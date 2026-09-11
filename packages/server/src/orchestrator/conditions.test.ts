import { describe, expect, it } from 'vitest';
import { ConditionSyntaxError, evaluateCondition, parseCondition } from './conditions.js';

const artifacts = new Map<string, Record<string, unknown>>([
  ['demand', { recommendation: 'continue_research', score: 42, blocked: false, note: null }],
]);

describe('parseCondition', () => {
  it('parses a string comparison', () => {
    expect(parseCondition('artifact.demand.recommendation == "continue_research"')).toEqual({
      nodeKey: 'demand', field: 'recommendation', op: '==', literal: 'continue_research',
    });
  });
  it('parses numbers, booleans and null', () => {
    expect(parseCondition('artifact.demand.score >= 40').literal).toBe(40);
    expect(parseCondition('artifact.demand.blocked == false').literal).toBe(false);
    expect(parseCondition('artifact.demand.note == null').literal).toBe(null);
  });

  it('refuses anything that is not a single whitelisted comparison', () => {
    for (const bad of [
      'process.exit(1)',
      'require("fs").readFileSync("/etc/passwd")',
      'artifact.demand.recommendation == "a" || true',
      'globalThis.x = 1',
      '1 == 1',
      'artifact.demand',
      'artifact.demand.recommendation',
      '__proto__.polluted == 1',
      'artifact.demand.recommendation =~ /x/',
    ]) {
      expect(() => parseCondition(bad), bad).toThrow(ConditionSyntaxError);
    }
  });

  it('refuses an unquoted bareword literal rather than treating it as an identifier', () => {
    expect(() => parseCondition('artifact.demand.recommendation == someVariable'))
      .toThrow(/unsupported literal/);
  });
});

describe('evaluateCondition', () => {
  it('evaluates equality and inequality', () => {
    const eq = evaluateCondition(parseCondition('artifact.demand.recommendation == "continue_research"'), artifacts);
    expect(eq).toEqual({ decided: true, result: true, actual: 'continue_research' });
    const ne = evaluateCondition(parseCondition('artifact.demand.recommendation != "reject"'), artifacts);
    expect(ne.decided && ne.result).toBe(true);
  });

  it('evaluates ordered comparisons on numbers', () => {
    expect(evaluateCondition(parseCondition('artifact.demand.score > 40'), artifacts))
      .toMatchObject({ decided: true, result: true });
    expect(evaluateCondition(parseCondition('artifact.demand.score < 40'), artifacts))
      .toMatchObject({ decided: true, result: false });
  });

  it('is UNDECIDED, never false, when the artifact is missing', () => {
    const out = evaluateCondition(parseCondition('artifact.absent.recommendation == "x"'), artifacts);
    expect(out.decided).toBe(false);
    if (!out.decided) expect(out.reason).toMatch(/No artifact from node "absent"/);
  });

  it('is UNDECIDED when the field is missing', () => {
    const out = evaluateCondition(parseCondition('artifact.demand.missingField == "x"'), artifacts);
    expect(out.decided).toBe(false);
    if (!out.decided) expect(out.reason).toMatch(/undecided, not false/);
  });

  it('is UNDECIDED rather than coercing for a non-numeric ordered comparison', () => {
    const out = evaluateCondition(parseCondition('artifact.demand.recommendation > 5'), artifacts);
    expect(out.decided).toBe(false);
  });
});
