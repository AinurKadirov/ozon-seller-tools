/**
 * supply-plan.ts — план поставки FBO по кластерам Ozon.
 *
 * Что делает:
 *   1. Читает остатки склада в Москве из выгрузки XLSX (export_all_items*.xlsx).
 *   2. Тянет из Ozon API: список кластеров, остатки FBO по складам,
 *      скорость продаж (ordered_units) по каждому SKU за окно.
 *   3. Считает, сколько единиц каждого товара нужно довезти, чтобы хватило
 *      на COVER дней, и распределяет это по кластерам пропорционально их доле
 *      в текущих остатках FBO.
 *   4. Печатает план в консоль и генерирует по одному XLSX-файлу на кластер
 *      в формате шаблона импорта Ozon (артикул | имя | количество) —
 *      их можно сразу загружать в личном кабинете при создании поставки.
 *
 * Методология (важно):
 *   Ozon больше не отдаёт продажи в разрезе регионов через API, поэтому
 *   спрос по кластерам оценивается ПРОКСИ — по доле кластера в текущих
 *   остатках FBO (там, где товар уже разложен, он и продаётся). Скорость
 *   продаж берётся суммарно по SKU из analytics/data. Это оценка, а не
 *   точные региональные продажи — проверяйте здравым смыслом.
 *
 * Запуск:
 *   npm run ozon:supply-plan -- "~/Desktop/export_all_items (4).xlsx"
 *   npm run ozon:supply-plan -- <stock.xlsx> --cover 45 --days 30 --hubs 8
 *   npm run ozon:supply-plan -- <stock.xlsx> --out ~/Desktop/ozon-supply
 *   npm run ozon:supply-plan -- <stock.xlsx> --no-files   — только план в консоль
 *
 * Флаги:
 *   --cover N    целевой запас в днях (по умолчанию 45)
 *   --days N     окно для оценки скорости продаж, дней (по умолчанию 30)
 *   --hubs N     в сколько верхних кластеров везём (по умолчанию 8)
 *   --out DIR    куда класть XLSX (по умолчанию <папка stock.xlsx>/ozon-supply)
 *   --no-files   не создавать XLSX, только показать план
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import * as XLSX from 'xlsx';

import { OFFER_BY_SKU, SHORT_NAME_BY_OFFER, OFFER_IDS } from './lib/catalog';
import {
  fetchClusters,
  fetchStockOnWarehouses,
  fetchOrderedUnitsBySku,
  fetchPostingsFbo,
  ozonPost,
  setOzonCredsOverride,
} from './lib/ozon';
import { moscowNow, pad } from './lib/format';

/** Excel артикул ФФ → Ozon offer_id (MilAi). */
const MILAI_EXCEL_TO_OZON: Record<string, string> = {
  СЧ: 'СЧ',
  СШ: 'СШ',
  СС: 'СС',
  РП: 'РП',
  'Шоппер на молнии': 'Шоппер на молнии',
  СБ: 'Спортивная сумка',
  СР: 'Сумка кросс-боди подростковая',
  СД: 'сумка кросс-боди для девочек',
  СН: 'Бананка обычная',
  'СН полоска': 'Бананка с полоской',
  СШЧ: 'Сумка шоппер',
};

/** Основные хабы, куда обычно везём FBO. */
const MAIN_HUBS = [
  'Москва, МО и Дальние регионы',
  'Санкт-Петербург и СЗО',
  'Казань',
  'Ярославль',
] as const;

// ─── Аргументы ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const NO_FILES = argv.includes('--no-files');

function flag(name: string, def: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || !argv[i + 1]) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
function strFlag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

const COVER = flag('cover', 45);
const DAYS = flag('days', 30);
const HUBS = flag('hubs', 8);
/** Если скорость продаж 0 — берём этот пол (шт/день). 0 = не везём нулевые. */
const MIN_VEL = flag('min-vel', 0);
const SHOP = (strFlag('shop') ?? 'lumos').toLowerCase();
const IS_MILAI = SHOP === 'milai' || SHOP === '2';

