/**
 * Base58 (Bitcoin alphabet), as NEAR uses for public keys and signatures.
 *
 * Written out rather than pulled from npm on purpose. This file sits directly under the
 * evidence-signing path: a compromised base58 implementation could make a forged signature
 * decode to something that verifies, or make an honest one fail. It is forty lines of
 * arithmetic with no configuration, so the supply-chain surface is not worth the convenience.
 *
 * Correctness is pinned against the real public key and signature in
 * `test-vectors/evidence.json`, which the Rust side produced with the bs58 crate. If this
 * implementation disagreed with that crate by even one byte, those tests would fail.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i]!] = i;

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Leading zero bytes are not representable positionally, so they are carried over as
  // explicit '1' characters.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Repeated division of a big-endian base-256 number by 58.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);

  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const value = INDEX[s[i]!];
    if (value === undefined) {
      throw new Error(`base58: "${s[i]}" at position ${i} is not a base58 character`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i]!;
  return out;
}
