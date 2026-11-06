/**
 * economics.ts — финансовая модель магазина.
 *
 * Единое место для ставок, формул безубытка/целевой цены и расчёта P&L
 * из транзакций Ozon. Используется отчётами (daily/weekly) и скриптами цен.
 */
import { COST_BY_OFFER, FIXED_BY_OFFER, COST_BY_SKU, OFFER_BY_SKU, SHORT_NAME_BY_OFFER } from './catalog';
import { activeShop } from './shop-config';

// ─── Ставки ───────────────────────────────────────────────────────────────────
export const COMM_RATE = 0.52; // комиссия Ozon FBO (карточки Seller API, сент. 2026)
export const TAX_RATE  = 0.07; // УСН «доходы» 7% (Москва)
export const NET_RATE  = 1 - COMM_RATE - TAX_RATE; // 0.41 — сколько остаётся с рубля цены

// ─── Ценообразование ────────────────────────────────────────────────────────
// Цена = (Себестоимость + ФиксРасходы + ЦельПрибыли) / NET_RATE
//   targetProfit = 0   → безубыток
//   targetProfit = 150 → минимальная цена для +150 ₽/шт
export function priceForProfit(offerId: string, targetProfit: number): number {
  const cost  = COST_BY_OFFER[offerId];
  const fixed = FIXED_BY_OFFER[offerId];
  if (cost === undefined || fixed === undefined) return 0;
  return Math.ceil((cost + fixed + targetProfit) / NET_RATE);
}

export const breakEvenPrice = (offerId: string): number => priceForProfit(offerId, 0);

/** Цена под целевую прибыль с заложенным ДРР (% от цены уходит на рекламу). */
export function priceForProfitWithDrr(offerId: string, targetProfit: number, drrPercent: number): number {
  const cost  = COST_BY_OFFER[offerId];
  const fixed = FIXED_BY_OFFER[offerId];
  if (cost === undefined || fixed === undefined) return 0;
  const ACQ = 0.01; // эквайринг ≈ 1%
  const denom = NET_RATE - ACQ - drrPercent / 100;
  if (denom <= 0) return 0;
  return Math.ceil((cost + fixed + targetProfit) / denom);
}

// ─── Классификация операций finance API ──────────────────────────────────────
export const ADS_OPERATION_TYPES = new Set([
  'OperationMarketplaceCostPerClick',   // оплата за клик
  'OperationPromotionWithCostPerOrder', // продвижение за заказ
  'StarsMembership',                    // звёздные товары
  'OperationAgentCampaign',
  'CampaignPayment',
]);

export const LOGISTICS_SERVICES = new Set([
  'MarketplaceServiceItemDirectFlowLogistic',
  'MarketplaceServiceItemReturnFlowLogistic',
  'MarketplaceServiceItemFlowLogistic',
  'MarketplaceServiceItemRedistributionLastMileCourier',
  'MarketplaceServiceItemReturnAfterDeliveryLogistic',
  'MarketplaceServiceItemDeliveryToPoint',
  'MarketplaceServiceItemDropshipDirectFlowLogistic',
]);

export const STOCK_RETURN_OPERATION_TYPES = new Set([
  'OperationSellerReturnsCargoAssortmentValid', // подготовка товара к вывозу со склада Ozon
  'SellerReturnsDeliveryToPickupPoint',         // вывоз товара со склада Ozon до ПВЗ
]);

// ─── Типы ───────────────────────────────────────────────────────────────────
export interface OzonOperation {
  operation_id: number;
  operation_type: string;
  operation_date: string;
  accruals_for_sale: number;
  sale_commission: number;
  amount: number;
  type: string;
  items: Array<{ name: string; sku: number }>;
  services: Array<{ name: string; price: number }>;
  posting?: { posting_number?: string };
}

export interface DayStat {
  dateStr: string;
  revenue: number;
  soldCount: number;
  returnCount: number;
  cancelCount: number;
  returnRevenue: number;
  commission: number;
  logistics: number;
  returnLogistics: number;
  acquiring: number;
  ads: number;
  storage: number;
  otherServices: number;
  stockReturnServices: number;
  costPriceTotal: number;
  tax: number;
  netProfit: number;
  netProfitAfterStockReturn: number;
  marginPercent: number;
  drrPercent: number;
  opsCount: number;
}

/**
 * Считает P&L за один московский день из списка транзакций Ozon.
 * Единая логика для daily- и weekly-отчёта — гарантирует одинаковые цифры.
 */
