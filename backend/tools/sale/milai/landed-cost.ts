/**
 * landed-cost.ts — фактические доп.расходы MilAi на единицу (поставки, прочее, реклама).
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/milai/landed-cost.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import ExcelJS from 'exceljs';
import { MILAI_BY_SKU, MILAI_PRODUCTS } from './catalog';
import { DEFAULT_TAX_RATE } from './economics';
import { fetchProductRates } from './ozon';
import { moscowDateStr, moscowNow } from '../lib/format';

const repoRoot = join(__dirname, '../../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://api-seller.ozon.ru';
const PERF = 'https://api-performance.ozon.ru';
const DAYS = 30;

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

/** Расходы магазина, которые распределяем на SKU (не привязаны к товару в API). */
const ALLOC_OTHER_TYPES = new Set([
  'OperationMarketplaceSupplyAdditional',
  'OperationMarketplaceAcceleratedProductReviews',
  'InsuranceServiceSellerItem',
  'OperationMarketplacePackageRedistribution',
  'OperationMarketplacePackageMaterialsProvision',
]);

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
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function daysAgo(n: number): Date {
  const msk = moscowNow();
  msk.setUTCDate(msk.getUTCDate() - n);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - 3 * 3600_000);
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU');
}

function hint(sku: number): string {
  return MILAI_BY_SKU.get(sku)?.hint ?? String(sku);
}

function costOf(sku: number): number {
  return MILAI_BY_SKU.get(sku)?.cost ?? 0;
}

interface InboundLine {
  orderId: number;
  date: string;
  warehouse: string;
  sku: number;
  offer: string;
  qty: number;
}

interface SupplyOrderSummary {
  orderId: number;
  date: string;
  warehouse: string;
  totalQty: number;
  items: Array<{ sku: number; offer: string; qty: number }>;
}

