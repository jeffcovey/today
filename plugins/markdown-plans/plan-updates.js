import fs from 'fs';

export function updateTomorrowPlan(filePath, suggestions, rewritePlanFile) {
  if (!suggestions || (!suggestions.focus && !suggestions.priorities)) return false;

  const original = fs.readFileSync(filePath, 'utf-8');
  let content = original;
  let modified = false;

  if (suggestions.focus) {
    const focusReplacement = `<!-- TODAY_FOCUS: Day theme and focus area -->\n## 🎯 Today's Focus\n\n${suggestions.focus}\n\n<!-- /TODAY_FOCUS -->`;
    const newContent = content.replace(
      /<!-- TODAY_FOCUS:.*?-->\s*## 🎯 Today's Focus\s*<!-- \/TODAY_FOCUS -->/s,
      focusReplacement
    );
    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }

  if (suggestions.priorities) {
    const prioritiesReplacement = `<!-- TOP_PRIORITIES: Auto-generated from database -->\n## 📋 Top Priorities\n\n${suggestions.priorities}\n\n<!-- /TOP_PRIORITIES -->`;
    const newContent = content.replace(
      /<!-- TOP_PRIORITIES:.*?-->\s*## 📋 Top Priorities\s*(?:\{\{PRIORITIES_FROM_DATABASE\}\})?\s*<!-- \/TOP_PRIORITIES -->/s,
      prioritiesReplacement
    );
    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }

  return modified && rewritePlanFile(filePath, (latest) => (latest === original ? content : null));
}
