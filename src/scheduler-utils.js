export function formatCommandFailure(error) {
  const stderr = error?.stderr?.toString().trim();
  if (stderr) return stderr;
  return error?.message || String(error);
}
