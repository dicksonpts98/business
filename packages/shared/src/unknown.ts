/**
 * Explicit unknown-ness.
 *
 * The single most common way a business model lies to its author is by letting
 * an unmeasured cost default to zero. This type makes that impossible: an
 * unknown input propagates through every aggregation and the caller must handle
 * it. There is deliberately no `valueOrZero` helper.
 */
export interface KnownValue<T> {
  readonly known: true;
  readonly value: T;
}

export interface UnknownValue {
  readonly known: false;
  readonly reasons: readonly string[];
}

export type Maybe<T> = KnownValue<T> | UnknownValue;

export function known<T>(value: T): KnownValue<T> {
  return { known: true, value };
}

export function unknown(reason: string | readonly string[]): UnknownValue {
  return { known: false, reasons: typeof reason === 'string' ? [reason] : reason };
}

export function isKnown<T>(m: Maybe<T>): m is KnownValue<T> {
  return m.known;
}

export function isUnknown<T>(m: Maybe<T>): m is UnknownValue {
  return !m.known;
}

/**
 * Read a value that a preceding collective check has already proven known.
 * Throws rather than substituting a default, so a logic error surfaces as a
 * crash in development instead of a plausible wrong number in a decision packet.
 */
export function expectKnown<T>(m: Maybe<T>, context = 'value'): T {
  if (!m.known) {
    throw new Error(
      `expectKnown(${context}) called on an unknown value: ${m.reasons.join('; ')}`,
    );
  }
  return m.value;
}

/** Collect reasons from every unknown member, de-duplicated and order-stable. */
export function collectUnknownReasons(items: readonly Maybe<unknown>[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.known) continue;
    for (const reason of item.reasons) if (!out.includes(reason)) out.push(reason);
  }
  return out;
}

/** Combine many Maybes; unknown if ANY input is unknown. */
export function allKnown<T>(items: readonly Maybe<T>[]): Maybe<T[]> {
  const reasons = collectUnknownReasons(items);
  if (reasons.length > 0) return unknown(reasons);
  return known(items.map((i) => expectKnown(i)));
}

export function mapKnown<A, B>(m: Maybe<A>, fn: (a: A) => B): Maybe<B> {
  return m.known ? known(fn(m.value)) : m;
}

/** Render for display without ever inventing a figure. */
export function describeMaybe<T>(m: Maybe<T>, render: (v: T) => string): string {
  return m.known ? render(m.value) : `unknown (${m.reasons.join('; ')})`;
}
