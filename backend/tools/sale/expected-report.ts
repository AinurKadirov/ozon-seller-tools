/**
 * expected-report.ts — теоретическая (начисленная) прибыль по ЗАКАЗАМ за день.
 *
 * В отличие от daily/weekly (касса по транзакциям с лагом 2–14 дней), этот отчёт
 * берёт ЗАКАЗЫ, оформленные в указанный день, и сразу оценивает их прибыль:
 *
 *   прибыль/ед = цена(из заказа) − комиссия(% из заказа) − логистика(формула Ozon
 *               по кластеру назначения) − эквайринг − себестоимость − налог 7%
 *               − доля рекламы(оценка по ДРР)
 *
 * Логистика считается по реальной формуле Ozon 2026 (см. lib/logistics.ts):
 * базовый тариф из карточки + наценка за нелокальность по кластеру + последняя миля.
 *
 * Запуск:
 *   npm run ozon:expected                       — вчера и сегодня, отправка в ТГ
 *   npm run ozon:expected -- 2026-06-03          — конкретный день
 *   npm run ozon:expected -- 2026-06-01 2026-06-04
 *   npm run ozon:expected -- --dry               — только консоль
 *   npm run ozon:expected -- 2026-06-01 2026-06-04 --verify  — сверка с фактом
 *   npm run ozon:expected -- --drr 7.5           — задать ДРР для оценки рекламы
 */
import { TAX_RATE, OzonOperation, LOGISTICS_SERVICES, ADS_OPERATION_TYPES } from './lib/economics';
import { fetchPostingsFbo, fetchAllOperations, fetchAllPrices, Posting } from './lib/ozon';
import { estimateLogistics, LogisticsCardData, DEFAULT_BASE_LOGISTICS } from './lib/logistics';
import { COST_BY_SKU, OFFER_BY_SKU } from './lib/catalog';
import { sendMarkdown } from './lib/telegram';
import { fmt, escapeMd as esc, moscowNow } from './lib/format';
import { logActiveShop, activeShop } from './lib/shop-config';

const ACQUIRING_RATE = 0.006; // эквайринг ≈ 0.6% от выручки (откалибровано по факту, бэктест 01–04.06)
const DEFAULT_BASE = DEFAULT_BASE_LOGISTICS; // база прямой логистики по умолчанию
const DEFAULT_RETURN_FLOW = 90;              // обратная логистика невыкупа по умолчанию, ₽
const DRY = process.argv.includes('--dry');
const VERIFY = process.argv.includes('--verify');
const SUMMARY = process.argv.includes('--summary');
const drrArgIdx = process.argv.indexOf('--drr');
const DRR = drrArgIdx >= 0 ? Number(process.argv[drrArgIdx + 1]) / 100 : 0.075;
const daysArgIdx = process.argv.indexOf('--days');
const DAYS = daysArgIdx >= 0 ? Number(process.argv[daysArgIdx + 1]) : 0;
const dateArgs = process.argv.slice(2).filter((a) => !a.startsWith('--') && /^\d{4}-\d{2}-\d{2}$/.test(a));

interface CardInfo extends LogisticsCardData { commPct: number; returnFlow: number; }

function mskDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

interface LineCalc {
  offerId: string;
  units: number;
  revenue: number;
  commission: number;
  logistics: number;
  acquiring: number;
  cost: number;
  tax: number;
  marginBeforeAds: number;
  nonLocalUnits: number;
  surchargeRub: number;
}

function calcLine(
  offerId: string, sku: number, qty: number, price: number,
  commissionPercent: number, clusterFrom: string, clusterTo: string,
  card: CardInfo | undefined,
): LineCalc {
  const commPct = commissionPercent > 0 ? commissionPercent / 100 : (card?.commPct ?? 46) / 100;
  const log = estimateLogistics(price, clusterFrom, clusterTo, card);
  const revenue = price * qty;
  const commission = revenue * commPct;
  const logistics = log.total * qty;
  const acquiring = revenue * ACQUIRING_RATE;
  const unitCost = COST_BY_SKU[sku] ?? activeShop.defaultCost;
  const cost = (unitCost > 0 ? unitCost : 0) * qty;
  const tax = revenue * TAX_RATE;
  return {
    offerId, units: qty, revenue,
    commission, logistics, acquiring, cost, tax,
    marginBeforeAds: revenue - commission - logistics - acquiring - cost - tax,
    nonLocalUnits: log.isLocal ? 0 : qty,
    surchargeRub: log.surcharge * qty,
  };
}

