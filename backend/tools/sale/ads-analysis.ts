/**
 * ads-analysis.ts — анализ рекламных кампаний (РК) Ozon Performance.
 *
 * Что делает:
 *   1. Тянет все кампании, их состав SKU и статистику расхода/заказов/ДРР за период.
 *   2. Считает по каждому SKU маржу ДО рекламы из транзакций → «безубыточный ДРР»
 *      (сколько % от цены можно отдать на рекламу, не уходя в минус).
 *   3. Делит товары на: что крутится (и стоит ли масштабировать/резать),
 *      что настроено но выключено (можно включить), и кандидатов на добавление.
 *
 * Запуск:
 *   npm run ozon:ads-analysis              — анализ за 30 дней (+ Telegram)
 *   npm run ozon:ads-analysis -- 14        — за 14 дней
 *   npm run ozon:ads-analysis -- 30 --dry  — только консоль, без Telegram
 */
import { fetchCampaigns, fetchCampaignProducts, fetchSkuStatsPerCampaign, getPerfToken, Campaign, SkuAdStat } from './lib/performance';
import { fetchAllOperations } from './lib/ozon';
import { TAX_RATE, LOGISTICS_SERVICES, OzonOperation, priceForProfit, priceForProfitWithDrr, NET_RATE } from './lib/economics';
import { COST_BY_SKU, OFFER_BY_SKU, SHORT_NAME_BY_OFFER, PRODUCTS } from './lib/catalog';
import { fetchAllPrices } from './lib/ozon';
import { sendHtml } from './lib/telegram';
import { fmt, escapeHtml as esc, moscowNow } from './lib/format';
import { logActiveShop, activeShop } from './lib/shop-config';

const DRY = process.argv.includes('--dry');
const days = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || 30;
const TARGET_PROFIT = 100; // целевая прибыль ₽/шт при заложенном ДРР
/** Дефолт cart→order по магазину (реклама), если мало данных по SKU. */
const DEFAULT_CART_TO_ORDER = 0.20;
const MIN_CARTS_FOR_K = 5;

const ACQUIRING_RATE = 0.01; // эквайринг ≈ 1% от цены (подтверждено транзакциями)
const ACTIVE_STATES = new Set(['CAMPAIGN_STATE_RUNNING']);
const DEAD_STATES = new Set(['CAMPAIGN_STATE_ARCHIVED', 'CAMPAIGN_STATE_FINISHED']);
const AD_TYPES = new Set(['SKU', 'SEARCH_PROMO']); // товарная реклама (не баннеры)

interface SkuEcon {
  sold: number;
  avgPrice: number;
  preAdsMargin: number;   // маржа на единицу ДО рекламы, ₽
  breakevenDrr: number;   // безубыточный ДРР, %
}

/** Маржа до рекламы по каждому SKU из транзакций за период. */
function computeSkuEcon(ops: OzonOperation[]): Map<number, SkuEcon> {
  const agg = new Map<number, { revenue: number; commission: number; logistics: number; sold: number }>();
  for (const op of ops) {
    if (op.type !== 'orders') continue;
    const sku = op.items[0]?.sku;
    if (sku === undefined) continue;
    let a = agg.get(sku);
    if (!a) { a = { revenue: 0, commission: 0, logistics: 0, sold: 0 }; agg.set(sku, a); }
    for (const svc of op.services) if (LOGISTICS_SERVICES.has(svc.name)) a.logistics += svc.price;
    if (op.accruals_for_sale <= 0) continue;
    a.revenue += op.accruals_for_sale;
    a.commission += op.sale_commission;
    a.sold++;
  }

  const out = new Map<number, SkuEcon>();
  for (const [sku, a] of agg) {
    if (a.sold === 0) continue;
    const avgPrice = a.revenue / a.sold;
    const cost = COST_BY_SKU[sku] ?? activeShop.defaultCost;
    const commPerUnit = a.commission / a.sold;           // < 0
    const logPerUnit = a.logistics / a.sold;             // < 0
    const acquiring = avgPrice * ACQUIRING_RATE;
    const tax = avgPrice * TAX_RATE;
    const preAdsMargin = avgPrice + commPerUnit + logPerUnit - acquiring - cost - tax;
    const breakevenDrr = avgPrice > 0 ? (preAdsMargin / avgPrice) * 100 : 0;
    out.set(sku, { sold: a.sold, avgPrice, preAdsMargin: Math.round(preAdsMargin), breakevenDrr: +breakevenDrr.toFixed(1) });
  }
  return out;
}

