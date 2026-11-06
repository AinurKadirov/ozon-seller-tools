/**
 * Интерактивная юнитка Lumos: факт расходов на 1 шт из транзакций + живая цена.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/lumos-unit-html.ts
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/lumos-unit-html.ts 30
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/lumos-unit-html.ts --from 2026-08-01
 *
 * Пишет HTML на рабочий стол и в tools/sale/out/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCTS, type Product } from './lib/catalog';
import { TAX_RATE } from './lib/economics';
import { env } from './lib/env';
import { fetchAllOperations, fetchAllPrices, ozonPost } from './lib/ozon';
import { moscowDateStr, moscowNow } from './lib/format';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fromArg = process.argv.includes('--from')
  ? process.argv[process.argv.indexOf('--from') + 1]
  : undefined;
const DAYS = Number(args[0]) || 30;
const TAX_PCT = TAX_RATE * 100;
const OUT_DIR = join(__dirname, 'out');
const DESKTOP = '/Users/kadirovajnur/Desktop/lumos-unit.html';

/** SKU, которых нет в catalog.ts, но они есть в кабинете / Excel. */
const EXTRA_SKU: Record<number, string> = {
  3171713240: 'АБ-013',
};

const ADS_TYPES = new Set([
  'OperationMarketplaceCostPerClick',
  'OperationPromotionWithCostPerOrder',
  'StarsMembership',
  'OperationAgentCampaign',
  'CampaignPayment',
  'OperationElectronicServicesPromotionInSearch',
  'MarketplaceMarketingActionCostOperation',
  'OperationMarketplaceServicePremiumCashback',
  'OperationMarketplaceServicePremiumPromotion',
]);

const STAR_TYPES = new Set(['StarsMembership']);

const STOCK_RETURN_TYPES = new Set([
  'OperationSellerReturnsCargoAssortmentValid',
  'SellerReturnsDeliveryToPickupPoint',
]);

function daysAgo(n: number): Date {
  const msk = moscowNow();
  msk.setUTCDate(msk.getUTCDate() - n);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - 3 * 3600_000);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface Bucket {
  sku: number;
  offerId: string;
  name: string;
  group: string;
  catalogCost: number;
  catalogFixed: number;
  sold: number;
  returns: number;
  cancels: number;
  revenue: number;
  commission: number;
  logDirect: number;
  logReturn: number;
  logOther: number;
  adsDirect: number;
  starsDirect: number;
  servicesOther: number;
}

interface ShopTotals {
  ads: number;
  stars: number;
  acquiring: number;
  storage: number;
  other: number;
  stockReturn: number;
  revenue: number;
}

interface Row {
  sku: number;
  offerId: string;
  name: string;
  group: string;
  catalogCost: number;
  catalogFixed: number;
  sold: number;
  returns: number;
  cancels: number;
  buyoutPct: number | null;
  volumeL: number | null;
  cardPrice: number | null;
  minPrice: number | null;
  oldPrice: number | null;
  commPctCard: number | null;
  avgAccrual: number | null;
  commPctFact: number;
  logDirectPerSale: number;
  logReturnPerSale: number;
  logOtherPerSale: number;
  logTotalPerSale: number;
  adsDirectPerSale: number;
  adsAllocPerSale: number;
  adsTotalPerSale: number;
  starsPerSale: number;
  acqPerSale: number;
  storagePerSale: number;
  otherPerSale: number;
  drrPct: number;
  acqPct: number;
}

function emptyBucket(sku: number, p?: Product): Bucket {
  return {
    sku,
    offerId: p?.offerId ?? EXTRA_SKU[sku] ?? String(sku),
    name: p ? `${p.offerId} ${p.name}` : EXTRA_SKU[sku] ?? `SKU ${sku}`,
    group: p?.group ?? '—',
    catalogCost: p?.cost ?? 0,
    catalogFixed: p?.fixed ?? 0,
    sold: 0,
    returns: 0,
    cancels: 0,
    revenue: 0,
    commission: 0,
    logDirect: 0,
    logReturn: 0,
    logOther: 0,
    adsDirect: 0,
    starsDirect: 0,
    servicesOther: 0,
  };
}

