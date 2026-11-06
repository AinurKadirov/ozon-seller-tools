/**
 * supply-vs-stock.ts — отгрузки vs текущие остатки MilAi (по SKU).
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/milai/supply-vs-stock.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import ExcelJS from 'exceljs';
import { MILAI_BY_SKU, MILAI_PRODUCTS } from './catalog';
import { moscowDateStr, moscowNow } from '../lib/format';

const repoRoot = join(__dirname, '../../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://api-seller.ozon.ru';

/** Короткие имена статусов (как в /v3/supply-order/list). */
const SUPPLY_STATES = [
  'DATA_FILLING',
  'READY_TO_SUPPLY',
  'ACCEPTED_AT_SUPPLY_WAREHOUSE',
  'IN_TRANSIT',
  'ACCEPTANCE_AT_STORAGE_WAREHOUSE',
  'REPORTS_CONFIRMATION_AWAITING',
  'REPORT_REJECTED',
  'COMPLETED',
  'REJECTED_AT_SUPPLY_WAREHOUSE',
];

/** Уже приняты / почти приняты на склад (товар вошёл или входит в остаток). */
const ACCEPTED_STATES = new Set([
  'COMPLETED',
  'ORDER_STATE_COMPLETED',
  'REPORTS_CONFIRMATION_AWAITING',
  'ORDER_STATE_REPORTS_CONFIRMATION_AWAITING',
]);

function creds(): { clientId: string; apiKey: string } {
  const clientId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const apiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (!clientId || !apiKey) throw new Error('Нет OZON_SELLER_*_MILAI');
  return { clientId, apiKey };
}

