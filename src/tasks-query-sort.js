// Parse and apply Obsidian Tasks `sort by` directives.
//
// Directives come in two shapes:
//   { type: 'field', field: 'created', reverse: false }  // sort by created [reverse]
//   { type: 'function', expr: 'task.priority' }          // sort by function <expr>
//
// Date fields sort ascending by default (oldest first); `reverse` flips them.
// `priority` is numeric (higher = more important) and sorts most-important-first
// by default, so its reverse semantics are inverted relative to the date fields.

// Map of `sort by <field>` names to the Date-valued property on a task object.
const DATE_FIELDS = {
  created: 'createdDate',
  due: 'dueDate',
  scheduled: 'scheduledDate',
  done: 'doneDate',
};

// Parse a single `sort by ...` line into a directive, or null if unrecognized.
export function parseSortLine(line) {
  if (line.startsWith('sort by function ')) {
    return { type: 'function', expr: line.replace('sort by function ', '').trim() };
  }
  const sortMatch = line.match(/sort by (\w+)( reverse)?/);
  if (sortMatch) {
    return { type: 'field', field: sortMatch[1], reverse: !!sortMatch[2] };
  }
  return null;
}

function evalSortFunction(task, expr, debug) {
  try {
    return new Function('task', `return (${expr})`)(task);
  } catch (e) {
    debug(`Error evaluating sort function: ${e.message}`);
    return '';
  }
}

// Compare two tasks for a single sort directive. Returns <0, 0, or >0.
// Returns 0 for unknown fields so an unsupported directive is a no-op rather
// than throwing.
export function compareByDirective(a, b, directive, debug = () => {}) {
  if (directive.type === 'function') {
    const aVal = evalSortFunction(a, directive.expr, debug);
    const bVal = evalSortFunction(b, directive.expr, debug);
    if (typeof aVal === 'string' && typeof bVal === 'string') return aVal.localeCompare(bVal);
    return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
  }

  if (directive.field === 'priority') {
    return directive.reverse ? a.priority - b.priority : b.priority - a.priority;
  }

  const dateField = DATE_FIELDS[directive.field];
  if (dateField) {
    const aTime = a[dateField] ? a[dateField].getTime() : 0;
    const bTime = b[dateField] ? b[dateField].getTime() : 0;
    return directive.reverse ? bTime - aTime : aTime - bTime;
  }

  return 0;
}

// Stably sort tasks in place by directives in priority order (first = primary).
// Mutates and returns the array.
export function sortTasks(tasks, sortDirectives, debug = () => {}) {
  if (!sortDirectives || sortDirectives.length === 0) return tasks;
  tasks.sort((a, b) => {
    for (const directive of sortDirectives) {
      const cmp = compareByDirective(a, b, directive, debug);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  return tasks;
}
