import { describe, expect, it } from 'vitest';
import {
  type ContributionInput, type FixedCostInput, type LandedCostInput,
  assessDeliveryWindow, computeBreakEven, computeCashExposure, computeContribution,
  computeLandedCost, computeSellThrough,
} from './finance.js';
import { type FxRate, parseMoney } from './money.js';
import { known, unknown } from './unknown.js';

const CNY_CAD: FxRate = {
  from: 'CNY', to: 'CAD', rate: '0.19000000', asOf: '2026-09-01',
  source: 'Owner-entered bank rate', label: 'OWNER_CONFIRMED_ACTUAL',
};

const cad = (s: string) => parseMoney(s, 'CAD');
const codes = (ds: readonly { code: string }[]) => ds.map((d) => d.code);

/* ==========================================================================
 * Worked fixture, verifiable by hand.
 *
 *   200 garment organiser units, FOB Shanghai, 42.00 CNY each @ 0.19 = 7.98 CAD
 *   Goods                     200 x   7.98 = 1596.00
 *   International freight                      620.00
 *   Cargo insurance                             45.00
 *   Brokerage                                   95.00
 *   Canadian inbound freight                   130.00
 *   Duty 18% of (goods 1596.00 + freight 620.00 = 2216.00) = 398.88
 *   Inspection / repack                        180.00
 *   -------------------------------------------------
 *   Landed batch                              3064.88
 *   Landed per unit  3064.88 / 200 = 15.3244 -> 15.32
 *   Recoverable import tax 5% of (1596.00 + 398.88 = 1994.88) = 99.744 -> 99.74
 * ========================================================================== */
function landedFixture(overrides: Partial<LandedCostInput> = {}): LandedCostInput {
  return {
    reportingCurrency: 'CAD',
    incoterm: 'FOB',
    batchQuantity: 200,
    supplierUnitPrice: parseMoney('42.00', 'CNY'),
    fx: CNY_CAD,
    components: {
      internationalFreight: known(cad('620.00')),
      insurance: known(cad('45.00')),
      brokerage: known(cad('95.00')),
      destinationInboundFreight: known(cad('130.00')),
    },
    duty: {
      hsCode: known('4202.92.90 (owner-confirmed)'),
      rate: known('0.18'),
      basis: { kind: 'GOODS_PLUS_FREIGHT_TO_BORDER' },
      label: 'OWNER_CONFIRMED_ACTUAL',
    },
    recoverableImportTax: { rate: known('0.05'), eligibilityConfirmed: true, label: 'OWNER_CONFIRMED_ACTUAL' },
    allocatedInspectionPackaging: known(cad('180.00')),
    label: 'SUPPLIER_CLAIM',
    ...overrides,
  };
}

describe('computeLandedCost — worked fixture', () => {
  it('reproduces the hand-computed worksheet exactly', () => {
    const r = computeLandedCost(landedFixture());
    expect(r.goodsCostBatch).toEqual(known(cad('1596.00')));
    expect(r.dutyAmount).toEqual(known(cad('398.88')));
    expect(r.landedCostBatch).toEqual(known(cad('3064.88')));
    expect(r.landedCostPerUnit).toEqual(known(cad('15.32')));
    expect(r.recoverableImportTaxBatch).toEqual(known(cad('99.74')));
  });

  it('is deterministic: identical input yields identical output', () => {
    expect(computeLandedCost(landedFixture())).toEqual(computeLandedCost(landedFixture()));
  });

  it('inherits the weakest provenance label of its inputs', () => {
    // Inputs include a SUPPLIER_CLAIM, so the result cannot be stronger.
    expect(computeLandedCost(landedFixture()).label).toBe('SUPPLIER_CLAIM');
  });

  it('produces an auditable trace line for every component', () => {
    const keys = computeLandedCost(landedFixture()).trace.map((t) => t.key);
    for (const k of ['goods', 'internationalFreight', 'importDuty', 'landedBatch', 'landedUnit']) {
      expect(keys).toContain(k);
    }
  });
});