const nameFor = (sku: number, fallback = ''): string => {
  const offer = OFFER_BY_SKU[sku];
  if (offer) return `${offer} ${SHORT_NAME_BY_OFFER[offer] ?? ''}`.trim();
  return fallback || `SKU ${sku}`;
};

const NO_ORDERS_DRR = 999; // сентинел: есть расход, но прямых заказов нет

/**
 * ДРР по ПРЯМЫМ рекламным заказам (как в кабинете Ozon): расход / ordersMoney.
 * НЕ используем product_gmv — это полный оборот товара (вкл. органику), он занижает ДРР в разы.
 * Если расход есть, а прямых заказов нет → сентинел 999 («расход без заказов»).
 */
function directDrr(s: SkuAdStat): number {
  if (s.ordersMoney > 0) return +((s.spent / s.ordersMoney) * 100).toFixed(1);
  return s.spent > 0 ? NO_ORDERS_DRR : 0;
}

/** ДРР с учётом модельной атрибуции (мягче): расход / (ordersMoney + modelsMoney). */
function modelDrr(s: SkuAdStat): number {
  const base = s.ordersMoney + s.modelsMoney;
  if (base > 0) return +((s.spent / base) * 100).toFixed(1);
  return s.spent > 0 ? NO_ORDERS_DRR : 0;
}

const drrTxt = (d: number): string => (d >= NO_ORDERS_DRR ? '∞' : `${d}%`);

/** Короткий ярлык состояния кампании. */
function stateShort(state: string): string {
  return ({
    CAMPAIGN_STATE_RUNNING: 'активна',
    CAMPAIGN_STATE_STOPPED: 'нет бюджета',
    CAMPAIGN_STATE_INACTIVE: 'выключена',
    CAMPAIGN_STATE_PLANNED: 'запланирована',
  } as Record<string, string>)[state] ?? state.replace('CAMPAIGN_STATE_', '').toLowerCase();
}

interface AdRow {
  sku: number;
  name: string;
  stat?: SkuAdStat;
  e?: SkuEcon;
  campaign: Campaign;
  running: boolean;
  drr: number;
  drrModel: number;
  drrCart: number;
  cartToOrder: number;
  expectedOrders: number;
  verdict: string;
  icon: string;
  action: 'держать' | 'резать' | 'выключить' | 'масштабировать' | 'ждать' | '—';
}

/** ДРР по ожидаемой выручке из корзин: расход / (корзины × k × средний чек). */
function cartBasedDrr(spent: number, carts: number, k: number, avgPrice: number): number {
  const rev = carts * k * avgPrice;
  if (rev <= 0) return spent > 0 ? NO_ORDERS_DRR : 0;
  return +((spent / rev) * 100).toFixed(1);
}

/** k = cart→order: по SKU если достаточно корзин, иначе дефолт магазина. */
function resolveCartToOrder(stat: SkuAdStat | undefined, shopK: number): number {
  if (!stat || stat.toCart < MIN_CARTS_FOR_K) return shopK;
  if (stat.orders > 0) return Math.min(0.5, stat.orders / stat.toCart);
  return shopK;
}