async function post(path: string, body: unknown, retries = 4): Promise<any> {
  const { clientId, apiKey } = creds();
  for (let attempt = 0; attempt <= retries; attempt++) {
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
    if (res.status === 429 && attempt < retries) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }
  throw new Error(`${path} → rate limit`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SupplyLine {
  orderId: number;
  state: string;
  date: string;
  warehouse: string;
  sku: number;
  offer: string;
  name: string;
  qty: number;
}

interface ProductMeta {
  sku: number;
  offerId: string;
  name: string;
  productId: number;
}

interface StockAgg {
  free: number;
  reserved: number;
  promised: number;
  warehouse: number;
  transit: number; // from warehouse stocks API if present
}

async function fetchProductMeta(): Promise<Map<number, ProductMeta>> {
  const bySku = new Map<number, ProductMeta>();
  let lastId = '';
  for (;;) {
    const d = await post('/v3/product/list', {
      filter: { visibility: 'ALL' },
      limit: 100,
      last_id: lastId,
    });
    const items: any[] = d.result?.items ?? d.items ?? [];
    const productIds = items.map((i) => Number(i.product_id)).filter(Boolean);
    if (productIds.length) {
      const info = await post('/v3/product/info/list', {
        offer_id: [],
        product_id: productIds,
        sku: [],
      });
      for (const it of info.items ?? info.result?.items ?? []) {
        const sku = Number(it.sku ?? it.sources?.find((s: any) => s.sku)?.sku ?? 0);
        if (!sku) continue;
        bySku.set(sku, {
          sku,
          offerId: String(it.offer_id ?? ''),
          name: String(it.name ?? ''),
          productId: Number(it.id ?? it.product_id ?? 0),
        });
      }
    }
    lastId = d.result?.last_id ?? d.last_id ?? '';
    if (!lastId || items.length < 100) break;
  }
  return bySku;
}

async function listOrderIds(states: string[]): Promise<number[]> {
  const orderIds: number[] = [];
  let last = '';
  for (;;) {
    const d = await post('/v3/supply-order/list', {
      limit: 100,
      last_id: last,
      sort_by: 1,
      sort_direction: 'DESC',
      filter: { states },
    });
    const ids: number[] = d.order_ids ?? [];
    orderIds.push(...ids);
    if (!d.has_next || !ids.length) break;
    last = d.last_id ?? String(ids[ids.length - 1]);
  }
  return orderIds;
}

/** API не принимает длинный список states — тянем по одному статусу. */
async function listAllOrderIds(): Promise<number[]> {
  const all: number[] = [];
  for (const state of SUPPLY_STATES) {
    try {
      const ids = await listOrderIds([state]);
      if (ids.length) console.log(`  ${state}: ${ids.length}`);
      all.push(...ids);
    } catch (e: any) {
      console.log(`  ${state}: ${e.message.slice(0, 120)}`);
    }
    await sleep(80);
  }
  return [...new Set(all)];
}

async function fetchSupplies(): Promise<SupplyLine[]> {
  // status counter — чтобы увидеть реальные статусы в аккаунте
  try {
    const counter = await post('/v1/supply-order/status/counter', {});
    const items = (counter.items ?? []).filter((x: any) => Number(x.count) > 0);
    console.log('Статусы заявок (ненулевые):', JSON.stringify(items));
  } catch (e: any) {
    console.log('status/counter:', e.message);
  }

  const orderIds = await listAllOrderIds();
  console.log(`Заявок на поставку: ${orderIds.length}`);

  const lines: SupplyLine[] = [];
  for (let i = 0; i < orderIds.length; i += 20) {
    const chunk = orderIds.slice(i, i + 20);
    const det = await post('/v3/supply-order/get', { order_ids: chunk });
    for (const o of det.orders ?? []) {
      const orderId = Number(o.order_id ?? o.supply_order_id ?? 0);
      const state = String(o.state ?? o.status ?? '');
      const date = String(o.state_updated_date ?? o.created_date ?? '').slice(0, 10);
      const warehouse =
        o.warehouse_name ??
        o.warehouse?.name ??
        o.dropoff_warehouse?.name ??
        o.supplies?.[0]?.storage_warehouse?.name ??
        '—';

      const bundleIds = new Set<string>();
      for (const s of o.supplies ?? []) {
        if (s.bundle_id) bundleIds.add(String(s.bundle_id));
      }

      // иногда состав прямо в supplies
      let gotFromBundle = false;
      for (const bid of bundleIds) {
        const b = await post('/v1/supply-order/bundle', {
          bundle_ids: [bid],
          limit: 100,
          last_id: '',
        });
        for (const item of b.items ?? []) {
          const sku = Number(item.sku);
          const qty = Number(item.quantity ?? item.quant ?? item.icon_quantity ?? 0);
          if (sku > 0 && qty > 0) {
            gotFromBundle = true;
            lines.push({
              orderId,
              state,
              date,
              warehouse,
              sku,
              offer: String(item.offer_id ?? ''),
              name: String(item.name ?? ''),
              qty,
            });
          }
        }
        await sleep(250);
      }

      if (!gotFromBundle) {
        for (const s of o.supplies ?? []) {
          for (const item of s.items ?? s.products ?? []) {
            const sku = Number(item.sku);
            const qty = Number(item.quantity ?? item.quant ?? 0);
            if (sku > 0 && qty > 0) {
              lines.push({
                orderId,
                state,
                date,
                warehouse,
                sku,
                offer: String(item.offer_id ?? ''),
                name: String(item.name ?? ''),
                qty,
              });
            }
          }
        }
      }
    }
    await sleep(300);
  }
  return lines;
}

async function fetchStocks(): Promise<Map<number, StockAgg>> {
  const bySku = new Map<number, StockAgg>();
  const ensure = (sku: number): StockAgg => {
    let a = bySku.get(sku);
    if (!a) {
      a = { free: 0, reserved: 0, promised: 0, warehouse: 0, transit: 0 };
      bySku.set(sku, a);
    }
    return a;
  };

  // 1) analytics stock_on_warehouses
  try {
    const d = await post('/v2/analytics/stock_on_warehouses', {
      limit: 1000,
      offset: 0,
      warehouse_type: 'ALL',
    });
    const sample = (d.result?.rows ?? [])[0];
    if (sample) console.log('stock_on_warehouses sample keys:', Object.keys(sample).join(', '));
    for (const r of d.result?.rows ?? []) {
      const sku = Number(r.sku);
      if (!sku) continue;
      const a = ensure(sku);
      a.free += Number(r.free_to_sell_amount ?? 0);
      a.reserved += Number(r.reserved_amount ?? 0);
      a.promised += Number(r.promised_amount ?? 0);
      a.warehouse += Number(r.warehouse_amount ?? 0);
    }
  } catch (e: any) {
    console.log('stock_on_warehouses:', e.message);
  }

  // 2) v1/product/info/warehouse/stocks — детальнее, если доступен
  try {
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const d = await post('/v1/product/info/warehouse/stocks', {
        cursor: cursor || undefined,
        limit: 100,
      });
      const items: any[] = d.products ?? d.items ?? d.result?.products ?? [];
      if (page === 0 && items[0]) {
        console.log('warehouse/stocks sample:', JSON.stringify(items[0]).slice(0, 600));
      }
      for (const p of items) {
        const sku = Number(p.sku ?? p.product_id ?? 0);
        // stocks may be nested
        const stocks: any[] = p.stocks ?? p.warehouses ?? [];
        if (!stocks.length && (p.present != null || p.reserved != null)) {
          const a = ensure(Number(p.sku) || sku);
          a.warehouse += Number(p.present ?? 0);
          a.reserved += Number(p.reserved ?? 0);
          continue;
        }
        for (const s of stocks) {
          const sSku = Number(s.sku ?? p.sku ?? 0);
          if (!sSku) continue;
          const a = ensure(sSku);
          a.warehouse += Number(s.present ?? s.stock ?? s.available ?? 0);
          a.reserved += Number(s.reserved ?? 0);
          a.transit += Number(s.transit ?? s.coming ?? s.in_transit ?? 0);
        }
      }
      cursor = d.cursor ?? d.result?.cursor ?? '';
      if (!cursor || !items.length) break;
      await sleep(150);
    }
  } catch (e: any) {
    console.log('warehouse/stocks:', e.message.slice(0, 200));
  }

  // 3) v4/product/info/stocks (legacy-ish)
  try {
    let lastId = '';
    for (let page = 0; page < 20; page++) {
      const d = await post('/v4/product/info/stocks', {
        filter: { visibility: 'ALL' },
        limit: 100,
        last_id: lastId,
      });
      const items: any[] = d.items ?? d.result?.items ?? [];
      if (page === 0 && items[0]) {
        console.log('v4 stocks sample:', JSON.stringify(items[0]).slice(0, 600));
      }
      for (const it of items) {
        const offer = String(it.offer_id ?? '');
        for (const s of it.stocks ?? []) {
          // type: fbo / fbs
          const present = Number(s.present ?? 0);
          const reserved = Number(s.reserved ?? 0);
          // sku mapping later via offer — store under product_id temporarily won't work
          // We'll merge via product meta offer→sku in main
          const key = Number(it.product_id ?? 0);
          if (!key) continue;
          // stash under negative product id? Better: attach offer in a side map
          (it as any).__offer = offer;
          const a = ensure(key); // temp by product_id — fixed below if sku present
          if (String(s.type ?? '').toLowerCase() === 'fbo' || !s.type) {
            // only bump if we don't already have free from analytics
          }
          void present;
          void reserved;
        }
      }
      lastId = d.last_id ?? d.result?.last_id ?? '';
      if (!lastId || items.length < 100) break;
    }
  } catch (e: any) {
    console.log('v4 stocks:', e.message.slice(0, 200));
  }

  return bySku;
}

/** Дополнительно: остатки v4 с маппингом offer→sku */
async function fetchFboStocksByOffer(): Promise<Map<string, { present: number; reserved: number }>> {
  const map = new Map<string, { present: number; reserved: number }>();
  let lastId = '';
  try {
    for (;;) {
      const d = await post('/v4/product/info/stocks', {
        filter: { visibility: 'ALL' },
        limit: 100,
        last_id: lastId,
      });
      for (const it of d.items ?? d.result?.items ?? []) {
        const offer = String(it.offer_id ?? '');
        if (!offer) continue;
        let present = 0;
        let reserved = 0;
        for (const s of it.stocks ?? []) {
          if (String(s.type ?? '').toLowerCase() === 'fbs') continue;
          present += Number(s.present ?? 0);
          reserved += Number(s.reserved ?? 0);
        }
        const prev = map.get(offer) ?? { present: 0, reserved: 0 };
        map.set(offer, {
          present: prev.present + present,
          reserved: prev.reserved + reserved,
        });
      }
      lastId = d.last_id ?? d.result?.last_id ?? '';
      if (!lastId || (d.items ?? []).length < 100) break;
    }
  } catch (e: any) {
    console.log('fetchFboStocksByOffer:', e.message.slice(0, 200));
  }
  return map;
}

async function main(): Promise<void> {
  console.log('→ Товары…');
  const meta = await fetchProductMeta();
  console.log(`  карточек: ${meta.size}`);

  console.log('→ Поставки…');
  const supplies = await fetchSupplies();
  console.log(`  строк поставок: ${supplies.length}`);

  console.log('→ Остатки…');
  const stocks = await fetchStocks();
  const stocksByOffer = await fetchFboStocksByOffer();

  // агрегаты по SKU
  type Agg = {
    sku: number;
    offer: string;
    name: string;
    shippedTotal: number; // все неотменённые заявки
    shippedAccepted: number; // COMPLETED / awaiting reports
    inTransitSupply: number; // заявки ещё не завершены
    free: number;
    reserved: number;
    promised: number;
    presentFbo: number;
    stockTotal: number;
  };

  const bySku = new Map<number, Agg>();
  const ensure = (sku: number, offer = '', name = ''): Agg => {
    let a = bySku.get(sku);
    if (!a) {
      const m = meta.get(sku);
      const cat = MILAI_BY_SKU.get(sku);
      a = {
        sku,
        offer: offer || m?.offerId || '',
        name: name || m?.name || cat?.hint || '',
        shippedTotal: 0,
        shippedAccepted: 0,
        inTransitSupply: 0,
        free: 0,
        reserved: 0,
        promised: 0,
        presentFbo: 0,
        stockTotal: 0,
      };
      bySku.set(sku, a);
    } else {
      if (!a.offer && offer) a.offer = offer;
      if (!a.name && name) a.name = name;
    }
    return a;
  };

  for (const p of MILAI_PRODUCTS) ensure(p.sku);
  for (const [sku] of meta) ensure(sku);

  for (const line of supplies) {
    const a = ensure(line.sku, line.offer, line.name);
    a.shippedTotal += line.qty;
    const st = line.state.toUpperCase();
    if (ACCEPTED_STATES.has(st) || st === 'COMPLETED' || st.endsWith('COMPLETED')) {
      a.shippedAccepted += line.qty;
    } else {
      a.inTransitSupply += line.qty;
    }
  }

  // stocks from analytics keyed by sku
  for (const [sku, s] of stocks) {
    // skip product_id keys that aren't real skus if they don't match meta
    if (!meta.has(sku) && !MILAI_BY_SKU.has(sku) && !bySku.has(sku)) continue;
    const a = ensure(sku);
    a.free = Math.max(a.free, s.free);
    a.reserved = Math.max(a.reserved, s.reserved);
    a.promised = Math.max(a.promised, s.promised);
  }

  // merge v4 by offer
  for (const a of bySku.values()) {
    if (!a.offer) continue;
    const s = stocksByOffer.get(a.offer);
    if (!s) continue;
    a.presentFbo = s.present;
    a.reserved = Math.max(a.reserved, s.reserved);
    if (!a.free) a.free = Math.max(0, s.present - s.reserved);
  }

  for (const a of bySku.values()) {
    // общий остаток: свободно + резерв + promised (в пути к клиенту / ожидается)
    // + поставка в пути (ещё не на складе)
    const onHand = a.free + a.reserved + a.promised;
    // если analytics пустой, берём present из v4
    const base = onHand > 0 ? onHand : a.presentFbo;
    a.stockTotal = base + a.inTransitSupply;
  }

  // только SKU с движением или остатком / из каталога
  const rows = [...bySku.values()]
    .filter((r) => r.shippedTotal > 0 || r.stockTotal > 0 || MILAI_BY_SKU.has(r.sku))
    .sort((a, b) => b.shippedTotal - a.shippedTotal || a.sku - b.sku);

  // выкуп ≈ принято на склад − (свободно+резерв+promised)
  // товары в пути поставки не вычитаем из «выкуплено», т.к. они ещё не были в остатке
  for (const r of rows) {
    // fix accepted if API returned short state names
    if (r.shippedAccepted === 0 && r.inTransitSupply === 0 && r.shippedTotal > 0) {
      // все поставки без распознанного статуса — считаем accepted (как COMPLETED-only fallback)
      r.shippedAccepted = r.shippedTotal;
    }
  }

  const outDir = join(repoRoot, 'tools/sale/milai/out');
  mkdirSync(outDir, { recursive: true });
  const date = moscowDateStr(moscowNow());
  const outPath = join(outDir, `milai-supply-vs-stock-${date}.xlsx`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'milai supply-vs-stock';

  const ws = wb.addWorksheet('Сводка');
  ws.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Артикул', key: 'offer', width: 18 },
    { header: 'Название', key: 'name', width: 42 },
    { header: 'Отгружено всего, шт', key: 'shippedTotal', width: 18 },
    { header: 'Принято на склад, шт', key: 'shippedAccepted', width: 18 },
    { header: 'Поставка в пути, шт', key: 'inTransitSupply', width: 16 },
    { header: 'Свободно к продаже, шт', key: 'free', width: 18 },
    { header: 'В резерве, шт', key: 'reserved', width: 12 },
    { header: 'Promised, шт', key: 'promised', width: 12 },
    { header: 'Остаток сейчас (склад+резерв), шт', key: 'onHand', width: 22 },
    { header: 'Остаток с учётом поставок в пути, шт', key: 'stockTotal', width: 24 },
    { header: 'Выкуплено / ушло ≈, шт', key: 'sold', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };

  let sumShip = 0;
  let sumAcc = 0;
  let sumTransit = 0;
  let sumOnHand = 0;
  let sumSold = 0;

  for (const r of rows) {
    const onHand = r.free + r.reserved + r.promised || r.presentFbo;
    const sold = Math.max(0, r.shippedAccepted - onHand);
    sumShip += r.shippedTotal;
    sumAcc += r.shippedAccepted;
    sumTransit += r.inTransitSupply;
    sumOnHand += onHand;
    sumSold += sold;
    ws.addRow({
      sku: r.sku,
      offer: r.offer,
      name: r.name,
      shippedTotal: r.shippedTotal,
      shippedAccepted: r.shippedAccepted,
      inTransitSupply: r.inTransitSupply,
      free: r.free,
      reserved: r.reserved,
      promised: r.promised,
      onHand,
      stockTotal: r.stockTotal,
      sold,
    });
  }

  const totalRow = ws.addRow({
    sku: '',
    offer: '',
    name: 'ИТОГО',
    shippedTotal: sumShip,
    shippedAccepted: sumAcc,
    inTransitSupply: sumTransit,
    free: '',
    reserved: '',
    promised: '',
    onHand: sumOnHand,
    stockTotal: sumOnHand + sumTransit,
    sold: sumSold,
  });
  totalRow.font = { bold: true };

  const det = wb.addWorksheet('Поставки');
  det.columns = [
    { header: '№ заявки', key: 'orderId', width: 12 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Статус', key: 'state', width: 36 },
    { header: 'Склад', key: 'warehouse', width: 28 },
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Артикул', key: 'offer', width: 18 },
    { header: 'Название', key: 'name', width: 42 },
    { header: 'Кол-во, шт', key: 'qty', width: 12 },
  ];
  det.getRow(1).font = { bold: true };
  for (const line of supplies.sort((a, b) => b.orderId - a.orderId || a.sku - b.sku)) {
    const m = meta.get(line.sku);
    det.addRow({
      orderId: line.orderId,
      date: line.date,
      state: line.state,
      warehouse: line.warehouse,
      sku: line.sku,
      offer: line.offer || m?.offerId || '',
      name: line.name || m?.name || MILAI_BY_SKU.get(line.sku)?.hint || '',
      qty: line.qty,
    });
  }

  const note = wb.addWorksheet('Пояснения');
  note.getColumn(1).width = 28;
  note.getColumn(2).width = 90;
  const notes: Array<[string, string]> = [
    ['Дата отчёта', date],
    ['Магазин', 'MilAi (OZON_SELLER_*_MILAI)'],
    ['Отгружено всего', 'Сумма qty по всем неотменённым заявкам на поставку (supply-order)'],
    ['Принято на склад', 'COMPLETED / REPORTS_CONFIRMATION_AWAITING — товар уже вошёл в остатки Ozon'],
    ['Поставка в пути', 'Заявки в остальных статусах (ещё не COMPLETED)'],
    ['Свободно / резерв / promised', 'Из /v2/analytics/stock_on_warehouses (+ v4 stocks)'],
    ['Остаток сейчас', 'свободно + резерв + promised (товар у Ozon, включая под заказами)'],
    ['Остаток с поставками в пути', 'остаток сейчас + поставка в пути'],
    ['Выкуплено / ушло ≈', 'принято на склад − остаток сейчас. Не учитывает возвраты продавцу и списания'],
  ];
  for (const [k, v] of notes) note.addRow([k, v]);

  await wb.xlsx.writeFile(outPath);

  console.log('\n═══ СВОДКА ═══');
  console.log(
    'SKU'.padEnd(12) +
      'Артикул'.padEnd(16) +
      'Отгр'.padStart(6) +
      'Прин'.padStart(6) +
      'Впути'.padStart(6) +
      'Ост'.padStart(6) +
      'Выкуп≈'.padStart(7) +
      '  Название',
  );
  for (const r of rows) {
    const onHand = r.free + r.reserved + r.promised || r.presentFbo;
    const sold = Math.max(0, r.shippedAccepted - onHand);
    console.log(
      String(r.sku).padEnd(12) +
        (r.offer || '—').padEnd(16) +
        String(r.shippedTotal).padStart(6) +
        String(r.shippedAccepted).padStart(6) +
        String(r.inTransitSupply).padStart(6) +
        String(onHand).padStart(6) +
        String(sold).padStart(7) +
        '  ' +
        (r.name || '').slice(0, 40),
    );
  }
  console.log(
    `\nИтого отгружено ${sumShip} · принято ${sumAcc} · в пути ${sumTransit} · остаток ${sumOnHand} · выкуп≈ ${sumSold}`,
  );
  console.log(`\nExcel: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
