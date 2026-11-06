/**
 * Shop switch. Credentials come from the environment, not from this file.
 */
export const ACTIVE_SHOP: 'main' | 'test' = 'main';

interface ShopSettings {
  name: string;
  clientId: string;
  defaultCost: number;
}

const SHOPS: Record<'main' | 'test', ShopSettings> = {
  main: {
    name: 'Main shop',
    clientId: process.env.OZON_SELLER_CLIENT_ID?.trim() || '',
    defaultCost: 0,
  },
  test: {
    name: 'Second shop',
    clientId:
      process.env.OZON_SELLER_CLIENT_ID_TEST?.trim() ||
      process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim() ||
      '',
    defaultCost: 0,
  },
};

export const activeShop: ShopSettings = SHOPS[ACTIVE_SHOP];

export function logActiveShop(): void {
  if (ACTIVE_SHOP !== 'main') {
    console.log(`\x1b[33mActive shop: ${activeShop.name} [${ACTIVE_SHOP}]\x1b[0m`);
  }
}
