/**
 * data-graphing: how a chart is built from query rows.
 *
 * The plugin draws line graphs (bars only on request), leaves out a partial
 * first month, marks an amount still adding up with a dashed segment, and
 * writes SVG that carries its own dark palette.
 */

import * as vega from 'vega';
import { compile } from 'vega-lite';
import {
  chartKind, isAdditive, windowStart, prepareData, displayNames, tickLabelExpr,
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
    expect(data.points.map(p => p.date)).toEqual(['2025-12-01', '2026-10-01', '2026-11-01']);
    expect(data.points.map(p => p.partial)).toEqual([false, false, true]);
    expect(data.points[0].label).toBe("Dec '25");
  });

  test("today's amount is partial; a reading is not", () => {
    const rows = days('2026-11-20', 3, () => 5000);
    const steps = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: true });
    expect(steps.points.map(p => p.partial)).toEqual([false, false, true]);
    const weight = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: false });
    expect(weight.points.some(p => p.partial)).toBe(false);
  });

  test('daily data starting late moves the axis start up, but never the end', () => {
    const rows = days('2026-11-01', 5, () => 1);
    const data = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '6 months', additive: true });
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
    const data = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '30 days', additive: true, averageDays: 7 });
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

  test('daily amounts: a line, a dashed reach to today, a goal line', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Steps', units: 'count', rows: days('2026-10-24', 30, i => 4000 + i * 200) }],
      settings: { ...baseSettings, metrics: ['Steps'], goal: 8000 },
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
      settings: { ...baseSettings, metrics: ['Steps'], chartType: 'bar' },
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
