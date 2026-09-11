import type { FxRate, Money } from './money.js';
import { rateOfMoney } from './money.js';
import {
  type BreakEvenResult, type ContributionInput, type ContributionResult,
  type FinanceDiagnostic, type FixedCostInput, type LandedCostInput, type LandedCostResult,
  type SellThroughInput, type SellThroughResult,
  computeBreakEven, computeContribution, computeLandedCost, computeSellThrough,
} from './finance.js';
import { type Maybe, isKnown, known } from './unknown.js';

/**
 * Scenario overrides. Every field is an explicit replacement or multiplier; a
 * scenario never silently perturbs an input the author did not name, so two
 * scenarios differ only where the rationale says they differ.
 */
export interface ScenarioOverrides {
  readonly fxRate?: string;
  readonly internationalFreightMultiplier?: string;
  readonly batchQuantity?: number;
  readonly defectRate?: string;
  readonly returnRate?: string;
  readonly discountPerOrder?: Money;
  readonly acquisitionCostPerOrder?: Money;
  readonly listPricePerUnitExclTax?: Money;
  readonly sellThroughRate?: string;
}

export type ScenarioKind = 'base' | 'downside' | 'upside';

export interface ScenarioDefinition {
  readonly name: string;
  readonly kind: ScenarioKind;
  /** Why these values, in the author's words. Required: an unexplained
   *  scenario is a number with no argument behind it. */
  readonly rationale: string;
  readonly overrides: ScenarioOverrides;
}

export interface ScenarioResult {
  readonly definition: ScenarioDefinition;
  readonly landed: LandedCostResult;
  readonly contribution: ContributionResult;
  readonly breakEven: BreakEvenResult;
  readonly sellThrough: SellThroughResult;
  readonly diagnostics: readonly FinanceDiagnostic[];
}

export interface ScenarioBaseInputs {
  readonly landed: LandedCostInput;
  readonly contribution: Omit<ContributionInput, 'landedCostPerUnit'>;
  readonly fixed: FixedCostInput;
  readonly sellThrough: Omit<SellThroughInput, 'landedCostPerUnit' | 'batchQuantity'>;
}

function withFxRate(fx: FxRate | null, rate: string | undefined): FxRate | null {
  if (fx === null || rate === undefined) return fx;
  return { ...fx, rate, source: `${fx.source} (scenario override)` };
}

function scaleMaybeMoney(m: Maybe<Money> | undefined, multiplier: string | undefined): Maybe<Money> | undefined {
  if (m === undefined || multiplier === undefined) return m;
  if (!isKnown(m)) return m;
  return known(rateOfMoney(m.value, multiplier));
}

/**
 * Run one scenario deterministically. Given identical inputs this returns
 * identical output: there is no sampling, no randomness and no model call in
 * this path. Model output may inform the *inputs*; it never performs the
 * arithmetic.
 */
export function runScenario(base: ScenarioBaseInputs, def: ScenarioDefinition): ScenarioResult {
  const o = def.overrides;

  const freight = scaleMaybeMoney(
    base.landed.components.internationalFreight, o.internationalFreightMultiplier,
  );

  const landedInput: LandedCostInput = {
    ...base.landed,
    batchQuantity: o.batchQuantity ?? base.landed.batchQuantity,
    fx: withFxRate(base.landed.fx, o.fxRate),
    components: freight === undefined
      ? base.landed.components
      : { ...base.landed.components, internationalFreight: freight },
  };

  const landed = computeLandedCost(landedInput);

  const contributionInput: ContributionInput = {
    ...base.contribution,
    landedCostPerUnit: landed.landedCostPerUnit,
    ...(o.listPricePerUnitExclTax !== undefined
      ? { listPricePerUnitExclTax: o.listPricePerUnitExclTax } : {}),
    ...(o.discountPerOrder !== undefined
      ? { discountPerOrder: known(o.discountPerOrder) } : {}),
    ...(o.acquisitionCostPerOrder !== undefined
      ? { acquisitionCostPerOrder: known(o.acquisitionCostPerOrder) } : {}),
    returns: {
      ...base.contribution.returns,
      ...(o.defectRate !== undefined ? { defectRate: known(o.defectRate) } : {}),
      ...(o.returnRate !== undefined ? { returnRate: known(o.returnRate) } : {}),
    },
  };

  const contribution = computeContribution(contributionInput);
  const breakEven = computeBreakEven(contribution, base.fixed);

  const sellThrough = computeSellThrough({
    ...base.sellThrough,
    batchQuantity: landedInput.batchQuantity,
    landedCostPerUnit: landed.landedCostPerUnit,
    ...(o.sellThroughRate !== undefined ? { sellThroughRate: known(o.sellThroughRate) } : {}),
  });

  return {
    definition: def, landed, contribution, breakEven, sellThrough,
    diagnostics: [
      ...landed.diagnostics, ...contribution.diagnostics,
      ...breakEven.diagnostics, ...sellThrough.diagnostics,
    ],
  };
}

export function runScenarioSet(
  base: ScenarioBaseInputs, definitions: readonly ScenarioDefinition[],
): ScenarioResult[] {
  return definitions.map((d) => runScenario(base, d));
}

/**
 * A scenario set is only decision-useful if the downside is genuinely adverse.
 * This check exists because optimistic "downside" cases are the most common way
 * a scenario table flatters a bad product.
 */
export function auditScenarioSet(results: readonly ScenarioResult[]): FinanceDiagnostic[] {
  const out: FinanceDiagnostic[] = [];
  const base = results.find((r) => r.definition.kind === 'base');
  const down = results.filter((r) => r.definition.kind === 'downside');

  if (base === undefined) {
    out.push({
      code: 'SCENARIO_NO_BASE', severity: 'blocker',
      message: 'Scenario set has no base case, so downside and upside have nothing to vary from.',
    });
    return out;
  }
  if (down.length === 0) {
    out.push({
      code: 'SCENARIO_NO_DOWNSIDE', severity: 'blocker',
      message: 'Scenario set has no downside case. A set without one is a forecast, not an analysis.',
    });
  }
  const baseC = base.contribution.contributionPerOrder;
  for (const d of down) {
    const dC = d.contribution.contributionPerOrder;
    if (isKnown(baseC) && isKnown(dC) && dC.value.minor >= baseC.value.minor) {
      out.push({
        code: 'SCENARIO_DOWNSIDE_NOT_ADVERSE', severity: 'warning',
        message: `Downside scenario "${d.definition.name}" produces contribution at or above the base case. Either the overrides are not actually adverse, or the base case is already pessimistic.`,
      });
    }
  }
  return out;
}
