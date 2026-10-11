/*
 * Prices are integer micro-USD per million tokens (ADR 0037). People think in dollars per
 * million tokens, so the UI converts both ways with string arithmetic: no floating point, so
 * "0.075" is exactly 75000 and never 74999.
 */

const DOLLARS = /^(\d{1,6})(?:\.(\d{1,6}))?$/;

/** "3.25" -> 3250000. Undefined for anything that is not a plain non-negative amount. */
export function parseDollarsPerMtok(text: string): number | undefined {
  const match = DOLLARS.exec(text.trim().replace(/^\$/, ''));
  if (match === null) return undefined;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(6, '0');
  return Number(whole) * 1_000_000 + Number(fraction);
}

/** 3250000 -> "$3.25", 75000 -> "$0.075". */
export function formatDollarsPerMtok(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `$${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * A signed amount of integer micro-USD, as the api sends it (a decimal string), in dollars and
 * cents with thousands separators: "-2250000" -> "-$2.25", "1000000000" -> "$1,000.00"
 * (docs/design/docs/copy.md). Rounded to the nearest cent, half away from zero, except that an
 * amount that is not zero never shows as $0.00.
 */
export function formatMicroUsd(micro: string): string {
  const value = BigInt(micro);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  let cents = (abs + 5_000n) / 10_000n;
  if (cents === 0n && abs > 0n) cents = 1n;
  const dollars = String(cents / 100n).replaceAll(/\B(?=(\d{3})+$)/g, ',');
  const text = `$${dollars}.${String(cents % 100n).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

const AMOUNT = /^(\d{1,9})(?:\.(\d{1,6}))?$/;

/**
 * A dollar amount as a person types it, "25" or "$0.50", to integer micro-USD as the api takes
 * it (a decimal string). Up to $999,999,999.999999 (MAX_BUDGET_MICRO_USD); undefined otherwise.
 */
export function parseDollars(text: string): string | undefined {
  const match = AMOUNT.exec(text.trim().replace(/^\$/, '').replaceAll(',', ''));
  if (match === null) return undefined;
  const micro = BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return String(micro);
}

/**
 * What one request cost, as copy.md allows for per-request costs: four decimals, rounded up so a
 * cost is never shown as less than it was (CLAUDE.md, money): "3100" -> "$0.0032".
 */
export function formatCost(micro: string): string {
  const value = BigInt(micro);
  const tenThousandths = (value + 99n) / 100n;
  const dollars = String(tenThousandths / 10_000n).replaceAll(/\B(?=(\d{3})+$)/g, ',');
  return `$${dollars}.${String(tenThousandths % 10_000n).padStart(4, '0')}`;
}
