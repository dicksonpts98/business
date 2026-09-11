import {
  type CurrencyCode, type FxRate, type Money,
  addMoney, convertMoney, divideMoney, formatMoney, isPositive, multiplyMoney,
  rateOfMoney, subMoney, sumMoney, zero,
} from './money.js';
import { RATE_ONE, formatScaled, parseRate } from './decimal.js';
import {
  COMPONENT_LABEL, type Incoterm, LANDED_COMPONENTS, type LandedComponent,
  sellerBears, sellerBorneComponents,
} from './incoterms.js';
import { type ProvenanceLabel, weakestLabel } from './provenance.js';
import { type Maybe, collectUnknownReasons, expectKnown, isKnown, known, unknown } from './unknown.js';

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

export type FinanceSeverity = 'blocker' | 'warning' | 'note';

export interface FinanceDiagnostic {
  readonly code: string;
  readonly severity: FinanceSeverity;
  readonly message: string;
}

/** One auditable line of a worksheet. Amount is absent when unknown. */
export interface TraceLine {
  readonly key: string;
  readonly label: string;
  readonly amount: Maybe<Money>;
  readonly note?: string;
}

function traceLine(key: string, label: string, amount: Maybe<Money>, note?: string): TraceLine {
  return note === undefined ? { key, label, amount } : { key, label, amount, note };
}

/* -------------------------------------------------------------------------- */
/* Landed cost                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Value for duty basis. Canadian duty is normally assessed on the value for
 * duty determined under the Customs Act, which is usually — but not always —
 * the transaction value. The basis is therefore an explicit input, never an
 * assumption, and an unconfirmed basis produces a blocker rather than a number.
 */
export type DutyBasis =
  | { readonly kind: 'GOODS_ONLY' }
  | { readonly kind: 'GOODS_PLUS_FREIGHT_TO_BORDER' }
  | { readonly kind: 'DECLARED_VALUE_FOR_DUTY'; readonly amount: Money }
  | { readonly kind: 'NOT_DETERMINED'; readonly note: string };

export interface DutyInput {
  /** Tariff classification. Never invented; unknown until a human confirms it. */
  readonly hsCode: Maybe<string>;
  /** Duty rate as a decimal string, e.g. "0.18" for 18%. */
  readonly rate: Maybe<string>;
  readonly basis: DutyBasis;
  readonly label: ProvenanceLabel;
}

/**
 * Recoverable import tax (e.g. GST paid at import that a registrant may later
 * recover as an input tax credit). Recoverability is an eligibility question
 * with a real answer that this application does not get to assume. When
 * unconfirmed, the amount still affects cash timing but is NOT removed from
 * economic cost.
 */
export interface RecoverableTaxInput {
  readonly rate: Maybe<string>;
  readonly eligibilityConfirmed: boolean;
  readonly label: ProvenanceLabel;
}

export interface LandedCostInput {
  readonly reportingCurrency: CurrencyCode;
  readonly incoterm: Incoterm;
  /** Units in the purchase batch. Landed cost per unit divides by this. */
  readonly batchQuantity: number;
  /** Supplier's quoted unit price in the supplier's own currency. */
  readonly supplierUnitPrice: Money;
  /** Required when the supplier currency differs from the reporting currency. */
  readonly fx: FxRate | null;
  /** Per-BATCH amounts in the reporting currency, keyed by component. */
  readonly components: Readonly<Partial<Record<LandedComponent, Maybe<Money>>>>;
  readonly duty: DutyInput;
  readonly recoverableImportTax: RecoverableTaxInput;
  /** Inspection, rework and repackaging allocated to this batch. */
  readonly allocatedInspectionPackaging: Maybe<Money>;
  readonly label: ProvenanceLabel;
}

export interface LandedCostResult {
  readonly batchQuantity: number;
  readonly reportingCurrency: CurrencyCode;
  readonly goodsCostBatch: Maybe<Money>;
  readonly dutyAmount: Maybe<Money>;
  readonly landedCostBatch: Maybe<Money>;
  readonly landedCostPerUnit: Maybe<Money>;
  /** Cash outlay recoverable later. Never netted against economic cost. */
  readonly recoverableImportTaxBatch: Maybe<Money>;
  readonly recoverableTreatedAsRecoverable: boolean;
  readonly diagnostics: readonly FinanceDiagnostic[];
  readonly trace: readonly TraceLine[];
  readonly label: ProvenanceLabel;
}