interface DayResult {
  date: string;
  orders: number;
  cancelled: number;
  byOffer: Map<string, LineCalc>;
  totals: LineCalc;
}

function emptyLine(offerId = ''): LineCalc {
  return { offerId, units: 0, revenue: 0, commission: 0, logistics: 0, acquiring: 0, cost: 0, tax: 0, marginBeforeAds: 0, nonLocalUnits: 0, surchargeRub: 0 };
}
function addLine(a: LineCalc, b: LineCalc): void {
  a.units += b.units; a.revenue += b.revenue; a.commission += b.commission;
  a.logistics += b.logistics; a.acquiring += b.acquiring; a.cost += b.cost;
  a.tax += b.tax; a.marginBeforeAds += b.marginBeforeAds;
  a.nonLocalUnits += b.nonLocalUnits; a.surchargeRub += b.surchargeRub;
}

function computeDay(date: string, postings: Posting[], cards: Map<string, CardInfo>): DayResult {
  const dayPostings = postings.filter((p) => mskDate(p.createdAt) === date);
  const byOffer = new Map<string, LineCalc>();
  const totals = emptyLine();
  let cancelled = 0, orders = 0;
  for (const p of dayPostings) {
    if (p.status === 'cancelled') { cancelled++; continue; }
    orders++;
    for (const pr of p.products) {
      const display = OFFER_BY_SKU[pr.sku] ?? pr.offerId;
      const line = calcLine(display, pr.sku, pr.qty, pr.price, pr.commissionPercent, p.clusterFrom, p.clusterTo, cards.get(pr.offerId));
      let agg = byOffer.get(display);
      if (!agg) { agg = emptyLine(display); byOffer.set(display, agg); }
      addLine(agg, line);
      addLine(totals, line);
    }
  }
  return { date, orders, cancelled, byOffer, totals };
}

function printDay(r: DayResult): void {
  const ads = r.totals.revenue * DRR;
  const profit = r.totals.marginBeforeAds - ads;
  const margin = r.totals.revenue > 0 ? (profit / r.totals.revenue) * 100 : 0;
  console.log(`\n📅 ${r.date}  —  заказов ${r.orders}${r.cancelled ? ` (+${r.cancelled} отмен)` : ''}, единиц ${r.totals.units}`);
  console.log(`   Выручка по заказам: ${fmt(r.totals.revenue)} ₽`);
  console.log(`   Комиссия ${fmt(-r.totals.commission)} · Логистика ${fmt(-r.totals.logistics)} (из них наценка за нелокальность ${fmt(-r.totals.surchargeRub)}, нелокальных ед. ${r.totals.nonLocalUnits}/${r.totals.units})`);
  console.log(`   Эквайринг ${fmt(-r.totals.acquiring)} · Себестоимость ${fmt(-r.totals.cost)} · Налог ${fmt(-r.totals.tax)}`);
  console.log(`   Маржа до рекламы: ${fmt(r.totals.marginBeforeAds)} ₽`);
  console.log(`   Реклама (оценка ДРР ${(DRR * 100).toFixed(1)}%): ${fmt(-ads)} ₽`);
  console.log(`   ${profit >= 0 ? '✅' : '🔴'} Ожидаемая прибыль: ${fmt(profit)} ₽  ·  маржа ${margin.toFixed(1)}%`);

  const rows = [...r.byOffer.values()].sort((a, b) => a.marginBeforeAds - b.marginBeforeAds);
  console.log(`   ── по товарам (маржа до рекламы) ──`);
  for (const x of rows) {
    const perUnit = x.units > 0 ? x.marginBeforeAds / x.units : 0;
    const icon = x.marginBeforeAds < 0 ? ' 🔴' : '';
    console.log(`     ${x.offerId.padEnd(8)} ${String(x.units).padStart(3)} шт.  ${fmt(x.revenue / Math.max(1, x.units)).padStart(6)} ₽/шт  → ${(perUnit >= 0 ? '+' : '') + fmt(perUnit)} ₽/шт  итого ${(x.marginBeforeAds >= 0 ? '+' : '') + fmt(x.marginBeforeAds)} ₽${icon}`);
  }
}

