/**
 * Demo catalog. Replace with your offer ids, SKUs, and costs.
 * Real shop numbers are not published.
 */

export type ProductGroup = 'АБ' | 'АР' | 'АР-300' | 'Р';

export interface Product {
  offerId: string;
  sku?: number;
  cost: number;
  fixed: number;
  name: string;
  group: ProductGroup;
}

export const PRODUCTS: Product[] = [
  { offerId: 'DEMO-001', sku: 1000000001, cost: 500, fixed: 250, name: 'Sample album grey', group: 'АБ' },
  { offerId: 'DEMO-002', sku: 1000000002, cost: 500, fixed: 250, name: 'Sample album olive', group: 'АБ' },
  { offerId: 'DEMO-003', sku: 1000000003, cost: 420, fixed: 220, name: 'Sample frame silver', group: 'Р' },
];

export const COST_BY_OFFER: Record<string, number> = Object.fromEntries(
  PRODUCTS.map((p) => [p.offerId, p.cost]),
);

export const FIXED_BY_OFFER: Record<string, number> = Object.fromEntries(
  PRODUCTS.map((p) => [p.offerId, p.fixed]),
);

export const COST_BY_SKU: Record<number, number> = Object.fromEntries(
  PRODUCTS.filter((p) => p.sku !== undefined).map((p) => [p.sku!, p.cost]),
);

export const NAME_BY_OFFER: Record<string, string> = Object.fromEntries(
  PRODUCTS.map((p) => [p.offerId, `${p.offerId} ${p.name}`]),
);

export const SHORT_NAME_BY_OFFER: Record<string, string> = Object.fromEntries(
  PRODUCTS.map((p) => [p.offerId, p.name]),
);

export const OFFER_BY_SKU: Record<number, string> = Object.fromEntries(
  PRODUCTS.filter((p) => p.sku !== undefined).map((p) => [p.sku!, p.offerId]),
);

export const OFFER_IDS: string[] = PRODUCTS.map((p) => p.offerId);

export function avgFixedForGroup(group: ProductGroup): number {
  const items = PRODUCTS.filter((p) => p.group === group);
  if (!items.length) return 250;
  return Math.round(items.reduce((s, p) => s + p.fixed, 0) / items.length);
}
