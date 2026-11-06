/**
 * monitor-promos.ts — мониторинг акций Ozon.
 *
 * Что делает:
 *   1. Показывает все активные акции с товарами и маржой по каждой позиции
 *   2. Находит убыточные позиции (акц.цена < безубыток)
 *   3. Выводит товары из убыточных акций (нужна роль «Акции» на ключе)
 *   4. Показывает статус auto_action
 *   5. Отправляет сводку в Telegram
 *
 * Выход из акции происходит, если прибыль на единицу по акционной цене ниже
 * целевого порога MIN_PROMO_PROFIT (а не только при формальном убытке). Это
 * нужно потому, что сверх акционной цены Ozon снимает ещё ~60 ₽/шт баллами за
 * счёт продавца — поэтому «тонкие» участия (+1…+60 ₽ по модели) по факту уходят
 * в минус. Порог по умолчанию покрывает этот зазор.
 *
 * Запуск:
 *   npm run ozon:monitor-promos                  — отчёт + выход из неприбыльных + Telegram
 *   npm run ozon:monitor-promos -- --dry         — только мониторинг (без выхода), с отправкой в Telegram
 *   npm run ozon:monitor-promos -- --no-exit     — только мониторинг + Telegram (без изменений в акциях)
 *   npm run ozon:monitor-promos -- --no-telegram — только консоль, без Telegram
 *   npm run ozon:monitor-promos -- --no-exit --no-telegram  — read-only для отчёта агента
 *   npm run ozon:monitor-promos -- --min-profit 150  — свой порог целевой прибыли (₽/шт)
 *   npm run ozon:monitor-promos -- --join АР-006   — добавить товар в выгодную акцию
 */
import { breakEvenPrice, NET_RATE } from './lib/economics';
import { COST_BY_OFFER, FIXED_BY_OFFER, NAME_BY_OFFER } from './lib/catalog';
import { buildPidMap, fetchAllPrices, fetchActions, fetchActionProducts, fetchActionCandidates, deactivateActionProducts, activateActionProducts } from './lib/ozon';
import { sendHtml } from './lib/telegram';
import { escapeHtml as esc, moscowNow } from './lib/format';
import { logActiveShop, activeShop } from './lib/shop-config';

const DRY = process.argv.includes('--dry');
const NO_EXIT = process.argv.includes('--no-exit');
const NO_TELEGRAM = process.argv.includes('--no-telegram');
const joinIdx = process.argv.indexOf('--join');
const JOIN_OFFER = joinIdx >= 0 ? process.argv[joinIdx + 1] : null;

// Минимальная прибыль на единицу (₽), при которой остаёмся в акции.
// Ниже порога — выходим. Дефолт 100 ₽ ≈ запас на баллы Ozon (~60 ₽) + маржа.
const mpIdx = process.argv.indexOf('--min-profit');
const MIN_PROMO_PROFIT = mpIdx >= 0 && Number(process.argv[mpIdx + 1]) > 0
  ? Number(process.argv[mpIdx + 1])
  : 100;

/** Прибыль на единицу при данной цене (с учётом fixed-расходов). */
function profitAtPrice(offerId: string, price: number): number {
  const cost  = COST_BY_OFFER[offerId] ?? 0;
  const fixed = FIXED_BY_OFFER[offerId] ?? 0;
  return Math.round(price * NET_RATE - cost - fixed);
}

/** Иконка прибыльности относительно целевого порога. */
function marginIcon(profit: number): string {
  if (profit >= MIN_PROMO_PROFIT) return '✅';
  if (profit >= 0)                return '🟡';
  return '🔴';
}

