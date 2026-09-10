/**
 * Length-value concatenation primitives used by CPace
 * (draft-irtf-cfrg-cpace-21, section 4.2).
 *
 * `lvCat` prefixes every field with its byte length encoded as LEB128, so that
 * a concatenation of variable-length fields is unambiguously parseable and no
 * field can "bleed" into the next. We only ever build these strings, never
 * parse them, but the encoding still has to match the spec for the test
 * vectors to pass.
 */

/** LEB128-encode an unsigned integer (spec: `prepend_len` length prefix). */
export function leb128(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`leb128: expected non-negative integer, got ${value}`);
  }
  const out: number[] = [];
  let n = value;
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

/** `prepend_len(bytes)` = LEB128(len) ‖ bytes. */
export function prependLen(bytes: Uint8Array): Uint8Array {
  const len = leb128(bytes.length);
  const out = new Uint8Array(len.length + bytes.length);
  out.set(len, 0);
  out.set(bytes, len.length);
  return out;
}

/** `lv_cat(a, b, c, ...)` = prepend_len(a) ‖ prepend_len(b) ‖ ... */
export function lvCat(...fields: Uint8Array[]): Uint8Array {
  const parts = fields.map(prependLen);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