export function computeDayPnl(ops: OzonOperation[], targetDate: string): DayStat {
  const dayOps = ops.filter((o) => o.operation_date.startsWith(targetDate));

  let revenue = 0, soldCount = 0, returnCount = 0, cancelCount = 0;
  let returnRevenue = 0, commission = 0, logistics = 0, returnLogistics = 0;
  let acquiring = 0, ads = 0, storage = 0, otherServices = 0, stockReturnServices = 0, costPriceTotal = 0;

  for (const op of dayOps) {
    if (op.type === 'orders') {
      for (const svc of op.services) {
        if (LOGISTICS_SERVICES.has(svc.name)) logistics += svc.price;
      }
      if (op.accruals_for_sale <= 0) continue;

      revenue += op.accruals_for_sale;
      commission += op.sale_commission;
      soldCount++;

      const sku = op.items[0]?.sku;
      const unitCost = sku !== undefined
        ? (COST_BY_SKU[sku] ?? activeShop.defaultCost)
        : activeShop.defaultCost;
      if (unitCost > 0) costPriceTotal += unitCost;
    } else if (op.type === 'returns') {
      if (op.accruals_for_sale !== 0) {
        returnCount++;
        returnRevenue += op.accruals_for_sale;
        commission += op.sale_commission;
        for (const svc of op.services) {
          if (LOGISTICS_SERVICES.has(svc.name)) returnLogistics += svc.price;
        }
        // Товар вернулся на склад → убираем его себестоимость из расходов
        const returnSku = op.items[0]?.sku;
        const returnCost = returnSku !== undefined
          ? (COST_BY_SKU[returnSku] ?? activeShop.defaultCost)
          : activeShop.defaultCost;
        if (returnCost > 0) costPriceTotal -= returnCost;
      } else {
        cancelCount++;
        returnLogistics += op.amount;
      }
    } else if (op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation') {
      acquiring += op.amount;
    } else if (ADS_OPERATION_TYPES.has(op.operation_type)) {
      ads += op.amount;
    } else if (STOCK_RETURN_OPERATION_TYPES.has(op.operation_type)) {
      stockReturnServices += op.amount;
    } else if (/storage|Storage|Placement|placement/i.test(op.operation_type)) {
      storage += op.amount;
    } else {
      otherServices += op.amount;
    }
  }

  const grossRevenue = revenue + returnRevenue;
  const tax = +(Math.max(0, grossRevenue) * TAX_RATE).toFixed(2);
  const netProfit = +(
    grossRevenue + commission + logistics + returnLogistics +
    acquiring + ads + storage + otherServices - costPriceTotal - tax
  ).toFixed(2);
  const netProfitAfterStockReturn = +(netProfit + stockReturnServices).toFixed(2);
  const marginPercent = revenue > 0 ? +((netProfit / revenue) * 100).toFixed(1) : 0;
  const drrPercent = revenue > 0 && Math.abs(ads) > 0 ? +((-ads / revenue) * 100).toFixed(1) : 0;

  return {
    dateStr: targetDate,
    revenue: +revenue.toFixed(2),
    soldCount, returnCount, cancelCount,
    returnRevenue: +returnRevenue.toFixed(2),
    commission: +commission.toFixed(2),
    logistics: +logistics.toFixed(2),
    returnLogistics: +returnLogistics.toFixed(2),
    acquiring: +acquiring.toFixed(2),
    ads: +ads.toFixed(2),
    storage: +storage.toFixed(2),
    otherServices: +otherServices.toFixed(2),
    stockReturnServices: +stockReturnServices.toFixed(2),
    costPriceTotal: +costPriceTotal.toFixed(2),
    tax, netProfit, netProfitAfterStockReturn, marginPercent, drrPercent,
    opsCount: dayOps.length,
  };
}

// ─── P&L по каждому товару за день ────────────────────────────────────────────
export interface ProductStat {
  offerId: string;
  name: string;
  soldCount: number;
  returnCount: number;
  profitPerUnit: number; // прибыль на 1 проданную единицу (с учётом доли рекламы/налога)
  totalProfit: number;   // суммарная прибыль по товару за день
}

/**
 * Считает прибыль по каждому проданному товару за московский день.
 *
 * Прямые расходы (комиссия, логистика, себестоимость) берутся по операциям
 * конкретного SKU. Общие расходы магазина (реклама, эквайринг, хранение, прочее)
 * и налог распределяются пропорционально выручке товара — поэтому сумма totalProfit
 * по всем товарам сходится с netProfit основного отчёта (с точностью до возвратов).
 */
