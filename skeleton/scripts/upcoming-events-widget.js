// Upcoming Events Widget for Obsidian DataviewJS
// Reads calendar events from synced JSON file
// Usage: await dv.view("scripts/upcoming-events-widget");

const container = dv.el('div', '');

try {
    // Read the calendar events JSON file (synced by bin/sync)
    const eventsJson = await dv.io.load('logs/sync/calendar-events.json');

    if (!eventsJson || !eventsJson.trim()) {
        container.createEl('p', { text: 'No upcoming events', cls: 'text-muted' });
        return;
    }

    const events = JSON.parse(eventsJson);

    if (!events || events.length === 0) {
        container.createEl('p', { text: 'No upcoming events', cls: 'text-muted' });
        return;
    }

    const table = container.createEl('table');
    table.style.width = '100%';

    // Create header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Time' });
    headerRow.createEl('th', { text: 'Event' });
    headerRow.createEl('th', { text: 'Location' });

    // Create body
    const tbody = table.createEl('tbody');

    // Show up to 5 events
    const eventsToShow = events.slice(0, 5);

    for (const event of eventsToShow) {
        const startDate = new Date(event.start);
        const endDate = new Date(event.end);

        // Format time (skip time if it's an all-day event)
        let timeStr;
        if (event.start.length === 10) {
            // All-day event (date only, no time)
            timeStr = 'All day';
        } else {
            timeStr = `${startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
        }

        const row = tbody.createEl('tr');
        row.createEl('td', { text: timeStr });
        row.createEl('td', { text: event.title });
        row.createEl('td', { text: event.location || '' });
    }

} catch (error) {
    container.createEl('p', { text: `⚠️ Error: ${error.message}` });
}