async function fetchInboundSupplies(): Promise<InboundLine[]> {
  const orderIds: number[] = [];
  let last = '';
  for (;;) {
    const d = await post('/v3/supply-order/list', {
      limit: 100,
      last_id: last,
      sort_by: 1,
      sort_direction: 'DESC',
      filter: { states: ['COMPLETED'] },
    });
    const ids: number[] = d.order_ids ?? [];
    orderIds.push(...ids);
    if (!d.has_next || !ids.length) break;
    last = d.last_id ?? String(ids[ids.length - 1]);
  }

  const inbound: InboundLine[] = [];
  for (let i = 0; i < orderIds.length; i += 20) {
    const chunk = orderIds.slice(i, i + 20);
    const det = await post('/v3/supply-order/get', { order_ids: chunk });
    for (const o of det.orders ?? []) {
      const date = String(o.state_updated_date ?? o.created_date ?? '').slice(0, 10);
      const warehouse =
        o.warehouse_name ??
        o.warehouse?.name ??
        o.dropoff_warehouse?.name ??
        o.supplies?.[0]?.storage_warehouse?.name ??
        '—';
      const bundleIds = new Set<string>();
      for (const s of o.supplies ?? []) {
        if (s.bundle_id) bundleIds.add(s.bundle_id);
      }
      for (const bid of bundleIds) {
        const b = await post('/v1/supply-order/bundle', {
          bundle_ids: [bid],
          limit: 100,
          last_id: '',
        });
        for (const item of b.items ?? []) {
          const sku = Number(item.sku);
          const qty = Number(item.quantity ?? item.quant ?? 0);
          if (sku > 0 && qty > 0) {
            inbound.push({
              orderId: Number(o.order_id),
              date,
              warehouse,
              sku,
              offer: String(item.offer_id ?? ''),
              qty,
            });
          }
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return inbound;
}

async function fetchFinanceOps(from: Date, to: Date): Promise<any[]> {
  const all: any[] = [];
  let chunkStart = new Date(from);
  while (chunkStart < to) {
    const nextEnd = new Date(chunkStart);
    nextEnd.setUTCDate(nextEnd.getUTCDate() + 27);
    const toChunk = nextEnd < to ? nextEnd : to;
    let page = 1;
    for (;;) {
      const d = await post('/v3/finance/transaction/list', {
        filter: {
          date: { from: chunkStart.toISOString(), to: toChunk.toISOString() },
          transaction_type: 'all',
        },
        language: 'DEFAULT',
        page,
        page_size: 1000,
      });
      const ops = d.result?.operations ?? [];
      all.push(...ops);
      if (page >= (d.result?.page_count ?? 1) || !ops.length) break;
      page++;
      await new Promise((r) => setTimeout(r, 200));
    }
    chunkStart = new Date(toChunk.getTime() + 1);
  }
  return all;
}

async function fetchAdsBySku(days: number): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const clientId = process.env.OZON_PERFORMANCE_CLIENT_ID_MILAI?.trim();
  const clientSecret = process.env.OZON_PERFORMANCE_CLIENT_SECRET_MILAI?.trim();
  if (!clientId || !clientSecret) return map;

  const tokenRes = await nodeFetch(`${PERF}/api/client/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;
  if (!token) return map;

  const to = moscowDateStr();
  const fromD = moscowNow();
  fromD.setUTCDate(fromD.getUTCDate() - days);
  const from = fromD.toISOString().slice(0, 10);

  const campsRes = await nodeFetch(`${PERF}/api/client/campaign`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const camps: any[] = (await campsRes.json()).list ?? [];

  for (const c of camps) {
    const statRes = await nodeFetch(
      `${PERF}/api/client/statistics/campaign/product/json?campaignIds=${c.id}&dateFrom=${from}&dateTo=${to}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const rows: any[] = (await statRes.json()).rows ?? [];
    for (const r of rows) {
      const sku = Number(r.sku);
      const spent = Number(r.moneySpent ?? r.expense ?? 0);
      if (sku > 0 && spent > 0) map.set(sku, (map.get(sku) ?? 0) + spent);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return map;
}

/** Ozon volume tiers for logistics formula (same as user matrix). */
const OZON_TIERS = [
  0, 0.201, 0.401, 0.601, 0.801, 1.001, 1.251, 1.501, 1.751, 2.001,
].map((v, i, arr) => {
  const bases = [56, 63, 67, 67, 67, 72, 75, 75, 75, 75];
  return { volFrom: v, base: bases[i] ?? 75 };
});

function calcLogistics(vol: number, buyoutPct: number): number {
  const p = buyoutPct / 100;
  if (p <= 0) return 0;
  let tier = OZON_TIERS[0];
  for (const t of OZON_TIERS) if (vol >= t.volFrom) tier = t;
  const ret = tier.base;
  const mile = 25;
  return Math.round((tier.base + mile + ret * (1 - p)) / p);
}

async function main(): Promise<void> {
  const from = daysAgo(DAYS);
  const to = new Date();
  const fromStr = from.toISOString().slice(0, 10);
  const today = moscowDateStr();

  console.log(`\n🏪 MilAi landed cost · ${fromStr} — ${today}\n`);

  console.log('→ Поставки FBO (completed)...');
  const inbound = await fetchInboundSupplies();
  const inboundBySku = new Map<number, number>();
  const ordersById = new Map<number, SupplyOrderSummary>();
  for (const line of inbound) {
    inboundBySku.set(line.sku, (inboundBySku.get(line.sku) ?? 0) + line.qty);
    const o = ordersById.get(line.orderId) ?? {
      orderId: line.orderId,
      date: line.date,
      warehouse: line.warehouse,
      totalQty: 0,
      items: [],
    };
    o.totalQty += line.qty;
    o.items.push({ sku: line.sku, offer: line.offer, qty: line.qty });
    ordersById.set(line.orderId, o);
  }
  const totalInbound = [...inboundBySku.values()].reduce((s, q) => s + q, 0);
  console.log(`  Поставок: ${ordersById.size} · единиц принято: ${totalInbound}`);

  console.log('→ Финансы (касса)...');
  const ops = await fetchFinanceOps(from, to);

  let supplyCostTotal = 0;
  let otherAllocTotal = 0;
  const otherByType = new Map<string, number>();
  let revenue = 0;
  let sold = 0;
  const skuSold = new Map<number, number>();
  const skuRevenue = new Map<number, number>();

  for (const op of ops) {
    const d = String(op.operation_date).slice(0, 10);
    if (d < fromStr) continue;
    const t = String(op.operation_type ?? '');
    const amt = Number(op.amount ?? 0);

    if (t === 'OperationMarketplaceSupplyAdditional') {
      supplyCostTotal += amt; // negative
    } else if (ALLOC_OTHER_TYPES.has(t)) {
      otherAllocTotal += amt;
      otherByType.set(t, (otherByType.get(t) ?? 0) + amt);
    }

    if (op.type === 'orders' && Number(op.accruals_for_sale) > 0) {
      revenue += Number(op.accruals_for_sale);
      sold++;
      const sku = Number(op.items?.[0]?.sku ?? 0);
      if (sku) {
        skuSold.set(sku, (skuSold.get(sku) ?? 0) + 1);
        skuRevenue.set(sku, (skuRevenue.get(sku) ?? 0) + Number(op.accruals_for_sale));
      }
    }
  }

  console.log('→ Реклама по SKU...');
  let adsBySku = await fetchAdsBySku(DAYS);
  let adsTotal = [...adsBySku.values()].reduce((s, v) => s + v, 0);

  // fallback: касса CPC, распределение по выручке SKU
  if (adsTotal <= 0) {
    let adsFinance = 0;
    for (const op of ops) {
      const d = String(op.operation_date).slice(0, 10);
      if (d < fromStr) continue;
      if (ADS_OPS.has(String(op.operation_type ?? ''))) {
        adsFinance += Math.abs(Number(op.amount ?? 0));
      }
    }
    adsTotal = adsFinance;
    adsBySku = new Map();
    for (const prod of MILAI_PRODUCTS) {
      const rev = skuRevenue.get(prod.sku) ?? 0;
      if (revenue > 0 && rev > 0) adsBySku.set(prod.sku, adsFinance * (rev / revenue));
    }
  }

  const supplyPerInboundUnit = totalInbound > 0 ? Math.abs(supplyCostTotal) / totalInbound : 0;
  const otherPerSoldUnit = sold > 0 ? Math.abs(otherAllocTotal) / sold : 0;

  console.log('\n═══ РАСХОДЫ МАГАЗИНА (30д) ═══');
  console.log(`  Доставка на склад (SupplyAdditional): ${fmt(supplyCostTotal)} ₽`);
  console.log(`  Прочее (отзывы, страховка, упаковка):  ${fmt(otherAllocTotal)} ₽`);
  console.log(`  Реклама (Performance API):               ${fmt(-adsTotal)} ₽`);
  for (const [t, v] of otherByType) console.log(`    · ${t}: ${fmt(v)} ₽`);

  console.log('\n═══ ПОСТАВКИ ПО СКЛАДАМ ═══');
  for (const o of [...ordersById.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const share = o.totalQty / Math.max(1, totalInbound);
    const orderCost = Math.abs(supplyCostTotal) * share;
    const perUnit = o.totalQty > 0 ? orderCost / o.totalQty : 0;
    console.log(
      `  #${o.orderId} ${o.date} · ${o.warehouse} · ${o.totalQty} шт · ~${fmt(orderCost)} ₽ · ~${fmt(perUnit)} ₽/шт`,
    );
    for (const it of o.items) {
      console.log(`      ${it.offer || hint(it.sku)} (SKU ${it.sku}): ${it.qty} шт`);
    }
  }

  console.log('\n═══ LANDED COST НА ЕДИНИЦУ (для себестоимости) ═══');
  console.log(
    'SKU'.padEnd(12) +
      'Товар'.padEnd(26) +
      'закуп'.padStart(7) +
      'пост'.padStart(6) +
      'проч'.padStart(6) +
      'рекл'.padStart(6) +
      'итого'.padStart(7) +
      '  прод',
  );

  const rates = await fetchProductRates();
  const rateBySku = new Map(rates.map((r) => [r.sku, r]));

  interface Row {
    sku: number;
    name: string;
    purchase: number;
    supply: number;
    other: number;
    ads: number;
    landed: number;
    sold: number;
    inbound: number;
    revenue: number;
    volume: number;
    buyout: number;
    cardPrice: number;
    priceAfter: number;
    commissionPct: number;
    logistics: number;
    profitCash: number;
    profitUnit: number;
  }

  const rows: Row[] = [];

  for (const prod of MILAI_PRODUCTS) {
    const sku = prod.sku;
    const inboundQty = inboundBySku.get(sku) ?? 0;
    const soldQty = skuSold.get(sku) ?? 0;
    const rev = skuRevenue.get(sku) ?? 0;

    // Supply: proportional to accepted units; if no inbound data, spread by sold
    const supplyDenom = totalInbound > 0 ? totalInbound : sold;
    const supplyShare = supplyDenom > 0
      ? (totalInbound > 0 ? inboundQty : soldQty) / supplyDenom
      : 0;
    const supplyRub = Math.abs(supplyCostTotal) * supplyShare;
    const supplyPerUnit = inboundQty > 0
      ? supplyRub / inboundQty
      : soldQty > 0
        ? supplyRub / soldQty
        : supplyPerInboundUnit;

    const otherRub = Math.abs(otherAllocTotal) * (sold > 0 ? soldQty / sold : 0);
    const otherPerUnit = soldQty > 0 ? otherRub / soldQty : otherPerSoldUnit;

    const adsRub = adsBySku.get(sku) ?? (adsTotal > 0 && revenue > 0 ? adsTotal * (rev / revenue) : 0);
    const adsPerUnit = soldQty > 0 ? adsRub / soldQty : 0;

    const landed = prod.cost + supplyPerUnit + otherPerUnit + adsPerUnit;

    const rate = rateBySku.get(sku);
    const volume = 0; // filled from product info if needed
    const buyoutPct = prod.buyout * 100;

    rows.push({
      sku,
      name: prod.hint ?? '',
      purchase: prod.cost,
      supply: Math.round(supplyPerUnit),
      other: Math.round(otherPerUnit),
      ads: Math.round(adsPerUnit),
      landed: Math.round(landed),
      sold: soldQty,
      inbound: inboundQty,
      revenue: rev,
      volume,
      buyout: buyoutPct,
      cardPrice: rate?.currentPrice ?? 0,
      priceAfter: soldQty > 0 ? Math.round(rev / soldQty) : rate?.currentPrice ?? 0,
      commissionPct: rate ? Math.round(rate.commissionFboRate * 1000) / 10 : 0,
      logistics: 0,
      profitCash: 0,
      profitUnit: 0,
    });
  }

  // product info volumes
  const offerIds = rates.map((r) => r.offerId).filter(Boolean);
  const infoRes = await post('/v3/product/info/list', { offer_id: offerIds, product_id: [], sku: [] });
  const infoItems: any[] = infoRes.items ?? infoRes.result?.items ?? [];
  const volBySku = new Map<number, number>();
  const nameBySku = new Map<number, string>();
  for (const it of infoItems) {
    const sku = Number(it.sku ?? it.sources?.[0]?.sku ?? 0);
    if (!sku) continue;
    volBySku.set(sku, Number(it.volume_weight ?? it.dimensions?.volume ?? 0));
    nameBySku.set(sku, String(it.name ?? ''));
  }

  for (const r of rows) {
    r.volume = volBySku.get(r.sku) ?? 0;
    r.logistics = calcLogistics(r.volume, r.buyout);
    const g = r.cardPrice;
    const comm = g * (r.commissionPct / 100);
    const acq = g * 0.015;
    const tax = r.priceAfter * DEFAULT_TAX_RATE;
    r.profitUnit = Math.round(g - comm - r.logistics - acq - r.ads - tax - r.landed);
    r.profitCash = r.sold * r.profitUnit; // approx
  }

  rows.sort((a, b) => b.sold - a.sold);
  for (const r of rows) {
    console.log(
      String(r.sku).padEnd(12) +
        r.name.slice(0, 24).padEnd(26) +
        String(r.purchase).padStart(7) +
        String(r.supply).padStart(6) +
        String(r.other).padStart(6) +
        String(r.ads).padStart(6) +
        String(r.landed).padStart(7) +
        `  ${r.sold}`,
    );
  }

  // Excel export
  const outDir = join(repoRoot, 'tmp');
  mkdirSync(outDir, { recursive: true });
  const xlsxPath = join(outDir, `milai-landed-cost-${today}.xlsx`);

  const wb = new ExcelJS.Workbook();

  const lc = wb.addWorksheet('Landed cost');
  lc.addRow([
    'SKU', 'Товар', 'Принято на склад', 'Продано 30д', 'Закупка ₽', 'Поставка ₽/шт', 'Прочее ₽/шт',
    'Реклама ₽/шт', 'Полная себестоимость ₽', 'Примечание',
  ]);
  lc.getRow(1).font = { bold: true };
  for (const r of rows) {
    lc.addRow([
      r.sku, nameBySku.get(r.sku) ?? r.name, r.inbound, r.sold, r.purchase, r.supply, r.other, r.ads, r.landed,
      r.inbound === 0 ? 'поставка распределена по продажам' : '',
    ]);
  }
  [12, 40, 16, 14, 12, 14, 12, 12, 18, 30].forEach((w, i) => { lc.getColumn(i + 1).width = w; });

  const sup = wb.addWorksheet('Поставки');
  sup.addRow(['Order ID', 'Дата', 'Склад', 'SKU', 'Артикул', 'Кол-во', 'Доля поставки ₽', '₽/шт поставки']);
  sup.getRow(1).font = { bold: true };
  for (const o of [...ordersById.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const share = o.totalQty / Math.max(1, totalInbound);
    const orderCost = Math.abs(supplyCostTotal) * share;
    for (const it of o.items) {
      const unitCost = it.qty > 0 ? orderCost * (it.qty / o.totalQty) / it.qty : 0;
      sup.addRow([o.orderId, o.date, o.warehouse, it.sku, it.offer, it.qty, Math.round(orderCost * it.qty / o.totalQty), Math.round(unitCost)]);
    }
  }

  const ue = wb.addWorksheet('Юнит-экономика');
  ue.addRow([
    'SKU', 'Товар', 'Закупка', 'Поставка', 'Прочее', 'Реклама', 'Landed cost',
    'Цена G', 'Цена I', 'Комиссия%', 'Объём', 'Выкуп%', 'Логистика', 'Прибыль/шт',
  ]);
  ue.getRow(1).font = { bold: true };
  for (const r of rows) {
    ue.addRow([
      r.sku, nameBySku.get(r.sku) ?? r.name, r.purchase, r.supply, r.other, r.ads, r.landed,
      r.cardPrice, r.priceAfter, r.commissionPct, r.volume, r.buyout, r.logistics, r.profitUnit,
    ]);
  }

  const ref = wb.addWorksheet('Справка');
  ref.addRows([
    ['Параметр', 'Значение'],
    ['Период', `${fromStr} — ${today}`],
    ['Поставки на склад (всего)', `${fmt(supplyCostTotal)} ₽`],
    ['Единиц принято на склад', totalInbound],
    ['Поставка ₽/шт (средняя)', Math.round(supplyPerInboundUnit)],
    ['Прочее Ozon (всего)', `${fmt(otherAllocTotal)} ₽`],
    ['Прочее ₽/шт (по продажам)', Math.round(otherPerSoldUnit)],
    ['Реклама (всего)', `${fmt(-adsTotal)} ₽`],
    ['', ''],
    ['Landed cost', 'Закупка + поставка/шт + прочее/шт + реклама/шт'],
    ['Поставка', 'OperationMarketplaceSupplyAdditional, пропорция по принятым единицам в поставках'],
    ['Прочее', 'Ускоренные отзывы, страховка, упаковка — по продажам'],
    ['Реклама', 'Performance API по SKU, иначе по доле выручки'],
    ['Прибыль', 'G − комиссия(G) − логистика − эквайринг 1.5% − реклама − налог(I) − landed cost'],
  ]);
  ref.getColumn(1).width = 34;
  ref.getColumn(2).width = 60;

  await wb.xlsx.writeFile(xlsxPath);
  console.log(`\n✅ Excel: ${xlsxPath}\n`);
}

main().catch((e: Error) => {
  console.error('❌', e.message);
  process.exit(1);
});
