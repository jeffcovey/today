// temporal-manager.js
// Handles Day and Week creation with proper relationships

class TemporalManager {
  constructor(notionAPI, cache) {
    this.notionAPI = notionAPI;
    this.cache = cache;
  }

  /**
   * Creates missing temporal entries (days, weeks, months, quarters, years) for a date range
   * @param {Date} startDate - Start date (default: 7 days ago)
   * @param {Date} endDate - End date (default: 7 days from now)
   */
  async createMissingDaysAndWeeks(startDate = null, endDate = null) {
    const today = new Date();
    const start = startDate || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    const end = endDate || new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

    console.log(`Creating missing temporal entries from ${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`);

    try {
      // Get all temporal databases
      const [daysDB, weeksDB, monthsDB, quartersDB, yearsDB] = await Promise.allSettled([
        this.notionAPI.getDaysDatabase(),
        this.notionAPI.getWeeksDatabase(),
        this.notionAPI.getMonthsDatabase().catch(() => null),
        this.notionAPI.getQuartersDatabase().catch(() => null),
        this.notionAPI.getYearsDatabase().catch(() => null)
      ]);

      const databases = {
        days: daysDB.status === 'fulfilled' ? daysDB.value : null,
        weeks: weeksDB.status === 'fulfilled' ? weeksDB.value : null,
        months: monthsDB.status === 'fulfilled' ? monthsDB.value : null,
        quarters: quartersDB.status === 'fulfilled' ? quartersDB.value : null,
        years: yearsDB.status === 'fulfilled' ? yearsDB.value : null
      };

      // DISABLED: No longer creating temporal entries as we're migrating away from Notion
      // Keeping the structure in case we need to reference existing entries
      const existingPeriods = {};

      // Comment out all temporal creation - we're moving away from Notion
      /*
      if (databases.years) {
        existingPeriods.years = await this.getExistingYears(databases.years.id);
        await this.createMissingYears(databases.years.id, existingPeriods.years, start, end);
        existingPeriods.years = await this.getExistingYears(databases.years.id);
      }

      if (databases.quarters) {
        existingPeriods.quarters = await this.getExistingQuarters(databases.quarters.id);
        await this.createMissingQuarters(databases.quarters.id, existingPeriods.quarters, existingPeriods.years, start, end);
        existingPeriods.quarters = await this.getExistingQuarters(databases.quarters.id);
      }

      if (databases.months) {
        existingPeriods.months = await this.getExistingMonths(databases.months.id);
        await this.createMissingMonths(databases.months.id, existingPeriods.months, existingPeriods.quarters, start, end);
        existingPeriods.months = await this.getExistingMonths(databases.months.id);
      }

      if (databases.weeks) {
        existingPeriods.weeks = await this.getExistingWeeks(databases.weeks.id);
        await this.createMissingWeeks(databases.weeks.id, existingPeriods.weeks, existingPeriods.months, start, end);
        existingPeriods.weeks = await this.getExistingWeeks(databases.weeks.id);
      }

      if (databases.days) {
        existingPeriods.days = await this.getExistingDays(databases.days.id);
        await this.createMissingDays(databases.days.id, existingPeriods.days, existingPeriods.weeks, start, end);
      }
      */
      
      console.log('⚠️  Temporal creation disabled - migrating away from Notion');

      console.log('✅ Temporal check complete (creation disabled).');
      
    } catch (error) {
      console.error('❌ Failed to create missing temporal entries:', error.message);
      throw error;
    }
  }

  /**
   * Get existing days from the database
   */
  async getExistingDays(daysDBId) {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const days = await this.notionAPI.getDatabaseItemsIncremental(daysDBId, oneMonthAgo.toISOString(), {
      fetchAll: true,
      useCache: true
    });

    // Extract dates and create lookup map
    const dayMap = new Map();
    days.forEach(day => {
      const dateProperty = day.properties?.Date?.date;
      if (dateProperty && dateProperty.start) {
        dayMap.set(dateProperty.start, day);
      }
    });

    return dayMap;
  }

