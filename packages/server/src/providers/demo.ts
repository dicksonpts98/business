import { createHash } from 'node:crypto';
import type { ProviderStatus } from '@sqhq/shared';
import type { ModelProvider, ModelRequest, ModelResponse } from './types.js';

/**
 * Deterministic seeded executor.
 *
 * No network, no randomness: output is a pure function of (purpose, seed). The
 * same demo project therefore replays identically, which is what makes the
 * seeded company session a fixture rather than a slideshow.
 *
 * Everything it returns is labelled SYNTHETIC_DEMO upstream. The canned
 * findings below are deliberately MIXED — some support the hypothesis, some
 * undercut it — because a demo where every agent agrees teaches the owner to
 * trust agreement.
 */
export class DemoProvider implements ModelProvider {
  readonly name = 'demo';

  status(): ProviderStatus {
    return {
      state: 'demo',
      seedNote: 'Deterministic seeded executor. Output is a pure function of purpose and seed.',
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const bank = RESPONSE_BANK[request.purpose] ?? RESPONSE_BANK['default']!;
    const digest = createHash('sha256')
      .update(`${request.purpose}:${request.seed}`, 'utf8')
      .digest();
    const index = digest.readUInt32BE(0) % bank.length;
    const text = bank[index]!;
    return {
      text,
      model: 'demo-deterministic-v1',
      usage: null,
      costUsd: '0.000000',
      measured: false,
    };
  }
}

/**
 * Canned deliverables, one bank per task purpose. Written as JSON so the
 * structured-output parser exercises the same path it would in live mode.
 */
const RESPONSE_BANK: Record<string, readonly string[]> = {
  'research.demand': [
    JSON.stringify({
      summary: 'Three public discussions describe embroidery snagging in generic garment bags; none quantifies willingness to pay.',
      findings: [
        { claim: 'Buyers report zari and sequin work catching on unlined garment bags during travel.', strength: 'suggestive', supports: true },
        { claim: 'No observed instance of anyone stating a price they would pay for a purpose-built system.', strength: 'gap', supports: false },
      ],
      counterEvidence: ['Several commenters say a cotton bedsheet wrap already solves this for free.'],
      recommendation: 'continue_research',
      nextCheapestExperiment: 'Ask three Calgary boutiques what they currently hand customers for transport, and what it costs them.',
    }),
    JSON.stringify({
      summary: 'Demand signal is thin and indirect. Most complaints are about storage humidity, not transport damage.',
      findings: [
        { claim: 'Humidity and yellowing dominate the complaints found, not mechanical damage.', strength: 'suggestive', supports: false },
      ],
      counterEvidence: ['The stated problem may be the wrong problem: storage, not travel.'],
      recommendation: 'reframe_problem',
      nextCheapestExperiment: 'Re-run discovery against storage-and-preservation phrasing before sourcing anything.',
    }),
  ],
  'research.competition': [
    JSON.stringify({
      summary: 'Marketplace supply is dense at the low end and thin above CAD 60 delivered.',
      substitutes: [
        { name: 'Generic non-woven garment bag', deliveredPriceBand: 'CAD 12-25', availability: 'immediate' },
        { name: 'Etsy saree cover sets', deliveredPriceBand: 'CAD 30-55', availability: '1-3 weeks, often US shipped' },
      ],
      scarcityClaimTest: 'The "nothing exists for this" framing does not survive a marketplace search; what is thin is the premium, locally-stocked tier.',
      recommendation: 'differentiate_on_local_stock_and_fit',
    }),
  ],
  'sourcing.leads': [
    JSON.stringify({
      summary: 'Four supplier listings match the specification category. All are listings, not verified capabilities.',
      leads: [
        { supplier: 'DEMO Baixiang-style bag works', kind: 'factory', moqClaim: 500, unitPriceClaim: 'CNY 38-46', verified: false },
        { supplier: 'DEMO Yiwu trading co', kind: 'trader', moqClaim: 100, unitPriceClaim: 'CNY 44-52', verified: false },
      ],
      caution: 'MOQ and price are listing claims. Neither is a quote, and neither evidences quality or on-time delivery.',
    }),
  ],
  'finance.model': [
    JSON.stringify({
      summary: 'Inputs assembled for the deterministic engine. No arithmetic performed here.',
      assumptionsRequiringOwnerConfirmation: [
        'Duty rate depends on a tariff classification that is not confirmed.',
        'Outbound parcel cost within Alberta is not yet quoted.',
      ],
    }),
  ],
  'challenge.review': [
    JSON.stringify({
      summary: 'The demand case rests on two suggestive observations and one gap. That is not enough to buy inventory.',
      dissent: 'I disagree with proceeding to a 200-unit order. The cheapest test that would change my mind is a boutique conversation, not a purchase.',
      wouldChangeMyMind: [
        'Two boutiques stating what they currently pay for transport packaging.',
        'One customer stating a price unprompted.',
      ],
      recommendation: 'do_not_launch_yet',
    }),
  ],
  default: [
    JSON.stringify({
      summary: 'Deterministic demo output. No real research was performed for this task.',
      recommendation: 'continue_research',
    }),
  ],
};
