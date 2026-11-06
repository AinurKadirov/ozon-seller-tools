/**
 * run-daily-report.ts — доходность по дню.
 *
 * Тянет транзакции из Ozon API, считает P&L по каждой указанной дате и шлёт
 * по одному сообщению в Telegram на каждый день.
 *
 * Запуск:
 *   npm run ozon:daily-report                  — вчера и сегодня
 *   npm run ozon:daily-report -- 2026-06-03    — конкретный день
 *   npm run ozon:daily-report -- 2026-06-01 2026-06-02
 *   npm run ozon:daily-report -- --dry         — только консоль, без Telegram
 */
import { computeDayPnl, computeProductPnl, DayStat, ProductStat } from './lib/economics';
import { fetchAllOperations } from './lib/ozon';
import { sendMarkdown } from './lib/telegram';
import { fmt, escapeMd as esc, moscowNow } from './lib/format';
import { logActiveShop } from './lib/shop-config';

const DRY = process.argv.includes('--dry');
const dateArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// Число со знаком: 850 → "+850", -360 → "-360".
const signed = (n: number): string => (n >= 0 ? '+' : '') + fmt(n);

// ─── Таблица «прибыль по товарам» (моноширинный блок для Telegram/консоли) ─────
const COL = { name: 16, sold: 5, ret: 6, unit: 7, total: 8 } as const;

function productTableLines(products: ProductStat[]): string[] {
  const header =
    'Товар'.padEnd(COL.name) +
    'прод'.padStart(COL.sold) +
    'возвр'.padStart(COL.ret) +
    '₽/шт'.padStart(COL.unit) +
    'всего'.padStart(COL.total);

  const rows = products.map((p) => {
    const name = `${p.offerId} ${p.name}`.slice(0, COL.name - 1);
    const ret = p.returnCount > 0 ? String(p.returnCount) : '-';
    const line =
      name.padEnd(COL.name) +
      String(p.soldCount).padStart(COL.sold) +
      ret.padStart(COL.ret) +
      signed(p.profitPerUnit).padStart(COL.unit) +
      signed(p.totalProfit).padStart(COL.total);
    return p.totalProfit < 0 ? `${line} 🔴` : line;
  });

  return [header, ...rows];
}

/** Блок таблицы для Telegram (внутри ``` — экранирование не нужно). */
function buildProductBlock(products: ProductStat[]): string | null {
  if (products.length === 0) return null;
  return '📦 *По товарам:*\n```\n' + productTableLines(products).join('\n') + '\n```';
}

// ─── Telegram-сообщение за один день ──────────────────────────────────────────
function buildMessage(s: DayStat, products: ProductStat[], prev?: DayStat): string {
  const delta = prev
    ? ` \\(${esc((s.netProfit >= prev.netProfit ? '+' : '') + fmt(s.netProfit - prev.netProfit))} ₽\\)`
    : '';
  const profitLine = s.netProfit >= 0
    ? `✅ *Прибыль: ${esc(fmt(s.netProfit))} ₽*${delta}`
    : `🔴 *Убыток: ${esc(fmt(s.netProfit))} ₽*${delta}`;
  const hasStockReturnServices = Math.abs(s.stockReturnServices) > 0;
  const stockReturnTotalLine = hasStockReturnServices
    ? `💸 Итого с разовыми списаниями: ${esc(fmt(s.netProfitAfterStockReturn))} ₽`
    : null;

  const lines: (string | null)[] = [
    `📊 *Сводка за ${esc(s.dateStr)}*`,
    '',
    `💰 Выручка: *${esc(fmt(s.revenue))} ₽* \\(${s.soldCount} шт\\.\\)`,
    s.returnCount > 0 ? `↩️ Возвраты: ${s.returnCount} шт\\. \\(${esc(fmt(s.returnRevenue))} ₽\\)` : null,
    s.cancelCount > 0 ? `🚫 Отмены/невыкупы: ${s.cancelCount} шт\\.` : null,
    '',
    `📉 *Расходы:*`,
    `  Комиссия Ozon: ${esc(fmt(s.commission))} ₽`,
    `  Логистика: ${esc(fmt(s.logistics))} ₽`,
    Math.abs(s.returnLogistics) > 0 ? `  Обратная логистика: ${esc(fmt(s.returnLogistics))} ₽` : null,
    `  Эквайринг: ${esc(fmt(s.acquiring))} ₽`,
    Math.abs(s.ads) > 0 ? `  Реклама: ${esc(fmt(s.ads))} ₽` : null,
    Math.abs(s.storage) > 0 ? `  Хранение: ${esc(fmt(s.storage))} ₽` : null,
    Math.abs(s.otherServices) > 0 ? `  Прочие услуги: ${esc(fmt(s.otherServices))} ₽` : null,
    s.costPriceTotal > 0 ? `  Себестоимость: ${esc(fmt(s.costPriceTotal))} ₽` : null,
    `  Налог УСН 7%: ${esc(fmt(s.tax))} ₽`,
    hasStockReturnServices ? '' : null,
    hasStockReturnServices ? `📦 *Разовые списания вне дневной маржи:*` : null,
    hasStockReturnServices ? `  Вывоз/подготовка товара со склада Ozon: ${esc(fmt(s.stockReturnServices))} ₽` : null,
    '',
    profitLine,
    stockReturnTotalLine,
    `📈 Маржа: ${esc(String(s.marginPercent))}%`,
    s.drrPercent > 0 ? `📣 ДРР: ${esc(String(s.drrPercent))}%` : null,
  ];
  const body = lines.filter((l): l is string => l !== null).join('\n');
  const block = buildProductBlock(products);
  return block ? `${body}\n\n${block}` : body;
}