describe('computeLandedCost — unknowns never become zero', () => {
  it('leaves the total unknown when a buyer-borne component is missing', () => {
    const f = landedFixture();
    const { brokerage: _omitted, ...rest } = f.components;
    const r = computeLandedCost({ ...f, components: rest });
    expect(r.landedCostBatch.known).toBe(false);
    expect(r.landedCostPerUnit.known).toBe(false);
    expect(codes(r.diagnostics)).toContain('COMPONENT_MISSING');
    if (!r.landedCostBatch.known) {
      expect(r.landedCostBatch.reasons.join(' ')).toMatch(/brokerage|Brokerage/i);
    }
  });

  it('blocks rather than estimating when the duty rate is unknown', () => {
    const f = landedFixture();
    const r = computeLandedCost({
      ...f,
      duty: { ...f.duty, rate: unknown('Tariff classification not yet confirmed.') },
    });
    expect(r.dutyAmount.known).toBe(false);
    expect(r.landedCostBatch.known).toBe(false);
    expect(codes(r.diagnostics)).toContain('DUTY_RATE_UNKNOWN');
  });

  it('blocks when the value-for-duty basis is undetermined', () => {
    const f = landedFixture();
    const r = computeLandedCost({
      ...f,
      duty: { ...f.duty, basis: { kind: 'NOT_DETERMINED', note: 'Related-party pricing under review.' } },
    });
    expect(codes(r.diagnostics)).toContain('DUTY_BASIS_NOT_DETERMINED');
    expect(r.landedCostBatch.known).toBe(false);
  });

  it('blocks when currency conversion has no dated rate', () => {
    const r = computeLandedCost(landedFixture({ fx: null }));
    expect(codes(r.diagnostics)).toContain('FX_RATE_MISSING');
    expect(r.goodsCostBatch.known).toBe(false);
    expect(r.landedCostBatch.known).toBe(false);
  });

  it('warns when duty is computed without a confirmed classification', () => {
    const f = landedFixture();
    const r = computeLandedCost({
      ...f, duty: { ...f.duty, hsCode: unknown('Not yet classified.') },
    });
    expect(codes(r.diagnostics)).toContain('HS_CODE_UNCONFIRMED');
  });
});

describe('computeLandedCost — Incoterm double counting', () => {
  it('does not charge the buyer for origin costs the supplier bears under FOB', () => {
    const r = computeLandedCost(landedFixture());
    const origin = r.trace.find((t) => t.key === 'originInlandTransport');
    expect(origin?.amount).toEqual(known(cad('0.00')));
    expect(origin?.note).toMatch(/Borne by supplier under FOB/);
    // And the total is unaffected: still the hand-computed figure.
    expect(r.landedCostBatch).toEqual(known(cad('3064.88')));
  });

  it('flags freight added on top of a CIF price as a double count', () => {
    const r = computeLandedCost(landedFixture({ incoterm: 'CIF' }));
    expect(codes(r.diagnostics)).toContain('INCOTERM_DOUBLE_COUNT');
    const blockers = r.diagnostics.filter((d) => d.severity === 'blocker');
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.map((b) => b.message).join(' ')).toMatch(/already includes it/);
  });

  it('treats duty as the supplier’s under DDP and charges it to nobody twice', () => {
    const f = landedFixture({ incoterm: 'DDP' });
    const r = computeLandedCost(f);
    expect(r.dutyAmount).toEqual(known(cad('0.00')));
    // Goods 1596.00 + inspection 180.00 only; everything else is the seller's.
    expect(r.landedCostBatch).toEqual(known(cad('1776.00')));
  });
});

