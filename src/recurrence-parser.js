/**
 * Recurrence pattern parser for human-readable scheduling
 *
 * Supported patterns:
 * - daily
 * - on weekdays / on weekday
 * - on weekends / on weekend
 * - weekly (defaults to Monday)
 * - weekly on Sunday
 * - weekly on Tuesday and Thursday
 * - monthly (defaults to 1st)
 * - monthly on the 15th
 * - monthly on the last day
 * - monthly on the first Monday
 * - monthly on the third Thursday
 * - quarterly (Jan 1, Apr 1, Jul 1, Oct 1)
 * - yearly / annual (Jan 1)
 * - yearly on March 15
 */

const DAYS_OF_WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
                'july', 'august', 'september', 'october', 'november', 'december'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'last'];

/**
 * Parse a recurrence pattern into a structured object
 * @param {string} pattern - Human-readable recurrence pattern
 * @returns {object} Parsed pattern object
 */
export function parseRecurrence(pattern) {
  const p = pattern.toLowerCase().trim();

  // Daily
  if (p === 'daily') {
    return { type: 'daily' };
  }

  // Weekdays
  if (p === 'on weekdays' || p === 'on weekday' || p === 'weekdays') {
    return { type: 'weekly', days: [1, 2, 3, 4, 5] }; // Mon-Fri
  }

  // Weekends
  if (p === 'on weekends' || p === 'on weekend' || p === 'weekends') {
    return { type: 'weekly', days: [0, 6] }; // Sun, Sat
  }

  // Weekly on specific day(s)
  const weeklyMatch = p.match(/^weekly(?:\s+on\s+(.+))?$/);
  if (weeklyMatch) {
    if (!weeklyMatch[1]) {
      return { type: 'weekly', days: [1] }; // Default to Monday
    }
    const dayNames = weeklyMatch[1].split(/\s+and\s+|,\s*/);
    const days = dayNames.map(d => DAYS_OF_WEEK.indexOf(d.trim())).filter(d => d >= 0);
    return { type: 'weekly', days: days.length > 0 ? days : [1] };
  }

  // Monthly on ordinal weekday (e.g., "monthly on the third Thursday")
  const monthlyOrdinalMatch = p.match(/^monthly\s+on\s+the\s+(first|second|third|fourth|fifth|last)\s+(\w+)$/);
  if (monthlyOrdinalMatch) {
    const ordinal = ORDINALS.indexOf(monthlyOrdinalMatch[1]);
    const dayOfWeek = DAYS_OF_WEEK.indexOf(monthlyOrdinalMatch[2]);
    if (dayOfWeek >= 0) {
      return { type: 'monthly', ordinal, dayOfWeek };
    }
  }

  // Monthly on ordinal "day" (e.g., "monthly on the first day", "monthly on the second day")
  const monthlyOrdinalDayMatch = p.match(/^monthly\s+on\s+the\s+(first|second|third|fourth|fifth)\s+day$/);
  if (monthlyOrdinalDayMatch) {
    const day = ORDINALS.indexOf(monthlyOrdinalDayMatch[1]) + 1;
    return { type: 'monthly', day };
  }

  // Monthly on specific day (e.g., "monthly on the 15th")
  const monthlyDayMatch = p.match(/^monthly(?:\s+on\s+the\s+(\d+)(?:st|nd|rd|th)?)?$/);
  if (monthlyDayMatch) {
    const day = monthlyDayMatch[1] ? parseInt(monthlyDayMatch[1], 10) : 1;
    return { type: 'monthly', day };
  }

  // Monthly on last day
  if (p === 'monthly on the last day') {
    return { type: 'monthly', lastDay: true };
  }

  // Quarterly (with optional "on the first day" suffix)
  if (p === 'quarterly' || p === 'quarterly on the first day') {
    return { type: 'quarterly' };
  }

  // Yearly/Annual on specific date
  const yearlyMatch = p.match(/^(?:yearly|annual)(?:\s+on\s+(\w+)\s+(\d+))?$/);
  if (yearlyMatch) {
    if (!yearlyMatch[1]) {
      return { type: 'yearly', month: 0, day: 1 }; // Default to Jan 1
    }
    const month = MONTHS.indexOf(yearlyMatch[1]);
    const day = parseInt(yearlyMatch[2], 10);
    if (month >= 0 && day > 0) {
      return { type: 'yearly', month, day };
    }
  }

  // Default to daily if unrecognized
  console.warn(`Unrecognized recurrence pattern: "${pattern}", defaulting to daily`);
  return { type: 'daily' };
}

