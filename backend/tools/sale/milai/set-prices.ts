/**
 * set-prices.ts — выставить цены MILAI: безубыток с запасом ДРР + % сверху.
 *
 *   price     = ceil(безубыток × (1 + topup%))
 *   min_price = безубыток
 *
 * Безубыток считается с surcharge = ДРР (по умолчанию 10% от цены).
 *
 *   npm run ozon:milai-set-prices                 — dry-run
 *   npm run ozon:milai-set-prices -- --apply      — применить
 *   npm run ozon:milai-set-prices -- --drr=10 --topup=5 --apply
 */
import { fetchProductRates, importPrices, type PriceUpdate } from './ozon';
import { MILAI_BY_SKU, MILAI_PRODUCTS } from './catalog';
import { computePricing, DEFAULT_ACQUIRING_RATE } from './economics';
import { fmt } from '../lib/format';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const drrArg = args.find((a) => a.startsWith('--drr='));
const topupArg = args.find((a) => a.startsWith('--topup='));
const DRR_RATE = drrArg ? Number(drrArg.split('=')[1]) / 100 : 0.10;
const TOPUP_RATE = topupArg ? Number(topupArg.split('=')[1]) / 100 : 0.05;

async function main(): Promise<void> {
  console.log(
    APPLY
      ? `🚀 APPLY MILAI: цена = МИН×${(1 + TOPUP_RATE).toFixed(2)} (ДРР ${(DRR_RATE * 100).toFixed(0)}% в модели)`
      : `🔍 DRY-RUN MILAI: цена = МИН×${(1 + TOPUP_RATE).toFixed(2)} (ДРР ${(DRR_RATE * 100).toFixed(0)}% в модели; добавь --apply)`,
  );
  console.log();

  const rates = await fetchProductRates();
  const bySku = new Map(rates.map((r) => [r.sku, r]));

  const updates: PriceUpdate[] = [];
  const head =
    'Товар'.padEnd(26) + 'SKU'.padEnd(12) + 'факт'.padStart(7) + 'МИН'.padStart(7) +
    'новая'.padStart(7) + 'Δ'.padStart(7) + '  min_price';
  console.log(head);
  console.log('─'.repeat(head.length));

  for (const prod of MILAI_PRODUCTS) {
    const r = bySku.get(prod.sku);
    if (!r) {
      console.log(`${(prod.hint ?? '').padEnd(26)}${String(prod.sku).padEnd(12)} НЕТ В API`);
      continue;
    }
    const acquiringRate = r.currentPrice > 0 ? r.acquiring / r.currentPrice : DEFAULT_ACQUIRING_RATE;
    const pricing = computePricing({
      cost: prod.cost,
      buyout: prod.buyout,
      commissionRate: r.commissionFboRate,
      forwardLogistics: r.fboForward,
      returnLogistics: r.fboReturn,
      acquiringRate,
      surchargeRate: DRR_RATE,
    });

    const newMin = pricing.breakEven;
    const newPrice = Math.ceil(newMin * (1 + TOPUP_RATE));
    const oldPrice = Math.max(r.currentPrice, newPrice + 200);
    const delta = newPrice - r.currentPrice;
    const name = (prod.hint ?? r.offerId).slice(0, 25);

    console.log(
      name.padEnd(26) +
      String(prod.sku).padEnd(12) +
      String(fmt(r.currentPrice)).padStart(7) +
      String(fmt(newMin)).padStart(7) +
      String(fmt(newPrice)).padStart(7) +
      `${delta >= 0 ? '+' : ''}${fmt(delta)}`.padStart(7) +
      `  ${fmt(newMin)}`,
    );

    updates.push({
      offer_id: r.offerId,
      price: String(newPrice),
      old_price: String(oldPrice),
      min_price: String(newMin),
      currency_code: 'RUB',
    });
  }

  console.log('─'.repeat(head.length));
  console.log(`\nК обновлению: ${updates.length} позиций`);
  console.log('МИН = безубыток с заложенным ДРР; новая цена = МИН + topup%; min_price = МИН.');

  if (!APPLY) {
    console.log('\n▶  Запусти с --apply для записи на Ozon.');
    return;
  }

  const res = await importPrices(updates);
  if (res.error) {
    console.error(`\n❌ Ошибка API: ${res.error}`);
    process.exit(1);
  }
  if (res.failed.length) {
    console.error('\n❌ Ошибки по позициям:');
    for (const f of res.failed) console.error(`   ${f.offer_id}: ${f.message}`);
  }
  console.log(`\n✅ Обновлено: ${res.okCount}`);
}

main().catch((e: Error) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