describe('computeLandedCost — recoverable import tax', () => {
  it('never nets recoverable tax against economic cost', () => {
    const confirmed = computeLandedCost(landedFixture());
    const f = landedFixture();
    const unconfirmed = computeLandedCost({
      ...f,
      recoverableImportTax: { ...f.recoverableImportTax, eligibilityConfirmed: false },
    });
    // Landed cost is identical either way: recoverability is a cash question.
    expect(unconfirmed.landedCostBatch).toEqual(confirmed.landedCostBatch);
    expect(unconfirmed.recoverableTreatedAsRecoverable).toBe(false);
    expect(codes(unconfirmed.diagnostics)).toContain('RECOVERABLE_TAX_UNCONFIRMED');
  });

  it('leaves the amount unknown when the rate is unknown', () => {
    const f = landedFixture();
    const r = computeLandedCost({
      ...f,
      recoverableImportTax: { rate: unknown('Registration status unconfirmed.'), eligibilityConfirmed: false, label: 'UNVERIFIED_LEAD' },
    });
    expect(r.recoverableImportTaxBatch.known).toBe(false);
    // ...but that does not block landed cost, which does not depend on it.
    expect(r.landedCostBatch).toEqual(known(cad('3064.88')));
  });
});

/* ==========================================================================
 * Contribution fixture, verifiable by hand (1 unit per order).
 *   Net revenue excl tax                        59.99
 *   Gross charged (incl 3.00 tax)               62.99
 *   Less refunded revenue     6% x 59.99   =     3.60
 *   Less landed COGS                            15.32
 *   Plus goods recovered  6% x 75% x 15.32 =     0.69
 *   Less defect write-off     2% x 15.32   =     0.31
 *   Less return handling      6% x  9.00   =     0.54
 *   Less fulfillment                             3.50
 *   Less outbound shipping                      12.00
 *   Less channel fee     3% of 59.99       =     1.80
 *   Less payment fee 2.9% of 62.99 + 0.30  =     2.13
 *   Less acquisition cost                       14.00
 *   -------------------------------------------------
 *   Contribution per order                       7.48
 * ========================================================================== */
function contributionFixture(overrides: Partial<ContributionInput> = {}): ContributionInput {
  return {
    currency: 'CAD',
    unitsPerOrder: 1,
    listPricePerUnitExclTax: cad('59.99'),
    discountPerOrder: known(cad('0.00')),
    shippingChargedToCustomerExclTax: known(cad('0.00')),
    collectedSalesTaxPerOrder: known(cad('3.00')),
    landedCostPerUnit: known(cad('15.32')),
    fulfillmentCostPerOrder: known(cad('3.50')),
    outboundShippingCostPerOrder: known(cad('12.00')),
    channelFeeRate: known('0.03'),
    channelFeeBase: 'NET_EXCLUDING_TAX',
    paymentFeeRate: known('0.029'),
    paymentFeeBase: 'GROSS_INCLUDING_TAX',
    paymentFeeFixedPerOrder: known(cad('0.30')),
    returns: {
      returnRate: known('0.06'),
      defectRate: known('0.02'),
      unrecoverableGoodsFractionOnReturn: known('0.25'),
      returnHandlingCostPerOrder: known(cad('9.00')),
    },
    acquisitionCostPerOrder: known(cad('14.00')),
    label: 'SUPPLIER_CLAIM',
    ...overrides,
  };
}

