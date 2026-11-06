/** Map Ozon accrual type_id / name → P&L bucket. */

const BY_ID = {
  1: 'acquiring',
  2: 'logistics',
  3: 'ads',
  4: 'ads',
  5: 'ads',
  6: 'logistics',
  9: 'logistics',
  12: 'logistics',
  13: 'logistics',
  16: 'logistics',
  17: 'logistics',
  19: 'ads',
  21: 'logistics',
  22: 'installment',
  23: 'ads',
  26: 'installment',
  28: 'logistics',
  29: 'logistics',
  30: 'logistics',
  32: 'logistics',
  33: 'ads',
  40: 'logistics',
  41: 'ads',
  42: 'logistics',
  43: 'logistics',
  44: 'logistics',
  45: 'logistics',
  46: 'storage',
  47: 'ads',
  48: 'ads',
  49: 'ads',
  50: 'ads',
  53: 'logistics',
  54: 'ads',
  55: 'ads',
  56: 'logistics',
  59: 'logistics',
  60: 'storage',
  61: 'ads',
  64: 'logistics',
  67: 'logistics',
  69: 'commission',
  70: 'ads',
  71: 'logistics',
  73: 'logistics',
  74: 'ads',
  75: 'ads',
  76: 'storage',
  78: 'storage',
  79: 'storage',
  87: 'ads',
  88: 'logistics',
};

const NAME_RULES = [
  [/salecommission|вознаграждение за продажу/i, 'commission'],
  [/acquir/i, 'acquiring'],
  [/click|advertis|marketing|brand|stars|review|promotion|push|полк|реклам|stencil|socialmedia/i, 'ads'],
  [/logistic|lastmile|shipment|fulfillment|drop-?off|pick-?up|crossdock|cancellation|return|магистрал|миля|выдач|самовывоз/i, 'logistics'],
  [/placement|storage|insurance|хранен|размещен/i, 'storage'],
  [/installment|рассроч/i, 'installment'],
];

export const BUCKETS = [
  'revenue',
  'commission',
  'logistics',
  'acquiring',
  'ads',
  'storage',
  'installment',
  'other',
];

export function bucketOf(typeId, typeName = '') {
  if (typeId === 0 && typeName === 'Sale') return 'revenue';
  if (BY_ID[typeId]) return BY_ID[typeId];
  const blob = `${typeName}`;
  for (const [re, bucket] of NAME_RULES) {
    if (re.test(blob)) return bucket;
  }
  return 'other';
}

export function money(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value === 'object' && value.amount != null) return money(value.amount);
  return 0;
}

export function commissionRatio(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const match = String(value).match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}