function printStat(s: DayStat, products: ProductStat[]): void {
  const icon = s.netProfit >= 0 ? '✅' : '🔴';
  console.log(`\n📅 ${s.dateStr}  (${s.opsCount} операций)`);
  console.log(`   Выручка: ${fmt(s.revenue)} ₽ (${s.soldCount} шт.)`);
  console.log(`   Комиссия ${fmt(s.commission)} · Логистика ${fmt(s.logistics)} · Реклама ${fmt(s.ads)} · Налог ${fmt(-s.tax)}`);
  console.log(`   ${icon} Прибыль: ${fmt(s.netProfit)} ₽  ·  Маржа ${s.marginPercent}%  ·  ДРР ${s.drrPercent}%`);
  if (Math.abs(s.stockReturnServices) > 0) {
    console.log(`   📦 Разово вывоз/подготовка со склада Ozon: ${fmt(s.stockReturnServices)} ₽`);
    console.log(`   💸 Итого с разовыми списаниями: ${fmt(s.netProfitAfterStockReturn)} ₽`);
  }
  if (products.length > 0) {
    console.log('   📦 По товарам:');
    for (const line of productTableLines(products)) console.log(`     ${line}`);
  }
}

async function main(): Promise<void> {
  const now = moscowNow();
  const dates = dateArgs.length > 0
    ? dateArgs
    : [
        new Date(now.getTime() - 86400_000).toISOString().slice(0, 10), // вчера
        now.toISOString().slice(0, 10),                                  // сегодня
      ];

  logActiveShop();
  console.log(`🕐 Москва: ${now.toISOString().slice(0, 16).replace('T', ' ')}`);
  console.log(`📅 Даты: ${dates.join(', ')}${DRY ? '  (DRY — без отправки)' : ''}\n`);

  const dateFrom = new Date(`${dates[0]}T00:00:00+03:00`);
  const dateTo   = new Date(`${dates[dates.length - 1]}T23:59:59+03:00`);

  const ops = await fetchAllOperations(dateFrom, dateTo);
  console.log(`✅ Всего ${ops.length} операций`);

  const stats = dates.map((d) => computeDayPnl(ops, d));
  const products = dates.map((d) => computeProductPnl(ops, d));
  stats.forEach((s, i) => printStat(s, products[i]));

  if (DRY) { console.log('\n(DRY: Telegram пропущен)\n'); return; }

  console.log('\n📬 Отправляем в Telegram...');
  for (let i = 0; i < stats.length; i++) {
    await sendMarkdown(buildMessage(stats[i], products[i], i > 0 ? stats[i - 1] : undefined));
    console.log(`  ✅ ${stats[i].dateStr} отправлено`);
  }
  console.log('\n🎉 Готово!\n');
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