export function computeLandedCost(input: LandedCostInput): LandedCostResult {
  const ccy = input.reportingCurrency.toUpperCase();
  const diagnostics: FinanceDiagnostic[] = [];
  const trace: TraceLine[] = [];
  const labels: ProvenanceLabel[] = [input.label, input.duty.label, input.recoverableImportTax.label];

  if (!Number.isInteger(input.batchQuantity) || input.batchQuantity <= 0) {
    diagnostics.push({
      code: 'BATCH_QUANTITY_INVALID', severity: 'blocker',
      message: `Batch quantity must be a positive integer; received ${input.batchQuantity}.`,
    });
  }

  /* --- goods cost, converted if needed ------------------------------------ */
  let goodsUnit: Maybe<Money>;
  if (input.supplierUnitPrice.currency === ccy) {
    goodsUnit = known(input.supplierUnitPrice);
  } else if (input.fx === null) {
    goodsUnit = unknown(
      `Supplier price is in ${input.supplierUnitPrice.currency} but reporting currency is ${ccy}; no dated FX rate supplied.`,
    );
    diagnostics.push({
      code: 'FX_RATE_MISSING', severity: 'blocker',
      message: `Cannot convert ${input.supplierUnitPrice.currency} to ${ccy} without a dated FX rate.`,
    });
  } else {
    goodsUnit = known(convertMoney(input.supplierUnitPrice, input.fx));
    labels.push(input.fx.label);
    trace.push(traceLine(
      'fx', `FX ${input.fx.from}->${input.fx.to} @ ${input.fx.rate} (as of ${input.fx.asOf})`,
      known(input.supplierUnitPrice), `source: ${input.fx.source}`,
    ));
  }

  const qty = input.batchQuantity;
  const goodsBatch: Maybe<Money> = isKnown(goodsUnit) && qty > 0
    ? known(multiplyMoney(goodsUnit.value, qty))
    : isKnown(goodsUnit) ? unknown('Batch quantity invalid.') : goodsUnit;

  trace.push(traceLine('goods', `Goods cost (${qty} units)`, goodsBatch));

  /* --- component costs, with double-count detection ---------------------- */
  const componentAmounts: Maybe<Money>[] = [];
  for (const component of LANDED_COMPONENTS) {
    if (component === 'importDuty') continue; // computed from rate below
    const supplied = input.components[component];
    const sellerCovers = sellerBears(input.incoterm, component);

    if (supplied === undefined) {
      if (sellerCovers) {
        trace.push(traceLine(component, COMPONENT_LABEL[component], known(zero(ccy)),
          `Borne by supplier under ${input.incoterm}; not added.`));
      } else {
        const m = unknown(
          `${COMPONENT_LABEL[component]} is the buyer's cost under ${input.incoterm} but no amount was supplied.`,
        );
        componentAmounts.push(m);
        trace.push(traceLine(component, COMPONENT_LABEL[component], m));
        diagnostics.push({
          code: 'COMPONENT_MISSING', severity: 'warning',
          message: `${COMPONENT_LABEL[component]} not supplied and is the buyer's responsibility under ${input.incoterm}. It is recorded as unknown, not zero.`,
        });
      }
      continue;
    }

    if (sellerCovers && isKnown(supplied) && supplied.value.minor !== 0) {
      // The Incoterm is the contractual fact; a stray amount here is a data
      // entry error. Excluding it keeps the headline total correct, and the
      // blocker plus the trace line make the exclusion explicit rather than
      // silent. Including it would publish a knowingly inflated landed cost
      // that only a diagnostic contradicted.
      diagnostics.push({
        code: 'INCOTERM_DOUBLE_COUNT', severity: 'blocker',
        message: `${COMPONENT_LABEL[component]} of ${formatMoney(supplied.value)} was supplied, but under ${input.incoterm} the supplier's price already includes it. Adding it double-counts the cost, so it is excluded from the total. Correct the Incoterm or remove the amount.`,
      });
      componentAmounts.push(known(zero(ccy)));
      trace.push(traceLine(component, COMPONENT_LABEL[component], known(zero(ccy)),
        `EXCLUDED as a double count: ${formatMoney(supplied.value)} was supplied but the supplier bears this under ${input.incoterm}.`));
      continue;
    }
    componentAmounts.push(supplied);
    trace.push(traceLine(component, COMPONENT_LABEL[component], supplied));
  }

  /* --- duty --------------------------------------------------------------- */
  const dutyBase = resolveDutyBase(input, goodsBatch, ccy);
  let dutyAmount: Maybe<Money>;
  const suppliedDuty = input.components.importDuty;

  if (sellerBears(input.incoterm, 'importDuty')) {
    dutyAmount = known(zero(ccy));
    trace.push(traceLine('importDuty', 'Import duty', dutyAmount,
      `Borne by supplier under ${input.incoterm}.`));
    if (suppliedDuty !== undefined && isKnown(suppliedDuty) && suppliedDuty.value.minor !== 0) {
      diagnostics.push({
        code: 'INCOTERM_DOUBLE_COUNT', severity: 'blocker',
        message: `Import duty of ${formatMoney(suppliedDuty.value)} was supplied but ${input.incoterm} places it on the supplier, so it is excluded from the total.`,
      });
    }
  } else if (suppliedDuty !== undefined) {
    dutyAmount = suppliedDuty;
    trace.push(traceLine('importDuty', 'Import duty (supplied amount)', dutyAmount));
  } else if (!isKnown(input.duty.rate)) {
    dutyAmount = unknown(input.duty.rate.reasons);
    trace.push(traceLine('importDuty', 'Import duty', dutyAmount));
    diagnostics.push({
      code: 'DUTY_RATE_UNKNOWN', severity: 'blocker',
      message: 'Duty rate is unknown. A rate must be established from the tariff for the confirmed classification; it is not estimated here.',
    });
  } else if (!isKnown(dutyBase)) {
    dutyAmount = unknown(dutyBase.reasons);
    trace.push(traceLine('importDuty', 'Import duty', dutyAmount));
  } else {
    dutyAmount = known(rateOfMoney(dutyBase.value, input.duty.rate.value));
    trace.push(traceLine('importDuty', `Import duty @ ${input.duty.rate.value}`, dutyAmount,
      `Base: ${formatMoney(dutyBase.value)} (${input.duty.basis.kind})`));
  }

  if (!isKnown(input.duty.hsCode) && isKnown(dutyAmount) && dutyAmount.value.minor !== 0) {
    diagnostics.push({
      code: 'HS_CODE_UNCONFIRMED', severity: 'warning',
      message: 'Duty has been computed without a confirmed tariff classification. Classification determines the rate and is a customs matter; confirm it before relying on this figure.',
    });
  }
  if (input.duty.basis.kind === 'NOT_DETERMINED') {
    diagnostics.push({
      code: 'DUTY_BASIS_NOT_DETERMINED', severity: 'blocker',
      message: `Value for duty basis is not determined: ${input.duty.basis.note}`,
    });
  }

  componentAmounts.push(dutyAmount);

  /* --- inspection and packaging ------------------------------------------ */
  componentAmounts.push(input.allocatedInspectionPackaging);
  trace.push(traceLine('inspectionPackaging', 'Allocated inspection, rework and packaging',
    input.allocatedInspectionPackaging));

  /* --- totals ------------------------------------------------------------- */
  const allParts: Maybe<Money>[] = [goodsBatch, ...componentAmounts];
  const unknownReasons = collectUnknownReasons(allParts);
  const landedCostBatch: Maybe<Money> = unknownReasons.length > 0
    ? unknown(unknownReasons)
    : known(sumMoney(allParts.map((p) => expectKnown(p)), ccy));

  const landedCostPerUnit: Maybe<Money> = isKnown(landedCostBatch) && qty > 0
    ? known(divideMoney(landedCostBatch.value, qty))
    : isKnown(landedCostBatch) ? unknown('Batch quantity invalid.') : landedCostBatch;

  trace.push(traceLine('landedBatch', 'Landed cost, batch total', landedCostBatch));
  trace.push(traceLine('landedUnit', 'Landed cost per unit', landedCostPerUnit));

  /* --- recoverable import tax (cash only) -------------------------------- */
  const recoverableBase = combineRecoverableBase(goodsBatch, dutyAmount, ccy);
  let recoverable: Maybe<Money>;
  if (!isKnown(input.recoverableImportTax.rate)) {
    recoverable = unknown(input.recoverableImportTax.rate.reasons);
  } else if (!isKnown(recoverableBase)) {
    recoverable = unknown(recoverableBase.reasons);
  } else {
    recoverable = known(rateOfMoney(recoverableBase.value, input.recoverableImportTax.rate.value));
  }
  trace.push(traceLine('recoverableTax', 'Recoverable import tax (cash outlay, not cost)', recoverable,
    input.recoverableImportTax.eligibilityConfirmed
      ? 'Eligibility confirmed by owner.'
      : 'Eligibility NOT confirmed: treated as an unrecovered cash outlay.'));

  if (!input.recoverableImportTax.eligibilityConfirmed && isKnown(recoverable) && recoverable.value.minor !== 0) {
    diagnostics.push({
      code: 'RECOVERABLE_TAX_UNCONFIRMED', severity: 'warning',
      message: 'Import tax recoverability has not been confirmed. It is excluded from economic cost but shown as cash tied up, and must not be assumed refundable.',
    });
  }

  return {
    batchQuantity: qty,
    reportingCurrency: ccy,
    goodsCostBatch: goodsBatch,
    dutyAmount,
    landedCostBatch,
    landedCostPerUnit,
    recoverableImportTaxBatch: recoverable,
    recoverableTreatedAsRecoverable: input.recoverableImportTax.eligibilityConfirmed,
    diagnostics,
    trace,
    label: weakestLabel(labels),
  };
}

