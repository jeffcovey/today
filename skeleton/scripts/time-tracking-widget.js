// Time Tracking Widget for Obsidian DataviewJS
// Works on both desktop and mobile
// Usage: await dv.view("scripts/time-tracking-widget", { startDate: '2025-11-02', endDate: '2025-11-02' });

// dv and input are provided by dv.view()
// Handle both string and moment/date objects
let startDate = input.startDate || moment().format('YYYY-MM-DD');
let endDate = input.endDate || moment().format('YYYY-MM-DD');
// Convert to string if needed (Dataview DateTime objects have a .toString() that gives ISO format)
if (typeof startDate !== 'string') {
    // Dataview DateTime objects: extract just the date part (YYYY-MM-DD)
    startDate = startDate.toString ? startDate.toString().substring(0, 10) : moment(startDate).format('YYYY-MM-DD');
}
if (typeof endDate !== 'string') {
    // Dataview DateTime objects: extract just the date part (YYYY-MM-DD)
    endDate = endDate.toString ? endDate.toString().substring(0, 10) : moment(endDate).format('YYYY-MM-DD');
}
const isSingleDay = startDate === endDate;
// Use vault-root-relative path (Obsidian resolves from vault root)
const currentTimerPath = 'logs/time-tracking/current-timer.md';

// Check for running timer
let runningTimer = null;
try {
    const timerContent = await dv.io.load(currentTimerPath);
    if (timerContent && timerContent.trim()) {
        const timerLines = timerContent.trim().split('\n');
        if (timerLines.length >= 2) {
            const description = timerLines[0];
            const startTime = moment(timerLines[1]);
            const durationMinutes = moment().diff(startTime, 'minutes');
            const hours = Math.floor(durationMinutes / 60);
            const minutes = durationMinutes % 60;
            const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
            runningTimer = { description, start: startTime.format('h:mm A'), duration: durationStr, startTime };
        }
    }
} catch (e) {}

// The web server renders this script server-side through a Dataview shim whose
// pseudo-elements serialise to an HTML string, so a handler assigned to
// `.onclick` is silently dropped and the buttons do nothing. Detect that by the
// capability we actually need and emit inline markup calling the web API
// instead. In Obsidian these are real DOM nodes and the original path runs.
const probeEl = dv.el('span', '');
const isWebRender = typeof probeEl.addEventListener !== 'function';
probeEl.style.display = 'none';

