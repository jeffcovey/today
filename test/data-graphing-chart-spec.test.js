/**
 * data-graphing: how a chart is built from query rows.
 *
 * The plugin draws line graphs (bars only on request) of finished periods
 * only: no partial first month, and no amount for the day or month still
 * under way unless include_current asks for it, as a dashed segment. It
 * writes SVG that carries its own dark palette.
 */

import * as vega from 'vega';
import { compile } from 'vega-lite';
import {
  chartKind, isAdditive, normalizeUnits, unitTitle, zeroWhenMissing, windowStart, prepareData, displayNames, tickLabelExpr,
  dayTicks, buildSubtitle, buildSpec, addDarkMode, SERIES, CHROME
} from '../plugins/data-graphing/chart-spec.js';

const day = (iso, value) => ({ date: iso, value });

function days(from, n, valueOf) {
  const out = [];
  const t0 = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(day(new Date(t0 + i * 86400000).toISOString().slice(0, 10), valueOf(i)));
  }
  return out;
}

const baseSettings = {
  source: 'health', metrics: [], colors: [], timePeriod: '30 days',
  width: 800, height: 450, chartTitle: '', xAxisLabel: '', yAxisLabel: '',
  chartType: 'line', goal: NaN, averageDays: 0
};

describe('chart kind and metric meaning', () => {
  test('graphs are lines unless bars are asked for', () => {
    expect(chartKind({})).toBe('line');
    expect(chartKind({ chartType: 'auto' })).toBe('line');
    expect(chartKind({ chartType: 'bar' })).toBe('bar');
  });

  test('amounts add up whatever their unit; readings do not', () => {
    expect(isAdditive({ source: 'health', metric: 'Steps' })).toBe(true);
    expect(isAdditive({ source: 'health', metric: 'Protein' })).toBe(true);
    expect(isAdditive({ source: 'health', metric: 'Caffeine' })).toBe(true);
    expect(isAdditive({ source: 'health', metric: 'Weight' })).toBe(false);
    expect(isAdditive({ source: 'health', metric: 'BMI' })).toBe(false);
    expect(isAdditive({ source: 'finance', metric: 'Income' })).toBe(true);
  });
});

describe('units', () => {
  test('a history kept partly in kg and partly in lb is put in the latest unit', () => {
    const { rows, units, dropped } = normalizeUnits([
      { date: '2026-11-01', value: 70, units: 'kg' },
      { date: '2026-11-02', value: 154.3, units: 'lb' },
      { date: '2026-11-03', value: 71, units: 'kg' }
    ]);
    expect(units).toBe('kg');
    expect(dropped).toBe(0);
    expect(rows.map(r => Number(r.value.toFixed(2)))).toEqual([70, 69.99, 71]);
  });

  test("a row whose unit can't be converted is left out and counted", () => {
    const { rows, dropped } = normalizeUnits([
      { date: '2026-11-01', value: 3, units: 'count' },
      { date: '2026-11-02', value: 1.2, units: 'mi' }
    ]);
    expect(rows.map(r => r.value)).toEqual([1.2]);
    expect(dropped).toBe(1);
  });

  test('a mixed history is averaged after conversion, and the subtitle says what was left out', () => {
    const rows = [
      ...days('2026-11-01', 6, () => 70).map(r => ({ ...r, units: 'kg' })),
      ...days('2026-11-07', 6, () => 154.32).map(r => ({ ...r, units: 'lb' })),
      { date: '2026-10-31', value: 1, units: 'count' }
    ];
    const spec = buildSpec({
      datasets: [{ metric: 'Weight', units: 'kg', rows }],
      settings: { ...baseSettings, metrics: ['Weight'], averageDays: 7 },
      today: '2026-11-13'
    });
    const values = spec.layer[0].data.values.map(v => Number(v.value.toFixed(1)));
    expect(new Set(values)).toEqual(new Set([154.3]));
    expect(spec.title.subtitle).toContain('Latest 154.3 lb');
    expect(spec.title.subtitle).toContain('1 reading in other units left out');
  });

  test('units the ticks cannot carry title the axis instead', () => {
    expect(unitTitle('ml/(kg·min)')).toBe('ml/(kg·min)');
    expect(unitTitle('kcal')).toBeNull();
    expect(unitTitle('mi')).toBeNull();
    expect(unitTitle('count')).toBeNull();
    expect(unitTitle('$')).toBeNull();
    const spec = buildSpec({
      datasets: [{ metric: 'VO2 Max', units: 'ml/(kg·min)', rows: days('2026-11-01', 5, () => 35).map(r => ({ ...r, units: 'ml/(kg·min)' })) }],
      settings: { ...baseSettings, metrics: ['VO2 Max'] },
      today: '2026-11-05'
    });
    expect(spec.layer[0].encoding.y.axis.title).toBe('ml/(kg·min)');
  });
});