/** Вердикт по одной РК. Всегда начинается с «РК {id}:». */
function verdictForCampaign(
  c: Campaign,
  stat: SkuAdStat | undefined,
  e: SkuEcon | undefined,
  running: boolean,
  shopK: number,
): { icon: string; verdict: string; drr: number; drrModel: number; drrCart: number; cartToOrder: number; expectedOrders: number; action: AdRow['action'] } {
  const rk = `РК ${c.id}`;
  const drr = stat ? directDrr(stat) : 0;
  const drrModel = stat ? modelDrr(stat) : 0;
  const k = resolveCartToOrder(stat, shopK);
  const carts = stat?.toCart ?? 0;
  const expectedOrders = +(carts * k).toFixed(1);
  const avgPrice = e?.avgPrice ?? (stat && stat.orders > 0 ? stat.ordersMoney / stat.orders : 0);
  const drrCart = stat && avgPrice > 0 ? cartBasedDrr(stat.spent, carts, k, avgPrice) : (stat?.spent ? NO_ORDERS_DRR : 0);
  const modelNote = drrModel < drr && drrModel < NO_ORDERS_DRR ? `, модель ${drrModel}%` : '';
  const cartNote = carts > 0 ? `, корз ${carts}→~${expectedOrders} зак., ДРРᵏ ${drrTxt(drrCart)}` : '';

  if (!running) {
    const marg = e ? `маржа до рекл. ${e.preAdsMargin}₽/шт, продаж ${e.sold}` : 'нет органических продаж';
    const spentNote = stat?.spent ? ` · ранее ${fmt(stat.spent)}₽` : '';
    const icon = e && e.preAdsMargin > 0 ? '🟢' : '⚪️';
    return { icon, drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: '—', verdict: `${rk} (${stateShort(c.state)}): выключена — ${marg}${spentNote}` };
  }

  if (!stat || stat.spent <= 0) {
    return { icon: '⚪️', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: '—', verdict: `${rk}: нет показов за период` };
  }

  const beDrr = e?.breakevenDrr ?? 0;
  const expMargin = e ? Math.round(expectedOrders * e.preAdsMargin - stat.spent) : 0;

  // Фактический ДРР в норме
  if (drr < NO_ORDERS_DRR && e && e.preAdsMargin > 0) {
    if (drr <= beDrr * 0.6) {
      return { icon: '✅', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'масштабировать', verdict: `${rk}: масштабировать — факт ДРР ${drr}% < безуб ${beDrr}%${cartNote}` };
    }
    if (drr <= beDrr) {
      return { icon: '🟡', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'держать', verdict: `${rk}: держать — факт ДРР ${drr}% при безуб ${beDrr}%${cartNote}` };
    }
    return { icon: '🔴', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'резать', verdict: `${rk}: резать — факт ДРР ${drr}% > безуб ${beDrr}%${cartNote}` };
  }

  // 0 прямых заказов — смотрим корзины
  if (drr >= NO_ORDERS_DRR) {
    if (carts === 0) {
      return { icon: '🔴', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'выключить', verdict: `${rk}: выключить — ${fmt(stat.spent)}₽ расход, 0 корзин${modelNote}` };
    }
    if (e && drrCart < NO_ORDERS_DRR && drrCart <= beDrr && expMargin > 0) {
      return { icon: '🟡', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'ждать', verdict: `${rk}: ждать 7–14д — 0 заказов, но корз ${carts}, ожид.маржа +${expMargin}₽, ДРРᵏ ${drrTxt(drrCart)} vs безуб ${beDrr}%${modelNote}` };
    }
    if (e && drrCart < NO_ORDERS_DRR && drrCart <= beDrr) {
      return { icon: '🟡', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'ждать', verdict: `${rk}: ждать — корз ${carts}, ДРРᵏ ${drrTxt(drrCart)} ≤ безуб ${beDrr}%, заказы долетят${modelNote}` };
    }
    if (carts > 0 && !e) {
      return { icon: '🟡', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'ждать', verdict: `${rk}: ждать — корз ${carts}, нет данных о марже${modelNote}` };
    }
    return { icon: '🔴', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'выключить', verdict: `${rk}: выключить — корз ${carts}, ДРРᵏ ${drrTxt(drrCart)} > безуб ${beDrr}% (ожид.маржа ${expMargin}₽)${modelNote}` };
  }

  if (e) {
    return { icon: '⛔', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'резать', verdict: `${rk}: нет маржи без рекламы — поднять цену` };
  }
  return { icon: '🟡', drr, drrModel, drrCart, cartToOrder: k, expectedOrders, action: 'держать', verdict: `${rk}: ДРР ${drr}% (нет данных о марже)${cartNote}` };
}

