/**
 * performance.ts — клиент Ozon Performance API (реклама).
 *
 * Реклама живёт на отдельном домене api-performance.ozon.ru со своей
 * OAuth-авторизацией (client_credentials). Креды — OZON_PERFORMANCE_CLIENT_ID /
 * OZON_PERFORMANCE_CLIENT_SECRET (для активного магазина — с суффиксом _MAIN/_TEST).
 */
import { env } from './env';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://api-performance.ozon.ru';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Парсит число в русском формате Performance API: "1 104,70" → 1104.7. */
export function parseRu(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const n = parseFloat(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export interface Campaign {
  id: string;
  title: string;
  state: string;        // CAMPAIGN_STATE_RUNNING | INACTIVE | ARCHIVED | ...
  advObjectType: string; // SKU | BANNER | SEARCH_PROMO
  dailyBudget: string;
  paymentType: string;   // CPC | CPO | CPM
}

export interface SkuAdStat {
  sku: string;
  title: string;
  views: number;
  clicks: number;
  spent: number;       // расход на рекламу, ₽
  orders: number;      // заказы (прямая атрибуция)
  ordersMoney: number; // выручка с прямых заказов
  modelsMoney: number; // выручка по модельной атрибуции
  gmv: number;         // общий product_gmv товара
  toCart: number;      // добавления в корзину (реклама)
}

let cachedToken: string | null = null;

export async function getPerfToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await nodeFetch(`${BASE}/api/client/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.ozonPerfClientId,
      client_secret: env.ozonPerfClientSecret,
      grant_type: 'client_credentials',
    }),
  });
  const d = (await res.json()) as { access_token?: string; error?: string };
  if (!d.access_token) throw new Error(`Performance token: ${d.error ?? JSON.stringify(d)}`);
  cachedToken = d.access_token;
  return cachedToken;
}

export async function fetchCampaigns(token: string): Promise<Campaign[]> {
  const res = await nodeFetch(`${BASE}/api/client/campaign?page=1&pageSize=500`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = (await res.json()) as { list?: any[] };
  return (d.list ?? []).map((c) => ({
    id: String(c.id),
    title: c.title ?? '',
    state: c.state ?? '',
    advObjectType: c.advObjectType ?? '',
    dailyBudget: String(c.dailyBudget ?? '0'),
    paymentType: c.PaymentType ?? c.paymentType ?? '',
  }));
}

/** SKU, привязанные к кампании (даже без показов). */
export async function fetchCampaignProducts(
  token: string,
  campaignId: string,
): Promise<Array<{ sku: string; bid: number; title: string }>> {
  const res = await nodeFetch(`${BASE}/api/client/campaign/${campaignId}/v2/products`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) return [];
  const d = (await res.json()) as { products?: any[] };
  return (d.products ?? []).map((p) => ({
    sku: String(p.sku),
    bid: parseRu(p.bid),
    title: p.title ?? '',
  }));
}

/**
 * Статистика по SKU за период (агрегировано по всем переданным кампаниям).
 * Performance API: POST statistics/json → UUID → опрос job → GET report.
 * Лимит — 10 кампаний на запрос, поэтому бьём батчами.
 */
export async function fetchSkuStats(
  token: string,
  campaignIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, SkuAdStat>> {
  const bySku = new Map<string, SkuAdStat>();

  for (let i = 0; i < campaignIds.length; i += 10) {
    const batch = campaignIds.slice(i, i + 10).map(Number);
    const byCampaign = await resolveReportByCampaign(token, batch, dateFrom, dateTo);
    for (const rows of byCampaign.values()) {
      for (const row of rows) accumulateSkuRow(bySku, row);
    }
  }
  return bySku;
}

/**
 * Статистика по SKU в разрезе кампаний: campaignId → (sku → stat).
 * Один батч-запрос на ≤10 РК (как fetchSkuStats), без потери расхода по каждой РК.
 */
export async function fetchSkuStatsPerCampaign(
  token: string,
  campaignIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, Map<string, SkuAdStat>>> {
  const out = new Map<string, Map<string, SkuAdStat>>();
  for (const id of campaignIds) out.set(id, new Map());

  for (let i = 0; i < campaignIds.length; i += 10) {
    const batch = campaignIds.slice(i, i + 10).map(Number);
    const byCampaign = await resolveReportByCampaign(token, batch, dateFrom, dateTo);
    for (const [cid, rows] of byCampaign) {
      const skuMap = out.get(cid) ?? new Map();
      if (!out.has(cid)) out.set(cid, skuMap);
      for (const row of rows) accumulateSkuRow(skuMap, row);
    }
  }
  return out;
}

function accumulateSkuRow(bySku: Map<string, SkuAdStat>, row: any): void {
  const sku = String(row.sku ?? '');
  if (!sku) return;
  let s = bySku.get(sku);
  if (!s) {
    s = { sku, title: row.title ?? '', views: 0, clicks: 0, spent: 0, orders: 0, ordersMoney: 0, modelsMoney: 0, gmv: 0, toCart: 0 };
    bySku.set(sku, s);
  }
  if (!s.title && row.title) s.title = row.title;
  s.views += parseRu(row.views);
  s.clicks += parseRu(row.clicks);
  s.spent += parseRu(row.moneySpent);
  s.orders += parseRu(row.orders);
  s.ordersMoney += parseRu(row.ordersMoney);
  s.modelsMoney += parseRu(row.modelsMoney);
  s.gmv += parseRu(row.product_gmv);
  s.toCart += parseRu(row.toCart ?? row.addToCart ?? row.carts);
}

async function resolveReportByCampaign(
  token: string,
  campaigns: number[],
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, any[]>> {
  const post = await nodeFetch(`${BASE}/api/client/statistics/json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaigns, dateFrom, dateTo, groupBy: 'NO_GROUP_BY' }),
  });
  const pd = (await post.json().catch(() => null)) as { UUID?: string; uuid?: string } | null;
  const uuid = pd?.UUID ?? pd?.uuid;
  if (!uuid) return new Map();

  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(2500);
    const jr = await nodeFetch(`${BASE}/api/client/statistics/${uuid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const job = (await jr.json().catch(() => null)) as { state?: string } | null;
    if (job?.state === 'OK') break;
    if (job?.state === 'ERROR' || job?.state === 'FAILED') return new Map();
  }

  const rep = await nodeFetch(`${BASE}/api/client/statistics/report?UUID=${uuid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (rep.status !== 200) return new Map();
  const body = (await rep.json().catch(() => null)) as Record<string, any> | null;
  if (!body) return new Map();

  const byCampaign = new Map<string, any[]>();
  for (const [key, value] of Object.entries(body)) {
    if (!value || typeof value !== 'object') continue;
    const block = value as { report?: { rows?: any[] } };
    if (Array.isArray(block.report?.rows)) byCampaign.set(String(key), block.report!.rows!);
  }
  return byCampaign;
}
