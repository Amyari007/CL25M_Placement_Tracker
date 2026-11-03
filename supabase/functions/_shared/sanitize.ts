/**
 * Spreadsheet formula-injection protection: text that starts with a
 * character Excel/Sheets/LibreOffice treat as a formula is prefixed with an
 * apostrophe so it is shown as text, never evaluated.
 */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

export function safeCell<T>(v: T): T | string {
  if (typeof v !== 'string') return v;
  return FORMULA_START.test(v) ? `'${v}` : v;
}

/** Applies safeCell to every string value of a row object. */
export function safeRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = safeCell(v);
  return out as T;
}