function isLogiName(name: string): 'direct' | 'return' | 'other' | null {
  const n = name.toLowerCase();
  if (!n) return null;
  if (
    n.includes('return') ||
    n.includes('notdeliv') ||
    n.includes('afterdeliv') ||
    n.includes('partgoods')
  ) {
    return 'return';
  }
  if (
    n.includes('logistic') ||
    n.includes('deliv') ||
    n.includes('dropoff') ||
    n.includes('lastmile') ||
    n.includes('trans') ||
    n.includes('delivery')
  ) {
    return 'direct';
  }
  return null;
}

function addServices(b: Bucket, services: Array<{ name?: string; price?: number }>, kind: 'order' | 'return') {
  for (const svc of services ?? []) {
    const price = num(svc.price);
    if (!price) continue;
    const cls = isLogiName(String(svc.name ?? ''));
    if (kind === 'return' || cls === 'return') {
      b.logReturn += price;
    } else if (cls === 'direct') {
      b.logDirect += price;
    } else {
      b.servicesOther += price;
    }
  }
}

async function fetchVolumes(offerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!offerIds.length) return map;
  const d: any = await ozonPost('/v3/product/info/list', {
    offer_id: offerIds,
    product_id: [],
    sku: [],
  });
  const items: any[] = d.items ?? d.result?.items ?? [];
  for (const it of items) {
    const offerId = String(it.offer_id ?? '');
    const vol = num(it.volume_weight ?? it.volumeWeight);
    if (offerId && vol > 0) map.set(offerId, vol);
  }
  return map;
}

function perSale(amount: number, sold: number): number {
  return sold > 0 ? amount / sold : 0;
}

