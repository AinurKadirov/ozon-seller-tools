/**
 * format.ts — форматирование чисел и текста для консоли и Telegram.
 */

/** Целое число с разделителями тысяч: 12345 → "12 345". */
export function fmt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}

/** Деньги с символом рубля: 12345 → "12 345 ₽". */
export function money(n: number): string {
  return `${fmt(n)} ₽`;
}

/** Дополнение строки до ширины w пробелами (l = слева/справа). */
export function pad(s: string, w: number, right = false): string {
  return right ? s.padStart(w) : s.padEnd(w);
}

/** Экранирование спецсимволов Telegram MarkdownV2. */
export function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/** Экранирование для Telegram HTML (&, <, >). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Текущая дата в московском часовом поясе (UTC+3). */
export function moscowNow(): Date {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}

/** YYYY-MM-DD для даты в МСК. */
export function moscowDateStr(d: Date = moscowNow()): string {
  return d.toISOString().slice(0, 10);
}
