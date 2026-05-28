export function parseCreatedAfterDate(filter, tz, now = new Date()) {
  const relativeMatch = filter.match(/^created after (\d+) (days?|weeks?|months?|years?) ago$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const date = new Date(now);

    if (unit.startsWith('day')) {
      date.setDate(date.getDate() - amount);
    } else if (unit.startsWith('week')) {
      date.setDate(date.getDate() - (amount * 7));
    } else if (unit.startsWith('month')) {
      date.setMonth(date.getMonth() - amount);
    } else if (unit.startsWith('year')) {
      date.setFullYear(date.getFullYear() - amount);
    }

    return date.toLocaleDateString('en-CA', { timeZone: tz });
  }

  const absoluteMatch = filter.match(/^created after (\d{4}-\d{2}-\d{2})$/);
  return absoluteMatch ? absoluteMatch[1] : null;
}

export function sortCreatedGroups(entries, reverse = false) {
  return entries.sort((a, b) => {
    if (a[0] === 'No date') return 1;
    if (b[0] === 'No date') return -1;
    return reverse ? b[0].localeCompare(a[0]) : a[0].localeCompare(b[0]);
  });
}
