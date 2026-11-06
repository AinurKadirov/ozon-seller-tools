const BASE = 'https://api-seller.ozon.ru';

function headers() {
  const clientId = process.env.OZON_SELLER_CLIENT_ID;
  const apiKey = process.env.OZON_SELLER_API_KEY;
  if (!clientId || !apiKey) {
    throw new Error('Нет OZON_SELLER_CLIENT_ID / OZON_SELLER_API_KEY');
  }
  return {
    'Content-Type': 'application/json',
    'Client-Id': clientId,
    'Api-Key': apiKey,
  };
}

export async function ozonPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) {
    const message = json?.message || json?.error || res.statusText;
    const err = new Error(`${path} ${res.status}: ${message}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

export async function listAccrualTypes() {
  const data = await ozonPost('/v1/finance/accrual/types', {});
  return data.accrual_types || [];
}

export async function listAccrualsByDay(date) {
  const rows = [];
  let lastId = '';
  for (let page = 0; page < 100; page += 1) {
    const data = await ozonPost('/v1/finance/accrual/by-day', { date, last_id: lastId });
    const batch = data.accruals || [];
    rows.push(...batch);
    lastId = data.last_id || '';
    if (!lastId || batch.length === 0) break;
  }
  return rows;
}

export async function listProductInfoBySkus(skus) {
  const unique = [...new Set(skus.filter(Boolean))];
  const cards = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const data = await ozonPost('/v3/product/info/list', { sku: chunk });
      cards.push(...(data.items || data.result?.items || []));
    } catch {
      // полный синк карточек — отдельная задача; имена подтянем если ручка пустит
    }
  }
  return cards;
}

export function eachDate(minDate, maxDate) {
  const dates = [];
  let cursor = minDate;
  while (cursor <= maxDate) {
    dates.push(cursor);
    const [year, month, day] = cursor.split('-').map(Number);
    const utc = new Date(Date.UTC(year, month - 1, day));
    utc.setUTCDate(utc.getUTCDate() + 1);
    cursor = utc.toISOString().slice(0, 10);
  }
  return dates;
}