const stockPath = expandHome(argv.find((a) => !a.startsWith('--')) ?? '');
if (!stockPath || !existsSync(stockPath)) {
  console.error('❌ Укажи путь к выгрузке остатков склада (.xlsx / .txt / TSV).');
  console.error('   Пример: npm run ozon:supply-plan -- "~/Desktop/export_all_items (4).xlsx"');
  process.exit(1);
}
const OUT_DIR = expandHome(
  strFlag('out') ??
    (IS_MILAI
      ? join(homedir(), 'Desktop', 'ozon-supply-milai')
      : join(dirname(stockPath), 'ozon-supply')),
);

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// ─── Чтение остатков склада в Москве ──────────────────────────────────────────
function parseStockLines(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^артикул/i.test(line)) continue;
    const parts = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
    if (parts.length < 2) continue;
    const qtyRaw = String(parts[parts.length - 1] ?? '').replace(/\s/g, '').replace(',', '.');
    const qty = Number(qtyRaw) || 0;
    const offer = String(parts.length >= 3 ? parts[parts.length - 2] : parts[0] ?? '').trim();
    if (!offer || !Number.isFinite(Number(qtyRaw))) continue;
    map.set(offer, (map.get(offer) ?? 0) + qty);
  }
  return map;
}

/** Возвращает Map<offerId, свободный остаток на складе в Москве / ФФ>. */
function readMoscowStock(path: string): Map<string, number> {
  if (!/\.xlsx$/i.test(path)) {
    const map = parseStockLines(readFileSync(path, 'utf8'));
    if (!map.size) throw new Error('Не нашёл артикулы и остатки в текстовом файле склада.');
    return map;
  }

  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  const header = (rows[0] ?? []).map((h) => String(h ?? '').trim());
  const offerCol = header.findIndex((h) => /артикул/i.test(h));
  const freeCol = header.findIndex((h) => /остаток свободный/i.test(h));
  const stockCol = header.findIndex((h) => /^остаток$/i.test(h));
  const qtyCol = freeCol !== -1 ? freeCol : stockCol;
  if (offerCol === -1 || qtyCol === -1) {
    // выгрузка без шапки: колонка A = артикул, B = кол-во
    const fallback = parseStockLines(
      rows.map((r) => `${r[0] ?? ''}\t${r[1] ?? ''}`).join('\n'),
    );
    if (fallback.size) return fallback;
    throw new Error('Не нашёл колонки «Артикул» и «Остаток» в выгрузке склада.');
  }

  const map = new Map<string, number>();
  for (const r of rows.slice(1)) {
    const offer = String(r[offerCol] ?? '').trim();
    if (!offer) continue;
    map.set(offer, (map.get(offer) ?? 0) + (Number(r[qtyCol]) || 0));
  }
  return map;
}

function milaiCreds(): { clientId: string; apiKey: string } {
  const clientId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const apiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (!clientId || !apiKey) throw new Error('Нет OZON_SELLER_CLIENT_ID_MILAI / OZON_SELLER_API_KEY_MILAI');
  return { clientId, apiKey };
}

function mapMilaiStock(raw: Map<string, number>, offerIds: string[]): { mapped: Map<string, number>; notes: string[] } {
  const mapped = new Map<string, number>();
  const notes: string[] = [];
  const byLower = new Map(offerIds.map((id) => [id.toLowerCase(), id]));
  for (const [excel, qty] of raw) {
    const wanted = MILAI_EXCEL_TO_OZON[excel] ?? excel;
    const ozon = offerIds.includes(wanted) ? wanted : byLower.get(wanted.toLowerCase());
    if (!ozon) {
      notes.push(`ФФ «${excel}» (${qty} шт): нет в карте / каталоге MilAi`);
      continue;
    }
    mapped.set(ozon, (mapped.get(ozon) ?? 0) + qty);
  }
  return { mapped, notes };
}

