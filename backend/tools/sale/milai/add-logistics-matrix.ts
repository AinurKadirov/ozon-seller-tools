/**
 * Добавляет вкладку «Матрица логистики» — тарифы по ОБЪЁМУ (как у Ozon).
 * Лист «Юнит-экономика» не меняется. Выкуп и объём берутся с 1-й вкладки.
 *
 *   npm run ozon:milai-logistics-matrix -- tmp/milai-unit-economics-2026-07-19.xlsx
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import ExcelJS from 'exceljs';
import { moscowDateStr } from '../lib/format';

const repoRoot = join(__dirname, '../../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

interface VolTier {
  vol: number;
  min: number;
  max: number;
  lastMile: number;
  ret: number;
  skus: string[];
}

function creds(): { clientId: string; apiKey: string } {
  const clientId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const apiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (!clientId || !apiKey) throw new Error('Нет OZON_SELLER_*_MILAI');
  return { clientId, apiKey };
}

async function post(path: string, body: unknown): Promise<any> {
  const { clientId, apiKey } = creds();
  const res = await nodeFetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Api-Key': apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Собирает уникальные ступени объёма из API (min/max/обратная/миля). */
async function fetchVolumeTiers(): Promise<VolTier[]> {
  const prices = await post('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 100, last_id: '' });
  const offerIds = (prices.items ?? []).map((i: any) => i.offer_id);
  const info = await post('/v3/product/info/list', { offer_id: offerIds, product_id: [], sku: [] });

  const byVol = new Map<number, VolTier>();
  for (const it of prices.items ?? []) {
    const sku = Number((info.items ?? []).find((x: any) => x.offer_id === it.offer_id)?.sku ?? 0);
    const vol = Math.round((Number(it.volume_weight) || 0) * 10) / 10;
    if (!vol) continue;
    const c = it.commissions ?? {};
    const min = Number(c.fbo_direct_flow_trans_min_amount) || 0;
    const max = Number(c.fbo_direct_flow_trans_max_amount) || 0;
    const lastMile = Number(c.fbo_deliv_to_customer_amount) || 25;
    const ret = Number(c.fbo_return_flow_amount) || 0;

    const key = vol;
    const prev = byVol.get(key);
    if (!prev) {
      byVol.set(key, { vol, min, max, lastMile, ret, skus: [it.offer_id] });
    } else {
      // если вдруг расхождение — берём максимум (консервативно)
      prev.min = Math.max(prev.min, min);
      prev.max = Math.max(prev.max, max);
      prev.ret = Math.max(prev.ret, ret);
      prev.skus.push(it.offer_id);
    }
  }
  return [...byVol.values()].sort((a, b) => a.vol - b.vol);
}

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
}

/** Формула логистики: объём J, выкуп K (%), матрица A:F */
const FORMULA_S2 =
  '=ЕСЛИОШИБКА(((ВПР($J2;\'Матрица логистики\'!$A:$F;4;ИСТИНА)'
  + '+ВПР($J2;\'Матрица логистики\'!$A:$F;5;ИСТИНА)'
  + '+ВПР($J2;\'Матрица логистики\'!$A:$F;6;ИСТИНА)*(1-$K2/100))/($K2/100);0)';

async function main(): Promise<void> {
  const today = moscowDateStr();
  const xlsxPath = process.argv[2]
    ? join(process.cwd(), process.argv[2])
    : join(repoRoot, 'tmp', `milai-unit-economics-${today}.xlsx`);

  console.log(`\n→ Открываю ${xlsxPath}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);

  for (const name of ['Матрица логистики', 'Формула логистики']) {
    const old = wb.getWorksheet(name);
    if (old) wb.removeWorksheet(old.id);
  }

  console.log('→ Тарифы по объёму из API...');
  const tiers = await fetchVolumeTiers();

  const mx = wb.addWorksheet('Матрица логистики', { views: [{ state: 'frozen', ySplit: 1 }] });
  // A — ключ для ВПР(…;ИСТИНА): «объём до» ступени, строки по возрастанию
  mx.addRow([
    'Объём, л',        // A — ищем по объёму с 1-й вкладки (кол. J)
    'min маршрут',     // B
    'max маршрут',     // C
    'mid маршрут',     // D = (min+max)/2
    'Последняя миля',  // E
    'Обратная',        // F
    'Примеры артикулов', // G — справочно
  ]);
  styleHeader(mx.getRow(1));
  [10, 11, 11, 11, 14, 10, 36].forEach((w, i) => { mx.getColumn(i + 1).width = w; });

  for (const t of tiers) {
    const mid = Math.round(((t.min + t.max) / 2) * 10) / 10;
    mx.addRow([t.vol, t.min, t.max, mid, t.lastMile, t.ret, t.skus.join(', ')]);
  }

  // Пояснение под таблицей
  const noteRow = tiers.length + 3;
  mx.getCell(`A${noteRow}`).value = 'Как читать:';
  mx.getCell(`A${noteRow + 1}`).value =
    'ВПР(объём;ИСТИНА) находит строку с наибольшим «Объём, л» ≤ объёму товара. Строки отсортированы по возрастанию.';
  mx.getCell(`A${noteRow + 2}`).value =
    'mid = средняя география. Логистика/шт = (mid + миля + обратная×(1−выкуп)) / выкуп';

  const fm = wb.addWorksheet('Формула логистики');
  fm.getColumn(1).width = 24;
  fm.getColumn(2).width = 95;

  fm.addRows([
    ['Параметр', 'Значение'],
    ['Формула для S2 (строка 2)', FORMULA_S2],
    ['', ''],
    ['Откуда данные на листе «Юнит-экономика»', ''],
    ['J2', 'Объем товара, л (колонка J)'],
    ['K2', 'Процент выкупа (колонка K), в процентах: 58.7'],
    ['S2', 'Вставь формулу → логистика ₽/шт'],
    ['', ''],
    ['Матрица логистики', ''],
    ['Колонка A', 'Объём, л — ступени тарифов Ozon (из API MilAi)'],
    ['Колонки B–C', 'min / max маршрута FBO (средняя география = D)'],
    ['Колонка E', 'Последняя миля, обычно 25 ₽'],
    ['Колонка F', 'Обратная логистика невыкупа'],
    ['', ''],
    ['Формула', '(mid + миля + обратная×(1−выкуп%)) / выкуп%'],
    ['Выкуп', 'Берётся с 1-й вкладки, в матрицу НЕ зашит'],
  ]);
  fm.getRow(1).font = { bold: true };
  fm.getRow(2).getCell(2).font = { name: 'Courier New', size: 9 };

  await wb.xlsx.writeFile(xlsxPath);
  console.log(`✅ Матрица по объёму: ${tiers.length} ступеней`);
  console.log(`   Файл: ${xlsxPath}\n`);
  console.log('Формула для S2:');
  console.log(FORMULA_S2);
  console.log('');
}

main().catch((e: Error) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