function resolveDutyBase(
  input: LandedCostInput, goodsBatch: Maybe<Money>, ccy: CurrencyCode,
): Maybe<Money> {
  switch (input.duty.basis.kind) {
    case 'GOODS_ONLY':
      return goodsBatch;
    case 'GOODS_PLUS_FREIGHT_TO_BORDER': {
      const freight = input.components.internationalFreight
        ?? (sellerBears(input.incoterm, 'internationalFreight')
          ? known(zero(ccy))
          : unknown('International freight not supplied; required for this duty basis.'));
      if (!isKnown(goodsBatch) || !isKnown(freight)) {
        return unknown(collectUnknownReasons([goodsBatch, freight]));
      }
      return known(addMoney(goodsBatch.value, freight.value));
    }
    case 'DECLARED_VALUE_FOR_DUTY':
      return known(input.duty.basis.amount);
    case 'NOT_DETERMINED':
      return unknown(`Value for duty not determined: ${input.duty.basis.note}`);
  }
}

function combineRecoverableBase(
  goods: Maybe<Money>, duty: Maybe<Money>, ccy: CurrencyCode,
): Maybe<Money> {
  if (!isKnown(goods) || !isKnown(duty)) return unknown(collectUnknownReasons([goods, duty]));
  return known(sumMoney([goods.value, duty.value], ccy));
}

