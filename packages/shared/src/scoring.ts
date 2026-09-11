import { type Maybe, isKnown, known, unknown } from './unknown.js';
import { type ProvenanceLabel, isDecisionGrade, weakestLabel } from './provenance.js';

/**
 * Opportunity scoring.
 *
 * This produces a RANKING AID and nothing else. It is not a probability of
 * success, not an expected value, and not a substitute for the evidence beside
 * it. The weights are the owner's editable opinion about what matters; the
 * scores are judgements about evidence. Both are shown, never just the total.
 */
export const SCORE_DIMENSIONS = [
  'demandEvidence',
  'unmetNeedSeverity',
  'differentiation',
  'supplyFeasibility',
  'contributionEconomics',
  'cashRequirement',
  'complianceComplexity',
  'seasonality',
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** 'benefit' = higher raw score is better. 'cost' = higher raw score is worse. */
const POLARITY: Record<ScoreDimension, 'benefit' | 'cost'> = {
  demandEvidence: 'benefit',
  unmetNeedSeverity: 'benefit',
  differentiation: 'benefit',
  supplyFeasibility: 'benefit',
  contributionEconomics: 'benefit',
  cashRequirement: 'cost',
  complianceComplexity: 'cost',
  seasonality: 'cost',
};

export const DIMENSION_LABEL: Record<ScoreDimension, string> = {
  demandEvidence: 'Demand evidence',
  unmetNeedSeverity: 'Severity of unmet need',
  differentiation: 'Differentiation',
  supplyFeasibility: 'Supply feasibility',
  contributionEconomics: 'Contribution economics',
  cashRequirement: 'Cash requirement',
  complianceComplexity: 'Compliance complexity',
  seasonality: 'Seasonality concentration',
};

export const DIMENSION_GUIDANCE: Record<ScoreDimension, string> = {
  demandEvidence: '0 = no observation of anyone wanting this. 5 = multiple independent, dated observations of people seeking it and failing to get it.',
  unmetNeedSeverity: '0 = mild preference. 5 = the current workaround causes real loss (damaged garments, ruined occasion).',
  differentiation: '0 = identical to what is already delivered cheaply. 5 = a capability competitors visibly lack.',
  supplyFeasibility: '0 = no credible supplier found. 5 = multiple comparable quotes from vetted suppliers at workable MOQ.',
  contributionEconomics: '0 = contribution negative or unknown. 5 = positive contribution with headroom under downside scenarios.',
  cashRequirement: '0 = trivial outlay. 5 = requires cash beyond the owner-configured exposure cap.',
  complianceComplexity: '0 = no product-specific regime identified. 5 = testing, certification or labelling regime with unresolved questions.',
  seasonality: '0 = steady year-round demand. 5 = a single annual window, with dead stock risk if missed.',
};

export interface DimensionScore {
  readonly dimension: ScoreDimension;
  /** Integer 0-5, or unknown. Unknown is never coerced to a midpoint. */
  readonly raw: Maybe<number>;
  /** Evidence record IDs supporting this score. Empty is itself a finding. */
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
  readonly label: ProvenanceLabel;
}

export type DimensionWeights = Readonly<Record<ScoreDimension, number>>;

export const DEFAULT_WEIGHTS: DimensionWeights = {
  demandEvidence: 25,
  unmetNeedSeverity: 15,
  differentiation: 10,
  supplyFeasibility: 10,
  contributionEconomics: 20,
  cashRequirement: 8,
  complianceComplexity: 7,
  seasonality: 5,
};

export interface ScoringPolicy {
  readonly weights: DimensionWeights;
  /** Max dimensions that may be unknown before ranking is refused. */
  readonly maxUnknownDimensions: number;
  /** Dimensions that must be decision-grade evidence, not leads, to rank. */
  readonly requireDecisionGrade: readonly ScoreDimension[];
}

export const DEFAULT_SCORING_POLICY: ScoringPolicy = {
  weights: DEFAULT_WEIGHTS,
  maxUnknownDimensions: 2,
  requireDecisionGrade: ['demandEvidence'],
};

export interface ScoreResult {
  /** False when evidence is too thin to rank. The opportunity still exists;
   *  it simply may not be ordered against others yet. */
  readonly rankable: boolean;
  readonly blockingReasons: readonly string[];
  /** 0-100 weighted aid, present only when rankable. NOT a probability. */
  readonly weightedScore: Maybe<number>;
  readonly perDimension: readonly DimensionScore[];
  readonly unknownDimensions: readonly ScoreDimension[];
  readonly label: ProvenanceLabel;
}

export function scoreOpportunity(
  scores: readonly DimensionScore[], policy: ScoringPolicy = DEFAULT_SCORING_POLICY,
): ScoreResult {
  const byDimension = new Map(scores.map((s) => [s.dimension, s]));
  const blocking: string[] = [];
  const unknownDims: ScoreDimension[] = [];

  for (const dim of SCORE_DIMENSIONS) {
    const s = byDimension.get(dim);
    if (s === undefined) {
      unknownDims.push(dim);
      blocking.push(`${DIMENSION_LABEL[dim]} has not been scored at all.`);
      continue;
    }
    if (!isKnown(s.raw)) {
      unknownDims.push(dim);
      continue;
    }
    if (!Number.isInteger(s.raw.value) || s.raw.value < 0 || s.raw.value > 5) {
      blocking.push(`${DIMENSION_LABEL[dim]} score ${s.raw.value} is outside 0-5.`);
    }
    if (s.evidenceIds.length === 0) {
      blocking.push(`${DIMENSION_LABEL[dim]} is scored ${s.raw.value} with no evidence attached.`);
    }
    if (policy.requireDecisionGrade.includes(dim) && !isDecisionGrade(s.label)) {
      blocking.push(
        `${DIMENSION_LABEL[dim]} rests on ${s.label}, which is not decision-grade evidence.`,
      );
    }
  }

  if (unknownDims.length > policy.maxUnknownDimensions) {
    blocking.push(
      `${unknownDims.length} dimensions are unknown (policy allows ${policy.maxUnknownDimensions}): ${unknownDims.map((d) => DIMENSION_LABEL[d]).join(', ')}.`,
    );
  }

  const labels = scores.map((s) => s.label);
  const label = weakestLabel(labels);

  if (blocking.length > 0) {
    return {
      rankable: false,
      blockingReasons: blocking,
      weightedScore: unknown(blocking),
      perDimension: scores,
      unknownDimensions: unknownDims,
      label,
    };
  }

  // Weighted over the dimensions actually scored, so an unknown dimension
  // neither helps nor silently penalises. The divisor shrinks with it.
  let weightedPoints = 0;
  let weightSum = 0;
  for (const dim of SCORE_DIMENSIONS) {
    const s = byDimension.get(dim);
    if (s === undefined || !isKnown(s.raw)) continue;
    const weight = policy.weights[dim];
    const normalised = POLARITY[dim] === 'benefit' ? s.raw.value : 5 - s.raw.value;
    weightedPoints += normalised * weight;
    weightSum += weight;
  }
  if (weightSum === 0) {
    return {
      rankable: false,
      blockingReasons: ['No dimension carries weight.'],
      weightedScore: unknown('No weighted dimensions.'),
      perDimension: scores, unknownDimensions: unknownDims, label,
    };
  }
  // Scale 0-5 to 0-100, rounding half away from zero on integers only.
  const score = Math.round((weightedPoints * 100 * 2) / (weightSum * 5) / 2);

  return {
    rankable: true,
    blockingReasons: [],
    weightedScore: known(score),
    perDimension: scores,
    unknownDimensions: unknownDims,
    label,
  };
}

/** Rendering guard: refuses to describe a score as a likelihood. */
export function describeScore(result: ScoreResult): string {
  if (!result.rankable || !isKnown(result.weightedScore)) {
    return `Not rankable: ${result.blockingReasons.join(' ')}`;
  }
  return `Ranking aid ${result.weightedScore.value}/100 (weighted owner priorities; not a probability of success)`;
}
