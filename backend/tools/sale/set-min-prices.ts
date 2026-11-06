/**
 * set-min-prices.ts
 * Вычисляет min_price = безубыток+100₽ для каждого артикула и обновляет через
 * POST /v1/product/import/prices.
 *
 * Требуемые роли API-ключа: «Товары и цены» (запись).
 * Если ключ получил нужные роли, запускать: npm run ozon:set-min-prices
 *
 * Логика:
 *   netRate   = 1 - commissionRate - acquiringRate - taxRate (УСН 7%)
 *   breakeven = (costPrice + maxLogistics) / netRate
 *   min_price = ceil(breakeven + 100)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import fetch from 'node-fetch';
import { COST_BY_OFFER } from './lib/catalog';

dotenv.config({ path: path.join(__dirname, '../../.env.development') });

const TOKEN     = process.env.OZON_SELLER_API_KEY!;
const CLIENT_ID = process.env.OZON_SELLER_CLIENT_ID!;
const TAX_RATE  = 0.07; // УСН 7%
const AVG_LOGISTICS = 134;
const DRY_RUN   = process.argv.includes('--dry'); // показать без отправки

// ─── Ozon API ─────────────────────────────────────────────────────────────────
async function ozonPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Id': CLIENT_ID, 'Api-Key': TOKEN },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<T>;
}

interface PriceItem {
  offer_id: string; product_id: number;
  price: { price: string; old_price: string; min_price: string; auto_action_enabled: boolean; auto_add_to_ozon_actions_list_enabled: boolean; };
  acquiring: number;
  commissions: {
    sales_percent_fbo: number;
    fbo_direct_flow_trans_max_amount: number;
    fbo_direct_flow_trans_min_amount: number;
  };
}

async function fetchAllPrices(): Promise<PriceItem[]> {
  const all: PriceItem[] = [];
  let lastId = '';
  for (;;) {
    const d: any = await ozonPost('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 100, last_id: lastId });
    if (!d.items?.length) break;
    all.push(...d.items);
    if (!d.last_id || d.items.length < 100) break;
    lastId = d.last_id;
  }
  return all;
}

// ─── Расчёт min_price ─────────────────────────────────────────────────────────
// commRate  = sales_percent_fbo / 100 (например 46/100 = 0.46)
// acquiring включён в commRate (по данным реальных транзакций — отдельно не списывается)
// avgLogistics = эмпирическое среднее ₽/шт из транзакций
function calcMinPrice(
  commissionPct: number,   // процент, e.g. 46 (= 46%)
  avgLogistics: number,    // в рублях, среднее по реальным транзакциям
  costPrice: number,
  targetProfit = 100,
): number {
  const commRate = commissionPct / 100;
  const netRate  = 1 - commRate - TAX_RATE;
  return Math.ceil((costPrice + avgLogistics + targetProfit) / netRate);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log(DRY_RUN ? '🔍 DRY-RUN (цены не будут обновлены)' : '🚀 Обновление min_price на Ozon...');

  const items = await fetchAllPrices();
  console.log(`Загружено ${items.length} товаров\n`);

  type PriceUpdate = { offer_id: string; price: string; old_price: string; min_price: string; currency_code: string; };
  const updates: PriceUpdate[] = [];
  const rows: Array<{ offer_id: string; currentPrice: number; currentMin: number; newMin: number; costPrice: number; }> = [];

  for (const item of items) {
    const offer_id = item.offer_id;
    const currentPrice = Number(item.price?.price ?? 0);
    const currentMin   = Number(item.price?.min_price ?? 0);
    const oldPrice     = Number(item.price?.old_price ?? 10000);

    const costPrice = COST_BY_OFFER[offer_id] ?? null;
    if (costPrice === null) {
      console.warn(`⚠️  Нет себестоимости для ${offer_id}, пропускаем`);
      continue;
    }

    // sales_percent_fbo = 46 → 46% (из реальных транзакций подтверждено: комиссия = 46% от цены)
    // acquiring включён в commPct (по данным транзакций отдельно = 0)
    const commPct = item.commissions?.sales_percent_fbo ?? 46;

    const newMin = calcMinPrice(commPct, AVG_LOGISTICS, costPrice);

    // Если min_price > текущей цены — Ozon отклонит; ставим cap на currentPrice
    const safeNewMin = Math.min(newMin, currentPrice);

    rows.push({ offer_id, currentPrice, currentMin, newMin: safeNewMin, costPrice });

    // Формируем апдейт только если новый min_price ОТЛИЧАЕТСЯ от текущего
    if (safeNewMin !== currentMin) {
      updates.push({
        offer_id,
        price:     String(currentPrice),
        old_price: String(oldPrice),
        min_price: String(safeNewMin),
        currency_code: 'RUB',
      });
    }
  }

  // Вывод таблицы
  const P = (s: string, n: number, r = false) => r ? s.padStart(n) : s.padEnd(n);
  console.log(P('Артикул', 10) + P('Цена', 7, true) + P('Тек.min', 9, true) + P('Нов.min', 9, true) + P('Себест', 8, true) + '  Изм?');
  console.log('-'.repeat(50));
  for (const r of rows.sort((a, b) => a.offer_id.localeCompare(b.offer_id))) {
    const changed = r.newMin !== r.currentMin ? '✅ ОБНОВИТЬ' : '—';
    console.log(
      P(r.offer_id, 10) +
      P(r.currentPrice + '₽', 7, true) +
      P(r.currentMin + '₽', 9, true) +
      P(r.newMin + '₽', 9, true) +
      P(r.costPrice + '₽', 8, true) +
      '  ' + changed,
    );
  }

  console.log(`\nОбновлений: ${updates.length}`);
  if (updates.length === 0) { console.log('Нечего менять.'); return; }
  if (DRY_RUN) { console.log('(dry-run: отправка пропущена)'); return; }

  // Отправляем батчами по 50
  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50);
    const res: any = await ozonPost('/v1/product/import/prices', { prices: batch });
    if (res.code && res.code !== 0) {
      console.error('❌ Ошибка:', res.message);
    } else {
      const failed = res.result?.filter((r: any) => r.errors?.length) ?? [];
      if (failed.length) {
        console.error('❌ Ошибки при обновлении:', JSON.stringify(failed).slice(0, 500));
      } else {
        console.log(`✅ Батч ${Math.floor(i / 50) + 1}: ${batch.length} цен обновлено`);
      }
    }
  }
}

run().catch((e) => { console.error(e.message); process.exit(1); });