/* -------------------------------------------------------------------------- */
/* Contribution per order                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a percentage fee is assessed. Payment processors normally charge on the
 * full amount the customer is billed, tax included; marketplace commissions
 * more often apply to the item subtotal. Getting this wrong is a silent 1-2%
 * error on every order, so the base is an explicit input.
 */
export type FeeBase = 'GROSS_INCLUDING_TAX' | 'NET_EXCLUDING_TAX';

export interface ReturnsInput {
  /** Fraction of orders returned, decimal string, e.g. "0.06". */
  readonly returnRate: Maybe<string>;
  /** Fraction of units defective and written off with no revenue. */
  readonly defectRate: Maybe<string>;
  /** Fraction of landed goods value NOT recoverable when a unit comes back. */
  readonly unrecoverableGoodsFractionOnReturn: Maybe<string>;
  /** Inbound shipping, inspection and restocking cost per returned order. */
  readonly returnHandlingCostPerOrder: Maybe<Money>;
}

export interface ContributionInput {
  readonly currency: CurrencyCode;
  readonly unitsPerOrder: number;
  /** Price per unit excluding sales tax, before discount. */
  readonly listPricePerUnitExclTax: Money;
  readonly discountPerOrder: Maybe<Money>;
  /** Shipping revenue billed to the customer, excluding tax. */
  readonly shippingChargedToCustomerExclTax: Maybe<Money>;
  /** Sales tax collected on the owner's behalf. Pass-through, never revenue. */
  readonly collectedSalesTaxPerOrder: Maybe<Money>;
  readonly landedCostPerUnit: Maybe<Money>;
  /** Pick, pack, packaging materials and labour per order. */
  readonly fulfillmentCostPerOrder: Maybe<Money>;
  readonly outboundShippingCostPerOrder: Maybe<Money>;
  readonly channelFeeRate: Maybe<string>;
  readonly channelFeeBase: FeeBase;
  readonly paymentFeeRate: Maybe<string>;
  readonly paymentFeeBase: FeeBase;
  readonly paymentFeeFixedPerOrder: Maybe<Money>;
  readonly returns: ReturnsInput;
  /** Customer acquisition cost attributed to this order. */
  readonly acquisitionCostPerOrder: Maybe<Money>;
  readonly label: ProvenanceLabel;
}

export interface ContributionResult {
  readonly currency: CurrencyCode;
  readonly unitsPerOrder: number;
  readonly netRevenueExclTaxPerOrder: Maybe<Money>;
  readonly grossChargedToCustomerPerOrder: Maybe<Money>;
  readonly landedCogsPerOrder: Maybe<Money>;
  readonly contributionPerOrder: Maybe<Money>;
  readonly contributionPerUnit: Maybe<Money>;
  readonly diagnostics: readonly FinanceDiagnostic[];
  readonly trace: readonly TraceLine[];
  readonly label: ProvenanceLabel;
}

/** Apply `rate` to an amount, or return unknown when the rate is unknown. */
function applyMaybeRate(amount: Maybe<Money>, rate: Maybe<string>): Maybe<Money> {
  if (!isKnown(amount) || !isKnown(rate)) {
    return unknown(collectUnknownReasons([amount, rate]));
  }
  return known(rateOfMoney(amount.value, rate.value));
}

/** Apply (1 - rate); used for the recoverable share of returned goods. */
function applyMaybeComplementRate(amount: Maybe<Money>, rate: Maybe<string>): Maybe<Money> {
  if (!isKnown(amount) || !isKnown(rate)) {
    return unknown(collectUnknownReasons([amount, rate]));
  }
  const full = amount.value;
  const taken = rateOfMoney(full, rate.value);
  return known(subMoney(full, taken));
}

/** Multiply two rates, e.g. returnRate x recoverableFraction. */
function productOfMaybeRates(a: Maybe<Money>, r1: Maybe<string>, r2: Maybe<string>): Maybe<Money> {
  const first = applyMaybeRate(a, r1);
  return applyMaybeRate(first, r2);
}

