/**
 * Crockford Base32 (no I, L, O, U). MSB-first, no padding characters.
 * Decoding is lenient about case, hyphens/whitespace, and the
 * O->0 / I->1 / L->1 confusables; it is strict about unknown symbols and
 * non-zero leftover bits.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const DECODE = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) DECODE.set(ALPHABET[i]!, i);
DECODE.set('O', 0);
DECODE.set('I', 1);
DECODE.set('L', 1);

export class Base32Error extends Error {
  override name = 'Base32Error';
}

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(acc << (5 - bits)) & 0x1f];
  }
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s-]+/g, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = DECODE.get(ch);
    if (val === undefined) throw new Base32Error(`invalid symbol "${ch}"`);
    acc = (acc << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Base32Error('non-zero trailing bits');
  }
  return Uint8Array.from(out);
}
