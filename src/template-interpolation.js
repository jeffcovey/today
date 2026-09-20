function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function interpolateTemplate(template, data = {}) {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, 'g'), () => value ?? '');
  }
  return result;
}