const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Descriptions are URI-encoded before going into a handler, for two reasons:
// the server runs every rendered page through a `#topic/x` -> emoji pass that
// would otherwise rewrite the payload and silently drop the tag, and it leaves
// nothing needing quote-escaping. The browser decodes it back.
// encodeURIComponent misses `'`, which would close the JS string literal.
const enc = (s) => encodeURIComponent(String(s)).replace(/'/g, '%27');

// Comfortably tappable on a phone; the old icon was ~20x18px at 60% opacity.
const ICON_BTN_STYLE = 'cursor:pointer;margin-right:8px;min-width:44px;min-height:44px;' +
    'font-size:20px;line-height:1;padding:6px 10px;vertical-align:middle;' +
    'border:1px solid var(--background-modifier-border);border-radius:6px;' +
    'background-color:transparent;color:inherit;';
const CTA_BTN_STYLE = 'cursor:pointer;min-height:44px;padding:8px 16px;font-size:15px;' +
    'border-radius:6px;border:1px solid var(--background-modifier-border);';

// Build an inline onclick that POSTs and reloads. `bodyJs` is raw JS source;
// the whole thing is HTML-escaped exactly once, at the end.
const postAttr = (endpoint, bodyJs, guardJs) => esc(
    `(function(b){${guardJs || ''}b.disabled=true;var o=b.textContent;b.textContent='\u2026';` +
    `fetch('${endpoint}',{method:'POST',headers:{'Content-Type':'application/json'},` +
    `credentials:'same-origin',body:JSON.stringify(${bodyJs})})` +
    `.then(function(r){return r.json()})` +
    `.then(function(d){if(d&&d.success){location.reload()}else{b.disabled=false;` +
    `b.textContent=o;alert('Failed: '+((d&&d.message)||'unknown error'))}})` +
    `.catch(function(e){b.disabled=false;b.textContent=o;alert('Error: '+e.message)})})(this)`);

const container = dv.el('div', '');
container.style.marginBottom = '1em';

if (isWebRender) {
    if (runningTimer) {
        container.innerHTML =
            `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;` +
            `padding:8px 12px;background-color:var(--background-secondary);border-radius:6px;">` +
            `<div style="flex:1;min-width:200px;">\u23f1\ufe0f <strong>${esc(runningTimer.description)}</strong> ` +
            `<span style="color:var(--text-muted);">\u2022 ${esc(runningTimer.duration)}</span></div>` +
            `<button type="button" class="mod-cta" style="${CTA_BTN_STYLE}" ` +
            `onclick="${postAttr('/api/track/stop', '{}')}">\u23f9 Stop</button></div>`;
    } else {
        // Note the space in "#topic/ tags": without it the server's tag pass
        // strips the example out of the placeholder.
        const guard = `var i=document.getElementById('today-timer-input');` +
            `var v=(i&&i.value||'').trim();if(!v){alert('Please enter a description');return}`;
        container.innerHTML =
            `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">` +
            `<input id="today-timer-input" type="text" ` +
            `placeholder="Start tracking... (include #topic/ tags)" ` +
            `style="flex:1;min-width:200px;min-height:44px;padding:8px 12px;font-size:15px;` +
            `border-radius:6px;border:1px solid var(--background-modifier-border);">` +
            `<button type="button" class="mod-cta" style="${CTA_BTN_STYLE}" ` +
            `onclick="${postAttr('/api/track/start', '{description:v}', guard)}">\u25b6 Start</button></div>`;
    }
} else if (runningTimer) {
    const timerContainer = container.createEl('div', { cls: 'timer-running' });
    timerContainer.style.display = 'flex';
    timerContainer.style.alignItems = 'center';
    timerContainer.style.gap = '10px';
    timerContainer.style.padding = '8px 12px';
    timerContainer.style.backgroundColor = 'var(--background-secondary)';
    timerContainer.style.borderRadius = '6px';

    const timerText = timerContainer.createEl('div');
    timerText.innerHTML = `⏱️ <strong>${runningTimer.description}</strong> <span style="color: var(--text-muted);">• ${runningTimer.duration}</span>`;
    timerText.style.flex = '1';

    const stopBtn = timerContainer.createEl('button', { text: '⏹ Stop', cls: 'mod-cta' });
    stopBtn.style.cssText = CTA_BTN_STYLE;
    stopBtn.onclick = async () => {
        try {
            const now = moment().format('YYYY-MM-DDTHH:mm:ssZ');
            const currentMonth = moment().format('YYYY-MM');
            const monthFilePath = `logs/time-tracking/${currentMonth}.md`;
            let monthContent = '';
            try { monthContent = await dv.io.load(monthFilePath); } catch (e) {}
            const entry = `${runningTimer.startTime.format('YYYY-MM-DDTHH:mm:ssZ')}|${now}|${runningTimer.description}\n`;
            await dv.app.vault.adapter.write(monthFilePath, monthContent + entry);
            await dv.app.vault.adapter.write(currentTimerPath, '');
            location.reload();
        } catch (error) { alert('Error: ' + error.message); }
    };
} else {
    const formContainer = container.createEl('div');
    formContainer.style.display = 'flex';
    formContainer.style.alignItems = 'center';
    formContainer.style.gap = '10px';

    const input = formContainer.createEl('input', { type: 'text', placeholder: 'Start tracking... (include #topic/tags)' });
    input.style.flex = '1';
    input.style.minHeight = '44px';
    input.style.boxSizing = 'border-box';
    input.style.padding = '6px 12px';
    input.style.fontSize = '14px';
    input.style.borderRadius = '4px';
    input.style.border = '1px solid var(--background-modifier-border)';

    const startBtn = formContainer.createEl('button', { text: '▶ Start', cls: 'mod-cta' });
    startBtn.style.cssText = CTA_BTN_STYLE;
    startBtn.onclick = async () => {
        const description = input.value.trim();
        if (!description) { alert('Please enter a description'); return; }
        try {
            const now = moment().format('YYYY-MM-DDTHH:mm:ssZ');
            await dv.app.vault.adapter.write(currentTimerPath, `${description}\n${now}`);
            location.reload();
        } catch (error) { alert('Error: ' + error.message); }
    };
    input.onkeypress = (e) => { if (e.key === 'Enter') startBtn.click(); };
}

const entries = [];
let totalMinutes = 0;
const topicMinutes = {};
const monthsToRead = new Set();
let currentDate = moment(startDate);
const finalDate = moment(endDate);
while (currentDate.isSameOrBefore(finalDate)) {
    monthsToRead.add(currentDate.format('YYYY-MM'));
    currentDate.add(1, 'month').startOf('month');
}

for (const yearMonth of monthsToRead) {
    try {
        const content = await dv.io.load(`logs/time-tracking/${yearMonth}.md`);
        const lines = content.split('\n').filter(line => line.trim());
        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length >= 3) {
                const start = parts[0].trim();
                const end = parts[1].trim();
                const description = parts[2].trim();
                const entryDate = start.substring(0, 10);
                if (entryDate >= startDate && entryDate <= endDate) {
                    const startTime = moment(start);
                    const endTime = moment(end);
                    const durationMinutes = endTime.diff(startTime, 'minutes');
                    const hours = Math.floor(durationMinutes / 60);
                    const minutes = durationMinutes % 60;
                    const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                    totalMinutes += durationMinutes;
                    const topicMatches = description.match(/#topic\/[\w_]+/g);
                    if (topicMatches && topicMatches.length > 0) {
                        // Add duration to each individual topic
                        for (const topic of topicMatches) {
                            topicMinutes[topic] = (topicMinutes[topic] || 0) + durationMinutes;
                        }
                    } else {
                        // No topics found
                        topicMinutes['(untagged)'] = (topicMinutes['(untagged)'] || 0) + durationMinutes;
                    }
                    entries.push({ start: startTime.format('h:mm A'), date: entryDate, duration: durationStr, description });
                }
            }
        }
    } catch (e) {}
}

