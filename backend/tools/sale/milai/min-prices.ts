/**
 * min-prices.ts — минимальные цены и цены под целевую прибыль для MILAI.
 *
 * Магазин новый, продаж нет → ставки берём из карточек Ozon (комиссия, логистика,
 * эквайринг), процент выкупа и себестоимость — из catalog.ts. По каждому товару
 * считаем безубыток (минималку) и цену под заданную прибыль на единицу, затем
 * пушим короткую сводку в Telegram (без полного отчёта).
 *
 * Запуск:
 *   npm run ozon:milai-min-prices                  — безубыток + цена под +300 ₽/шт, пуш в Telegram
 *   npm run ozon:milai-min-prices -- 200 400       — колонки под +200 и +400 ₽/шт
 *   npm run ozon:milai-min-prices -- --dry         — только консоль, без Telegram
 *   npm run ozon:milai-min-prices -- --fbs         — считать по тарифам FBS (по умолч. FBO)
 *   npm run ozon:milai-min-prices -- --surcharge=8 — добавить запас-наценку 8% от цены
 *
 * По умолчанию: схема FBO, цель прибыли +300 ₽/шт, наценка 0% (логистика берётся как
 * середина min…max тарифа Ozon — это уже учитывает дальние кластеры).
 */
import { fetchProductRates } from './ozon';
import { MILAI_BY_SKU, MILAI_PRODUCTS } from './catalog';
import { computePricing, DEFAULT_TAX_RATE, DEFAULT_ACQUIRING_RATE } from './economics';
import { sendMarkdown } from '../lib/telegram';
import { fmt, moscowNow } from '../lib/format';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const USE_FBS = args.includes('--fbs');
// Наценка за нелокальность по умолчанию 0%: midpoint-логистика (середина min…max)
// уже включает дальние кластеры, поэтому отдельная наценка задваивала бы расстояние.
// Добавить запас вручную: --surcharge=8
const surchargeArg = args.find((a) => a.startsWith('--surcharge='));
const SURCHARGE_RATE = surchargeArg ? Number(surchargeArg.split('=')[1]) / 100 : 0;
const targets = args.filter((a) => /^\d+$/.test(a)).map(Number);
if (targets.length === 0) targets.push(300);

interface Row {
  offerId: string;
  sku: number;
  name: string;
  buyout: number;
  cost: number;
  commPct: number;
  forward: number;
  ret: number;
  logiPerSale: number;
  currentPrice: number;
  breakEven: number;
  targetPrices: number[];
  belowBE: boolean;
}

