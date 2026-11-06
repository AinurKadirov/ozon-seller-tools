/**
 * seller-search.ts — клиент приватного seller.ozon.ru API для SEO-трекинга.
 *
 * Использует браузерные куки (сессия), а не API-ключ.
 * Куки периодически протухают — нужно обновлять OZON_SELLER_COOKIES в .env.development.
 *
 * Как обновить куки:
 *   1. Открыть DevTools → Application → Cookies → seller.ozon.ru
 *   2. Скопировать значение заголовка Cookie из любого XHR-запроса
 *   3. Вставить в .env.development: OZON_SELLER_COOKIES=...
 */
import { env } from './env';
import { activeShop } from './shop-config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const BASE = 'https://seller.ozon.ru';

export interface SearchItem {
  sku: number;
  name: string;
  position: number;
  price: number;
  rating?: number;
  reviewCount?: number;
  offerId?: string;
  imageUrl?: string;
  isMine: boolean;
}

export interface SearchResult {
  phrase: string;
  items: SearchItem[];
  total: number;
  rawResponse?: unknown;
}

function buildHeaders(): Record<string, string> {
  const companyId = activeShop.clientId;
  return {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'ru',
    'content-type': 'application/json',
    'x-o3-app-name': 'seller-ui',
    'x-o3-company-id': companyId,
    'x-o3-language': 'ru',
    'origin': 'https://seller.ozon.ru',
    'referer': 'https://seller.ozon.ru/app/analytics-search/search-results/explainer',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'cookie': env.ozonSellerCookies,
  };
}

/** Нормализует элемент выдачи из разных возможных форматов ответа API. */
function parseItem(raw: any, index: number): SearchItem {
  const sku = Number(raw.sku ?? raw.skuId ?? raw.productId ?? raw.product_id ?? 0);
  const position = Number(raw.position ?? raw.rank ?? (index + 1));
  const price = Number(raw.price ?? raw.finalPrice ?? raw.currentPrice ?? 0);
  const name: string = raw.name ?? raw.title ?? raw.productName ?? '';
  const rating = raw.rating != null ? Number(raw.rating) : undefined;
  const reviewCount = raw.reviewCount ?? raw.reviews_count ?? raw.reviewsCount;
  const offerId: string | undefined = raw.offerId ?? raw.offer_id ?? raw.articleNumber ?? undefined;
  const imageUrl: string | undefined = raw.imageUrl ?? raw.image ?? raw.primaryImage ?? undefined;

  return { sku, name, position, price, rating, reviewCount, offerId, imageUrl, isMine: true };
}

/**
 * Парсит одну страницу поиска.
 * onlyCurSellerItems=true → возвращает только наши товары.
 */
export async function fetchSearchPositions(
  phrase: string,
  page = 1,
  itemsPerPage = 36,
): Promise<SearchResult> {
  const body = {
    sellerId: activeShop.clientId,
    query: phrase,
    skus: [],
    uuid: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5',
    explainId: '11111111',
    sortOption: { headerKey: 'position', direction: 'SortDirectionAscending' },
    itemsPerPage: String(itemsPerPage),
    pageNumber: String(page),
    onlyCurSellerItems: true,
    applicationScope: 'SCOPE_BIG_OZON',
    parentRequestId: '520d6f54-f591-446e-8fec-e24868253e83',
  };

  const res = await nodeFetch(
    `${BASE}/api/search-query-analytics/v2/external/explanation_by_id`,
    { method: 'POST', headers: buildHeaders(), body: JSON.stringify(body) },
  );

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} для фразы "${phrase}"`);
  }

  const raw: any = await res.json();

  // API может вернуть ошибку в теле
  if (raw.error || raw.code) {
    throw new Error(`API вернул ошибку: ${JSON.stringify(raw.error ?? raw.message ?? raw)}`);
  }

  // Пробуем разные возможные форматы ответа
  const itemsRaw: any[] =
    raw.items ??
    raw.data?.items ??
    raw.result?.items ??
    raw.products ??
    raw.data?.products ??
    [];

  const total: number =
    raw.total ?? raw.data?.total ?? raw.result?.total ?? raw.totalCount ?? itemsRaw.length;

  const items = itemsRaw.map((r, i) => parseItem(r, i));

  return { phrase, items, total, rawResponse: raw };
}

/**
 * Собирает позиции по всем страницам (до 5 страниц), пока есть результаты.
 * Нужно если наши товары раскиданы по разным страницам выдачи.
 */
export async function fetchAllSearchPositions(phrase: string): Promise<SearchResult> {
  const first = await fetchSearchPositions(phrase, 1);

  if (first.items.length === 0) {
    return first;
  }

  // Если есть ещё страницы — собираем до 5 страниц
  const allItems = [...first.items];
  const maxPages = Math.min(5, Math.ceil(first.total / 36));

  for (let page = 2; page <= maxPages; page++) {
    await new Promise((r) => setTimeout(r, 500));
    const next = await fetchSearchPositions(phrase, page);
    if (next.items.length === 0) break;
    allItems.push(...next.items);
  }

  return { ...first, items: allItems, total: allItems.length };
}
