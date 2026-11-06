import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { MongoClient } from 'mongodb';
import { syncRange } from './sync.js';
import { buildReport } from './report.js';
import { eachDate } from './ozon.js';

const here = path.dirname(fileURLToPath(import.meta.url));
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const i = trimmed.indexOf('=');
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(here, '../../backend/.env.development'));
loadEnvFile(path.resolve(here, '../.env'));

function env(name, fallback) {
  return process.env[name] || fallback;
}

function todayMoscow() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function daysAgo(n) {
  const [y, m, d] = todayMoscow().split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - n);
  return utc.toISOString().slice(0, 10);
}

const mongoUrl = env('MONGO_URL', 'mongodb://127.0.0.1:27017/card_profit');
const port = Number(env('PORT', '3080'));

const client = new MongoClient(mongoUrl);
await client.connect();
const db = client.db();
await db.collection('lines').createIndex({ date: 1, sku: 1 });
await db.collection('lines').createIndex({ accrualId: 1 });
await db.collection('cards').createIndex({ sku: 1 }, { unique: true });
await db.collection('accrual_types').createIndex({ id: 1 }, { unique: true });

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ ok: true, today: todayMoscow() }));

app.post('/api/sync', async (req, reply) => {
  const body = req.body || {};
  const maxDate = body.maxDate || todayMoscow();
  const minDate = body.minDate || daysAgo(7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(minDate) || !/^\d{4}-\d{2}-\d{2}$/.test(maxDate)) {
    return reply.code(400).send({ error: 'minDate и maxDate: YYYY-MM-DD' });
  }
  if (eachDate(minDate, maxDate).length > 62) {
    return reply.code(400).send({ error: 'Синк не больше 62 дней за раз' });
  }
  const result = await syncRange(db, minDate, maxDate);
  return result;
});

app.get('/api/cards', async (req, reply) => {
  const q = req.query || {};
  const maxDate = q.maxDate || todayMoscow();
  const minDate = q.minDate || daysAgo(7);
  const interval = ['day', 'week', 'month', 'period'].includes(q.interval) ? q.interval : 'period';
  const sku = q.sku ? Number(q.sku) : undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(minDate) || !/^\d{4}-\d{2}-\d{2}$/.test(maxDate)) {
    return reply.code(400).send({ error: 'minDate и maxDate: YYYY-MM-DD' });
  }
  return buildReport(db, { minDate, maxDate, interval, sku });
});

app.get('/api/types', async () => {
  const types = await db.collection('accrual_types').find({}).sort({ id: 1 }).toArray();
  return { types };
});

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