describe('periods with nothing in them', () => {
  test('finance, tasks and time logs count a missing period as zero; health does not', () => {
    expect(zeroWhenMissing('finance')).toBe(true);
    expect(zeroWhenMissing('tasks')).toBe(true);
    expect(zeroWhenMissing('time-logs')).toBe(true);
    expect(zeroWhenMissing('health')).toBe(false);
  });

  test('two active days among three empty ones average over all five', () => {
    const rows = [day('2026-11-17', 10), day('2026-11-21', 10)];
    const spec = buildSpec({
      datasets: [{ metric: 'Completed', units: '', rows }],
      settings: { ...baseSettings, source: 'tasks', metrics: ['Completed'], timePeriod: '5 days' },
      today: '2026-11-22'
    });
    const values = spec.layer[0].data.values.filter(v => v.seg === 'whole').map(v => [v.date, v.value]);
    expect(values).toEqual([
      ['2026-11-17', 10], ['2026-11-18', 0], ['2026-11-19', 0], ['2026-11-20', 0], ['2026-11-21', 10]
    ]);
    expect(spec.title.subtitle).toContain('Average 4 a day');
  });

  test('a month with no transactions is a zero month', () => {
    const data = prepareData(
      [{ metric: 'Expenses', rows: [day('2026-09', 100), day('2026-11', 50)] }],
      { today: '2026-11-22', timePeriod: '3 months', additive: true, zeroFill: true, includeCurrent: true }
    );
    expect(data.points.map(p => [p.date, p.value])).toEqual([
      ['2026-09-01', 100], ['2026-10-01', 0], ['2026-11-01', 50]
    ]);
  });

  test('a missing health day stays missing', () => {
    const data = prepareData(
      [{ metric: 'Steps', rows: [day('2026-11-17', 10), day('2026-11-21', 10)] }],
      { today: '2026-11-22', timePeriod: '5 days', additive: true }
    );
    expect(data.points).toHaveLength(2);
  });
});

describe('windowStart', () => {
  test('counts back by calendar unit', () => {
    expect(windowStart('2026-11-22', '6 months')).toBe('2026-05-22');
    expect(windowStart('2026-11-22', '30 days')).toBe('2026-10-23');
    expect(windowStart('2026-11-22', '2 weeks')).toBe('2026-11-08');
    expect(windowStart('2026-11-22', '1 year')).toBe('2025-11-22');
  });
});

