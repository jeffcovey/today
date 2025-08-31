// Date parser for natural language date tags in task titles
import { getTimezone } from './config.js';

export class DateParser {
  constructor() {
    // Get today in configured timezone
    const now = new Date();
    const localTime = new Intl.DateTimeFormat('en-US', {
      timeZone: getTimezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
    const [month, day, year] = localTime.split('/');
    this.today = `${year}-${month}-${day}`;
    this.todayDate = new Date(`${this.today}T00:00:00`);
  }

  // Extract all date tags from text
  extractDateTags(text) {
    const tags = [];
    // Match @ followed by date patterns, but not @mentions or emails
    // Negative lookbehind for letters, negative lookahead for @
    const regex = /(?<![a-zA-Z])@(today|tomorrow|yesterday|tonight|weekend|nextweek|lastweek|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+[dwmy]|next\s+\w+|last\s+\w+|in\s+\d+\s+\w+|\w+\s+\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/gi;
    
    let match;
    while ((match = regex.exec(text)) !== null) {
      const tag = match[0];
      const tagContent = match[1];
      const parsed = this.parse(tagContent);
      if (parsed) {
        tags.push({
          tag,
          content: tagContent,
          parsed,
          index: match.index,
          length: tag.length
        });
      }
    }
    
    return tags;
  }

  // Remove date tags from text
  removeTagsFromText(text, tags) {
    if (!tags || tags.length === 0) return text;
    
    // Sort tags by index in reverse order to remove from end to start
    const sortedTags = [...tags].sort((a, b) => b.index - a.index);
    
    let result = text;
    for (const tag of sortedTags) {
      // Remove the tag and any trailing/leading spaces
      const before = result.substring(0, tag.index);
      const after = result.substring(tag.index + tag.length);
      
      // Clean up extra spaces
      result = (before.trimEnd() + ' ' + after.trimStart()).trim();
    }
    
    // Clean up any double spaces
    return result.replace(/\s+/g, ' ').trim();
  }

  // Parse a date tag content (without the @)
  parse(input) {
    if (!input) return null;
    
    const normalized = input.toLowerCase().trim();
    
    // Quick tags
    if (normalized === 'today' || normalized === 'tonight') {
      return this.today;
    }
    
    if (normalized === 'tomorrow') {
      return this.addDays(this.todayDate, 1);
    }
    
    if (normalized === 'yesterday') {
      return this.addDays(this.todayDate, -1);
    }
    
    if (normalized === 'weekend') {
      // Next Saturday
      const daysUntilSaturday = (6 - this.todayDate.getDay() + 7) % 7 || 7;
      return this.addDays(this.todayDate, daysUntilSaturday);
    }
    
    if (normalized === 'nextweek') {
      // Next Monday
      const daysUntilMonday = (1 - this.todayDate.getDay() + 7) % 7 || 7;
      return this.addDays(this.todayDate, daysUntilMonday);
    }
    
    if (normalized === 'lastweek') {
      // Last Monday
      const daysToLastMonday = this.todayDate.getDay() === 0 ? -6 : -(this.todayDate.getDay() + 6);
      return this.addDays(this.todayDate, daysToLastMonday);
    }
    
    // Weekday names
    const weekdayResult = this.parseWeekday(normalized);
    if (weekdayResult) return weekdayResult;
    
    // Relative time (3d, 2w, 1m, 1y)
    const relativeResult = this.parseRelativeTime(normalized);
    if (relativeResult) return relativeResult;
    
    // "next [weekday]" or "last [weekday]"
    const nextLastResult = this.parseNextLast(normalized);
    if (nextLastResult) return nextLastResult;
    
    // "in X days/weeks/months"
    const inXResult = this.parseInX(normalized);
    if (inXResult) return inXResult;
    
    // Absolute dates (aug 25, 8/25, 8/25/2025)
    const absoluteResult = this.parseAbsoluteDate(normalized);
    if (absoluteResult) return absoluteResult;
    
    return null;
  }

  // Parse weekday names (defaults to next occurrence)
  parseWeekday(input) {
    const weekdays = {
      'mon': 1, 'monday': 1,
      'tue': 2, 'tuesday': 2,
      'wed': 3, 'wednesday': 3,
      'thu': 4, 'thursday': 4,
      'fri': 5, 'friday': 5,
      'sat': 6, 'saturday': 6,
      'sun': 0, 'sunday': 0
    };
    
    if (weekdays.hasOwnProperty(input)) {
      const targetDay = weekdays[input];
      const currentDay = this.todayDate.getDay();
      let daysToAdd = (targetDay - currentDay + 7) % 7;
      if (daysToAdd === 0) daysToAdd = 7; // Next week if today
      return this.addDays(this.todayDate, daysToAdd);
    }
    
    return null;
  }

  // Parse relative time (3d, 2w, 1m, 1y)
  parseRelativeTime(input) {
    const match = input.match(/^(\d+)([dwmy])$/);
    if (!match) return null;
    
    const amount = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 'd': return this.addDays(this.todayDate, amount);
      case 'w': return this.addDays(this.todayDate, amount * 7);
      case 'm': return this.addMonths(this.todayDate, amount);
      case 'y': return this.addMonths(this.todayDate, amount * 12);
      default: return null;
    }
  }

  // Parse "next [weekday]" or "last [weekday]"
  parseNextLast(input) {
    const match = input.match(/^(next|last)\s+(\w+)$/);
    if (!match) return null;
    
    const direction = match[1];
    const day = match[2];
    
    const weekdayNum = this.parseWeekday(day);
    if (!weekdayNum) return null;
    
    if (direction === 'last') {
      // Convert the result to a date, then go back a week
      const nextDate = new Date(weekdayNum + 'T00:00:00');
      return this.addDays(nextDate, -7);
    }
    
    return weekdayNum;
  }

  // Parse "in X days/weeks/months"
  parseInX(input) {
    const match = input.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/);
    if (!match) return null;
    
    const amount = parseInt(match[1]);
    const unit = match[2];
    
    if (unit.startsWith('day')) {
      return this.addDays(this.todayDate, amount);
    } else if (unit.startsWith('week')) {
      return this.addDays(this.todayDate, amount * 7);
    } else if (unit.startsWith('month')) {
      return this.addMonths(this.todayDate, amount);
    }
    
    return null;
  }

  // Parse absolute dates
  parseAbsoluteDate(input) {
    // MM/DD or MM/DD/YYYY
    const slashMatch = input.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (slashMatch) {
      const month = slashMatch[1].padStart(2, '0');
      const day = slashMatch[2].padStart(2, '0');
      const year = slashMatch[3] ? 
        (slashMatch[3].length === 2 ? '20' + slashMatch[3] : slashMatch[3]) :
        this.todayDate.getFullYear();
      
      return `${year}-${month}-${day}`;
    }
    
    // Month name + day (aug 25, august 25)
    const monthMatch = input.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})$/);
    if (monthMatch) {
      const monthNames = {
        'jan': 1, 'january': 1,
        'feb': 2, 'february': 2,
        'mar': 3, 'march': 3,
        'apr': 4, 'april': 4,
        'may': 5,
        'jun': 6, 'june': 6,
        'jul': 7, 'july': 7,
        'aug': 8, 'august': 8,
        'sep': 9, 'september': 9,
        'oct': 10, 'october': 10,
        'nov': 11, 'november': 11,
        'dec': 12, 'december': 12
      };
      
      const month = monthNames[monthMatch[1]];
      const day = parseInt(monthMatch[2]);
      let year = this.todayDate.getFullYear();
      
      // If the date has passed this year, use next year
      const testDate = new Date(year, month - 1, day);
      if (testDate < this.todayDate) {
        year++;
      }
      
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    
    return null;
  }

  // Helper to add days to a date
  addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return this.formatDate(result);
  }

  // Helper to add months to a date
  addMonths(date, months) {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return this.formatDate(result);
  }

  // Format date as YYYY-MM-DD
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}