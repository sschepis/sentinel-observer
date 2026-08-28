/**
 * Portable random identifiers.
 *
 * The observer core must run identically in Node and in browsers, so it
 * cannot import 'node:crypto' directly. Browsers and Node >= 19 expose
 * `crypto.randomUUID`; older Node runtimes fall back to a non-cryptographic
 * v4-style generator that is fine for trace/session identifiers (never for
 * security purposes).
 */

export function randomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // RFC 4122 v4 layout using Math.random (identifier use only).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