export function computeProductPnl(ops: OzonOperation[], targetDate: string): ProductStat[] {
  const dayOps = ops.filter((o) => o.operation_date.startsWith(targetDate));

  interface Bucket {
    /** Прямой финрез по товару (без распределяемых общих расходов и налога). */
    direct: number;
    soldCount: number;
    returnCount: number;
    soldRevenue: number; // выручка с проданных единиц — база для распределения общих расходов
  }
  const bySku = new Map<number, Bucket>();
  const bucket = (sku: number): Bucket => {
    let b = bySku.get(sku);
    if (!b) { b = { direct: 0, soldCount: 0, returnCount: 0, soldRevenue: 0 }; bySku.set(sku, b); }
    return b;
  };

  let ads = 0, acquiring = 0, storage = 0, otherServices = 0;
  let grossRevenue = 0, totalSoldRevenue = 0;

  for (const op of dayOps) {
    if (op.type === 'orders') {
      const sku = op.items[0]?.sku;
      if (sku === undefined) continue;
      const b = bucket(sku);
      for (const svc of op.services) {
        if (LOGISTICS_SERVICES.has(svc.name)) b.direct += svc.price;
      }
      if (op.accruals_for_sale <= 0) continue;
      const unitCost = COST_BY_SKU[sku] ?? activeShop.defaultCost;
      b.direct += op.accruals_for_sale + op.sale_commission - (unitCost > 0 ? unitCost : 0);
      b.soldRevenue += op.accruals_for_sale;
      b.soldCount++;
      grossRevenue += op.accruals_for_sale;
      totalSoldRevenue += op.accruals_for_sale;
    } else if (op.type === 'returns') {
      const sku = op.items[0]?.sku;
      const b = sku !== undefined ? bucket(sku) : undefined;
      if (op.accruals_for_sale !== 0) {
        // Реальный возврат с деньгами — считаем как «возврат шт.».
        if (b) {
          b.returnCount++;
          b.direct += op.accruals_for_sale + op.sale_commission;
          for (const svc of op.services) {
            if (LOGISTICS_SERVICES.has(svc.name)) b.direct += svc.price;
          }
          const returnCost = sku !== undefined ? (COST_BY_SKU[sku] ?? activeShop.defaultCost) : 0;
          if (returnCost > 0) b.direct += returnCost; // товар вернулся на склад → возвращаем себестоимость
        }
        grossRevenue += op.accruals_for_sale;
      } else if (b) {
        // accruals == 0: сборы за обработку невыкупа/отмены (несколько строк на одно событие).
        // В счётчик возвратов не идёт, но стоимость уменьшает прибыль товара.
        b.direct += op.amount;
      }
    } else if (op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation') {
      acquiring += op.amount;
    } else if (ADS_OPERATION_TYPES.has(op.operation_type)) {
      ads += op.amount;
    } else if (STOCK_RETURN_OPERATION_TYPES.has(op.operation_type)) {
      // Разовый вывоз товара со склада Ozon не распределяем по SKU дневной маржи.
    } else if (/storage|Storage|Placement|placement/i.test(op.operation_type)) {
      storage += op.amount;
    } else {
      otherServices += op.amount;
    }
  }

  const accountCosts = ads + acquiring + storage + otherServices; // отрицательные числа
  const tax = Math.max(0, grossRevenue) * TAX_RATE;

  const result: ProductStat[] = [];
  for (const [sku, b] of bySku) {
    if (b.soldCount === 0 && b.returnCount === 0) continue;
    const offerId = OFFER_BY_SKU[sku] ?? String(sku);
    const name = SHORT_NAME_BY_OFFER[offerId] ?? `SKU ${sku}`;
    // Общие расходы и налог распределяем пропорционально выручке проданных единиц.
    const revShare = totalSoldRevenue > 0 ? b.soldRevenue / totalSoldRevenue : 0;
    const totalProfit = b.direct + accountCosts * revShare - tax * revShare;
    result.push({
      offerId,
      name,
      soldCount: b.soldCount,
      returnCount: b.returnCount,
      profitPerUnit: b.soldCount > 0 ? +(totalProfit / b.soldCount).toFixed(0) : 0,
      totalProfit: +totalProfit.toFixed(0),
    });
  }

  return result.sort((a, b) => a.totalProfit - b.totalProfit); // убыточные сверху
}
