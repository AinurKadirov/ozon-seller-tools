/**
 * Импорт себестоимости из Excel-файла (лист «Себестоимость»).
 * Ожидаемые колонки: Артикул продавца | SKU | Себестоимость | Год | Месяц (опционально)
 *
 * Запуск:
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/import-cost-price-xlsx.ts <path-to-xlsx> [--year 2026] [--month 4]
 *
 * Примеры:
 *   npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/import-cost-price-xlsx.ts "Оцифровка_OZON ver13_по мес..xlsx"
 */
import 'shared/preload';

import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { config as loadDotenv } from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import ExcelJS from 'exceljs';

const repoRoot = join(__dirname, '../..');

loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

const ACCOUNT_ID = new ObjectId(
  (process.env.OZON_ACCOUNT_ID || process.env.ACCOUNT_ID || '').trim() || undefined,
);

const MONTHS_RU: Record<string, number> = {
  'Январь': 0, 'Февраль': 1, 'Март': 2, 'Апрель': 3,
  'Май': 4, 'Июнь': 5, 'Июль': 6, 'Август': 7,
  'Сентябрь': 8, 'Октябрь': 9, 'Ноябрь': 10, 'Декабрь': 11,
};

function parseArgs(): { xlsxPath: string; year?: number; month?: number } {
  const args = process.argv.slice(2);
  const xlsxPath = args[0];
  let year: number | undefined;
  let month: number | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      year = Number(args[i + 1]);
    }

    if (args[i] === '--month' && args[i + 1]) {
      month = Number(args[i + 1]) - 1;
    }
  }

  return { xlsxPath, year, month };
}

type Row = {
  sellerProductId: string;
  sku?: number;
  costPrice: number;
  year: number;
  month: number;
};

async function readXlsx(xlsxPath: string, defaultYear?: number, defaultMonth?: number): Promise<Row[]> {
  const wb = new ExcelJS.Workbook();

  await wb.xlsx.readFile(xlsxPath);

  const ws = wb.getWorksheet('Себестоимость');

  if (!ws) {
    const names = wb.worksheets.map((s) => `"${s.name}"`).join(', ');

    throw new Error(`Лист «Себестоимость» не найден. Доступные листы: ${names}`);
  }

  const rows: Row[] = [];
  const now = new Date();
  const fallbackYear = defaultYear ?? now.getUTCFullYear();
  const fallbackMonth = defaultMonth ?? now.getUTCMonth();

  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) {
      return;
    }

    const vals = row.values as (string | number | null | undefined)[];
    // Expect columns: Ключ | Год | Месяц | Артикул продавца | SKU | Товар | Себестоимость
    // (from the actual file structure)
    const yearCell = vals[2];
    const monthCell = vals[3];
    const sellerProductId = String(vals[4] ?? '').trim();
    const skuRaw = vals[5];
    const costPriceRaw = vals[7];

    if (!sellerProductId || sellerProductId === 'Артикул продавца') {
      return;
    }

    const costPrice = Number(costPriceRaw);

    if (!Number.isFinite(costPrice) || costPrice < 0) {
      return;
    }

    const year = Number(yearCell) || fallbackYear;
    const monthStr = String(monthCell ?? '').trim();
    const month = MONTHS_RU[monthStr] ?? fallbackMonth;

    rows.push({
      sellerProductId,
      sku: skuRaw ? Number(skuRaw) : undefined,
      costPrice,
      year,
      month,
    });
  });

  return rows;
}

async function main(): Promise<void> {
  const { xlsxPath, year, month } = parseArgs();

  if (!xlsxPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: import-cost-price-xlsx.ts <path-to-xlsx> [--year 2026] [--month 4]');
    process.exit(1);
  }

  const resolved = existsSync(xlsxPath) ? xlsxPath : join(repoRoot, xlsxPath);

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const mongoUrl = process.env.MONGO_URL?.trim();

  if (!mongoUrl) {
    throw new Error('MONGO_URL is required');
  }

  // eslint-disable-next-line no-console
  console.log(`Reading ${resolved}...`);
  const rows = await readXlsx(resolved, year, month);
  // eslint-disable-next-line no-console
  console.log(`Found ${rows.length} cost price rows`);

  const client = new MongoClient(mongoUrl);

  await client.connect();

  const col = client.db().collection('sale_cost_price');

  let upsertCount = 0;

  for (const row of rows) {
    const { sellerProductId, sku, costPrice, year: y, month: m } = row;
    const effectiveFrom = new Date(Date.UTC(y, m, 1));

    await col.updateOne(
      { accountId: ACCOUNT_ID, sellerProductId, effectiveFrom },
      {
        $set: { costPrice, source: 'xlsx-import', updatedAt: new Date(), ...sku !== undefined && { sku } },
        $setOnInsert: { accountId: ACCOUNT_ID, sellerProductId, effectiveFrom, createdAt: new Date() },
      },
      { upsert: true },
    );

    upsertCount++;

    if (upsertCount % 100 === 0) {
      // eslint-disable-next-line no-console
      console.log(`  Upserted ${upsertCount}/${rows.length}...`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Done. Upserted ${upsertCount} cost price records for account ${ACCOUNT_ID.toHexString()}.`);
  await client.close();
}

void main().catch((error: Error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
