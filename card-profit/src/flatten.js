import { bucketOf, money } from './buckets.js';

function pushLine(lines, partial) {
  const amount = Number(partial.amount) || 0;
  if (!amount && partial.bucket !== 'revenue') return;
  lines.push({
    accrualId: partial.accrualId,
    date: partial.date,
    sku: partial.sku || 0,
    category: partial.category,
    typeId: partial.typeId,
    typeName: partial.typeName,
    bucket: partial.bucket,
    amount,
    quantity: partial.quantity || 0,
  });
}

export function flattenAccrual(accrual, typeById) {
  const lines = [];
  const date = (accrual.date || '').slice(0, 10);
  const accrualId = accrual.accrual_id;
  const category = accrual.accrued_category || 'NON_ITEM';

  if (category === 'POSTING' && accrual.posting?.products) {
    for (const product of accrual.posting.products) {
      const sku = product.sku || 0;
      const quantity = product.quantity || 1;
      const commission = product.commission;
      if (commission) {
        const sellerPrice = money(commission.seller_price);
        pushLine(lines, {
          accrualId,
          date,
          sku,
          category,
          typeId: 0,
          typeName: 'Sale',
          bucket: 'revenue',
          amount: sellerPrice,
          quantity: sellerPrice >= 0 ? quantity : -quantity,
        });
        pushLine(lines, {
          accrualId,
          date,
          sku,
          category,
          typeId: 69,
          typeName: typeById.get(69)?.name || 'SaleCommission',
          bucket: 'commission',
          amount: money(commission.sale_commission ?? commission.commission),
          quantity,
        });
      }
      for (const service of product.delivery?.services || []) {
        const typeId = service.type_id;
        const meta = typeById.get(typeId) || { name: `type_${typeId}` };
        pushLine(lines, {
          accrualId,
          date,
          sku,
          category,
          typeId,
          typeName: meta.name,
          bucket: bucketOf(typeId, meta.name),
          amount: money(service.accrued),
          quantity,
        });
      }
    }
  }

  if (category === 'ITEM') {
    for (const item of accrual.item_fees?.fees || []) {
      const sku = item.sku || 0;
      for (const fee of item.fees || []) {
        const typeId = fee.type_id;
        const meta = typeById.get(typeId) || { name: `type_${typeId}` };
        pushLine(lines, {
          accrualId,
          date,
          sku,
          category,
          typeId,
          typeName: meta.name,
          bucket: bucketOf(typeId, meta.name),
          amount: money(fee.accrued),
          quantity: 0,
        });
      }
    }
  }

  if (category === 'NON_ITEM' && accrual.non_item_fee) {
    const typeId = accrual.non_item_fee.type_id;
    const meta = typeById.get(typeId) || { name: `type_${typeId}` };
    pushLine(lines, {
      accrualId,
      date,
      sku: 0,
      category,
      typeId,
      typeName: meta.name,
      bucket: bucketOf(typeId, meta.name),
      amount: money(accrual.non_item_fee.accrued),
      quantity: 0,
    });
  }

  return lines;
}