describe('computeContribution — worked fixture', () => {
  it('reproduces the hand-computed contribution exactly', () => {
    const r = computeContribution(contributionFixture());
    expect(r.netRevenueExclTaxPerOrder).toEqual(known(cad('59.99')));
    expect(r.grossChargedToCustomerPerOrder).toEqual(known(cad('62.99')));
    expect(r.landedCogsPerOrder).toEqual(known(cad('15.32')));
    expect(r.contributionPerOrder).toEqual(known(cad('7.48')));
    expect(r.contributionPerUnit).toEqual(known(cad('7.48')));
  });

  it('excludes collected sales tax from revenue', () => {
    const withMoreTax = computeContribution(
      contributionFixture({ collectedSalesTaxPerOrder: known(cad('9.00')) }),
    );
    // Revenue is unchanged; only the payment fee base moves.
    expect(withMoreTax.netRevenueExclTaxPerOrder).toEqual(known(cad('59.99')));
    // 2.9% of 68.99 = 2.0007 -> 2.00, plus 0.30 = 2.30 (was 2.13): 0.17 worse.
    expect(withMoreTax.contributionPerOrder).toEqual(known(cad('7.31')));
  });

  it('distinguishes order quantities from unit quantities', () => {
    const r = computeContribution(contributionFixture({ unitsPerOrder: 3 }));
    // 3 units: revenue 179.97, COGS 45.96, and the per-ORDER costs
    // (fulfillment, outbound shipping, acquisition, fixed payment fee) are
    // charged once, which is precisely why bundling improves contribution.
    //   credits     179.97 + 2.07 goods recovered            = 182.04
    //   deductions  10.80 refund + 45.96 COGS + 0.92 defect
    //               + 0.54 handling + 3.50 fulfil + 12.00 ship
    //               + 5.40 channel + 5.61 payment + 14.00 CAC =  98.73
    //   contribution                                         =  83.31
    expect(r.netRevenueExclTaxPerOrder).toEqual(known(cad('179.97')));
    expect(r.landedCogsPerOrder).toEqual(known(cad('45.96')));
    expect(r.contributionPerOrder).toEqual(known(cad('83.31')));
    // 83.31 / 3 = 27.77
    expect(r.contributionPerUnit).toEqual(known(cad('27.77')));
  });

  it('applies the payment fee on the base the caller declares', () => {
    const onNet = computeContribution(contributionFixture({ paymentFeeBase: 'NET_EXCLUDING_TAX' }));
    // 2.9% of 59.99 = 1.739 -> 1.74, vs 1.83 on gross: 0.09 better.
    expect(onNet.contributionPerOrder).toEqual(known(cad('7.57')));
  });

  it('refuses to compute when any input is unknown, rather than assuming zero', () => {
    const r = computeContribution(contributionFixture({
      outboundShippingCostPerOrder: unknown('No quoted parcel rate for Calgary yet.'),
    }));
    expect(r.contributionPerOrder.known).toBe(false);
    expect(codes(r.diagnostics)).toContain('CONTRIBUTION_INCOMPLETE');
    if (!r.contributionPerOrder.known) {
      expect(r.contributionPerOrder.reasons).toContain('No quoted parcel rate for Calgary yet.');
    }
  });

  it('reports negative contribution as a blocker', () => {
    const r = computeContribution(contributionFixture({
      outboundShippingCostPerOrder: known(cad('45.00')),
      acquisitionCostPerOrder: known(cad('30.00')),
    }));
    expect(r.contributionPerOrder).toEqual(known(cad('-41.52')));
    const blocker = r.diagnostics.find((d) => d.code === 'CONTRIBUTION_NEGATIVE');
    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.message).toMatch(/volume makes this worse/);
  });

  it('treats exactly-zero contribution as a blocker too', () => {
    // Raise acquisition cost by exactly the 7.48 of contribution.
    const r = computeContribution(contributionFixture({
      acquisitionCostPerOrder: known(cad('21.48')),
    }));
    expect(r.contributionPerOrder).toEqual(known(cad('0.00')));
    expect(codes(r.diagnostics)).toContain('CONTRIBUTION_ZERO');
  });

  it('states in the trace that contribution is not net profit', () => {
    const line = computeContribution(contributionFixture()).trace
      .find((t) => t.key === 'contribution');
    expect(line?.note).toMatch(/NOT net profit/);
  });
});

