/**
 * Exact decimal parsing and fixed-point integer arithmetic.
 *
 * Rationale: every monetary and rate calculation in this application must be
 * reproducible bit-for-bit across machines and across reruns. IEEE-754 binary
 * floating point is not, so no `number` in this module is ever produced by
 * parsing a decimal with `parseFloat`. Decimals arrive as strings and are
 * converted to scaled integers by string manipulation only.
 */

/** Fixed scale used for rates, percentages and FX: 8 decimal places. */
export const RATE_SCALE = 8;
export const RATE_ONE = 100_000_000; // 10 ** RATE_SCALE

export class DecimalParseError extends Error {
  constructor(input: string, detail: string) {
    super(`Cannot parse decimal ${JSON.stringify(input)}: ${detail}`);
    this.name = 'DecimalParseError';
  }
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string into an integer scaled by 10**scale, with no float
 * involvement. Digits beyond `scale` are rejected rather than silently
 * truncated — silent truncation of a rate is a correctness bug, not a rounding
 * preference.
 */
export function parseDecimalToScaled(input: string, scale: number): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) {
    throw new DecimalParseError(input, `unsupported scale ${scale}`);
  }
  const trimmed = input.trim();
  const m = DECIMAL_RE.exec(trimmed);
  if (!m) throw new DecimalParseError(input, 'expected format [-]digits[.digits]');
  const [, sign, intPart, fracRaw = ''] = m;
  if (fracRaw.length > scale) {
    throw new DecimalParseError(
      input,
      `has ${fracRaw.length} decimal places but scale is ${scale}; round explicitly before calling`,
    );
  }
  const frac = fracRaw.padEnd(scale, '0');
  const digits = `${intPart ?? '0'}${frac}`.replace(/^0+(?=\d)/, '');
  const magnitude = Number(digits);
  if (!Number.isSafeInteger(magnitude)) {
    throw new DecimalParseError(input, 'exceeds safe integer range at this scale');
  }
  return sign === '-' ? -magnitude : magnitude;
}

/** Render a scaled integer back to its exact decimal string. */
export function formatScaled(scaled: number, scale: number): string {
  if (!Number.isSafeInteger(scaled)) throw new RangeError('scaled value must be a safe integer');
  const negative = scaled < 0;
  const digits = Math.abs(scaled).toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  const intPart = digits.slice(0, cut);
  const frac = digits.slice(cut);
  const body = scale === 0 ? intPart : `${intPart}.${frac}`;
  return negative ? `-${body}` : body;
}

/**
 * Round half away from zero. Chosen deliberately: it is the convention used by
 * Canadian commercial invoicing and by CBSA duty worksheets, it is symmetric
 * about zero (so a credit and a charge of equal magnitude round identically),
 * and it is trivially auditable by hand. Documented because any rounding rule
 * is arbitrary and the choice must be inspectable, not implicit.
 */
export function divideRoundHalfAwayFromZero(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError('division by zero');
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RangeError('divideRoundHalfAwayFromZero requires safe integers');
  }
  const negative = numerator < 0 !== denominator < 0;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const quotient = Math.floor(n / d);
  const remainder = n - quotient * d;
  const rounded = remainder * 2 >= d ? quotient + 1 : quotient;
  return negative ? -rounded : rounded;
}

/** Multiply a scaled integer by a rate expressed at RATE_SCALE. */
export function applyRate(scaledValue: number, rateScaled: number): number {
  if (!Number.isSafeInteger(scaledValue) || !Number.isSafeInteger(rateScaled)) {
    throw new RangeError('applyRate requires safe integers');
  }
  const product = scaledValue * rateScaled;
  if (!Number.isSafeInteger(product)) {
    // Fall back to BigInt so a large value * high-precision rate stays exact.
    const big = (BigInt(scaledValue) * BigInt(rateScaled));
    const negative = big < 0n;
    const abs = negative ? -big : big;
    const one = BigInt(RATE_ONE);
    const q = abs / one;
    const r = abs - q * one;
    const rounded = r * 2n >= one ? q + 1n : q;
    const out = negative ? -rounded : rounded;
    if (out > BigInt(Number.MAX_SAFE_INTEGER) || out < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError('applyRate result exceeds safe integer range');
    }
    return Number(out);
  }
  return divideRoundHalfAwayFromZero(product, RATE_ONE);
}

/** Parse a rate/percentage string ("0.029", "12.5") to RATE_SCALE integer. */
export function parseRate(input: string): number {
  return parseDecimalToScaled(input, RATE_SCALE);
}

/**
 * Exact division of scaled integers where the intermediate product exceeds the
 * safe-integer range, e.g. inverting an 8-decimal FX rate requires 10**16.
 * Rounds half away from zero, identically to the Number path.
 */
export function divideScaledExact(
  numerator: bigint, denominator: bigint,
): number {
  if (denominator === 0n) throw new RangeError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n - q * d;
  const rounded = r * 2n >= d ? q + 1n : q;
  const out = negative ? -rounded : rounded;
  if (out > BigInt(Number.MAX_SAFE_INTEGER) || out < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('divideScaledExact result exceeds safe integer range');
  }
  return Number(out);
}
