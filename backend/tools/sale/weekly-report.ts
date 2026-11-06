/**
 * weekly-report.ts — доходность по неделе.
 *
 * Тянет транзакции за последние 7 дней (не включая сегодня), считает P&L
 * по дням и шлёт ОДНУ агрегированную сводку в Telegram с разбивкой по дням.
 *
 * Запуск:
 *   npm run ozon:weekly-report           — последние 7 дней
 *   npm run ozon:weekly-report -- --dry  — только консоль, без Telegram
 */
import { computeDayPnl, DayStat } from './lib/economics';
import { fetchAllOperations } from './lib/ozon';
import { sendMarkdown } from './lib/telegram';
import { fmt, escapeMd as esc, moscowNow } from './lib/format';

const DRY = process.argv.includes('--dry');

type Totals = Omit<DayStat, 'dateStr' | 'marginPercent' | 'drrPercent' | 'opsCount'>;

function sumStats(stats: DayStat[]): Totals {
  const z: Totals = {
    revenue: 0, soldCount: 0, returnCount: 0, cancelCount: 0, returnRevenue: 0,
    commission: 0, logistics: 0, returnLogistics: 0, acquiring: 0, ads: 0,
    storage: 0, otherServices: 0, stockReturnServices: 0, costPriceTotal: 0, tax: 0,
    netProfit: 0, netProfitAfterStockReturn: 0,
  };
  return stats.reduce((a, s) => {
    (Object.keys(z) as (keyof Totals)[]).forEach((k) => { a[k] += s[k]; });
    return a;
  }, z);
}

function buildMessage(stats: DayStat[], from: string, to: string): string {
  const t = sumStats(stats);
  const avgDaily = t.netProfit / stats.length;
  const margin = t.revenue > 0 ? +((t.netProfit / t.revenue) * 100).toFixed(1) : 0;
  const drr = t.revenue > 0 && Math.abs(t.ads) > 0 ? +((-t.ads / t.revenue) * 100).toFixed(1) : 0;

  const profitLine = t.netProfit >= 0
    ? `✅ *Прибыль: ${esc(fmt(t.netProfit))} ₽*`
    : `🔴 *Убыток: ${esc(fmt(t.netProfit))} ₽*`;
  const hasStockReturnServices = Math.abs(t.stockReturnServices) > 0;

  const dayLines = stats.map((s) => {
    const icon = s.netProfit >= 0 ? '✅' : '🔴';
    const [, mm, dd] = s.dateStr.split('-');
    return `  ${dd}\\.${mm}  ${esc(fmt(s.revenue))} ₽  ${s.soldCount} шт\\.  ${icon} ${esc(fmt(s.netProfit))} ₽`;
  });

  const lines: (string | null)[] = [
    `📊 *Недельный отчёт ${esc(from)} — ${esc(to)}*`,
    '',
    `💰 Выручка: *${esc(fmt(t.revenue))} ₽* \\(${t.soldCount} шт\\.\\)`,
    t.returnCount > 0 ? `↩️ Возвраты: ${t.returnCount} шт\\. \\(${esc(fmt(t.returnRevenue))} ₽\\)` : null,
    t.cancelCount > 0 ? `🚫 Отмены/невыкупы: ${t.cancelCount} шт\\.` : null,
    '',
    `📉 *Расходы за неделю:*`,
    `  Комиссия Ozon: ${esc(fmt(t.commission))} ₽`,
    `  Логистика: ${esc(fmt(t.logistics))} ₽`,
    Math.abs(t.returnLogistics) > 0 ? `  Обратная логистика: ${esc(fmt(t.returnLogistics))} ₽` : null,
    `  Эквайринг: ${esc(fmt(t.acquiring))} ₽`,
    Math.abs(t.ads) > 0 ? `  Реклама: ${esc(fmt(t.ads))} ₽` : null,
    Math.abs(t.storage) > 0 ? `  Хранение: ${esc(fmt(t.storage))} ₽` : null,
    Math.abs(t.otherServices) > 0 ? `  Прочие услуги: ${esc(fmt(t.otherServices))} ₽` : null,
    t.costPriceTotal > 0 ? `  Себестоимость: ${esc(fmt(t.costPriceTotal))} ₽` : null,
    `  Налог УСН 7%: ${esc(fmt(t.tax))} ₽`,
    hasStockReturnServices ? '' : null,
    hasStockReturnServices ? `📦 *Разовые списания вне маржи:*` : null,
    hasStockReturnServices ? `  Вывоз/подготовка товара со склада Ozon: ${esc(fmt(t.stockReturnServices))} ₽` : null,
    '',
    profitLine,
    hasStockReturnServices ? `💸 Итого с разовыми списаниями: ${esc(fmt(t.netProfitAfterStockReturn))} ₽` : null,
    `📈 Маржа: ${esc(String(margin))}%`,
    drr > 0 ? `📣 ДРР: ${esc(String(drr))}%` : null,
    `📊 Средняя прибыль/день: ${esc(fmt(avgDaily))} ₽`,
    '',
    `*По дням \\(дата / выручка / продажи / прибыль\\):*`,
    ...dayLines,
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

async function main(): Promise<void> {
  const todayStr = moscowNow().toISOString().slice(0, 10);
  const dates: string[] = [];
  for (let i = 7; i >= 1; i--) {
    dates.push(new Date(new Date(`${todayStr}T00:00:00+03:00`).getTime() - i * 86400_000).toISOString().slice(0, 10));
  }
  const from = dates[0];
  const to = dates[dates.length - 1];

  console.log(`📅 Период: ${from} → ${to} (7 дней)${DRY ? '  (DRY — без отправки)' : ''}\n`);

  const ops = await fetchAllOperations(
    new Date(`${from}T00:00:00+03:00`),
    new Date(`${to}T23:59:59+03:00`),
  );
  console.log(`✅ Всего ${ops.length} операций\n`);

  const stats = dates.map((d) => computeDayPnl(ops, d));

  console.log('─'.repeat(64));
  console.log('  Дата        Выручка     Продано  Прибыль     Маржа');
  console.log('─'.repeat(64));
  for (const s of stats) {
    const icon = s.netProfit >= 0 ? '✅' : '🔴';
    console.log(`  ${s.dateStr}  ${fmt(s.revenue).padStart(10)} ₽  ${String(s.soldCount).padStart(5)} шт.  ${icon} ${fmt(s.netProfit).padStart(8)} ₽  ${String(s.marginPercent).padStart(5)}%`);
  }
  const t = sumStats(stats);
  console.log('─'.repeat(64));
  console.log(`  ИТОГО        ${fmt(t.revenue).padStart(10)} ₽  ${String(t.soldCount).padStart(5)} шт.  ${t.netProfit >= 0 ? '✅' : '🔴'} ${fmt(t.netProfit).padStart(8)} ₽`);
  if (Math.abs(t.stockReturnServices) > 0) {
    console.log(`  РАЗОВО       вывоз/подготовка со склада Ozon: ${fmt(t.stockReturnServices)} ₽`);
    console.log(`  ИТОГО cash   ${fmt(t.netProfitAfterStockReturn)} ₽`);
  }

  if (DRY) { console.log('\n(DRY: Telegram пропущен)\n'); return; }

  console.log('\n📬 Отправляем недельную сводку в Telegram...');
  await sendMarkdown(buildMessage(stats, from, to));
  console.log('  ✅ Отправлено!\n');
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