  /**
   * Get existing weeks from the database
   */
  async getExistingWeeks(weeksDBId) {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const weeks = await this.notionAPI.getDatabaseItemsIncremental(weeksDBId, oneMonthAgo.toISOString(), {
      fetchAll: true,
      useCache: true
    });

    // Extract week start dates and create lookup map
    const weekMap = new Map();
    weeks.forEach(week => {
      const dateProperty = week.properties?.Date?.date;
      if (dateProperty && dateProperty.start) {
        weekMap.set(dateProperty.start, week);
      }
    });

    return weekMap;
  }

  /**
   * Create missing weeks for the date range
   */
  async createMissingWeeks(weeksDBId, existingWeeks, existingMonths, startDate, endDate) {
    const weeksToCreate = [];
    
    // Generate all week start dates (Sundays) in the range
    const current = new Date(startDate);
    
    while (current <= endDate) {
      const weekStart = this.getWeekStart(current);
      const weekStartStr = this.formatDate(weekStart);
      
      // Check if this week already exists
      if (!existingWeeks.has(weekStartStr)) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6); // Saturday
        
        // Find which months this week spans
        const monthEntries = [];
        if (existingMonths) {
          const weekDates = [];
          for (let d = new Date(weekStart); d <= weekEnd; d.setDate(d.getDate() + 1)) {
            weekDates.push(new Date(d));
          }
          
          const monthsInWeek = new Set();
          weekDates.forEach(date => {
            const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            if (existingMonths.has(monthKey)) {
              monthsInWeek.add(monthKey);
            }
          });
          
          monthsInWeek.forEach(monthKey => {
            const monthEntry = existingMonths.get(monthKey);
            if (monthEntry) {
              monthEntries.push(monthEntry);
            }
          });
        }
        
        weeksToCreate.push({
          start: weekStart,
          end: weekEnd,
          startStr: weekStartStr,
          endStr: this.formatDate(weekEnd),
          monthEntries: monthEntries
        });
      }
      