export function computeContribution(input: ContributionInput): ContributionResult {
  const ccy = input.currency.toUpperCase();
  const diagnostics: FinanceDiagnostic[] = [];
  const trace: TraceLine[] = [];

  if (!Number.isInteger(input.unitsPerOrder) || input.unitsPerOrder <= 0) {
    diagnostics.push({
      code: 'UNITS_PER_ORDER_INVALID', severity: 'blocker',
      message: `Units per order must be a positive integer; received ${input.unitsPerOrder}.`,
    });
  }
  const units = input.unitsPerOrder;

  /* --- revenue ------------------------------------------------------------ */
  const itemSubtotal: Maybe<Money> = units > 0
    ? known(multiplyMoney(input.listPricePerUnitExclTax, units))
    : unknown('Units per order invalid.');
  trace.push(traceLine('itemSubtotal', `Item subtotal (${units} x list, excl tax)`, itemSubtotal));
  trace.push(traceLine('discount', 'Discount', input.discountPerOrder));
  trace.push(traceLine('shipRevenue', 'Shipping billed to customer (excl tax)',
    input.shippingChargedToCustomerExclTax));

  const netRevenue: Maybe<Money> = (() => {
    const parts = [itemSubtotal, input.discountPerOrder, input.shippingChargedToCustomerExclTax];
    const reasons = collectUnknownReasons(parts);
    if (reasons.length > 0) return unknown(reasons);
    const sub = expectKnown(itemSubtotal);
    const disc = expectKnown(input.discountPerOrder);
    const ship = expectKnown(input.shippingChargedToCustomerExclTax);
    return known(addMoney(subMoney(sub, disc), ship));
  })();
  trace.push(traceLine('netRevenue', 'Net revenue excluding sales tax', netRevenue,
    'Collected sales tax is a pass-through and is never counted as revenue.'));

  const grossCharged: Maybe<Money> = (() => {
    const parts = [netRevenue, input.collectedSalesTaxPerOrder];
    const reasons = collectUnknownReasons(parts);
    if (reasons.length > 0) return unknown(reasons);
    return known(addMoney(
      expectKnown(netRevenue),
      expectKnown(input.collectedSalesTaxPerOrder),
    ));
  })();
  trace.push(traceLine('grossCharged', 'Total charged to customer (incl tax)', grossCharged));

  /* --- cost of goods ----------------------------------------------------- */
  const landedCogs: Maybe<Money> = isKnown(input.landedCostPerUnit) && units > 0
    ? known(multiplyMoney(input.landedCostPerUnit.value, units))
    : isKnown(input.landedCostPerUnit)
      ? unknown('Units per order invalid.')
      : input.landedCostPerUnit;
  trace.push(traceLine('landedCogs', 'Landed cost of goods sold, per order', landedCogs));

  /* --- returns and defects ------------------------------------------------ */
  const refundedRevenue = applyMaybeRate(netRevenue, input.returns.returnRate);
  trace.push(traceLine('refundedRevenue', 'Expected refunded revenue', refundedRevenue,
    'Revenue reversed on returned orders.'));

  const recoveredGoods = productOfMaybeRates(
    landedCogs, input.returns.returnRate,
    isKnown(input.returns.unrecoverableGoodsFractionOnReturn)
      ? known(complementDecimal(input.returns.unrecoverableGoodsFractionOnReturn.value))
      : input.returns.unrecoverableGoodsFractionOnReturn,
  );
  trace.push(traceLine('recoveredGoods', 'Goods value recovered from returns (credit)', recoveredGoods));

  const defectWriteOff = applyMaybeRate(landedCogs, input.returns.defectRate);
  trace.push(traceLine('defectWriteOff', 'Defective units written off', defectWriteOff));

  const returnHandling = applyMaybeRate(
    input.returns.returnHandlingCostPerOrder, input.returns.returnRate,
  );
  trace.push(traceLine('returnHandling', 'Expected return handling cost', returnHandling));

  /* --- fees --------------------------------------------------------------- */
  const channelBase = input.channelFeeBase === 'GROSS_INCLUDING_TAX' ? grossCharged : netRevenue;
  const channelFee = applyMaybeRate(channelBase, input.channelFeeRate);
  trace.push(traceLine('channelFee', `Channel fee (on ${input.channelFeeBase})`, channelFee));

  const paymentBase = input.paymentFeeBase === 'GROSS_INCLUDING_TAX' ? grossCharged : netRevenue;
  const paymentVariable = applyMaybeRate(paymentBase, input.paymentFeeRate);
  const paymentFee: Maybe<Money> = (() => {
    const parts = [paymentVariable, input.paymentFeeFixedPerOrder];
    const reasons = collectUnknownReasons(parts);
    if (reasons.length > 0) return unknown(reasons);
    return known(addMoney(
      expectKnown(paymentVariable),
      expectKnown(input.paymentFeeFixedPerOrder),
    ));
  })();
  trace.push(traceLine('paymentFee', `Payment fee (on ${input.paymentFeeBase} plus fixed)`, paymentFee));

  trace.push(traceLine('fulfillment', 'Fulfillment cost', input.fulfillmentCostPerOrder));
  trace.push(traceLine('outboundShipping', 'Outbound shipping cost', input.outboundShippingCostPerOrder));
  trace.push(traceLine('acquisition', 'Customer acquisition cost', input.acquisitionCostPerOrder));

  /* --- contribution ------------------------------------------------------- */
  const deductions: Maybe<Money>[] = [
    refundedRevenue, landedCogs, defectWriteOff, returnHandling,
    input.fulfillmentCostPerOrder, input.outboundShippingCostPerOrder,
    channelFee, paymentFee, input.acquisitionCostPerOrder,
  ];
  const credits: Maybe<Money>[] = [netRevenue, recoveredGoods];
  const allParts = [...credits, ...deductions];
  const reasons = collectUnknownReasons(allParts);

  const contributionPerOrder: Maybe<Money> = reasons.length > 0
    ? unknown(reasons)
    : known(subMoney(
        sumMoney(credits.map((c) => expectKnown(c)), ccy),
        sumMoney(deductions.map((d) => expectKnown(d)), ccy),
      ));

  trace.push(traceLine('contribution', 'Contribution per order', contributionPerOrder,
    'Contribution only. Fixed overhead and owner labour are excluded and reported separately; this is NOT net profit.'));

  if (reasons.length > 0) {
    diagnostics.push({
      code: 'CONTRIBUTION_INCOMPLETE', severity: 'blocker',
      message: `Contribution cannot be computed: ${reasons.length} input(s) unknown. Unknown inputs are never treated as zero.`,
    });
  } else if (isKnown(contributionPerOrder) && contributionPerOrder.value.minor < 0) {
    diagnostics.push({
      code: 'CONTRIBUTION_NEGATIVE', severity: 'blocker',
      message: `Contribution per order is ${formatMoney(contributionPerOrder.value)}. Every additional order loses money; break-even is undefined and volume makes this worse, not better.`,
    });
  } else if (isKnown(contributionPerOrder) && contributionPerOrder.value.minor === 0) {
    diagnostics.push({
      code: 'CONTRIBUTION_ZERO', severity: 'blocker',
      message: 'Contribution per order is exactly zero. No volume recovers fixed cost.',
    });
  }

  const contributionPerUnit: Maybe<Money> = isKnown(contributionPerOrder) && units > 0
    ? known(divideMoney(contributionPerOrder.value, units))
    : isKnown(contributionPerOrder) ? unknown('Units per order invalid.') : contributionPerOrder;

  return {
    currency: ccy, unitsPerOrder: units,
    netRevenueExclTaxPerOrder: netRevenue,
    grossChargedToCustomerPerOrder: grossCharged,
    landedCogsPerOrder: landedCogs,
    contributionPerOrder, contributionPerUnit,
    diagnostics, trace, label: input.label,
  };
}