describe('prepareData', () => {
  test('a monthly window starting mid-month drops that partial first month', () => {
    const rows = ['2025-11', '2025-12', '2026-10', '2026-11'].map(m => day(m, 100));
    const data = prepareData([{ metric: 'Income', rows }], {
      today: '2026-11-22', timePeriod: '12 months', additive: true
    });
    expect(data.monthly).toBe(true);
    expect(data.skippedPartial).toBe(true);
    expect(data.start).toBe('2025-12-01');
    expect(data.points[0].label).toBe("Dec '25");
  });

  test('amounts end at the last finished day or month', () => {
    const months = ['2026-09', '2026-10', '2026-11'].map(m => day(m, 100));
    const monthly = prepareData([{ metric: 'Income', rows: months }], { today: '2026-11-22', timePeriod: '3 months', additive: true });
    expect(monthly.points.map(p => p.date)).toEqual(['2026-09-01', '2026-10-01']);
    expect(monthly.end).toBe('2026-10-01');

    const steps = prepareData([{ metric: 'Steps', rows: days('2026-11-20', 3, () => 5000) }], { today: '2026-11-22', timePeriod: '30 days', additive: true });
    expect(steps.points.map(p => p.date)).toEqual(['2026-11-20', '2026-11-21']);
    expect(steps.end).toBe('2026-11-21');
    expect(steps.points.some(p => p.partial)).toBe(false);
  });

  test('a reading taken today is complete and stays', () => {
    const weight = prepareData([{ metric: 'Weight', rows: days('2026-11-20', 3, () => 168) }], { today: '2026-11-22', timePeriod: '30 days', additive: false });
    expect(weight.points.map(p => p.date)).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
    expect(weight.end).toBe('2026-11-22');
  });

  test('a chart of a reading and an amount cuts each series on its own', () => {
    const spec = buildSpec({
      datasets: [
        { metric: 'Weight', units: 'lb', rows: days('2026-11-20', 3, () => 168).map(r => ({ ...r, units: 'lb' })) },
        { metric: 'Steps', units: 'count', rows: days('2026-11-20', 3, () => 5000).map(r => ({ ...r, units: 'count' })) }
      ],
      settings: { ...baseSettings, metrics: ['Weight', 'Steps'] },
      today: '2026-11-22'
    });
    const values = spec.layer[0].data.values;
    const datesOf = (series) => values.filter(v => v.series === series).map(v => v.date);
    expect(datesOf('Weight')).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
    expect(datesOf('Steps')).toEqual(['2026-11-20', '2026-11-21']);
    expect(values.some(v => v.partial)).toBe(false);
  });

  test('with include_current, only the amount is marked partial', () => {
    const data = prepareData([
      { metric: 'Weight', additive: false, rows: days('2026-11-21', 2, () => 168) },
      { metric: 'Steps', additive: true, rows: days('2026-11-21', 2, () => 5000) }
    ], { today: '2026-11-22', timePeriod: '30 days', includeCurrent: true });
    expect(data.points.filter(p => p.partial).map(p => p.series)).toEqual(['Steps']);
    expect(data.end).toBe('2026-11-22');
  });

  test('include_current draws the period under way, marked partial', () => {
    const rows = ['2026-10', '2026-11'].map(m => day(m, 100));
    const data = prepareData([{ metric: 'Income', rows }], { today: '2026-11-22', timePeriod: '3 months', additive: true, includeCurrent: true });
    expect(data.points.map(p => [p.date, p.partial])).toEqual([['2026-10-01', false], ['2026-11-01', true]]);
  });

  test("today's amount is partial; a reading is not", () => {
    const rows = days('2026-11-20', 3, () => 5000);
    const steps = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: true, includeCurrent: true });
    expect(steps.points.map(p => p.partial)).toEqual([false, false, true]);
    const weight = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: false });
    expect(weight.points.some(p => p.partial)).toBe(false);
  });

  test('daily data starting late moves the axis start up, but never the end', () => {
    const rows = days('2026-11-01', 5, () => 1);
    const data = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '6 months', additive: false });
    expect(data.start).toBe('2026-11-01');
    expect(data.end).toBe('2026-11-22');
  });

  test('rows outside the window are dropped', () => {
    const rows = [day('2026-10-01', 1), day('2026-11-20', 2), day('2026-11-23', 3)];
    const data = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '14 days', additive: true });
    expect(data.points.map(p => p.value)).toEqual([2]);
  });

  test('the rolling average spans calendar days, not rows', () => {
    // Readings of 100 on Nov 1-10, then 200 on Nov 14: the window for Nov 14
    // is Nov 8-14, which holds three 100s and the 200, not the last 7 rows.
    const rows = [...days('2026-11-01', 10, () => 100), day('2026-11-14', 200)];
    const data = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: false, averageDays: 7 });
    const last = data.points[data.points.length - 1];
    expect(last.average).toBeCloseTo((100 * 3 + 200) / 4);
    expect(data.points[0].average).toBe(100);
  });

  test('no average unless one is asked for', () => {
    const rows = days('2026-10-24', 30, () => 100);
    const data = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: false });
    expect(data.points.every(p => p.average === undefined)).toBe(true);
  });

  test('a partial day stays out of the average', () => {
    const rows = [...days('2026-11-12', 10, () => 8000), day('2026-11-22', 100)];
    const data = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: true, averageDays: 7, includeCurrent: true });
    expect(data.points.find(p => p.date === '2026-11-21').average).toBe(8000);
    expect(data.points.find(p => p.date === '2026-11-22').average).toBeUndefined();
  });

  test('too few readings for an average leaves it off', () => {
    const rows = days('2026-11-15', 5, i => 100 + i);
    const data = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: false, averageDays: 7 });
    expect(data.points.every(p => p.average === undefined)).toBe(true);
  });
});

