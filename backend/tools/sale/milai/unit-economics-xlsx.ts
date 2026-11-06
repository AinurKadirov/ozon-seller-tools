/**
 * unit-economics-xlsx.ts — таблица юнит-экономики MILAI в Excel.
 *
 * Собирает операционные значения по каждому SKU и выгружает xlsx с гиперссылками.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/milai/unit-economics-xlsx.ts
 *   npm run ozon:milai-unit-economics
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import ExcelJS from 'exceljs';
import { fetchProductRates, type ProductRates } from './ozon';
import { MILAI_BY_SKU, MILAI_PRODUCTS } from './catalog';
import { computePricing, DEFAULT_TAX_RATE, DEFAULT_ACQUIRING_RATE } from './economics';
import { moscowDateStr, moscowNow } from '../lib/format';

const repoRoot = join(__dirname, '../../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://api-seller.ozon.ru';
const PERF = 'https://api-performance.ozon.ru';
const DAYS = 30;
const TAX_PCT = DEFAULT_TAX_RATE * 100;

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

function daysAgo(n: number): Date {
  const msk = moscowNow();
  msk.setUTCDate(msk.getUTCDate() - n);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - 3 * 3600_000);
}

interface ProductInfo {
  offerId: string;
  sku: number;
  productId: number;
  name: string;
  subject: string;
  category: string;
  volumeWeight: number;
  oldPrice: number;
  cardPrice: number;
  currentPrice: number;
  netPrice: number;
  commissionFboPct: number;
}

interface SkuFinance {
  sold: number;
  returns: number;
  revenue: number;
  commission: number;
  logistics: number;
  returnLogistics: number;
  acquiring: number;
  storageShare: number;
  avgRealizedPrice: number;
  actualBuyout: number | null;
  coinvestPct: number | null;
}

interface SkuAds {
  spent: number;
  ordersMoney: number;
  drr: number | null;
}

async function fetchProductInfos(rates: ProductRates[]): Promise<Map<number, ProductInfo>> {
  const offerIds = rates.map((r) => r.offerId).filter(Boolean);
  const infoRes = await post('/v3/product/info/list', { offer_id: offerIds, product_id: [], sku: [] });
  const infoItems: any[] = infoRes.items ?? infoRes.result?.items ?? [];

  const catRes = await post('/v1/description-category/tree', { language: 'DEFAULT' });
  const tree: any[] = catRes.result ?? [];

  const categoryById = new Map<number, string>();
  const typeById = new Map<number, string>();
  const walk = (nodes: any[]): void => {
    for (const n of nodes ?? []) {
      if (n.description_category_id) categoryById.set(n.description_category_id, n.category_name);
      if (n.type_id && n.type_name) typeById.set(n.type_id, n.type_name);
      walk(n.children);
    }
  };
  walk(tree);

  const priceByOffer = new Map(rates.map((r) => [r.offerId, r]));
  const map = new Map<number, ProductInfo>();

  for (const it of infoItems) {
    const offerId = String(it.offer_id ?? '');
    const sku = Number(it.sku ?? 0);
    const rate = priceByOffer.get(offerId);
    if (!sku) continue;
    map.set(sku, {
      offerId,
      sku,
      productId: Number(it.id ?? rate?.productId ?? 0),
      name: String(it.name ?? rate?.offerId ?? ''),
      subject: typeById.get(Number(it.type_id)) ?? '—',
      category: categoryById.get(Number(it.description_category_id)) ?? '—',
      volumeWeight: Number(it.volume_weight ?? 0),
      oldPrice: Number(it.old_price ?? 0),
      cardPrice: Number(it.price ?? rate?.currentPrice ?? 0),
      currentPrice: Number(rate?.currentPrice ?? it.price ?? 0),
      netPrice: Number((it as any).net_price ?? 0),
      commissionFboPct: Math.round((rate?.commissionFboRate ?? 0) * 1000) / 10,
    });
  }
  return map;
}

async function fetchStocks(): Promise<Map<number, number>> {
  const bySku = new Map<number, number>();
  try {
    const d = await post('/v2/analytics/stock_on_warehouses', {
      limit: 1000,
      offset: 0,
      warehouse_type: 'ALL',
    });
    for (const r of d.result?.rows ?? []) {
      const sku = Number(r.sku);
      bySku.set(sku, (bySku.get(sku) ?? 0) + Number(r.free_to_sell_amount ?? 0));
    }
  } catch {
    // optional
  }
  return bySku;
}

async function fetchFinance(from: Date, to: Date): Promise<{
  bySku: Map<number, SkuFinance>;
  totalStorage: number;
  totalAcquiringUnalloc: number;
}> {
  const all: any[] = [];
  const chunkEnd = new Date(to);
  let chunkStart = new Date(from);
  while (chunkStart < chunkEnd) {
    const nextEnd = new Date(chunkStart);
    nextEnd.setUTCDate(nextEnd.getUTCDate() + 27);
    const toChunk = nextEnd < chunkEnd ? nextEnd : chunkEnd;
    let page = 1;
    for (;;) {
      const d = await post('/v3/finance/transaction/list', {
        filter: { date: { from: chunkStart.toISOString(), to: toChunk.toISOString() }, transaction_type: 'all' },
        language: 'DEFAULT',
        page,
        page_size: 1000,
      });
      const ops = d.result?.operations ?? [];
      const pages = d.result?.page_count ?? 1;
      all.push(...ops);
      if (page >= pages || !ops.length) break;
      page++;
      await new Promise((r) => setTimeout(r, 200));
    }
    chunkStart = new Date(toChunk.getTime() + 1);
  }

  const bySku = new Map<number, SkuFinance>();
  let totalStorage = 0;
  let totalAcquiringUnalloc = 0;
  let totalRevenue = 0;

  const ensure = (sku: number): SkuFinance => {
    let row = bySku.get(sku);
    if (!row) {
      row = {
        sold: 0,
        returns: 0,
        revenue: 0,
        commission: 0,
        logistics: 0,
        returnLogistics: 0,
        acquiring: 0,
        storageShare: 0,
        avgRealizedPrice: 0,
        actualBuyout: null,
        coinvestPct: null,
      };
      bySku.set(sku, row);
    }
    return row;
  };

  for (const op of all) {
    if (/storage|Storage|Placement|placement/i.test(op.operation_type ?? '')) {
      totalStorage += Number(op.amount ?? 0);
      continue;
    }
    if (op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation') {
      totalAcquiringUnalloc += Number(op.amount ?? 0);
      continue;
    }
    if (ADS_OPS.has(op.operation_type)) continue;

    const sku = Number(op.items?.[0]?.sku ?? 0);
    if (!sku) continue;
    const row = ensure(sku);

    if (op.type === 'orders' && Number(op.accruals_for_sale) > 0) {
      row.sold++;
      row.revenue += Number(op.accruals_for_sale);
      row.commission += Number(op.sale_commission ?? 0);
      totalRevenue += Number(op.accruals_for_sale);
      for (const svc of op.services ?? []) {
        if (LOGI.has(svc.name)) row.logistics += Number(svc.price ?? 0);
      }
    } else if (op.type === 'returns' && Number(op.accruals_for_sale) !== 0) {
      row.returns++;
      row.revenue += Number(op.accruals_for_sale);
      row.commission += Number(op.sale_commission ?? 0);
      for (const svc of op.services ?? []) {
        if (LOGI.has(svc.name)) row.returnLogistics += Number(svc.price ?? 0);
      }
    }
  }

  for (const row of bySku.values()) {
    if (row.sold > 0) row.avgRealizedPrice = row.revenue / row.sold;
    const attempts = row.sold + row.returns;
    if (attempts > 0) row.actualBuyout = row.sold / attempts;
  }

  const storageAbs = Math.abs(totalStorage);
  for (const [sku, row] of bySku) {
    if (totalRevenue > 0) {
      row.storageShare = storageAbs * (row.revenue / totalRevenue);
    }
    void sku;
  }

  return { bySku, totalStorage, totalAcquiringUnalloc };
}

async function fetchAdsBySku(days: number): Promise<Map<number, SkuAds>> {
  const map = new Map<number, SkuAds>();
  const clientId = process.env.OZON_PERFORMANCE_CLIENT_ID_MILAI?.trim();
  const clientSecret = process.env.OZON_PERFORMANCE_CLIENT_SECRET_MILAI?.trim();
  if (!clientId || !clientSecret) return map;

  const tokRes = await nodeFetch(`${PERF}/api/client/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  const tok = (await tokRes.json()) as { access_token?: string };
  if (!tok.access_token) return map;
  const token = tok.access_token;

  const campRes = await nodeFetch(`${PERF}/api/client/campaign?page=1&pageSize=500`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const campBody = (await campRes.json()) as { list?: Array<{ id: number }> };
  const ids = (campBody.list ?? []).map((c) => Number(c.id)).filter(Boolean);
  if (!ids.length) return map;

  const to = moscowNow();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo = to.toISOString().slice(0, 10);

  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const postR = await nodeFetch(`${PERF}/api/client/statistics/json`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaigns: batch, dateFrom, dateTo, groupBy: 'NO_GROUP_BY' }),
    });
    const pd = (await postR.json().catch(() => null)) as { UUID?: string; uuid?: string } | null;
    const uuid = pd?.UUID ?? pd?.uuid;
    if (!uuid) continue;

    let ok = false;
    for (let a = 0; a < 40; a++) {
      await new Promise((r) => setTimeout(r, 2000));
      const jr = await nodeFetch(`${PERF}/api/client/statistics/${uuid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const job = (await jr.json().catch(() => null)) as { state?: string } | null;
      if (job?.state === 'OK') { ok = true; break; }
      if (job?.state === 'ERROR' || job?.state === 'FAILED') break;
    }
    if (!ok) continue;

    const rep = await nodeFetch(`${PERF}/api/client/statistics/report?UUID=${uuid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await rep.json().catch(() => null)) as Record<string, any> | null;
    if (!body) continue;

    const parseRu = (v: unknown): number => {
      if (typeof v === 'number') return v;
      if (typeof v !== 'string') return 0;
      const n = parseFloat(v.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : 0;
    };

    for (const value of Object.values(body)) {
      for (const row of value?.report?.rows ?? []) {
        const sku = Number(row.sku);
        if (!sku) continue;
        const spent = parseRu(row.moneySpent);
        const money = parseRu(row.ordersMoney);
        const cur = map.get(sku) ?? { spent: 0, ordersMoney: 0, drr: null };
        cur.spent += spent;
        cur.ordersMoney += money;
        cur.drr = cur.ordersMoney > 0 ? (cur.spent / cur.ordersMoney) * 100 : cur.spent > 0 ? null : 0;
        map.set(sku, cur);
      }
    }
  }
  return map;
}

function linkCell(ws: ExcelJS.Worksheet, row: number, col: number, text: string, url: string): void {
  const cell = ws.getCell(row, col);
  cell.value = { text, hyperlink: url };
  cell.font = { color: { argb: 'FF0563C1' }, underline: true };
}

async function main(): Promise<void> {
  const today = moscowDateStr();
  console.log(`\n🏪 MILAI unit economics → Excel (${today})\n`);

  console.log('→ Карточки и тарифы...');
  const rates = await fetchProductRates();
  const ratesBySku = new Map(rates.filter((r) => r.sku).map((r) => [r.sku, r]));

  console.log('→ Названия и категории...');
  const infos = await fetchProductInfos(rates);

  console.log(`→ Финансы за ${DAYS} дн...`);
  const finFrom = daysAgo(DAYS);
  const { bySku: finBySku, totalStorage } = await fetchFinance(finFrom, new Date());

  console.log('→ Остатки...');
  const stocks = await fetchStocks();

  console.log(`→ Реклама за ${DAYS} дн...`);
  const adsBySku = await fetchAdsBySku(DAYS);

  const outDir = join(repoRoot, 'tmp');
  mkdirSync(outDir, { recursive: true });
  const xlsxPath = join(outDir, `milai-unit-economics-${today}.xlsx`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MILAI tools';
  wb.created = new Date();

  const ws = wb.addWorksheet('Юнит-экономика', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = [
    'Предмет',
    'Название',
    'Артикул',
    'SKU',
    'Дата',
    'Цена до скидки',
    'Процент соинвеста',
    'Цена после скидки',
    'Процент комиссии',
    'Объем товара, л',
    'Процент выкупа',
    'Кол-во продаж в месяц',
    'Кол-во на складе',
    'Себестоимость',
    'Налог, %',
    'Логистика, ₽/шт',
    'Стоимость хранения, ₽/мес',
    'ДРР, %',
    'Эквайринг, ₽/шт',
    'Прибыль/шт (факт)',
    'Безубыток',
    'Ссылка Ozon',
    'Кабинет',
  ];
  ws.addRow(headers);

  const headerFill = 'FF2F5496';
  ws.getRow(1).eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerFill } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });

  const widths = [12, 36, 14, 12, 11, 14, 14, 14, 12, 12, 12, 14, 12, 12, 8, 12, 14, 8, 12, 14, 10, 12, 10];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const products = [...MILAI_PRODUCTS].sort((a, b) => (infos.get(a.sku)?.offerId ?? '').localeCompare(infos.get(b.sku)?.offerId ?? ''));

  for (const prod of products) {
    const info = infos.get(prod.sku);
    const rate = ratesBySku.get(prod.sku);
    const fin = finBySku.get(prod.sku);
    const stock = stocks.get(prod.sku) ?? 0;
    const ads = adsBySku.get(prod.sku);

    const priceBefore = info?.cardPrice || rate?.currentPrice || 0;
    const priceAfter = fin?.avgRealizedPrice && fin.sold > 0
      ? fin.avgRealizedPrice
      : priceBefore;

    let coinvestPct: number | null = null;
    if (info?.netPrice && info.netPrice > 0 && info.currentPrice > 0) {
      coinvestPct = ((info.currentPrice - info.netPrice) / info.currentPrice) * 100;
    } else if (priceBefore > 0 && fin && fin.sold > 0 && priceBefore > priceAfter) {
      coinvestPct = ((priceBefore - priceAfter) / priceBefore) * 100;
    }

    const buyoutPct = fin?.actualBuyout != null && (fin.sold + fin.returns) >= 5
      ? fin.actualBuyout * 100
      : prod.buyout * 100;

    const monthlySales = fin?.sold ?? 0;

    const avgLogiPerSale = fin && fin.sold > 0
      ? (Math.abs(fin.logistics) + Math.abs(fin.returnLogistics)) / fin.sold
      : rate
        ? computePricing({
            cost: prod.cost,
            buyout: prod.buyout,
            commissionRate: rate.commissionFboRate,
            forwardLogistics: rate.fboForward,
            returnLogistics: rate.fboReturn,
          }).logiCostPerSale
        : 0;

    const storagePerMonth = fin?.storageShare ?? 0;
    const acquiringPerSale = rate && rate.currentPrice > 0
      ? rate.acquiring || rate.currentPrice * DEFAULT_ACQUIRING_RATE
      : 0;

    const pricing = rate
      ? computePricing({
          cost: prod.cost,
          buyout: fin?.actualBuyout ?? prod.buyout,
          commissionRate: rate.commissionFboRate,
          forwardLogistics: rate.fboForward,
          returnLogistics: rate.fboReturn,
          acquiringRate: rate.currentPrice > 0 ? rate.acquiring / rate.currentPrice : DEFAULT_ACQUIRING_RATE,
        })
      : null;

    const profitPerUnit = pricing ? Math.round(pricing.profitAtPrice(priceAfter)) : null;
    const breakEven = pricing ? Math.round(pricing.breakEven) : null;

    const ozonUrl = `https://www.ozon.ru/product/${prod.sku}`;
    const sellerUrl = info?.productId
      ? `https://seller.ozon.ru/app/products/${info.productId}`
      : `https://seller.ozon.ru/app/products`;

    const rowNum = ws.rowCount + 1;
    ws.addRow([
      info?.subject ?? '—',
      info?.name ?? prod.hint ?? '',
      info?.offerId ?? '—',
      prod.sku,
      today,
      Math.round(priceBefore),
      coinvestPct != null ? Math.round(coinvestPct * 10) / 10 : '',
      Math.round(priceAfter),
      info?.commissionFboPct ?? (rate ? Math.round(rate.commissionFboRate * 1000) / 10 : ''),
      info?.volumeWeight || '',
      Math.round(buyoutPct * 10) / 10,
      monthlySales,
      stock,
      prod.cost,
      TAX_PCT,
      Math.round(avgLogiPerSale),
      Math.round(storagePerMonth),
      ads?.drr != null ? Math.round(ads.drr * 10) / 10 : ads?.spent ? '∞' : '',
      Math.round(acquiringPerSale * 10) / 10,
      profitPerUnit ?? '',
      breakEven ?? '',
      'Ozon',
      'Кабинет',
    ]);

    linkCell(ws, rowNum, 4, String(prod.sku), ozonUrl);
    linkCell(ws, rowNum, 22, 'Ozon', ozonUrl);
    linkCell(ws, rowNum, 23, 'Кабинет', sellerUrl);

    const profit = profitPerUnit ?? 0;
    const fill = profit < 0 ? 'FFF4CCCC' : profit < 100 ? 'FFFCE5CD' : 'FFE2F0D9';
    ws.getRow(rowNum).eachCell({ includeEmpty: true }, (c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    });
  }

  const meta = wb.addWorksheet('Справка');
  meta.addRows([
    ['Параметр', 'Значение'],
    ['Дата выгрузки', today],
    ['Период продаж/финансов', `${DAYS} дней`],
    ['Налог', `УСН ${TAX_PCT}% от выручки`],
    ['Цена до скидки', 'текущая цена в карточке (price / marketing_seller_price)'],
    ['Цена после скидки', `среднее начисление Ozon за продажу за ${DAYS}д; если продаж нет — цена карточки`],
    ['Процент соинвеста', 'из net_price API или (цена карточки − факт выкуп) / цена карточки'],
    ['Процент выкупа', `факт за ${DAYS}д (продажи / (продажи+возвраты)); иначе оценка из catalog.ts`],
    ['Кол-во продаж в месяц', `фактические продажи за последние ${DAYS} дней`],
    ['Логистика', 'средняя прямая + возвратная логистика на 1 продажу из транзакций; иначе модель FBO'],
    ['Стоимость хранения', 'доля общего хранения за период, пропорционально выручке SKU'],
    ['ДРР', `расход РК / GMV по SKU за ${DAYS}д (Performance API)`],
    ['Эквайринг', '~1% от цены, из карточки Ozon'],
    ['', ''],
    ['Доп. расходы (не в таблице по SKU)', ''],
    ['Возвратная логистика', 'уже включена в колонку «Логистика»'],
    ['Эквайринг', 'отдельная колонка; ~1% от цены'],
    ['Прочие услуги Ozon', 'штрафы, продвижение вне РК, подписки — смотреть в P&L'],
    ['Рассрочка / баллы Ozon', 'снижают фактическую цену выкупа vs ценник — отражено в «Цена после скидки»'],
    ['Общее хранение за период', `${Math.round(Math.abs(totalStorage))} ₽ за ${DAYS}д`],
  ]);
  meta.getColumn(1).width = 34;
  meta.getColumn(2).width = 72;
  meta.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(xlsxPath);
  console.log(`\n✅ Файл: ${xlsxPath}\n`);
}

main().catch((e: Error) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