function buildTgMessage(results: DayResult[]): string {
  const lines: (string | null)[] = [`🧮 *Прогноз прибыли по заказам*`, ''];
  for (const r of results) {
    const ads = r.totals.revenue * DRR;
    const profit = r.totals.marginBeforeAds - ads;
    const margin = r.totals.revenue > 0 ? (profit / r.totals.revenue) * 100 : 0;
    const icon = profit >= 0 ? '✅' : '🔴';
    const [, mm, dd] = r.date.split('-');
    lines.push(
      `*${dd}\\.${mm}* — ${r.orders} зак\\., ${r.totals.units} шт\\.`,
      `  💰 Выручка: ${esc(fmt(r.totals.revenue))} ₽`,
      `  📦 Логистика: ${esc(fmt(-r.totals.logistics))} ₽ \\(наценка нелок\\. ${esc(fmt(-r.totals.surchargeRub))} ₽, ${r.totals.nonLocalUnits}/${r.totals.units} ед\\.\\)`,
      `  📈 Маржа до рекламы: ${esc(fmt(r.totals.marginBeforeAds))} ₽`,
      `  ${icon} Ожид\\. прибыль: *${esc(fmt(profit))} ₽* \\(${esc(margin.toFixed(1))}%\\)`,
      '',
    );
  }
  lines.push(`_Оценка по заказам дня, реклама по ДРР ${esc((DRR * 100).toFixed(1))}%\\. Касса \\(факт\\) приходит позже\\._`);
  return lines.filter((l): l is string => l !== null).join('\n');
}

// ─── Сводная юнит-экономика по товарам (от текущих цен, с выкупом и ДРР) ───────
interface SummaryRow extends LineCalc {
  cancelledUnits: number;
  returnPenaltyPerUnit: number; // обратная логистика на 1 невыкуп
}

interface Summary {
  rows: SummaryRow[];
  soldUnits: number;
  cancelledUnits: number;
  buyoutRate: number;
}

function buildSummary(postings: Posting[], cards: Map<string, CardInfo>, dates: string[]): Summary {
  const byOffer = new Map<string, SummaryRow>();
  const getRow = (display: string, card?: CardInfo): SummaryRow => {
    let r = byOffer.get(display);
    if (!r) {
      r = { ...emptyLine(display), cancelledUnits: 0, returnPenaltyPerUnit: (card?.baseDirectFlow || DEFAULT_BASE) + (card?.returnFlow || DEFAULT_RETURN_FLOW) };
      byOffer.set(display, r);
    }
    return r;
  };

  for (const p of postings) {
    if (!dates.includes(mskDate(p.createdAt))) continue;
    for (const pr of p.products) {
      const display = OFFER_BY_SKU[pr.sku] ?? pr.offerId;
      const card = cards.get(pr.offerId);
      const r = getRow(display, card);
      if (p.status === 'cancelled') { r.cancelledUnits += pr.qty; continue; }
      const line = calcLine(display, pr.sku, pr.qty, pr.price, pr.commissionPercent, p.clusterFrom, p.clusterTo, card);
      addLine(r, line);
    }
  }

  const rows = [...byOffer.values()].filter((r) => r.units > 0 || r.cancelledUnits > 0);
  const soldUnits = rows.reduce((s, r) => s + r.units, 0);
  const cancelledUnits = rows.reduce((s, r) => s + r.cancelledUnits, 0);
  return { rows, soldUnits, cancelledUnits, buyoutRate: soldUnits + cancelledUnits > 0 ? soldUnits / (soldUnits + cancelledUnits) : 1 };
}

