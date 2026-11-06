/**
 * download-realization-reports.ts — скачивание отчётов о реализации Ozon.
 *
 * API:
 *   POST /v2/finance/realization       — помесячный отчёт по SKU
 *   POST /v1/finance/realization/posting — детализация по отправлениям
 *
 * Запуск:
 *   npm run ozon:download-realization              — прошлый календарный месяц
 *   npm run ozon:download-realization -- 2026-06   — конкретный месяц
 *   npm run ozon:download-realization -- 2026-04 2026-05 2026-06
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ozonPost } from './lib/ozon';
import { logActiveShop } from './lib/shop-config';

const monthArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function prevCalendarMonth(): { year: number; month: number } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function parseMonthArg(arg: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(arg.trim());
  if (!m) throw new Error(`Неверный формат месяца: ${arg} (ожидается YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Неверный месяц: ${arg}`);
  return { year, month };
}

function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function downloadMonth(year: number, month: number, outDir: string): Promise<void> {
  const label = monthLabel(year, month);
  console.log(`\n📥 ${label}...`);

  const [bySku, byPosting] = await Promise.all([
    ozonPost<any>('/v2/finance/realization', { year, month }),
    ozonPost<any>('/v1/finance/realization/posting', { year, month }),
  ]);

  const skuPath = join(outDir, `realization-v2-${label}.json`);
  const postingPath = join(outDir, `realization-posting-${label}.json`);

  writeFileSync(skuPath, JSON.stringify(bySku, null, 2), 'utf8');
  writeFileSync(postingPath, JSON.stringify(byPosting, null, 2), 'utf8');

  const skuRows = bySku.result?.rows?.length ?? 0;
  const postingRows = byPosting.rows?.length ?? byPosting.result?.rows?.length ?? 0;
  const header = bySku.result?.header;

  console.log(`   ✅ v2 SKU: ${skuRows} строк → ${skuPath}`);
  console.log(`   ✅ posting: ${postingRows} строк → ${postingPath}`);
  if (header) {
    console.log(
      `   📄 акт ${header.number} · ${header.start_date} → ${header.stop_date} · ${header.receiver_name}`,
    );
  }
}

async function main(): Promise<void> {
  logActiveShop();
  const months = monthArgs.length
    ? monthArgs.map(parseMonthArg)
    : [prevCalendarMonth()];

  const outDir = join(__dirname, '../../tmp/realization-reports/lumos');
  mkdirSync(outDir, { recursive: true });

  console.log(`🏪 Lumos — отчёты по реализации → ${outDir}`);

  for (const { year, month } of months) {
    await downloadMonth(year, month, outDir);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log('\nГотово.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
