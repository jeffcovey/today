/**
 * Chart building for the data-graphing plugin.
 *
 * Pure functions: rows in, a Vega-Lite spec out, plus the SVG post-processing
 * that gives the written file its own dark palette. Rendering (vega + canvas)
 * lives in read.js so this module can be tested without either.
 */

// Reference palette: categorical slots in a fixed order, a light and a dark
// step each. A series keeps its slot whatever else is on the chart.
export const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#eb6834', dark: '#d95926' }, // orange
  { light: '#1baf7a', dark: '#199e70' }, // aqua
  { light: '#eda100', dark: '#c98500' }, // yellow
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#008300', dark: '#0ca30c' }, // green
  { light: '#6250d6', dark: '#9085e9' }, // violet
  { light: '#e34948', dark: '#e66767' } // red
];

// Chart chrome. Each light value is unique within the chart so the dark
// stylesheet can find it by attribute.
export const CHROME = {
  surface: { light: '#fcfcfb', dark: '#1a1a19' },
  ink: { light: '#0b0b0b', dark: '#f0efec' },
  ink2: { light: '#52514e', dark: '#c3c2b7' },
  muted: { light: '#898781', dark: '#9a988f' },
  grid: { light: '#e1e0d9', dark: '#2c2c2a' },
  axis: { light: '#c3c2b7', dark: '#383835' }
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Health metrics that are a reading taken at a moment rather than an amount
// that adds up over the day. A day's reading is complete once taken; a day's
// steps are not complete until the day ends. Labels as in METRIC_DISPLAY.
const HEALTH_READINGS = new Set([
  'Walk Speed', 'Step Length', 'Walk Asymmetry', 'Double Support', 'Walk HR', 'Effort',
  'Weight', 'Body Fat', 'BMI', 'Lean Mass',
  'Heart Rate', 'Resting HR', 'HRV', 'Resp Rate', 'SpO2',
  'Env Audio', 'Headphone'
]);

// Short units worth repeating on every tick label, keyed by the stored unit
// in lower case.
const TICK_SUFFIX = {
  min: ' min', hr: ' h', hrs: ' h', ms: ' ms',
  lb: ' lb', lbs: ' lb', kg: ' kg', g: ' g', mg: ' mg', mcg: ' mcg',
  mi: ' mi', km: ' km', m: ' m', in: ' in', ft: ' ft',
  kcal: ' kcal', kj: ' kJ', ml: ' mL', l: ' L', fl_oz_us: ' fl oz',
  bpm: ' bpm', 'count/min': '/min', 'mi/hr': ' mph',
  '%': '%', dbaspl: ' dB', db: ' dB', degf: '°F', degc: '°C'
};

/** The tick-label suffix for a unit, or null when it has none. */
function unitSuffix(units) {
  return TICK_SUFFIX[String(units || '').toLowerCase()] ?? null;
}

/**
 * A unit the tick labels can't carry (ml/(kg·min), kcal/hr·kg) goes in the
 * axis title instead, so no chart is left with bare numbers.
 */
export function unitTitle(units) {
  if (!units || units === '$' || units === 'count' || unitSuffix(units) !== null) return null;
  return units;
}

// ---------------------------------------------------------------- dates

const toUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

export function shortDate(iso) {
  const d = new Date(toUtc(iso));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function shortMonth(iso) {
  const d = new Date(toUtc(iso));
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

/**
 * First day of the window a time period covers, ending at `today`.
 * "6 months" before 2026-11-22 is 2026-05-22.
 */
export function windowStart(today, timePeriod) {
  const match = String(timePeriod).match(/(\d+)\s*(day|week|month|year)s?/i);
  const [amount, unit] = match ? [parseInt(match[1], 10), match[2].toLowerCase()] : [6, 'month'];
  const d = new Date(toUtc(today));
  if (unit === 'day') d.setUTCDate(d.getUTCDate() - amount);
  if (unit === 'week') d.setUTCDate(d.getUTCDate() - amount * 7);
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - amount);
  if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() - amount);
  return toIso(d.getTime());
}

// ---------------------------------------------------------------- data

// Units that can be converted into one another, as a factor to a base unit
// of their kind.
const CONVERSIONS = {
  mass: { kg: 1, lb: 0.45359237, lbs: 0.45359237, g: 0.001 },
  distance: { m: 1, km: 1000, mi: 1609.344, ft: 0.3048 },
  energy: { kj: 1, kcal: 4.184 },
  volume: { l: 1, ml: 0.001, fl_oz_us: 0.0295735295625 }
};

function conversionFactor(from, to) {
  const f = String(from || '').toLowerCase();
  const t = String(to || '').toLowerCase();
  if (f === t) return 1;
  for (const table of Object.values(CONVERSIONS)) {
    if (f in table && t in table) return table[f] / table[t];
  }
  return null;
}

/**
 * Put a series' rows in one unit: the unit of its latest row. A Weight
 * history kept partly in kg and partly in lb is converted, never averaged
 * as raw numbers; a row whose unit can't be converted is left out.
 *
 * @returns {{rows: object[], units: string, dropped: number}}
 */
export function normalizeUnits(rows) {
  if (rows.length === 0) return { rows, units: '', dropped: 0 };
  const latest = rows.reduce((m, r) => (r.date >= m.date ? r : m), rows[0]);
  const units = latest.units || '';
  let dropped = 0;
  const out = [];
  for (const r of rows) {
    const factor = conversionFactor(r.units || '', units);
    if (factor === null) { dropped++; continue; }
    out.push(factor === 1 ? r : { ...r, value: r.value * factor, units });
  }
  return { rows: out, units, dropped };
}

// Sources whose query has no row for a day or month with nothing in it, so
// a missing period means zero. A missing health reading means unknown.
const ZERO_WHEN_MISSING = new Set(['finance', 'tasks', 'time-logs']);

export function zeroWhenMissing(source) {
  return ZERO_WHEN_MISSING.has(source);
}

/** Graphs are lines; `chart_type = "bar"` asks for bars instead. */
export function chartKind({ chartType }) {
  return chartType === 'bar' ? 'bar' : 'line';
}

/**
 * Whether a metric is an amount that adds up over its day or month (steps,
 * dollars, tasks done) rather than a reading (weight). An amount for the
 * period still under way is incomplete; amounts can be totalled.
 */
export function isAdditive({ source, metric }) {
  return source !== 'health' || !HEALTH_READINGS.has(metric);
}

/**
 * Turn query rows into plot rows on one calendar.
 *
 * @param {Array<{metric: string, rows: Array<{date: string, value: number}>}>} datasets
 * @param {{today: string, timePeriod: string, additive: boolean, averageDays: number, zeroFill: boolean}} opts
 * @returns {{monthly: boolean, start: string, end: string, points: object[], skippedPartial: boolean}}
 */
export function prepareData(datasets, { today, timePeriod, additive, averageDays = 0, zeroFill = false }) {
  const monthly = datasets.some(ds => ds.rows.some(r => /^\d{4}-\d{2}$/.test(r.date)));
  let start = windowStart(today, timePeriod);
  let skippedPartial = false;

  if (monthly) {
    // A window starting mid-month covers only part of its first month; that
    // month's total is not comparable with the rest, so it starts a month on.
    if (!start.endsWith('-01')) {
      const d = new Date(toUtc(start));
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      start = toIso(d.getTime());
      skippedPartial = true;
    }
  }

  const currentPeriod = monthly ? today.slice(0, 7) : today;
  const last = monthly ? `${currentPeriod}-01` : today;
  const points = [];

  // Every day or month in the window, for sources where a missing one is zero.
  const periods = [];
  if (zeroFill) {
    const d = new Date(toUtc(start));
    for (; toIso(d.getTime()) <= last; monthly ? d.setUTCMonth(d.getUTCMonth() + 1) : d.setUTCDate(d.getUTCDate() + 1)) {
      periods.push(toIso(d.getTime()));
    }
  }

  for (const ds of datasets) {
    let rows = ds.rows
      .filter(r => Number.isFinite(r.value))
      .map(r => ({ ...r, date: monthly && r.date.length === 7 ? `${r.date}-01` : r.date }))
      .filter(r => r.date >= start && r.date <= last)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (zeroFill) {
      const have = new Set(rows.map(r => r.date));
      rows = [...rows, ...periods.filter(d => !have.has(d)).map(date => ({ date, value: 0 }))]
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    for (const r of rows) {
      const point = {
        series: ds.metric,
        date: r.date,
        label: monthly ? shortMonth(r.date) : shortDate(r.date),
        value: r.value,
        // The period still under way: an amount that is still adding up.
        partial: additive && (monthly ? r.date.slice(0, 7) === currentPeriod : r.date === today)
      };
      points.push(point);
    }

    if (!monthly && averageDays > 1 && rows.length >= averageDays + 3) {
      // Trailing mean over calendar days, not rows, so a gap in the data
      // doesn't stretch the window. A partial day stays out of it.
      const whole = rows.filter(r => !(additive && r.date === today));
      const byPoint = points.filter(p => p.series === ds.metric && !p.partial);
      for (const p of byPoint) {
        const from = toIso(toUtc(p.date) - (averageDays - 1) * DAY_MS);
        const win = whole.filter(r => r.date >= from && r.date <= p.date);
        p.average = win.reduce((s, r) => s + r.value, 0) / win.length;
      }
    }
  }

  // Daily data that only begins partway into the window (a source connected
  // recently) starts the axis at its first day rather than leaving most of
  // the chart empty. The end always stays at today, so stale data shows.
  if (!monthly && !zeroFill && points.length) {
    const first = points.reduce((m, p) => (p.date < m ? p.date : m), points[0].date);
    if (first > start) start = first;
  }

  return { monthly, start, end: last, points, skippedPartial };
}

// ---------------------------------------------------------------- formatting

/**
 * Series names without the prefix they all share: "OlderGay.Men: Income" and
 * "OlderGay.Men: Expenses" read as "Income" and "Expenses" under a title that
 * already names the group.
 */
export function displayNames(metrics) {
  const names = new Map(metrics.map(m => [m, m]));
  if (metrics.length < 2) return names;
  const prefixes = metrics.map(m => m.match(/^(.+?):\s+/)?.[1]);
  if (prefixes[0] && prefixes.every(p => p === prefixes[0])) {
    for (const m of metrics) names.set(m, m.slice(m.indexOf(':') + 1).trim());
  }
  return names;
}

/**
 * Vega expression for y tick labels: full numbers below 10,000 and compact
 * ones (10K, 20K) on an axis that reaches it; the unit rides along when short.
 */
export function tickLabelExpr(units, maxValue, fmt) {
  const prefix = units === '$' ? '$' : '';
  const suffix = unitSuffix(units) || '';
  const plain = `format(datum.value, '${fmt === ',.1f' ? ',~f' : ',.0f'}')`;
  const body = maxValue >= 10000
    ? `(abs(datum.value) >= 1000 ? format(datum.value / 1000, ',~f') + 'K' : ${plain})`
    : plain;
  return `'${prefix}' + ${body} + '${suffix}'`;
}

/** Tick dates for a daily axis: a few evenly spaced days, never past today. */
export function dayTicks(start, end) {
  const days = Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1;
  const step = days <= 10 ? 1 : days <= 21 ? 2 : days <= 45 ? 7 : days <= 120 ? 14 : 0;
  const ticks = [];
  if (step) {
    // Count back from the last day so today always gets a label.
    for (let t = toUtc(end); t >= toUtc(start); t -= step * DAY_MS) ticks.unshift(toIso(t));
  } else {
    const d = new Date(toUtc(start));
    if (d.getUTCDate() !== 1) { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); }
    for (; toIso(d.getTime()) <= end; d.setUTCMonth(d.getUTCMonth() + 1)) ticks.push(toIso(d.getTime()));
  }
  return ticks;
}

/** d3-format string for values in these units. */
export function valueFormat(units, points) {
  if (units === '$') return '$,.0f';
  const max = Math.max(...points.map(p => Math.abs(p.value)), 0);
  const fractional = points.some(p => !Number.isInteger(p.value));
  return fractional && max < 1000 ? ',.1f' : ',.0f';
}

function formatNumber(value, units, fmt) {
  const decimals = fmt.includes('.1f') ? 1 : 0;
  const n = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (units === '$') return `$${n}`;
  const suffix = unitSuffix(units);
  if (suffix) return `${n}${suffix}`;
  return unitTitle(units) ? `${n} ${units}` : n;
}

/**
 * One line under the title saying what the chart is for: where it ended up,
 * the typical value, and how fresh the data is.
 */
export function buildSubtitle({ additive, monthly, points, units, metrics, today, fmt, averageDays }) {
  if (points.length === 0) return 'No data in this period';
  const parts = [];
  const fmtN = (v) => formatNumber(v, units, fmt);
  const lastDate = points.reduce((m, p) => (p.date > m ? p.date : m), points[0].date);

  const latest = (metric) => {
    const own = points.filter(p => p.series === metric && !p.partial);
    return own[own.length - 1];
  };

  if (metrics.length > 1 && additive) {
    for (const metric of metrics) {
      const total = points.filter(p => p.series === metric).reduce((s, p) => s + p.value, 0);
      parts.push(`${metric} ${fmtN(total)}`);
    }
    parts[0] = `${monthly ? 'Totals' : 'Total'}: ${parts[0]}`;
  } else if (metrics.length > 1) {
    // Readings don't add up; each series' latest is what to compare.
    for (const metric of metrics) {
      const last = latest(metric);
      if (last) parts.push(`${metric} ${fmtN(last.value)}`);
    }
    if (parts.length) parts[0] = `Latest: ${parts[0]}`;
  } else if (!additive) {
    const last = latest(metrics[0]);
    parts.push(`Latest ${fmtN(last.value)}`);
    if (last.average !== undefined) parts.push(`${averageDays}-day average ${fmtN(last.average)}`);
  } else {
    const whole = points.filter(p => !p.partial);
    if (whole.length) {
      const avg = whole.reduce((s, p) => s + p.value, 0) / whole.length;
      parts.push(`Average ${fmtN(avg)} a ${monthly ? 'month' : 'day'}`);
      const best = whole.reduce((m, p) => (p.value > m.value ? p : m), whole[0]);
      parts.push(`best ${fmtN(best.value)} on ${best.label}`);
    }
  }

  // Stale data should be visible at a glance, not only from the axis.
  const staleDays = Math.round((toUtc(today) - toUtc(lastDate)) / DAY_MS);
  if (!monthly && staleDays > 1) parts.push(`no data since ${shortDate(lastDate)}`);
  if (points.some(p => p.partial)) parts.push(`${monthly ? 'this month' : 'today'} so far is dashed`);

  return parts.join(' · ');
}

// ---------------------------------------------------------------- spec

/**
 * The layers of a line graph.
 *
 * Straight segments between real points (no smoothing that invents values
 * between days). A period still under way is reached by a dashed segment
 * and drawn as a hollow point. Points are marked while there is room for
 * them, and a single series has its latest value written at its end.
 * With a rolling average the daily line goes quiet and the average leads.
 */
function lineLayers({ points, x, y, color, multi, fmt, averageDays }) {
  const series = [...new Set(points.map(p => p.series))];
  const segments = [];
  for (const name of series) {
    const own = points.filter(p => p.series === name);
    const whole = own.filter(p => !p.partial);
    for (const p of whole) segments.push({ ...p, seg: 'whole' });
    const partial = own.find(p => p.partial);
    if (partial && whole.length) {
      segments.push({ ...whole[whole.length - 1], seg: 'partial' }, { ...partial, seg: 'partial' });
    }
  }

  const averaged = points.some(p => p.average !== undefined);
  const perSeries = Math.max(...series.map(n => points.filter(p => p.series === n).length), 0);
  const markers = !averaged && perSeries <= 45;
  const surface = CHROME.surface.light;
  const layers = [];

  layers.push({
    data: { values: segments },
    mark: {
      type: 'line', interpolate: 'linear', strokeCap: 'round', strokeJoin: 'round',
      strokeWidth: averaged ? 1.5 : 2, opacity: averaged ? 0.4 : 1
    },
    encoding: {
      x, y: y('value'), color,
      detail: { field: 'series' },
      strokeDash: {
        field: 'seg', type: 'nominal', legend: null,
        scale: { domain: ['whole', 'partial'], range: [[1, 0], [4, 4]] }
      }
    }
  });

  if (averaged) {
    layers.push({
      transform: [{ filter: 'isValid(datum.average)' }],
      mark: { type: 'line', interpolate: 'linear', strokeWidth: 2.5, strokeCap: 'round', strokeJoin: 'round' },
      encoding: { x, y: y('average'), color, detail: { field: 'series' } }
    });
  }

  if (markers) {
    layers.push({
      transform: [{ filter: '!datum.partial' }],
      mark: { type: 'circle', size: 52, opacity: 1, stroke: surface, strokeWidth: 1.5 },
      encoding: { x, y: y('value'), color }
    });
  }

  // The period under way: hollow, since its value is not final.
  layers.push({
    transform: [{ filter: 'datum.partial' }],
    mark: { type: 'point', shape: 'circle', size: 52, filled: true, fill: surface, strokeWidth: 2, opacity: 1 },
    encoding: { x, y: y('value'), stroke: color }
  });

  if (!multi) {
    // The latest value, written above its point, or below it when the line
    // falls into the point and would run through text placed above.
    const field = averaged ? 'average' : 'value';
    const whole = points.filter(p => !p.partial && Number.isFinite(p[field]));
    const last = whole[whole.length - 1];
    if (last) {
      const prev = whole[whole.length - 2];
      const below = prev !== undefined && prev[field] > last[field];
      layers.push({
        data: { values: [last] },
        layer: [
          ...(markers ? [] : [{
            mark: { type: 'circle', size: 64, opacity: 1, stroke: surface, strokeWidth: 2 },
            encoding: { x, y: y(field), color }
          }]),
          {
            mark: {
              type: 'text', align: 'center', baseline: below ? 'top' : 'bottom', dy: below ? 9 : -9,
              fontSize: 12, fontWeight: 'bold', color: CHROME.ink.light
            },
            encoding: { x, y: y(field), text: { field, format: fmt } }
          }
        ]
      });
    }
  }

  return layers;
}

/**
 * Build the Vega-Lite spec.
 *
 * @param {object} p
 * @param {Array} p.datasets - [{ metric, rows, units }]
 * @param {object} p.settings - plugin settings (see read.js)
 * @param {string} p.today - YYYY-MM-DD in the user's time zone
 */
export function buildSpec({ datasets: raw, settings, today }) {
  // Each series in one unit before anything is averaged or totalled.
  const datasets = raw.map(ds => ({ ...ds, ...normalizeUnits(ds.rows) }));
  const dropped = datasets.reduce((n, ds) => n + ds.dropped, 0);
  const metrics = datasets.map(ds => ds.metric);
  const units = datasets[0]?.units || '';
  const kind = chartKind({ chartType: settings.chartType });
  const additive = metrics.every(metric => isAdditive({ source: settings.source, metric }));
  const averageDays = Number.isFinite(settings.averageDays) ? settings.averageDays : 0;
  const data = prepareData(datasets, {
    today, timePeriod: settings.timePeriod, additive, averageDays,
    zeroFill: additive && zeroWhenMissing(settings.source)
  });
  const { monthly } = data;
  const names = displayNames(metrics);
  const points = data.points.map(p => ({ ...p, series: names.get(p.series) }));
  const fmt = valueFormat(units, points);
  const multi = metrics.length > 1;

  // A series keeps the slot of its place in the configured list, even when
  // an earlier one has no data this time.
  const slotOf = (metric, i) => {
    const configured = (settings.metrics || []).indexOf(metric);
    return configured >= 0 ? configured : i;
  };
  const colors = metrics.map((m, i) => settings.colors?.[slotOf(m, i)] || SERIES[slotOf(m, i) % SERIES.length].light);
  const seriesNames = metrics.map(m => names.get(m));
  const color = multi
    ? { field: 'series', type: 'nominal', scale: { domain: seriesNames, range: colors }, title: null }
    : { value: colors[0] };

  const title = settings.chartTitle ||
    (multi ? metrics.join(' vs ') : metrics[0] || 'Graph');
  let subtitle = buildSubtitle({ additive, monthly, points, units, metrics: seriesNames, today, fmt, averageDays });
  if (kind === 'bar') subtitle = subtitle.replace('so far is dashed', 'so far is faded');
  if (dropped) subtitle += ` · ${dropped} reading${dropped === 1 ? '' : 's'} in other units left out`;

  // autosize "fit" makes this the size of the whole image; the plot area is
  // what remains after title, axes and legend. Bar widths use the estimate.
  const { width, height } = settings;
  const plotWidth = width - 80;

  // Tick labels carry the unit where it is short, so no axis title is needed.
  const maxValue = Math.max(0, ...points.map(p => p.value), Number.isFinite(settings.goal) ? settings.goal : 0);
  const yAxis = {
    title: settings.yAxisLabel || unitTitle(units),
    tickCount: 5,
    labelExpr: tickLabelExpr(units, maxValue, fmt)
  };

  let x;
  const layers = [];

  if (monthly) {
    // Months are categories here, one point (or bar group) in each.
    const months = [];
    for (let d = new Date(toUtc(data.start)); toIso(d.getTime()) <= data.end; d.setUTCMonth(d.getUTCMonth() + 1)) {
      months.push(shortMonth(toIso(d.getTime())));
    }
    x = {
      field: 'label', type: 'ordinal', sort: months,
      scale: kind === 'bar' ? { domain: months, paddingInner: 0.25 } : { domain: months, padding: 0.4 },
      axis: { title: settings.xAxisLabel || null, labelAngle: 0, labelOverlap: 'greedy', ticks: false }
    };
  } else {
    // Bars span their whole day, so ticks sit at noon, under the bar.
    const offset = kind === 'bar' ? DAY_MS / 2 : 0;
    const domainEnd = kind === 'bar' ? toUtc(data.end) + DAY_MS : toUtc(data.end);
    x = {
      field: 'date', type: 'temporal',
      ...(kind === 'bar' ? { timeUnit: 'utcyearmonthdate' } : {}),
      scale: { type: 'utc', domain: [toUtc(data.start), domainEnd] },
      axis: {
        title: settings.xAxisLabel || null, labelAngle: 0, labelOverlap: true,
        values: dayTicks(data.start, data.end).map(d => toUtc(d) + offset),
        format: '%b %-d', ticks: false, grid: false
      }
    };
  }

  const y = (field, extra = {}) => ({
    field, type: 'quantitative',
    // Amounts are measured from zero; readings use the room they need.
    scale: { zero: additive || kind === 'bar', nice: true },
    axis: yAxis,
    ...extra
  });

  if (kind === 'bar') {
    // Bars stay slim with air between them; side-by-side bars keep a gap.
    const periods = monthly
      ? Math.round((toUtc(data.end) - toUtc(data.start)) / (30.4 * DAY_MS)) + 1
      : Math.round((toUtc(data.end) - toUtc(data.start)) / DAY_MS) + 1;
    const band = plotWidth / Math.max(1, periods);
    const perBar = monthly ? (band * 0.75) / (multi ? metrics.length : 1) - 3 : band * 0.7;
    const barWidth = Math.max(2, Math.min(monthly ? 32 : 24, Math.floor(perBar)));
    layers.push({
      mark: { type: 'bar', width: barWidth, cornerRadiusEnd: Math.min(4, Math.floor(barWidth / 2)) },
      encoding: {
        x, y: y('value'), color,
        ...(multi && monthly ? { xOffset: { field: 'series', sort: seriesNames } } : {}),
        opacity: { condition: { test: 'datum.partial', value: 0.35 }, value: 1 }
      }
    });
  } else {
    layers.push(...lineLayers({ points, x, y, color, multi, fmt, averageDays }));
  }

  if (Number.isFinite(settings.goal)) {
    const goalLabel = `Goal ${formatNumber(settings.goal, units, fmt)}`;
    layers.push({
      data: { values: [{ goal: settings.goal }] },
      layer: [
        { mark: { type: 'rule', color: CHROME.ink2.light, strokeWidth: 1, strokeDash: [4, 3] }, encoding: { y: { field: 'goal', type: 'quantitative' } } },
        {
          mark: { type: 'text', align: 'right', baseline: 'bottom', dy: -3, x: 'width', fontSize: 11, color: CHROME.ink2.light },
          encoding: { y: { field: 'goal', type: 'quantitative' }, text: { value: goalLabel } }
        }
      ]
    });
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    usermeta: { colors },
    width, height,
    autosize: { type: 'fit', contains: 'padding' },
    padding: { top: 20, right: 24, bottom: 16, left: 20 },
    background: CHROME.surface.light,
    title: {
      text: title, subtitle, anchor: 'start', offset: 16,
      fontSize: 18, fontWeight: 'bold', color: CHROME.ink.light,
      subtitleFontSize: 13, subtitleColor: CHROME.ink2.light, subtitlePadding: 6
    },
    data: { values: points },
    layer: layers,
    resolve: { scale: { y: 'shared' } },
    config: {
      font: FONT,
      view: { stroke: null },
      axis: {
        labelColor: CHROME.muted.light, labelFontSize: 12, labelPadding: 6,
        titleColor: CHROME.ink2.light, titleFontSize: 12, titleFontWeight: 500,
        gridColor: CHROME.grid.light, gridWidth: 1,
        domainColor: CHROME.axis.light, tickColor: CHROME.axis.light
      },
      // Labels are measured with the server's fonts; a viewer's may be wider,
      // so the title keeps a margin.
      axisY: { domain: false, ticks: false, labelPadding: 8, titlePadding: 14 },
      axisX: { domainWidth: 1 },
      legend: {
        orient: 'top', direction: 'horizontal', title: null,
        labelColor: CHROME.ink2.light, labelFontSize: 12, symbolType: 'square', symbolSize: 120,
        offset: 4, columnPadding: 18
      }
    }
  };
}

// ---------------------------------------------------------------- dark mode

/**
 * Give an SVG written in the light palette its own dark one.
 *
 * Vega writes colors as presentation attributes (fill="#2a78d6"); a stylesheet
 * rule beats a presentation attribute, so matching on the attribute value
 * swaps every light color for its dark step without touching the markup.
 * Works wherever the SVG is shown, including as an <img>.
 */
export function addDarkMode(svg, colors = []) {
  const pairs = [
    ...Object.values(CHROME).map(c => [c.light, c.dark]),
    ...SERIES.filter(s => colors.includes(s.light)).map(s => [s.light, s.dark])
  ];
  const rules = pairs.flatMap(([light, dark]) => [
    `[fill="${light}"]{fill:${dark}}`,
    `[stroke="${light}"]{stroke:${dark}}`
  ]);
  const style = `<style>@media (prefers-color-scheme: dark){${rules.join('')}}</style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1${style}`);
}
