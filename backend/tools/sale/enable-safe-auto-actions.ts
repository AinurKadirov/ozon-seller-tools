/**
 * enable-safe-auto-actions.ts — «участвовать в акциях со своей ценой».
 *
 * Включает авто-участие в акциях Ozon, но защищает прибыль полом цены:
 *   auto_action_enabled                    = ENABLED
 *   auto_add_to_ozon_actions_list_enabled  = ENABLED
 *   min_price_for_auto_actions_enabled     = true
 *   min_price                              = цена для +PROFIT ₽/шт (по умолчанию 150)
 *
 * В результате Ozon добавляет товар в акции автоматически, НО никогда не
 * опускает цену ниже min_price. В акции, где нужна цена ниже пола, тебя
 * просто не добавят — значит, участие всегда прибыльное.
 *
 * Цель прибыли можно переопределить аргументом: -- 0 → пол = безубыток.
 *
 * DRY-RUN по умолчанию. Для применения: -- --apply
 * Требует роль «Товары и цены» на API-ключе.
 */
import { priceForProfit } from './lib/economics';
import { COST_BY_OFFER } from './lib/catalog';
import { fetchAllPrices, importPrices, PriceUpdate } from './lib/ozon';
import { pad } from './lib/format';

const APPLY = process.argv.includes('--apply');
const profitArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const TARGET_PROFIT = profitArg !== undefined ? Number(profitArg) : 150;

async function main(): Promise<void> {
  console.log(APPLY
    ? `🚀 APPLY: включаем безопасные авто-акции (пол = цена +${TARGET_PROFIT} ₽/шт)...`
    : `🔍 DRY-RUN (пол = цена +${TARGET_PROFIT} ₽/шт; для применения добавьте --apply)`);
  console.log();

  const items = await fetchAllPrices();
  console.log(`Загружено ${items.length} товаров\n`);

  const updates: PriceUpdate[] = [];
  const skipped: string[] = [];
  type Row = { oid: string; curPrice: number; curMin: number; newMin: number; autoNow: boolean };
  const rows: Row[] = [];

  for (const item of items) {
    const oid = item.offer_id;
    if (COST_BY_OFFER[oid] === undefined) { skipped.push(oid); continue; }

    const curPrice = Number(item.price?.price ?? 0);
    const curMin   = Number(item.price?.min_price ?? 0);
    const oldPrice = Number(item.price?.old_price ?? curPrice);
    const autoNow  = Boolean(item.price?.auto_action_enabled && item.price?.auto_add_to_ozon_actions_list_enabled);

    // Пол = цена целевой прибыли. price не опускаем ниже пола.
    const floor = priceForProfit(oid, TARGET_PROFIT);
    const newPrice = Math.max(curPrice, floor);

    rows.push({ oid, curPrice, curMin, newMin: floor, autoNow });

    updates.push({
      offer_id: oid,
      price: String(newPrice),
      old_price: String(oldPrice || newPrice + 200),
      min_price: String(floor),
      auto_action_enabled: 'ENABLED',
      auto_add_to_ozon_actions_list_enabled: 'ENABLED',
      min_price_for_auto_actions_enabled: true,
      currency_code: 'RUB',
    });
  }

  console.log(
    pad('Артикул', 9) + pad('Цена', 8, true) + pad('ТекMin', 8, true) +
    pad('НовMin(пол)', 13, true) + pad('autoAction', 13, true));
  console.log('─'.repeat(51));
  for (const r of rows.sort((a, b) => a.oid.localeCompare(b.oid))) {
    console.log(
      pad(r.oid, 9) +
      pad(r.curPrice + '₽', 8, true) +
      pad(r.curMin + '₽', 8, true) +
      pad(r.newMin + '₽', 13, true) +
      pad(r.autoNow ? 'вкл' : 'выкл→ВКЛ', 13, true));
  }

  if (skipped.length) console.log(`\n⚠️  Пропущены (нет в catalog): ${skipped.join(', ')}`);
  console.log(`\nБудет настроено товаров: ${updates.length}`);
  console.log('Пол цены защитит прибыль: Ozon не опустит цену ниже него даже в акциях.');

  if (!APPLY) { console.log('\n▶  Запустите с флагом --apply для применения.'); return; }

  const res = await importPrices(updates);
  if (res.error) { console.error(`\n❌ Ошибка API: ${res.error}\n   Вероятно, нет роли «Товары и цены» на ключе.`); process.exit(1); }
  if (res.failed.length) {
    console.error('\n❌ Ошибки:');
    for (const f of res.failed) console.error(`   ${f.offer_id}: ${f.message}`);
  }
  console.log(`\n✅ Настроено товаров: ${res.okCount}`);
  console.log(`🎉 Готово! Ozon будет добавлять в акции только при цене ≥ пола (+${TARGET_PROFIT} ₽/шт).`);
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