if (entries.length > 0) {
    // Create collapsible details element for history
    const details = dv.el('details', '');
    details.style.marginTop = '12px';

    const summary = details.createEl('summary');
    summary.style.cursor = 'pointer';
    summary.style.marginBottom = '8px';
    summary.style.fontSize = '13px';
    summary.style.color = 'var(--text-muted)';
    const historyLabel = isSingleDay ? "Today's History" : "Period History";
    summary.textContent = `📋 ${historyLabel} (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`;

    const tableContainer = details.createEl('div');
    tableContainer.style.marginTop = '8px';

    const tableData = entries.map(e => {
        const descContainerWeb = isWebRender ? dv.el('span', '') : null;
        if (descContainerWeb) {
            // `.onclick`/`.title` never survive the shim, so inline the markup.
            // POSTing to /api/track/start is also safer than the Obsidian path
            // below: `bin/track start` stops a running timer instead of
            // overwriting current-timer.md and losing it.
            descContainerWeb.innerHTML =
                `<button type="button" title="Start new timer with this description" ` +
                `aria-label="Start new timer" style="${ICON_BTN_STYLE}" ` +
                `onclick="${postAttr('/api/track/start', `{description:decodeURIComponent('${enc(e.description)}')}`)}">` +
                `\u21bb</button>` +
                `<span style="vertical-align:middle;">${esc(e.description)}</span>`;
            return isSingleDay
                ? [e.start, e.duration, descContainerWeb]
                : [e.date, e.start, e.duration, descContainerWeb];
        }
        const btn = dv.el('button', '↻');
        btn.style.cssText = ICON_BTN_STYLE;
        btn.title = 'Start new timer with this description';
        btn.onclick = async () => {
            try {
                const now = moment().format('YYYY-MM-DDTHH:mm:ssZ');
                await dv.app.vault.adapter.write(currentTimerPath, `${e.description}\n${now}`);
                location.reload();
            } catch (error) { alert('Error: ' + error.message); }
        };
        const descContainer = dv.el('span', '');
        descContainer.appendChild(btn);
        descContainer.appendText(e.description);
        // Include date for multi-day views
        return isSingleDay ? [e.start, e.duration, descContainer] : [e.date, e.start, e.duration, descContainer];
    });

    // Render table into the details container
    const table = dv.el('table', '', { container: tableContainer });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    const headers = isSingleDay ? ['Start', 'Duration', 'Description'] : ['Date', 'Start', 'Duration', 'Description'];
    headers.forEach(h => {
        headerRow.createEl('th', { text: h });
    });
    const tbody = table.createEl('tbody');
    tableData.forEach(row => {
        const tr = tbody.createEl('tr');
        row.forEach(cell => {
            const td = tr.createEl('td');
            if (typeof cell === 'string') {
                td.textContent = cell;
            } else {
                td.appendChild(cell);
            }
        });
    });

    // Add topic summary inside the collapsible section
    if (Object.keys(topicMinutes).length > 0) {
        const sortedTopics = Object.entries(topicMinutes).sort((a, b) => b[1] - a[1]);
        const summaryDiv = details.createEl('div', '');
        summaryDiv.style.marginTop = '12px';
        summaryDiv.style.fontSize = '13px';
        summaryDiv.style.color = 'var(--text-muted)';
        summaryDiv.style.lineHeight = '1.4';
        for (const [topic, mins] of sortedTopics) {
            const hours = Math.floor(mins / 60);
            const minutes = mins % 60;
            const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
            summaryDiv.createEl('div', { text: `${topic}: ${durationStr}` });
        }
    }

    // Add total inside the collapsible section
    if (totalMinutes > 0) {
        const totalHours = Math.floor(totalMinutes / 60);
        const totalMins = totalMinutes % 60;
        const totalStr = totalHours > 0 ? `${totalHours}h ${totalMins}m` : `${totalMins}m`;
        const totalDiv = details.createEl('div', '');
        totalDiv.style.marginTop = '8px';
        totalDiv.style.fontSize = '14px';
        totalDiv.style.fontWeight = 'bold';
        totalDiv.innerHTML = `Total: ${totalStr}`;
    }
} else if (entries.length === 0) {
    dv.paragraph("No time entries for this period");
}