/**
 * Exact (1 - x) for a decimal string at rate scale, computed on scaled integers
 * so that e.g. 1 - 0.15 is exactly 0.85 rather than 0.8500000000000001.
 */
function complementDecimal(decimal: string): string {
  const scaled = parseRate(decimal);
  if (scaled < 0 || scaled > RATE_ONE) {
    throw new RangeError(`Fraction must lie in [0, 1]; received ${decimal}`);
  }
  return formatScaled(RATE_ONE - scaled, 8);
}

/* -------------------------------------------------------------------------- */
/* Break-even                                                                 */
/* -------------------------------------------------------------------------- */

export interface FixedCostInput {
  readonly currency: CurrencyCode;
  /** Rent, software, insurance, accounting — recurring and volume-independent. */
  readonly overheadPerMonth: Maybe<Money>;
  /**
   * Owner labour, costed separately and never folded into contribution. A
   * business that only clears fixed cost by paying its owner nothing has not
   * broken even; it has hidden a wage.
   */
  readonly ownerLabourPerMonth: Maybe<Money>;
  readonly includeOwnerLabourInBreakEven: boolean;
}

export interface BreakEvenResult {
  readonly computed: boolean;
  readonly reason?: string;
  readonly fixedCostBasePerMonth: Maybe<Money>;
  readonly breakEvenOrdersPerMonth: Maybe<number>;
  readonly breakEvenUnitsPerMonth: Maybe<number>;
  readonly diagnostics: readonly FinanceDiagnostic[];
}

export function computeBreakEven(
  contribution: ContributionResult, fixed: FixedCostInput,
): BreakEvenResult {
  const diagnostics: FinanceDiagnostic[] = [];

  const base: Maybe<Money> = (() => {
    const parts = fixed.includeOwnerLabourInBreakEven
      ? [fixed.overheadPerMonth, fixed.ownerLabourPerMonth]
      : [fixed.overheadPerMonth];
    const reasons = collectUnknownReasons(parts);
    if (reasons.length > 0) return unknown(reasons);
    return known(sumMoney(
      parts.map((p) => expectKnown(p)),
      fixed.currency.toUpperCase(),
    ));
  })();

  if (!fixed.includeOwnerLabourInBreakEven) {
    diagnostics.push({
      code: 'OWNER_LABOUR_EXCLUDED', severity: 'note',
      message: 'Break-even excludes owner labour. The figure is the point at which cash overhead is covered, not the point at which the owner is paid.',
    });
  }

  if (!isKnown(contribution.contributionPerOrder)) {
    return {
      computed: false,
      reason: 'Contribution per order is unknown, so break-even is undefined.',
      fixedCostBasePerMonth: base,
      breakEvenOrdersPerMonth: unknown('Contribution unknown.'),
      breakEvenUnitsPerMonth: unknown('Contribution unknown.'),
      diagnostics,
    };
  }

  const c = contribution.contributionPerOrder.value;
  if (!isPositive(c)) {
    diagnostics.push({
      code: 'BREAK_EVEN_UNDEFINED', severity: 'blocker',
      message: `Contribution per order is ${formatMoney(c)}. Break-even units are not computed for non-positive contribution because no volume reaches profitability.`,
    });
    return {
      computed: false,
      reason: `Contribution per order is ${formatMoney(c)} (not positive).`,
      fixedCostBasePerMonth: base,
      breakEvenOrdersPerMonth: unknown('Contribution is not positive.'),
      breakEvenUnitsPerMonth: unknown('Contribution is not positive.'),
      diagnostics,
    };
  }

  if (!isKnown(base)) {
    return {
      computed: false,
      reason: 'Fixed cost base is unknown.',
      fixedCostBasePerMonth: base,
      breakEvenOrdersPerMonth: unknown(base.reasons),
      breakEvenUnitsPerMonth: unknown(base.reasons),
      diagnostics,
    };
  }

  if (base.value.currency !== c.currency) {
    throw new Error(
      `Break-even currency mismatch: fixed cost in ${base.value.currency}, contribution in ${c.currency}.`,
    );
  }

  // Ceiling division: a partial order does not cover fixed cost.
  const orders = Math.ceil(base.value.minor / c.minor);
  const units = orders * contribution.unitsPerOrder;

  return {
    computed: true,
    fixedCostBasePerMonth: base,
    breakEvenOrdersPerMonth: known(orders),
    breakEvenUnitsPerMonth: known(units),
    diagnostics,
  };
}

