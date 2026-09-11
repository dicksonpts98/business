import {
  RATE_ONE,
  applyRate,
  divideRoundHalfAwayFromZero,
  divideScaledExact,
  formatScaled,
  parseDecimalToScaled,
  parseRate,
} from './decimal.js';
import type { ProvenanceLabel } from './provenance.js';

/**
 * Money is an integer count of minor units plus an explicit currency. There is
 * no implicit currency and no float representation anywhere.
 */
export interface Money {
  readonly minor: number;
  readonly currency: CurrencyCode;
}

export type CurrencyCode = string;

/** Minor-unit exponents for currencies this application handles explicitly. */
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  CAD: 2, USD: 2, CNY: 2, INR: 2, EUR: 2, GBP: 2, HKD: 2,
  JPY: 0, KRW: 0,
};

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode, op: string) {
    super(`Refusing to ${op} ${a} and ${b}: convert with a dated FX rate first.`);
    this.name = 'CurrencyMismatchError';
  }
}

export function minorUnitExponent(currency: CurrencyCode): number {
  const e = MINOR_UNIT_EXPONENT[currency.toUpperCase()];
  if (e === undefined) {
    throw new RangeError(
      `Unknown currency ${currency}: add its minor-unit exponent explicitly rather than assuming 2.`,
    );
  }
  return e;
}

export function money(minor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Money must be an integer count of minor units, got ${minor}`);
  }
  minorUnitExponent(currency);
  return { minor, currency: currency.toUpperCase() };
}

/** Parse "1234.56" in the given currency with no float involvement. */
export function parseMoney(decimal: string, currency: CurrencyCode): Money {
  return money(parseDecimalToScaled(decimal, minorUnitExponent(currency)), currency);
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency, 'add');
  return money(a.minor + b.minor, a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency, 'subtract');
  return money(a.minor - b.minor, a.currency);
}

export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => addMoney(acc, m), zero(currency));
}

export function negateMoney(a: Money): Money {
  return money(-a.minor, a.currency);
}

/** Multiply by an integer quantity. Exact. */
export function multiplyMoney(a: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) {
    throw new RangeError(`Quantity must be an integer, got ${quantity}. Use rateOfMoney for shares.`);
  }
  return money(a.minor * quantity, a.currency);
}

/** Divide across an integer count, rounding half away from zero. */
export function divideMoney(a: Money, divisor: number): Money {
  return money(divideRoundHalfAwayFromZero(a.minor, divisor), a.currency);
}

/** Take a decimal share of an amount, e.g. a 2.9% payment fee. */
export function rateOfMoney(a: Money, rateDecimal: string): Money {
  return money(applyRate(a.minor, parseRate(rateDecimal)), a.currency);
}

export function compareMoney(a: Money, b: Money): number {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency, 'compare');
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

export function isNegative(a: Money): boolean { return a.minor < 0; }
export function isPositive(a: Money): boolean { return a.minor > 0; }
export function isZero(a: Money): boolean { return a.minor === 0; }

export function formatMoney(a: Money): string {
  return `${formatScaled(a.minor, minorUnitExponent(a.currency))} ${a.currency}`;
}

/**
 * An FX rate is never a bare number. It carries the pair, the effective date,
 * the source and a provenance label, because a converted figure inherits the
 * trustworthiness of its rate.
 */
export interface FxRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** Decimal string, e.g. "0.19120000" meaning 1 CNY = 0.1912 CAD. */
  readonly rate: string;
  /** ISO date the rate applies to (not the date it was fetched). */
  readonly asOf: string;
  readonly source: string;
  readonly label: ProvenanceLabel;
}

/**
 * Convert with an explicit dated rate. Adjusts for differing minor-unit
 * exponents so CNY->JPY does not silently shift by a factor of 100.
 */
export function convertMoney(amount: Money, fx: FxRate): Money {
  const from = fx.from.toUpperCase();
  const to = fx.to.toUpperCase();
  if (amount.currency !== from) {
    throw new CurrencyMismatchError(amount.currency, from, 'convert');
  }
  const rateScaled = parseRate(fx.rate);
  if (rateScaled <= 0) throw new RangeError(`FX rate must be positive, got ${fx.rate}`);
  const expFrom = minorUnitExponent(from);
  const expTo = minorUnitExponent(to);
  let converted = applyRate(amount.minor, rateScaled);
  if (expTo > expFrom) {
    converted = converted * 10 ** (expTo - expFrom);
  } else if (expFrom > expTo) {
    converted = divideRoundHalfAwayFromZero(converted, 10 ** (expFrom - expTo));
  }
  return money(converted, to);
}

/** Inverse rate as an exact decimal string at RATE_SCALE. */
export function invertRate(fx: FxRate): FxRate {
  const rateScaled = parseRate(fx.rate);
  if (rateScaled <= 0) throw new RangeError('cannot invert a non-positive rate');
  // RATE_ONE**2 is 10**16, beyond MAX_SAFE_INTEGER, so this must be exact.
  const inverted = divideScaledExact(BigInt(RATE_ONE) * BigInt(RATE_ONE), BigInt(rateScaled));
  return {
    from: fx.to, to: fx.from,
    rate: formatScaled(inverted, 8),
    asOf: fx.asOf, source: `${fx.source} (inverted)`, label: fx.label,
  };
}
