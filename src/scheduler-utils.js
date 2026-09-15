const OUTPUT_LINE_LIMIT = 5;

function summarizeOutput(output) {
  const text = output?.toString().trim();
  if (!text) return '';
  return text.split('\n').slice(-OUTPUT_LINE_LIMIT).join('\n');
}

export function formatCommandFailure(description, error) {
  const details = [];
  if (error?.code !== undefined) details.push(`exit code ${error.code}`);
  if (error?.signal) details.push(`signal ${error.signal}`);

  let header = `❌ ${description} failed`;
  if (details.length > 0) {
    header += ` (${details.join(', ')})`;
  }

  const stderr = summarizeOutput(error?.stderr);
  const stdout = summarizeOutput(error?.stdout);

  if (!stderr && !stdout) {
    const fallback = error?.message || String(error);
    return `${header}: ${fallback}`;
  }

  const lines = [header];
  if (stderr) lines.push(stderr);
  if (stdout) {
    lines.push('stdout:');
    lines.push(stdout);
  }
  return lines.join('\n');
}
