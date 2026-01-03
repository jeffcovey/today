// Calendar Events Widget for Obsidian DataviewJS
// Shows upcoming events from Today's calendar sync system
// Reads from logs/upcoming-events.json (exported during plugin sync)
// Usage: await dv.view("scripts/calendar-events-widget");

const container = dv.el('div', '');

try {
    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    // Calculate date range (today + next 3 days)
    const endDate = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    const endDateStr = endDate.toISOString().split('T')[0];

    let allEvents = [];
    let timezone = 'UTC'; // Default fallback

    // Load events from the exported JSON file
    try {
        const eventsData = await dv.io.load('logs/upcoming-events.json');
        if (eventsData && eventsData.trim()) {
            const data = JSON.parse(eventsData);
            if (data.entries && Array.isArray(data.entries)) {
                // Use timezone from exported data if available
                timezone = data.timezone || 'UTC';

                // Filter events to next 3 days (since exported file has 30 days)
                allEvents = data.entries.filter(entry => {
                    if (!entry.start) return false;
                    const eventDate = entry.start.split('T')[0];
                    return eventDate >= dateStr && eventDate <= endDateStr;
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
        container.createEl('p', { text: 'No upcoming events in the next 7 days', cls: 'text-muted' });
        return;
    }

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
        const eventDate = new Date(event.start);

        // Format date and time in user's configured timezone
        let dateTimeStr;
        if (event.isAllDay) {
            dateTimeStr = eventDate.toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                timeZone: timezone
            });
        } else {
            dateTimeStr = eventDate.toLocaleString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZone: timezone
            });
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