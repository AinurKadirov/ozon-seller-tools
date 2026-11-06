/**
 * economics.ts — финансовая модель MILAI для НОВОГО магазина без продаж.
 *
 * Всё считается «технически»: ставки берём из карточек Ozon (комиссия, тарифы
 * логистики, эквайринг), а процент выкупа — из catalog.ts. Никаких транзакций.
 *
 * ─── Как формула учитывает выкуп ────────────────────────────────────────────
 * Чтобы получить 1 ВЫКУПЛЕННУЮ единицу, в среднем нужно отгрузить 1/p отправлений
 * (p = доля выкупа). Из них (1/p − 1) вернутся (невыкуп). На каждом:
 *   - отгрузка (прямая логистика + последняя миля) платится ВСЕГДА → (1/p)·Lпрям;
 *   - возвратная логистика платится за каждый невыкуп → (1/p − 1)·Lвозврат.
 * Комиссия, налог и эквайринг — это % от цены и берутся только с выкупа
 * (на возврате Ozon их возвращает), себестоимость тоже «горит» только на выкупе
 * (возвращённый товар приходит обратно на склад и перепродаётся).
 *
 *   Прибыль/шт = Цена·M − Себестоимость − ЛогистикаНаВыкуп
 *   где  M = 1 − Комиссия% − Налог% − Эквайринг% − Наценка%
 *        ЛогистикаНаВыкуп = (1/p)·Lпрям + (1/p − 1)·Lвозврат
 *
 *   ⇒  Цена = (Себестоимость + ЛогистикаНаВыкуп + ЦельПрибыли) / M
 *   ⇒  Безубыток = Цена при ЦельПрибыли = 0
 */

export const DEFAULT_TAX_RATE = 0.07;       // УСН «доходы» 7%
export const DEFAULT_ACQUIRING_RATE = 0.01; // эквайринг Ozon ≈ 1% от цены

export interface PricingInputs {
  cost: number;             // себестоимость, ₽
  buyout: number;           // доля выкупа 0..1
  commissionRate: number;   // доля, напр. 0.48 (FBO) или 0.53 (FBS)
  forwardLogistics: number; // ₽ за отправление: прямая логистика + последняя миля
  returnLogistics: number;  // ₽ за невыкуп: возвратная логистика
  taxRate?: number;         // по умолчанию 0.07
  acquiringRate?: number;   // по умолчанию 0.01
  /** Наценка за нелокальность (доля от цены). По умолчанию 0 — задаётся вручную. */
  surchargeRate?: number;
}

export interface Pricing {
  multiplier: number;       // сколько остаётся с рубля цены (M)
  logiCostPerSale: number;  // логистика на 1 выкупленную единицу (с учётом невыкупов), ₽
  breakEven: number;        // минимальная цена для нулевой прибыли, ₽
  /** Цена под заданную целевую прибыль на единицу, ₽ (округление вверх). */
  priceForProfit: (targetProfit: number) => number;
  /** Прибыль на единицу при заданной цене продажи, ₽. */
  profitAtPrice: (price: number) => number;
}

export function computePricing(input: PricingInputs): Pricing {
  const taxRate = input.taxRate ?? DEFAULT_TAX_RATE;
  const acquiringRate = input.acquiringRate ?? DEFAULT_ACQUIRING_RATE;
  const surchargeRate = input.surchargeRate ?? 0;

  const multiplier = 1 - input.commissionRate - taxRate - acquiringRate - surchargeRate;
  const p = input.buyout > 0 ? input.buyout : 1;

  const logiCostPerSale =
    (1 / p) * input.forwardLogistics + (1 / p - 1) * input.returnLogistics;

  const priceForProfit = (targetProfit: number): number => {
    if (multiplier <= 0) return 0;
    return Math.ceil((input.cost + logiCostPerSale + targetProfit) / multiplier);
  };

  const profitAtPrice = (price: number): number =>
    price * multiplier - input.cost - logiCostPerSale;

  return {
    multiplier,
    logiCostPerSale,
    breakEven: priceForProfit(0),
    priceForProfit,
    profitAtPrice,
  };
}
