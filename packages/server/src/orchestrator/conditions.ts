/**
 * Restricted condition language for conditional workflow nodes.
 *
 * Deliberately NOT a JavaScript expression evaluator. `eval` or `new Function`
 * on a workflow field would let anything that can edit a graph run arbitrary
 * code in the server process, and graphs are editable through the API. This
 * parser accepts one comparison over a whitelisted set of readable paths and
 * nothing else.
 *
 * Grammar:
 *   condition  := path op literal
 *   path       := "artifact." nodeKey "." field
 *   op         := "==" | "!=" | ">" | ">=" | "<" | "<="
 *   literal    := quoted string | number | true | false | null
 */
export type ConditionValue = string | number | boolean | null;

export interface ParsedCondition {
  readonly nodeKey: string;
  readonly field: string;
  readonly op: '==' | '!=' | '>' | '>=' | '<' | '<=';
  readonly literal: ConditionValue;
}

export class ConditionSyntaxError extends Error {
  constructor(condition: string, detail: string) {
    super(`Cannot parse condition ${JSON.stringify(condition)}: ${detail}`);
    this.name = 'ConditionSyntaxError';
  }
}

const CONDITION_RE =
  /^\s*artifact\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;

export function parseCondition(condition: string): ParsedCondition {
  const m = CONDITION_RE.exec(condition);
  if (m === null) {
    throw new ConditionSyntaxError(
      condition,
      'expected the form artifact.<nodeKey>.<field> <op> <literal>',
    );
  }
  const [, nodeKey = '', field = '', op = '==', rawLiteral = ''] = m;
  return {
    nodeKey, field,
    op: op as ParsedCondition['op'],
    literal: parseLiteral(condition, rawLiteral),
  };
}

function parseLiteral(condition: string, raw: string): ConditionValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw) || /^'(?:[^'\\]|\\.)*'$/.test(raw)) {
    return raw.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  throw new ConditionSyntaxError(condition, `unsupported literal ${raw}`);
}

export type ConditionOutcome =
  | { readonly decided: true; readonly result: boolean; readonly actual: ConditionValue | undefined }
  | { readonly decided: false; readonly reason: string };

/**
 * Evaluate against artifact bodies keyed by node key.
 *
 * An absent artifact or field is UNDECIDED, not false. Branching on a missing
 * input would silently take the "else" path and hide the fact that the work it
 * depended on never produced an answer.
 */
export function evaluateCondition(
  parsed: ParsedCondition,
  artifactsByNodeKey: ReadonlyMap<string, Record<string, unknown>>,
): ConditionOutcome {
  const body = artifactsByNodeKey.get(parsed.nodeKey);
  if (body === undefined) {
    return { decided: false, reason: `No artifact from node "${parsed.nodeKey}" to evaluate.` };
  }
  if (!(parsed.field in body)) {
    return {
      decided: false,
      reason: `Artifact from "${parsed.nodeKey}" has no field "${parsed.field}". A missing field is undecided, not false.`,
    };
  }
  const actual = body[parsed.field] as ConditionValue | undefined;

  if (parsed.op === '==' || parsed.op === '!=') {
    const equal = actual === parsed.literal;
    return { decided: true, result: parsed.op === '==' ? equal : !equal, actual };
  }
  if (typeof actual !== 'number' || typeof parsed.literal !== 'number') {
    return {
      decided: false,
      reason: `Ordered comparison needs numbers on both sides; got ${typeof actual} and ${typeof parsed.literal}.`,
    };
  }
  const result =
    parsed.op === '>' ? actual > parsed.literal :
    parsed.op === '>=' ? actual >= parsed.literal :
    parsed.op === '<' ? actual < parsed.literal :
    actual <= parsed.literal;
  return { decided: true, result, actual };
}