describe('computeBreakEven', () => {
  const fixed: FixedCostInput = {
    currency: 'CAD',
    overheadPerMonth: known(cad('1200.00')),
    ownerLabourPerMonth: known(cad('2000.00')),
    includeOwnerLabourInBreakEven: false,
  };

  it('computes break-even orders and units with ceiling division', () => {
    const c = computeContribution(contributionFixture());
    const r = computeBreakEven(c, fixed);
    // 1200.00 / 7.48 = 160.43 -> 161 orders, 1 unit each.
    expect(r.computed).toBe(true);
    expect(r.breakEvenOrdersPerMonth).toEqual(known(161));
    expect(r.breakEvenUnitsPerMonth).toEqual(known(161));
    expect(codes(r.diagnostics)).toContain('OWNER_LABOUR_EXCLUDED');
  });

  it('rises when owner labour is included, and says so', () => {
    const c = computeContribution(contributionFixture());
    const r = computeBreakEven(c, { ...fixed, includeOwnerLabourInBreakEven: true });
    // 3200.00 / 7.48 = 427.8 -> 428
    expect(r.breakEvenOrdersPerMonth).toEqual(known(428));
    expect(codes(r.diagnostics)).not.toContain('OWNER_LABOUR_EXCLUDED');
  });

  it('scales units by order size', () => {
    const c = computeContribution(contributionFixture({ unitsPerOrder: 3 }));
    const r = computeBreakEven(c, fixed);
    // 1200.00 / 83.31 = 14.40 -> 15 orders x 3 units = 45 units
    expect(r.breakEvenOrdersPerMonth).toEqual(known(15));
    expect(r.breakEvenUnitsPerMonth).toEqual(known(45));
  });

  it('refuses to compute break-even on negative contribution', () => {
    const c = computeContribution(contributionFixture({
      outboundShippingCostPerOrder: known(cad('45.00')),
      acquisitionCostPerOrder: known(cad('30.00')),
    }));
    const r = computeBreakEven(c, fixed);
    expect(r.computed).toBe(false);
    expect(r.breakEvenUnitsPerMonth.known).toBe(false);
    expect(codes(r.diagnostics)).toContain('BREAK_EVEN_UNDEFINED');
  });

  it('refuses on zero contribution', () => {
    const c = computeContribution(contributionFixture({ acquisitionCostPerOrder: known(cad('21.48')) }));
    expect(computeBreakEven(c, fixed).computed).toBe(false);
  });

  it('refuses when contribution itself is unknown', () => {
    const c = computeContribution(contributionFixture({
      fulfillmentCostPerOrder: unknown('Packaging not specified.'),
    }));
    const r = computeBreakEven(c, fixed);
    expect(r.computed).toBe(false);
    expect(r.reason).toMatch(/unknown/);
  });
});

describe('computeCashExposure', () => {
  it('sums cash at risk and reports headroom under the owner cap', () => {
    const r = computeCashExposure({
      currency: 'CAD',
      supplierDepositPaid: known(cad('900.00')),
      supplierBalanceCommitted: known(cad('2164.88')),
      inventoryAtLandedCost: known(cad('0.00')),
      recoverableTaxOutstanding: known(cad('99.74')),
      settlementHeldByProcessor: known(cad('0.00')),
      refundReserve: known(cad('150.00')),
      ownerConfiguredExposureCap: known(cad('4000.00')),
    });
    expect(r.totalCashAtRisk).toEqual(known(cad('3314.62')));
    expect(r.capBreached).toBe(false);
    expect(r.headroom).toEqual(known(cad('685.38')));
  });

  it('blocks when the owner cap is breached', () => {
    const r = computeCashExposure({
      currency: 'CAD',
      supplierDepositPaid: known(cad('3000.00')),
      supplierBalanceCommitted: known(cad('3000.00')),
      inventoryAtLandedCost: known(cad('0.00')),
      recoverableTaxOutstanding: known(cad('0.00')),
      settlementHeldByProcessor: known(cad('0.00')),
      refundReserve: known(cad('0.00')),
      ownerConfiguredExposureCap: known(cad('4000.00')),
    });
    expect(r.capBreached).toBe(true);
    expect(codes(r.diagnostics)).toContain('EXPOSURE_CAP_BREACHED');
  });

  it('does not invent a budget when no cap is configured', () => {
    const r = computeCashExposure({
      currency: 'CAD',
      supplierDepositPaid: known(cad('900.00')),
      supplierBalanceCommitted: known(cad('0.00')),
      inventoryAtLandedCost: known(cad('0.00')),
      recoverableTaxOutstanding: known(cad('0.00')),
      settlementHeldByProcessor: known(cad('0.00')),
      refundReserve: known(cad('0.00')),
      ownerConfiguredExposureCap: unknown('Owner has not set an exposure cap.'),
    });
    expect(r.capBreached).toBe('unknown');
    expect(codes(r.diagnostics)).toContain('EXPOSURE_CAP_UNSET');
  });
});