async function main(): Promise<void> {
  const scheme = USE_FBS ? 'FBS' : 'FBO';
  const taxPct = (DEFAULT_TAX_RATE * 100).toFixed(0);
  console.log(`🏪 MILAI — расчёт минимальных цен (схема ${scheme}, налог ${taxPct}%, эквайринг ~1%${SURCHARGE_RATE ? `, наценка ${(SURCHARGE_RATE * 100).toFixed(0)}%` : ''})`);
  console.log(`   Цель прибыли: ${targets.map((t) => `+${t}₽`).join(', ')} на единицу\n`);

  const rates = await fetchProductRates();
  const ratesBySku = new Map(rates.map((r) => [r.sku, r]));

  const rows: Row[] = [];
  const missing: number[] = [];

  for (const prod of MILAI_PRODUCTS) {
    const r = ratesBySku.get(prod.sku);
    if (!r) { missing.push(prod.sku); continue; }

    const commissionRate = USE_FBS ? r.commissionFbsRate : r.commissionFboRate;
    const forwardLogistics = USE_FBS ? r.fbsForward : r.fboForward;
    const returnLogistics = USE_FBS ? r.fbsReturn : r.fboReturn;
    const acquiringRate = r.currentPrice > 0 ? r.acquiring / r.currentPrice : DEFAULT_ACQUIRING_RATE;

    const pricing = computePricing({
      cost: prod.cost,
      buyout: prod.buyout,
      commissionRate,
      forwardLogistics,
      returnLogistics,
      acquiringRate,
      surchargeRate: SURCHARGE_RATE,
    });

    rows.push({
      offerId: r.offerId,
      sku: prod.sku,
      name: (prod.hint ?? r.offerId).slice(0, 22),
      buyout: prod.buyout,
      cost: prod.cost,
      commPct: commissionRate * 100,
      forward: forwardLogistics,
      ret: returnLogistics,
      logiPerSale: pricing.logiCostPerSale,
      currentPrice: r.currentPrice,
      breakEven: pricing.breakEven,
      targetPrices: targets.map((t) => pricing.priceForProfit(t)),
      belowBE: r.currentPrice > 0 && r.currentPrice < pricing.breakEven,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  printConsole(rows, missing, scheme);

  if (DRY) { console.log('\n▶  --dry: в Telegram не отправлено.'); return; }
  await sendMarkdown(buildTelegram(rows, scheme));
  console.log('\n✅ Отправлено в Telegram.');
}

function printConsole(rows: Row[], missing: number[], scheme: string): void {
  const head =
    '  ' + 'Артикул'.padEnd(20) + 'SKU'.padEnd(12) + 'Товар'.padEnd(24) + 'выкуп'.padStart(6) + 'себ'.padStart(6) +
    'комм'.padStart(6) + 'лог/прод'.padStart(9) + 'тек.цена'.padStart(9) +
    'МИНИМ'.padStart(8) + targets.map((t) => `+${t}`.padStart(8)).join('');
  console.log(head);
  console.log('  ' + '─'.repeat(head.length));
  for (const r of rows) {
    console.log(
      '  ' +
      r.offerId.slice(0, 19).padEnd(20) +
      `${r.sku}`.padEnd(12) +
      r.name.padEnd(24) +
      `${Math.round(r.buyout * 100)}%`.padStart(6) +
      `${r.cost}`.padStart(6) +
      `${Math.round(r.commPct)}%`.padStart(6) +
      `${Math.round(r.logiPerSale)}₽`.padStart(9) +
      (r.currentPrice ? `${fmt(r.currentPrice)}${r.belowBE ? '🔴' : ''}` : '—').padStart(9) +
      `${fmt(r.breakEven)}`.padStart(8) +
      r.targetPrices.map((p) => `${fmt(p)}`.padStart(8)).join(''),
    );
  }
  console.log('  ' + '─'.repeat(head.length));
  console.log('\n  МИНИМ = безубыток (прибыль 0). 🔴 = текущая цена карточки ниже безубытка.');
  console.log(`  лог/прод = логистика на 1 выкупленную шт с учётом невыкупов (схема ${scheme}).`);
  if (missing.length) console.log(`\n  ⚠️  Нет в API: SKU ${missing.join(', ')}`);
}

function buildTelegram(rows: Row[], scheme: string): string {
  const date = moscowNow().toISOString().slice(0, 10);
  const taxPct = (DEFAULT_TAX_RATE * 100).toFixed(0);
  const surPart = SURCHARGE_RATE ? ` · наценка ${(SURCHARGE_RATE * 100).toFixed(0)}%` : '';
  const lines: string[] = [];
  // Заголовок жирным (em-dash и пробелы в MarkdownV2 безопасны).
  lines.push('*MILAI — минимальные цены*');
  lines.push(escape(`${date} · ${scheme} · налог ${taxPct}% · эквайринг ~1%${surPart}`));
  lines.push('');

  // Карточками: по товару — отдельный блок, ничего не плющит на телефоне.
  for (const r of rows) {
    const flag = r.belowBE ? '🔴' : '✅';
    const targetsLine = targets
      .map((t, i) => escape(`+${t} → ${fmt(r.targetPrices[i])} ₽`))
      .join(' · ');
    lines.push(`${flag} *${escape(r.offerId)}*  ·  SKU \`${r.sku}\``);
    lines.push(escape(`выкуп ${Math.round(r.buyout * 100)}% · себ ${fmt(r.cost)} ₽`));
    lines.push(`мин *${escape(`${fmt(r.breakEven)} ₽`)}* · ${targetsLine}`);
    lines.push('');
  }

  lines.push(escape('🔴 = текущая цена карточки ниже безубытка (мин). Ниже мин продаёшь в минус.'));
  return lines.join('\n');
}

/** Экранирование для MarkdownV2 вне код-блока. */
function escape(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

main().catch((err: Error) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
