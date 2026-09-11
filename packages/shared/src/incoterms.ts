/**
 * Incoterm responsibility mapping.
 *
 * Purpose: prevent the single most common landed-cost error, which is adding a
 * cost the supplier's quoted price already includes. A CIF quote that then has
 * ocean freight and marine insurance added again overstates landed cost and can
 * kill a viable product on paper. The engine flags this rather than guessing.
 *
 * This mapping reflects the customary allocation of cost under Incoterms 2020.
 * It is a modelling aid for cost arithmetic, not a contractual interpretation:
 * the governing document is the actual contract with the supplier.
 */
export const LANDED_COMPONENTS = [
  'originInlandTransport',
  'exportClearance',
  'internationalFreight',
  'insurance',
  'importDuty',
  'brokerage',
  'destinationInboundFreight',
] as const;

export type LandedComponent = (typeof LANDED_COMPONENTS)[number];

export const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'] as const;
export type Incoterm = (typeof INCOTERMS)[number];

export const COMPONENT_LABEL: Record<LandedComponent, string> = {
  originInlandTransport: 'Origin inland transport',
  exportClearance: 'Export clearance and origin charges',
  internationalFreight: 'International freight',
  insurance: 'Cargo insurance',
  importDuty: 'Import duty',
  brokerage: 'Customs brokerage and import clearance',
  destinationInboundFreight: 'Canadian inbound freight',
};

/**
 * Components the SELLER customarily bears under each term, and which therefore
 * must not also be charged to the buyer's landed-cost worksheet.
 */
const SELLER_BEARS: Record<Incoterm, readonly LandedComponent[]> = {
  EXW: [],
  FCA: ['originInlandTransport', 'exportClearance'],
  FOB: ['originInlandTransport', 'exportClearance'],
  CFR: ['originInlandTransport', 'exportClearance', 'internationalFreight'],
  CIF: ['originInlandTransport', 'exportClearance', 'internationalFreight', 'insurance'],
  DAP: [
    'originInlandTransport', 'exportClearance', 'internationalFreight', 'insurance',
    'destinationInboundFreight',
  ],
  DDP: [
    'originInlandTransport', 'exportClearance', 'internationalFreight', 'insurance',
    'importDuty', 'brokerage', 'destinationInboundFreight',
  ],
};

export function sellerBears(incoterm: Incoterm, component: LandedComponent): boolean {
  return SELLER_BEARS[incoterm].includes(component);
}

export function buyerBears(incoterm: Incoterm, component: LandedComponent): boolean {
  return !sellerBears(incoterm, component);
}

export function sellerBorneComponents(incoterm: Incoterm): readonly LandedComponent[] {
  return SELLER_BEARS[incoterm];
}
