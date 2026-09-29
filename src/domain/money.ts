/**
 * Money is always integer minor units (kuruş / cents). Floats never touch prices.
 *
 * Rounding rule: percentage discounts are rounded half-up to the nearest minor
 * unit; an effective price can never go below zero.
 *
 * NOTE: the set-based SQL recompute (src/pricing/recompute-sql.ts) mirrors this
 * arithmetic. tests/integration/pricing-parity.test.ts guards against drift.
 */

export type DiscountType = 'PERCENTAGE' | 'FIXED';

export const BPS_PER_WHOLE = 10_000;

/** Upper bound of every Postgres `int` column (prices, stock, discount values). */
export const MAX_INT32 = 2_147_483_647;

/** Discount amount in minor units, half-up. `valueBps` for PERCENTAGE, minor units for FIXED. */
export function discountAmount(baseMinor: number, type: DiscountType, value: number): number {
  if (type === 'PERCENTAGE') {
    // base * bps fits comfortably in a double (< 2^53) for any int32 price.
    return Math.floor((baseMinor * value + BPS_PER_WHOLE / 2) / BPS_PER_WHOLE);
  }
  return value;
}

export function applyDiscount(baseMinor: number, type: DiscountType, value: number): number {
  return Math.max(0, baseMinor - discountAmount(baseMinor, type, value));
}

/** "12.5" (percent) -> 1250 bps. Up to two decimals. */
export function percentToBps(percent: number): number {
  const bps = Math.round(percent * 100);
  if (Math.abs(bps - percent * 100) > 1e-6) {
    throw new RangeError(`percentage supports at most 2 decimals: ${percent}`);
  }
  return bps;
}

export function bpsToPercent(bps: number): number {
  return bps / 100;
}

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** "199.9" -> 19990. Returns null for anything that is not a non-negative 2dp decimal. */
export function parseDecimalToMinor(input: string): number | null {
  const s = input.trim();
  if (!DECIMAL_RE.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor <= MAX_INT32 ? minor : null;
}

export function formatMinor(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}
