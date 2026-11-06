/**
 * status.ts — полный статус магазина MILAI (read-only).
 *
 * Собирает: юнит-экономику, P&L по кассе, заказы FBO, акции, рекламу, остатки.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/milai/status.ts
 *   npm run ozon:milai-status
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { fetchProductRates, type ProductRates } from './ozon';
import { MILAI_BY_SKU, MILAI_PRODUCTS } from './catalog';
import { computePricing, DEFAULT_TAX_RATE, DEFAULT_ACQUIRING_RATE } from './economics';
import { fmt, moscowNow, moscowDateStr } from '../lib/format';

const repoRoot = join(__dirname, '../../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://api-seller.ozon.ru';
const PERF = 'https://api-performance.ozon.ru';
const TAX = DEFAULT_TAX_RATE;
const MIN_PROMO_PROFIT = 100;

function creds(): { clientId: string; apiKey: string } {
  const clientId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const apiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (!clientId || !apiKey) throw new Error('Нет OZON_SELLER_*_MILAI');
  return { clientId, apiKey };
}

async function post(path: string, body: unknown): Promise<any> {
  const { clientId, apiKey } = creds();
  const res = await nodeFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Id': clientId,
      'Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function get(path: string): Promise<any> {
  const { clientId, apiKey } = creds();
  const res = await nodeFetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { 'Client-Id': clientId, 'Api-Key': apiKey },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function daysAgo(n: number): Date {
  const msk = moscowNow();
  msk.setUTCDate(msk.getUTCDate() - n);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - 3 * 3600_000);
}

function costOf(sku: number): number {
  return MILAI_BY_SKU.get(sku)?.cost ?? 0;
}

function hintOf(sku: number, fallback = ''): string {
  return MILAI_BY_SKU.get(sku)?.hint ?? fallback;
}

// ─── Finance P&L ─────────────────────────────────────────────────────────────
interface DayPnl {
  date: string;
  revenue: number;
  sold: number;
  returns: number;
  cancels: number;
  commission: number;
  logistics: number;
  returnLogistics: number;
  acquiring: number;
  ads: number;
  storage: number;
  other: number;
  cost: number;
  tax: number;
  net: number;
  margin: number;
  drr: number;
}

const LOGI = new Set([
  'MarketplaceServiceItemDirectFlowLogistic',
  'MarketplaceServiceItemReturnFlowLogistic',
  'MarketplaceServiceItemDelivToCustomer',
  'MarketplaceServiceItemReturnAfterDelivToCustomer',
  'MarketplaceServiceItemReturnNotDelivToCustomer',
  'MarketplaceServiceItemReturnPartGoodsCustomer',
  'MarketplaceServiceItemDirectFlowTrans',
  'MarketplaceServiceItemReturnFlowTrans',
  'MarketplaceServiceItemDropoffPVZ',
  'MarketplaceServiceItemDropoffSC',
  'MarketplaceServiceItemDropoffFF',
]);

const ADS_OPS = new Set([
  'OperationMarketplaceCostPerClick',
  'OperationElectronicServicesPromotionInSearch',
  'MarketplaceMarketingActionCostOperation',
  'OperationMarketplaceServicePremiumCashback',
  'OperationMarketplaceServicePremiumPromotion',
]);

async function fetchOps(from: Date, to: Date): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  for (;;) {
    const d = await post('/v3/finance/transaction/list', {
      filter: { date: { from: from.toISOString(), to: to.toISOString() }, transaction_type: 'all' },
      language: 'DEFAULT',
      page,
      page_size: 1000,
    });
    const ops = d.result?.operations ?? [];
    const pages = d.result?.page_count ?? 1;
    all.push(...ops);
    process.stdout.write(`  finance стр. ${page}/${pages} (${all.length})\r`);
    if (page >= pages || !ops.length) break;
    page++;
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write('\n');
  return all;
}

function pnlForDay(ops: any[], date: string): DayPnl {
  const day = ops.filter((o) => String(o.operation_date).startsWith(date));
  let revenue = 0, sold = 0, returns = 0, cancels = 0;
  let returnRev = 0, commission = 0, logistics = 0, returnLogistics = 0;
  let acquiring = 0, ads = 0, storage = 0, other = 0, cost = 0;

  for (const op of day) {
    if (op.type === 'orders') {
      for (const svc of op.services ?? []) {
        if (LOGI.has(svc.name)) logistics += Number(svc.price ?? 0);
      }
      if (Number(op.accruals_for_sale) <= 0) continue;
      revenue += Number(op.accruals_for_sale);
      commission += Number(op.sale_commission ?? 0);
      sold++;
      const sku = Number(op.items?.[0]?.sku ?? 0);
      if (sku) cost += costOf(sku);
    } else if (op.type === 'returns') {
      if (Number(op.accruals_for_sale) !== 0) {
        returns++;
        returnRev += Number(op.accruals_for_sale);
        commission += Number(op.sale_commission ?? 0);
        for (const svc of op.services ?? []) {
          if (LOGI.has(svc.name)) returnLogistics += Number(svc.price ?? 0);
        }
        const sku = Number(op.items?.[0]?.sku ?? 0);
        if (sku) cost -= costOf(sku);
      } else {
        cancels++;
        returnLogistics += Number(op.amount ?? 0);
      }
    } else if (op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation') {
      acquiring += Number(op.amount ?? 0);
    } else if (ADS_OPS.has(op.operation_type)) {
      ads += Number(op.amount ?? 0);
    } else if (/storage|Storage|Placement|placement/i.test(op.operation_type ?? '')) {
      storage += Number(op.amount ?? 0);
    } else {
      other += Number(op.amount ?? 0);
    }
  }

  const gross = revenue + returnRev;
  const tax = +(Math.max(0, gross) * TAX).toFixed(2);
  const net = +(
    gross + commission + logistics + returnLogistics + acquiring + ads + storage + other - cost - tax
  ).toFixed(2);
  return {
    date,
    revenue: +revenue.toFixed(2),
    sold, returns, cancels,
    commission: +commission.toFixed(2),
    logistics: +logistics.toFixed(2),
    returnLogistics: +returnLogistics.toFixed(2),
    acquiring: +acquiring.toFixed(2),
    ads: +ads.toFixed(2),
    storage: +storage.toFixed(2),
    other: +other.toFixed(2),
    cost: +cost.toFixed(2),
    tax, net,
    margin: revenue > 0 ? +((net / revenue) * 100).toFixed(1) : 0,
    drr: revenue > 0 && Math.abs(ads) > 0 ? +((-ads / revenue) * 100).toFixed(1) : 0,
  };
}

function productPnl(ops: any[], dateFrom: string, dateTo: string): Array<{
  sku: number; name: string; sold: number; returns: number; revenue: number; cost: number; netApprox: number;
}> {
  const map = new Map<number, { sold: number; returns: number; revenue: number; cost: number; commission: number; logistics: number }>();
  for (const op of ops) {
    const d = String(op.operation_date).slice(0, 10);
    if (d < dateFrom || d > dateTo) continue;
    const sku = Number(op.items?.[0]?.sku ?? 0);
    if (!sku) continue;
    let row = map.get(sku);
    if (!row) { row = { sold: 0, returns: 0, revenue: 0, cost: 0, commission: 0, logistics: 0 }; map.set(sku, row); }
    if (op.type === 'orders' && Number(op.accruals_for_sale) > 0) {
      row.sold++;
      row.revenue += Number(op.accruals_for_sale);
      row.commission += Number(op.sale_commission ?? 0);
      row.cost += costOf(sku);
      for (const svc of op.services ?? []) if (LOGI.has(svc.name)) row.logistics += Number(svc.price ?? 0);
    } else if (op.type === 'returns' && Number(op.accruals_for_sale) !== 0) {
      row.returns++;
      row.revenue += Number(op.accruals_for_sale);
      row.commission += Number(op.sale_commission ?? 0);
      row.cost -= costOf(sku);
      for (const svc of op.services ?? []) if (LOGI.has(svc.name)) row.logistics += Number(svc.price ?? 0);
    }
  }
  return [...map.entries()]
    .map(([sku, r]) => {
      const tax = Math.max(0, r.revenue) * TAX;
      const netApprox = r.revenue + r.commission + r.logistics - r.cost - tax;
      return { sku, name: hintOf(sku), sold: r.sold, returns: r.returns, revenue: +r.revenue.toFixed(0), cost: +r.cost.toFixed(0), netApprox: +netApprox.toFixed(0) };
    })
    .sort((a, b) => b.netApprox - a.netApprox);
}

// ─── Postings (orders) ───────────────────────────────────────────────────────
async function fetchPostings(from: Date, to: Date): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  for (;;) {
    const d = await post('/v2/posting/fbo/list', {
      dir: 'DESC',
      filter: { since: from.toISOString(), to: to.toISOString() },
      limit: 1000,
      offset,
      with: { analytics_data: true, financial_data: true },
    });
    const rows = d.result ?? [];
    all.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

function summarizeOrders(postings: any[], date: string): { orders: number; cancelled: number; units: number; revenue: number; bySku: Map<number, { units: number; revenue: number }> } {
  let orders = 0, cancelled = 0, units = 0, revenue = 0;
  const bySku = new Map<number, { units: number; revenue: number }>();
  for (const p of postings) {
    const created = new Date(new Date(p.created_at).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    if (created !== date) continue;
    if (p.status === 'cancelled') { cancelled++; continue; }
    orders++;
    const finBySku = new Map<number, any>();
    for (const fp of p.financial_data?.products ?? []) finBySku.set(Number(fp.product_id), fp);
    for (const pr of p.products ?? []) {
      const sku = Number(pr.sku);
      const fp = finBySku.get(sku);
      const price = Number(fp?.price ?? pr.price ?? 0);
      const qty = Number(pr.quantity ?? 1);
      units += qty;
      revenue += price * qty;
      const row = bySku.get(sku) ?? { units: 0, revenue: 0 };
      row.units += qty;
      row.revenue += price * qty;
      bySku.set(sku, row);
    }
  }
  return { orders, cancelled, units, revenue: +revenue.toFixed(0), bySku };
}

// ─── Promos ──────────────────────────────────────────────────────────────────
async function analyzePromos(rates: ProductRates[]): Promise<string[]> {
  const lines: string[] = [];
  const byPid = new Map<number, ProductRates>();
  for (const r of rates) if (r.productId) byPid.set(r.productId, r);

  const actions = (await get('/v1/actions')).result ?? [];
  lines.push(`Активных акций в кабинете: ${actions.length}`);

  const priceItems: any[] = [];
  let lastId = '';
  for (;;) {
    const d = await post('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 100, last_id: lastId });
    priceItems.push(...(d.items ?? []));
    if (!d.last_id || !(d.items?.length)) break;
    lastId = d.last_id;
  }
  let autoOn = 0;
  for (const it of priceItems) {
    if (it.price?.auto_action_enabled && it.price?.auto_add_to_ozon_actions_list_enabled) autoOn++;
  }
  lines.push(`auto_action включён: ${autoOn}/${priceItems.length} товаров`);

  const ratesByOffer = new Map(rates.map((r) => [r.offerId, r]));

  for (const action of actions) {
    const prods: any[] = [];
    let offset = 0;
    for (;;) {
      const d = await post('/v1/actions/products', { action_id: action.id, limit: 100, offset });
      const rows = d.result?.products ?? [];
      prods.push(...rows);
      if (rows.length < 100) break;
      offset += 100;
    }
    if (!prods.length) continue;

    lines.push(`\n📌 ${action.title} (id ${action.id}) — в акции ${prods.length} шт`);
    for (const p of prods) {
      const offer = p.offer_id ?? '';
      const r = ratesByOffer.get(offer) ?? byPid.get(Number(p.id ?? p.product_id));
      const sku = r?.sku ?? 0;
      const prod = MILAI_BY_SKU.get(sku);
      const actionPrice = Number(p.action_price ?? p.price ?? 0);
      if (!r || !prod) {
        lines.push(`  ? ${offer || p.id}: цена ${actionPrice} (нет в каталоге MILAI)`);
        continue;
      }
      const pricing = computePricing({
        cost: prod.cost,
        buyout: prod.buyout,
        commissionRate: r.commissionFboRate,
        forwardLogistics: r.fboForward,
        returnLogistics: r.fboReturn,
        acquiringRate: r.currentPrice > 0 ? r.acquiring / r.currentPrice : DEFAULT_ACQUIRING_RATE,
      });
      const profit = Math.round(pricing.profitAtPrice(actionPrice));
      const icon = profit >= MIN_PROMO_PROFIT ? '✅' : profit >= 0 ? '🟡' : '🔴';
      lines.push(
        `  ${icon} ${offer} SKU ${sku} «${prod.hint ?? ''}» акц ${fmt(actionPrice)} → ${profit >= 0 ? '+' : ''}${profit} ₽/шт (BE ${fmt(pricing.breakEven)})`,
      );
    }

    // candidates
    const cands: any[] = [];
    offset = 0;
    for (;;) {
      const d = await post('/v1/actions/candidates', { action_id: action.id, limit: 100, offset });
      const rows = (d.result?.products ?? []).filter((x: any) => !x.action_price || x.add_mode === 'NOT_SET');
      cands.push(...rows);
      if ((d.result?.products ?? []).length < 100) break;
      offset += 100;
    }
    const milaiCands = cands.filter((c) => {
      const r = ratesByOffer.get(c.offer_id) ?? byPid.get(Number(c.id ?? c.product_id));
      return r && MILAI_BY_SKU.has(r.sku);
    });
    if (milaiCands.length) {
      lines.push(`  Кандидаты на вступление (${milaiCands.length}):`);
      for (const c of milaiCands.slice(0, 15)) {
        const r = ratesByOffer.get(c.offer_id) ?? byPid.get(Number(c.id ?? c.product_id))!;
        const prod = MILAI_BY_SKU.get(r.sku)!;
        const maxP = Number(c.max_action_price ?? c.price ?? 0);
        const pricing = computePricing({
          cost: prod.cost,
          buyout: prod.buyout,
          commissionRate: r.commissionFboRate,
          forwardLogistics: r.fboForward,
          returnLogistics: r.fboReturn,
          acquiringRate: r.currentPrice > 0 ? r.acquiring / r.currentPrice : DEFAULT_ACQUIRING_RATE,
        });
        const profit = Math.round(pricing.profitAtPrice(maxP));
        const icon = profit >= MIN_PROMO_PROFIT ? '✅' : profit >= 0 ? '🟡' : '🔴';
        const verdict = profit >= MIN_PROMO_PROFIT ? 'вступать' : profit >= 0 ? 'осторожно' : 'не вступать';
        lines.push(`  ${icon} ${c.offer_id} max ${fmt(maxP)} → ${profit >= 0 ? '+' : ''}${profit} ₽ (${verdict})`);
      }
    }
  }
  return lines;
}

// ─── Ads ─────────────────────────────────────────────────────────────────────
async function analyzeAds(days: number): Promise<string[]> {
  const lines: string[] = [];
  const clientId = process.env.OZON_PERFORMANCE_CLIENT_ID_MILAI?.trim();
  const clientSecret = process.env.OZON_PERFORMANCE_CLIENT_SECRET_MILAI?.trim();
  if (!clientId || !clientSecret) {
    lines.push('Нет Performance-кредов MILAI — рекламу пропустить.');
    return lines;
  }

  const tokRes = await nodeFetch(`${PERF}/api/client/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  const tok = await tokRes.json() as { access_token?: string; error?: string };
  if (!tok.access_token) {
    lines.push(`Performance token error: ${tok.error ?? JSON.stringify(tok)}`);
    return lines;
  }
  const token = tok.access_token;

  const campRes = await nodeFetch(`${PERF}/api/client/campaign?page=1&pageSize=500`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const campBody = await campRes.json() as { list?: any[] };
  const campaigns = campBody.list ?? [];
  lines.push(`Кампаний: ${campaigns.length}`);
  for (const c of campaigns) {
    lines.push(`  РК ${c.id} «${c.title}» state=${c.state} type=${c.advObjectType} pay=${c.PaymentType ?? c.paymentType}`);
  }

  const running = campaigns.filter((c) => c.state === 'CAMPAIGN_STATE_RUNNING' || String(c.state).includes('RUNNING'));
  const ids = campaigns.map((c) => Number(c.id)).filter(Boolean);
  if (!ids.length) return lines;

  const to = moscowNow();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo = to.toISOString().slice(0, 10);

  // report job
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const postR = await nodeFetch(`${PERF}/api/client/statistics/json`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaigns: batch, dateFrom, dateTo, groupBy: 'NO_GROUP_BY' }),
    });
    const pd = await postR.json().catch(() => null) as { UUID?: string; uuid?: string } | null;
    const uuid = pd?.UUID ?? pd?.uuid;
    if (!uuid) {
      lines.push(`  stats job не создан для батча ${batch.join(',')}`);
      continue;
    }
    let ok = false;
    for (let a = 0; a < 40; a++) {
      await new Promise((r) => setTimeout(r, 2500));
      const jr = await nodeFetch(`${PERF}/api/client/statistics/${uuid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const job = await jr.json().catch(() => null) as { state?: string } | null;
      if (job?.state === 'OK') { ok = true; break; }
      if (job?.state === 'ERROR' || job?.state === 'FAILED') break;
    }
    if (!ok) {
      lines.push(`  stats job ${uuid} не готов`);
      continue;
    }
    const rep = await nodeFetch(`${PERF}/api/client/statistics/report?UUID=${uuid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await rep.json().catch(() => null) as Record<string, any> | null;
    if (!body) continue;

    let totalSpent = 0, totalOrders = 0, totalMoney = 0;
    for (const [cid, value] of Object.entries(body)) {
      const rows = value?.report?.rows ?? [];
      const camp = campaigns.find((c) => String(c.id) === String(cid));
      let spent = 0, orders = 0, money = 0, views = 0, clicks = 0;
      const bySku: Array<{ sku: string; spent: number; orders: number; money: number }> = [];
      for (const row of rows) {
        const parseRu = (v: unknown): number => {
          if (typeof v === 'number') return v;
          if (typeof v !== 'string') return 0;
          const n = parseFloat(v.replace(/\s/g, '').replace(',', '.'));
          return Number.isFinite(n) ? n : 0;
        };
        const s = parseRu(row.moneySpent);
        const o = parseRu(row.orders);
        const m = parseRu(row.ordersMoney);
        spent += s; orders += o; money += m;
        views += parseRu(row.views);
        clicks += parseRu(row.clicks);
        if (s > 0 || o > 0) bySku.push({ sku: String(row.sku), spent: s, orders: o, money: m });
      }
      totalSpent += spent; totalOrders += orders; totalMoney += money;
      const drr = money > 0 ? (spent / money) * 100 : spent > 0 ? Infinity : 0;
      const drrStr = Number.isFinite(drr) ? `${drr.toFixed(1)}%` : '∞';
      lines.push(
        `\nРК ${cid} «${camp?.title ?? ''}» (${running.some((r) => String(r.id) === String(cid)) ? 'активна' : camp?.state}): ` +
        `расход ${fmt(spent)} · зак ${orders} · выручка ${fmt(money)} · ДРР ${drrStr} · показ ${views} клик ${clicks}`,
      );
      bySku.sort((a, b) => b.spent - a.spent);
      for (const s of bySku.slice(0, 10)) {
        const skuN = Number(s.sku);
        const drrSku = s.money > 0 ? ((s.spent / s.money) * 100).toFixed(1) + '%' : s.spent > 0 ? '∞' : '0%';
        lines.push(`    SKU ${s.sku} ${hintOf(skuN)}: расход ${fmt(s.spent)} зак ${s.orders} GMV ${fmt(s.money)} ДРР ${drrSku}`);
      }
    }
    lines.push(`\nИтого реклама ${days}д: расход ${fmt(totalSpent)} · прям.зак ${totalOrders} · GMV ${fmt(totalMoney)} · ДРР ${totalMoney > 0 ? ((totalSpent / totalMoney) * 100).toFixed(1) + '%' : totalSpent > 0 ? '∞' : '0%'}`);
  }
  return lines;
}

// ─── Stocks ──────────────────────────────────────────────────────────────────
async function stocks(): Promise<string[]> {
  const lines: string[] = [];
  try {
    const d = await post('/v2/analytics/stock_on_warehouses', {
      limit: 1000, offset: 0, warehouse_type: 'ALL',
    });
    const rows = d.result?.rows ?? [];
    const bySku = new Map<number, number>();
    for (const r of rows) {
      const sku = Number(r.sku);
      bySku.set(sku, (bySku.get(sku) ?? 0) + Number(r.free_to_sell_amount ?? 0));
    }
    let total = 0;
    for (const [sku, free] of [...bySku.entries()].sort((a, b) => b[1] - a[1])) {
      if (!free) continue;
      total += free;
      lines.push(`  SKU ${sku} ${hintOf(sku)}: ${free} шт`);
    }
    lines.unshift(`Свободно к продаже: ${total} шт по ${bySku.size} SKU`);
  } catch (e: any) {
    lines.push(`Остатки: ${e.message}`);
  }
  return lines;
}

// ─── Unit economics table ────────────────────────────────────────────────────
function printEconomics(rates: ProductRates[]): void {
  console.log('\n═══ ЮНИТ-ЭКОНОМИКА (FBO, цель +100/+300) ═══');
  const head =
    'SKU'.padEnd(12) + 'Товар'.padEnd(24) + 'цена'.padStart(7) + 'мин'.padStart(7) +
    'тек'.padStart(7) + '+100'.padStart(7) + '+300'.padStart(7) + '₽/шт'.padStart(7) + 'комм'.padStart(6) + 'выкуп'.padStart(6);
  console.log(head);
  console.log('─'.repeat(head.length));
  for (const prod of MILAI_PRODUCTS) {
    const r = rates.find((x) => x.sku === prod.sku);
    if (!r) {
      console.log(`${String(prod.sku).padEnd(12)}${(prod.hint ?? '').padEnd(24)} НЕТ В API`);
      continue;
    }
    const pricing = computePricing({
      cost: prod.cost,
      buyout: prod.buyout,
      commissionRate: r.commissionFboRate,
      forwardLogistics: r.fboForward,
      returnLogistics: r.fboReturn,
      acquiringRate: r.currentPrice > 0 ? r.acquiring / r.currentPrice : DEFAULT_ACQUIRING_RATE,
    });
    const profit = Math.round(pricing.profitAtPrice(r.currentPrice));
    const flag = r.currentPrice > 0 && r.currentPrice < pricing.breakEven ? '🔴' : profit < 100 ? '🟡' : '✅';
    console.log(
      String(prod.sku).padEnd(12) +
      (prod.hint ?? '').slice(0, 23).padEnd(24) +
      String(prod.cost).padStart(7) +
      String(fmt(pricing.breakEven)).padStart(7) +
      `${fmt(r.currentPrice)}${r.currentPrice < pricing.breakEven ? '!' : ''}`.padStart(7) +
      String(fmt(pricing.priceForProfit(100))).padStart(7) +
      String(fmt(pricing.priceForProfit(300))).padStart(7) +
      `${flag}${profit >= 0 ? '+' : ''}${profit}`.padStart(7) +
      `${Math.round(r.commissionFboRate * 100)}%`.padStart(6) +
      `${Math.round(prod.buyout * 100)}%`.padStart(6),
    );
  }
}

async function main(): Promise<void> {
  const { clientId } = creds();
  const today = moscowDateStr();
  const yMsk = moscowNow();
  yMsk.setUTCDate(yMsk.getUTCDate() - 1);
  const yesterday = yMsk.toISOString().slice(0, 10);
  console.log(`\n🏪 MILAI status — client_id=${clientId} — ${today} MSK\n`);

  // 1) Rates + economics
  console.log('→ Карточки и комиссии...');
  const rates = await fetchProductRates();
  console.log(`  Товаров в API: ${rates.length}`);
  printEconomics(rates);

  // 2) Finance
  console.log('\n→ Финансовые транзакции (14 дней)...');
  const finFrom = daysAgo(14);
  const finTo = new Date();
  const ops = await fetchOps(finFrom, finTo);

  const dayList: string[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = moscowNow();
    d.setUTCDate(d.getUTCDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }

  console.log('\n═══ P&L ПО КАССЕ ═══');
  console.log(
    'Дата'.padEnd(12) + 'выручка'.padStart(9) + 'шт'.padStart(5) + 'прибыль'.padStart(9) +
    'маржа'.padStart(7) + 'ДРР'.padStart(6) + 'комис'.padStart(8) + 'логист'.padStart(8) + 'реклама'.padStart(8),
  );
  const weekDays = dayList.slice(-8, -1); // last 7 full days excl today
  let weekRev = 0, weekSold = 0, weekNet = 0, weekAds = 0;
  for (const d of dayList) {
    const p = pnlForDay(ops, d);
    const mark = d === today ? '◀сегодня' : d === yesterday ? '◀вчера' : '';
    console.log(
      d.padEnd(12) +
      String(fmt(p.revenue)).padStart(9) +
      String(p.sold).padStart(5) +
      String(fmt(p.net)).padStart(9) +
      `${p.margin}%`.padStart(7) +
      `${p.drr}%`.padStart(6) +
      String(fmt(p.commission)).padStart(8) +
      String(fmt(p.logistics + p.returnLogistics)).padStart(8) +
      String(fmt(p.ads)).padStart(8) +
      (mark ? `  ${mark}` : ''),
    );
    if (weekDays.includes(d)) {
      weekRev += p.revenue;
      weekSold += p.sold;
      weekNet += p.net;
      weekAds += p.ads;
    }
  }
  const todayP = pnlForDay(ops, today);
  const yestP = pnlForDay(ops, yesterday);
  console.log('\nСводка:');
  console.log(`  Сегодня: выручка ${fmt(todayP.revenue)} · ${todayP.sold} шт · прибыль ${fmt(todayP.net)} · маржа ${todayP.margin}% · ДРР ${todayP.drr}%`);
  console.log(`  Вчера:   выручка ${fmt(yestP.revenue)} · ${yestP.sold} шт · прибыль ${fmt(yestP.net)} · маржа ${yestP.margin}% · ДРР ${yestP.drr}%`);
  console.log(`  7 дней (без сегодня): выручка ${fmt(weekRev)} · ${weekSold} шт · прибыль ${fmt(weekNet)} · маржа ${weekRev > 0 ? ((weekNet / weekRev) * 100).toFixed(1) : 0}% · ДРР ${weekRev > 0 && weekAds ? ((-weekAds / weekRev) * 100).toFixed(1) : 0}%`);

  const prod7 = productPnl(ops, weekDays[0], weekDays[weekDays.length - 1]);
  console.log('\n═══ ТОВАРЫ ЗА 7 ДНЕЙ (касса) ═══');
  for (const p of prod7) {
    const icon = p.netApprox < 0 ? '🔴' : '✅';
    console.log(`  ${icon} SKU ${p.sku} ${p.name}: прод ${p.sold} возвр ${p.returns} выр ${fmt(p.revenue)} ≈прибыль ${fmt(p.netApprox)}`);
  }

  // 3) Orders
  console.log('\n→ Заказы FBO (7 дней)...');
  const ordFrom = daysAgo(7);
  const postings = await fetchPostings(ordFrom, new Date());
  console.log(`  Postings: ${postings.length}`);
  console.log('\n═══ ЗАКАЗЫ (начисленные, без лага кассы) ═══');
  for (const d of [yesterday, today]) {
    const s = summarizeOrders(postings, d);
    console.log(`  ${d}: заказов ${s.orders} (отм ${s.cancelled}) · ${s.units} шт · GMV ${fmt(s.revenue)}`);
    for (const [sku, v] of [...s.bySku.entries()].sort((a, b) => b[1].revenue - a[1].revenue)) {
      console.log(`    SKU ${sku} ${hintOf(sku)}: ${v.units} шт · ${fmt(v.revenue)} ₽`);
    }
  }

  // 4) Promos
  console.log('\n→ Акции...');
  const promoLines = await analyzePromos(rates);
  console.log('\n═══ АКЦИИ ═══');
  for (const l of promoLines) console.log(l);

  // 5) Ads
  console.log('\n→ Реклама (7 дней)...');
  const adLines = await analyzeAds(7);
  console.log('\n═══ РЕКЛАМА ═══');
  for (const l of adLines) console.log(l);

  // 6) Stocks
  console.log('\n→ Остатки...');
  const stockLines = await stocks();
  console.log('\n═══ ОСТАТКИ ═══');
  for (const l of stockLines) console.log(l);

  console.log('\n✅ MILAI status готов.\n');
}

main().catch((e: Error) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