/**
 * Get the start of the current period for a recurrence pattern
 * @param {object} parsed - Parsed recurrence object
 * @param {Date} [date=new Date()] - Reference date
 * @returns {Date} Start of the current period
 */
export function getCurrentPeriodStart(parsed, date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  switch (parsed.type) {
    case 'daily':
      return d;

    case 'weekly': {
      // Find the most recent day that matches
      const currentDay = d.getDay();
      const sortedDays = [...parsed.days].sort((a, b) => a - b);

      // Look for a matching day on or before today
      for (let i = sortedDays.length - 1; i >= 0; i--) {
        if (sortedDays[i] <= currentDay) {
          const result = new Date(d);
          result.setDate(d.getDate() - (currentDay - sortedDays[i]));
          return result;
        }
      }
      // If no match this week, get last occurrence from previous week
      const lastDay = sortedDays[sortedDays.length - 1];
      const result = new Date(d);
      result.setDate(d.getDate() - (currentDay + 7 - lastDay));
      return result;
    }

    case 'monthly': {
      const year = d.getFullYear();
      const month = d.getMonth();

      if (parsed.lastDay) {
        // Last day of current month
        return new Date(year, month + 1, 0);
      }

      if (parsed.ordinal !== undefined && parsed.dayOfWeek !== undefined) {
        // Ordinal weekday (e.g., third Thursday)
        return getOrdinalWeekday(year, month, parsed.ordinal, parsed.dayOfWeek, d);
      }

      // Specific day of month
      const day = Math.min(parsed.day, new Date(year, month + 1, 0).getDate());
      const periodStart = new Date(year, month, day);

      // If we haven't reached this day yet this month, use last month
      if (periodStart > d) {
        const prevMonth = month === 0 ? 11 : month - 1;
        const prevYear = month === 0 ? year - 1 : year;
        const prevDay = Math.min(parsed.day, new Date(prevYear, prevMonth + 1, 0).getDate());
        return new Date(prevYear, prevMonth, prevDay);
      }
      return periodStart;
    }

    case 'quarterly': {
      const year = d.getFullYear();
      const month = d.getMonth();
      const quarterMonth = Math.floor(month / 3) * 3; // 0, 3, 6, or 9
      return new Date(year, quarterMonth, 1);
    }

    case 'yearly': {
      const year = d.getFullYear();
      const targetDate = new Date(year, parsed.month, parsed.day);
      // If we haven't reached this date yet this year, use last year
      if (targetDate > d) {
        return new Date(year - 1, parsed.month, parsed.day);
      }
      return targetDate;
    }

    default:
      return d;
  }
}

/**
 * Get the next period start after a given date
 * @param {object} parsed - Parsed recurrence object
 * @param {Date} afterDate - Date to find next period after
 * @returns {Date} Start of the next period
 */
