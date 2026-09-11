import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORING_POLICY, type DimensionScore, SCORE_DIMENSIONS,
  describeScore, scoreOpportunity,
} from './scoring.js';
import { known, unknown } from './unknown.js';
import type { ProvenanceLabel } from './provenance.js';

function fullScores(
  value: number, label: ProvenanceLabel = 'SOURCE_BACKED_OBSERVATION',
): DimensionScore[] {
  return SCORE_DIMENSIONS.map((dimension) => ({
    dimension, raw: known(value), evidenceIds: [`ev-${dimension}`],
    rationale: 'fixture', label,
  }));
}

describe('scoreOpportunity', () => {
  it('inverts cost-polarity dimensions so high risk lowers the aid', () => {
    // All 5s: benefits max out, costs are at their WORST, so the aid is mid.
    const all5 = scoreOpportunity(fullScores(5));
    const all0 = scoreOpportunity(fullScores(0));
    expect(all5.rankable).toBe(true);
    expect(all0.rankable).toBe(true);
    expect(all5.weightedScore).toEqual(known(80));
    expect(all0.weightedScore).toEqual(known(20));
  });

  it('scores a genuinely strong opportunity above a weak one', () => {
    const strong = fullScores(4).map((s) =>
      ['cashRequirement', 'complianceComplexity', 'seasonality'].includes(s.dimension)
        ? { ...s, raw: known(1) } : s);
    const weak = fullScores(1).map((s) =>
      ['cashRequirement', 'complianceComplexity', 'seasonality'].includes(s.dimension)
        ? { ...s, raw: known(4) } : s);
    const a = scoreOpportunity(strong).weightedScore;
    const b = scoreOpportunity(weak).weightedScore;
    expect(a.known && b.known && a.value > b.value).toBe(true);
  });

  it('refuses to rank a score carrying no evidence', () => {
    const s = fullScores(4);
    s[0] = { ...s[0]!, evidenceIds: [] };
    const r = scoreOpportunity(s);
    expect(r.rankable).toBe(false);
    expect(r.weightedScore.known).toBe(false);
    expect(r.blockingReasons.join(' ')).toMatch(/no evidence attached/);
  });

  it('refuses to rank when demand rests on a supplier claim', () => {
    const s = fullScores(4);
    s[0] = { ...s[0]!, label: 'SUPPLIER_CLAIM' };
    const r = scoreOpportunity(s);
    expect(r.rankable).toBe(false);
    expect(r.blockingReasons.join(' ')).toMatch(/not decision-grade/);
  });

  it('refuses to rank when too many dimensions are unknown', () => {
    const s = fullScores(4).map((d, i) =>
      i < 3 ? { ...d, raw: unknown('Not researched.') } : d);
    const r = scoreOpportunity(s);
    expect(r.rankable).toBe(false);
    expect(r.unknownDimensions).toHaveLength(3);
    expect(r.blockingReasons.join(' ')).toMatch(/policy allows 2/);
  });

  it('tolerates unknowns within policy and reweights rather than penalising', () => {
    const s = fullScores(4).map((d) =>
      d.dimension === 'seasonality' ? { ...d, raw: unknown('Unmeasured.') } : d);
    const r = scoreOpportunity(s, DEFAULT_SCORING_POLICY);
    expect(r.rankable).toBe(true);
    expect(r.unknownDimensions).toEqual(['seasonality']);
  });

  it('refuses a dimension that was never scored at all', () => {
    const r = scoreOpportunity(fullScores(3).slice(0, 4));
    expect(r.rankable).toBe(false);
    expect(r.blockingReasons.join(' ')).toMatch(/has not been scored at all/);
  });

  it('rejects out-of-range raw scores', () => {
    const s = fullScores(3);
    s[1] = { ...s[1]!, raw: known(9) };
    expect(scoreOpportunity(s).blockingReasons.join(' ')).toMatch(/outside 0-5/);
  });

  it('inherits the weakest provenance label', () => {
    const s = fullScores(3);
    s[4] = { ...s[4]!, label: 'SYNTHETIC_DEMO' };
    expect(scoreOpportunity(s).label).toBe('SYNTHETIC_DEMO');
  });
});

describe('describeScore', () => {
  it('never describes the aid as a likelihood', () => {
    const text = describeScore(scoreOpportunity(fullScores(4)));
    expect(text).toMatch(/not a probability of success/);
    expect(text).not.toMatch(/chance|likelihood|probability of succ\w+ is/i);
  });
  it('explains itself when not rankable', () => {
    const s = fullScores(4);
    s[0] = { ...s[0]!, evidenceIds: [] };
    expect(describeScore(scoreOpportunity(s))).toMatch(/^Not rankable:/);
  });
});