async function main(): Promise<void> {
  logActiveShop();
  const modeParts = [DRY && 'DRY', NO_EXIT && 'NO-EXIT', NO_TELEGRAM && 'NO-TELEGRAM'].filter(Boolean);
  const modeLabel = modeParts.length ? `  (${modeParts.join(', ')})` : '';
  console.log(`🔍 Мониторинг акций Ozon [${activeShop.name}]...${modeLabel}`);

  const [pidMap, priceItems] = await Promise.all([buildPidMap(), fetchAllPrices()]);
  const autoActionByOffer = new Map<string, boolean>();
  const currentPriceByOffer = new Map<string, number>();
  for (const it of priceItems) {
    autoActionByOffer.set(it.offer_id, Boolean(it.price?.auto_action_enabled && it.price?.auto_add_to_ozon_actions_list_enabled));
    currentPriceByOffer.set(it.offer_id, Number(it.price?.price ?? 0));
  }

  const actions = await fetchActions();

  // ─── Структура для сбора всех акций с товарами ────────────────────────────
  interface PromoItem {
    offerId: string;
    actionPrice: number;
    profit: number;
    breakEven: number;
    isLoss: boolean;
    pid: number;
  }
  interface PromoStat {
    title: string;
    id: number;
    items: PromoItem[];
    lossCount: number;
    profitCount: number;
  }

  const activePromos: PromoStat[] = [];
  const lossLines: string[] = [];
  const exitedLines: string[] = [];

  for (const action of actions) {
    const prods = await fetchActionProducts(action.id);
    if (!prods.length) continue;

    const promoItems: PromoItem[] = [];
    const toExit: number[] = [];

    for (const p of prods) {
      const pid = Number(p.id ?? p.product_id);
      const offerId = pidMap.get(pid);
      if (!offerId || COST_BY_OFFER[offerId] === undefined) continue;

      const actionPrice = Number(p.action_price ?? p.price ?? 0);
      if (!actionPrice) continue;

      const be = breakEvenPrice(offerId);
      const profit = profitAtPrice(offerId, actionPrice);
      const belowTarget = profit < MIN_PROMO_PROFIT;

      promoItems.push({ offerId, actionPrice, profit, breakEven: be, isLoss: belowTarget, pid });

      if (belowTarget) {
        const profitStr = profit >= 0 ? `+${profit}` : `${profit}`;
        lossLines.push(`  • <b>${esc(offerId)}</b> в «${esc(action.title.slice(0, 30))}»: ${actionPrice}₽ → <b>${profitStr}₽/шт</b> (цель +${MIN_PROMO_PROFIT}₽, безубыток ${be}₽)`);
        toExit.push(pid);
      }
    }

    if (!promoItems.length) continue;

    activePromos.push({
      title: action.title,
      id: action.id,
      items: promoItems,
      lossCount: promoItems.filter(i => i.isLoss).length,
      profitCount: promoItems.filter(i => !i.isLoss).length,
    });

    if (toExit.length && !DRY && !NO_EXIT) {
      const ok = await deactivateActionProducts(action.id, toExit);
      exitedLines.push(ok
        ? `  ✅ Вышли из «${esc(action.title.slice(0, 35))}»: ${toExit.length} шт`
        : `  ⚠️  «${esc(action.title.slice(0, 35))}»: нужна роль «Акции» на API-ключе`);
    } else if (toExit.length && DRY) {
      exitedLines.push(`  ▶ DRY: вышли бы из «${esc(action.title.slice(0, 35))}»: ${toExit.length} шт`);
    } else if (toExit.length && NO_EXIT) {
      exitedLines.push(`  ℹ️ NO-EXIT: найдено для выхода в «${esc(action.title.slice(0, 35))}»: ${toExit.length} шт`);
    }
  }

  const autoOn  = [...autoActionByOffer].filter(([, on]) => on).map(([o]) => o);
  const autoOff = [...autoActionByOffer].filter(([, on]) => !on).map(([o]) => o);

  // ─── Кандидаты: товары которые могут вступить, но ещё не в акции ──────────
  interface CandidateItem {
    offerId: string;
    pid: number;
    maxPromoPrice: number;
    currentPrice: number;
    profitAtMax: number;
    profitAtCurrent: number;
  }
  interface CandidatePromo {
    id: number;
    title: string;
    items: CandidateItem[];
    profitableCount: number;
  }
  const candidatePromos: CandidatePromo[] = [];

  for (const action of actions) {
    const candidates = await fetchActionCandidates(action.id);
    if (!candidates.length) continue;

    const items: CandidateItem[] = [];
    for (const p of candidates) {
      const pid = Number(p.id ?? p.product_id);
      const offerId = pidMap.get(pid);
      if (!offerId || COST_BY_OFFER[offerId] === undefined) continue;

      const maxPromoPrice = Number(p.max_action_price ?? 0);
      const currentPrice  = currentPriceByOffer.get(offerId) ?? 0;
      if (!maxPromoPrice) continue;

      items.push({
        offerId,
        pid,
        maxPromoPrice,
        currentPrice,
        profitAtMax:     profitAtPrice(offerId, maxPromoPrice),
        profitAtCurrent: profitAtPrice(offerId, currentPrice),
      });
    }

    if (!items.length) continue;
    candidatePromos.push({
      id: action.id,
      title: action.title,
      items,
      profitableCount: items.filter(i => i.profitAtMax >= MIN_PROMO_PROFIT).length,
    });
  }

  // ─── Добавление товара в акцию (--join) ───────────────────────────────────
  if (JOIN_OFFER) {
    const opts = candidatePromos.flatMap((p) =>
      p.items
        .filter((i) => i.offerId === JOIN_OFFER && i.profitAtMax >= MIN_PROMO_PROFIT)
        .map((i) => ({ promo: p, item: i })),
    );
    if (!opts.length) {
      console.error(`\n❌ ${JOIN_OFFER}: нет выгодной акции (порог +${MIN_PROMO_PROFIT}₽/шт)\n`);
      process.exit(1);
    }
    const best = opts.sort((a, b) => b.item.profitAtMax - a.item.profitAtMax)[0];
    const { promo, item } = best;
    console.log(`\n➕ Добавляю ${item.offerId} в «${promo.title.slice(0, 45)}»`);
    console.log(`   Акц. цена: ${item.maxPromoPrice}₽ → +${item.profitAtMax}₽/шт (текущая ${item.currentPrice}₽)\n`);
    const { activated, rejected } = await activateActionProducts(promo.id, [
      { product_id: item.pid, action_price: item.maxPromoPrice },
    ]);
    if (activated.includes(item.pid)) {
      console.log(`✅ ${item.offerId} добавлен в акцию (id ${promo.id})`);
    } else {
      console.error(`❌ Не удалось добавить: ${JSON.stringify(rejected)}`);
      console.error('   Проверь роль «Акции» на API-ключе');
      process.exit(1);
    }
    if (!NO_TELEGRAM) {
      await sendHtml(`✅ <b>${esc(item.offerId)}</b> добавлен в «${esc(promo.title.slice(0, 40))}» — ${item.maxPromoPrice}₽ → +${item.profitAtMax}₽/шт`);
    }
    return;
  }

  // ─── Telegram-сообщение ───────────────────────────────────────────────────
  const date = moscowNow().toISOString().slice(0, 10);
  const parts: string[] = [`<b>📊 Акции Ozon — ${date}</b>`];

  // Блок 1: все активные акции с товарами и маржой
  if (activePromos.length === 0) {
    parts.push('\n📭 Активных акций с моими товарами нет');
  } else {
    parts.push(`\n<b>🏷 Активные акции (${activePromos.length}):</b>`);
    for (const promo of activePromos) {
      const statusIcon = promo.lossCount > 0 ? '🔴' : '✅';
      parts.push(`\n${statusIcon} <b>${esc(promo.title.slice(0, 45))}</b>`);
      for (const item of promo.items) {
        const name = NAME_BY_OFFER[item.offerId] ?? item.offerId;
        const shortName = name.replace(item.offerId + ' ', '').slice(0, 25);
        const be = item.breakEven;
        const icon = marginIcon(item.profit);
        const profitStr = item.profit >= 0 ? `+${item.profit}₽/шт` : `${item.profit}₽/шт`;
        const beStr = item.isLoss ? ` (безубыток ${be}₽)` : '';
        parts.push(`  ${icon} <b>${esc(item.offerId)}</b> ${esc(shortName)} — ${item.actionPrice}₽ → <b>${profitStr}</b>${esc(beStr)}`);
      }
    }
  }

  // Блок 2: позиции ниже цели — что сделали
  if (lossLines.length) {
    parts.push(`\n⚠️ <b>Ниже цели (+${MIN_PROMO_PROFIT}₽/шт): ${lossLines.length} поз.</b>`);
    parts.push(lossLines.join('\n'));
    if (exitedLines.length) {
      parts.push('<b>Действия:</b>');
      parts.push(exitedLines.join('\n'));
    }
  } else if (activePromos.length > 0) {
    parts.push(`\n✅ Все участия дают ≥ +${MIN_PROMO_PROFIT}₽/шт`);
  }

  // Блок 3: потенциальные акции — только выгодные позиции
  const profitableCandidates = candidatePromos
    .map(p => ({ ...p, items: p.items.filter(i => i.profitAtMax >= MIN_PROMO_PROFIT) }))
    .filter(p => p.items.length > 0);

  if (profitableCandidates.length > 0) {
    parts.push(`\n<b>💡 Можно присоединиться (≥ +${MIN_PROMO_PROFIT}₽/шт):</b>`);
    for (const promo of profitableCandidates) {
      parts.push(`\n🟢 <b>${esc(promo.title.slice(0, 45))}</b>`);
      for (const item of promo.items) {
        const name = (NAME_BY_OFFER[item.offerId] ?? item.offerId).replace(item.offerId + ' ', '').slice(0, 25);
        const icon2 = marginIcon(item.profitAtMax);
        const profStr = `+${item.profitAtMax}₽/шт`;
        const diff = item.maxPromoPrice - item.currentPrice;
        const diffStr = diff < 0 ? ` (−${Math.abs(diff)}₽ к цене)` : '';
        parts.push(`  ${icon2} <b>${esc(item.offerId)}</b> ${esc(name)} — ${item.maxPromoPrice}₽ → <b>${profStr}</b>${esc(diffStr)}`);
      }
    }
  } else if (candidatePromos.length > 0) {
    parts.push(`\n💡 Доступно ${candidatePromos.length} акций — ни одна не даёт ≥ +${MIN_PROMO_PROFIT}₽/шт при макс. цене`);
  }

  // Блок 5: auto_action
  if (autoOff.length) parts.push(`\n🔒 auto_action выключен у ${autoOff.length} тов.`);
  if (autoOn.length)  parts.push(`\n⚠️ <b>auto_action включён</b> у ${autoOn.length} тов.: ${autoOn.slice(0, 6).join(', ')}${autoOn.length > 6 ? '...' : ''}`);

  const msg = parts.join('\n');

  // Вывод в консоль (без HTML-тегов)
  console.log('\n' + msg
    .replace(/<b>/g, '').replace(/<\/b>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

  if (DRY) { console.log('\n(DRY: выход из акций пропущен)\n'); }

  if (NO_TELEGRAM) {
    console.log('\n(NO-TELEGRAM: отправка пропущена)\n');
    return;
  }

  await sendHtml(msg);
  const noChangesMode = NO_EXIT || DRY;
  console.log(`\n✅ Отчёт отправлен в Telegram${noChangesMode ? ' (без изменений в акциях)' : ''}`);
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
