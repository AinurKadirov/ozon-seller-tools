/**
 * realized-prices.ts — реальная цена выкупа vs ценник в карточке.
 *
 * Для каждого SKU сводит:
 *   - ценник в кабинете (price / marketing_seller_price) и min_price;
 *   - фактическое среднее начисление за продажу (accruals_for_sale) из транзакций
 *     — это реальная цена выкупа после акций/рассрочки/баллов;
 *   - безубыток по финмодели;
 *   - разрыв ценник → выкуп (сколько съедают акции) и выкуп vs безубыток.
 *
 * Только консоль. Окно по умолчанию — 14 дней.
 *
 * Запуск:
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/realized-prices.ts [дней]
 */
import { fetchAllOperations, fetchAllPrices, PriceItem } from './lib/ozon';
import { breakEvenPrice } from './lib/economics';
import { OFFER_BY_SKU, NAME_BY_OFFER } from './lib/catalog';
import { fmt, moscowNow } from './lib/format';
import { logActiveShop, activeShop } from './lib/shop-config';

const DAYS = Number(process.argv[2] ?? 14);

interface Agg { sold: number; sumAccrual: number; }

async function main(): Promise<void> {
  logActiveShop();
  console.log(`🏪 ${activeShop.name} (client_id ${activeShop.clientId})`);

  const todayStr = moscowNow().toISOString().slice(0, 10);
  const from = new Date(new Date(`${todayStr}T00:00:00+03:00`).getTime() - DAYS * 86400_000).toISOString().slice(0, 10);
  const to = new Date(new Date(`${todayStr}T00:00:00+03:00`).getTime() - 1 * 86400_000).toISOString().slice(0, 10);
  console.log(`📅 Выкупы за ${from} → ${to} (${DAYS} дн.)\n`);

  const [ops, prices] = await Promise.all([
    fetchAllOperations(new Date(`${from}T00:00:00+03:00`), new Date(`${to}T23:59:59+03:00`)),
    fetchAllPrices(),
  ]);

  const priceByOffer = new Map<string, PriceItem>();
  for (const p of prices) priceByOffer.set(p.offer_id, p);

  // Среднее начисление за продажу по offerId.
  const agg = new Map<string, Agg>();
  for (const op of ops) {
    if (op.type !== 'orders' || op.accruals_for_sale <= 0) continue;
    const sku = op.items[0]?.sku;
    if (sku === undefined) continue;
    const offer = OFFER_BY_SKU[sku] ?? String(sku);
    let a = agg.get(offer);
    if (!a) { a = { sold: 0, sumAccrual: 0 }; agg.set(offer, a); }
    a.sold++;
    a.sumAccrual += op.accruals_for_sale;
  }

  const rows = [...agg.entries()]
    .map(([offer, a]) => {
      const pi = priceByOffer.get(offer);
      const card = pi ? Number((pi.price as any).price ?? 0) : 0;
      const cardMkt = pi ? Number((pi.price as any).marketing_seller_price ?? card) : card;
      const minPrice = pi ? Number((pi.price as any).min_price ?? 0) : 0;
      const realized = a.sumAccrual / a.sold;
      const be = breakEvenPrice(offer);
      return {
        offer,
        name: (NAME_BY_OFFER[offer] ?? offer).slice(0, 26),
        sold: a.sold,
        card: cardMkt || card,
        minPrice,
        realized,
        be,
        gapCard: (cardMkt || card) > 0 ? realized - (cardMkt || card) : 0,
        gapBE: be > 0 ? realized - be : 0,
      };
    })
    .sort((x, y) => y.sold - x.sold);

  const H = `  ${'Товар'.padEnd(27)}${'шт'.padStart(4)}${'ценник'.padStart(8)}${'min'.padStart(7)}${'выкуп'.padStart(8)}${'безуб.'.padStart(8)}${'акции'.padStart(8)}${'vs безуб'.padStart(9)}`;
  console.log(H);
  console.log('  ' + '─'.repeat(76));
  for (const r of rows) {
    const flag = r.gapBE < 0 ? ' 🔴' : '';
    console.log(
      `  ${r.name.padEnd(27)}${String(r.sold).padStart(4)}${fmt(r.card).padStart(8)}${fmt(r.minPrice).padStart(7)}` +
      `${fmt(r.realized).padStart(8)}${fmt(r.be).padStart(8)}` +
      `${(r.gapCard <= 0 ? '' : '+') + fmt(r.gapCard)}`.padStart(8) +
      `${(r.gapBE >= 0 ? '+' : '') + fmt(r.gapBE)}`.padStart(9) + flag,
    );
  }
  console.log('  ' + '─'.repeat(76));
  console.log(`\n  Колонки: «выкуп» = среднее начисление Ozon за продажу (реальная цена после акций/рассрочки).`);
  console.log(`           «акции» = выкуп − ценник (сколько съедает скидка). «vs безуб» = выкуп − безубыток.`);
  console.log(`           🔴 = реальная цена выкупа ниже безубытка → продаёшь в минус.\n`);
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