export function getNextPeriodStart(parsed, afterDate) {
  const d = new Date(afterDate);
  d.setHours(0, 0, 0, 0);

  switch (parsed.type) {
    case 'daily': {
      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      return next;
    }

    case 'weekly': {
      const currentDay = d.getDay();
      const sortedDays = [...parsed.days].sort((a, b) => a - b);

      // Find the next matching day after today
      for (const day of sortedDays) {
        if (day > currentDay) {
          const result = new Date(d);
          result.setDate(d.getDate() + (day - currentDay));
          return result;
        }
      }
      // Wrap to next week
      const firstDay = sortedDays[0];
      const result = new Date(d);
      result.setDate(d.getDate() + (7 - currentDay + firstDay));
      return result;
    }

    case 'monthly': {
      const year = d.getFullYear();
      const month = d.getMonth();

      if (parsed.lastDay) {
        // Last day of next month
        return new Date(year, month + 2, 0);
      }

      if (parsed.ordinal !== undefined && parsed.dayOfWeek !== undefined) {
        // Try next month
        const nextMonth = month === 11 ? 0 : month + 1;
        const nextYear = month === 11 ? year + 1 : year;
        return getOrdinalWeekday(nextYear, nextMonth, parsed.ordinal, parsed.dayOfWeek);
      }

      // Specific day next month
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      const nextDay = Math.min(parsed.day, new Date(nextYear, nextMonth + 1, 0).getDate());
      return new Date(nextYear, nextMonth, nextDay);
    }

    case 'quarterly': {
      const year = d.getFullYear();
      const month = d.getMonth();
      const nextQuarterMonth = (Math.floor(month / 3) + 1) * 3;
      if (nextQuarterMonth >= 12) {
        return new Date(year + 1, nextQuarterMonth - 12, 1);
      }
      return new Date(year, nextQuarterMonth, 1);
    }

    case 'yearly': {
      const year = d.getFullYear();
      return new Date(year + 1, parsed.month, parsed.day);
    }

    default:
      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      return next;
  }
}

/**
 * Check if we've moved into a new period since a scheduled date
 * @param {string} recurrence - Recurrence pattern string
 * @param {Date|string} scheduledDate - The scheduled date on tasks
 * @param {Date} [today=new Date()] - Today's date
 * @returns {boolean} True if we're in a new period
 */
export function isNewPeriod(recurrence, scheduledDate, today = new Date()) {
  const parsed = parseRecurrence(recurrence);
  const scheduled = new Date(scheduledDate);
  scheduled.setHours(0, 0, 0, 0);

  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);

  // If scheduled date is today or in the future, not a new period
  if (scheduled >= todayStart) {
    return false;
  }

  // Get the current period start
  const currentPeriod = getCurrentPeriodStart(parsed, todayStart);

  // If scheduled date is before the current period start, it's a new period
  return scheduled < currentPeriod;
}

/**
 * Get the ordinal weekday of a month (e.g., third Thursday)
 * @param {number} year
 * @param {number} month - 0-indexed
 * @param {number} ordinal - 0=first, 1=second, ... 5=last
 * @param {number} dayOfWeek - 0=Sunday, 1=Monday, ...
 * @param {Date} [referenceDate] - For checking if we've passed this date
 * @returns {Date}
 */
function getOrdinalWeekday(year, month, ordinal, dayOfWeek, referenceDate) {
  if (ordinal === 5) {
    // Last occurrence - work backwards from end of month
    const lastDay = new Date(year, month + 1, 0);
    const lastDayOfWeek = lastDay.getDay();
    const diff = (lastDayOfWeek - dayOfWeek + 7) % 7;
    const result = new Date(lastDay);
    result.setDate(lastDay.getDate() - diff);

    // If reference date provided and result is after it, use previous month
    if (referenceDate && result > referenceDate) {
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      return getOrdinalWeekday(prevYear, prevMonth, ordinal, dayOfWeek);
    }
    return result;
  }

  // Find first occurrence of dayOfWeek in the month
  const first = new Date(year, month, 1);
  const firstDayOfWeek = first.getDay();
  const daysUntilFirst = (dayOfWeek - firstDayOfWeek + 7) % 7;
  const firstOccurrence = 1 + daysUntilFirst;

  // Add weeks for ordinal (0=first, 1=second, etc.)
  const targetDay = firstOccurrence + (ordinal * 7);

  // Make sure it's still in the same month
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (targetDay > daysInMonth) {
    // This ordinal doesn't exist this month (e.g., fifth Monday)
    // Fall back to last occurrence
    return getOrdinalWeekday(year, month, 5, dayOfWeek, referenceDate);
  }

  const result = new Date(year, month, targetDay);

  // If reference date provided and result is after it, use previous month
  if (referenceDate && result > referenceDate) {
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    return getOrdinalWeekday(prevYear, prevMonth, ordinal, dayOfWeek);
  }

  return result;
}

/**
 * Format a date as YYYY-MM-DD
 * @param {Date} date
 * @returns {string}
 */
export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
