/**
 * Однократный скрипт: создаёт/обновляет один Account + Permission из переменных окружения.
 *
 * Подготовка:
 * 1) Убедитесь что Mongo доступна (локально или через tunnel).
 * 2) В .env.development должны быть заданы:
 *    OZON_SELLER_CLIENT_ID, OZON_SELLER_API_KEY
 *    OZON_PERFORMANCE_CLIENT_ID, OZON_PERFORMANCE_CLIENT_SECRET (опционально)
 * 3) Запуск:
 *    npx ts-node --transpile-only -r tsconfig-paths/register tools/sale/seed-account.ts
 */
import 'shared/preload';

import { join } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';

const repoRoot = join(__dirname, '../..');

loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

const ACCOUNT_ID = new ObjectId(
  (process.env.OZON_ACCOUNT_ID || process.env.ACCOUNT_ID || '').trim() || undefined,
);

const ACCOUNT_NAME = process.env.OZON_ACCOUNT_NAME?.trim() || 'Мой магазин Ozon';

async function main(): Promise<void> {
  const mongoUrl = process.env.MONGO_URL?.trim();

  if (!mongoUrl) {
    throw new Error('MONGO_URL is required');
  }

  const sellerToken = process.env.OZON_SELLER_API_KEY?.trim();
  const sellerClientId = Number(process.env.OZON_SELLER_CLIENT_ID?.trim());
  const performanceClientId = process.env.OZON_PERFORMANCE_CLIENT_ID?.trim();
  const performanceClientSecret = process.env.OZON_PERFORMANCE_CLIENT_SECRET?.trim();

  if (!sellerToken) {
    throw new Error('OZON_SELLER_API_KEY is required');
  }

  if (!Number.isFinite(sellerClientId) || sellerClientId < 1) {
    throw new Error('OZON_SELLER_CLIENT_ID must be a positive integer');
  }

  const client = new MongoClient(mongoUrl);

  await client.connect();

  // eslint-disable-next-line no-console
  console.log('Connected to MongoDB:', mongoUrl.replace(/:[^:@]+@/, ':***@'));

  const db = client.db();

  const accountsCol = db.collection('account');
  const permissionsCol = db.collection('permission');

  const now = new Date();

  await accountsCol.updateOne(
    { _id: ACCOUNT_ID },
    {
      $setOnInsert: { _id: ACCOUNT_ID, createdAt: now },
      $set: {
        name: ACCOUNT_NAME,
        status: 'ENABLED',
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  // eslint-disable-next-line no-console
  console.log(`Account upserted: ${ACCOUNT_ID.toHexString()} "${ACCOUNT_NAME}"`);

  const permissionUpdate: Record<string, unknown> = {
    authorized: true,
    updatedAt: now,
    sellerSecret: {
      clientId: String(sellerClientId),
      clientSecret: sellerToken,
      grantType: 'client_credentials',
    },
    token: sellerToken,
  };

  if (performanceClientId && performanceClientSecret) {
    permissionUpdate.performanceSecret = {
      clientId: performanceClientId,
      clientSecret: performanceClientSecret,
      grantType: 'client_credentials',
    };
  }

  await permissionsCol.updateOne(
    { account: ACCOUNT_ID },
    {
      $setOnInsert: { account: ACCOUNT_ID, createdAt: now },
      $set: permissionUpdate,
    },
    { upsert: true },
  );

  // eslint-disable-next-line no-console
  console.log(`Permission upserted for account ${ACCOUNT_ID.toHexString()}`);
  // eslint-disable-next-line no-console
  console.log(`  Seller clientId: ${sellerClientId}`);

  if (performanceClientId) {
    // eslint-disable-next-line no-console
    console.log(`  Performance clientId: ${performanceClientId}`);
  }

  await client.close();
  // eslint-disable-next-line no-console
  console.log('Done.');
}

void main().catch((error: Error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
