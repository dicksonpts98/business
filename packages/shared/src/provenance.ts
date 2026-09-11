/**
 * Data provenance labels. These are the application's central honesty
 * mechanism: every number, claim and record carries one, and the label travels
 * with the value through aggregation rather than being attached at render time.
 */
export const PROVENANCE_LABELS = [
  'SYNTHETIC_DEMO',
  'UNVERIFIED_LEAD',
  'SOURCE_BACKED_OBSERVATION',
  'SUPPLIER_CLAIM',
  'CUSTOMER_VALIDATED',
  'OWNER_CONFIRMED_ACTUAL',
] as const;

export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];

/**
 * Evidential strength ordering, used only to pick the weakest label when
 * combining values. It is deliberately NOT a confidence score and must never be
 * rendered as a percentage or a probability of success.
 */
const STRENGTH: Record<ProvenanceLabel, number> = {
  SYNTHETIC_DEMO: 0,
  UNVERIFIED_LEAD: 1,
  SUPPLIER_CLAIM: 2,
  SOURCE_BACKED_OBSERVATION: 3,
  CUSTOMER_VALIDATED: 4,
  OWNER_CONFIRMED_ACTUAL: 5,
};

export const PROVENANCE_DESCRIPTION: Record<ProvenanceLabel, string> = {
  SYNTHETIC_DEMO: 'Fabricated for demonstration. Carries no evidential weight whatsoever.',
  UNVERIFIED_LEAD: 'A pointer worth following. Not evidence of demand, price or availability.',
  SUPPLIER_CLAIM: 'Asserted by a supplier or their listing. Unverified until independently checked.',
  SOURCE_BACKED_OBSERVATION: 'Observed in a citable source at a recorded access time.',
  CUSTOMER_VALIDATED: 'Corroborated by an identified customer interaction or transaction.',
  OWNER_CONFIRMED_ACTUAL: 'Confirmed by the owner against a real document or settled transaction.',
};

/**
 * A derived value is never stronger than its weakest input. An agent's
 * recommendation cannot upgrade a label — only the owner or a real transaction
 * can, and they do so by recording new evidence, not by re-deriving.
 */
export function weakestLabel(labels: readonly ProvenanceLabel[]): ProvenanceLabel {
  if (labels.length === 0) return 'UNVERIFIED_LEAD';
  return labels.reduce((weakest, current) =>
    STRENGTH[current] < STRENGTH[weakest] ? current : weakest,
  );
}

/** True when a label may back a decision that spends money or contacts a person. */
export function isDecisionGrade(label: ProvenanceLabel): boolean {
  return STRENGTH[label] >= STRENGTH.SOURCE_BACKED_OBSERVATION;
}

export function isSynthetic(label: ProvenanceLabel): boolean {
  return label === 'SYNTHETIC_DEMO';
}
