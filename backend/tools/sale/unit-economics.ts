/**
 * Unit-economics по SKU за последние N дней.
 * Считает фактические ставки комиссии/логистики/эквайринга из реальных API-данных,
 * и вычисляет минимальную цену для заданного целевого профита на единицу.
 *
 * Запуск:
 *   npm run ozon:unit-economics              — последние 15 дней
 *   npm run ozon:unit-economics 30           — последние 30 дней
 *   npm run ozon:unit-economics 15 100 200   — 15 дней, цели профита 100 и 200 ₽
 *   npm run ozon:unit-economics-current 30   — пересчёт по текущим ценам карточек
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { COST_BY_SKU, NAME_BY_OFFER, OFFER_BY_SKU } from './lib/catalog';

const repoRoot = join(__dirname, '../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

const SKU_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(OFFER_BY_SKU).map(([sku, offer]) => [
    Number(sku),
    NAME_BY_OFFER[offer] ?? offer,
  ]),
);

const TAX_RATE = 0.07;

const LOGISTICS_SERVICES = new Set([
  'MarketplaceServiceItemDirectFlowLogistic',
  'MarketplaceServiceItemReturnFlowLogistic',
  'MarketplaceServiceItemFlowLogistic',
  'MarketplaceServiceItemRedistributionLastMileCourier',
  'MarketplaceServiceItemReturnAfterDeliveryLogistic',
  'MarketplaceServiceItemDeliveryToPoint',
  'MarketplaceServiceItemDropshipDirectFlowLogistic',
]);

const ADS_OPERATION_TYPES = new Set([
  'OperationMarketplaceCostPerClick',
  'OperationPromotionWithCostPerOrder',
  'StarsMembership',
  'OperationAgentCampaign',
  'CampaignPayment',
]);

// ─── Типы ──────────────────────────────────────────────────────────────────
interface OzonOperation {
  operation_id: number;
  operation_type: string;
  operation_date: string;
  accruals_for_sale: number;
  sale_commission: number;
  amount: number;
  type: string;
  items: Array<{ sku: number; name: string }>;
  services: Array<{ name: string; price: number }>;
}

interface SkuStats {
  sku: number;
  name: string;
  offerId: string;
  costPrice: number;

  soldCount: number;
  returnCount: number;

  totalRevenue: number;
  totalCommission: number;
  totalLogistics: number;

  // Доля рекламы и эквайринга — распределяем пропорционально выручке
  allocatedAds: number;
  allocatedAcquiring: number;

  avgSellingPrice: number;
  currentCardPrice?: number;
  effectiveCommissionRate: number;   // комиссия как доля от цены продажи (отрицательная)
  avgLogisticsPerUnit: number;        // средняя логистика на 1 продажу (отрицательная)
  avgAcquiringPerUnit: number;        // средний эквайринг на 1 продажу (отрицательная)
  avgAdsPerUnit: number;              // средняя реклама на 1 продажу (отрицательная)

  actualNetPerUnit: number;           // фактическая прибыль на единицу
  currentNetPerUnit?: number;         // прибыль при текущей цене карточки и фактических расходах
  breakEvenPrice: number;             // минимальная цена для нулевой прибыли
  priceTargets: Record<number, number>; // цена для каждого целевого профита
}

type PriceMode = 'actual' | 'current';

// ─── API ───────────────────────────────────────────────────────────────────
async function fetchOzon(
  token: string,
  clientId: number,
  dateFrom: Date,
  dateTo: Date,
): Promise<OzonOperation[]> {
  const all: OzonOperation[] = [];
  let page = 1;

  for (;;) {
    const res = await nodeFetch('https://api-seller.ozon.ru/v3/finance/transaction/list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': String(clientId),
        'Api-Key': token,
      },
      body: JSON.stringify({
        filter: {
          date: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
          transaction_type: 'all',
        },
        language: 'DEFAULT',
        page,
        page_size: 1000,
      }),
    });

    if (!res.ok) throw new Error(`Ozon API ${res.status}: ${await res.text()}`);

    const data = await res.json() as { result: { operations: OzonOperation[]; page_count: number } };
    const { operations, page_count } = data.result;

    all.push(...operations);
    process.stdout.write(`  стр. ${page}/${page_count}  (${all.length} ops)\r`);

    if (page >= page_count || operations.length === 0) break;
    page++;
    await new Promise((r) => setTimeout(r, 200));
  }

  process.stdout.write('\n');
  return all;
}

async function fetchCurrentPrices(token: string, clientId: number): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  let lastId = '';

  for (;;) {
    const res = await nodeFetch('https://api-seller.ozon.ru/v5/product/info/prices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': String(clientId),
        'Api-Key': token,
      },
      body: JSON.stringify({
        filter: { visibility: 'ALL' },
        limit: 100,
        last_id: lastId,
      }),
    });

    if (!res.ok) throw new Error(`Ozon prices API ${res.status}: ${await res.text()}`);

    const data = await res.json() as {
      items?: Array<{ offer_id: string; price?: { price?: string } }>;
      last_id?: string;
    };

    for (const item of data.items ?? []) {
      const price = Number(item.price?.price ?? 0);
      if (item.offer_id && price > 0) prices.set(item.offer_id, price);
    }

    if (!data.last_id || !data.items?.length || data.items.length < 100) break;
    lastId = data.last_id;
    await new Promise((r) => setTimeout(r, 200));
  }

  return prices;
}

// ─── Вычисление unit-economics ─────────────────────────────────────────────
function computeUnitEconomics(
  ops: OzonOperation[],
  targetProfits: number[],
  currentPriceByOffer: Map<string, number>,
): SkuStats[] {
  // Агрегаты по SKU
  const bySkuSold = new Map<number, {
    revenue: number; commission: number; logistics: number;
    soldCount: number; returnCount: number; name: string;
  }>();

  // Общие расходы не-на-SKU
  let totalRevenue = 0;
  let totalAds = 0;
  let totalAcquiring = 0;

  for (const op of ops) {
    if (op.type === 'orders') {
      const sku = op.items[0]?.sku ?? 0;
      const name = op.items[0]?.name ?? `SKU ${sku}`;

      if (!bySkuSold.has(sku)) {
        bySkuSold.set(sku, { revenue: 0, commission: 0, logistics: 0, soldCount: 0, returnCount: 0, name });
      }

      const s = bySkuSold.get(sku)!;

      // Включаем логистику/корректировки всегда (они влияют на финрез)
      for (const svc of op.services) {
        if (LOGISTICS_SERVICES.has(svc.name)) s.logistics += svc.price;
      }

      // Считаем продажу только если был реальный доход (accruals > 0)
      // Нулевые orders — это корректировки логистики, возврат сборов и т.п.
      if (op.accruals_for_sale <= 0) continue;

      s.revenue += op.accruals_for_sale;
      s.commission += op.sale_commission;
      s.soldCount++;

      totalRevenue += op.accruals_for_sale;
    } else if (op.type === 'returns' && op.accruals_for_sale !== 0) {
      const sku = op.items[0]?.sku ?? 0;
      if (bySkuSold.has(sku)) {
        bySkuSold.get(sku)!.returnCount++;
      }
    } else if (op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation') {
      totalAcquiring += op.amount;
    } else if (ADS_OPERATION_TYPES.has(op.operation_type)) {
      totalAds += op.amount;
    }
  }

  const result: SkuStats[] = [];

  for (const [sku, s] of bySkuSold) {
    if (s.soldCount === 0) continue;

    const costPrice = COST_BY_SKU[sku] ?? 0;
    const skuRevShare = totalRevenue > 0 ? s.revenue / totalRevenue : 0;

    // Распределяем рекламу и эквайринг пропорционально выручке SKU
    const allocatedAds = totalAds * skuRevShare;
    const allocatedAcquiring = totalAcquiring * skuRevShare;

    const avgSellingPrice = s.revenue / s.soldCount;
    const effectiveCommissionRate = avgSellingPrice > 0 ? s.commission / s.revenue : 0;
    const avgLogisticsPerUnit = s.logistics / s.soldCount;
    const avgAcquiringPerUnit = allocatedAcquiring / s.soldCount;
    const avgAdsPerUnit = allocatedAds / s.soldCount;

    // Фактическая прибыль на единицу (с учётом налога)
    const actualGrossPerUnit = avgSellingPrice + effectiveCommissionRate * avgSellingPrice
      + avgLogisticsPerUnit + avgAcquiringPerUnit + avgAdsPerUnit;
    const taxPerUnit = avgSellingPrice * TAX_RATE;
    const actualNetPerUnit = actualGrossPerUnit - costPrice - taxPerUnit;

    // Для расчёта цены при целевом профите:
    // net = price × (1 + commissionRate - taxRate) + logisticsFixed + acquiringFixed + adsFixed - COGS
    // target = price × multiplier + fixed - COGS
    // price = (COGS + target - fixed) / multiplier
    //
    // Но: логистика — НЕ % от цены, это фиксированная сумма на единицу (зависит от веса/размера).
    // Эквайринг и реклама тоже фиксированы на единицу в нашем расчёте.
    // Т.е. только commission + tax — % от цены.
    //
    // Значит multiplier = (1 + effectiveCommissionRate - TAX_RATE)
    // price = (COGS - logisticsPerUnit - acquiringPerUnit - adsPerUnit + target) / multiplier
    //
    // Примечание: logisticsPerUnit/acquiringPerUnit/adsPerUnit — отрицательные числа,
    //             поэтому (COGS - negative) = COGS + |costs|

    const multiplier = 1 + effectiveCommissionRate - TAX_RATE; // обычно ~0.50

    const fixedCostsPerUnit = avgLogisticsPerUnit + avgAcquiringPerUnit + avgAdsPerUnit;

    const breakEvenPrice = costPrice > 0 && multiplier > 0
      ? (costPrice - fixedCostsPerUnit) / multiplier
      : 0;

    const priceTargets: Record<number, number> = {};

    for (const target of targetProfits) {
      priceTargets[target] = costPrice > 0 && multiplier > 0
        ? (costPrice - fixedCostsPerUnit + target) / multiplier
        : 0;
    }

    const shortName = SKU_NAME[sku] ?? s.name.slice(0, 35);
    const offerId = OFFER_BY_SKU[sku] ?? String(sku);
    const currentCardPrice = currentPriceByOffer.get(offerId);
    const currentNetPerUnit = currentCardPrice !== undefined
      ? currentCardPrice + effectiveCommissionRate * currentCardPrice
        + avgLogisticsPerUnit + avgAcquiringPerUnit + avgAdsPerUnit
        - costPrice - currentCardPrice * TAX_RATE
      : undefined;

    result.push({
      sku,
      name: shortName,
      offerId,
      costPrice,
      soldCount: s.soldCount,
      returnCount: s.returnCount,
      totalRevenue: s.revenue,
      totalCommission: s.commission,
      totalLogistics: s.logistics,
      allocatedAds,
      allocatedAcquiring,
      avgSellingPrice,
      currentCardPrice,
      effectiveCommissionRate,
      avgLogisticsPerUnit,
      avgAcquiringPerUnit,
      avgAdsPerUnit,
      actualNetPerUnit,
      currentNetPerUnit,
      breakEvenPrice,
      priceTargets,
    });
  }

  return result.sort((a, b) => b.soldCount - a.soldCount);
}

// ─── Вывод ─────────────────────────────────────────────────────────────────
function r(n: number, dec = 0): string {
  return n.toFixed(dec);
}

function sortForDisplay(items: SkuStats[]): SkuStats[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
}

function printResults(
  stats: SkuStats[],
  targets: number[],
  days: number,
  priceMode: PriceMode,
): void {
  const soldStats = stats.filter((s) => s.soldCount > 0);
  const noData = [...Object.keys(COST_BY_SKU).map(Number)].filter(
    (sku) => !soldStats.find((s) => s.sku === sku),
  );

  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  📊 Unit-economics за последние ${days} дней (${soldStats.length} SKU с продажами)`);
  console.log(priceMode === 'current'
    ? '  Режим: текущая цена карточки + фактические расходы из отчёта'
    : '  Режим: фактическая цена реализации из отчёта');
  console.log(`${'═'.repeat(100)}\n`);

  // Заголовок
  const targetHeaders = targets.map((t) => `Цена+${t}₽`.padStart(9)).join(' ');
  console.log(
    '  ' +
    'SKU/Название'.padEnd(35) +
    'Себ-ть'.padStart(7) +
    'Прод'.padStart(5) +
    'Ср.факт'.padStart(8) +
    'Карточка'.padStart(9) +
    'Комм%'.padStart(6) +
    'Логист'.padStart(7) +
    'Прибыль/шт'.padStart(11) +
    'БезубЦена'.padStart(10) +
    ' ' + targetHeaders,
  );
  console.log('  ' + '─'.repeat(98));

  // Группы товаров
  const groups: Record<string, SkuStats[]> = {
    'Альбомы без рамки (АБ)': sortForDisplay(soldStats.filter((s) => s.name.startsWith('АБ'))),
    'Альбомы с рамкой (АР)': sortForDisplay(soldStats.filter((s) => s.name.startsWith('АР'))),
    'Фоторамки (Р)':          sortForDisplay(soldStats.filter((s) => s.name.startsWith('Р'))),
    'Прочее':                  sortForDisplay(soldStats.filter((s) => !s.name.match(/^(АБ|АР|Р)/))),
  };

  for (const [groupName, groupStats] of Object.entries(groups)) {
    if (groupStats.length === 0) continue;
    console.log(`\n  ── ${groupName} ──`);

    for (const s of groupStats) {
      const commPct = (-s.effectiveCommissionRate * 100).toFixed(1) + '%';
      const netPerUnit = priceMode === 'current'
        ? (s.currentNetPerUnit ?? s.actualNetPerUnit)
        : s.actualNetPerUnit;
      const profitIcon = netPerUnit >= 0 ? '✅' : '🔴';
      const targetCols = targets
        .map((t) => Math.ceil(s.priceTargets[t]).toString().padStart(9))
        .join(' ');
      const cardPrice = s.currentCardPrice !== undefined ? r(s.currentCardPrice).padStart(9) : '—'.padStart(9);

      console.log(
        '  ' +
        s.name.padEnd(35) +
        r(s.costPrice).padStart(7) +
        String(s.soldCount).padStart(5) +
        r(s.avgSellingPrice).padStart(8) +
        cardPrice +
        commPct.padStart(6) +
        r(s.avgLogisticsPerUnit).padStart(7) +
        (`${profitIcon} ${r(netPerUnit)}`).padStart(11) +
        Math.ceil(s.breakEvenPrice).toString().padStart(10) +
        ' ' + targetCols,
      );
    }

    // Среднее по группе
    if (groupStats.length > 1) {
      const avgComm = groupStats.reduce((s, g) => s + g.effectiveCommissionRate, 0) / groupStats.length;
      const avgLog = groupStats.reduce((s, g) => s + g.avgLogisticsPerUnit, 0) / groupStats.length;
      const avgBE = groupStats.reduce((s, g) => s + g.breakEvenPrice, 0) / groupStats.length;
      const avgT = targets.map((t) => {
        const avg = groupStats.reduce((s, g) => s + g.priceTargets[t], 0) / groupStats.length;
        return Math.ceil(avg).toString().padStart(9);
      }).join(' ');

      console.log('  ' + '─'.repeat(98));
      console.log(
        '  ' +
        'СРЕДНЕЕ по группе'.padEnd(35) +
        ''.padStart(7) +
        ''.padStart(5) +
        ''.padStart(8) +
        ''.padStart(9) +
        ((-avgComm * 100).toFixed(1) + '%').padStart(6) +
        r(avgLog).padStart(7) +
        ''.padStart(11) +
        Math.ceil(avgBE).toString().padStart(10) +
        ' ' + avgT,
      );
    }
  }

  // Подробная таблица по расходам
  console.log(`\n${'─'.repeat(100)}`);
  console.log(priceMode === 'current'
    ? '  📋 Детальный разбор при текущей цене карточки (расходы средние по факту):'
    : '  📋 Детальный разбор расходов на единицу (среднее по факту):');
  console.log('─'.repeat(100));
  console.log(
    '  ' +
    'SKU'.padEnd(35) +
    'Цена'.padStart(7) +
    'Факт'.padStart(7) +
    'Себ-ть'.padStart(7) +
    'Комм'.padStart(7) +
    'Лог-ка'.padStart(7) +
    'Экв'.padStart(5) +
    'Рекл'.padStart(7) +
    'Налог'.padStart(6) +
    'Итого расх'.padStart(11) +
    'Прибыль'.padStart(9),
  );
  console.log('  ' + '─'.repeat(98));

  for (const s of sortForDisplay(soldStats)) {
    const basisPrice = priceMode === 'current'
      ? (s.currentCardPrice ?? s.avgSellingPrice)
      : s.avgSellingPrice;
    const netPerUnit = priceMode === 'current'
      ? (s.currentNetPerUnit ?? s.actualNetPerUnit)
      : s.actualNetPerUnit;
    const commAmt = s.effectiveCommissionRate * basisPrice;
    const tax = basisPrice * TAX_RATE;
    const totalExpenses = commAmt + s.avgLogisticsPerUnit + s.avgAcquiringPerUnit + s.avgAdsPerUnit - s.costPrice - tax;

    console.log(
      '  ' +
      s.name.padEnd(35) +
      r(basisPrice).padStart(7) +
      r(s.avgSellingPrice).padStart(7) +
      r(-s.costPrice).padStart(7) +
      r(commAmt).padStart(7) +
      r(s.avgLogisticsPerUnit).padStart(7) +
      r(s.avgAcquiringPerUnit).padStart(5) +
      r(s.avgAdsPerUnit).padStart(7) +
      r(-tax).padStart(6) +
      r(totalExpenses).padStart(11) +
      r(netPerUnit).padStart(9),
    );
  }

  // Итоговые наблюдения
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  💡 avgSellingPrice = accruals_for_sale (API) = фактическая цена реализации');
  console.log('     Карточка = текущая price.price из /v5/product/info/prices.');
  if (priceMode === 'current') {
    console.log('     В режиме текущих цен прибыль считается по цене карточки, а расходы/ставки — из finance-отчёта.');
  }
  console.log('     Это НЕ цена карточки на Ozon. Разница = скидки + акции + баллы кэшбэка за счёт продавца.');
  console.log('     Если avgSellingPrice << цены карточки — товар участвует в промо с твоей доплатой.');
  console.log('─'.repeat(100));
  console.log('  🔍 Ключевые наблюдения:');
  console.log('─'.repeat(100));

  const maxComm = soldStats.reduce((m, s) => s.effectiveCommissionRate < m.effectiveCommissionRate ? s : m);
  const minComm = soldStats.reduce((m, s) => s.effectiveCommissionRate > m.effectiveCommissionRate ? s : m);
  const avgCommRate = soldStats.reduce((s, g) => s + g.effectiveCommissionRate, 0) / soldStats.length;
  const avgLogistics = soldStats.reduce((s, g) => s + g.avgLogisticsPerUnit, 0) / soldStats.length;

  console.log(`\n  📦 Комиссия Ozon:`);
  console.log(`     Средняя эффективная: ${(-avgCommRate * 100).toFixed(1)}% от цены продажи`);
  console.log(`     Максимальная: ${(-maxComm.effectiveCommissionRate * 100).toFixed(1)}% — ${maxComm.name}`);
  console.log(`     Минимальная:  ${(-minComm.effectiveCommissionRate * 100).toFixed(1)}% — ${minComm.name}`);

  console.log(`\n  🚚 Логистика:`);
  console.log(`     Средняя на единицу: ${(-avgLogistics).toFixed(0)} ₽`);
  console.log(`     ⚠️  Это НЕ процент — фиксированная сумма. При увеличении цены товара`);
  console.log(`        логистика остаётся такой же → маржа % растёт с ростом цены`);

  console.log(`\n  💡 Ценообразование:`);
  const multiplier = 1 + avgCommRate - TAX_RATE;
  console.log(`     Эффективный коэффициент "сколько остаётся от рубля цены": ${(multiplier * 100).toFixed(1)}%`);
  console.log(`     Формула: Цена = (Себестоимость + |Логистика| + |Эквайринг| + |Реклама| + Цель) / ${multiplier.toFixed(3)}`);

  if (noData.length > 0) {
    console.log(`\n  ⚪️  SKU без продаж за период (${noData.length} шт) — используй среднюю комиссию/логистику группы`);
  }

  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const token = process.env.OZON_SELLER_API_KEY?.trim();
  const clientId = Number(process.env.OZON_SELLER_CLIENT_ID?.trim());

  if (!token || !clientId) throw new Error('Нужны OZON_SELLER_API_KEY и OZON_SELLER_CLIENT_ID');

  const args = process.argv.slice(2);
  const priceMode: PriceMode = args.includes('--current-prices') ? 'current' : 'actual';
  const numericArgs = args.filter((a) => !a.startsWith('--'));
  const days = Number(numericArgs[0]) || 15;
  const targets = numericArgs.slice(1).map(Number).filter((n) => n > 0);
  if (targets.length === 0) targets.push(0, 100, 200);

  const moscowNow = new Date(Date.now() + 3 * 3600 * 1000);
  const dateTo = new Date(`${moscowNow.toISOString().slice(0, 10)}T23:59:59+03:00`);
  const dateFrom = new Date(dateTo.getTime() - days * 86400_000);

  console.log(
    `\n🔍 Unit-economics: последние ${days} дней ` +
    `(${dateFrom.toISOString().slice(0, 10)} → ${dateTo.toISOString().slice(0, 10)} МСК)`,
  );
  console.log(priceMode === 'current'
    ? '   Режим: текущие цены карточек + расходы из отчёта'
    : '   Режим: фактическая цена реализации из отчёта');
  console.log(`   Целевой профит: ${targets.map((t) => `+${t}₽`).join(', ')} на единицу\n`);

  const [ops, currentPriceByOffer] = await Promise.all([
    fetchOzon(token, clientId, dateFrom, dateTo),
    fetchCurrentPrices(token, clientId),
  ]);
  console.log(`✅ ${ops.length} операций\n`);
  console.log(`✅ ${currentPriceByOffer.size} текущих цен из карточек\n`);

  const stats = computeUnitEconomics(ops, targets, currentPriceByOffer);
  printResults(stats, targets, days, priceMode);
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