/** Прибыль/шт (если выкуплен) и итог с поправкой на невыкупы. */
function rowProfit(r: SummaryRow) {
  const ads = r.revenue * DRR;
  const profitSold = r.marginBeforeAds - ads;          // суммарно по проданным
  const perUnit = r.units > 0 ? profitSold / r.units : 0;
  const returnPenalty = r.cancelledUnits * r.returnPenaltyPerUnit; // потери на невыкупах
  const totalExpected = profitSold - returnPenalty;    // ожидаемый итог по товару
  const buyout = r.units + r.cancelledUnits > 0 ? r.units / (r.units + r.cancelledUnits) : 1;
  return { ads, profitSold, perUnit, returnPenalty, totalExpected, buyout };
}

function printSummary(s: Summary, dates: string[]): void {
  console.log(`\n━━━ СВОДНАЯ ЮНИТ-ЭКОНОМИКА от текущих цен (${dates[0]} → ${dates[dates.length - 1]}) ━━━`);
  console.log(`  Средний выкуп: ${(s.buyoutRate * 100).toFixed(0)}% (продано ${s.soldUnits} / отменено-невыкуп ${s.cancelledUnits}) · ДРР ${(DRR * 100).toFixed(1)}%`);
  console.log(`  ${'Товар'.padEnd(9)}${'шт'.padStart(4)}${'вык%'.padStart(6)}${'цена'.padStart(7)}${'комис'.padStart(7)}${'логис'.padStart(7)}${'себес'.padStart(7)}${'рекл'.padStart(6)}${'приб/шт'.padStart(8)}${'итого'.padStart(9)}`);
  console.log('  ' + '─'.repeat(76));
  const enriched = s.rows.map((r) => ({ r, p: rowProfit(r) }));
  enriched.sort((a, b) => b.p.totalExpected - a.p.totalExpected);
  let totProfit = 0, totRev = 0;
  for (const { r, p } of enriched) {
    const price = r.units > 0 ? r.revenue / r.units : 0;
    const icon = p.totalExpected < 0 ? ' 🔴' : '';
    totProfit += p.totalExpected; totRev += r.revenue;
    console.log(
      `  ${r.offerId.padEnd(9)}${String(r.units).padStart(4)}${(p.buyout * 100).toFixed(0).padStart(6)}` +
      `${fmt(price).padStart(7)}${fmt(-r.commission / Math.max(1, r.units)).padStart(7)}${fmt(-r.logistics / Math.max(1, r.units)).padStart(7)}` +
      `${fmt(-r.cost / Math.max(1, r.units)).padStart(7)}${fmt(-p.ads / Math.max(1, r.units)).padStart(6)}` +
      `${((p.perUnit >= 0 ? '+' : '') + fmt(p.perUnit)).padStart(8)}${((p.totalExpected >= 0 ? '+' : '') + fmt(p.totalExpected)).padStart(9)}${icon}`,
    );
  }
  console.log('  ' + '─'.repeat(76));
  const margin = totRev > 0 ? (totProfit / totRev) * 100 : 0;
  console.log(`  ИТОГО ожидаемая прибыль: ${fmt(totProfit)} ₽  ·  выручка ${fmt(totRev)} ₽  ·  маржа ${margin.toFixed(1)}%`);
}

function buildSummaryTg(s: Summary, dates: string[]): string {
  const enriched = s.rows.map((r) => ({ r, p: rowProfit(r) }));
  enriched.sort((a, b) => b.p.totalExpected - a.p.totalExpected);
  const totProfit = enriched.reduce((sum, e) => sum + e.p.totalExpected, 0);
  const totRev = enriched.reduce((sum, e) => sum + e.r.revenue, 0);
  const margin = totRev > 0 ? (totProfit / totRev) * 100 : 0;

  const tableLines = enriched.map(({ r, p }) => {
    const price = r.units > 0 ? r.revenue / r.units : 0;
    const flag = p.totalExpected < 0 ? ' !' : '';
    return `${r.offerId.padEnd(8)}${String(r.units).padStart(3)}шт ${fmt(price).padStart(5)}₽ ${((p.perUnit >= 0 ? '+' : '') + fmt(p.perUnit)).padStart(6)}/шт ${((p.totalExpected >= 0 ? '+' : '') + fmt(p.totalExpected)).padStart(7)}${flag}`;
  });

  const [, m1, d1] = dates[0].split('-');
  const [, m2, d2] = dates[dates.length - 1].split('-');
  const icon = totProfit >= 0 ? '✅' : '🔴';
  return [
    `🧮 *Юнит\\-экономика от текущих цен*`,
    `📅 ${d1}\\.${m1} — ${d2}\\.${m2} \\(${dates.length} дн\\.\\)`,
    `🛒 Средний выкуп: *${esc((s.buyoutRate * 100).toFixed(0))}%* · ДРР ${esc((DRR * 100).toFixed(1))}%`,
    '',
    `*Товар / шт / цена / приб\\.\\/шт / итого:*`,
    '```',
    ...tableLines,
    '```',
    `${icon} *Ожид\\. прибыль: ${esc(fmt(totProfit))} ₽* \\(маржа ${esc(margin.toFixed(1))}%\\)`,
    `_Прибыль с учётом выкупа, рекламы \\(ДРР\\), логистики по кластерам и невыкупов\\._`,
  ].join('\n');
}

