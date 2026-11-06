/**
 * track-seo-positions.ts — трекинг позиций моих товаров в поиске Ozon.
 *
 * Что делает:
 *   1. Перебирает список ключевых фраз
 *   2. Для каждой фразы парсит приватный seller API (выдача только моих товаров)
 *   3. Сохраняет снапшот позиций в MongoDB (коллекция seo_rank_snapshots)
 *   4. Выводит краткую сводку в консоль
 *
 * Запуск:
 *   npm run ozon:track-seo          — разовый снапшот
 *   npm run ozon:track-seo -- --raw — + показать сырой ответ API первой фразы
 *
 * ВАЖНО: Куки протухают. При ошибке 401/403 — обнови OZON_SELLER_COOKIES в .env.development:
 *   1. Открой DevTools → Network в seller.ozon.ru
 *   2. Найди любой XHR-запрос к seller.ozon.ru/api/...
 *   3. Скопируй заголовок Cookie → вставь в OZON_SELLER_COOKIES
 */
import { MongoClient, Collection } from 'mongodb';
import { fetchAllSearchPositions, SearchItem } from './lib/seller-search';
import { env } from './lib/env';

const SHOW_RAW = process.argv.includes('--raw');

// ─── Ключевые фразы для трекинга ─────────────────────────────────────────────
const PHRASES: string[] = [
  'фотоальбом',
  'альбом для фотографий',
  'фотоальбом 10х15',
  'альбом для фотографий 10х15',
  'рамка для фото 15х21',
  'рамка для фото 10х15',
  'фотоальбом магнитный',
];

// ─── Схема MongoDB ────────────────────────────────────────────────────────────
interface RankSnapshot {
  phrase: string;
  snapshotAt: Date;
  items: SearchItem[];
  totalFound: number;
}

async function getCollection(client: MongoClient): Promise<Collection<RankSnapshot>> {
  const db = client.db('ozon-seo');
  const col = db.collection<RankSnapshot>('seo_rank_snapshots');
  // Индексы для быстрой выборки трендов
  await col.createIndex({ phrase: 1, snapshotAt: -1 });
  await col.createIndex({ snapshotAt: -1 });
  return col;
}

// ─── Форматирование ───────────────────────────────────────────────────────────
function fmtPosition(pos: number): string {
  if (pos <= 3) return `\x1b[32m#${pos}\x1b[0m`;   // зелёный — топ-3
  if (pos <= 10) return `\x1b[33m#${pos}\x1b[0m`;  // жёлтый — топ-10
  return `\x1b[90m#${pos}\x1b[0m`;                  // серый — ниже
}

function fmtPhrase(phrase: string): string {
  return `\x1b[1m"${phrase}"\x1b[0m`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const client = new MongoClient(env.mongoUrl);
  await client.connect();
  const col = await getCollection(client);

  const snapshotAt = new Date();
  console.log(`\n📸 SEO-снапшот: ${snapshotAt.toLocaleString('ru')} (${PHRASES.length} фраз)\n`);

  let totalSaved = 0;
  let totalErrors = 0;

  for (const phrase of PHRASES) {
    process.stdout.write(`  → ${fmtPhrase(phrase)} … `);

    try {
      const result = await fetchAllSearchPositions(phrase);

      if (SHOW_RAW && PHRASES.indexOf(phrase) === 0) {
        console.log('\n\n[RAW API response for first phrase]:');
        console.log(JSON.stringify(result.rawResponse, null, 2).slice(0, 2000));
        console.log('\n');
      }

      if (result.items.length === 0) {
        console.log(`\x1b[33mне найдено моих товаров\x1b[0m`);
      } else {
        const positions = result.items.map((i) => fmtPosition(i.position)).join(', ');
        console.log(`${result.items.length} товаров: ${positions}`);
        for (const item of result.items) {
          const name = item.name.length > 55 ? item.name.slice(0, 52) + '...' : item.name;
          const price = item.price ? ` | ${item.price} ₽` : '';
          const sku = item.sku ? ` [${item.sku}]` : '';
          console.log(`     ${fmtPosition(item.position).padEnd(12)} ${name}${price}${sku}`);
        }
      }

      await col.insertOne({
        phrase,
        snapshotAt,
        items: result.items,
        totalFound: result.items.length,
      });
      totalSaved++;

    } catch (err: any) {
      console.log(`\x1b[31mОШИБКА: ${err.message}\x1b[0m`);
      totalErrors++;
    }

    // Пауза между запросами, чтобы не триггерить rate limit
    await new Promise((r) => setTimeout(r, 800));
  }

  await client.close();

  console.log(`\n✅ Готово: ${totalSaved} фраз сохранено, ${totalErrors} ошибок`);
  console.log(`   Данные в MongoDB: ozon-seo.seo_rank_snapshots`);
  console.log(`   Посмотреть тренд: npm run ozon:seo-trend\n`);
}

main().catch((err) => {
  console.error('\n❌', err.message);
  if (err.message.includes('OZON_SELLER_COOKIES')) {
    console.error('\n💡 Обнови куки в .env.development:');
    console.error('   OZON_SELLER_COOKIES="..."');
    console.error('   (скопируй заголовок Cookie из DevTools seller.ozon.ru)\n');
  }
  process.exit(1);
});