async function loadMilaiCatalog(): Promise<{
  offerIds: string[];
  offerBySku: Record<number, string>;
  shortName: Record<string, string>;
}> {
  const prices: any = await ozonPost('/v5/product/info/prices', {
    filter: { visibility: 'ALL' },
    limit: 100,
    last_id: '',
  });
  const offerIds = (prices.items ?? []).map((i: any) => String(i.offer_id));
  const info: any = await ozonPost('/v3/product/info/list', {
    offer_id: offerIds,
    product_id: [],
    sku: [],
  });
  const offerBySku: Record<number, string> = {};
  const shortName: Record<string, string> = {};
  const ids: string[] = [];
  for (const it of info.items ?? info.result?.items ?? []) {
    const offer = String(it.offer_id);
    const sku = Number(
      it.sku ?? it.sources?.find((s: any) => s.sku)?.sku ?? 0,
    );
    if (sku) offerBySku[sku] = offer;
    shortName[offer] = String(it.name ?? offer).slice(0, 60);
    ids.push(offer);
  }
  return { offerIds: ids.length ? ids : offerIds, offerBySku, shortName };
}

function resolveHubName(clusterTo: string): string | null {
  if (!clusterTo) return null;
  for (const hub of MAIN_HUBS) {
    if (clusterTo === hub) return hub;
  }
  if (/москва/i.test(clusterTo)) return MAIN_HUBS[0];
  if (/петербург|сзо/i.test(clusterTo)) return MAIN_HUBS[1];
  if (/казань/i.test(clusterTo)) return MAIN_HUBS[2];
  if (/ярославль/i.test(clusterTo)) return MAIN_HUBS[3];
  return null;
}

// ─── Распределение целого числа по долям (метод наибольшего остатка) ──────────
function allocateByShares(total: number, shares: number[]): number[] {
  const sum = shares.reduce((s, x) => s + x, 0) || 1;
  const raw = shares.map((s) => (total * s) / sum);
  const floors = raw.map((x) => Math.floor(x));
  let rest = total - floors.reduce((s, x) => s + x, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) floors[order[k].i] += 1;
  return floors;
}

interface ClusterPlan {
  cluster: string;
  rows: { offerId: string; qty: number }[];
  total: number;
}

