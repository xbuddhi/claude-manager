// Structural equality for JSON-like values (settings, backend payloads), so a value that arrives again
// unchanged keeps the object it had and selectors on it do not fire.

// `in` (Object.hasOwn is newer than the lib this builds against); an inherited name never equals a JSON value
const has = (o: object, k: string) => k in o;

/** Deep equality for JSON values (plain objects, arrays, strings, numbers, booleans, null). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!has(b, k)) return false;
    if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * `next` with the values of `prev` kept for every top-level key whose value is structurally equal, and
 * `prev` itself when nothing changed at all.
 */
export function keepEqual<T extends object>(prev: T, next: T): T {
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let changed = Object.keys(p).length !== Object.keys(n).length;
  for (const k of Object.keys(n)) {
    if (has(p, k) && jsonEqual(p[k], n[k])) out[k] = p[k];
    else {
      out[k] = n[k];
      changed = true;
    }
  }
  return changed ? (out as T) : prev;
}

/** `next`, or `prev` when the two are structurally equal. */
export function keepIfEqual<T>(prev: T, next: T): T {
  return jsonEqual(prev, next) ? prev : next;
}