// ─── Сверка прогноза с фактом (по posting_number) ─────────────────────────────
interface ActualAgg { revenue: number; commission: number; logistics: number; acquiring: number; soldUnits: number; cost: number; }

async function verify(results: DayResult[], postings: Posting[], cards: Map<string, CardInfo>, dates: string[]): Promise<void> {
  const minDate = dates[0];
  const now = moscowNow();
  console.log(`\n🔍 Сверка с фактом: тяну транзакции ${minDate} → ${now.toISOString().slice(0, 10)} ...`);
  const ops: OzonOperation[] = await fetchAllOperations(
    new Date(`${minDate}T00:00:00+03:00`),
    new Date(now.toISOString().slice(0, 10) + 'T23:59:59+03:00'),
  );

  // posting_number → фактические суммы (по продажам с accruals_for_sale>0).
  const actualByPosting = new Map<string, ActualAgg>();
  const adsTotal = ops.filter((o) => ADS_OPERATION_TYPES.has(o.operation_type)).reduce((s, o) => s + o.amount, 0);
  for (const op of ops) {
    const pn = op.posting?.posting_number;
    if (!pn) continue;
    let a = actualByPosting.get(pn);
    if (!a) { a = { revenue: 0, commission: 0, logistics: 0, acquiring: 0, soldUnits: 0, cost: 0 }; actualByPosting.set(pn, a); }
    if (op.type === 'orders' && op.accruals_for_sale > 0) {
      a.revenue += op.accruals_for_sale;
      a.commission += op.sale_commission;
      a.soldUnits += 1;
      const sku = op.items[0]?.sku;
      const unitCost = sku !== undefined ? (COST_BY_SKU[sku] ?? activeShop.defaultCost) : 0;
      if (unitCost > 0) a.cost += unitCost;
      for (const svc of op.services ?? []) if (LOGISTICS_SERVICES.has(svc.name)) a.logistics += svc.price;
    } else if (op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation') {
      a.acquiring += op.amount;
    } else {
      for (const svc of op.services ?? []) if (LOGISTICS_SERVICES.has(svc.name)) a.logistics += svc.price;
    }
  }

  // Сопоставляем только заказы выбранных дней, у которых уже есть факт (продажа).
  const selected = postings.filter((p) => dates.includes(mskDate(p.createdAt)) && p.status !== 'cancelled');
  let matched = 0, unmatched = 0;
  let expRev = 0, actRev = 0, expComm = 0, actComm = 0, expLog = 0, actLog = 0, expMargin = 0, actMargin = 0;

  for (const p of selected) {
    const act = actualByPosting.get(p.postingNumber);
    if (!act || act.soldUnits === 0) { unmatched++; continue; }
    matched++;
    // Прогноз по этому заказу (модель).
    let pExpRev = 0, pExpComm = 0, pExpLog = 0, pExpAcq = 0, pExpCost = 0, pExpTax = 0;
    for (const pr of p.products) {
      const l = calcLine(pr.offerId, pr.sku, pr.qty, pr.price, pr.commissionPercent, p.clusterFrom, p.clusterTo, cards.get(pr.offerId));
      pExpRev += l.revenue; pExpComm += l.commission; pExpLog += l.logistics;
      pExpAcq += l.acquiring; pExpCost += l.cost; pExpTax += l.tax;
    }
    const pExpMargin = pExpRev - pExpComm - pExpLog - pExpAcq - pExpCost - pExpTax;
    // Факт по этому заказу.
    const aMargin = act.revenue + act.commission + act.logistics + act.acquiring - act.cost - act.revenue * TAX_RATE;
    expRev += pExpRev; actRev += act.revenue;
    expComm += pExpComm; actComm += -act.commission;
    expLog += pExpLog; actLog += -act.logistics;
    expMargin += pExpMargin; actMargin += aMargin;
  }

  const pctErr = (e: number, a: number) => (a !== 0 ? ((e - a) / Math.abs(a)) * 100 : 0);
  console.log(`\n━━━ СВЕРКА ПРОГНОЗ vs ФАКТ (по ${matched} сопоставленным заказам; не сматчено/в пути ${unmatched}) ━━━`);
  console.log(`  Выручка:   прогноз ${fmt(expRev).padStart(9)} ₽  факт ${fmt(actRev).padStart(9)} ₽  откл. ${pctErr(expRev, actRev).toFixed(1)}%`);
  console.log(`  Комиссия:  прогноз ${fmt(expComm).padStart(9)} ₽  факт ${fmt(actComm).padStart(9)} ₽  откл. ${pctErr(expComm, actComm).toFixed(1)}%`);
  console.log(`  Логистика: прогноз ${fmt(expLog).padStart(9)} ₽  факт ${fmt(actLog).padStart(9)} ₽  откл. ${pctErr(expLog, actLog).toFixed(1)}%`);
  console.log(`  Маржа д/р: прогноз ${fmt(expMargin).padStart(9)} ₽  факт ${fmt(actMargin).padStart(9)} ₽  откл. ${pctErr(expMargin, actMargin).toFixed(1)}%`);
  console.log(`\n  (реклама за период по факту: ${fmt(adsTotal)} ₽ — не привязана к заказам, в сверку маржи не входит)\n`);
}

