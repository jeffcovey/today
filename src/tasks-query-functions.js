import path from 'path';

export function buildTasksQueryContext(urlPath = '') {
  const normalizedPath = String(urlPath).replace(/\\/g, '/');
  const folder = path.posix.dirname(normalizedPath).replace(/^\/+/, '');
  return {
    file: {
      folder: folder === '.' ? '' : folder
    }
  };
}

export function runTasksFilterFunction(task, code, query = {}, debugLog = () => {}) {
  const source = String(code || '').trim();
  if (!source) return false;
  const log = typeof debugLog === 'function' ? debugLog : () => {};

  try {
    const statementFn = new Function('task', 'query', source);
    const statementResult = statementFn(task, query);
    if (statementResult !== undefined) {
      return !!statementResult;
    }
  } catch (error) {
    log(`Error evaluating filter-by-function statement: ${error.message}`);
    // Fall back to expression evaluation below
  }

  try {
    const expressionFn = new Function('task', 'query', `return (${source});`);
    return !!expressionFn(task, query);
  } catch (error) {
    log(`Error evaluating filter-by-function expression: ${error.message}`);
    return false;
  }
}

export function runTasksGroupFunction(task, expr, query = {}, debugLog = () => {}) {
  const log = typeof debugLog === 'function' ? debugLog : () => {};
  try {
    const fn = new Function('task', 'query', `return (${expr});`);
    const value = fn(task, query);
    return value == null ? '' : String(value);
  } catch (error) {
    log(`Error evaluating group-by-function expression: ${error.message}`);
    return task?.file?.path || 'Unknown file';
  }
}
