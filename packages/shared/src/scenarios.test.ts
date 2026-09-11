import { describe, expect, it } from 'vitest';
import type { ContributionInput, FixedCostInput, LandedCostInput, SellThroughInput } from './finance.js';
import { type FxRate, parseMoney } from './money.js';
import { auditScenarioSet, runScenario, runScenarioSet, type ScenarioBaseInputs, type ScenarioDefinition } from './scenarios.js';
import { known } from './unknown.js';

const cad = (s: string) => parseMoney(s, 'CAD');
const CNY_CAD: FxRate = {
  from: 'CNY', to: 'CAD', rate: '0.19000000', asOf: '2026-09-01',
  source: 'Owner-entered bank rate', label: 'OWNER_CONFIRMED_ACTUAL',
};

const landed: LandedCostInput = {
  reportingCurrency: 'CAD', incoterm: 'FOB', batchQuantity: 200,
  supplierUnitPrice: parseMoney('42.00', 'CNY'), fx: CNY_CAD,
  components: {
    internationalFreight: known(cad('620.00')), insurance: known(cad('45.00')),
    brokerage: known(cad('95.00')), destinationInboundFreight: known(cad('130.00')),
  },
  duty: {
    hsCode: known('4202.92.90'), rate: known('0.18'),
    basis: { kind: 'GOODS_PLUS_FREIGHT_TO_BORDER' }, label: 'OWNER_CONFIRMED_ACTUAL',
  },
  recoverableImportTax: { rate: known('0.05'), eligibilityConfirmed: true, label: 'OWNER_CONFIRMED_ACTUAL' },
  allocatedInspectionPackaging: known(cad('180.00')),
  label: 'SUPPLIER_CLAIM',
};

const contribution: Omit<ContributionInput, 'landedCostPerUnit'> = {
  currency: 'CAD', unitsPerOrder: 1, listPricePerUnitExclTax: cad('59.99'),
  discountPerOrder: known(cad('0.00')),
  shippingChargedToCustomerExclTax: known(cad('0.00')),
  collectedSalesTaxPerOrder: known(cad('3.00')),
  fulfillmentCostPerOrder: known(cad('3.50')),
  outboundShippingCostPerOrder: known(cad('12.00')),
  channelFeeRate: known('0.03'), channelFeeBase: 'NET_EXCLUDING_TAX',
  paymentFeeRate: known('0.029'), paymentFeeBase: 'GROSS_INCLUDING_TAX',
  paymentFeeFixedPerOrder: known(cad('0.30')),
  returns: {
    returnRate: known('0.06'), defectRate: known('0.02'),
    unrecoverableGoodsFractionOnReturn: known('0.25'),
    returnHandlingCostPerOrder: known(cad('9.00')),
  },
  acquisitionCostPerOrder: known(cad('14.00')),
  label: 'SUPPLIER_CLAIM',
};

const fixed: FixedCostInput = {
  currency: 'CAD', overheadPerMonth: known(cad('1200.00')),
  ownerLabourPerMonth: known(cad('2000.00')), includeOwnerLabourInBreakEven: false,
};

const sellThrough: Omit<SellThroughInput, 'landedCostPerUnit' | 'batchQuantity'> = {
  currency: 'CAD', sellThroughRate: known('0.70'), salvageValuePerUnit: known(cad('4.00')),
};

const base: ScenarioBaseInputs = { landed, contribution, fixed, sellThrough };

const BASE: ScenarioDefinition = {
  name: 'Base', kind: 'base', rationale: 'Quoted freight, 6% returns, 0.19 CNY/CAD.',
  overrides: {},
};
const DOWNSIDE: ScenarioDefinition = {
  name: 'Freight and FX both move against us', kind: 'downside',
  rationale: 'Freight +60%, CNY strengthens to 0.22, returns double, CAC rises.',
  overrides: {
    internationalFreightMultiplier: '1.60', fxRate: '0.22000000',
    returnRate: '0.12', acquisitionCostPerOrder: cad('22.00'),
    sellThroughRate: '0.45',
  },
};
const UPSIDE: ScenarioDefinition = {
  name: 'Bundle sells at full price', kind: 'upside',
  rationale: 'Larger batch lowers unit freight share; returns settle at 4%.',
  overrides: { batchQuantity: 400, returnRate: '0.04', sellThroughRate: '0.90' },
};

describe('runScenario', () => {
  it('reproduces the base fixture', () => {
    const r = runScenario(base, BASE);
    expect(r.landed.landedCostPerUnit).toEqual(known(cad('15.32')));
    expect(r.contribution.contributionPerOrder).toEqual(known(cad('7.48')));
    expect(r.breakEven.breakEvenOrdersPerMonth).toEqual(known(161));
  });

  it('is deterministic across repeated runs', () => {
    expect(runScenario(base, DOWNSIDE)).toEqual(runScenario(base, DOWNSIDE));
  });

  it('makes the downside genuinely worse', () => {
    const b = runScenario(base, BASE).contribution.contributionPerOrder;
    const d = runScenario(base, DOWNSIDE).contribution.contributionPerOrder;
    expect(b.known && d.known && d.value.minor < b.value.minor).toBe(true);
  });

  it('applies a batch-size override to landed cost per unit', () => {
    const up = runScenario(base, UPSIDE);
    const b = runScenario(base, BASE);
    // Fixed batch charges spread over 400 units instead of 200.
    expect(up.landed.batchQuantity).toBe(400);
    expect(up.landed.landedCostPerUnit.known && b.landed.landedCostPerUnit.known
      && up.landed.landedCostPerUnit.value.minor < b.landed.landedCostPerUnit.value.minor).toBe(true);
  });

  it('does not mutate the shared base inputs', () => {
    const before = JSON.stringify(base);
    runScenario(base, DOWNSIDE);
    runScenario(base, UPSIDE);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('leaves inputs a scenario does not name untouched', () => {
    const r = runScenario(base, { name: 'x', kind: 'upside', rationale: 'only returns', overrides: { returnRate: '0.04' } });
    expect(r.landed.landedCostPerUnit).toEqual(known(cad('15.32')));
  });
});

describe('auditScenarioSet', () => {
  it('accepts a set with a real downside', () => {
    const results = runScenarioSet(base, [BASE, DOWNSIDE, UPSIDE]);
    expect(auditScenarioSet(results)).toHaveLength(0);
  });

  it('flags a set with no downside case', () => {
    const codes = auditScenarioSet(runScenarioSet(base, [BASE, UPSIDE])).map((d) => d.code);
    expect(codes).toContain('SCENARIO_NO_DOWNSIDE');
  });

  it('flags a set with no base case', () => {
    const codes = auditScenarioSet(runScenarioSet(base, [DOWNSIDE])).map((d) => d.code);
    expect(codes).toContain('SCENARIO_NO_BASE');
  });

  it('catches a flattering "downside" that is not actually adverse', () => {
    const fake: ScenarioDefinition = {
      name: 'Downside in name only', kind: 'downside',
      rationale: 'Claims to be adverse but improves returns.',
      overrides: { returnRate: '0.01' },
    };
    const codes = auditScenarioSet(runScenarioSet(base, [BASE, fake])).map((d) => d.code);
    expect(codes).toContain('SCENARIO_DOWNSIDE_NOT_ADVERSE');
  });
});