async function main(): Promise<void> {
  logActiveShop();
  console.log(`🏪 ${activeShop.name} (client_id ${activeShop.clientId})`);

  const now = moscowNow();
  const todayStr = now.toISOString().slice(0, 10);
  let dates: string[];
  if (dateArgs.length > 0) {
    dates = [...dateArgs].sort();
  } else if (DAYS > 0) {
    dates = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      dates.push(new Date(new Date(`${todayStr}T00:00:00+03:00`).getTime() - i * 86400_000).toISOString().slice(0, 10));
    }
  } else {
    dates = [new Date(now.getTime() - 86400_000).toISOString().slice(0, 10), todayStr];
  }
  console.log(`📅 Дни заказов: ${dates.join(', ')}  ·  ДРР для оценки рекламы: ${(DRR * 100).toFixed(1)}%${DRY ? '  (DRY)' : ''}\n`);

  const from = new Date(`${dates[0]}T00:00:00+03:00`);
  const to = new Date(`${dates[dates.length - 1]}T23:59:59+03:00`);

  const [postings, prices] = await Promise.all([fetchPostingsFbo(from, to), fetchAllPrices()]);
  console.log(`✅ Загружено заказов: ${postings.length}`);

  const cards = new Map<string, CardInfo>();
  for (const p of prices as any[]) {
    const c = p.commissions ?? {};
    cards.set(p.offer_id, {
      baseDirectFlow: Number(c.fbo_direct_flow_trans_min_amount ?? 0),
      lastMile: Number(c.fbo_deliv_to_customer_amount ?? 0),
      commPct: Number(c.sales_percent_fbo ?? 46),
      returnFlow: Number(c.fbo_return_flow_amount ?? 0),
    });
  }

  const results = dates.map((d) => computeDay(d, postings, cards));
  results.forEach(printDay);

  const summary = SUMMARY ? buildSummary(postings, cards, dates) : null;
  if (summary) printSummary(summary, dates);

  if (VERIFY) await verify(results, postings, cards, dates);

  if (DRY || VERIFY) { console.log('\n(Telegram пропущен)\n'); return; }

  console.log('\n📬 Отправляем в Telegram...');
  await sendMarkdown(summary ? buildSummaryTg(summary, dates) : buildTgMessage(results));
  console.log('  ✅ Отправлено!\n');
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