describe('labels', () => {
  test('a prefix every series shares is left to the title', () => {
    const names = displayNames(['OlderGay.Men: Income', 'OlderGay.Men: Expenses']);
    expect([...names.values()]).toEqual(['Income', 'Expenses']);
    expect([...displayNames(['Income', 'Expenses']).values()]).toEqual(['Income', 'Expenses']);
    expect([...displayNames(['A: Income', 'B: Expenses']).values()]).toEqual(['A: Income', 'B: Expenses']);
  });

  test('tick labels: compact from 10,000, unit carried along', async () => {
    // Evaluate the expression the way the axis will: in Vega.
    const run = async (expr, value) => {
      const view = new vega.View(vega.parse({
        signals: [{ name: 'out', init: expr.replaceAll('datum.value', `(${value})`) }]
      }), { renderer: 'none' });
      await view.runAsync();
      return view.signal('out');
    };
    expect(await run(tickLabelExpr('count', 10478, ',.0f'), 8000)).toBe('8K');
    expect(await run(tickLabelExpr('count', 10478, ',.0f'), 0)).toBe('0');
    expect(await run(tickLabelExpr('$', 4600, '$,.0f'), 3000)).toBe('$3,000');
    expect(await run(tickLabelExpr('min', 191, ',.0f'), 50)).toBe('50 min');
    expect(await run(tickLabelExpr('lb', 172, ',.1f'), 168.5)).toBe('168.5 lb');
  });

  test('day ticks always include the last day and never pass it', () => {
    const ticks = dayTicks('2026-10-23', '2026-11-22');
    expect(ticks[ticks.length - 1]).toBe('2026-11-22');
    expect(ticks[0] >= '2026-10-23').toBe(true);
    expect(dayTicks('2026-05-22', '2026-11-22')).toEqual(
      ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']);
  });

  test('the subtitle says when data has stopped arriving', () => {
    const points = [{ series: 'Weight', date: '2026-11-15', label: 'Nov 15', value: 168.5, partial: false }];
    const text = buildSubtitle({
      additive: false, monthly: false, points, units: 'lb', metrics: ['Weight'],
      today: '2026-11-22', fmt: ',.1f', averageDays: 7
    });
    expect(text).toBe('Latest 168.5 lb · no data since Nov 15');
  });

  test('a daily-total subtitle leaves the partial day out of the average', () => {
    const points = [
      { date: '2026-11-21', label: 'Nov 21', value: 8000, partial: false },
      { date: '2026-11-22', label: 'Nov 22', value: 100, partial: true }
    ];
    const text = buildSubtitle({
      additive: true, monthly: false, points, units: 'count', metrics: ['Steps'],
      today: '2026-11-22', fmt: ',.0f', averageDays: 7
    });
    expect(text).toBe('Average 8,000 a day · best 8,000 on Nov 21 · today so far is dashed');
  });

  test('readings in several series are compared by latest value, never summed', () => {
    const points = [
      { series: 'Me', date: '2026-11-21', label: 'Nov 21', value: 160, partial: false },
      { series: 'Partner', date: '2026-11-21', label: 'Nov 21', value: 161, partial: false }
    ];
    const text = buildSubtitle({
      additive: false, monthly: false, points, units: 'lb', metrics: ['Me', 'Partner'],
      today: '2026-11-22', fmt: ',.0f', averageDays: 0
    });
    expect(text).toBe('Latest: Me 160 lb · Partner 161 lb');
  });
});

describe('buildSpec renders', () => {
  async function render(spec) {
    const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });
    return view.toSVG();
  }

  const marks = (spec) => spec.layer.flatMap(l => (l.layer ? l.layer.map(m => m.mark.type) : [l.mark.type]));

  test('daily amounts end yesterday', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Steps', units: 'count', rows: days('2026-10-24', 30, i => 4000 + i * 200) }],
      settings: { ...baseSettings, metrics: ['Steps'] },
      today: '2026-11-22'
    });
    const values = spec.layer[0].data.values;
    expect(values[values.length - 1].date).toBe('2026-11-21');
    expect(values.some(v => v.seg === 'partial')).toBe(false);
    const svg = await render(spec);
    expect(svg).not.toContain('so far');
  });

  test('with include_current: a line, a dashed reach to today, a goal line', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Steps', units: 'count', rows: days('2026-10-24', 30, i => 4000 + i * 200) }],
      settings: { ...baseSettings, metrics: ['Steps'], goal: 8000, includeCurrent: true },
      today: '2026-11-22'
    });
    const line = spec.layer[0];
    expect(line.mark.type).toBe('line');
    expect(line.mark.interpolate).toBe('linear');
    const dashed = line.data.values.filter(v => v.seg === 'partial').map(v => v.date);
    expect(dashed).toEqual(['2026-11-21', '2026-11-22']);
    expect(line.encoding.y.scale.zero).toBe(true);
    const svg = await render(spec);
    expect(svg).toContain('Goal 8,000');
    expect(svg).toContain('today so far is dashed');
  });

  test('a reading is a line off zero, with its latest value written', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Weight', units: 'lb', rows: days('2026-10-23', 30, i => 168 + Math.sin(i)) }],
      settings: { ...baseSettings, metrics: ['Weight'], timePeriod: '6 months' },
      today: '2026-11-22'
    });
    expect(marks(spec)).toEqual(['line', 'circle', 'point', 'text']);
    expect(spec.layer[0].encoding.y.scale.zero).toBe(false);
    expect(await render(spec)).toContain('Latest');
  });

  test('average_days adds an average line over the daily one', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Weight', units: 'lb', rows: days('2026-10-23', 30, i => 168 + Math.sin(i)) }],
      settings: { ...baseSettings, metrics: ['Weight'], averageDays: 7 },
      today: '2026-11-22'
    });
    expect(marks(spec).filter(m => m === 'line')).toHaveLength(2);
    expect(await render(spec)).toContain('7-day average');
  });

  test('chart_type = "bar" still draws slim bars', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Steps', units: 'count', rows: days('2026-10-24', 30, () => 5000) }],
      settings: { ...baseSettings, metrics: ['Steps'], chartType: 'bar', includeCurrent: true },
      today: '2026-11-22'
    });
    expect(spec.layer[0].mark.type).toBe('bar');
    expect(spec.layer[0].mark.width).toBeLessThanOrEqual(24);
    expect(await render(spec)).toContain('today so far is faded');
  });

  test('two monthly series share a legend and keep configured colors', async () => {
    const months = ['2025-12', '2026-01', '2026-02'];
    const spec = buildSpec({
      datasets: [
        { metric: 'Biz: Income', units: '$', rows: months.map(m => day(m, 1500)) },
        { metric: 'Biz: Expenses', units: '$', rows: months.map(m => day(m, 2000)) }
      ],
      settings: {
        ...baseSettings, source: 'finance', timePeriod: '3 months',
        metrics: ['Biz: Income', 'Biz: Expenses'], colors: ['#4CAF50']
      },
      today: '2026-02-15'
    });
    expect(spec.usermeta.colors).toEqual(['#4CAF50', SERIES[1].light]);
    const svg = await render(spec);
    expect(svg).toContain('>Income<');
    expect(svg).toContain('>Expenses<');
  });
});

describe('addDarkMode', () => {
  test('maps chrome and palette colors to their dark steps, leaves custom ones', () => {
    const svg = addDarkMode('<svg width="1"><rect fill="#fcfcfb"/></svg>', [SERIES[0].light, '#4CAF50']);
    expect(svg.startsWith('<svg width="1"><style>@media (prefers-color-scheme: dark){')).toBe(true);
    expect(svg).toContain(`[fill="${CHROME.surface.light}"]{fill:${CHROME.surface.dark}}`);
    expect(svg).toContain(`[stroke="${SERIES[0].light}"]{stroke:${SERIES[0].dark}}`);
    expect(svg).not.toContain('#4CAF50');
  });
});
