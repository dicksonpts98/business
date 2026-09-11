import { describe, expect, it } from 'vitest';
import {
  DecimalParseError, RATE_ONE, applyRate, divideRoundHalfAwayFromZero,
  formatScaled, parseDecimalToScaled, parseRate,
} from './decimal.js';

describe('parseDecimalToScaled', () => {
  it('parses exactly, with no float drift', () => {
    expect(parseDecimalToScaled('0.07', 2)).toBe(7);
    expect(parseDecimalToScaled('1234.56', 2)).toBe(123456);
    expect(parseDecimalToScaled('-1234.56', 2)).toBe(-123456);
    expect(parseDecimalToScaled('10', 2)).toBe(1000);
    expect(parseDecimalToScaled('0', 2)).toBe(0);
  });

  it('parses the value that famously breaks binary floats', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. In scaled integers it is exact.
    expect(parseDecimalToScaled('0.1', 2) + parseDecimalToScaled('0.2', 2))
      .toBe(parseDecimalToScaled('0.3', 2));
  });

  it('refuses to silently truncate excess precision', () => {
    expect(() => parseDecimalToScaled('1.005', 2)).toThrow(DecimalParseError);
    expect(() => parseDecimalToScaled('1.005', 2)).toThrow(/round explicitly/);
  });

  it('rejects malformed input rather than coercing to NaN or zero', () => {
    for (const bad of ['', 'abc', '1.2.3', '1,200.00', '1e5', ' ', '--1']) {
      expect(() => parseDecimalToScaled(bad, 2), `input ${JSON.stringify(bad)}`)
        .toThrow(DecimalParseError);
    }
  });
});

describe('formatScaled', () => {
  it('round-trips', () => {
    for (const s of ['0.00', '0.07', '1234.56', '-1234.56', '1000000.01']) {
      expect(formatScaled(parseDecimalToScaled(s, 2), 2)).toBe(s);
    }
  });
  it('pads sub-unit values correctly', () => {
    expect(formatScaled(7, 2)).toBe('0.07');
    expect(formatScaled(-7, 2)).toBe('-0.07');
    expect(formatScaled(7, 0)).toBe('7');
  });
});

describe('divideRoundHalfAwayFromZero', () => {
  it('rounds halves away from zero, symmetrically', () => {
    expect(divideRoundHalfAwayFromZero(5, 2)).toBe(3);   // 2.5 -> 3
    expect(divideRoundHalfAwayFromZero(-5, 2)).toBe(-3); // -2.5 -> -3
    expect(divideRoundHalfAwayFromZero(7, 2)).toBe(4);   // 3.5 -> 4
    expect(divideRoundHalfAwayFromZero(4, 2)).toBe(2);
    expect(divideRoundHalfAwayFromZero(1, 3)).toBe(0);
    expect(divideRoundHalfAwayFromZero(2, 3)).toBe(1);
  });
  it('is symmetric: a credit and a charge of equal size round identically', () => {
    for (const n of [1, 5, 7, 49, 12345]) {
      expect(divideRoundHalfAwayFromZero(n, 7))
        .toBe(-divideRoundHalfAwayFromZero(-n, 7));
    }
  });
  it('refuses division by zero', () => {
    expect(() => divideRoundHalfAwayFromZero(1, 0)).toThrow(/division by zero/);
  });
});

describe('applyRate', () => {
  it('applies a percentage exactly', () => {
    expect(applyRate(10000, parseRate('0.05'))).toBe(500);
    expect(applyRate(5999, parseRate('0.029'))).toBe(174); // 173.971 -> 174
    expect(applyRate(199488, parseRate('0.05'))).toBe(9974); // 9974.4 -> 9974
  });
  it('is exact for large values via the BigInt path', () => {
    const big = 9_000_000_000_000; // * 1e8 overflows Number precision
    expect(applyRate(big, RATE_ONE)).toBe(big);
    expect(applyRate(big, parseRate('0.5'))).toBe(4_500_000_000_000);
  });
  it('identity at rate 1', () => {
    expect(applyRate(123456, RATE_ONE)).toBe(123456);
  });
});
