---
cssclasses: dashboard
---

## ⏱️ Time Tracking - Today

```dataviewjs
await dv.view("scripts/time-tracking-widget", {
    startDate: moment().format('YYYY-MM-DD'),
    endDate: moment().format('YYYY-MM-DD')
});
```

---

## 📅 Today

```dataviewjs
const today = new Date();
const year = today.getFullYear();
const month = String(today.getMonth() + 1).padStart(2, '0');
const day = String(today.getDate()).padStart(2, '0');
const quarter = `Q${Math.ceil((today.getMonth() + 1) / 3)}`;

// Calculate ISO week number (ISO 8601)
function getISOWeek(date) {
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  return Math.ceil((firstThursday - target) / 604800000) + 1;
}
const weekNum = String(getISOWeek(today)).padStart(2, '0');

const dailyFile = `${year}_${quarter}_${month}_W${weekNum}_${day}`;
const weeklyFile = `${year}_${quarter}_${month}_W${weekNum}_00`;
const monthlyFile = `${year}_${quarter}_${month}_00`;
const quarterlyFile = `${year}_${quarter}_00`;
const yearlyFile = `${year}_00`;

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayName = dayNames[today.getDay()];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = monthNames[today.getMonth()];

dv.header(3, `${dayName}, ${monthName} ${day}, ${year}`);
dv.paragraph(`📅 [[plans/${dailyFile}|Today's Plan]] | 📊 [[plans/${weeklyFile}|This Week]] | 📆 [[plans/${monthlyFile}|This Month]] | 🎯 [[plans/${quarterlyFile}|This Quarter]] | 📈 [[plans/${yearlyFile}|This Year]]`);

// Stage theme (customize in config.toml)
const stageThemes = {
  1: { name: "Front Stage", emoji: "🎬", focus: "Meetings, calls, support, emails" },
  3: { name: "Front Stage", emoji: "🎬", focus: "Meetings, calls, support, emails" },
  6: { name: "Front Stage", emoji: "🎬", focus: "Meetings, calls, support, emails" },
  4: { name: "Back Stage", emoji: "🔧", focus: "Maintenance, bills, bug fixes, organizing" },
  0: { name: "Back Stage", emoji: "🔧", focus: "Maintenance, bills, bug fixes, organizing" },
  2: { name: "Off Stage", emoji: "🎨", focus: "Personal time, nature, friends, reading" },
  5: { name: "Off Stage", emoji: "🎨", focus: "Personal time, nature, friends, reading" }
};
const stage = stageThemes[today.getDay()];
dv.paragraph(`${stage.emoji} **${stage.name}** - ${stage.focus}`);
```

## 📊 Today's Progress

```dataviewjs
const todayDate = moment().format('YYYY-MM-DD');
const completedToday = dv.pages('"vault"').file.tasks
  .where(t => t.completed && t.completion && t.completion.toFormat("yyyy-MM-dd") === todayDate);
const completedCount = completedToday.length;

// Create a stat card display
const container = dv.el('div', '', { cls: 'stat-card' });
const value = container.createEl('div', { text: completedCount, cls: 'stat-value' });
const label = container.createEl('div', { text: 'Tasks Completed Today', cls: 'stat-label' });
```

## 📅 Upcoming Events

```dataviewjs
await dv.view("scripts/upcoming-events-widget");
```

> [!note]- 📅 Due or Scheduled Today
>
> ```tasks
> not done
> (scheduled before tomorrow) OR (due before tomorrow)
> sort by priority
> group by happens
> ```

## 📝 Recent Notes

```dataview
TABLE WITHOUT ID
  file.link as "Note",
  dateformat(file.mtime, "MMM dd, yyyy HH:mm") as "Modified"
FROM "notes/general"
SORT file.mtime DESC
LIMIT 5
```
