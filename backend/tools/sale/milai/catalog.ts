/**
 * Demo catalog for a second shop. Replace with your SKUs and costs.
 */

export interface MilaiProduct {
  sku: number;
  buyout: number;
  cost: number;
  hint?: string;
}

export const MILAI_PRODUCTS: MilaiProduct[] = [
  { sku: 2000000001, buyout: 0.7, cost: 400, hint: 'Sample cross-body' },
  { sku: 2000000002, buyout: 0.65, cost: 450, hint: 'Sample shopper' },
];

export const MILAI_BY_SKU: Map<number, MilaiProduct> = new Map(
  MILAI_PRODUCTS.map((p) => [p.sku, p]),
);
