/**
 * supply-plan-dual.ts — план FBO на 30 дней для Lumos + Milai.
 *
 *   1. Читает остатки МСК-склада из export_all_items*.xlsx
 *   2. Тянет FBO-остатки, заказы и postings (cluster_to) по обоим магазинам
 *   3. Считает ship = min(ceil(vel×30) − fbo, msk) и раскладывает по 4 хабам
 *      (Москва, СПб, Казань, Ярославль) пропорционально продажам cluster_to
 *   4. Пишет сводный Excel + файлы импорта Ozon по кластерам
 *
 * Запуск:
 *   npm run ozon:supply-plan-dual -- "~/Desktop/export_all_items (7).xlsx"
 *   npm run ozon:supply-plan-dual -- <stock.xlsx> --out ~/Desktop/ozon-supply-dual
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';

import { PRODUCTS, SHORT_NAME_BY_OFFER } from './lib/catalog';
import { env } from './lib/env';
import { MILAI_BY_SKU } from './milai/catalog';
import { moscowDateStr, moscowNow, pad } from './lib/format';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const COVER = 30;
const DAYS = 30;
const HUBS = [
  'Москва, МО и Дальние регионы',
  'Санкт-Петербург и СЗО',
  'Казань',
  'Ярославль',
] as const;

/** Excel артикул МСК-склада → Ozon offer_id (Milai). */
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

/** Lumos: альтернативные артикулы в выгрузке склада. */
const LUMOS_EXCEL_ALIASES: Record<string, string> = {
  'Рамка золотая': 'РЗ',
};

const argv = process.argv.slice(2);
function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}
function strFlag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

const stockPath = expandHome(argv.find((a) => !a.startsWith('--') && /\.xlsx$/i.test(a)) ?? '');
if (!stockPath || !existsSync(stockPath)) {
  console.error('❌ Укажи путь к выгрузке остатков склада (.xlsx).');
  console.error('   Пример: npm run ozon:supply-plan-dual -- "~/Desktop/export_all_items (7).xlsx"');
  process.exit(1);
}
const OUT_DIR = expandHome(strFlag('out') ?? join(dirname(stockPath), 'ozon-supply-dual'));

type ShopId = 'Lumos' | 'Milai';

interface MoscowRow {
  excelOffer: string;
  name: string;
  free: number;
}

interface ShopProduct {
  shop: ShopId;
  excelOffer: string;
  ozonOffer: string;
  sku: number;
  name: string;
  msk: number;
}

interface SkuPlan {
  shop: ShopId;
  excelOffer: string;
  ozonOffer: string;
  sku: number;
  name: string;
  msk: number;
  fbo: number;
  ordered30: number;
  vel: number;
  daysFbo: number | null;
  target: number;
  ship: number;
  alloc: Record<string, number>;
}

interface Creds {
  clientId: string;
  apiKey: string;
  label: ShopId;
}

function lumosCreds(): Creds {
  return { clientId: env.ozonClientId, apiKey: env.ozonApiKey, label: 'Lumos' };
}

function milaiCreds(): Creds {
  const clientId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const apiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (!clientId || !apiKey) throw new Error('Нет кредов Milai (OZON_SELLER_*_MILAI)');
  return { clientId, apiKey, label: 'Milai' };
}

