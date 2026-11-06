/**
 * ozon.ts — клиент Ozon Seller API для магазина MILAI.
 *
 * Использует ОТДЕЛЬНЫЕ токены OZON_SELLER_*_MILAI, чтобы не задевать основной
 * магазин (у него своя конфигурация в lib/shop-config.ts). Тащит из карточек всё,
 * что нужно для «технического» расчёта без продаж: комиссии и тарифы логистики.
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const repoRoot = join(__dirname, '../../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://api-seller.ozon.ru';

function creds(): { clientId: string; apiKey: string } {
  const clientId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const apiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (!clientId || !apiKey) {
    throw new Error('Нужны OZON_SELLER_CLIENT_ID_MILAI и OZON_SELLER_API_KEY_MILAI в .env.development');
  }
  return { clientId, apiKey };
}

async function post<T = any>(path: string, body: unknown): Promise<T> {
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
  if (!res.ok) throw new Error(`Ozon ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Тарифы логистики FBO/FBS и комиссии из карточки товара (всё посчитал Ozon). */
export interface ProductRates {
  offerId: string;
  productId: number;
  sku: number;
  currentPrice: number;      // текущая цена карточки, ₽
  currentMinPrice: number;   // текущий min_price в карточке, ₽
  acquiring: number;         // эквайринг, ₽ за единицу (≈1% от цены)

  commissionFboRate: number; // доля, напр. 0.48
  commissionFbsRate: number; // доля, напр. 0.53

  // FBO
  fboForward: number;        // прямая логистика + последняя миля, ₽
  fboReturn: number;         // возвратная логистика (невыкуп), ₽
  // FBS
  fbsForward: number;        // первая миля + прямая логистика + последняя миля, ₽
  fbsReturn: number;         // возвратная логистика (невыкуп), ₽
}

/** Тащит все товары MILAI с комиссиями, тарифами логистики и маппингом на SKU. */
export async function fetchProductRates(): Promise<ProductRates[]> {
  // 1) Цены + комиссии + тарифы логистики
  const priceItems: any[] = [];
  let lastId = '';
  for (;;) {
    const d = await post('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 100, last_id: lastId });
    const items: any[] = d.items ?? [];
    priceItems.push(...items);
    if (!d.last_id || items.length < 100) break;
    lastId = d.last_id;
  }

  // 2) Маппинг offer_id → sku
  const offerIds = priceItems.map((i) => i.offer_id).filter(Boolean);
  const skuByOffer = new Map<string, number>();
  if (offerIds.length) {
    const info = await post('/v3/product/info/list', { offer_id: offerIds, product_id: [], sku: [] });
    const infoItems: any[] = info.items ?? info.result?.items ?? [];
    for (const it of infoItems) {
      const sku = Number(it.sku ?? it.sources?.find((s: any) => s.sku)?.sku ?? 0);
      if (it.offer_id && sku) skuByOffer.set(it.offer_id, sku);
    }
  }

  return priceItems.map((it) => {
    const c = it.commissions ?? {};
    // Прямая логистика зависит от объёма: API отдаёт диапазон min…max по кластерам.
    // Берём середину (ближе к реальному значению калькулятора Ozon, чем min).
    const mid = (a: unknown, b: unknown): number => (num(a) + num(b)) / 2;
    const fboDirect = mid(c.fbo_direct_flow_trans_min_amount, c.fbo_direct_flow_trans_max_amount);
    const fbsDirect = mid(c.fbs_direct_flow_trans_min_amount, c.fbs_direct_flow_trans_max_amount);
    const fbsFirstMile = mid(c.fbs_first_mile_min_amount, c.fbs_first_mile_max_amount);
    const fboForward = fboDirect + num(c.fbo_deliv_to_customer_amount);
    const fbsForward = fbsFirstMile + fbsDirect + num(c.fbs_deliv_to_customer_amount);
    return {
      offerId: it.offer_id,
      productId: Number(it.product_id ?? 0),
      sku: skuByOffer.get(it.offer_id) ?? 0,
      currentPrice: num(it.price?.price),
      currentMinPrice: num(it.price?.min_price),
      acquiring: num(it.acquiring),
      commissionFboRate: num(c.sales_percent_fbo) / 100,
      commissionFbsRate: num(c.sales_percent_fbs) / 100,
      fboForward,
      fboReturn: num(c.fbo_return_flow_amount),
      fbsForward,
      fbsReturn: num(c.fbs_return_flow_amount),
    };
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── Обновление цен (опционально, для будущего set-min-prices) ────────────────
export interface PriceUpdate {
  offer_id: string;
  price: string;
  old_price: string;
  min_price: string;
  currency_code: 'RUB';
}

export async function importPrices(updates: PriceUpdate[]): Promise<{ okCount: number; failed: Array<{ offer_id: string; message: string }>; error?: string }> {
  const result = { okCount: 0, failed: [] as Array<{ offer_id: string; message: string }> };
  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50);
    const res: any = await post('/v1/product/import/prices', { prices: batch });
    if (res.code && res.code !== 0) return { ...result, error: res.message ?? 'ошибка API' };
    for (const r of res.result ?? []) {
      if (r.errors?.length) result.failed.push({ offer_id: r.offer_id, message: r.errors.map((e: any) => e.message).join(', ') });
      else result.okCount++;
    }
  }
  return result;
}