describe('computeSellThrough', () => {
  it('quantifies dead stock at 70% sell-through', () => {
    const r = computeSellThrough({
      currency: 'CAD', batchQuantity: 200,
      landedCostPerUnit: known(cad('15.32')),
      sellThroughRate: known('0.70'),
      salvageValuePerUnit: known(cad('4.00')),
    });
    // 140 sold, 60 unsold, loss 11.32 each = 679.20
    expect(r.unsoldUnits).toEqual(known(60));
    expect(r.markdownWriteOff).toEqual(known(cad('679.20')));
    expect(codes(r.diagnostics)).toContain('DEAD_STOCK_EXPOSURE');
  });

  it('does not assume full sell-through when the rate is unknown', () => {
    const r = computeSellThrough({
      currency: 'CAD', batchQuantity: 200,
      landedCostPerUnit: known(cad('15.32')),
      sellThroughRate: unknown('No comparable sell-through data.'),
      salvageValuePerUnit: known(cad('4.00')),
    });
    expect(r.unsoldUnits.known).toBe(false);
    expect(codes(r.diagnostics)).toContain('SELL_THROUGH_UNKNOWN');
  });
});

describe('assessDeliveryWindow', () => {
  it('blocks when stock lands after the occasion', () => {
    const r = assessDeliveryWindow({
      occasionName: 'Diwali 2026 retail window',
      mustBeSellableBy: '2026-10-24',
      estimatedSellableFrom: known('2026-11-02'),
    });
    expect(r.missesWindow).toBe(true);
    expect(r.daysOfMargin).toEqual(known(-9));
    expect(codes(r.diagnostics)).toContain('DELIVERY_WINDOW_MISSED');
  });

  it('warns on a margin thinner than freight variance', () => {
    const r = assessDeliveryWindow({
      occasionName: 'Diwali 2026 retail window',
      mustBeSellableBy: '2026-10-24',
      estimatedSellableFrom: known('2026-10-18'),
    });
    expect(r.missesWindow).toBe(false);
    expect(codes(r.diagnostics)).toContain('DELIVERY_WINDOW_TIGHT');
  });

  it('is silent when there is comfortable margin', () => {
    const r = assessDeliveryWindow({
      occasionName: 'Diwali 2026 retail window',
      mustBeSellableBy: '2026-10-24',
      estimatedSellableFrom: known('2026-09-01'),
    });
    expect(r.diagnostics).toHaveLength(0);
    expect(r.daysOfMargin).toEqual(known(53));
  });

  it('cannot assess without an estimate', () => {
    const r = assessDeliveryWindow({
      occasionName: 'Diwali 2026 retail window',
      mustBeSellableBy: '2026-10-24',
      estimatedSellableFrom: unknown('No supplier lead time quoted.'),
    });
    expect(r.missesWindow).toBe('unknown');
    expect(codes(r.diagnostics)).toContain('DELIVERY_ESTIMATE_UNKNOWN');
  });
});