/* -------------------------------------------------------------------------- */
/* Cash exposure and timing                                                   */
/* -------------------------------------------------------------------------- */

export interface CashExposureInput {
  readonly currency: CurrencyCode;
  readonly supplierDepositPaid: Maybe<Money>;
  readonly supplierBalanceCommitted: Maybe<Money>;
  readonly inventoryAtLandedCost: Maybe<Money>;
  /** Import tax paid out and awaiting recovery, if recoverable at all. */
  readonly recoverableTaxOutstanding: Maybe<Money>;
  /** Card/marketplace settlement float: daily net revenue x days held. */
  readonly settlementHeldByProcessor: Maybe<Money>;
  readonly refundReserve: Maybe<Money>;
  /**
   * Owner-configured ceiling on cash at risk. Unset means unset: the engine
   * reports that no limit was configured rather than inventing a budget.
   */
  readonly ownerConfiguredExposureCap: Maybe<Money>;
}

export interface CashExposureResult {
  readonly totalCashAtRisk: Maybe<Money>;
  readonly capBreached: boolean | 'unknown';
  readonly headroom: Maybe<Money>;
  readonly diagnostics: readonly FinanceDiagnostic[];
  readonly trace: readonly TraceLine[];
}

export function computeCashExposure(input: CashExposureInput): CashExposureResult {
  const ccy = input.currency.toUpperCase();
  const diagnostics: FinanceDiagnostic[] = [];
  const parts: readonly [string, string, Maybe<Money>][] = [
    ['deposit', 'Supplier deposit paid', input.supplierDepositPaid],
    ['balance', 'Supplier balance committed', input.supplierBalanceCommitted],
    ['inventory', 'Inventory at landed cost', input.inventoryAtLandedCost],
    ['recoverableTax', 'Import tax awaiting recovery', input.recoverableTaxOutstanding],
    ['settlement', 'Held by payment processor', input.settlementHeldByProcessor],
    ['refundReserve', 'Refund reserve', input.refundReserve],
  ];
  const trace = parts.map(([k, l, a]) => traceLine(k, l, a));
  const amounts = parts.map(([, , a]) => a);
  const reasons = collectUnknownReasons(amounts);

  const total: Maybe<Money> = reasons.length > 0
    ? unknown(reasons)
    : known(sumMoney(amounts.map((a) => expectKnown(a)), ccy));
  trace.push(traceLine('total', 'Total cash at risk', total));

  if (reasons.length > 0) {
    diagnostics.push({
      code: 'CASH_EXPOSURE_INCOMPLETE', severity: 'warning',
      message: `Cash at risk is incomplete: ${reasons.length} component(s) unknown. The true figure is at least the sum of the known components.`,
    });
  }

  let capBreached: boolean | 'unknown' = 'unknown';
  let headroom: Maybe<Money> = unknown('Exposure cap or total unknown.');

  if (!isKnown(input.ownerConfiguredExposureCap)) {
    diagnostics.push({
      code: 'EXPOSURE_CAP_UNSET', severity: 'warning',
      message: 'No owner-configured cash exposure cap. The application does not assume a budget; set one before approving a purchase.',
    });
  } else if (isKnown(total)) {
    const cap = input.ownerConfiguredExposureCap.value;
    headroom = known(subMoney(cap, total.value));
    capBreached = total.value.minor > cap.minor;
    if (capBreached) {
      diagnostics.push({
        code: 'EXPOSURE_CAP_BREACHED', severity: 'blocker',
        message: `Cash at risk ${formatMoney(total.value)} exceeds the owner-configured cap of ${formatMoney(cap)}.`,
      });
    }
    trace.push(traceLine('cap', 'Owner-configured exposure cap', known(cap)));
    trace.push(traceLine('headroom', 'Headroom under cap', headroom));
  }

  return { totalCashAtRisk: total, capBreached, headroom, diagnostics, trace };
}

