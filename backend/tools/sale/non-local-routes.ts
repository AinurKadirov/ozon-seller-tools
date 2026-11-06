/**
 * non-local-routes.ts — статистика нелокальных FBO-заказов по маршрутам.
 *
 *   npm run ozon:non-local-routes
 *   npm run ozon:non-local-routes -- 30
 */
import { fetchPostingsFbo } from './lib/ozon';
import { estimateLogistics } from './lib/logistics';
import { logActiveShop } from './lib/shop-config';

const DAYS = Number(process.argv[2]) || 60;

interface Agg {
  units: number;
  orders: number;
  revenue: number;
  surcharge: number;
  rate: number;
}

function bump(map: Map<string, Agg>, key: string, qty: number, price: number, surcharge: number, rate: number): void {
  let a = map.get(key);
  if (!a) a = { units: 0, orders: 0, revenue: 0, surcharge: 0, rate };
  a.units += qty;
  a.orders += 1;
  a.revenue += price * qty;
  a.surcharge += surcharge * qty;
  map.set(key, a);
}

const pct = (n: number, d: number): string => (d ? `${(100 * n / d).toFixed(1)}%` : '0%');

function printTop(title: string, map: Map<string, Agg>, total: number, n = 15): void {
  const rows = [...map.entries()]
    .map(([key, a]) => ({
      key,
      ...a,
      avgPrice: a.revenue / a.units,
      avgSurcharge: a.surcharge / a.units,
    }))
    .sort((a, b) => b.units - a.units);

  console.log(`\n=== ${title} ===`);
  console.log(
    'Маршрут/кластер'.padEnd(52) +
    'ед.'.padStart(5) +
    '  доля'.padStart(6) +
    '  наценка'.padStart(8) +
    '  ср.цена'.padStart(9) +
    '  ср.надб.'.padStart(9),
  );
  for (const r of rows.slice(0, n)) {
    console.log(
      r.key.slice(0, 50).padEnd(52) +
      String(r.units).padStart(5) +
      pct(r.units, total).padStart(6) +
      `${(r.rate * 100).toFixed(0)}%`.padStart(8) +
      Math.round(r.avgPrice).toString().padStart(9) +
      Math.round(r.avgSurcharge).toString().padStart(9),
    );
  }
}

async function main(): Promise<void> {
  logActiveShop();
  const to = new Date();
  const from = new Date(to.getTime() - DAYS * 86_400_000);

  console.log(`Загружаю FBO-заказы за ${DAYS} дн...`);
  const postings = await fetchPostingsFbo(from, to);
  console.log(`Всего отправлений: ${postings.length}`);

  const byDest = new Map<string, Agg>();
  const byRoute = new Map<string, Agg>();
  const byWarehouse = new Map<string, Agg>();
  let totalUnits = 0;
  let localUnits = 0;
  let nonLocalUnits = 0;
  let cancelled = 0;

  for (const p of postings) {
    if (p.status === 'cancelled') { cancelled++; continue; }
    for (const pr of p.products) {
      totalUnits += pr.qty;
      const log = estimateLogistics(pr.price, p.clusterFrom, p.clusterTo);
      if (log.isLocal) { localUnits += pr.qty; continue; }
      nonLocalUnits += pr.qty;

      const dest = p.clusterTo || '(пусто)';
      const route = `${p.clusterFrom || '?'} → ${dest}`;
      const whRoute = `${p.warehouse || '(склад)'} → ${dest}`;

      bump(byDest, dest, pr.qty, pr.price, log.surcharge, log.surchargeRate);
      bump(byRoute, route, pr.qty, pr.price, log.surcharge, log.surchargeRate);
      bump(byWarehouse, whRoute, pr.qty, pr.price, log.surcharge, log.surchargeRate);
    }
  }

  console.log('\n=== ОБЩЕЕ ===');
  console.log(`Период: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  console.log(`Отправлений: ${postings.length} (отмен: ${cancelled})`);
  console.log(`Единиц (без отмен): ${totalUnits}`);
  console.log(`Локальных: ${localUnits} (${pct(localUnits, totalUnits)})`);
  console.log(`Нелокальных: ${nonLocalUnits} (${pct(nonLocalUnits, totalUnits)})`);

  printTop('ТОП кластеров НАЗНАЧЕНИЯ (нелокальные)', byDest, nonLocalUnits);
  printTop('ТОП маршрутов cluster_from → cluster_to', byRoute, nonLocalUnits);
  printTop('ТОП склад → кластер назначения', byWarehouse, nonLocalUnits, 12);

  let sumRev = 0;
  let sumSur = 0;
  for (const a of byDest.values()) {
    sumRev += a.revenue;
    sumSur += a.surcharge;
  }
  console.log(`\nСредневзвешенная наценка нелокальности: ${pct(sumSur, sumRev)} от цены`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
