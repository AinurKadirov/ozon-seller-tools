/**
 * logistics.ts — оценка стоимости логистики FBO по формуле Ozon (с 06.04.2026).
 *
 * Логистика FBO = базовый тариф + доставка до места выдачи + наценка за нелокальность.
 *
 *   - Базовый тариф зависит от объёма/направления (берём из карточки товара:
 *     commissions.fbo_direct_flow_trans_min_amount — базовая прямая логистика).
 *   - Доставка до места выдачи («последняя миля») — не более 25 ₽
 *     (commissions.fbo_deliv_to_customer_amount).
 *   - Наценка за нелокальную продажу — % от ЦЕНЫ товара, зависит от кластера
 *     НАЗНАЧЕНИЯ. Применяется только если заказ нелокальный (товара нет на складе
 *     в кластере покупателя ⇒ cluster_from ≠ cluster_to).
 *
 * Локальность определяем напрямую по financial_data: cluster_from vs cluster_to.
 * Наценка не применяется к отменам/невыкупам и если < 50 FBO-заказов за 7 дней
 * (для нашего магазина их больше, поэтому считаем, что наценка действует).
 *
 * Источник таблицы наценок: тарифы Ozon с изменениями от 01.05.2026.
 */

/** Наценка за нелокальный заказ по кластеру НАЗНАЧЕНИЯ (доля от цены товара). */
export const NON_LOCAL_SURCHARGE: Record<string, number> = {
  'Омск': 0.12,
  'Оренбург': 0.12,
  'Пермь': 0.12,
  'Самара': 0.12,
  'Воронеж': 0.08,
  'Дальний Восток': 0.08,
  'Екатеринбург': 0.08,
  'Казань': 0.08,
  'Калининград': 0.08,
  'Краснодар': 0.08,
  'Махачкала': 0.08,
  'Москва, МО и Дальние регионы': 0.08,
  'Невинномысск': 0.08,
  'Санкт-Петербург и СЗО': 0.08,
  'Саратов': 0.08,
  'Тверь': 0.08,
  'Тюмень': 0.08,
  'Уфа': 0.08,
  'Ярославль': 0.08,
  'Алматы': 0.06,
  'Астана': 0.06,
  'Беларусь': 0.06,
  'Азербайджан': 0,
  'Армения': 0,
  'Грузия': 0,
  'Красноярск': 0,
  'Кыргызстан': 0,
  'Новосибирск': 0,
  'Ростов': 0,
  'Узбекистан': 0,
};

/** Наценка по умолчанию для незнакомого кластера (медиана таблицы). */
export const DEFAULT_SURCHARGE = 0.08;
/** Базовая прямая логистика по умолчанию, если нет данных в карточке. */
export const DEFAULT_BASE_LOGISTICS = 80;
/** Доставка до места выдачи по умолчанию (не более 25 ₽). */
export const DEFAULT_LAST_MILE = 25;

export interface LogisticsBreakdown {
  base: number;        // базовый тариф прямой логистики
  lastMile: number;    // доставка до места выдачи
  surchargeRate: number; // ставка наценки (доля), 0 если локальный
  surcharge: number;   // наценка в рублях
  total: number;       // итого логистика на единицу
  isLocal: boolean;
}

export interface LogisticsCardData {
  /** commissions.fbo_direct_flow_trans_min_amount из /v5/product/info/prices */
  baseDirectFlow?: number;
  /** commissions.fbo_deliv_to_customer_amount */
  lastMile?: number;
}

/**
 * Оценивает логистику на ОДНУ единицу товара.
 *
 * @param price       цена товара в заказе (после скидок), ₽
 * @param clusterFrom кластер отгрузки (financial_data.cluster_from)
 * @param clusterTo   кластер назначения (financial_data.cluster_to)
 * @param card        тарифы из карточки товара (опционально)
 */
export function estimateLogistics(
  price: number,
  clusterFrom: string | undefined,
  clusterTo: string | undefined,
  card?: LogisticsCardData,
): LogisticsBreakdown {
  const base = card?.baseDirectFlow && card.baseDirectFlow > 0 ? card.baseDirectFlow : DEFAULT_BASE_LOGISTICS;
  const lastMile = card?.lastMile && card.lastMile > 0 ? card.lastMile : DEFAULT_LAST_MILE;

  // Локальный заказ (cluster_from == cluster_to) → наценки нет.
  const isLocal = !!clusterFrom && !!clusterTo && clusterFrom === clusterTo;
  const surchargeRate = isLocal
    ? 0
    : (clusterTo !== undefined && clusterTo in NON_LOCAL_SURCHARGE
        ? NON_LOCAL_SURCHARGE[clusterTo]
        : DEFAULT_SURCHARGE);
  const surcharge = +(price * surchargeRate).toFixed(2);

  return {
    base,
    lastMile,
    surchargeRate,
    surcharge,
    total: +(base + lastMile + surcharge).toFixed(2),
    isLocal,
  };
}