function buildHtml(payload: {
  generatedAt: string;
  from: string;
  to: string;
  days: number;
  shop: string;
  taxPct: number;
  totals: ShopTotals;
  unknownOps: Array<{ type: string; amount: number; count: number }>;
  rows: Row[];
}): string {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lumos — юнитка, живые средние</title>
<style>
  :root {
    --bg: #f4f2ee;
    --ink: #1c1917;
    --muted: #78716c;
    --line: #e7e5e4;
    --paper: #fff;
    --ok: #166534;
    --bad: #991b1b;
    --warn: #9a3412;
    --accent: #1d4ed8;
    --sticky: #fafaf9;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
    color: var(--ink);
    background: var(--bg);
  }
  header {
    padding: 20px 24px 12px;
    max-width: 100%;
  }
  h1 { font-size: 22px; font-weight: 650; margin: 0 0 6px; }
  .sub { color: var(--muted); max-width: 920px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
  .stat {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
    min-width: 140px;
  }
  .stat b { display: block; font-size: 16px; }
  .stat span { color: var(--muted); font-size: 11px; }
  .note {
    background: #fff7ed;
    border: 1px solid #fed7aa;
    border-radius: 8px;
    padding: 10px 12px;
    max-width: 960px;
    color: #9a3412;
  }
  .toolbar {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 0 24px 12px;
  }
  button, .btn {
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
    font: inherit;
  }
  button:hover { border-color: #a8a29e; }
  .wrap { overflow: auto; padding: 0 12px 40px; }
  table {
    border-collapse: separate;
    border-spacing: 0;
    background: var(--paper);
    min-width: 1800px;
  }
  th, td {
    border-bottom: 1px solid var(--line);
    padding: 6px 8px;
    white-space: nowrap;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  th {
    position: sticky; top: 0; z-index: 3;
    background: #fafaf9;
    font-weight: 600;
    font-size: 11px;
    color: #44403c;
    text-align: right;
  }
  th.l, td.l { text-align: left; }
  td.sticky, th.sticky {
    position: sticky; left: 0; z-index: 2;
    background: var(--sticky);
    text-align: left;
    box-shadow: 1px 0 0 var(--line);
  }
  th.sticky { z-index: 4; }
  tr:hover td { background: #fafafa; }
  tr:hover td.sticky { background: #f5f5f4; }
  tr.bad td.profit { color: var(--bad); font-weight: 650; }
  tr.ok td.profit { color: var(--ok); font-weight: 650; }
  tr.warn td.profit { color: var(--warn); font-weight: 650; }
  input[type=number] {
    width: 84px;
    font: inherit;
    font-variant-numeric: tabular-nums;
    text-align: right;
    border: 1px solid #d6d3d1;
    border-radius: 4px;
    padding: 3px 4px;
    background: #fff;
  }
  input.price { width: 92px; font-weight: 650; }
  input.cost { width: 72px; }
  input.pct { width: 58px; }
  .muted { color: var(--muted); font-size: 11px; }
  .formula {
    margin: 0 24px 24px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 14px;
    max-width: 1100px;
  }
  .formula code { font-size: 12px; }
  details.ops { margin: 0 24px 32px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Lumos — средние расходы на 1 шт</h1>
  <p class="sub">
    Магазин ${payload.shop}. Период транзакций: ${payload.from} → ${payload.to} (${payload.days} дн.).
    Сгенерировано ${payload.generatedAt} МСК.
    Цена и себестоимость можно менять — комиссия, налог, эквайринг и реклама пересчитываются от цены.
    Логистика, хранение и прочее остаются фактическими средними на проданную штуку (включая амортизацию возвратов).
  </p>
  <div class="stats" id="shop-stats"></div>
  <p class="note">
    Старый расчёт занижал штуку: логистика только с короткого whitelist на заказах,
    без возвратов, без хранения и без «звёзд». За эти 30 дней одно хранение FBO
    вынесено в шапку — плюс вывоз со склада в юнитку не входит.
    Хранение размазано по выручке, не по остаткам: лежалый товар выглядит дешевле, чем есть.
    Себестоимость — из catalog.ts, колонку можно править. Цена модели по умолчанию — текущий ценник карточки.
  </p>
</header>
<div class="toolbar">
  <button type="button" id="use-card">Подставить цену карточки</button>
  <button type="button" id="use-accrual">Подставить факт начисления</button>
  <button type="button" id="reset-cost">Сбросить себестоимость из каталога</button>
  <span class="muted" id="sumline"></span>
</div>
<div class="wrap">
  <table id="t">
    <thead></thead>
    <tbody></tbody>
  </table>
</div>
<div class="formula">
  <div><b>Как считается прибыль при вашей цене</b></div>
  <code>прибыль = цена − себестоимость − цена×комиссия% − логистика_факт − цена×эквайринг% − цена×ДРР% − звёзды − хранение − прочее − цена×7%</code>
  <p class="muted" style="margin:8px 0 0">
    Комиссия% — факт sale_commission / начисление за период (не ставка из карточки).
    Налог — УСН 7% от цены, как в планировании; в кассе база — начисление дня.
    «catalog.fixed» справа — старая зашивка (логистика+эквайринг+реклама май–июнь), не участвует в формуле.
  </p>
</div>
<details class="ops">
  <summary>Операции, которые ушли в «прочее» магазина (не привязались к типу)</summary>
  <pre id="unknown"></pre>
</details>
<script>
const DATA = ${data};

const money = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
const n1 = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const n2 = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);

function calc(row, price, cost, commPct, acqPct, drrPct) {
  const comm = price * commPct / 100;
  const acq = price * acqPct / 100;
  const ads = price * drrPct / 100;
  const tax = price * DATA.taxPct / 100;
  const logi = row.logTotalPerSale;
  const stars = row.starsPerSale;
  const storage = row.storagePerSale;
  const other = row.otherPerSale;
  const expenses = cost + comm + logi + acq + ads + stars + storage + other + tax;
  const profit = price - expenses;
  const beDenom = 1 - commPct/100 - acqPct/100 - drrPct/100 - DATA.taxPct/100;
  const be = beDenom > 0.05 ? (cost + logi + stars + storage + other) / beDenom : 0;
  const roi = cost > 0 ? profit / cost * 100 : 0;
  const coinvest = row.avgAccrual != null && price > 0 ? (price - row.avgAccrual) / price * 100 : null;
  return { comm, acq, ads, tax, logi, stars, storage, other, expenses, profit, be, roi, coinvest };
}

function rowEls() {
  return [...document.querySelectorAll('tbody tr')];
}

function readRow(tr) {
  const row = DATA.rows[Number(tr.dataset.i)];
  return {
    row,
    price: Number(tr.querySelector('.price').value) || 0,
    cost: Number(tr.querySelector('.cost').value) || 0,
    commPct: Number(tr.querySelector('.commPct').value) || 0,
    acqPct: Number(tr.querySelector('.acqPct').value) || 0,
    drrPct: Number(tr.querySelector('.drrPct').value) || 0,
  };
}

function paint(tr) {
  const { row, price, cost, commPct, acqPct, drrPct } = readRow(tr);
  const c = calc(row, price, cost, commPct, acqPct, drrPct);
  const set = (k, v, suffix) => { tr.querySelector('[data-k="'+k+'"]').textContent = v; };
  set('commR', money(-c.comm));
  set('acqR', money(-c.acq));
  set('adsR', money(-c.ads));
  set('taxR', money(-c.tax));
  set('exp', money(-c.expenses));
  set('profit', (c.profit >= 0 ? '+' : '') + money(c.profit).replace(' ₽','') + ' ₽');
  set('roi', n1(c.roi) + '%');
  set('be', money(c.be));
  set('coinvest', c.coinvest == null ? '—' : n1(c.coinvest) + '%');
  tr.classList.remove('ok', 'bad', 'warn');
  tr.classList.add(c.profit >= 150 ? 'ok' : c.profit >= 0 ? 'warn' : 'bad');
}

function renderStats() {
  const t = DATA.totals;
  const items = [
    ['Выручка периода', money(t.revenue)],
    ['Реклама всего', money(t.ads)],
    ['Эквайринг', money(t.acquiring)],
    ['Хранение FBO', money(t.storage)],
    ['Звёзды', money(t.stars)],
    ['Прочее', money(t.other)],
    ['Вывоз склада (не в шт)', money(t.stockReturn)],
  ];
  document.getElementById('shop-stats').innerHTML = items.map(([k,v]) =>
    '<div class="stat"><b>'+v+'</b><span>'+k+'</span></div>'
  ).join('');
}

function renderTable() {
  const heads = [
    ['sticky l', 'Товар'],
    ['l', 'SKU'],
    ['', 'Прод'],
    ['', 'Возвр'],
    ['', 'Выкуп'],
    ['', 'Себест. catalog'],
    ['', 'Себест. (правка)'],
    ['', 'Цена карточки'],
    ['', 'Факт начисл. J'],
    ['', 'Цена модели'],
    ['', 'Соинвест'],
    ['', 'Комиссия %'],
    ['', 'Комиссия ₽'],
    ['', 'Лог. прямая'],
    ['', 'Лог. возврат'],
    ['', 'Лог. прочая'],
    ['', 'Логистика итог'],
    ['', 'Экв. %'],
    ['', 'Эквайринг ₽'],
    ['', 'ДРР %'],
    ['', 'Реклама ₽'],
    ['', 'Звёзды'],
    ['', 'Хранение'],
    ['', 'Прочее на шт'],
    ['', 'Налог 7%'],
    ['', 'Итого расход'],
    ['', 'Прибыль/шт'],
    ['', 'ROI'],
    ['', 'Безубыток'],
    ['', 'Объём, л'],
    ['', 'Фикс факт'],
    ['', 'catalog.fixed'],
  ];
  document.querySelector('thead').innerHTML = '<tr>' + heads.map(h =>
    '<th class="'+h[0]+'">'+h[1]+'</th>'
  ).join('') + '</tr>';

  const tb = document.querySelector('tbody');
  tb.innerHTML = DATA.rows.map((r, i) => {
    const price = r.cardPrice || r.avgAccrual || 0;
    const commPct = (r.commPctFact * 100);
    const buy = r.buyoutPct == null ? '—' : n1(r.buyoutPct) + '%';
    return '<tr data-i="'+i+'">' +
      '<td class="sticky l">'+r.name+'<div class="muted">'+r.offerId+' · '+r.group+'</div></td>' +
      '<td class="l muted">'+r.sku+'</td>' +
      '<td>'+r.sold+'</td>' +
      '<td>'+r.returns+(r.cancels ? ' / '+r.cancels : '')+'</td>' +
      '<td>'+buy+'</td>' +
      '<td class="muted">'+n2(r.catalogCost)+'</td>' +
      '<td><input class="cost" type="number" step="1" value="'+Math.round(r.catalogCost)+'"></td>' +
      '<td class="muted">'+(r.cardPrice ? money(r.cardPrice) : '—')+'</td>' +
      '<td class="muted">'+(r.avgAccrual != null ? money(r.avgAccrual) : '—')+'</td>' +
      '<td><input class="price" type="number" step="1" value="'+Math.round(price)+'"></td>' +
      '<td data-k="coinvest"></td>' +
      '<td><input class="commPct pct" type="number" step="0.1" value="'+commPct.toFixed(1)+'"></td>' +
      '<td data-k="commR"></td>' +
      '<td class="muted">'+money(r.logDirectPerSale)+'</td>' +
      '<td class="muted">'+money(r.logReturnPerSale)+'</td>' +
      '<td class="muted">'+money(r.logOtherPerSale)+'</td>' +
      '<td>'+money(r.logTotalPerSale)+'</td>' +
      '<td><input class="acqPct pct" type="number" step="0.1" value="'+r.acqPct.toFixed(1)+'"></td>' +
      '<td data-k="acqR"></td>' +
      '<td><input class="drrPct pct" type="number" step="0.1" value="'+r.drrPct.toFixed(1)+'"></td>' +
      '<td data-k="adsR"></td>' +
      '<td class="muted">'+money(r.starsPerSale)+'</td>' +
      '<td class="muted">'+money(r.storagePerSale)+'</td>' +
      '<td class="muted">'+money(r.otherPerSale)+'</td>' +
      '<td data-k="taxR"></td>' +
      '<td data-k="exp"></td>' +
      '<td class="profit" data-k="profit"></td>' +
      '<td data-k="roi"></td>' +
      '<td data-k="be"></td>' +
      '<td class="muted">'+(r.volumeL != null ? n2(r.volumeL) : '—')+'</td>' +
      '<td>'+money(r.logTotalPerSale + r.starsPerSale + r.storagePerSale + r.otherPerSale)+'</td>' +
      '<td class="muted">'+money(r.catalogFixed)+'</td>' +
    '</tr>';
  }).join('');

  rowEls().forEach((tr) => {
    tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      paint(tr); sum();
    }));
    paint(tr);
  });
  sum();
}

function sum() {
  let profit = 0, sold = 0, exp = 0;
  rowEls().forEach((tr) => {
    const { row, price, cost, commPct, acqPct, drrPct } = readRow(tr);
    const c = calc(row, price, cost, commPct, acqPct, drrPct);
    profit += c.profit * row.sold;
    exp += c.expenses * row.sold;
    sold += row.sold;
  });
  document.getElementById('sumline').textContent =
    'По текущим ценам модели на фактические продажи периода: ' +
    sold + ' шт · расход ' + money(exp) + ' · прибыль ' + money(profit) +
    (sold ? ' · средняя ' + money(profit / sold) + '/шт' : '');
}

document.getElementById('use-card').onclick = () => {
  rowEls().forEach((tr) => {
    const row = DATA.rows[Number(tr.dataset.i)];
    if (row.cardPrice) tr.querySelector('.price').value = Math.round(row.cardPrice);
    paint(tr);
  });
  sum();
};
document.getElementById('use-accrual').onclick = () => {
  rowEls().forEach((tr) => {
    const row = DATA.rows[Number(tr.dataset.i)];
    if (row.avgAccrual) tr.querySelector('.price').value = Math.round(row.avgAccrual);
    paint(tr);
  });
  sum();
};
document.getElementById('reset-cost').onclick = () => {
  rowEls().forEach((tr) => {
    const row = DATA.rows[Number(tr.dataset.i)];
    tr.querySelector('.cost').value = Math.round(row.catalogCost);
    paint(tr);
  });
  sum();
};

document.getElementById('unknown').textContent = DATA.unknownOps.length
  ? DATA.unknownOps.map(o => o.type + '  ' + o.count + ' шт  ' + Math.round(o.amount) + ' ₽').join('\\n')
  : 'нет — все типы разобраны';

renderStats();
renderTable();
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const dateTo = moscowNow();
  const dateFrom = fromArg
    ? new Date(`${fromArg}T00:00:00+03:00`)
    : daysAgo(DAYS);
  const fromStr = fromArg ?? moscowDateStr(dateFrom);
  const toStr = moscowDateStr(dateTo);
  const days = Math.max(1, Math.round((dateTo.getTime() - dateFrom.getTime()) / 86400_000));

  console.log(`Lumos unit HTML: ${fromStr} → ${toStr} (${days} дн.)`);

  const [ops, prices] = await Promise.all([
    fetchAllOperations(dateFrom, dateTo),
    fetchAllPrices(),
  ]);
  console.log(`операций ${ops.length}, цен ${prices.length}`);

  const byOffer = new Map(PRODUCTS.filter((p) => p.sku).map((p) => [p.offerId, p]));
  const bySku = new Map<number, Product>();
  for (const p of PRODUCTS) {
    if (p.sku) bySku.set(p.sku, p);
  }

  const buckets = new Map<number, Bucket>();
  const bucket = (sku: number): Bucket => {
    let b = buckets.get(sku);
    if (!b) {
      b = emptyBucket(sku, bySku.get(sku));
      buckets.set(sku, b);
    }
    return b;
  };

  const totals: ShopTotals = {
    ads: 0, stars: 0, acquiring: 0, storage: 0, other: 0, stockReturn: 0, revenue: 0,
  };
  const unknown = new Map<string, { amount: number; count: number }>();

  for (const op of ops as any[]) {
    const type = String(op.type ?? '');
    const opType = String(op.operation_type ?? '');
    const sku = num(op.items?.[0]?.sku);
    const amount = num(op.amount);
    const services = op.services ?? [];

    if (type === 'orders') {
      const b = sku ? bucket(sku) : null;
      if (b) addServices(b, services, 'order');
      if (num(op.accruals_for_sale) > 0 && b) {
        b.sold++;
        b.revenue += num(op.accruals_for_sale);
        b.commission += num(op.sale_commission);
        totals.revenue += num(op.accruals_for_sale);
      }
      continue;
    }
    if (type === 'returns') {
      const b = sku ? bucket(sku) : null;
      if (b) addServices(b, services, 'return');
      if (num(op.accruals_for_sale) !== 0 && b) {
        b.returns++;
        b.revenue += num(op.accruals_for_sale);
        b.commission += num(op.sale_commission);
        totals.revenue += num(op.accruals_for_sale);
      } else if (b) {
        b.cancels++;
        b.logReturn += amount;
      }
      continue;
    }

    if (opType === 'MarketplaceRedistributionOfAcquiringOperation') {
      totals.acquiring += amount;
      continue;
    }
    if (STAR_TYPES.has(opType)) {
      totals.stars += amount;
      if (sku) bucket(sku).starsDirect += amount;
      continue;
    }
    if (ADS_TYPES.has(opType)) {
      totals.ads += amount;
      if (sku) bucket(sku).adsDirect += amount;
      continue;
    }
    if (STOCK_RETURN_TYPES.has(opType)) {
      totals.stockReturn += amount;
      continue;
    }
    if (/storage|Storage|Placement|placement/i.test(opType)) {
      totals.storage += amount;
      continue;
    }
    totals.other += amount;
    const u = unknown.get(opType) ?? { amount: 0, count: 0 };
    u.amount += amount;
    u.count++;
    unknown.set(opType, u);
  }

  const offerIds = [...new Set([
    ...PRODUCTS.map((p) => p.offerId),
    ...[...buckets.values()].map((b) => b.offerId),
  ])];
  const volumes = await fetchVolumes(offerIds);
  const priceByOffer = new Map(prices.map((p) => [p.offer_id, p]));

  const unallocatedAds = totals.ads - [...buckets.values()].reduce((s, b) => s + b.adsDirect, 0);
  const unallocatedStars = totals.stars - [...buckets.values()].reduce((s, b) => s + b.starsDirect, 0);
  const soldRevenue = Math.max(0, [...buckets.values()].reduce((s, b) => s + Math.max(0, b.revenue), 0));
  // For allocation use positive sales revenue only
  let positiveRev = 0;
  for (const b of buckets.values()) {
    if (b.sold > 0) positiveRev += Math.max(0, b.revenue);
  }

  const catalogRows: Row[] = [];
  const seen = new Set<number>();

  const toRow = (b: Bucket): Row => {
    const sold = b.sold;
    const denom = sold + b.returns;
    const share = positiveRev > 0 && sold > 0 ? Math.max(0, b.revenue) / positiveRev : 0;
    const adsAlloc = unallocatedAds * share;
    const starsAlloc = unallocatedStars * share;
    const acq = totals.acquiring * share;
    const storage = totals.storage * share;
    const other = totals.other * share + b.servicesOther;
    const logDirect = perSale(b.logDirect, sold);
    const logReturn = perSale(b.logReturn, sold);
    const logOther = perSale(b.servicesOther, sold);
    const adsDirect = perSale(b.adsDirect, sold);
    const adsAllocPer = perSale(adsAlloc, sold);
    const avgAccrual = sold > 0 ? Math.max(0, b.revenue) / sold : null;
    const commPctFact = b.revenue > 0 ? Math.abs(b.commission / b.revenue) : 0.47;
    const adsTotal = adsDirect + adsAllocPer;
    const acqPer = perSale(acq, sold);
    const drrPct = avgAccrual && avgAccrual > 0 ? (Math.abs(adsTotal) / avgAccrual) * 100 : 0;
    const acqPct = avgAccrual && avgAccrual > 0 ? (Math.abs(acqPer) / avgAccrual) * 100 : 1;
    const p = priceByOffer.get(b.offerId);
    return {
      sku: b.sku,
      offerId: b.offerId,
      name: b.name,
      group: b.group,
      catalogCost: b.catalogCost,
      catalogFixed: b.catalogFixed,
      sold: b.sold,
      returns: b.returns,
      cancels: b.cancels,
      buyoutPct: denom > 0 ? (sold / denom) * 100 : null,
      volumeL: volumes.get(b.offerId) ?? null,
      cardPrice: p ? num(p.price?.price) || null : null,
      minPrice: p ? num(p.price?.min_price) || null : null,
      oldPrice: p ? num(p.price?.old_price) || null : null,
      commPctCard: p?.commissions?.sales_percent_fbo ?? null,
      avgAccrual,
      commPctFact,
      logDirectPerSale: Math.abs(logDirect),
      logReturnPerSale: Math.abs(logReturn),
      logOtherPerSale: Math.abs(logOther),
      logTotalPerSale: Math.abs(logDirect) + Math.abs(logReturn) + Math.abs(logOther),
      adsDirectPerSale: Math.abs(adsDirect),
      adsAllocPerSale: Math.abs(adsAllocPer),
      adsTotalPerSale: Math.abs(adsTotal),
      starsPerSale: Math.abs(perSale(b.starsDirect + starsAlloc, sold)),
      acqPerSale: Math.abs(acqPer),
      storagePerSale: Math.abs(perSale(storage, sold)),
      otherPerSale: Math.abs(perSale(totals.other * share, sold)),
      drrPct: Math.max(0, drrPct),
      acqPct: Math.max(0, acqPct),
    };
  };

  // Catalog products first, even without sales (group-average fallback later)
  const groupAvg = new Map<string, { log: number; comm: number; n: number }>();

  for (const p of PRODUCTS) {
    const sku = p.sku ?? (p.offerId === 'АБ-013' ? 3171713240 : 0);
    if (!sku) continue;
    const b = buckets.get(sku) ?? emptyBucket(sku, p);
    b.offerId = p.offerId;
    b.name = `${p.offerId} ${p.name}`;
    b.group = p.group;
    b.catalogCost = p.cost;
    b.catalogFixed = p.fixed;
    buckets.set(sku, b);
    seen.add(sku);
  }

  const withSales = [...buckets.values()].filter((b) => b.sold > 0);
  for (const b of withSales) {
    const r = toRow(b);
    const g = groupAvg.get(b.group) ?? { log: 0, comm: 0, n: 0 };
    g.log += r.logTotalPerSale;
    g.comm += r.commPctFact;
    g.n++;
    groupAvg.set(b.group, g);
  }

  const order = ['Р', 'АБ', 'АР', 'АР-300', '—'];
  const allBuckets = [...buckets.values()].sort((a, b) => {
    const ga = order.indexOf(a.group) - order.indexOf(b.group);
    if (ga !== 0) return ga;
    return a.offerId.localeCompare(b.offerId, 'ru');
  });

  for (const b of allBuckets) {
    if (b.sold > 0) {
      catalogRows.push(toRow(b));
      continue;
    }
    const g = groupAvg.get(b.group) ?? groupAvg.get('АБ');
    const avgLog = g && g.n ? g.log / g.n : 120;
    const avgComm = g && g.n ? g.comm / g.n : 0.47;
    const p = priceByOffer.get(b.offerId);
    catalogRows.push({
      sku: b.sku,
      offerId: b.offerId,
      name: b.name,
      group: b.group,
      catalogCost: b.catalogCost,
      catalogFixed: b.catalogFixed,
      sold: 0,
      returns: b.returns,
      cancels: b.cancels,
      buyoutPct: null,
      volumeL: volumes.get(b.offerId) ?? null,
      cardPrice: p ? num(p.price?.price) || null : null,
      minPrice: p ? num(p.price?.min_price) || null : null,
      oldPrice: p ? num(p.price?.old_price) || null : null,
      commPctCard: p?.commissions?.sales_percent_fbo ?? null,
      avgAccrual: null,
      commPctFact: avgComm,
      logDirectPerSale: avgLog,
      logReturnPerSale: 0,
      logOtherPerSale: 0,
      logTotalPerSale: avgLog,
      adsDirectPerSale: 0,
      adsAllocPerSale: 0,
      adsTotalPerSale: 0,
      starsPerSale: 0,
      acqPerSale: 0,
      storagePerSale: 0,
      otherPerSale: 0,
      drrPct: 0,
      acqPct: 1,
    });
  }

  const html = buildHtml({
    generatedAt: `${toStr} ${moscowNow().toISOString().slice(11, 16)}`,
    from: fromStr,
    to: toStr,
    days,
    shop: 'Main shop',
    taxPct: TAX_PCT,
    totals,
    unknownOps: [...unknown.entries()]
      .map(([type, v]) => ({ type, amount: v.amount, count: v.count }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    rows: catalogRows,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const repoOut = join(OUT_DIR, 'lumos-unit.html');
  writeFileSync(repoOut, html);
  writeFileSync(DESKTOP, html);
  console.log(`записано:\n  ${repoOut}\n  ${DESKTOP}`);
  console.log(`строк ${catalogRows.length}, unknown op types ${unknown.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
