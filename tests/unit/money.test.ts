import { applyDiscount, formatMinor, parseDecimalToMinor, percentToBps } from '../../src/domain/money';

describe('money', () => {
  it('rounds percentage discounts half-up to the minor unit', () => {
    // 999 * 12.5% = 124.875 -> 125 off
    expect(applyDiscount(999, 'PERCENTAGE', 1250)).toBe(874);
    // 1001 * 50% = 500.5 -> 501 off (half-up)
    expect(applyDiscount(1001, 'PERCENTAGE', 5000)).toBe(500);
    // 1003 * 50% = 501.5 -> 502 off
    expect(applyDiscount(1003, 'PERCENTAGE', 5000)).toBe(501);
  });

  it('100% off yields zero', () => {
    expect(applyDiscount(4999, 'PERCENTAGE', 10_000)).toBe(0);
  });

  it('never goes below zero for fixed discounts larger than the price', () => {
    expect(applyDiscount(500, 'FIXED', 800)).toBe(0);
    expect(applyDiscount(1500, 'FIXED', 250)).toBe(1250);
  });

  it('parses 2dp decimals into minor units and rejects junk', () => {
    expect(parseDecimalToMinor('199.9')).toBe(19990);
    expect(parseDecimalToMinor('0.05')).toBe(5);
    expect(parseDecimalToMinor('12')).toBe(1200);
    expect(parseDecimalToMinor('-1')).toBeNull();
    expect(parseDecimalToMinor('1.234')).toBeNull();
    expect(parseDecimalToMinor('1e3')).toBeNull();
    expect(parseDecimalToMinor('')).toBeNull();
  });

  it('converts percentages to basis points', () => {
    expect(percentToBps(50)).toBe(5000);
    expect(percentToBps(12.5)).toBe(1250);
    expect(() => percentToBps(12.345)).toThrow(RangeError);
  });

  it('formats minor units', () => {
    expect(formatMinor(19990)).toBe('199.90');
    expect(formatMinor(5)).toBe('0.05');
  });
});
