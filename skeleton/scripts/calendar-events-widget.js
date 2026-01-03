// Calendar Events Widget for Obsidian DataviewJS
// Shows upcoming events from Today's calendar sync system
// Reads from logs/upcoming-events.json (exported during plugin sync)
// Fixed: Proper timezone handling and 3-day range (Jan 3-5)
// Usage: await dv.view("scripts/calendar-events-widget");

// Import timezone-aware formatting function (same as bin/calendar uses)
function parseISO(dateString) {
    return new Date(dateString);
}

function formatTime(date, timezone) {
    const d = typeof date === 'string' ? parseISO(date) : date;
    return d.toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
        hour12: true
    });
}

const container = dv.el('div', '');

try {
    let allEvents = [];
    let timezone = 'UTC'; // Default fallback

    // Load events from the exported JSON file first to get timezone
    try {
        const eventsData = await dv.io.load('logs/upcoming-events.json');
        if (eventsData && eventsData.trim()) {
            const data = JSON.parse(eventsData);
            if (data.entries && Array.isArray(data.entries)) {
                // Use timezone from exported data if available
                timezone = data.timezone || 'UTC';

                // Get today's date in the user's configured timezone (simplified approach)
                const today = new Date();
                const todayStr = today.toLocaleDateString('sv-SE', {timeZone: timezone}); // YYYY-MM-DD format

                // Calculate 3-day range: today, tomorrow, day after
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                const dayAfter = new Date(today);
                dayAfter.setDate(dayAfter.getDate() + 2);

                const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', {timeZone: timezone});
                const dayAfterStr = dayAfter.toLocaleDateString('sv-SE', {timeZone: timezone});

                // Filter events to exactly 3 days: today, tomorrow, day after
                allEvents = data.entries.filter(entry => {
                    if (!entry.start) return false;
                    const eventDate = entry.start.split('T')[0];
                    return eventDate === todayStr || eventDate === tomorrowStr || eventDate === dayAfterStr;
                });
            }
        }
    } catch (err) {
        // If no events file exists, show helpful message
        container.createEl('p', { text: 'No calendar data available. Try running a sync to update calendar events.', cls: 'text-muted' });
        return;
    }

    // Sort events by date
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    if (allEvents.length === 0) {
        container.createEl('p', { text: 'No upcoming events in the next 3 days', cls: 'text-muted' });
        return;
    }

    // Add timezone indicator at the top
    const timezoneInfo = container.createEl('p');
    timezoneInfo.style.fontSize = '12px';
    timezoneInfo.style.color = 'var(--text-muted)';
    timezoneInfo.style.marginBottom = '8px';
    timezoneInfo.textContent = `Times shown in ${timezone}`;

    // Create table
    const table = container.createEl('table');
    table.style.width = '100%';

    // Create header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Date/Time' });
    headerRow.createEl('th', { text: 'Event' });
    headerRow.createEl('th', { text: 'Calendar' });

    // Create body
    const tbody = table.createEl('tbody');

    // Show up to 10 events
    const eventsToShow = allEvents.slice(0, 10);

    for (const event of eventsToShow) {
        // Format date and time in user's configured timezone (same as bin/calendar)
        let dateTimeStr;
        if (event.isAllDay) {
            // For all-day events, parse date as local date to avoid timezone shifts
            const dateParts = event.start.split('-');
            const localDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
            dateTimeStr = localDate.toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric'
            });
        } else {
            const eventDate = new Date(event.start);
            const dateStr = eventDate.toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                timeZone: timezone
            });
            const timeStr = formatTime(event.start, timezone);
            dateTimeStr = `${dateStr}, ${timeStr}`;
        }

        const row = tbody.createEl('tr');
        row.createEl('td', { text: dateTimeStr });

        // Event title with location if available
        const titleCell = row.createEl('td');
        titleCell.createEl('span', { text: event.title });
        if (event.location) {
            titleCell.createEl('br');
            titleCell.createEl('small', { text: event.location, cls: 'text-muted' });
        }

        row.createEl('td', { text: event.calendar });
    }

} catch (error) {
    container.createEl('p', { text: `⚠️ Calendar widget error: ${error.message}` });
    container.createEl('p', { text: 'Try running a sync to update calendar data', cls: 'text-muted' });
}