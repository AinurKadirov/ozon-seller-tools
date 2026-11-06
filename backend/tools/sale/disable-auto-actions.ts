/**
 * disable-auto-actions.ts — снять флаги авто-участия в акциях.
 *
 * Выключает auto_action_enabled и auto_add_to_ozon_actions_list_enabled
 * у всех товаров, где они включены. После этого Ozon не сможет сам снижать
 * цены и добавлять товары в свои акции.
 *
 * Ozon периодически (~раз в 30 дней) включает эти флаги обратно — запускайте
 * скрипт регулярно. Требует роль «Товары и цены» на API-ключе.
 *
 * DRY-RUN по умолчанию. Для применения: -- --apply
 * Магазины: --shop main | milai | all  (по умолчанию all)
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  fetchAllPrices,
  importPrices,
  setOzonCredsOverride,
  PriceUpdate,
  PriceItem,
} from './lib/ozon';
import { pad } from './lib/format';

const repoRoot = join(__dirname, '../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

const APPLY = process.argv.includes('--apply');
const shopArg = (process.argv.find((a) => a.startsWith('--shop=')) ?? '--shop=all')
  .slice('--shop='.length)
  .toLowerCase();

type Shop = { name: string; clientId: string; apiKey: string };

function shops(): Shop[] {
  const all: Shop[] = [];
  const mainId = process.env.OZON_SELLER_CLIENT_ID?.trim();
  const mainKey = process.env.OZON_SELLER_API_KEY?.trim();
  const milaiId = process.env.OZON_SELLER_CLIENT_ID_MILAI?.trim();
  const milaiKey = process.env.OZON_SELLER_API_KEY_MILAI?.trim();
  if (shopArg === 'main' || shopArg === 'all') {
    if (!mainId || !mainKey) throw new Error('Нет OZON_SELLER_CLIENT_ID / OZON_SELLER_API_KEY');
    all.push({ name: 'Lumos', clientId: mainId, apiKey: mainKey });
  }
  if (shopArg === 'milai' || shopArg === 'all') {
    if (!milaiId || !milaiKey) throw new Error('Нет OZON_SELLER_CLIENT_ID_MILAI / OZON_SELLER_API_KEY_MILAI');
    all.push({ name: 'Milai', clientId: milaiId, apiKey: milaiKey });
  }
  if (!all.length) throw new Error(`Неизвестный --shop=${shopArg} (main|milai|all)`);
  return all;
}

async function disableShop(shop: Shop): Promise<{ ok: number; skipped: number; failed: number }> {
  setOzonCredsOverride({ clientId: shop.clientId, apiKey: shop.apiKey });
  console.log(`\n── ${shop.name} ──`);
  const items = await fetchAllPrices();
  console.log(`Загружено ${items.length} товаров`);

  const already: string[] = [];
  const toDisable: PriceItem[] = [];
  for (const it of items) {
    if (it.price?.auto_action_enabled || it.price?.auto_add_to_ozon_actions_list_enabled) toDisable.push(it);
    else already.push(it.offer_id);
  }

  if (already.length) console.log(`Уже выключены (${already.length} шт)`);
  if (!toDisable.length) {
    console.log('Нечего выключать — у всех товаров auto_action уже отключён.');
    return { ok: 0, skipped: already.length, failed: 0 };
  }

  console.log(`Требуют отключения (${toDisable.length} шт):`);
  console.log(pad('Артикул', 28) + pad('Цена', 8, true) + pad('autoAction', 12, true) + pad('autoAddAll', 12, true));
  console.log('─'.repeat(60));
  for (const it of toDisable.sort((a, b) => a.offer_id.localeCompare(b.offer_id))) {
    console.log(
      pad(it.offer_id, 28) +
      pad((it.price?.price ?? '') + '₽', 8, true) +
      pad(it.price?.auto_action_enabled ? 'ВКЛ' : 'выкл', 12, true) +
      pad(it.price?.auto_add_to_ozon_actions_list_enabled ? 'ВКЛ' : 'выкл', 12, true),
    );
  }

  if (!APPLY) {
    console.log('▶  DRY-RUN — для применения добавьте --apply');
    return { ok: 0, skipped: already.length, failed: 0 };
  }

  const updates: PriceUpdate[] = toDisable.map((it) => ({
    offer_id: it.offer_id,
    price: String(it.price?.price ?? 0),
    old_price: String(it.price?.old_price ?? 0),
    min_price: String(it.price?.min_price ?? 0),
    auto_action_enabled: 'DISABLED',
    auto_add_to_ozon_actions_list_enabled: 'DISABLED',
    min_price_for_auto_actions_enabled: false,
    currency_code: 'RUB',
  }));

  const res = await importPrices(updates);
  if (res.error) {
    console.error(`Ошибка API: ${res.error}\n   Вероятно, нет роли «Товары и цены» на ключе.`);
    return { ok: 0, skipped: already.length, failed: toDisable.length };
  }
  if (res.failed.length) {
    console.error('Ошибки:');
    for (const f of res.failed) console.error(`   ${f.offer_id}: ${f.message}`);
  }
  console.log(`auto_action выключен у ${res.okCount} товаров`);
  return { ok: res.okCount, skipped: already.length, failed: res.failed.length };
}

async function main(): Promise<void> {
  console.log(APPLY
    ? 'APPLY: выключаем auto_action на Ozon...'
    : 'DRY-RUN (для применения добавьте --apply)');
  console.log(`Магазины: ${shopArg}`);

  const totals = { ok: 0, skipped: 0, failed: 0 };
  for (const shop of shops()) {
    const r = await disableShop(shop);
    totals.ok += r.ok;
    totals.skipped += r.skipped;
    totals.failed += r.failed;
  }
  setOzonCredsOverride(null);

  console.log(`\nИтого: выключено ${totals.ok}, уже было выкл. ${totals.skipped}, ошибок ${totals.failed}`);
  if (!APPLY) console.log('\nЗапустите: npm run ozon:disable-auto-actions -- --apply --shop=all');
  else if (totals.failed) process.exit(1);
  else console.log('Готово. Ozon больше не будет сам добавлять эти товары в акции.');
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
