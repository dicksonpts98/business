import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError, type FxRate,
  addMoney, convertMoney, divideMoney, formatMoney, invertRate, money,
  multiplyMoney, parseMoney, rateOfMoney, subMoney, sumMoney, zero,
} from './money.js';

const CNY_CAD: FxRate = {
  from: 'CNY', to: 'CAD', rate: '0.19000000', asOf: '2026-09-01',
  source: 'Owner-entered bank rate', label: 'OWNER_CONFIRMED_ACTUAL',
};

describe('Money construction', () => {
  it('parses decimals exactly into minor units', () => {
    expect(parseMoney('1234.56', 'CAD')).toEqual({ minor: 123456, currency: 'CAD' });
    expect(parseMoney('0.05', 'CAD').minor).toBe(5);
  });
  it('honours zero-decimal currencies instead of assuming two', () => {
    expect(parseMoney('1500', 'JPY')).toEqual({ minor: 1500, currency: 'JPY' });
    expect(() => parseMoney('1500.50', 'JPY')).toThrow(/decimal places but scale is 0/);
  });
  it('refuses an unknown currency rather than guessing its exponent', () => {
    expect(() => money(100, 'XYZ')).toThrow(/add its minor-unit exponent explicitly/);
  });
  it('refuses fractional minor units', () => {
    expect(() => money(10.5, 'CAD')).toThrow(/integer count of minor units/);
  });
});

describe('Money arithmetic', () => {
  it('refuses to mix currencies', () => {
    const a = parseMoney('10.00', 'CAD');
    const b = parseMoney('10.00', 'USD');
    expect(() => addMoney(a, b)).toThrow(CurrencyMismatchError);
    expect(() => subMoney(a, b)).toThrow(/convert with a dated FX rate first/);
  });
  it('adds, subtracts and sums exactly', () => {
    expect(addMoney(parseMoney('0.10', 'CAD'), parseMoney('0.20', 'CAD')))
      .toEqual(parseMoney('0.30', 'CAD'));
    expect(sumMoney([parseMoney('1.11', 'CAD'), parseMoney('2.22', 'CAD')], 'CAD'))
      .toEqual(parseMoney('3.33', 'CAD'));
    expect(sumMoney([], 'CAD')).toEqual(zero('CAD'));
  });
  it('multiplies only by integer quantities', () => {
    expect(multiplyMoney(parseMoney('7.98', 'CAD'), 200)).toEqual(parseMoney('1596.00', 'CAD'));
    expect(() => multiplyMoney(parseMoney('1.00', 'CAD'), 1.5))
      .toThrow(/Quantity must be an integer/);
  });
  it('divides with half-away-from-zero rounding', () => {
    // 3064.88 CAD over 200 units = 15.3244 -> 15.32
    expect(divideMoney(parseMoney('3064.88', 'CAD'), 200)).toEqual(parseMoney('15.32', 'CAD'));
  });
  it('takes a decimal share exactly', () => {
    expect(rateOfMoney(parseMoney('59.99', 'CAD'), '0.03')).toEqual(parseMoney('1.80', 'CAD'));
  });
});

describe('FX conversion', () => {
  it('converts with a dated rate', () => {
    // 42.00 CNY x 0.19 = 7.98 CAD
    expect(convertMoney(parseMoney('42.00', 'CNY'), CNY_CAD))
      .toEqual(parseMoney('7.98', 'CAD'));
  });
  it('refuses to convert the wrong source currency', () => {
    expect(() => convertMoney(parseMoney('42.00', 'CAD'), CNY_CAD))
      .toThrow(CurrencyMismatchError);
  });
  it('adjusts for differing minor-unit exponents', () => {
    const cadJpy: FxRate = {
      from: 'CAD', to: 'JPY', rate: '108.00000000', asOf: '2026-09-01',
      source: 'test', label: 'SOURCE_BACKED_OBSERVATION',
    };
    // 10.00 CAD (1000 minor, exp 2) -> 1080 JPY (1080 minor, exp 0)
    expect(convertMoney(parseMoney('10.00', 'CAD'), cadJpy))
      .toEqual({ minor: 1080, currency: 'JPY' });
  });
  it('inverts a rate and round-trips within one minor unit', () => {
    const back = invertRate(CNY_CAD);
    expect(back.from).toBe('CAD');
    expect(back.to).toBe('CNY');
    const there = convertMoney(parseMoney('100.00', 'CNY'), CNY_CAD);
    const backAgain = convertMoney(there, back);
    expect(Math.abs(backAgain.minor - 10000)).toBeLessThanOrEqual(1);
  });
  it('rejects a non-positive rate', () => {
    expect(() => convertMoney(parseMoney('1.00', 'CNY'), { ...CNY_CAD, rate: '0' }))
      .toThrow(/must be positive/);
  });
});

describe('formatMoney', () => {
  it('always names the currency', () => {
    expect(formatMoney(parseMoney('1596.00', 'CAD'))).toBe('1596.00 CAD');
    expect(formatMoney({ minor: 1500, currency: 'JPY' })).toBe('1500 JPY');
  });
});