      // Move to next week
      current.setDate(current.getDate() + 7);
    }

    // Create the missing weeks
    for (const week of weeksToCreate) {
      await this.createWeekEntry(weeksDBId, week);
    }

    console.log(`📅 Created ${weeksToCreate.length} missing weeks`);
  }

  /**
   * Create missing days for the date range
   */
  async createMissingDays(daysDBId, existingDays, existingWeeks, startDate, endDate) {
    const daysToCreate = [];
    
    // Generate all dates in the range
    const current = new Date(startDate);
    
    while (current <= endDate) {
      const dateStr = this.formatDate(current);
      
      // Check if this day already exists
      if (!existingDays.has(dateStr)) {
        const weekStart = this.getWeekStart(current);
        const weekStartStr = this.formatDate(weekStart);
        const week = existingWeeks.get(weekStartStr);
        
        if (!week) {
          console.warn(`⚠️ No week found for date ${dateStr} (week start: ${weekStartStr})`);
          current.setDate(current.getDate() + 1);
          continue;
        }

        // Find previous day
        const previousDate = new Date(current);
        previousDate.setDate(previousDate.getDate() - 1);
        const previousDateStr = this.formatDate(previousDate);
        const previousDay = existingDays.get(previousDateStr);

        daysToCreate.push({
          date: new Date(current),
          dateStr: dateStr,
          week: week,
          previousDay: previousDay
        });
      }
      
      current.setDate(current.getDate() + 1);
    }

    // Create the missing days
    for (const day of daysToCreate) {
      const createdDay = await this.createDayEntry(daysDBId, day);
      // Add to existingDays map so subsequent days can reference it as previousDay
      existingDays.set(day.dateStr, createdDay);
    }

    console.log(`📆 Created ${daysToCreate.length} missing days`);
  }

  /**
   * Create a single week entry in Notion
   */
  async createWeekEntry(weeksDBId, week) {
    const weekTitle = `${this.formatDateForTitle(week.start)} - ${this.formatDateForTitle(week.end)}, ${week.start.getFullYear()} <<`;
    
    console.log(`Creating week: ${weekTitle}`);

    const properties = {};

    // Get the date property name dynamically
    const dateProperty = await this.getDatePropertyName(weeksDBId);
    properties[dateProperty] = {
      date: {
        start: week.startStr,
        end: week.endStr
      }
    };

    // Add month relationships if available
    if (week.monthEntries && week.monthEntries.length > 0) {
      properties.Months = {
        relation: week.monthEntries.map(month => ({ id: month.id }))
      };
    }

    // Add title property (check what the title property is called)
    const titleProperty = await this.getTitlePropertyName(weeksDBId);
    properties[titleProperty] = {
      title: [{
        type: "text",
        text: { content: weekTitle }
      }]
    };

    const response = await this.notionAPI.notion.pages.create({
      parent: { database_id: weeksDBId },
      properties: properties
    });
    
    // Store in temporal sync cache
    await this.storeTemporalSync(week.startStr, null, response.id, week.startStr);
    
    return response;
  }

  /**
   * Create a single day entry in Notion
   */
  async createDayEntry(daysDBId, day) {
    const dayTitle = `${day.dateStr} <<`;
    
    console.log(`Creating day: ${dayTitle}`);

    const properties = {};

    // Get the date property name dynamically
    const dateProperty = await this.getDatePropertyName(daysDBId);
    properties[dateProperty] = {
      date: {
        start: day.dateStr
      }
    };

    properties.Week = {
      relation: [{ id: day.week.id }]
    };

    // Add previous day relationship if it exists
    if (day.previousDay) {
      properties.Yesterday = {
        relation: [{ id: day.previousDay.id }]
      };
    }

    // Add title property
    const titleProperty = await this.getTitlePropertyName(daysDBId);
    properties[titleProperty] = {
      title: [{
        type: "text", 
        text: { content: dayTitle }
      }]
    };

    const response = await this.notionAPI.notion.pages.create({
      parent: { database_id: daysDBId },
      properties: properties
    });
    
    // Store in temporal sync cache
    await this.storeTemporalSync(
      day.dateStr, 
      response.id, 
      day.week.id, 
      this.formatDate(this.getWeekStart(day.date)),
      day.previousDay?.id
    );
    
    return response;
  }

  /**
   * Get the title property name for a database
   */
  async getTitlePropertyName(databaseId) {
    try {
      const database = await this.notionAPI.notion.databases.retrieve({ database_id: databaseId });
      
      // Find the title property
      for (const [propertyName, propertyConfig] of Object.entries(database.properties)) {
        if (propertyConfig.type === 'title') {
          return propertyName;
        }
      }
      
      // Fallback to common names
      return 'Name';
    } catch (error) {
      console.warn(`Warning: Could not determine title property for database ${databaseId}, using 'Name'`);
      return 'Name';
    }
  }

  async getDatePropertyName(databaseId) {
    try {
      const database = await this.notionAPI.notion.databases.retrieve({ database_id: databaseId });
      
      // Find the date property
      for (const [propertyName, propertyConfig] of Object.entries(database.properties)) {
        if (propertyConfig.type === 'date') {
          return propertyName;
        }
      }
      
      // Fallback to common names
      return 'Date';
    } catch (error) {
      console.warn(`Warning: Could not determine date property for database ${databaseId}, using 'Date'`);
      return 'Date';
    }
  }

  /**
   * Store temporal sync information in SQLite cache
   */
  async storeTemporalSync(date, dayId, weekId, weekStartDate, previousDayId = null) {
    const now = Date.now();
    
    const stmt = this.cache.db.prepare(`
      INSERT OR REPLACE INTO temporal_sync 
      (date, day_id, week_id, created_at, synced_at, week_start_date, previous_day_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(date, dayId, weekId, now, now, weekStartDate, previousDayId);
  }

  /**
   * Get the start of the week (Sunday) for a given date
   */
  getWeekStart(date) {
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay()); // Subtract day of week to get to Sunday
    return weekStart;
  }

  /**
   * Format date as YYYY-MM-DD
   */
  formatDate(date) {
    return date.toISOString().split('T')[0];
  }

  /**
   * Format date for display in titles (e.g., "January 15")
   */
  formatDateForTitle(date) {
    const options = { month: 'long', day: 'numeric' };
    let formatted = date.toLocaleDateString('en-US', options);
    
    // For the end date of the week, add year if different from start
    const today = new Date();
    if (date.getFullYear() !== today.getFullYear()) {
      formatted += `, ${date.getFullYear()}`;
    }
    
    return formatted;
  }

  // Higher-level temporal period methods

  /**
   * Get existing years from the database
   */
  async getExistingYears(yearsDBId) {
    const years = await this.notionAPI.getDatabaseItemsIncremental(yearsDBId, '2020-01-01', {
      fetchAll: true,
      useCache: true
    });

    const yearMap = new Map();
    years.forEach(year => {
      const dateProperty = year.properties?.Date?.date;
      if (dateProperty && dateProperty.start) {
        const yearValue = new Date(dateProperty.start).getFullYear();
        yearMap.set(yearValue, year);
      }
    });

    return yearMap;
  }

  /**
   * Get existing quarters from the database
   */
  async getExistingQuarters(quartersDBId) {
    const quarters = await this.notionAPI.getDatabaseItemsIncremental(quartersDBId, '2020-01-01', {
      fetchAll: true,
      useCache: true
    });

    const quarterMap = new Map();
    quarters.forEach(quarter => {
      const dateProperty = quarter.properties?.Date?.date;
      if (dateProperty && dateProperty.start) {
        const date = new Date(dateProperty.start);
        const year = date.getFullYear();
        const quarterNum = Math.floor(date.getMonth() / 3) + 1;
        const key = `${year}-Q${quarterNum}`;
        quarterMap.set(key, quarter);
      }
    });

    return quarterMap;
  }

  /**
   * Get existing months from the database
   */
  async getExistingMonths(monthsDBId) {
    const months = await this.notionAPI.getDatabaseItemsIncremental(monthsDBId, '2020-01-01', {
      fetchAll: true,
      useCache: true
    });

    const monthMap = new Map();
    months.forEach(month => {
      const dateProperty = month.properties?.Date?.date;
      if (dateProperty && dateProperty.start) {
        const date = new Date(dateProperty.start);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        monthMap.set(key, month);
      }
    });

    return monthMap;
  }

  /**
   * Create missing years for the date range
   */
  async createMissingYears(yearsDBId, existingYears, startDate, endDate) {
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();
    const yearsToCreate = [];

    for (let year = startYear; year <= endYear; year++) {
      if (!existingYears.has(year)) {
        yearsToCreate.push(year);
      }
    }

    for (const year of yearsToCreate) {
      await this.createYearEntry(yearsDBId, year);
    }

    console.log(`📅 Created ${yearsToCreate.length} missing years`);
  }

  /**
   * Create missing quarters for the date range
   */
  async createMissingQuarters(quartersDBId, existingQuarters, existingYears, startDate, endDate) {
    const quartersToCreate = [];
    
    let current = new Date(startDate.getFullYear(), 0, 1); // Start of year
    const end = new Date(endDate.getFullYear(), 11, 31); // End of year

    while (current <= end) {
      const year = current.getFullYear();
      const quarter = Math.floor(current.getMonth() / 3) + 1;
      const key = `${year}-Q${quarter}`;

      if (!existingQuarters.has(key)) {
        const quarterStart = new Date(year, (quarter - 1) * 3, 1);
        const quarterEnd = new Date(year, quarter * 3, 0); // Last day of quarter
        
        quartersToCreate.push({
          year,
          quarter,
          key,
          start: quarterStart,
          end: quarterEnd,
          yearEntry: existingYears ? existingYears.get(year) : null
        });
      }

      // Move to next quarter
      current.setMonth(current.getMonth() + 3);
    }

    for (const quarter of quartersToCreate) {
      await this.createQuarterEntry(quartersDBId, quarter);
    }

    console.log(`📅 Created ${quartersToCreate.length} missing quarters`);
  }

  /**
   * Create missing months for the date range
   */
  async createMissingMonths(monthsDBId, existingMonths, existingQuarters, startDate, endDate) {
    const monthsToCreate = [];
    
    let current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

    while (current <= end) {
      const year = current.getFullYear();
      const month = current.getMonth() + 1;
      const key = `${year}-${String(month).padStart(2, '0')}`;

      if (!existingMonths.has(key)) {
        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 0); // Last day of month
        const quarter = Math.floor((month - 1) / 3) + 1;
        const quarterKey = `${year}-Q${quarter}`;
        
        monthsToCreate.push({
          year,
          month,
          key,
          start: monthStart,
          end: monthEnd,
          quarterEntry: existingQuarters ? existingQuarters.get(quarterKey) : null
        });
      }

      // Move to next month
      current.setMonth(current.getMonth() + 1);
    }

    for (const month of monthsToCreate) {
      await this.createMonthEntry(monthsDBId, month);
    }

    console.log(`📅 Created ${monthsToCreate.length} missing months`);
  }

  /**
   * Create a single year entry
   */
  async createYearEntry(yearsDBId, year) {
    const yearTitle = `${year} <<`;
    
    console.log(`Creating year: ${yearTitle}`);

    const properties = {};

    // Get the date property name dynamically
    const dateProperty = await this.getDatePropertyName(yearsDBId);
    properties[dateProperty] = {
      date: {
        start: `${year}-01-01`,
        end: `${year}-12-31`
      }
    };

    const titleProperty = await this.getTitlePropertyName(yearsDBId);
    properties[titleProperty] = {
      title: [{
        type: "text",
        text: { content: yearTitle }
      }]
    };

    const response = await this.notionAPI.notion.pages.create({
      parent: { database_id: yearsDBId },
      properties: properties
    });
    
    return response;
  }

  /**
   * Create a single quarter entry
   */
  async createQuarterEntry(quartersDBId, quarter) {
    const quarterTitle = `Q${quarter.quarter} ${quarter.year} <<`;
    
    console.log(`Creating quarter: ${quarterTitle}`);

    const properties = {};

    // Get the date property name dynamically
    const dateProperty = await this.getDatePropertyName(quartersDBId);
    properties[dateProperty] = {
      date: {
        start: this.formatDate(quarter.start),
        end: this.formatDate(quarter.end)
      }
    };

    // Add year relationship if available
    if (quarter.yearEntry) {
      properties.Year = {
        relation: [{ id: quarter.yearEntry.id }]
      };
    }

    const titleProperty = await this.getTitlePropertyName(quartersDBId);
    properties[titleProperty] = {
      title: [{
        type: "text",
        text: { content: quarterTitle }
      }]
    };

    const response = await this.notionAPI.notion.pages.create({
      parent: { database_id: quartersDBId },
      properties: properties
    });
    
    return response;
  }

  /**
   * Create a single month entry
   */
  async createMonthEntry(monthsDBId, month) {
    const monthName = month.start.toLocaleDateString('en-US', { month: 'long' });
    const monthTitle = `${monthName} ${month.year} <<`;
    
    console.log(`Creating month: ${monthTitle}`);

    const properties = {};

    // Get the date property name dynamically
    const dateProperty = await this.getDatePropertyName(monthsDBId);
    properties[dateProperty] = {
      date: {
        start: this.formatDate(month.start),
        end: this.formatDate(month.end)
      }
    };

    // Add quarter relationship if available
    if (month.quarterEntry) {
      properties.Quarter = {
        relation: [{ id: month.quarterEntry.id }]
      };
    }

    const titleProperty = await this.getTitlePropertyName(monthsDBId);
    properties[titleProperty] = {
      title: [{
        type: "text",
        text: { content: monthTitle }
      }]
    };

    const response = await this.notionAPI.notion.pages.create({
      parent: { database_id: monthsDBId },
      properties: properties
    });
    
    return response;
  }
}

export { TemporalManager };