async function main(): Promise<void> {
  const now = moscowNow();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - DAYS * 86_400_000).toISOString().slice(0, 10);

  console.log(`🕐 Москва: ${now.toISOString().slice(0, 16).replace('T', ' ')}`);
  console.log(`🏪 Магазин: ${IS_MILAI ? 'MilAi' : 'Lumos'}`);
  console.log(`📦 План поставки FBO · запас ${COVER} дн · окно продаж ${DAYS} дн (${from}…${to})`);
  if (MIN_VEL > 0) console.log(`📉 Пол скорости: ${MIN_VEL} шт/день, если продаж 0`);
  console.log(`📄 Остатки ФФ: ${stockPath}\n`);

  let offerIds = OFFER_IDS;
  let offerBySku: Record<number, string> = { ...OFFER_BY_SKU };
  let shortName: Record<string, string> = { ...SHORT_NAME_BY_OFFER };

  const moscowRaw = readMoscowStock(stockPath);
  let moscow = moscowRaw;
  if (IS_MILAI) {
    setOzonCredsOverride(milaiCreds());
    const cat = await loadMilaiCatalog();
    offerIds = cat.offerIds;
    offerBySku = cat.offerBySku;
    shortName = { ...shortName, ...cat.shortName };
    console.log(`  карточек MilAi: ${offerIds.length}`);
    const mapped = mapMilaiStock(moscowRaw, offerIds);
    moscow = mapped.mapped;
    for (const n of mapped.notes) console.log(`  ⚠️ ${n}`);
  }

  const mskTotal = [...moscow.values()].reduce((s, n) => s + n, 0);
  console.log(`ФФ/МСК позиций: ${moscow.size}, свободно: ${mskTotal} шт`);
  console.log('🌐 Тянем данные из Ozon (кластеры, остатки FBO, продажи, отправления)...');
  const fromDate = new Date(now.getTime() - DAYS * 86_400_000);
  const toDate = now;
  try {
  const [clusters, stockRows, orderedBySku, postings] = await Promise.all([
    fetchClusters(),
    fetchStockOnWarehouses(),
    fetchOrderedUnitsBySku(from, to),
    fetchPostingsFbo(fromDate, toDate),
  ]);

  // Карта склад → кластер.
  const warehouseToCluster = new Map<string, string>();
  for (const c of clusters) for (const w of c.warehouseNames) warehouseToCluster.set(w, c.name);

  // Остатки FBO: по offer суммарно и по (offer × кластер).
  const catalog = new Set(offerIds);
  const fboByOffer = new Map<string, number>();
  const clusterStock = new Map<string, number>(); // суммарный остаток кластера (все товары)
  for (const r of stockRows) {
    if (r.sku && r.offerId) offerBySku[r.sku] = r.offerId;
  }
  for (const r of stockRows) {
    const offer = catalog.has(r.offerId) ? r.offerId : offerBySku[r.sku];
    if (!offer || !catalog.has(offer)) continue;
    fboByOffer.set(offer, (fboByOffer.get(offer) ?? 0) + r.free);
    const cl = warehouseToCluster.get(r.warehouseName) ?? resolveHubName(r.warehouseName);
    if (cl) clusterStock.set(cl, (clusterStock.get(cl) ?? 0) + r.free);
  }

  // Продажи по основным хабам из cluster_to (без cancelled).
  const hubSales = new Map<string, number>(MAIN_HUBS.map((h) => [h, 0]));
  const byOfferHub = new Map<string, Map<string, number>>();
  for (const p of postings) {
    if (p.status === 'cancelled') continue;
    const hub = resolveHubName(p.clusterTo);
    if (!hub) continue;
    for (const pr of p.products) {
      if (pr.sku && pr.offerId) offerBySku[pr.sku] = pr.offerId;
      if (!catalog.has(pr.offerId)) continue;
      hubSales.set(hub, (hubSales.get(hub) ?? 0) + pr.qty);
      if (!byOfferHub.has(pr.offerId)) byOfferHub.set(pr.offerId, new Map(MAIN_HUBS.map((h) => [h, 0])));
      const m = byOfferHub.get(pr.offerId)!;
      m.set(hub, (m.get(hub) ?? 0) + pr.qty);
    }
  }

  // Скорость продаж по offer (шт/день) — после того как собрали sku→offer.
  const velByOffer = new Map<string, number>();
  for (const [sku, units] of orderedBySku) {
    const offer = offerBySku[sku];
    if (!offer) continue;
    velByOffer.set(offer, (velByOffer.get(offer) ?? 0) + units / DAYS);
  }
  console.log(`  sku→offer: ${Object.keys(offerBySku).length}, с продажами: ${velByOffer.size}`);
  console.log(
    '  продажи по хабам:',
    MAIN_HUBS.map((h) => `${h.split(',')[0]}:${hubSales.get(h) ?? 0}`).join(', '),
  );

  // Сколько везти: только то, что есть на ФФ. vel=0 → пол min-vel (если задан).
  interface Need { offerId: string; ship: number; vel: number; rawVel: number; fbo: number; msk: number }
  const needs: Need[] = [];
  for (const offerId of offerIds) {
    const rawVel = velByOffer.get(offerId) ?? 0;
    const vel = rawVel > 0 ? rawVel : MIN_VEL;
    const fbo = fboByOffer.get(offerId) ?? 0;
    const msk = moscow.get(offerId) ?? 0;
    if (msk <= 0) continue; // везём только то, что есть на складе ФФ
    if (vel <= 0) continue;
    const target = Math.ceil(vel * COVER);
    const ship = Math.min(Math.max(0, target - fbo), msk);
    if (ship > 0) needs.push({ offerId, ship, vel, rawVel, fbo, msk });
  }
  needs.sort((a, b) => b.ship - a.ship);

  if (!needs.length) {
    console.log('\n✅ Довозить нечего: запасов FBO хватает либо склад в Москве пуст.');
    return;
  }

  // Основные хабы — фиксированный список (не ранжируем по редким продажам за окно).
  const hubNames = MAIN_HUBS.slice(0, HUBS);
  const rawShares = hubNames.map((n) => hubSales.get(n) ?? 0);
  const shareSum = rawShares.reduce((a, b) => a + b, 0);
  // Если хаб без продаж — минимальная доля 15%, чтобы в каждый кластер ехал товар.
  const MIN_HUB_SHARE = 0.15;
  const globalShares = (() => {
    const base = shareSum > 0 ? rawShares : hubNames.map((n) => clusterStock.get(n) || 1);
    const total = base.reduce((a, b) => a + b, 0) || 1;
    const props = base.map((s) => s / total);
    const floored = props.map((p) => Math.max(p, MIN_HUB_SHARE));
    const fsum = floored.reduce((a, b) => a + b, 0);
    return floored.map((p) => p / fsum);
  })();
  console.log(`  кластеры отгрузки: ${hubNames.join(' | ')}`);
  console.log(
    '  доли:',
    hubNames.map((n, i) => `${n.split(',')[0]} ${Math.round(globalShares[i] * 100)}%`).join(', '),
  );

  // Для каждого товара распределяем ship по хабам (доля SKU, иначе глобальная).
  const planByCluster = new Map<string, { offerId: string; qty: number }[]>();
  hubNames.forEach((n) => planByCluster.set(n, []));
  for (const need of needs) {
    const perSku = byOfferHub.get(need.offerId);
    let shares = hubNames.map((h) => perSku?.get(h) ?? 0);
    if (shares.every((s) => s === 0)) {
      shares = globalShares;
    } else {
      const total = shares.reduce((a, b) => a + b, 0) || 1;
      const props = shares.map((s) => s / total);
      const floored = props.map((p) => Math.max(p, MIN_HUB_SHARE));
      const fsum = floored.reduce((a, b) => a + b, 0);
      shares = floored.map((p) => p / fsum);
    }
    const alloc = allocateByShares(need.ship, shares);
    alloc.forEach((qty, i) => {
      if (qty > 0) planByCluster.get(hubNames[i])!.push({ offerId: need.offerId, qty });
    });
  }

  const plans: ClusterPlan[] = hubNames
    .map((cluster) => {
      const rows = (planByCluster.get(cluster) ?? []).sort((a, b) => b.qty - a.qty);
      return { cluster, rows, total: rows.reduce((s, r) => s + r.qty, 0) };
    })
    .filter((p) => p.total > 0);

  printPlan(plans, needs);

  if (NO_FILES) {
    console.log('\n(--no-files: XLSX не создаём)\n');
    return;
  }
  writeFiles(plans, shortName);
  } finally {
    setOzonCredsOverride(null);
  }
}

