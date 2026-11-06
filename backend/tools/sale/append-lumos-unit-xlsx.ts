/**
 * Добавляет магазин Lumos в milai-main-unit-economics.xlsx.
 * Группировка: Фоторамки → Альбомы (АБ → АР → АР-300).
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/append-lumos-unit-xlsx.ts [path.xlsx]
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import ExcelJS from 'exceljs';
import { PRODUCTS, type Product, type ProductGroup } from './lib/catalog';
import { TAX_RATE } from './lib/economics';
import { env } from './lib/env';
import { fetchAllPrices, ozonPost } from './lib/ozon';
import { moscowDateStr, moscowNow } from './lib/format';

const repoRoot = join(__dirname, '../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const DEFAULT_XLSX = '/Users/kadirovajnur/Desktop/milai-main-unit-economics.xlsx';
const DAYS = 30;
const TAX_PCT = TAX_RATE * 100;
const ACQ_PCT = 1.5;
const STORE = 'Lumos';

const GROUP_ORDER: Record<ProductGroup, number> = {
  Р: 0,
  АБ: 1,
  АР: 2,
  'АР-300': 3,
};

const SUBJECT_BY_GROUP: Record<ProductGroup, string> = {
  Р: 'Фоторамка',
  АБ: 'Фотоальбом',
  АР: 'Фотоальбом',
  'АР-300': 'Фотоальбом',
};

const LOGI = new Set([
  'MarketplaceServiceItemDirectFlowLogistic',
  'MarketplaceServiceItemReturnFlowLogistic',
  'MarketplaceServiceItemDelivToCustomer',
  'MarketplaceServiceItemReturnAfterDelivToCustomer',
  'MarketplaceServiceItemReturnNotDelivToCustomer',
  'MarketplaceServiceItemReturnPartGoodsCustomer',
  'MarketplaceServiceItemDirectFlowTrans',
  'MarketplaceServiceItemReturnFlowTrans',
]);

const ADS_OPS = new Set([
  'OperationMarketplaceCostPerClick',
  'OperationElectronicServicesPromotionInSearch',
  'MarketplaceMarketingActionCostOperation',
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

function sortedProducts(): Product[] {
  return [...PRODUCTS]
    .filter((p) => p.sku)
    .sort((a, b) => {
      const ga = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
      if (ga !== 0) return ga;
      return a.offerId.localeCompare(b.offerId, 'ru');
    });
}

interface SkuFinance {
  sold: number;
  returns: number;
  revenue: number;
  actualBuyout: number | null;
}

interface ProductRow {
  product: Product;
  offerId: string;
  sku: number;
  name: string;
  subject: string;
  productId: number;
  volume: number;
  priceBefore: number;
  priceAfter: number;
  coinvestPct: number | null;
  commissionPct: number;
  buyoutPct: number;
  monthlySales: number;
  stock: number;
  drrPct: number | null;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await nodeFetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Id': env.ozonClientId,
      'Api-Key': env.ozonApiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function fetchFinance(from: Date, to: Date): Promise<Map<number, SkuFinance>> {
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

  const bySku = new Map<number, SkuFinance>();
  const ensure = (sku: number): SkuFinance => {
    let row = bySku.get(sku);
    if (!row) {
      row = { sold: 0, returns: 0, revenue: 0, actualBuyout: null };
      bySku.set(sku, row);
    }
    return row;
  };

  for (const op of all) {
    const sku = num(op.items?.[0]?.sku);
    if (!sku) continue;
    const row = ensure(sku);
    if (op.type === 'orders' && num(op.accruals_for_sale) > 0) {
      row.sold++;
      row.revenue += num(op.accruals_for_sale);
    } else if (op.type === 'returns' && num(op.accruals_for_sale) !== 0) {
      row.returns++;
      row.revenue += num(op.accruals_for_sale);
    }
  }

  for (const row of bySku.values()) {
    const attempts = row.sold + row.returns;
    if (attempts > 0) row.actualBuyout = row.sold / attempts;
  }
  return bySku;
}

async function fetchStocks(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const d = await ozonPost<any>('/v2/analytics/stock_on_warehouses', {
      limit: 1000,
      offset: 0,
      warehouse_type: 'ALL',
    });
    for (const r of d.result?.rows ?? []) {
      const sku = num(r.sku);
      map.set(sku, (map.get(sku) ?? 0) + num(r.free_to_sell_amount));
    }
  } catch {
    // optional
  }
  return map;
}

async function fetchAdsDrrBySku(fromStr: string, toStr: string): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const tokRes = await nodeFetch('https://api-performance.ozon.ru/api/client/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.ozonPerfClientId,
        client_secret: env.ozonPerfClientSecret,
        grant_type: 'client_credentials',
      }),
    });
    const tok = await tokRes.json();
    const token = tok.access_token;
    if (!token) return map;

    const campRes = await nodeFetch('https://api-performance.ozon.ru/api/client/campaign?page=1&pageSize=500', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ids: number[] = ((await campRes.json()).list ?? []).map((c: any) => Number(c.id)).filter(Boolean);
    if (!ids.length) return map;

    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const postR = await nodeFetch('https://api-performance.ozon.ru/api/client/statistics/json', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaigns: batch, dateFrom: fromStr, dateTo: toStr, groupBy: 'NO_GROUP_BY' }),
      });
      const pd = await postR.json();
      const uuid = pd?.UUID ?? pd?.uuid;
      if (!uuid) continue;

      let ok = false;
      for (let a = 0; a < 40; a++) {
        await new Promise((r) => setTimeout(r, 1500));
        const jr = await nodeFetch(`https://api-performance.ozon.ru/api/client/statistics/${uuid}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const job = await jr.json();
        if (job?.state === 'OK') { ok = true; break; }
        if (job?.state === 'ERROR' || job?.state === 'FAILED') break;
      }
      if (!ok) continue;

      const rep = await nodeFetch(`https://api-performance.ozon.ru/api/client/statistics/report?UUID=${uuid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await rep.json();
      const parseRu = (v: unknown): number => {
        if (typeof v === 'number') return v;
        if (typeof v !== 'string') return 0;
        const n = parseFloat(v.replace(/\s/g, '').replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
      };
      for (const value of Object.values(body ?? {})) {
        for (const row of (value as any)?.report?.rows ?? []) {
          const sku = num(row.sku);
          if (!sku) continue;
          const spent = parseRu(row.moneySpent);
          const money = parseRu(row.ordersMoney);
          if (money > 0) map.set(sku, (spent / money) * 100);
        }
      }
    }
  } catch {
    // optional
  }
  return map;
}

function formulas(row: number): Record<string, string> {
  return {
    J: `-(K${row}-I${row})/I${row}*100`,
    T: `I${row}*L${row}/100`,
    U: `IFERROR(((VLOOKUP($M${row},'Матрица логистики'!$A$2:$E$50,3,TRUE)+VLOOKUP($M${row},'Матрица логистики'!$A$2:$E$50,5,TRUE)+VLOOKUP($M${row},'Матрица логистики'!$A$2:$E$50,4,TRUE)*(1-$N${row}/100))/($N${row}/100)),0)`,
    V: `I${row}*Q${row}/100`,
    W: `IF(S${row}="",0,I${row}*S${row}%)`,
    X: `K${row}*R${row}/100`,
    Z: `I${row}-SUM(T${row},U${row},V${row},W${row},X${row},H${row})`,
    AA: `Z${row}/H${row}*100`,
  };
}

function setFormula(cell: ExcelJS.Cell, formula: string): void {
  cell.value = { formula, date1904: false };
}

function linkCell(ws: ExcelJS.Worksheet, row: number, col: number, text: string, url: string): void {
  const cell = ws.getCell(row, col);
  cell.value = { text, hyperlink: url };
  cell.font = { color: { argb: 'FF0563C1' }, underline: true };
}

async function buildRows(): Promise<ProductRow[]> {
  const products = sortedProducts();
  const skuList = products.map((p) => p.sku!);

  const prices = await fetchAllPrices();
  const priceByOffer = new Map(prices.map((p) => [p.offer_id, p]));

  const infoRes = await post('/v3/product/info/list', {
    offer_id: [],
    product_id: [],
    sku: skuList,
  });
  const infoItems: any[] = infoRes.items ?? infoRes.result?.items ?? [];
  const infoBySku = new Map(infoItems.map((it) => [num(it.sku ?? it.sources?.[0]?.sku), it]));
  const infoByOffer = new Map(infoItems.map((it) => [String(it.offer_id), it]));

  const finFrom = daysAgo(DAYS);
  const finBySku = await fetchFinance(finFrom, new Date());
  const stocks = await fetchStocks();
  const fromStr = finFrom.toISOString().slice(0, 10);
  const toStr = moscowDateStr();
  const drrBySku = await fetchAdsDrrBySku(fromStr, toStr);

  const rows: ProductRow[] = [];
  for (const product of products) {
    const sku = product.sku!;
    const info = infoBySku.get(sku) ?? infoByOffer.get(product.offerId);
    const offerId = String(info?.offer_id ?? product.offerId);
    const priceItem = priceByOffer.get(offerId) ?? priceByOffer.get(product.offerId);

    const fin = finBySku.get(sku);

    const priceBefore = Math.round(
      num(priceItem?.price?.price)
      || num(info?.price)
      || num(info?.marketing_price)
      || 0,
    );
    const priceAfter = fin && fin.sold > 0
      ? Math.round(fin.revenue / fin.sold)
      : priceBefore;
    let coinvestPct: number | null = null;
    if (priceBefore > 0 && fin && fin.sold > 0 && priceBefore > priceAfter) {
      coinvestPct = ((priceBefore - priceAfter) / priceBefore) * 100;
    }

    const commissionPct = num(priceItem?.commissions?.sales_percent_fbo) || 46;
    const buyoutPct = fin?.actualBuyout != null && (fin.sold + fin.returns) >= 3
      ? fin.actualBuyout * 100
      : 85;

    rows.push({
      product,
      offerId,
      sku,
      name: String(info?.name ?? product.name),
      subject: SUBJECT_BY_GROUP[product.group],
      productId: num(info?.id),
      volume: num(info?.volume_weight),
      priceBefore,
      priceAfter,
      coinvestPct: coinvestPct != null ? Math.round(coinvestPct * 10) / 10 : null,
      commissionPct,
      buyoutPct: Math.round(buyoutPct * 10) / 10,
      monthlySales: fin?.sold ?? 0,
      stock: stocks.get(sku) ?? 0,
      drrPct: drrBySku.has(sku) ? Math.round(drrBySku.get(sku)! * 10) / 10 : null,
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const xlsxPath = process.argv[2] ?? DEFAULT_XLSX;
  const today = moscowDateStr();

  console.log(`\n→ Lumos (${env.ozonClientId}) → ${xlsxPath}\n`);
  const data = await buildRows();
  console.log(`  SKU: ${data.length} (фоторамки ${data.filter((r) => r.product.group === 'Р').length}, альбомы ${data.filter((r) => r.product.group !== 'Р').length})`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet('Юнит-экономика');
  if (!ws) throw new Error('Нет листа «Юнит-экономика»');

  // Удалить строки после Milai (placeholder Lumos и пустые)
  const milaiLastRow = 12;
  if (ws.rowCount > milaiLastRow) {
    ws.spliceRows(milaiLastRow + 1, ws.rowCount - milaiLastRow);
  }

  let rowNum = milaiLastRow;

  for (const r of data) {
    rowNum++;
    const ozonUrl = `https://www.ozon.ru/product/${r.sku}`;
    const sellerUrl = r.productId
      ? `https://seller.ozon.ru/app/products/${r.productId}`
      : 'https://seller.ozon.ru/app/products';

    ws.getCell(`A${rowNum}`).value = 'OZON';
    ws.getCell(`B${rowNum}`).value = STORE;
    ws.getCell(`C${rowNum}`).value = r.subject;
    ws.getCell(`D${rowNum}`).value = r.name;
    ws.getCell(`E${rowNum}`).value = r.offerId;
    linkCell(ws, rowNum, 6, String(r.sku), ozonUrl);
    ws.getCell(`G${rowNum}`).value = today;
    ws.getCell(`H${rowNum}`).value = r.product.cost;
    ws.getCell(`I${rowNum}`).value = r.priceBefore;
    if (r.coinvestPct != null) ws.getCell(`K${rowNum}`).value = r.priceAfter;
    ws.getCell(`L${rowNum}`).value = r.commissionPct;
    ws.getCell(`M${rowNum}`).value = r.volume;
    ws.getCell(`N${rowNum}`).value = r.buyoutPct;
    ws.getCell(`O${rowNum}`).value = r.monthlySales;
    ws.getCell(`P${rowNum}`).value = r.stock;
    ws.getCell(`Q${rowNum}`).value = ACQ_PCT;
    ws.getCell(`R${rowNum}`).value = TAX_PCT;
    if (r.drrPct != null) ws.getCell(`S${rowNum}`).value = r.drrPct;
    ws.getCell(`Y${rowNum}`).value = 0;

    if (r.coinvestPct == null && r.priceAfter !== r.priceBefore) {
      ws.getCell(`K${rowNum}`).value = r.priceAfter;
    } else if (r.coinvestPct == null) {
      ws.getCell(`K${rowNum}`).value = r.priceAfter;
    }

    const f = formulas(rowNum);
    for (const [col, formula] of Object.entries(f)) setFormula(ws.getCell(`${col}${rowNum}`), formula);

    linkCell(ws, rowNum, 30, 'Ozon', ozonUrl);
    linkCell(ws, rowNum, 31, 'Кабинет', sellerUrl);
  }

  await wb.xlsx.writeFile(xlsxPath);
  console.log(`\n✅ Добавлено ${data.length} строк Lumos (строки ${milaiLastRow + 1}–${rowNum})`);
  console.log(`   Порядок: Фоторамки → АБ → АР → АР-300\n`);
}

main().catch((e: Error) => {
  console.error('❌', e.message);
  process.exit(1);
});
