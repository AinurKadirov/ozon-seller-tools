/**
 * set-prices-150.ts — установка цен для минимальной доходности.
 *
 * Для каждого товара выставляет:
 *   price     = минимальная цена для +150 ₽ прибыли/шт (цену только ПОВЫШАЕМ —
 *               если текущая уже выше цели, оставляем как есть)
 *   min_price = безубыток (прибыль = 0 ₽/шт)
 *
 * Цель прибыли можно переопределить аргументом: -- 200 → +200 ₽/шт.
 *
 * DRY-RUN по умолчанию. Для применения: -- --apply
 */
import { priceForProfit, breakEvenPrice } from './lib/economics';
import { COST_BY_OFFER, FIXED_BY_OFFER } from './lib/catalog';
import { fetchAllPrices, importPrices, PriceUpdate } from './lib/ozon';
import { pad } from './lib/format';

const APPLY = process.argv.includes('--apply');
const targetArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const TARGET_PROFIT = targetArg ? Number(targetArg) : 150;

async function main(): Promise<void> {
  console.log(APPLY
    ? `🚀 APPLY: обновляем цены на Ozon (цель +${TARGET_PROFIT} ₽/шт)...`
    : `🔍 DRY-RUN (цель +${TARGET_PROFIT} ₽/шт; для применения добавьте --apply)`);
  console.log();

  const items = await fetchAllPrices();
  console.log(`Загружено ${items.length} товаров\n`);

  const updates: PriceUpdate[] = [];
  const skipped: string[] = [];
  type Row = { oid: string; cost: number; fixed: number; curPrice: number; curMin: number; target: number; newPrice: number; newMin: number; changed: boolean };
  const rows: Row[] = [];

  for (const item of items) {
    const oid = item.offer_id;
    if (COST_BY_OFFER[oid] === undefined) { skipped.push(oid); continue; }

    const curPrice = Number(item.price?.price ?? 0);
    const curMin   = Number(item.price?.min_price ?? 0);
    const oldPrice = Number(item.price?.old_price ?? curPrice);

    const target = priceForProfit(oid, TARGET_PROFIT);
    const newMin = breakEvenPrice(oid);
    const newPrice = Math.max(curPrice, target); // цену только повышаем

    const changed = newPrice !== curPrice || newMin !== curMin;
    rows.push({ oid, cost: COST_BY_OFFER[oid], fixed: FIXED_BY_OFFER[oid], curPrice, curMin, target, newPrice, newMin, changed });

    if (changed) {
      updates.push({
        offer_id: oid,
        price: String(newPrice),
        old_price: String(oldPrice || newPrice + 200),
        min_price: String(newMin),
        currency_code: 'RUB',
      });
    }
  }

  // ── Таблица ──
  console.log(
    pad('Артикул', 9) + pad('Себест', 7, true) + pad('Фикс', 7, true) +
    pad('ТекЦена', 9, true) + pad(`Цель+${TARGET_PROFIT}`, 10, true) + pad('БудетЦена', 12, true) +
    pad('ТекMin', 8, true) + pad('НовMin', 8, true) + '  Статус');
  console.log('─'.repeat(84));
  for (const r of rows.sort((a, b) => a.oid.localeCompare(b.oid))) {
    const note = r.newPrice > r.curPrice ? '↑' : r.curPrice >= r.target ? '≥цели' : '';
    console.log(
      pad(r.oid, 9) +
      pad(r.cost + '₽', 7, true) +
      pad(r.fixed + '₽', 7, true) +
      pad(r.curPrice + '₽', 9, true) +
      pad(r.target + '₽', 10, true) +
      pad(r.newPrice + '₽' + (note ? ' ' + note : ''), 12, true) +
      pad(r.curMin + '₽', 8, true) +
      pad(r.newMin + '₽', 8, true) +
      '  ' + (r.changed ? '✅ ИЗМЕНИТЬ' : '—'));
  }

  if (skipped.length) console.log(`\n⚠️  Пропущены (нет себестоимости в catalog): ${skipped.join(', ')}`);
  console.log(`\nИзменений: ${updates.length} из ${rows.length} товаров`);

  if (updates.length === 0) { console.log('Нечего менять.'); return; }
  if (!APPLY) { console.log('\n▶  Запустите с флагом --apply для применения.'); return; }

  const res = await importPrices(updates);
  if (res.error) { console.error(`\n❌ Ошибка API: ${res.error}\n   Вероятно, нет роли «Товары и цены» на ключе.`); process.exit(1); }
  if (res.failed.length) {
    console.error('\n❌ Ошибки:');
    for (const f of res.failed) console.error(`   ${f.offer_id}: ${f.message}`);
  }
  console.log(`\n✅ Обновлено цен: ${res.okCount}`);
  console.log('🎉 Готово!');
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