function printPlan(plans: ClusterPlan[], needs: { offerId: string; ship: number; vel: number; rawVel: number; fbo: number; msk: number }[]): void {
  const w = 36;
  console.log('\n📊 Что и сколько везти (всего по товарам):');
  console.log(`   ${pad('Артикул', w)}${pad('везём', 7, true)}${pad('FBO', 7, true)}${pad('ФФ', 6, true)}${pad('шт/день', 10, true)}${pad('факт', 8, true)}`);
  let grand = 0;
  for (const n of needs) {
    grand += n.ship;
    const floorMark = n.rawVel <= 0 ? 'мин' : n.rawVel.toFixed(2);
    console.log(
      `   ${pad(n.offerId, w)}${pad(String(n.ship), 7, true)}${pad(String(n.fbo), 7, true)}${pad(String(n.msk), 6, true)}${pad(n.vel.toFixed(2), 10, true)}${pad(floorMark, 8, true)}`,
    );
  }
  console.log(`   ${'─'.repeat(w + 38)}\n   ${pad('ИТОГО', w)}${pad(String(grand), 7, true)}`);

  console.log('\n🗺  Распределение по кластерам:');
  for (const p of plans) {
    const parts = p.rows.map((r) => `${r.offerId}×${r.qty}`).join(', ');
    console.log(`   ${pad(p.cluster, 18)} ${pad(String(p.total) + ' шт', 8, true)}  ${parts}`);
  }
}

function writeFiles(plans: ClusterPlan[], names: Record<string, string>): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  else for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.xlsx')) unlinkSync(join(OUT_DIR, f));

  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-');
  console.log(`\n💾 Пишем XLSX в ${OUT_DIR}`);
  plans.forEach((p, idx) => {
    const aoa: (string | number)[][] = [['артикул', 'имя (необязательно)', 'количество']];
    for (const r of p.rows) aoa.push([r.offerId, names[r.offerId] ?? '', r.qty]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = `${String(idx + 1).padStart(2, '0')}_${safe(p.cluster)}_${p.total}шт.xlsx`;
    XLSX.writeFile(wb, join(OUT_DIR, file));
    console.log(`   ✅ ${file}`);
  });
  console.log('\n🎉 Готово! Загружай файлы в Ozon при создании поставки.\n');
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
