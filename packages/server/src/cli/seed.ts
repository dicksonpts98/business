/**
 * Seed a complete synthetic company session.
 *
 * Two honesty rules govern this file:
 *
 *  1. Every fabricated supplier, quote, inspection result and figure is named
 *     with a DEMO prefix and labelled SYNTHETIC_DEMO. It must be impossible to
 *     mistake seeded data for research.
 *
 *  2. The real URLs supplied by the owner are recorded as SEPARATE evidence
 *     records, and they are labelled UNVERIFIED_LEAD rather than
 *     SOURCE_BACKED_OBSERVATION. The seed has not fetched them, so claiming an
 *     observation would be exactly the fabrication the application forbids.
 *     A record is only upgraded when an agent actually retrieves the page and
 *     stores a genuine excerpt with a fetch timestamp.
 */
import {
  ROLE_TEMPLATES, type FxRate, type LandedCostInput, type ContributionInput,
  type FixedCostInput, parseMoney, runScenarioSet, auditScenarioSet, known, unknown,
} from '@sqhq/shared';
import { closePool, withTransaction } from '../db/pool.js';
import { appendEvent } from '../events/append.js';
import { hashApprovalPayload } from '../approvals/hash.js';

const cad = (s: string) => parseMoney(s, 'CAD');
const SEED_DATE = '2026-09-11';

