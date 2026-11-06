/**
 * exit-promos.ts
 * Выходит из акций, в которых товары участвуют ниже себестоимости.
 *
 * Требуемые роли API-ключа: «Акции» (запись).
 * Как добавить роли — см. README ниже.
 *
 * Запуск:
 *   npm run ozon:exit-promos               # выход из всех убыточных акций
 *   npm run ozon:exit-promos -- --dry      # только показать, без изменений
 *   npm run ozon:exit-promos -- --action 1977747   # только конкретная акция
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import fetch from 'node-fetch';
import { COST_BY_OFFER } from './lib/catalog';

dotenv.config({ path: path.join(__dirname, '../../.env.development') });

const TOKEN     = process.env.OZON_SELLER_API_KEY!;
const CLIENT_ID = process.env.OZON_SELLER_CLIENT_ID!;
const TAX_RATE  = 0.07;
const AVG_LOGISTICS = 134;
const DRY_RUN   = process.argv.includes('--dry');
const ONLY_ACTION = (() => { const i = process.argv.indexOf('--action'); return i >= 0 ? Number(process.argv[i + 1]) : null; })();

async function ozonReq<T>(p: string, body?: unknown, method = 'POST'): Promise<T> {
  const r = await fetch(`https://api-seller.ozon.ru${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Client-Id': CLIENT_ID, 'Api-Key': TOKEN },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return r.json() as Promise<T>;
}
const ozonPost = <T>(p: string, body: unknown) => ozonReq<T>(p, body, 'POST');
const ozonGet  = <T>(p: string) => ozonReq<T>(p, undefined, 'GET');

// product_id → offer_id
async function buildPidMap(): Promise<Map<number, string>> {
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

// Comissions for offer_id. sales_percent_fbo = 46 means 46%, not 4.6%.
async function fetchCommissions(): Promise<Map<string, { commPct: number }>> {
  const map = new Map<string, { commPct: number }>();
  let lastId = '';
  for (;;) {
    const d: any = await ozonPost('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 100, last_id: lastId });
    for (const it of d.items ?? []) {
      map.set(it.offer_id, {
        commPct: it.commissions?.sales_percent_fbo ?? 46,
      });
    }
    if (!d.last_id || d.items?.length < 100) break;
    lastId = d.last_id;
  }
  return map;
}

function breakeven(offer_id: string, _price: number, comm: { commPct: number }): number {
  const costPrice = COST_BY_OFFER[offer_id] ?? 0;
  const commRate  = comm.commPct / 100;
  const netRate   = 1 - commRate - TAX_RATE;
  return Math.ceil((costPrice + AVG_LOGISTICS) / netRate);
}

async function run() {
  console.log(DRY_RUN ? '🔍 DRY-RUN — изменения не отправляются\n' : '🚀 Выход из убыточных акций...\n');

  const [pidMap, commMap] = await Promise.all([buildPidMap(), fetchCommissions()]);

  // Получаем активные акции (/v1/actions — GET)
  const actionsRes: any = await ozonGet('/v1/actions');
  const allActions: any[] = actionsRes.result ?? [];
  const activeActions = allActions.filter((a: any) => a.is_participating);

  let totalExits = 0;

  for (const action of activeActions) {
    if (ONLY_ACTION && action.id !== ONLY_ACTION) continue;

    // Получаем список участвующих товаров
    let offset = 0, prods: any[] = [];
    for (;;) {
      const d: any = await ozonPost('/v1/actions/products', { action_id: action.id, limit: 100, offset });
      const rows: any[] = d.result?.products ?? [];
      prods.push(...rows);
      if (rows.length < 100) break;
      offset += 100;
    }
    if (!prods.length) continue;

    const toExit: number[] = [];
    for (const p of prods) {
      const pid = Number(p.id ?? p.product_id);
      const offer_id = pidMap.get(pid);
      if (!offer_id) continue;
      const actionPrice = Number(p.action_price ?? p.price ?? 0);
      if (!actionPrice) continue;

      const comm = commMap.get(offer_id);
      if (!comm) continue;
      const be = breakeven(offer_id, actionPrice, comm);

      if (actionPrice < be) {
        console.log(
          `📌 ${action.title.slice(0, 40)} | ${offer_id} | акц.цена ${actionPrice}₽ < безубыток ${be}₽ → убыток ${actionPrice - be}₽/шт`,
        );
        toExit.push(pid);
      }
    }

    if (!toExit.length) {
      console.log(`✅ Акция "${action.title.slice(0, 40)}" — все товары выше безубытка`);
      continue;
    }

    console.log(`🚫 Выходим из "${action.title.slice(0, 40)}": ${toExit.length} товаров`);
    if (DRY_RUN) continue;

    // Деактивируем батчами по 50
    for (let i = 0; i < toExit.length; i += 50) {
      const batch = toExit.slice(i, i + 50);
      const res: any = await ozonPost('/v1/actions/products/deactivate', {
        action_id: action.id,
        product_ids: batch,
      });
      if (res.code && res.code !== 0) {
        console.error(`  ❌ ${res.message}`);
      } else {
        console.log(`  ✅ Деактивировано ${batch.length} шт`);
        totalExits += batch.length;
      }
    }
  }

  console.log(`\nИтого выведено из акций: ${totalExits} позиций`);
}

run().catch((e) => { console.error(e.message); process.exit(1); });
