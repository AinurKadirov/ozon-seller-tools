import { Fragment, useEffect, useMemo, useState } from 'react';
import { fetchCards, runSync } from './api.js';

const INTERVALS = [
  { id: 'day', label: 'День' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'period', label: 'Период' },
];

function moscowToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function daysAgo(n) {
  const [y, m, d] = moscowToday().split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - n);
  return utc.toISOString().slice(0, 10);
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function money2(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function clsNum(n) {
  if (n > 0.5) return 'pos';
  if (n < -0.5) return 'neg';
  return '';
}

function signed(n) {
  const v = Number(n) || 0;
  const abs = money(Math.abs(v));
  if (v > 0.5) return `+${abs}`;
  if (v < -0.5) return `−${abs}`;
  return abs;
}

export default function App() {
  const [minDate, setMinDate] = useState(daysAgo(7));
  const [maxDate, setMaxDate] = useState(moscowToday());
  const [interval, setInterval] = useState('period');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openKey, setOpenKey] = useState(null);

  async function load() {
    setError('');
    const data = await fetchCards({ minDate, maxDate, interval });
    setReport(data);
  }

  useEffect(() => {
    load().catch((err) => setError(String(err.message || err)));
  }, [minDate, maxDate, interval]);

  async function onSync() {
    setBusy(true);
    setError('');
    try {
      await runSync(minDate, maxDate);
      await load();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  const totals = report?.totals;
  const rows = report?.rows || [];
  const synced = useMemo(() => {
    const days = report?.days || [];
    if (!days.length) return 'нет синка за период';
    return `дней в сырье: ${days.length}`;
  }, [report]);

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">Ozon <span>P&L</span></div>
        <nav className="nav">
          <button className="nav-item active" type="button">Карточки</button>
        </nav>
        <div className="rail-foot">Lumos · начисления Seller API</div>
      </aside>
      <main className="main">
        <h1 className="page-title">Доходность по карточкам</h1>
        <p className="page-sub">Разбор всех расходов из начислений Ozon и среднее на проданную штуку. {synced}</p>

        <div className="toolbar">
          <label className="field">С
            <input type="date" value={minDate} onChange={(e) => setMinDate(e.target.value)} />
          </label>
          <label className="field">По
            <input type="date" value={maxDate} onChange={(e) => setMaxDate(e.target.value)} />
          </label>
          <div className="seg">
            {INTERVALS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={interval === item.id ? 'on' : ''}
                onClick={() => setInterval(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="btn" type="button" onClick={onSync} disabled={busy}>
            {busy ? 'Синк…' : 'Синк начислений'}
          </button>
          <span className="status">{error}</span>
        </div>

        <div className="kpis">
          <div className="kpi">
            <div className="lbl">Выручка</div>
            <div className="val">{money(totals?.revenue)} ₽</div>
          </div>
          <div className="kpi">
            <div className="lbl">Чистая прибыль</div>
            <div className={`val ${clsNum(totals?.profit)}`}>{signed(totals?.profit)} ₽</div>
          </div>
          <div className="kpi">
            <div className="lbl">Продано, шт</div>
            <div className="val">{totals?.soldCount || 0}</div>
          </div>
          <div className="kpi">
            <div className="lbl">Маржа</div>
            <div className={`val ${clsNum(totals?.marginPercent)}`}>{money2(totals?.marginPercent)}%</div>
          </div>
        </div>

        <div className="panel">
          {!rows.length ? (
            <div className="hint">Нет строк. Нажмите «Синк начислений» за выбранные даты.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="left">Товар</th>
                  {interval !== 'period' ? <th>Интервал</th> : null}
                  <th>SKU</th>
                  <th>Продажи</th>
                  <th>Выручка</th>
                  <th>Комиссия</th>
                  <th>Логистика</th>
                  <th>Эквайринг</th>
                  <th>Реклама</th>
                  <th>Хранение</th>
                  <th>Прочее</th>
                  <th>Себест.</th>
                  <th>Налог</th>
                  <th>Прибыль</th>
                  <th>₽/шт</th>
                  <th>ROI</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.key}>
                    <tr
                      className={openKey === row.key ? 'open' : ''}
                      onClick={() => setOpenKey(openKey === row.key ? null : row.key)}
                    >
                      <td className="left">
                        <span className="caret">{openKey === row.key ? '▾' : '▸'}</span>
                        <span className="name">{row.name}</span>
                      </td>
                      {interval !== 'period' ? <td>{row.intervalStart}</td> : null}
                      <td className="sku">{row.sku || '—'}</td>
                      <td>{row.soldCount}</td>
                      <td>{money(row.revenue)}</td>
                      <td className="neg">{money(row.commission)}</td>
                      <td className="neg">{money(row.logistics)}</td>
                      <td className="neg">{money(row.acquiring)}</td>
                      <td className="neg">{money(row.ads)}</td>
                      <td className="neg">{money(row.storage)}</td>
                      <td className="neg">{money(row.other + row.installment)}</td>
                      <td>{money(row.cost)}</td>
                      <td>{money(row.tax)}</td>
                      <td className={clsNum(row.profit)}>{signed(row.profit)}</td>
                      <td className={clsNum(row.perUnit?.profit)}>{money2(row.perUnit?.profit)}</td>
                      <td>{row.roiPercent == null ? '—' : `${money2(row.roiPercent)}%`}</td>
                    </tr>
                    {openKey === row.key ? (
                      <tr className="expand">
                        <td colSpan={interval === 'period' ? 15 : 16}>
                          <table className="fees">
                            <thead>
                              <tr>
                                <th className="left">Тип начисления</th>
                                <th>Бакет</th>
                                <th>Сумма</th>
                                <th>Среднее на шт</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.fees.filter((f) => f.typeName !== 'Sale').map((fee) => (
                                <tr key={`${fee.typeId}-${fee.typeName}`}>
                                  <td className="left">{fee.typeName}{fee.allocated ? ' (аллокация)' : ''}</td>
                                  <td>{fee.bucket}</td>
                                  <td className={clsNum(fee.amount)}>{money2(fee.amount)}</td>
                                  <td>{money2(fee.perUnit)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
                {totals ? (
                  <tr className="totals">
                    <td className="left">Итого</td>
                    {interval !== 'period' ? <td /> : null}
                    <td />
                    <td>{totals.soldCount}</td>
                    <td>{money(totals.revenue)}</td>
                    <td>{money(totals.commission)}</td>
                    <td>{money(totals.logistics)}</td>
                    <td>{money(totals.acquiring)}</td>
                    <td>{money(totals.ads)}</td>
                    <td>{money(totals.storage)}</td>
                    <td>{money(totals.other + totals.installment)}</td>
                    <td>{money(totals.cost)}</td>
                    <td>{money(totals.tax)}</td>
                    <td className={clsNum(totals.profit)}>{signed(totals.profit)}</td>
                    <td>{money2(totals.perUnit?.profit)}</td>
                    <td>{totals.roiPercent == null ? '—' : `${money2(totals.roiPercent)}%`}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
