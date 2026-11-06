import { COST_SEED } from './cost-seed.js';
import { bucketOf } from './buckets.js';
import { flattenAccrual } from './flatten.js';
import { eachDate, listAccrualTypes, listAccrualsByDay, listProductInfoBySkus } from './ozon.js';

export async function seedCards(db) {
  const cards = db.collection('cards');
  for (const row of COST_SEED) {
    await cards.updateOne(
      { sku: row.sku },
      {
        $set: { sku: row.sku, offerId: row.offerId, name: row.name, cost: row.cost },
      },
      { upsert: true },
    );
  }
}

export async function syncRange(db, minDate, maxDate) {
  await seedCards(db);
  const typesCol = db.collection('accrual_types');
  const linesCol = db.collection('lines');
  const daysCol = db.collection('sync_days');
  const cardsCol = db.collection('cards');

  const types = await listAccrualTypes();
  const typeById = new Map(types.map((t) => [t.id, t]));
  if (types.length) {
    const ops = types.map((t) => ({
      updateOne: {
        filter: { id: t.id },
        update: {
          $set: {
            id: t.id,
            name: t.name,
            description: t.description,
            bucket: bucketOf(t.id, t.name),
          },
        },
        upsert: true,
      },
    }));
    await typesCol.bulkWrite(ops);
  }

  const dates = eachDate(minDate, maxDate);
  let lineCount = 0;
  let dayCount = 0;
  const skus = new Set();

  for (const date of dates) {
    const accruals = await listAccrualsByDay(date);
    const lines = accruals.flatMap((accrual) => flattenAccrual(accrual, typeById));
    await linesCol.deleteMany({ date });
    if (lines.length) await linesCol.insertMany(lines);
    await daysCol.updateOne(
      { date },
      { $set: { date, accrualCount: accruals.length, lineCount: lines.length, syncedAt: new Date() } },
      { upsert: true },
    );
    lineCount += lines.length;
    dayCount += 1;
    for (const line of lines) if (line.sku) skus.add(line.sku);
  }

  const infos = await listProductInfoBySkus([...skus]);
  for (const item of infos) {
    const sku = item.sku || item.fbo_sku || item.fbs_sku;
    if (!sku) continue;
    await cardsCol.updateOne(
      { sku: Number(sku) },
      {
        $set: {
          sku: Number(sku),
          offerId: item.offer_id || item.offerId,
          name: item.name,
          productId: item.id || item.product_id,
        },
      },
      { upsert: true },
    );
  }

  return { minDate, maxDate, dayCount, lineCount, typeCount: types.length, skuCount: skus.size };
}