async function shopPost(creds: Creds, path: string, body: unknown, attempt = 1): Promise<any> {
  const res = await nodeFetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Id': creds.clientId,
      'Api-Key': creds.apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 429 && attempt < 6) {
    const wait = attempt * 1500;
    await new Promise((r) => setTimeout(r, wait));
    return shopPost(creds, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${creds.label} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  await new Promise((r) => setTimeout(r, 550)); // ~1.8 rps under seller-api limit
  return JSON.parse(text);
}

function readMoscowStock(path: string): MoscowRow[] {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  const header = (rows[0] ?? []).map((h) => String(h ?? '').trim());
  const nameCol = header.findIndex((h) => /название/i.test(h));
  const offerCol = header.findIndex((h) => /артикул/i.test(h));
  const freeCol = header.findIndex((h) => /остаток свободный/i.test(h));
  const stockCol = header.findIndex((h) => /^остаток$/i.test(h));
  const qtyCol = freeCol !== -1 ? freeCol : stockCol;
  if (offerCol === -1 || qtyCol === -1) {
    throw new Error('Не нашёл колонки «Артикул» и «Остаток» в выгрузке склада.');
  }

  const out: MoscowRow[] = [];
  for (const r of rows.slice(1)) {
    const excelOffer = String(r[offerCol] ?? '').trim();
    if (!excelOffer) continue;
    out.push({
      excelOffer,
      name: nameCol >= 0 ? String(r[nameCol] ?? '').trim() : '',
      free: Number(r[qtyCol]) || 0,
    });
  }
  return out;
}

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

function resolveHubName(clusterTo: string): string | null {
  if (!clusterTo) return null;
  for (const hub of HUBS) {
    if (clusterTo === hub) return hub;
  }
  // partial match for safety
  if (/москва/i.test(clusterTo)) return HUBS[0];
  if (/петербург|сзо/i.test(clusterTo)) return HUBS[1];
  if (/казань/i.test(clusterTo)) return HUBS[2];
  if (/ярославль/i.test(clusterTo)) return HUBS[3];
  return null;
}

async function fetchClustersMap(creds: Creds): Promise<Map<string, string>> {
  const d = await shopPost(creds, '/v1/cluster/list', { cluster_type: 'CLUSTER_TYPE_OZON' });
  const map = new Map<string, string>();
  for (const c of d.clusters ?? []) {
    const name = c.name ?? String(c.id);
    for (const lc of c.logistic_clusters ?? []) {
      for (const w of lc.warehouses ?? []) map.set(w.name, name);
    }
  }
  return map;
}

async function fetchFboBySku(creds: Creds, wh2cl: Map<string, string>): Promise<{
  bySku: Map<number, number>;
  byCluster: Map<string, number>;
}> {
  const d = await shopPost(creds, '/v2/analytics/stock_on_warehouses', {
    limit: 1000,
    offset: 0,
    warehouse_type: 'ALL',
  });
  const bySku = new Map<number, number>();
  const byCluster = new Map<string, number>();
  for (const r of d.result?.rows ?? []) {
    const sku = Number(r.sku);
    const free = Number(r.free_to_sell_amount ?? 0);
    if (sku) bySku.set(sku, (bySku.get(sku) ?? 0) + free);
    const cl = wh2cl.get(r.warehouse_name) ?? r.warehouse_name;
    byCluster.set(cl, (byCluster.get(cl) ?? 0) + free);
  }
  return { bySku, byCluster };
}

async function fetchOrderedBySku(creds: Creds, from: string, to: string): Promise<Map<number, number>> {
  const d = await shopPost(creds, '/v1/analytics/data', {
    date_from: from,
    date_to: to,
    metrics: ['ordered_units'],
    dimension: ['sku'],
    limit: 1000,
    offset: 0,
  });
  const map = new Map<number, number>();
  for (const row of d.result?.data ?? []) {
    map.set(Number(row.dimensions[0].id), Number(row.metrics[0] ?? 0));
  }
  return map;
}

async function fetchSalesByHub(
  creds: Creds,
  from: Date,
  to: Date,
  skuSet: Set<number>,
): Promise<{ hubShares: Map<string, number>; bySkuHub: Map<number, Map<string, number>> }> {
  const hubShares = new Map<string, number>(HUBS.map((h) => [h, 0]));
  const bySkuHub = new Map<number, Map<string, number>>();
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const d = await shopPost(creds, '/v2/posting/fbo/list', {
      dir: 'ASC',
      filter: { since: from.toISOString(), to: to.toISOString() },
      limit,
      offset,
      with: { analytics_data: true, financial_data: true },
    });
    const rows: any[] = d.result ?? [];
    for (const p of rows) {
      if (p.status === 'cancelled') continue;
      const hub = resolveHubName(p.financial_data?.cluster_to ?? '');
      if (!hub) continue;
      for (const pr of p.products ?? []) {
        const sku = Number(pr.sku);
        if (!skuSet.has(sku)) continue;
        const qty = Number(pr.quantity ?? 1) || 1;
        hubShares.set(hub, (hubShares.get(hub) ?? 0) + qty);
        if (!bySkuHub.has(sku)) bySkuHub.set(sku, new Map(HUBS.map((h) => [h, 0])));
        const m = bySkuHub.get(sku)!;
        m.set(hub, (m.get(hub) ?? 0) + qty);
      }
    }
    if (rows.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { hubShares, bySkuHub };
}

async function loadMilaiProducts(creds: Creds): Promise<Map<string, { sku: number; name: string }>> {
  const prices = await shopPost(creds, '/v5/product/info/prices', {
    filter: { visibility: 'ALL' },
    limit: 100,
    last_id: '',
  });
  const offerIds = (prices.items ?? []).map((i: any) => String(i.offer_id));
  const info = await shopPost(creds, '/v3/product/info/list', {
    offer_id: offerIds,
    product_id: [],
    sku: [],
  });
  const map = new Map<string, { sku: number; name: string }>();
  for (const it of info.items ?? info.result?.items ?? []) {
    const offer = String(it.offer_id);
    const sku = Number(it.sku ?? it.sources?.[0]?.sku);
    map.set(offer, { sku, name: String(it.name ?? '') });
  }
  return map;
}

function buildLumosProducts(moscow: MoscowRow[]): { products: ShopProduct[]; notes: string[] } {
  const notes: string[] = [];
  const byExcel = new Map(moscow.map((r) => [r.excelOffer, r]));
  const products: ShopProduct[] = [];

  for (const p of PRODUCTS.filter((x) => x.sku)) {
    let msk = byExcel.get(p.offerId)?.free ?? 0;
    let excelOffer = p.offerId;
    if (!msk) {
      for (const [alias, canon] of Object.entries(LUMOS_EXCEL_ALIASES)) {
        if (canon === p.offerId && byExcel.has(alias)) {
          msk = byExcel.get(alias)!.free;
          excelOffer = alias;
        }
      }
    }
    products.push({
      shop: 'Lumos',
      excelOffer,
      ozonOffer: p.offerId,
      sku: p.sku!,
      name: SHORT_NAME_BY_OFFER[p.offerId] ?? p.name,
      msk,
    });
  }

  for (const r of moscow) {
    const canon = LUMOS_EXCEL_ALIASES[r.excelOffer] ?? r.excelOffer;
    const isLumosLike = /^(АБ-|АР-|РЗ|РС|РЧ)/.test(canon) || r.excelOffer in LUMOS_EXCEL_ALIASES;
    if (!isLumosLike) continue;
    if (PRODUCTS.some((p) => p.offerId === canon && p.sku)) continue;
    notes.push(`${r.excelOffer}: на МСК ${r.free} шт, нет активного SKU в catalog.ts — в отгрузку не берём`);
  }
  return { products, notes };
}

function buildMilaiProducts(
  moscow: MoscowRow[],
  apiProducts: Map<string, { sku: number; name: string }>,
): { products: ShopProduct[]; notes: string[] } {
  const notes: string[] = [];
  const products: ShopProduct[] = [];
  const usedExcel = new Set<string>();

  for (const [excelOffer, ozonOffer] of Object.entries(MILAI_EXCEL_TO_OZON)) {
    const row = moscow.find((r) => r.excelOffer === excelOffer);
    const api = apiProducts.get(ozonOffer);
    if (!api) {
      notes.push(`Milai ${excelOffer} → «${ozonOffer}»: нет в API Ozon`);
      continue;
    }
    usedExcel.add(excelOffer);
    products.push({
      shop: 'Milai',
      excelOffer,
      ozonOffer,
      sku: api.sku,
      name: MILAI_BY_SKU.get(api.sku)?.hint ?? api.name.slice(0, 40),
      msk: row?.free ?? 0,
    });
  }

  for (const r of moscow) {
    if (usedExcel.has(r.excelOffer)) continue;
    if (/^(АБ-|АР-|РЗ|РС|РЧ)/.test(r.excelOffer) || r.excelOffer in LUMOS_EXCEL_ALIASES) continue;
    if (MILAI_EXCEL_TO_OZON[r.excelOffer]) continue;
    notes.push(`МСК «${r.excelOffer}» (${r.free} шт): не сопоставлен с Milai/Lumos каталогом`);
  }
  return { products, notes };
}

function computePlans(
  products: ShopProduct[],
  fboBySku: Map<number, number>,
  orderedBySku: Map<number, number>,
  hubSharesGlobal: Map<string, number>,
  bySkuHub: Map<number, Map<string, number>>,
): SkuPlan[] {
  const globalShares = HUBS.map((h) => hubSharesGlobal.get(h) ?? 0);
  const globalSum = globalShares.reduce((a, b) => a + b, 0);

  return products.map((p) => {
    const fbo = fboBySku.get(p.sku) ?? 0;
    const ordered30 = orderedBySku.get(p.sku) ?? 0;
    const vel = ordered30 / DAYS;
    const target = Math.ceil(vel * COVER);
    const ship = vel > 0 ? Math.min(Math.max(0, target - fbo), p.msk) : 0;
    const daysFbo = vel > 0 ? fbo / vel : fbo > 0 ? null : 0;

    const perSku = bySkuHub.get(p.sku);
    let shares = HUBS.map((h) => perSku?.get(h) ?? 0);
    if (shares.every((s) => s === 0)) {
      shares = globalSum > 0 ? globalShares : HUBS.map(() => 1);
    }

    const allocQty = ship > 0 ? allocateByShares(ship, shares) : HUBS.map(() => 0);
    const alloc: Record<string, number> = {};
    HUBS.forEach((h, i) => {
      alloc[h] = allocQty[i];
    });

    return {
      shop: p.shop,
      excelOffer: p.excelOffer,
      ozonOffer: p.ozonOffer,
      sku: p.sku,
      name: p.name,
      msk: p.msk,
      fbo,
      ordered30,
      vel,
      daysFbo,
      target,
      ship,
      alloc,
    };
  });
}

async function writeReport(
  today: string,
  from: string,
  plans: SkuPlan[],
  notes: string[],
  hubSales: { Lumos: Map<string, number>; Milai: Map<string, number> },
): Promise<string> {
  const wb = new ExcelJS.Workbook();

  const hot = plans.filter((p) => p.vel > 0 && p.fbo === 0);
  const mskOnly = plans.filter((p) => p.fbo === 0 && p.msk > 0);
  const toShip = plans.filter((p) => p.ship > 0).sort((a, b) => b.ship - a.ship);

  const ws1 = wb.addWorksheet('1_Ходовые_без_FBO');
  ws1.addRow(['Магазин', 'Артикул Excel', 'Артикул Ozon', 'Название', 'Заказов/30д', 'шт/день', 'МСК свободно', 'Везти']);
  ws1.getRow(1).font = { bold: true };
  for (const p of hot.sort((a, b) => b.ordered30 - a.ordered30)) {
    ws1.addRow([p.shop, p.excelOffer, p.ozonOffer, p.name, p.ordered30, Math.round(p.vel * 100) / 100, p.msk, p.ship]);
  }

  const ws2 = wb.addWorksheet('2_Только_МСК_склад');
  ws2.addRow(['Магазин', 'Артикул Excel', 'Артикул Ozon', 'Название', 'МСК свободно', 'FBO', 'Заказов/30д', 'Везти']);
  ws2.getRow(1).font = { bold: true };
  for (const p of mskOnly.sort((a, b) => b.msk - a.msk)) {
    ws2.addRow([p.shop, p.excelOffer, p.ozonOffer, p.name, p.msk, p.fbo, p.ordered30, p.ship]);
  }

  const ws3 = wb.addWorksheet('3_План_SKU');
  ws3.addRow([
    'Магазин', 'Артикул Excel', 'Артикул Ozon', 'SKU', 'Название',
    'МСК', 'FBO', 'Заказов/30д', 'шт/день', 'Дней FBO', 'Цель 30д', 'Везти',
    ...HUBS,
  ]);
  ws3.getRow(1).font = { bold: true };
  for (const p of [...plans].sort((a, b) => a.shop.localeCompare(b.shop) || b.ship - a.ship)) {
    ws3.addRow([
      p.shop, p.excelOffer, p.ozonOffer, p.sku, p.name,
      p.msk, p.fbo, p.ordered30, Math.round(p.vel * 100) / 100,
      p.daysFbo == null ? '∞' : Math.round(p.daysFbo * 10) / 10,
      p.target, p.ship,
      ...HUBS.map((h) => p.alloc[h] ?? 0),
    ]);
  }

  const ws4 = wb.addWorksheet('4_По_кластерам');
  ws4.addRow(['Магазин', 'Кластер', 'Артикул Excel', 'Артикул Ozon', 'Название', 'Кол-во']);
  ws4.getRow(1).font = { bold: true };
  for (const shop of ['Lumos', 'Milai'] as ShopId[]) {
    for (const hub of HUBS) {
      for (const p of toShip.filter((x) => x.shop === shop && (x.alloc[hub] ?? 0) > 0)) {
        ws4.addRow([shop, hub, p.excelOffer, p.ozonOffer, p.name, p.alloc[hub]]);
      }
    }
  }

  const meta = wb.addWorksheet('Справка');
  meta.addRow(['Параметр', 'Значение']);
  meta.addRow(['Дата', today]);
  meta.addRow(['Период продаж', `${from} → ${today} (${DAYS} дн)`]);
  meta.addRow(['Целевой запас', `${COVER} дней`]);
  meta.addRow(['Кластеры', HUBS.join(' | ')]);
  meta.addRow(['Формула ship', 'min(max(0, ceil(vel×30) − fbo), msk_free); vel=0 → не везём']);
  meta.addRow(['Доли кластеров', 'cluster_to из FBO postings за 30д (без cancelled); иначе глобальные доли хабов']);
  meta.addRow(['Источник склада', stockPath]);
  meta.addRow(['Продажи Lumos по хабам', HUBS.map((h) => `${h}: ${hubSales.Lumos.get(h) ?? 0}`).join('; ')]);
  meta.addRow(['Продажи Milai по хабам', HUBS.map((h) => `${h}: ${hubSales.Milai.get(h) ?? 0}`).join('; ')]);
  for (const n of notes) meta.addRow(['Заметка', n]);

  for (const ws of [ws1, ws2, ws3, ws4, meta]) {
    ws.getColumn(1).width = 10;
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 28;
    ws.getColumn(4).width = 36;
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `supply-plan-dual-${today}.xlsx`);
  await wb.xlsx.writeFile(reportPath);

  // import files per shop × cluster
  const importDir = join(OUT_DIR, 'import');
  if (!existsSync(importDir)) mkdirSync(importDir, { recursive: true });
  else for (const f of readdirSync(importDir)) if (f.endsWith('.xlsx')) unlinkSync(join(importDir, f));

  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
  for (const shop of ['Lumos', 'Milai'] as ShopId[]) {
    HUBS.forEach((hub, idx) => {
      const rows = toShip
        .filter((p) => p.shop === shop && (p.alloc[hub] ?? 0) > 0)
        .map((p) => ({ offerId: p.ozonOffer, name: p.name, qty: p.alloc[hub] }));
      if (!rows.length) return;
      const total = rows.reduce((s, r) => s + r.qty, 0);
      const aoa: (string | number)[][] = [['артикул', 'имя (необязательно)', 'количество']];
      for (const r of rows) aoa.push([r.offerId, r.name, r.qty]);
      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
      const file = `${shop}_${String(idx + 1).padStart(2, '0')}_${safe(hub)}_${total}шт.xlsx`;
      XLSX.writeFile(book, join(importDir, file));
    });
  }

  // also copy report to Desktop
  const desk = join(homedir(), 'Desktop', `supply-plan-dual-${today}.xlsx`);
  await wb.xlsx.writeFile(desk);
  return reportPath;
}

function printTables(plans: SkuPlan[]): void {
  const hot = plans.filter((p) => p.vel > 0 && p.fbo === 0);
  const mskOnly = plans.filter((p) => p.fbo === 0 && p.msk > 0);
  const toShip = plans.filter((p) => p.ship > 0).sort((a, b) => a.shop.localeCompare(b.shop) || b.ship - a.ship);

  console.log('\n========== 1) Ходовые без FBO ==========');
  console.log(`${pad('Shop', 6)}${pad('Offer', 22)}${pad('ord30', 7, true)}${pad('msk', 5, true)}${pad('ship', 6, true)}`);
  for (const p of hot.sort((a, b) => b.ordered30 - a.ordered30)) {
    console.log(`${pad(p.shop, 6)}${pad(p.ozonOffer, 22)}${pad(String(p.ordered30), 7, true)}${pad(String(p.msk), 5, true)}${pad(String(p.ship), 6, true)}`);
  }
  if (!hot.length) console.log('(нет)');

  console.log('\n========== 2) Нет FBO, есть на МСК ==========');
  console.log(`${pad('Shop', 6)}${pad('Offer', 22)}${pad('msk', 5, true)}${pad('ord30', 7, true)}${pad('ship', 6, true)}`);
  for (const p of mskOnly.sort((a, b) => b.msk - a.msk)) {
    console.log(`${pad(p.shop, 6)}${pad(p.ozonOffer, 22)}${pad(String(p.msk), 5, true)}${pad(String(p.ordered30), 7, true)}${pad(String(p.ship), 6, true)}`);
  }
  if (!mskOnly.length) console.log('(нет)');

  console.log('\n========== 3) План отгрузки на 30 дней ==========');
  console.log(
    `${pad('Shop', 6)}${pad('Offer', 22)}${pad('fbo', 5, true)}${pad('msk', 5, true)}${pad('vel', 6, true)}${pad('ship', 6, true)}  ` +
      HUBS.map((h) => pad(h.split(',')[0].slice(0, 8), 9, true)).join(''),
  );
  let grand = 0;
  for (const p of toShip) {
    grand += p.ship;
    console.log(
      `${pad(p.shop, 6)}${pad(p.ozonOffer, 22)}${pad(String(p.fbo), 5, true)}${pad(String(p.msk), 5, true)}${pad(p.vel.toFixed(2), 6, true)}${pad(String(p.ship), 6, true)}  ` +
        HUBS.map((h) => pad(String(p.alloc[h] ?? 0), 9, true)).join(''),
    );
  }
  console.log(`ИТОГО везём: ${grand} шт`);

  console.log('\n========== По кластерам (артикулы) ==========');
  for (const shop of ['Lumos', 'Milai'] as ShopId[]) {
    for (const hub of HUBS) {
      const rows = toShip.filter((p) => p.shop === shop && (p.alloc[hub] ?? 0) > 0);
      const qty = rows.reduce((s, p) => s + (p.alloc[hub] ?? 0), 0);
      if (!qty) continue;
      const parts = rows
        .sort((a, b) => (b.alloc[hub] ?? 0) - (a.alloc[hub] ?? 0))
        .map((p) => `${p.excelOffer}×${p.alloc[hub]}`);
      console.log(`  ${shop} · ${hub}: ${qty} шт — ${parts.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const today = moscowDateStr();
  const now = moscowNow();
  const fromDate = new Date(new Date(`${today}T00:00:00+03:00`).getTime() - DAYS * 86400_000);
  const toDate = new Date(`${today}T23:59:59+03:00`);
  const from = fromDate.toISOString().slice(0, 10);

  console.log(`📦 Supply dual · cover ${COVER}д · sales ${DAYS}д (${from}…${today})`);
  console.log(`📄 Склад: ${stockPath}`);
  console.log(`🗺  Хабы: ${HUBS.join(' | ')}\n`);

  const moscow = readMoscowStock(stockPath);
  console.log(`МСК позиций: ${moscow.length}, свободно: ${moscow.reduce((s, r) => s + r.free, 0)} шт`);

  const lumos = lumosCreds();
  const milai = milaiCreds();

  console.log('\n🌐 Lumos API…');
  const lumosWh = await fetchClustersMap(lumos);
  const lumosFbo = await fetchFboBySku(lumos, lumosWh);
  const lumosOrdered = await fetchOrderedBySku(lumos, from, today);
  const { products: lumosProducts, notes: lumosNotes } = buildLumosProducts(moscow);
  const lumosSkus = new Set(lumosProducts.map((p) => p.sku));
  const lumosSales = await fetchSalesByHub(lumos, fromDate, toDate, lumosSkus);
  console.log('  hub sales:', [...lumosSales.hubShares.entries()].map(([k, v]) => `${k.split(',')[0]}:${v}`).join(', '));

  console.log('\n🌐 Milai API…');
  const milaiWh = await fetchClustersMap(milai);
  const milaiFbo = await fetchFboBySku(milai, milaiWh);
  const milaiOrdered = await fetchOrderedBySku(milai, from, today);
  const milaiApi = await loadMilaiProducts(milai);
  const { products: milaiProducts, notes: milaiNotes } = buildMilaiProducts(moscow, milaiApi);
  const milaiSkus = new Set(milaiProducts.map((p) => p.sku));
  const milaiSales = await fetchSalesByHub(milai, fromDate, toDate, milaiSkus);
  console.log('  hub sales:', [...milaiSales.hubShares.entries()].map(([k, v]) => `${k.split(',')[0]}:${v}`).join(', '));

  const lumosPlans = computePlans(
    lumosProducts,
    lumosFbo.bySku,
    lumosOrdered,
    lumosSales.hubShares,
    lumosSales.bySkuHub,
  );
  const milaiPlans = computePlans(
    milaiProducts,
    milaiFbo.bySku,
    milaiOrdered,
    milaiSales.hubShares,
    milaiSales.bySkuHub,
  );
  const plans = [...lumosPlans, ...milaiPlans];
  const notes = [...lumosNotes, ...milaiNotes];

  printTables(plans);

  const reportPath = await writeReport(today, from, plans, notes, {
    Lumos: lumosSales.hubShares,
    Milai: milaiSales.hubShares,
  });
  console.log(`\n✅ Отчёт: ${reportPath}`);
  console.log(`✅ Копия: ${join(homedir(), 'Desktop', `supply-plan-dual-${today}.xlsx`)}`);
  console.log(`✅ Импорт: ${join(OUT_DIR, 'import')}\n`);
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