await withTransaction(async (client) => {
  const existing = await client.query<{ id: string }>('SELECT id FROM workspace LIMIT 1');
  if (existing.rows.length > 0) {
    console.log('A workspace already exists. Run `npm run reset` first to reseed from empty.');
    return;
  }

  /* ------------------------------------------------------------- workspace */
  const ws = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, reporting_currency, execution_mode)
     VALUES ('SupplyQuest HQ (demo company)', 'CAD', 'demo') RETURNING id`,
  );
  const workspaceId = ws.rows[0]!.id;
  await client.query('INSERT INTO workspace_event_seq (workspace_id, last_seq) VALUES ($1, 0)', [workspaceId]);

  const owner = await client.query<{ id: string }>(
    `INSERT INTO app_user (workspace_id, email, display_name, is_owner)
     VALUES ($1, 'owner@example.invalid', 'Owner', true) RETURNING id`,
    [workspaceId],
  );
  const ownerId = owner.rows[0]!.id;

  /* ------------------------------------------------- role templates mirror */
  for (const role of ROLE_TEMPLATES) {
    await client.query(
      `INSERT INTO agent_template (id, workspace_id, title, responsibilities, home_zone,
         visual, default_tools, reviews, authority_limits, is_builtin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [role.id, workspaceId, role.title, role.responsibilities, role.homeZone,
       JSON.stringify(role.visual), role.defaultTools, role.reviews, role.authorityLimits],
    );
  }

  /* ------------------------------------------------------------ agent staff */
  async function hireAgent(
    templateId: string, name: string, instructions: string,
    status: 'active' | 'paused' = 'active',
  ): Promise<string> {
    const role = ROLE_TEMPLATES.find((r) => r.id === templateId)!;
    const agent = await client.query<{ id: string }>(
      `INSERT INTO agent_instance (workspace_id, template_id, name, status, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [workspaceId, templateId, name, status, ownerId],
    );
    const agentId = agent.rows[0]!.id;
    const config = await client.query<{ id: string }>(
      `INSERT INTO agent_config_version (agent_id, version, instructions, appearance,
         allowed_tools, review_of_role_ids, created_by)
       VALUES ($1,1,$2,$3,$4,$5,$6) RETURNING id`,
      [agentId, instructions, JSON.stringify(role.visual), role.defaultTools, role.reviews, ownerId],
    );
    await client.query('UPDATE agent_instance SET current_config_version_id = $2 WHERE id = $1',
      [agentId, config.rows[0]!.id]);
    await appendEvent(client, {
      workspaceId, type: 'agent.created', actorKind: 'owner', actorId: ownerId,
      actorLabel: 'Owner', dataLabel: 'SYNTHETIC_DEMO',
      summary: `Hired ${name} as ${role.title}`,
      detail: { agentId, templateId, status },
    });
    return agentId;
  }

  const chief = await hireAgent('chief-of-staff', 'Ada Rao',
    'Translate the owner objective into the smallest sequence of tasks that could kill the idea cheaply. Prefer a cheap disconfirming test over a broad survey.');
  const discovery = await hireAgent('customer-discovery', 'Nilay Bose',
    'Find what people actually cannot get satisfactorily. Record counterevidence with the same diligence as supporting evidence. Never infer anyone\'s background from their name.');
  const analyst = await hireAgent('market-analyst', 'Wen Li',
    'Test every scarcity claim against what is actually purchasable in Canada today, at a delivered price including shipping and tax.');
  const productManager = await hireAgent('product-manager', 'Simran Kaur',
    'Write a specification precise enough that two suppliers would quote the same thing. State the rejection criterion before the evidence arrives.');
  const cultural = await hireAgent('cultural-reviewer', 'Meera Nair',
    'Flag anything that treats a diverse population as one market. Request validation from named people rather than asserting authenticity yourself.');
  const sourcing = await hireAgent('china-sourcing', 'Zhou Min',
    'Compare factories and traders on evidence, not listing copy. A listing MOQ is a claim, not a quote.');
  const procurement = await hireAgent('procurement', 'Dev Patel',
    'Prepare comparable quote requests so that quotes differ on price and terms, not on interpretation of the specification.');
  const finance = await hireAgent('finance-pricing', 'Grace Okoro',
    'Supply inputs to the deterministic finance engine. Never state a figure you did not get back from it. Leave unknowns unknown.');
  const logistics = await hireAgent('logistics', 'Tomas Berg',
    'Test whether stock can be sellable before the occasion that creates the demand. A missed festival window is a write-off, not a delay.');
  const challenger = await hireAgent('challenger', 'Ruth Adeyemi',
    'Argue against the project. Name the cheapest evidence that would change your mind. Record dissent even when overruled.');
  const compliance = await hireAgent('compliance-research', 'Sofia Ricci',
    'Research applicable rules and cite them. Never state that something is approved, permitted or legal; produce questions for a professional.');
  // An idle employee, deliberately seeded so the scene shows genuine idleness.
  const creative = await hireAgent('brand-director', 'Jonah Weiss',
    'Develop positioning only once there is a validated need. Do not produce packaging concepts for an unvalidated product.');
  // A paused employee, to show paused is distinct from idle.
  await hireAgent('growth-marketing', 'Priya Anand',
    'Propose channel tests with a pre-committed CAC threshold.', 'paused');

  /* ---------------------------------------------------------- project one */
  const p1 = await client.query<{ id: string }>(
    `INSERT INTO project (workspace_id, name, owner_objective, geography, status, data_label, created_by)
     VALUES ($1,$2,$3,$4,'active','OWNER_CONFIRMED_ACTUAL',$5) RETURNING id`,
    [
      workspaceId,
      'Premium formalwear storage-and-travel system (Calgary-first)',
      'Investigate whether a Calgary-first business can profitably sell a better storage-and-travel system for embellished Indian formalwear, with a B2B route through boutiques and wedding planners. Compare current Canadian alternatives and suppliers in China and India. Identify what customers actually cannot get satisfactorily, estimate landed economics using explicit assumptions, and prepare the smallest credible validation experiment. Do not buy inventory, contact anyone, or launch campaigns without a specific approved action.',
      ['Calgary', 'Edmonton'],
      ownerId,
    ],
  );
  const project1 = p1.rows[0]!.id;
  await appendEvent(client, {
    workspaceId, projectId: project1, type: 'project.created', actorKind: 'owner',
    actorId: ownerId, actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
    summary: 'Project created from the owner objective',
    detail: { geographyNote: 'Calgary and Edmonton are an untested hypothesis, not a validated market.' },
  });

  /* -------------------------------------------------- project two: rejected */
  const p2 = await client.query<{ id: string }>(
    `INSERT INTO project (workspace_id, name, owner_objective, geography, status, data_label, created_by)
     VALUES ($1,$2,$3,$4,'rejected','SYNTHETIC_DEMO',$5) RETURNING id`,
    [
      workspaceId,
      'Reusable apartment-friendly celebration decor kit',
      'Assess whether a compact, reusable decor kit for apartment celebrations can clear a positive contribution at a price Calgary buyers will pay.',
      ['Calgary'],
      ownerId,
    ],
  );
  const project2 = p2.rows[0]!.id;

  /* ------------------------------------------- the five seeded hypotheses */
  const HYPOTHESES: readonly {
    name: string; gap: string; chinaFit: string; reject: string; project: string | null;
    decision: 'investigating' | 'rejected';
  }[] = [
    {
      name: 'Premium lehenga/saree travel and storage system',
      gap: 'Dimensions, heavy embroidery protection, compartments, and what is actually stocked in Canada.',
      chinaFit: 'Customised sewn bags, inserts, zips, packaging — to be verified, not assumed.',
      reject: 'Existing organizers already solve the need at a lower delivered cost.',
      project: project1, decision: 'investigating',
    },
    {
      name: 'Bangle and bridal-jewellery travel organizer',
      gap: 'Secure fit, adjustable partitions, protection, and whether a coordinated garment bundle matters to buyers.',
      chinaFit: 'Moulded or sewn protective cases — unverified.',
      reject: 'Generic jewellery cases are sufficient; breakage or material issues in transit.',
      project: null, decision: 'investigating',
    },
    {
      name: 'Customised wedding favour packaging for planners',
      gap: 'Small batches, matching colours, names, and reliable Canadian deadlines.',
      chinaFit: 'Pouches, boxes, ribbons, print production — unverified.',
      reject: 'Customisation MOQ and freight destroy margin; Indian supply may simply be better.',
      project: null, decision: 'investigating',
    },
    {
      name: 'Reusable apartment-friendly celebration decor kit',
      gap: 'Compact storage, accurate instructions, installation, reliable delivery.',
      chinaFit: 'Artificial florals, fabric decor, non-electrical components — unverified. Note that "non-electrical" does not imply compliant or low-risk.',
      reject: 'Commodity competition, seasonal dead stock, poor material quality.',
      project: project2, decision: 'rejected',
    },
    {
      name: 'Boutique garment-presentation and packing bundles',
      gap: 'Whether specialty garment shops would place repeat B2B orders at all.',
      chinaFit: 'Hangers, garment bags, branded packaging — unverified.',
      reject: 'Customers prioritise minimum price and already have suppliers.',
      project: null, decision: 'investigating',
    },
  ];

  const opportunityIds: string[] = [];
  for (const h of HYPOTHESES) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO opportunity (workspace_id, project_id, name, hypothesis, gap_to_investigate,
         china_supply_fit, key_reason_to_reject, locations, decision, decision_rationale,
         cheapest_next_experiment, rejection_criterion, accountable_owner, data_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'UNVERIFIED_LEAD') RETURNING id`,
      [
        workspaceId, h.project, h.name,
        'UNVALIDATED HYPOTHESIS. Seeded as a starting point for research, not as a validated opportunity.',
        h.gap, h.chinaFit, h.reject, ['Calgary', 'Edmonton'], h.decision,
        h.decision === 'rejected'
          ? 'Rejected on economics: modelled contribution was negative at every price the competitor scan supports. See the cost scenarios attached to this opportunity.'
          : null,
        'Ask three Calgary boutiques what they currently hand customers for transport, and what that costs them.',
        h.reject, 'Owner',
      ],
    );
    opportunityIds.push(row.rows[0]!.id);
  }

  /* -------------------------------- real source seeds, honestly labelled */
  const REAL_SOURCES: readonly {
    claim: string; url: string; title: string; publisher: string; sourceType: string;
  }[] = [
    { claim: 'A Canadian puja retailer lists broad categories and states festival-shipping caveats.', url: 'https://pujahut.co/', title: 'Puja Hut', publisher: 'pujahut.co', sourceType: 'retailer_site' },
    { claim: 'A marketplace category exists for saree cover and organizer products, indicating existing competition.', url: 'https://www.etsy.com/ca/market/saree_cover_organizer', title: 'Etsy CA — saree cover organizer', publisher: 'Etsy', sourceType: 'marketplace_listing' },
    { claim: 'Canada-facing garment storage listings exist in the clothing and wardrobe storage category.', url: 'https://www.silkrute.ca/category/home-kitchen/home-storage-organisation/clothing-wardrobe-storage', title: 'SilkRute CA — clothing and wardrobe storage', publisher: 'SilkRute', sourceType: 'marketplace_listing' },
    { claim: 'Artificial marigold garland decoration products are already sold into Canada.', url: 'https://www.amazon.ca/marigold-garlands-decoration/s?k=marigold+garlands+decoration', title: 'Amazon.ca — marigold garlands decoration', publisher: 'Amazon.ca', sourceType: 'marketplace_listing' },
    { claim: 'Chinese supplier listings exist for dress and garment bags.', url: 'https://www.alibaba.com/countrysearch/CN/bag-for-dress.html', title: 'Alibaba country search — bag for dress (CN)', publisher: 'Alibaba', sourceType: 'supplier_listing' },
    { claim: 'A manufacturer self-describes heavy-duty wedding dress garment bag capability.', url: 'https://www.baixiangjubag.com/garment-bag/non-woven-garment-bag/heavy-duty-white-wedding-dress-garment-bag.html', title: 'Manufacturer product page — heavy duty wedding dress garment bag', publisher: 'baixiangjubag.com', sourceType: 'supplier_listing' },
    { claim: 'CBSA publishes requirements for commercial importing.', url: 'https://www.cbsa-asfc.gc.ca/import/menu-eng.html', title: 'CBSA — Importing commercial goods', publisher: 'Canada Border Services Agency', sourceType: 'government_publication' },
    { claim: 'CARM is the CBSA system for import accounting and registration.', url: 'https://www.canada.ca/en/border-services-agency/services/carm.html', title: 'CBSA Assessment and Revenue Management (CARM)', publisher: 'Canada Border Services Agency', sourceType: 'government_publication' },
    { claim: 'Health Canada publishes an industry guide to the Canada Consumer Product Safety Act.', url: 'https://www.canada.ca/en/health-canada/services/consumer-product-safety/reports-publications/industry-professionals/canada-consumer-product-safety-act-guide.html', title: 'Guide to the Canada Consumer Product Safety Act', publisher: 'Health Canada', sourceType: 'government_publication' },
    { claim: 'Health Canada publishes mandatory incident reporting guidance under section 14.', url: 'https://www.canada.ca/en/health-canada/services/consumer-product-safety/legislation-guidelines/acts-regulations/canada-consumer-product-safety-act/industry/guide-mandatory-reporting-section-14.html', title: 'Guide to mandatory reporting — section 14', publisher: 'Health Canada', sourceType: 'government_publication' },
    { claim: 'The Competition Bureau publishes a guide to the Consumer Packaging and Labelling Act.', url: 'https://competition-bureau.canada.ca/en/guide-consumer-packaging-and-labelling-act-and-regulations', title: 'Guide to the Consumer Packaging and Labelling Act', publisher: 'Competition Bureau Canada', sourceType: 'government_publication' },
    { claim: 'The Competition Bureau publishes textile labelling requirements.', url: 'https://competition-bureau.canada.ca/en/labelling/textile-labelling/textile-labelling-requirements', title: 'Textile labelling requirements', publisher: 'Competition Bureau Canada', sourceType: 'government_publication' },
  ];

  for (const s of REAL_SOURCES) {
    await client.query(
      `INSERT INTO evidence (workspace_id, project_id, claim, url, title, publisher,
         published_at, fetched_at, source_type, excerpt, geographic_relevance,
         confidence_rationale, data_label)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,'UNVERIFIED_LEAD')`,
      [
        workspaceId, project1, s.claim, s.url, s.title, s.publisher,
        `${SEED_DATE}T00:00:00Z`, s.sourceType,
        '[No excerpt: this URL was supplied by the owner as a starting point and has NOT been fetched by this application. An excerpt appears only once an agent retrieves the page.]',
        ['Canada'],
        `URL supplied by the owner and checked by them on ${SEED_DATE}. Labelled UNVERIFIED_LEAD, not an observation, because this application has not retrieved the content. These links establish that competition and sourcing routes exist; they do NOT establish an underserved market, supplier reliability, local stock, a firm landed quote, or any legal clearance.`,
      ],
    );
  }
  await appendEvent(client, {
    workspaceId, projectId: project1, type: 'evidence.recorded', actorKind: 'owner',
    actorId: ownerId, actorLabel: 'Owner', dataLabel: 'UNVERIFIED_LEAD',
    summary: `${REAL_SOURCES.length} owner-supplied starting URLs recorded as UNVERIFIED_LEAD (not fetched by this application).`,
    detail: { count: REAL_SOURCES.length, checkedOn: SEED_DATE },
  });

  /* -------------------------------------------- synthetic mixed findings */
  const MIXED: readonly { claim: string; supports: boolean; note: string }[] = [
    { claim: 'DEMO: two forum posts describe zari work snagging on unlined garment bags during air travel.', supports: true, note: 'Suggestive of a real failure mode. Says nothing about willingness to pay.' },
    { claim: 'DEMO: one commenter states a cotton bedsheet wrap has worked for fifteen years at no cost.', supports: false, note: 'A free substitute that already satisfies the need is the strongest disconfirming signal found.' },
    { claim: 'DEMO: a boutique owner mentions handing customers a plain garment bag with each sale.', supports: true, note: 'Indicates a B2B packaging spend already exists. The amount is unknown.' },
    { claim: 'DEMO: the most-cited complaint in the sampled discussions is humidity and yellowing in storage, not transport damage.', supports: false, note: 'Suggests the project may be aimed at the wrong problem.' },
  ];
  for (const m of MIXED) {
    await client.query(
      `INSERT INTO evidence (workspace_id, project_id, claim, url, title, publisher,
         fetched_at, source_type, excerpt, geographic_relevance, confidence_rationale, data_label)
       VALUES ($1,$2,$3,'https://demo.invalid/synthetic','DEMO synthetic finding','SupplyQuest demo seed',
               $4,'social_public',$5,$6,$7,'SYNTHETIC_DEMO')`,
      [workspaceId, project1, m.claim, `${SEED_DATE}T00:00:00Z`,
       '[SYNTHETIC DEMO CONTENT — no real source exists for this claim.]',
       ['Calgary', 'Edmonton'],
       `Fabricated for demonstration. ${m.note}`],
    );
  }

  /* ------------------------------------------------- synthetic suppliers */
  const supplierRows: { id: string; name: string }[] = [];
  for (const s of [
    { name: 'DEMO Hangzhou Garment Case Works', country: 'CN', kind: 'factory' as const, price: '42.00', moq: 500, lead: 38, incoterm: 'FOB' },
    { name: 'DEMO Yiwu Export Trading Co', country: 'CN', kind: 'trader' as const, price: '48.50', moq: 100, lead: 30, incoterm: 'FOB' },
    { name: 'DEMO Jaipur Textile Craft', country: 'IN', kind: 'factory' as const, price: '51.00', moq: 150, lead: 45, incoterm: 'EXW' },
    { name: 'DEMO Ontario Wholesale Packaging', country: 'CA', kind: 'wholesaler' as const, price: '19.40', moq: 24, lead: 5, incoterm: 'DAP' },
  ]) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO supplier (workspace_id, name, country, kind, source_url, contact_status, documents, data_label)
       VALUES ($1,$2,$3,$4,NULL,'not_contacted',$5,'SYNTHETIC_DEMO') RETURNING id`,
      [workspaceId, s.name, s.country, s.kind,
       JSON.stringify([{ type: 'claimed_certificate', verified: false, note: 'DEMO document. Issuer, scope, product match and validity have not been checked, so it is an unverified document rather than a certification.' }])],
    );
    const supplierId = row.rows[0]!.id;
    supplierRows.push({ id: supplierId, name: s.name });
    await client.query(
      `INSERT INTO quote (workspace_id, supplier_id, unit_price_minor, currency, moq,
         lead_time_days, incoterm, valid_until, figure_kind, data_label, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'quote','SYNTHETIC_DEMO',$9)`,
      [workspaceId, supplierId,
       parseMoney(s.price, s.country === 'CN' ? 'CNY' : s.country === 'IN' ? 'INR' : 'CAD').minor,
       s.country === 'CN' ? 'CNY' : s.country === 'IN' ? 'INR' : 'CAD',
       s.moq, s.lead, s.incoterm, '2026-12-31',
       'DEMO quote. Fabricated for demonstration; no supplier was contacted.'],
    );
  }

  /* ---------------------------- finance, computed by the real engine */
  const fx: FxRate = {
    from: 'CNY', to: 'CAD', rate: '0.19000000', asOf: SEED_DATE,
    source: 'DEMO seeded rate', label: 'SYNTHETIC_DEMO',
  };
  const landed: LandedCostInput = {
    reportingCurrency: 'CAD', incoterm: 'FOB', batchQuantity: 200,
    supplierUnitPrice: parseMoney('42.00', 'CNY'), fx,
    components: {
      internationalFreight: known(cad('620.00')), insurance: known(cad('45.00')),
      brokerage: known(cad('95.00')), destinationInboundFreight: known(cad('130.00')),
    },
    duty: {
      hsCode: unknown('Tariff classification not confirmed. Classification is a customs matter and is not guessed here.'),
      rate: known('0.18'),
      basis: { kind: 'GOODS_PLUS_FREIGHT_TO_BORDER' },
      label: 'SYNTHETIC_DEMO',
    },
    recoverableImportTax: {
      rate: known('0.05'), eligibilityConfirmed: false, label: 'SYNTHETIC_DEMO',
    },
    allocatedInspectionPackaging: known(cad('180.00')),
    label: 'SYNTHETIC_DEMO',
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
    label: 'SYNTHETIC_DEMO',
  };
  const fixed: FixedCostInput = {
    currency: 'CAD', overheadPerMonth: known(cad('1200.00')),
    ownerLabourPerMonth: known(cad('2000.00')), includeOwnerLabourInBreakEven: false,
  };
  const scenarioBase = {
    landed, contribution, fixed,
    sellThrough: {
      currency: 'CAD', sellThroughRate: known('0.70'), salvageValuePerUnit: known(cad('4.00')),
    },
  };
  const scenarios = runScenarioSet(scenarioBase, [
    { name: 'Base', kind: 'base', rationale: 'DEMO seeded quote, 6% returns, 0.19 CNY/CAD, 70% sell-through.', overrides: {} },
    {
      name: 'Freight and FX both move against us', kind: 'downside',
      rationale: 'Freight +60%, CNY strengthens to 0.22, returns double to 12%, CAC rises to 22.00, sell-through falls to 45%.',
      overrides: {
        internationalFreightMultiplier: '1.60', fxRate: '0.22000000',
        returnRate: '0.12', acquisitionCostPerOrder: cad('22.00'), sellThroughRate: '0.45',
      },
    },
    {
      name: 'Larger batch, returns settle low', kind: 'upside',
      rationale: 'A 400-unit batch spreads fixed freight; returns settle at 4% and sell-through reaches 90%.',
      overrides: { batchQuantity: 400, returnRate: '0.04', sellThroughRate: '0.90' },
    },
  ]);
  const scenarioAudit = auditScenarioSet(scenarios);

  for (const s of scenarios) {
    await client.query(
      `INSERT INTO cost_scenario (workspace_id, opportunity_id, name, kind, rationale, inputs, results, data_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC_DEMO')`,
      [workspaceId, opportunityIds[0], s.definition.name, s.definition.kind,
       s.definition.rationale, JSON.stringify(s.definition.overrides), JSON.stringify(s)],
    );
  }
  await appendEvent(client, {
    workspaceId, projectId: project1, type: 'artifact.created', actorKind: 'agent',
    actorId: finance, actorLabel: 'Grace Okoro', dataLabel: 'SYNTHETIC_DEMO',
    summary: `Three scenarios computed by the deterministic engine. Scenario-set audit returned ${scenarioAudit.length} issue(s).`,
    detail: {
      baseContribution: scenarios[0]?.contribution.contributionPerOrder,
      downsideContribution: scenarios[1]?.contribution.contributionPerOrder,
      audit: scenarioAudit,
      note: 'Duty is computed against an UNCONFIRMED tariff classification and recoverable import tax is NOT treated as recoverable, both of which are surfaced as diagnostics rather than hidden.',
    },
  });

  // Project two's rejection, with the arithmetic that justifies it.
  const rejected = runScenarioSet(
    {
      ...scenarioBase,
      contribution: {
        ...contribution,
        listPricePerUnitExclTax: cad('34.99'),
        outboundShippingCostPerOrder: known(cad('18.00')),
        acquisitionCostPerOrder: known(cad('21.00')),
      },
    },
    [{ name: 'Base', kind: 'base', rationale: 'DEMO: priced to match the commodity competitor scan at 34.99.', overrides: {} }],
  );
  await client.query(
    `INSERT INTO cost_scenario (workspace_id, opportunity_id, name, kind, rationale, inputs, results, data_label)
     VALUES ($1,$2,'Base','base',$3,'{}'::jsonb,$4,'SYNTHETIC_DEMO')`,
    [workspaceId, opportunityIds[3], 'DEMO: priced to match the commodity competitor scan at 34.99.',
     JSON.stringify(rejected[0])],
  );
  await appendEvent(client, {
    workspaceId, projectId: project2, type: 'artifact.created', actorKind: 'agent',
    actorId: challenger, actorLabel: 'Ruth Adeyemi', dataLabel: 'SYNTHETIC_DEMO',
    summary: 'Recommended DO NOT LAUNCH: contribution is negative at the only price the competitor scan supports.',
    detail: {
      contributionPerOrder: rejected[0]?.contribution.contributionPerOrder,
      diagnostics: rejected[0]?.diagnostics.map((d) => d.code),
      reasoning: 'Break-even is not computed for non-positive contribution, because no volume reaches profitability.',
    },
  });
  await client.query(
    `UPDATE project SET status = 'rejected', paused_reason = $2 WHERE id = $1`,
    [project2, 'Rejected on modelled economics. Contribution per order is negative at the supportable price.'],
  );

  /* -------------------------------------------------- compliance register */
  const COMPLIANCE: readonly { topic: string; url: string; applicability: string; questions: string[]; status: string }[] = [
    { topic: 'CBSA commercial import registration and CARM enrolment', url: 'https://www.canada.ca/en/border-services-agency/services/carm.html', applicability: 'Applies to importing commercial goods into Canada. Appears applicable to any purchase for resale.', questions: ['Which CARM role does a sole proprietor need?', 'Is a customs broker required or optional at this volume?'], status: 'professional_review_needed' },
    { topic: 'Tariff classification, valuation and origin', url: 'https://www.cbsa-asfc.gc.ca/import/menu-eng.html', applicability: 'Determines the duty rate. Classification of a textile carrying case is not obvious and drives the landed cost materially.', questions: ['What is the correct HS classification for a lined textile garment carrier?', 'Does the value for duty include international freight on these terms?'], status: 'research_incomplete' },
    { topic: 'Consumer product safety and incident reporting', url: 'https://www.canada.ca/en/health-canada/services/consumer-product-safety/reports-publications/industry-professionals/canada-consumer-product-safety-act-guide.html', applicability: 'General obligations may apply. A textile storage article is not obviously within a product-specific regime, which is not the same as being exempt.', questions: ['Does a garment storage article attract any product-specific requirement?', 'What triggers a section 14 incident report for this product class?'], status: 'research_incomplete' },
    { topic: 'Consumer packaging and labelling', url: 'https://competition-bureau.canada.ca/en/guide-consumer-packaging-and-labelling-act-and-regulations', applicability: 'Applies to prepackaged consumer products. Likely applicable if sold retail in packaging.', questions: ['Is a dealer name and principal place of business required on the package?', 'Which declarations must be bilingual?'], status: 'research_incomplete' },
    { topic: 'Textile labelling requirements', url: 'https://competition-bureau.canada.ca/en/labelling/textile-labelling/textile-labelling-requirements', applicability: 'Applies to consumer textile articles. A fabric garment carrier appears to fall within scope.', questions: ['Is fibre content disclosure required for a carrying case rather than apparel?', 'What CA identification number process applies?'], status: 'professional_review_needed' },
    { topic: 'French-language requirements for sale in Quebec', url: null as unknown as string, applicability: 'Relevant only if selling into Quebec. Not applicable to a Calgary-first launch, and recorded so the question is not forgotten at expansion.', questions: ['What packaging and listing requirements apply when selling into Quebec?'], status: 'not_assessed' },
  ];
  for (const c of COMPLIANCE) {
    await client.query(
      `INSERT INTO compliance_issue (workspace_id, jurisdiction, topic, authoritative_source_url,
         accessed_at, apparent_applicability, unresolved_questions,
         required_documents_or_testing, reviewer, status)
       VALUES ($1,'Canada',$2,$3,$4,$5,$6,'{}',NULL,$7)`,
      [workspaceId, c.topic, c.url ?? null, `${SEED_DATE}T00:00:00Z`,
       c.applicability, c.questions, c.status],
    );
  }

  /* ------------------------------------------------------- failed connector */
  for (const conn of [
    { kind: 'shopify', name: 'Shopify storefront', health: 'not_configured', detail: 'No credentials supplied and no adapter implemented in this build. Listings cannot be published from here.' },
    { kind: 'email', name: 'Outbound email', health: 'disconnected', detail: 'DEMO: last health check failed with an authentication error. Supplier and customer messages cannot be sent; drafts are still produced.' },
    { kind: 'accounting', name: 'Accounting ledger', health: 'not_configured', detail: 'No adapter implemented. Bookkeeping stays as draft records for a human accountant.' },
  ]) {
    await client.query(
      `INSERT INTO connector (workspace_id, kind, display_name, capabilities, health, health_detail, last_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [workspaceId, conn.kind, conn.name,
       JSON.stringify({ read: [], write: [] }), conn.health, conn.detail],
    );
  }
  await appendEvent(client, {
    workspaceId, type: 'connector.health_changed', actorKind: 'system',
    actorLabel: 'Security and integration', dataLabel: 'SYNTHETIC_DEMO',
    summary: 'Outbound email connector is DISCONNECTED. Drafts continue; nothing can be sent.',
    detail: { kind: 'email', health: 'disconnected' },
  });

  /* ------------------------------------------------------------------ tasks */
  async function seedTask(
    title: string, instruction: string, state: string, agentId: string | null,
    opts: { nodeKind?: string; dependsOn?: string[]; reason?: string; priority?: number } = {},
  ): Promise<string> {
    const row = await client.query<{ id: string }>(
      `INSERT INTO task (workspace_id, project_id, title, instruction, node_kind, state,
         assigned_agent_id, waiting_reason, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [workspaceId, project1, title, instruction, opts.nodeKind ?? 'task', state,
       agentId, opts.reason ?? null, opts.priority ?? 100],
    );
    const taskId = row.rows[0]!.id;
    for (const dep of opts.dependsOn ?? []) {
      await client.query('INSERT INTO task_dependency (task_id, depends_on_task_id) VALUES ($1,$2)', [taskId, dep]);
    }
    return taskId;
  }

  const tDiscovery = await seedTask(
    'Find what buyers actually cannot get satisfactorily',
    'Search public sources for descriptions of failure with current transport and storage options for embellished formalwear. Record counterevidence with equal diligence.',
    'completed', discovery, { priority: 10 });
  const tCompetition = await seedTask(
    'Price and availability scan of Canadian alternatives',
    'Establish the delivered price band, including shipping and tax, for every substitute purchasable in Canada today. Test the claim that nothing suitable exists.',
    'completed', analyst, { priority: 20 });
  const tSpec = await seedTask(
    'Write a specification two suppliers would quote identically',
    'Define dimensions, lining, compartment count, closure type and embroidery-protection requirement precisely enough to compare quotes.',
    'completed', productManager, { dependsOn: [tDiscovery, tCompetition], priority: 30 });
  const tCultural = await seedTask(
    'Review assumptions about the buyer population',
    'Flag anywhere the research treats a diverse population as one market, or infers background from names. Identify which claims need validation by named people.',
    'completed', cultural, { dependsOn: [tSpec], priority: 35 });
  const tSourcing = await seedTask(
    'Identify comparable supplier leads in China and India',
    'Find factories and traders capable of the specification. Record MOQ and price as listing CLAIMS, not quotes.',
    'completed', sourcing, { dependsOn: [tSpec], priority: 40 });
  const tCompliance = await seedTask(
    'Screen the specification against Canadian requirements',
    'Build a cited issue register. Produce questions for a professional. Do not state that anything is permitted.',
    'completed', compliance, { dependsOn: [tSpec], priority: 45 });
  const tFinance = await seedTask(
    'Model landed cost and contribution with explicit assumptions',
    'Supply inputs to the deterministic finance engine. Leave the duty rate unknown until classification is confirmed.',
    'completed', finance, { dependsOn: [tSourcing], priority: 50 });
  const tChallenge = await seedTask(
    'Challenge the demand case and the economics',
    'Argue against proceeding. Name the cheapest evidence that would change your mind.',
    'completed', challenger, { dependsOn: [tFinance, tCultural, tCompliance], priority: 60 });

  // A task genuinely blocked on an unmet dependency.
  const tLogisticsBlocked = await seedTask(
    'Test whether stock can be sellable before the Diwali window',
    'Compare sea and air timing against the occasion deadline. A missed window is a write-off, not a delay.',
    'waiting_dependency', logistics,
    {
      dependsOn: [tChallenge],
      reason: 'Blocked: waiting on the challenger review before committing analyst time to freight timing.',
      priority: 70,
    });

  // The owner-approval node holding the sample order.
  const tSampleApproval = await seedTask(
    'Owner decision: buy samples, investigate further, reject, or pause',
    'A scoped sample-order proposal is prepared. Nothing is dispatched without a specific approved action.',
    'waiting_approval', procurement,
    {
      nodeKind: 'owner_approval', dependsOn: [tChallenge],
      reason: 'Awaiting a scoped owner approval bound to the exact supplier, quantity and amount.',
      priority: 80,
    });

  for (const [taskId, title] of [
    [tDiscovery, 'Find what buyers actually cannot get satisfactorily'],
    [tCompetition, 'Price and availability scan of Canadian alternatives'],
    [tSpec, 'Write a specification two suppliers would quote identically'],
    [tCultural, 'Review assumptions about the buyer population'],
    [tSourcing, 'Identify comparable supplier leads in China and India'],
    [tCompliance, 'Screen the specification against Canadian requirements'],
    [tFinance, 'Model landed cost and contribution with explicit assumptions'],
    [tChallenge, 'Challenge the demand case and the economics'],
    [tLogisticsBlocked, 'Test whether stock can be sellable before the Diwali window'],
    [tSampleApproval, 'Owner decision: buy samples, investigate further, reject, or pause'],
  ] as const) {
    await appendEvent(client, {
      workspaceId, projectId: project1, taskId, type: 'task.created',
      actorKind: 'owner', actorId: ownerId, actorLabel: 'Owner', dataLabel: 'SYNTHETIC_DEMO',
      summary: `Task "${title}" seeded`, detail: { seeded: true },
    });
  }

  await appendEvent(client, {
    workspaceId, projectId: project1, taskId: tChallenge, type: 'review.dissent_recorded',
    actorKind: 'agent', actorId: challenger, actorLabel: 'Ruth Adeyemi',
    dataLabel: 'SYNTHETIC_DEMO',
    summary: 'DEMO dissent: the demand case rests on two suggestive observations and one free substitute. That does not justify a 200-unit order.',
    detail: {
      wouldChangeMyMind: [
        'Two boutiques stating what they currently pay for transport packaging.',
        'One customer naming a price unprompted.',
      ],
    },
  });

  /* ------------------------------------------- the pending sample approval */
  const samplePayload = {
    tool: 'order.place' as const,
    action: 'Place a sample order for 5 units of the specified garment carrier for physical inspection.',
    destination: 'DEMO Hangzhou Garment Case Works (no contact has been made)',
    content: 'Sample order: 5 units to the written specification, FOB, to be inspected against the QA checklist before any production order is considered.',
    amountMinor: cad('420.00').minor,
    currency: 'CAD',
    productRef: 'Premium formalwear carrier, specification v1',
    quantity: 5,
    supplierRef: supplierRows[0]?.name ?? 'DEMO supplier',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };
  const sampleHash = hashApprovalPayload(samplePayload);
  const approval = await client.query<{ id: string }>(
    `INSERT INTO approval (workspace_id, project_id, task_id, tool_name, payload,
       payload_hash, state, expires_at)
     VALUES ($1,$2,$3,'order.place',$4,$5,'pending',$6) RETURNING id`,
    [workspaceId, project1, tSampleApproval, JSON.stringify(samplePayload), sampleHash,
     samplePayload.expiresAt],
  );
  await appendEvent(client, {
    workspaceId, projectId: project1, taskId: tSampleApproval, type: 'approval.requested',
    actorKind: 'agent', actorId: procurement, actorLabel: 'Dev Patel',
    dataLabel: 'SYNTHETIC_DEMO',
    summary: 'Approval requested: 5-unit sample order, 420.00 CAD. Nothing is dispatched until the owner grants it.',
    detail: {
      approvalId: approval.rows[0]!.id, payloadHash: sampleHash,
      note: 'Editing any field of this payload invalidates the approval. Approval is bound to this exact content.',
    },
  });

  /* -------------------------------------------- visible demo budget limits */
  await client.query(
    `INSERT INTO budget_ledger (workspace_id, project_id, kind, amount_usd, measured, note)
     VALUES ($1,$2,'compute','0',false,$3)`,
    [workspaceId, project1,
     'DEMO example limit, seeded visibly: a compute budget of USD 5.00 would be an example value only. No real budget is configured, and live runs stay blocked until the owner sets one.'],
  );

  await appendEvent(client, {
    workspaceId, type: 'project.created', actorKind: 'system',
    actorLabel: 'Seed', dataLabel: 'SYNTHETIC_DEMO',
    summary: 'Demo company seeded. Every fabricated record is labelled SYNTHETIC_DEMO; owner-supplied URLs are labelled UNVERIFIED_LEAD and were not fetched.',
    detail: {
      agents: 13, projects: 2, opportunities: HYPOTHESES.length,
      realSourceSeeds: REAL_SOURCES.length, syntheticFindings: MIXED.length,
      idleAgent: creative, pausedAgent: 'Priya Anand',
      blockedTask: tLogisticsBlocked, pendingApproval: approval.rows[0]!.id,
      chiefOfStaff: chief,
    },
  });

  console.log('Seeded demo company:');
  console.log(`  workspace        ${workspaceId}`);
  console.log('  agents           13 (11 active, 1 idle by design, 1 paused)');
  console.log('  projects         2 (1 active, 1 rejected on negative contribution)');
  console.log(`  opportunities    ${HYPOTHESES.length} unvalidated hypotheses`);
  console.log(`  evidence         ${REAL_SOURCES.length} owner URLs (UNVERIFIED_LEAD, not fetched) + ${MIXED.length} synthetic mixed findings`);
  console.log('  suppliers        4 DEMO suppliers with DEMO quotes');
  console.log('  scenarios        base / downside / upside from the deterministic engine');
  console.log(`  scenario audit   ${scenarioAudit.length} issue(s)`);
  console.log('  connectors       1 disconnected, 2 not configured');
  console.log('  tasks            10 (8 completed, 1 blocked on a dependency, 1 awaiting approval)');
  console.log(`  approval         1 pending sample order, hash ${sampleHash.slice(0, 16)}...`);
});

await closePool();
