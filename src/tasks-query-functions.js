import path from 'path';

function normalizeFunctionBody(code) {
  return /\breturn\b/.test(code) ? code : `return (${code});`;
}

export function buildTasksQueryContext(urlPath = '') {
  const normalizedPath = String(urlPath).replace(/\\/g, '/');
  const folder = path.posix.dirname(normalizedPath).replace(/^\/+/, '');
  return {
    file: {
      folder: folder === '.' ? '' : folder
    }
  };
}

export function runTasksFilterFunction(task, code, query = {}) {
  try {
    const fn = new Function('task', 'query', normalizeFunctionBody(code));
    return !!fn(task, query);
  } catch {
    return false;
  }
}

export function runTasksGroupFunction(task, expr, query = {}) {
  try {
    const fn = new Function('task', 'query', `return (${expr});`);
    const value = fn(task, query);
    return value == null ? '' : String(value);
  } catch {
    return task?.file?.path || 'Unknown file';
  }
}
