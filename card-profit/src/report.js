import { BUCKETS } from './buckets.js';

const TAX_RATE = Number(process.env.TAX_RATE || '0.07');

function emptyFees() {
  return Object.fromEntries(BUCKETS.map((b) => [b, 0]));
}

function intervalKey(date, interval) {
  if (interval === 'day') return date;
  if (interval === 'month') return date.slice(0, 7);
  if (interval === 'week') {
    const [year, month, day] = date.split('-').map(Number);
    const utc = new Date(Date.UTC(year, month - 1, day));
    const weekday = (utc.getUTCDay() + 6) % 7;
    utc.setUTCDate(utc.getUTCDate() - weekday);
    return utc.toISOString().slice(0, 10);
  }
  return 'period';
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function blankRow(key, sku, intervalStart) {
  return {
    key,
    intervalStart,
    sku,
    offerId: '',
    name: sku ? `SKU ${sku}` : 'Удержания Ozon',
    soldCount: 0,
    returnCount: 0,
    ...emptyFees(),
    cost: 0,
    tax: 0,
    profit: 0,
    marginPercent: 0,
    roiPercent: null,
    perUnit: {},
    fees: [],
  };
}

function finalize(row, sold) {
  const denom = sold > 0 ? sold : 0;
  row.tax = round2(Math.max(0, row.revenue) * TAX_RATE);
  row.profit = round2(
    row.revenue +
      row.commission +
      row.logistics +
      row.acquiring +
      row.ads +
      row.storage +
      row.installment +
      row.other -
      row.cost -
      row.tax,
  );
  row.marginPercent = row.revenue ? round2((row.profit / row.revenue) * 100) : 0;
  row.roiPercent = row.cost ? round2((row.profit / row.cost) * 100) : null;
  const per = {};
  for (const bucket of [...BUCKETS, 'cost', 'tax', 'profit']) {
    per[bucket] = denom ? round2(row[bucket] / denom) : 0;
  }
  row.perUnit = per;
  for (const fee of row.fees) {
    fee.amount = round2(fee.amount);
    fee.perUnit = denom ? round2(fee.amount / denom) : 0;
  }
  row.fees.sort((a, b) => a.amount - b.amount);
  for (const bucket of BUCKETS) row[bucket] = round2(row[bucket]);
  row.cost = round2(row.cost);
  return row;
}

export async function buildReport(db, { minDate, maxDate, interval = 'period', sku }) {
  const query = { date: { $gte: minDate, $lte: maxDate } };
  if (sku) query.sku = Number(sku);
  const lines = await db.collection('lines').find(query).toArray();
  const cards = await db.collection('cards').find({}).toArray();
  const cardBySku = new Map(cards.map((c) => [c.sku, c]));

  const rows = new Map();
  const shopLines = [];

  function rowFor(lineSku, date) {
    const start = intervalKey(date, interval);
    const key = `${start}:${lineSku}`;
    if (!rows.has(key)) {
      const row = blankRow(key, lineSku, start);
      const card = cardBySku.get(lineSku);
      if (card) {
        row.offerId = card.offerId || '';
        row.name = card.offerId ? `${card.offerId} ${card.name || ''}`.trim() : card.name || row.name;
        row.costPrice = card.cost || 0;
      }
      rows.set(key, row);
    }
    return rows.get(key);
  }

  for (const line of lines) {
    if (!line.sku) {
      shopLines.push(line);
      continue;
    }
    const row = rowFor(line.sku, line.date);
    if (line.bucket === 'revenue') {
      if (line.amount >= 0) row.soldCount += line.quantity || 1;
      else row.returnCount += Math.abs(line.quantity || 1);
    }
    row[line.bucket] = (row[line.bucket] || 0) + line.amount;
    const feeKey = `${line.typeId}:${line.typeName}`;
    let fee = row.fees.find((f) => `${f.typeId}:${f.typeName}` === feeKey);
    if (!fee) {
      fee = { typeId: line.typeId, typeName: line.typeName, bucket: line.bucket, amount: 0, perUnit: 0 };
      row.fees.push(fee);
    }
    fee.amount += line.amount;
  }

  const list = [...rows.values()];

  for (const line of shopLines) {
    const start = intervalKey(line.date, interval);
    const peers = list.filter((row) => row.intervalStart === start);
    const revenueTotal = peers.reduce((sum, row) => sum + row.revenue, 0);
    const soldTotal = peers.reduce((sum, row) => sum + row.soldCount, 0);
    const targets = peers.length ? peers : [rowFor(0, line.date)];
    if (!peers.length) list.push(targets[0]);
    for (const row of targets) {
      const share = peers.length
        ? (revenueTotal > 0 ? row.revenue / revenueTotal : soldTotal > 0 ? row.soldCount / soldTotal : 1 / peers.length)
        : 1;
      row[line.bucket] = (row[line.bucket] || 0) + line.amount * share;
      const feeKey = `${line.typeId}:${line.typeName}`;
      let fee = row.fees.find((f) => `${f.typeId}:${f.typeName}` === feeKey);
      if (!fee) {
        fee = { typeId: line.typeId, typeName: line.typeName, bucket: line.bucket, amount: 0, perUnit: 0, allocated: true };
        row.fees.push(fee);
      }
      fee.amount += line.amount * share;
    }
  }

  if (!list.length && shopLines.length) {
    const row = blankRow('period:0', 0, interval === 'period' ? 'period' : minDate);
    for (const line of shopLines) {
      row[line.bucket] = (row[line.bucket] || 0) + line.amount;
      row.fees.push({
        typeId: line.typeId,
        typeName: line.typeName,
        bucket: line.bucket,
        amount: line.amount,
        perUnit: 0,
      });
    }
    list.push(row);
  }

  for (const row of list) {
    const card = cardBySku.get(row.sku);
    const unitCost = card?.cost || 0;
    const netUnits = Math.max(0, row.soldCount - row.returnCount);
    row.cost = unitCost * netUnits;
    finalize(row, row.soldCount);
  }

  list.sort((a, b) => b.profit - a.profit);

  const totals = blankRow('totals', 0, 'totals');
  totals.name = 'Итого';
  for (const row of list) {
    totals.soldCount += row.soldCount;
    totals.returnCount += row.returnCount;
    for (const bucket of BUCKETS) totals[bucket] += row[bucket];
    totals.cost += row.cost;
    for (const fee of row.fees) {
      let t = totals.fees.find((f) => f.typeId === fee.typeId && f.typeName === fee.typeName);
      if (!t) {
        t = { typeId: fee.typeId, typeName: fee.typeName, bucket: fee.bucket, amount: 0, perUnit: 0 };
        totals.fees.push(t);
      }
      t.amount += fee.amount;
    }
  }
  finalize(totals, totals.soldCount);

  const days = await db.collection('sync_days')
    .find({ date: { $gte: minDate, $lte: maxDate } })
    .sort({ date: 1 })
    .toArray();

  return { minDate, maxDate, interval, taxRate: TAX_RATE, totals, rows: list, days };
}
