/**
 * Поднять цену продавца, чтобы прибыль/шт не просела из‑за роста комиссии Ozon.
 *
 * I_new = ceil(I_old × net(L_old) / net(L_new))
 * net(L) = 1 − комиссия − эквайринг 1.5% − налог 7%  (как в юнитке, база = цена продавца)
 *
 * Старая ставка: Lumos 47%, Milai 49%, РП 47%. Новая — из карточки API.
 * Флаги автоакций оставляем DISABLED.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/offset-commission-prices.ts
 *   npx ts-node ... tools/sale/offset-commission-prices.ts --apply
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import ExcelJS from 'exceljs';
import {
  fetchAllPrices,
  importPrices,
  setOzonCredsOverride,
  type PriceItem,
  type PriceUpdate,
} from './lib/ozon';
import { pad } from './lib/format';

const repoRoot = join(__dirname, '../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

const APPLY = process.argv.includes('--apply');
const XLSX = '/Users/kadirovajnur/Desktop/unit-economics-wb-ozon.xlsx';
const ACQ = 0.015;
const TAX = 0.07;

type Shop = { name: 'Lumos' | 'Milai'; clientId: string; apiKey: string };

function oldCommPct(shop: Shop['name'], offerId: string): number {
  if (shop === 'Lumos') return 47;
  if (offerId === 'РП') return 47;
  return 49;
}

function net(commPct: number): number {
  return 1 - commPct / 100 - ACQ - TAX;
}

function shops(): Shop[] {
  const lumosId = process.env.OZON_SELLER_CLIENT_ID?.trim();
  const lumosKey = process.env.OZON_SELLER_API_KEY?.trim();
  const milaiId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const milaiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (!lumosId || !lumosKey || !milaiId || !milaiKey) throw new Error('Нет Ozon-кредов');
  return [
    { name: 'Lumos', clientId: lumosId, apiKey: lumosKey },
    { name: 'Milai', clientId: milaiId, apiKey: milaiKey },
  ];
}

interface PlanRow {
  shop: Shop['name'];
  offerId: string;
  oldPrice: number;
  newPrice: number;
  oldPriceStrike: number;
  newOldPrice: number;
  minPrice: number;
  newMin: number;
  lOld: number;
  lNew: number;
  factor: number;
}

function planItem(shop: Shop['name'], item: PriceItem): PlanRow | null {
  const offerId = item.offer_id;
  const lNew = Number(item.commissions?.sales_percent_fbo ?? 0);
  const lOld = oldCommPct(shop, offerId);
  if (!lNew || lNew <= lOld) return null;

  const nOld = net(lOld);
  const nNew = net(lNew);
  if (nOld <= 0 || nNew <= 0) return null;

  const cur = Math.round(Number(item.price?.price ?? 0));
  if (!cur) return null;
  const factor = nOld / nNew;
  const newPrice = Math.ceil(cur * factor);
  if (newPrice <= cur) return null;

  const strike = Number(item.price?.old_price ?? 0);
  const minPrice = Number(item.price?.min_price ?? 0);
  const newOldPrice = Math.max(Math.ceil((strike || cur) * factor), newPrice + 200);
  const newMin = minPrice > 0 ? Math.max(minPrice, Math.ceil(minPrice * factor)) : minPrice;

  return {
    shop,
    offerId,
    oldPrice: cur,
    newPrice,
    oldPriceStrike: strike,
    newOldPrice,
    minPrice,
    newMin,
    lOld,
    lNew,
    factor,
  };
}

async function patchXlsx(rows: PlanRow[]): Promise<void> {
  const byOffer = new Map(rows.map((r) => [`${r.shop}::${r.offerId}`, r.newPrice]));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const oz = wb.getWorksheet('Юнит-экономика ОЗОН');
  if (!oz) return;
  let n = 0;
  for (let r = 2; r <= oz.rowCount; r++) {
    const store = String(oz.getCell(r, 1).value ?? '');
    const offer = String(oz.getCell(r, 4).value ?? '');
    const price = byOffer.get(`${store}::${offer}`);
    if (price == null) continue;
    oz.getCell(r, 9).value = price;
    n++;
  }
  try {
    await wb.xlsx.writeFile(XLSX);
    console.log(`Таблица: обновлена цена продавца у ${n} строк → ${XLSX}`);
  } catch (e: any) {
    console.warn(`Таблица не перезаписалась (${e.message}) — цены на Ozon уже выставлены.`);
  }
}

async function main(): Promise<void> {
  console.log(APPLY ? 'APPLY: поднимаем цены Ozon под новую комиссию' : 'DRY-RUN: расчёт без записи');
  console.log('Формула: цена × (1−Lстарая−1.5%−7%) / (1−Lновая−1.5%−7%)\n');

  const all: PlanRow[] = [];
  const updatesByShop: Array<{ shop: Shop; updates: PriceUpdate[]; rows: PlanRow[] }> = [];

  for (const shop of shops()) {
    setOzonCredsOverride({ clientId: shop.clientId, apiKey: shop.apiKey });
    const items = await fetchAllPrices();
    const rows: PlanRow[] = [];
    const updates: PriceUpdate[] = [];
    for (const it of items) {
      const row = planItem(shop.name, it);
      if (!row) continue;
      rows.push(row);
      updates.push({
        offer_id: row.offerId,
        price: String(row.newPrice),
        old_price: String(row.newOldPrice),
        min_price: String(row.newMin || 0),
        auto_action_enabled: 'DISABLED',
        auto_add_to_ozon_actions_list_enabled: 'DISABLED',
        min_price_for_auto_actions_enabled: false,
        currency_code: 'RUB',
      });
    }
    updatesByShop.push({ shop, updates, rows });
    all.push(...rows);
  }
  setOzonCredsOverride(null);

  console.log(
    pad('Маг.', 6) + pad('Артикул', 32) + pad('Было', 8, true) + pad('Станет', 8, true) +
    pad('Δ', 7, true) + pad('L', 12, true) + pad('×', 7, true),
  );
  console.log('─'.repeat(88));
  for (const r of all.sort((a, b) => a.shop.localeCompare(b.shop) || a.offerId.localeCompare(b.offerId, 'ru'))) {
    console.log(
      pad(r.shop, 6) +
      pad(r.offerId, 32) +
      pad(r.oldPrice + '₽', 8, true) +
      pad(r.newPrice + '₽', 8, true) +
      pad('+' + (r.newPrice - r.oldPrice) + '₽', 7, true) +
      pad(`${r.lOld}→${r.lNew}%`, 12, true) +
      pad(r.factor.toFixed(3), 7, true),
    );
  }
  console.log(`\nК повышению: ${all.length} SKU`);

  if (!APPLY) {
    console.log('\nДля записи на Ozon: добавьте --apply');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const block of updatesByShop) {
    if (!block.updates.length) continue;
    setOzonCredsOverride({ clientId: block.shop.clientId, apiKey: block.shop.apiKey });
    const res = await importPrices(block.updates);
    if (res.error) {
      console.error(`\n${block.shop}: ошибка API ${res.error}`);
      failed += block.updates.length;
      continue;
    }
    if (res.failed.length) {
      for (const f of res.failed) console.error(`   ${block.shop} ${f.offer_id}: ${f.message}`);
      failed += res.failed.length;
    }
    ok += res.okCount;
    console.log(`${block.shop.name}: обновлено ${res.okCount}`);
  }
  setOzonCredsOverride(null);

  if (ok) await patchXlsx(all);
  console.log(`\nИтого записано ${ok}, ошибок ${failed}`);
  if (failed) process.exit(1);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