/* -------------------------------------------------------------------------- */
/* Unsold stock and seasonal cutoffs                                          */
/* -------------------------------------------------------------------------- */

export interface SellThroughInput {
  readonly currency: CurrencyCode;
  readonly batchQuantity: number;
  readonly landedCostPerUnit: Maybe<Money>;
  /** Fraction of the batch expected to sell at full price, e.g. "0.70". */
  readonly sellThroughRate: Maybe<string>;
  /** Recoverable value per unsold unit at markdown, e.g. salvage or clearance. */
  readonly salvageValuePerUnit: Maybe<Money>;
}

export interface SellThroughResult {
  readonly unsoldUnits: Maybe<number>;
  readonly markdownWriteOff: Maybe<Money>;
  readonly diagnostics: readonly FinanceDiagnostic[];
}

export function computeSellThrough(input: SellThroughInput): SellThroughResult {
  const diagnostics: FinanceDiagnostic[] = [];
  if (!isKnown(input.sellThroughRate)) {
    return {
      unsoldUnits: unknown(input.sellThroughRate.reasons),
      markdownWriteOff: unknown(input.sellThroughRate.reasons),
      diagnostics: [{
        code: 'SELL_THROUGH_UNKNOWN', severity: 'warning',
        message: 'Sell-through rate is unknown, so dead-stock exposure cannot be quantified. It is not assumed to be 100%.',
      }],
    };
  }
  const sold = Math.floor(
    (parseRate(input.sellThroughRate.value) * input.batchQuantity) / RATE_ONE,
  );
  const unsold = Math.max(0, input.batchQuantity - sold);

  if (!isKnown(input.landedCostPerUnit) || !isKnown(input.salvageValuePerUnit)) {
    return {
      unsoldUnits: known(unsold),
      markdownWriteOff: unknown(
        collectUnknownReasons([input.landedCostPerUnit, input.salvageValuePerUnit]),
      ),
      diagnostics,
    };
  }
  const lossPerUnit = subMoney(input.landedCostPerUnit.value, input.salvageValuePerUnit.value);
  const writeOff = multiplyMoney(lossPerUnit, unsold);
  if (writeOff.minor > 0) {
    diagnostics.push({
      code: 'DEAD_STOCK_EXPOSURE', severity: 'warning',
      message: `${unsold} of ${input.batchQuantity} units are expected to remain unsold, a write-down of ${formatMoney(writeOff)}.`,
    });
  }
  return { unsoldUnits: known(unsold), markdownWriteOff: known(writeOff), diagnostics };
}

export interface DeliveryWindowInput {
  /** e.g. "Diwali 2026 retail window" — a demand deadline, not a shipping ETA. */
  readonly occasionName: string;
  /** ISO date by which stock must be sellable to serve the occasion. */
  readonly mustBeSellableBy: string;
  /** ISO date stock is estimated to be sellable. Estimated, not promised. */
  readonly estimatedSellableFrom: Maybe<string>;
}

export interface DeliveryWindowResult {
  readonly missesWindow: boolean | 'unknown';
  readonly daysOfMargin: Maybe<number>;
  readonly diagnostics: readonly FinanceDiagnostic[];
}

export function assessDeliveryWindow(input: DeliveryWindowInput): DeliveryWindowResult {
  if (!isKnown(input.estimatedSellableFrom)) {
    return {
      missesWindow: 'unknown',
      daysOfMargin: unknown(input.estimatedSellableFrom.reasons),
      diagnostics: [{
        code: 'DELIVERY_ESTIMATE_UNKNOWN', severity: 'warning',
        message: `No estimated sellable date for ${input.occasionName}; the window cannot be assessed.`,
      }],
    };
  }
  const deadline = Date.parse(`${input.mustBeSellableBy}T00:00:00Z`);
  const arrival = Date.parse(`${input.estimatedSellableFrom.value}T00:00:00Z`);
  if (Number.isNaN(deadline) || Number.isNaN(arrival)) {
    throw new RangeError('Dates must be ISO yyyy-mm-dd.');
  }
  const days = Math.round((deadline - arrival) / 86_400_000);
  const misses = days < 0;
  const diagnostics: FinanceDiagnostic[] = [];
  if (misses) {
    diagnostics.push({
      code: 'DELIVERY_WINDOW_MISSED', severity: 'blocker',
      message: `Stock is estimated sellable ${Math.abs(days)} day(s) AFTER the ${input.occasionName} deadline of ${input.mustBeSellableBy}. Occasion-driven demand does not wait.`,
    });
  } else if (days < 14) {
    diagnostics.push({
      code: 'DELIVERY_WINDOW_TIGHT', severity: 'warning',
      message: `Only ${days} day(s) of margin before the ${input.occasionName} deadline. Freight and customs variance routinely exceed this.`,
    });
  }
  return { missesWindow: misses, daysOfMargin: known(days), diagnostics };
}
