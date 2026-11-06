/**
 * show-seo-trend.ts — анализ трендов позиций в поиске Ozon.
 *
 * Показывает как менялись позиции моих товаров со временем по каждой фразе.
 *
 * Запуск:
 *   npm run ozon:seo-trend                  — последние 10 снапшотов по всем фразам
 *   npm run ozon:seo-trend -- --phrase "фотоальбом"   — только одна фраза
 *   npm run ozon:seo-trend -- --n 20        — последние 20 снапшотов
 *   npm run ozon:seo-trend -- --since 2026-06-01      — с определённой даты
 */
import { MongoClient } from 'mongodb';
import { env } from './lib/env';
import type { SearchItem } from './lib/seller-search';

const args = process.argv.slice(2);
const phraseFilter = args.includes('--phrase') ? args[args.indexOf('--phrase') + 1] : null;
const nArg = args.includes('--n') ? Number(args[args.indexOf('--n') + 1]) : 10;
const sinceArg = args.includes('--since') ? new Date(args[args.indexOf('--since') + 1]) : null;

interface RankSnapshot {
  phrase: string;
  snapshotAt: Date;
  items: SearchItem[];
  totalFound: number;
}

// ─── Цвета ────────────────────────────────────────────────────────────────────
const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function fmtPos(pos: number | null): string {
  if (pos === null) return c.gray('  —  ');
  const s = `#${pos}`.padStart(4);
  if (pos <= 3) return c.green(s);
  if (pos <= 10) return c.yellow(s);
  return c.gray(s);
}

function fmtDelta(prev: number | null, curr: number | null): string {
  if (prev === null || curr === null) return '    ';
  const d = prev - curr; // положительный = поднялись
  if (d === 0) return c.gray(' =  ');
  if (d > 0) return c.green(`+${d}`.padStart(4));
  return c.red(`${d}`.padStart(4));
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ─── Анализ одной фразы ───────────────────────────────────────────────────────
function analyzePhraseSnapshots(phrase: string, snapshots: RankSnapshot[]): void {
  console.log(`\n${c.bold(c.cyan(`📊 "${phrase}"`))}  (${snapshots.length} снапшотов)`);

  if (snapshots.length === 0) {
    console.log(c.gray('  нет данных'));
    return;
  }

  // Собираем все уникальные SKU из всех снапшотов
  const allSkus = new Map<number, string>(); // sku → name
  for (const snap of snapshots) {
    for (const item of snap.items) {
      if (!allSkus.has(item.sku)) allSkus.set(item.sku, item.name);
    }
  }

  if (allSkus.size === 0) {
    console.log(c.gray('  моих товаров в выдаче не найдено'));
    return;
  }

  // Заголовок — даты
  const dateHeader = snapshots.map((s) => fmtDate(s.snapshotAt).padEnd(14)).join('  ');
  console.log(`  ${'SKU / Товар'.padEnd(40)} ${dateHeader}`);
  console.log(`  ${'-'.repeat(40)} ${'-'.repeat(snapshots.length * 16)}`);

  for (const [sku, name] of allSkus) {
    const label = (name.length > 38 ? name.slice(0, 35) + '...' : name).padEnd(40);
    const positions = snapshots.map((snap) => {
      const item = snap.items.find((i) => i.sku === sku);
      return item?.position ?? null;
    });

    const cells = positions.map((pos, i) => {
      const prev = i > 0 ? positions[i - 1] : null;
      return `${fmtPos(pos)} ${fmtDelta(prev, pos)}`;
    }).join('  ');

    console.log(`  ${c.gray(String(sku).padEnd(12))} ${label.slice(12)} ${cells}`);
  }

  // Итоговая динамика: лучший и худший результат
  const latestPositions = snapshots[snapshots.length - 1]?.items.map((i) => i.position) ?? [];
  if (latestPositions.length > 0) {
    const best = Math.min(...latestPositions);
    const firstSnap = snapshots[0]?.items;
    const firstPositions = firstSnap?.map((i) => i.position) ?? [];
    if (firstPositions.length > 0) {
      const firstBest = Math.min(...firstPositions);
      const delta = firstBest - best;
      const arrow = delta > 0 ? c.green(`▲${delta}`) : delta < 0 ? c.red(`▼${Math.abs(delta)}`) : c.gray('=');
      console.log(`  ${c.gray('Лучшая позиция:')} первый снапшот #${firstBest} → сейчас #${best} ${arrow}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const client = new MongoClient(env.mongoUrl);
  await client.connect();

  const db = client.db('ozon-seo');
  const col = db.collection<RankSnapshot>('seo_rank_snapshots');

  // Определяем какие фразы показывать
  const allPhrases: string[] = phraseFilter
    ? [phraseFilter]
    : await col.distinct('phrase');

  if (allPhrases.length === 0) {
    console.log('\n⚠️  В базе нет данных. Сначала запусти: npm run ozon:track-seo\n');
    await client.close();
    return;
  }

  const filter: Record<string, unknown> = {};
  if (sinceArg) filter['snapshotAt'] = { $gte: sinceArg };

  console.log(`\n🔍 SEO-тренды Ozon (последние ${nArg} снапшотов)`);
  if (sinceArg) console.log(`   с ${sinceArg.toLocaleDateString('ru')}`);

  for (const phrase of allPhrases) {
    const snapshots = await col
      .find({ phrase, ...filter })
      .sort({ snapshotAt: -1 })
      .limit(nArg)
      .toArray();

    snapshots.reverse(); // от старых к новым

    analyzePhraseSnapshots(phrase, snapshots);
  }

  // Итоговая статистика
  const totalSnapshots = await col.countDocuments();
  const firstDoc = await col.findOne({}, { sort: { snapshotAt: 1 } });
  const lastDoc = await col.findOne({}, { sort: { snapshotAt: -1 } });

  console.log(`\n${c.gray('─'.repeat(60))}`);
  console.log(c.gray(`База: ${totalSnapshots} снапшотов`));
  if (firstDoc && lastDoc) {
    console.log(c.gray(`Период: ${fmtDate(firstDoc.snapshotAt)} → ${fmtDate(lastDoc.snapshotAt)}`));
  }
  console.log(c.gray(`Обновить данные: npm run ozon:track-seo\n`));

  await client.close();
}

main().catch((err) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
