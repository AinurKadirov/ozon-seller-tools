/**
 * ozon.ts — единый клиент Ozon Seller API.
 *
 * Все сетевые запросы к Ozon идут через этот модуль.
 */
import { env } from './env';
import { activeShop } from './shop-config';
import type { OzonOperation } from './economics';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://api-seller.ozon.ru';

/** Временная подмена кредов (например магазин MilAi). */
let credsOverride: { clientId: string; apiKey: string } | null = null;
export function setOzonCredsOverride(creds: { clientId: string; apiKey: string } | null): void {
  credsOverride = creds;
}

async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await nodeFetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Client-Id': credsOverride?.clientId ?? env.ozonClientId,
      'Api-Key': credsOverride?.apiKey ?? env.ozonApiKey,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res.json() as Promise<T>;
}

export const ozonPost = <T>(path: string, body: unknown): Promise<T> => request<T>(path, body, 'POST');
export const ozonGet  = <T>(path: string): Promise<T> => request<T>(path, undefined, 'GET');

// ─── Цены товаров ─────────────────────────────────────────────────────────────
export interface PriceItem {
  offer_id: string;
  product_id?: number;
  price: {
    price: string;
    old_price: string;
    min_price: string;
    auto_action_enabled: boolean;
    auto_add_to_ozon_actions_list_enabled: boolean;
  };
  commissions?: { sales_percent_fbo?: number };
}

export async function fetchAllPrices(): Promise<PriceItem[]> {
  const all: PriceItem[] = [];
  let lastId = '';
  for (;;) {
    const d: any = await ozonPost('/v5/product/info/prices', {
      filter: { visibility: 'ALL' }, limit: 100, last_id: lastId,
    });
    if (!d.items?.length) break;
    all.push(...d.items);
    if (!d.last_id || d.items.length < 100) break;
    lastId = d.last_id;
  }
  return all;
}

/** Карта product_id → offer_id (нужна для разбора участников акций). */
export async function buildPidMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let lastId = '';
  for (;;) {
    const d: any = await ozonPost('/v3/product/list', { filter: { visibility: 'ALL' }, limit: 200, last_id: lastId });
    for (const p of d.result?.items ?? []) map.set(Number(p.product_id), p.offer_id);
    if (!d.result?.last_id || d.result.items.length < 200) break;
    lastId = d.result.last_id;
  }
  return map;
}

export interface PriceUpdate {
  offer_id: string;
  price: string;
  old_price: string;
  min_price: string;
  currency_code: 'RUB';
  auto_action_enabled?: 'ENABLED' | 'DISABLED';
  auto_add_to_ozon_actions_list_enabled?: 'ENABLED' | 'DISABLED';
  /** Если true — Ozon не опускает цену ниже min_price при авто-акциях. */
  min_price_for_auto_actions_enabled?: boolean;
}

export interface ImportResult {
  okCount: number;
  failed: Array<{ offer_id: string; message: string }>;
  error?: string;
}

/** Отправляет обновления цен батчами по 50. Возвращает агрегированный результат. */
export async function importPrices(updates: PriceUpdate[]): Promise<ImportResult> {
  const result: ImportResult = { okCount: 0, failed: [] };
  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50);
    const res: any = await ozonPost('/v1/product/import/prices', { prices: batch });

    if (res.code && res.code !== 0) {
      result.error = res.message ?? 'неизвестная ошибка API';
      return result;
    }
    for (const r of res.result ?? []) {
      if (r.errors?.length) {
        result.failed.push({ offer_id: r.offer_id, message: r.errors.map((e: any) => e.message).join(', ') });
      } else {
        result.okCount++;
      }
    }
  }
  return result;
}

// ─── Акции ──────────────────────────────────────────────────────────────────
export interface OzonAction { id: number; title: string; }

export async function fetchActions(): Promise<OzonAction[]> {
  const res: any = await ozonGet('/v1/actions');
  return res.result ?? [];
}

export async function fetchActionProducts(actionId: number): Promise<any[]> {
  const prods: any[] = [];
  let offset = 0;
  for (;;) {
    const d: any = await ozonPost('/v1/actions/products', { action_id: actionId, limit: 100, offset });
    const rows: any[] = d.result?.products ?? [];
    prods.push(...rows);
    if (rows.length < 100) break;
    offset += 100;
  }
  return prods;
}

/**
 * Кандидаты на участие в акции — товары, которые ещё НЕ добавлены.
 * action_price = 0, add_mode = "NOT_SET" → можно присоединиться.
 * max_action_price — максимальная цена, при которой Ozon пустит в акцию.
 */
export async function fetchActionCandidates(actionId: number): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  for (;;) {
    const d: any = await ozonPost('/v1/actions/candidates', { action_id: actionId, limit: 100, offset });
    const rows: any[] = d.result?.products ?? [];
    all.push(...rows.filter((p: any) => !p.action_price || p.add_mode === 'NOT_SET'));
    if (rows.length < 100) break;
    offset += 100;
  }
  return all;
}

/** Добавляет товары в акцию с указанной акционной ценой. */
export async function activateActionProducts(
  actionId: number,
  products: Array<{ product_id: number; action_price: number }>,
): Promise<{ activated: number[]; rejected: any[] }> {
  const res: any = await ozonPost('/v1/actions/products/activate', {
    action_id: actionId,
    products,
  }).catch(() => null);
  return {
    activated: res?.result?.product_ids ?? [],
    rejected:  res?.result?.rejected  ?? [],
  };
}