async function main(): Promise<void> {
  logActiveShop();
  console.log(`📣 Анализ рекламы [${activeShop.name}] за ${days} дней${DRY ? '  (DRY)' : ''}`);
  console.log('ДРР = расход / выручка с ПРЯМЫХ рекламных заказов (как в кабинете Ozon), не по обороту товара.\n');

  const token = await getPerfToken();
  const campaigns = await fetchCampaigns(token);
  const live = campaigns.filter((c) => !DEAD_STATES.has(c.state) && AD_TYPES.has(c.advObjectType));
  console.log(`Кампаний всего: ${campaigns.length}, живых товарных: ${live.length}`);

  console.log('Запрашиваю статистику Performance (может занять ~10–30 сек)...');
  const dateFrom = dateStr(-days);
  const dateTo = dateStr(0);

  const ops = await fetchAllOperations(new Date(`${dateFrom}T00:00:00+03:00`), new Date(`${dateTo}T23:59:59+03:00`));
  const econ = computeSkuEcon(ops);

  const statsPerCampaign = await fetchSkuStatsPerCampaign(token, live.map((c) => c.id), dateFrom, dateTo);

  // shop-level cart→order k
  let shopCarts = 0, shopOrders = 0;
  for (const skuMap of statsPerCampaign.values()) {
    for (const s of skuMap.values()) { shopCarts += s.toCart; shopOrders += s.orders; }
  }
  const shopK = shopCarts >= 20 && shopOrders > 0
    ? Math.min(0.5, shopOrders / shopCarts)
    : DEFAULT_CART_TO_ORDER;
  console.log(`Cart→Order магазина: ${(100 * shopK).toFixed(1)}% (корз ${shopCarts}, зак ${shopOrders})\n`);

  const priceItems = await fetchAllPrices();
  const cardPriceByOffer = new Map(priceItems.map((it) => [it.offer_id, Number(it.price?.price ?? 0)]));

  const rows: AdRow[] = [];
  const advertisedSkus = new Set<number>();

  for (const c of live) {
    const prods = await fetchCampaignProducts(token, c.id);
    const stats = statsPerCampaign.get(c.id) ?? new Map<string, SkuAdStat>();
    const running = ACTIVE_STATES.has(c.state);

    for (const p of prods) {
      const sku = Number(p.sku);
      advertisedSkus.add(sku);
      const stat = stats.get(p.sku);
      const e = econ.get(sku);
      const v = verdictForCampaign(c, stat, e, running, shopK);
      rows.push({
        sku,
        name: nameFor(sku, p.title),
        stat,
        e,
        campaign: c,
        running,
        drr: v.drr,
        drrModel: v.drrModel,
        drrCart: v.drrCart,
        cartToOrder: v.cartToOrder,
        expectedOrders: v.expectedOrders,
        verdict: v.verdict,
        icon: v.icon,
        action: v.action,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const candidates = PRODUCTS
    .filter((p) => p.sku !== undefined && !advertisedSkus.has(p.sku))
    .map((p) => ({ p, e: econ.get(p.sku!) }))
    .filter((x) => x.e && x.e.sold > 0)
    .sort((a, b) => (b.e!.sold) - (a.e!.sold));

  printReport(rows, candidates, shopK, cardPriceByOffer);
  if (!DRY) await sendTelegram(rows, candidates);
}

function printPriceWithDrr(rows: AdRow[], cardPriceByOffer: Map<string, number>): void {
  const seen = new Set<number>();
  const active = rows.filter((r) => r.running && r.stat && r.stat.spent > 0);
  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  💰 ЦЕНА С ЗАЛОЖЕННЫМ ДРР (цель +${TARGET_PROFIT}₽/шт)`);
  console.log('  ДРРᵏ = ожидаемый ДРР из корзин. Δ = на сколько поднять карточную цену.');
  console.log('─'.repeat(110));
  console.log('  ' + 'Товар'.padEnd(28) + 'Сейчас'.padStart(8) + 'Без ДРР'.padStart(8) + 'ДРРᵏ%'.padStart(7) + 'С ДРРᵏ'.padStart(8) + '   Δ'.padStart(7) + '  РК');
  for (const r of active) {
    if (seen.has(r.sku)) continue;
    seen.add(r.sku);
    const offer = OFFER_BY_SKU[r.sku];
    if (!offer) continue;
    const drrUse = r.drrCart < NO_ORDERS_DRR ? r.drrCart : (r.drr < NO_ORDERS_DRR ? r.drr : r.e?.breakevenDrr ?? 15);
    if (drrUse <= 0 || drrUse >= NET_RATE * 100) continue;
    const base = priceForProfit(offer, TARGET_PROFIT);
    const withDrr = priceForProfitWithDrr(offer, TARGET_PROFIT, drrUse);
    if (!base || !withDrr) continue;
    const current = cardPriceByOffer.get(offer) ?? 0;
    const delta = withDrr - current;
    console.log('  ' +
      r.name.slice(0, 27).padEnd(28) +
      (current ? String(current) : '—').padStart(8) +
      String(base).padStart(8) +
      drrTxt(drrUse).padStart(7) +
      String(withDrr).padStart(8) +
      ((delta >= 0 ? '+' : '') + delta).padStart(7) +
      `  ${r.campaign.id}`);
  }
}

// ─── Вывод в консоль ─────────────────────────────────────────────────────────
function campaignShort(c: Campaign): string {
  return `${c.id} «${c.title.slice(0, 22)}»`;
}

function printReport(rows: AdRow[], candidates: any[], shopK: number, cardPriceByOffer: Map<string, number>): void {
  const running = rows.filter((r) => r.running).sort((a, b) => (b.stat?.spent ?? 0) - (a.stat?.spent ?? 0));
  const off = rows.filter((r) => !r.running);

  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  🟢 СЕЙЧАС В РЕКЛАМЕ (${running.length} позиций) — вердикт: держать / ждать / резать / выключить`);
  console.log('─'.repeat(110));
  console.log('  ' + 'Товар'.padEnd(24) + 'РК'.padStart(10) + 'Расх'.padStart(7) + 'Корз'.padStart(5) + 'Зак'.padStart(4) + 'ДРР'.padStart(6) + 'ДРРᵏ'.padStart(6) + 'Безуб'.padStart(6) + '  Действие / вердикт');
  for (const r of running) {
    const actionTag = { держать: '🟡', ждать: '⏳', резать: '🔴', выключить: '⛔', масштабировать: '✅', '—': '⚪️' }[r.action];
    console.log('  ' +
      r.name.slice(0, 23).padEnd(24) +
      r.campaign.id.padStart(10) +
      fmt(r.stat?.spent ?? 0).padStart(7) +
      String(r.stat?.toCart ?? 0).padStart(5) +
      String(r.stat?.orders ?? 0).padStart(4) +
      (r.stat?.spent ? drrTxt(r.drr) : '—').padStart(6) +
      (r.stat?.toCart ? drrTxt(r.drrCart) : '—').padStart(6) +
      (r.e ? `${r.e.breakevenDrr}%` : '—').padStart(6) +
      `  ${actionTag} ${r.action.toUpperCase()}`);
    console.log(`      ${r.verdict}`);
  }

  // Сводка решений
  const actions = ['выключить', 'резать', 'ждать', 'держать', 'масштабировать'] as const;
  console.log(`\n  📋 РЕШЕНИЯ:`);
  for (const act of actions) {
    const list = running.filter((r) => r.action === act);
    if (!list.length) continue;
    console.log(`  ${act.toUpperCase()} (${list.length}): ${list.map((r) => `РК ${r.campaign.id} ${OFFER_BY_SKU[r.sku] ?? r.sku}`).join(', ')}`);
  }

  printPriceWithDrr(rows, cardPriceByOffer);

  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  💤 НАСТРОЕНЫ, НО ВЫКЛЮЧЕНЫ — можно включить (${off.length})`);
  console.log('─'.repeat(100));
  for (const r of off.sort((a, b) => (b.e?.preAdsMargin ?? -1e9) - (a.e?.preAdsMargin ?? -1e9))) {
    console.log(`  ${r.icon} ${r.name.slice(0, 28).padEnd(29)} ${campaignShort(r.campaign)}`);
    console.log(`      ${r.verdict}`);
  }

  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  ➕ КАНДИДАТЫ ДОБАВИТЬ В РЕКЛАМУ — продаются сами, но не в РК (${candidates.length})`);
  console.log('─'.repeat(100));
  for (const c of candidates) {
    const tag = c.e.preAdsMargin > 0 ? '✅' : '⛔';
    console.log(`  ${tag} ${(`${c.p.offerId} ${c.p.name}`).slice(0, 34).padEnd(35)} продаж ${String(c.e.sold).padStart(3)} · маржа до рекл. ${c.e.preAdsMargin}₽/шт · безуб.ДРР ${c.e.breakevenDrr}%`);
  }
  console.log('');
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(rows: AdRow[], candidates: any[]): Promise<void> {
  const running = rows.filter((r) => r.running).sort((a, b) => (b.stat?.spent ?? 0) - (a.stat?.spent ?? 0));
  const off = rows.filter((r) => !r.running && r.e && r.e.preAdsMargin > 0);
  const parts: string[] = [`<b>📣 Анализ рекламы — ${days} дн.</b>`];

  parts.push(`\n<b>🟢 Сейчас в рекламе (${running.length}):</b>`);
  for (const r of running) {
    const drrStr = r.stat?.spent ? `ДРР ${drrTxt(r.drr)}${r.e ? `/безуб ${r.e.breakevenDrr}%` : ''}` : 'нет показов';
    parts.push(`${r.icon} <b>${esc(r.name.slice(0, 24))}</b> — ${esc(drrStr)}, расход ${esc(fmt(r.stat?.spent ?? 0))}₽`);
    parts.push(`   ${esc(r.verdict)}`);
    parts.push(`   <i>${esc(campaignShort(r.campaign))} (${stateShort(r.campaign.state)})</i>`);
  }

  const offGood = off.sort((a, b) => (b.e!.preAdsMargin) - (a.e!.preAdsMargin));
  if (offGood.length) {
    parts.push(`\n<b>💤 Выключены, но прибыльны — включить (${offGood.length}):</b>`);
    for (const r of offGood) {
      parts.push(`🟢 <b>${esc(r.name.slice(0, 24))}</b>`);
      parts.push(`   ${esc(r.verdict)}`);
    }
  }

  const candGood = candidates.filter((c: any) => c.e.preAdsMargin > 0);
  if (candGood.length) {
    parts.push(`\n<b>➕ Добавить в рекламу (${candGood.length}):</b>`);
    for (const c of candGood) parts.push(`✅ <b>${esc(c.p.offerId)} ${esc(c.p.name.slice(0, 22))}</b> — продаж ${c.e.sold}, маржа ${c.e.preAdsMargin}₽/шт, безуб.ДРР ${c.e.breakevenDrr}%`);
  }

  parts.push(`\n<i>Безуб.ДРР = сколько % от цены можно тратить на рекламу без убытка. Вердикт всегда привязан к id РК.</i>`);
  await sendHtml(parts.join('\n'));
  console.log('✅ Отчёт отправлен в Telegram');
}

// ─── utils ─────────────────────────────────────────────────────────────────
function dateStr(offsetDays: number): string {
  return new Date(moscowNow().getTime() + offsetDays * 86400_000).toISOString().slice(0, 10);
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