/** Выводит товары из акции. true = успех (есть роль «Акции» и API принял). */
export async function deactivateActionProducts(actionId: number, productIds: number[]): Promise<boolean> {
  const res: any = await ozonPost('/v1/actions/products/deactivate', {
    action_id: actionId, product_ids: productIds,
  }).catch(() => null);
  return Boolean(res && (!res.code || res.code === 0));
}

// ─── Кластеры, склады, аналитика (для планирования поставок) ──────────────────
export interface ClusterInfo {
  id: number;
  name: string;
  /** Имена всех складов кластера (любого типа) — для маппинга остатков. */
  warehouseNames: string[];
}

export async function fetchClusters(): Promise<ClusterInfo[]> {
  const d: any = await ozonPost('/v1/cluster/list', { cluster_type: 'CLUSTER_TYPE_OZON' });
  return (d.clusters ?? []).map((c: any) => {
    const warehouseNames: string[] = [];
    for (const lc of c.logistic_clusters ?? []) {
      for (const w of lc.warehouses ?? []) warehouseNames.push(w.name);
    }
    return { id: c.id, name: c.name ?? String(c.id), warehouseNames };
  });
}

export interface WarehouseStockRow {
  offerId: string;
  sku: number;
  warehouseName: string;
  free: number;
}

export async function fetchStockOnWarehouses(): Promise<WarehouseStockRow[]> {
  const d: any = await ozonPost('/v2/analytics/stock_on_warehouses', {
    limit: 1000, offset: 0, warehouse_type: 'ALL',
  });
  return (d.result?.rows ?? []).map((r: any) => ({
    offerId: r.item_code,
    sku: Number(r.sku),
    warehouseName: r.warehouse_name,
    free: Number(r.free_to_sell_amount ?? 0),
  }));
}

/** Заказано единиц по каждому SKU за период. Возвращает Map<sku, units>. */
export async function fetchOrderedUnitsBySku(dateFrom: string, dateTo: string): Promise<Map<number, number>> {
  const d: any = await ozonPost('/v1/analytics/data', {
    date_from: dateFrom, date_to: dateTo,
    metrics: ['ordered_units'], dimension: ['sku'], limit: 1000, offset: 0,
  });
  const map = new Map<number, number>();
  for (const row of d.result?.data ?? []) {
    const sku = Number(row.dimensions[0].id);
    map.set(sku, (map.get(sku) ?? 0) + (row.metrics[0] ?? 0));
  }
  return map;
}

// ─── Заказы (postings) FBO ────────────────────────────────────────────────────
export interface PostingProduct {
  sku: number;
  offerId: string;
  qty: number;
  price: number;            // цена за единицу после скидок (то, что платит покупатель)
  oldPrice: number;
  commissionPercent: number; // из financial_data (0, если ещё не рассчитана)
}

export interface Posting {
  postingNumber: string;
  status: string;
  createdAt: string;        // ISO, UTC
  clusterFrom: string;
  clusterTo: string;
  city: string;
  warehouse: string;
  products: PostingProduct[];
}

/** Тянет FBO-заказы за период (фильтр по дате создания заказа). */
export async function fetchPostingsFbo(dateFrom: Date, dateTo: Date): Promise<Posting[]> {
  const all: Posting[] = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const d: any = await ozonPost('/v2/posting/fbo/list', {
      dir: 'DESC',
      filter: { since: dateFrom.toISOString(), to: dateTo.toISOString() },
      limit,
      offset,
      with: { analytics_data: true, financial_data: true },
    });
    const rows: any[] = d.result ?? [];
    for (const p of rows) {
      const fin = p.financial_data ?? {};
      const finBySku = new Map<number, any>();
      for (const fp of fin.products ?? []) finBySku.set(Number(fp.product_id), fp);
      all.push({
        postingNumber: p.posting_number,
        status: p.status,
        createdAt: p.created_at,
        clusterFrom: fin.cluster_from ?? '',
        clusterTo: fin.cluster_to ?? '',
        city: p.analytics_data?.city ?? '',
        warehouse: p.analytics_data?.warehouse_name ?? '',
        products: (p.products ?? []).map((pr: any) => {
          const fp = finBySku.get(Number(pr.sku));
          return {
            sku: Number(pr.sku),
            offerId: pr.offer_id,
            qty: Number(pr.quantity ?? 1),
            price: Number(fp?.price ?? pr.price ?? 0),
            oldPrice: Number(fp?.old_price ?? 0),
            commissionPercent: Number(fp?.commission_percent ?? 0),
          };
        }),
      });
    }
    if (rows.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

// ─── Финансовые транзакции ────────────────────────────────────────────────────
export async function fetchAllOperations(dateFrom: Date, dateTo: Date): Promise<OzonOperation[]> {
  const all: OzonOperation[] = [];
  let page = 1;
  for (;;) {
    const d: any = await ozonPost('/v3/finance/transaction/list', {
      filter: { date: { from: dateFrom.toISOString(), to: dateTo.toISOString() }, transaction_type: 'all' },
      language: 'DEFAULT',
      page,
      page_size: 1000,
    });
    const { operations, page_count } = d.result;
    all.push(...operations);
    process.stdout.write(`  Загружено стр. ${page}/${page_count} (${all.length} операций)\r`);
    if (page >= page_count || operations.length === 0) break;
    page++;
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stdout.write('\n');
  return all;
}
