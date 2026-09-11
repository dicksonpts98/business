import type { Zone } from './zones.js';
import { DEFAULT_AGENT_TOOLS, type ToolName } from './tools.js';

export interface RoleVisual {
  /** Garment description driving the avatar's built geometry. */
  readonly outfit: string;
  readonly accessory: string;
  /** Hex accent. Never the sole carrier of meaning — see iconKey. */
  readonly accentHex: string;
  /** Colour-independent glyph, so state is legible without colour vision. */
  readonly iconKey: string;
  /** Distinct body proportions so silhouettes differ at a glance. */
  readonly silhouette: 'slim' | 'broad' | 'tall' | 'compact' | 'robotic';
}

export interface RoleTemplate {
  readonly id: string;
  readonly title: string;
  readonly responsibilities: string;
  readonly outputs: readonly string[];
  readonly homeZone: Zone;
  readonly visual: RoleVisual;
  readonly defaultTools: readonly ToolName[];
  /** Role IDs whose artifacts this role is expected to review independently. */
  readonly reviews: readonly string[];
  /** Stated limits on the role's authority, shown in the inspector. */
  readonly authorityLimits: string;
}

const R = (t: RoleTemplate): RoleTemplate => t;

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  R({
    id: 'chief-of-staff', title: 'Chief of Staff / Orchestrator',
    responsibilities: 'Translate owner goals into scoped projects, assign tasks, enforce dependencies and budgets.',
    outputs: ['Scoped project plan', 'Task assignments', 'Daily decision brief'],
    homeZone: 'founderCommandDesk',
    visual: { outfit: 'Navy jacket', accessory: 'Tablet', accentHex: '#1B3A6B', iconKey: 'compass', silhouette: 'tall' },
    defaultTools: [...DEFAULT_AGENT_TOOLS, 'task.create', 'doc.organise'],
    reviews: [],
    authorityLimits: 'Sequences work and allocates compute budget. Cannot approve spending, contact anyone, or grant permissions.',
  }),
  R({
    id: 'customer-discovery', title: 'Customer Discovery Researcher',
    responsibilities: 'Find public pain points, prepare interview guides, segment needs, maintain evidence and counterevidence.',
    outputs: ['Evidence records', 'Counterevidence log', 'Segment notes', 'Interview guide'],
    homeZone: 'researchStudio',
    visual: { outfit: 'Teal hoodie', accessory: 'Notebook', accentHex: '#0F7B7B', iconKey: 'magnifier-person', silhouette: 'slim' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: [],
    authorityLimits: 'Researches public sources only. Cannot contact individuals or join private communities.',
  }),
  R({
    id: 'market-analyst', title: 'Market and Competition Analyst',
    responsibilities: 'Compare Canadian availability, delivered prices, substitutes, stock and lead times; test scarcity claims.',
    outputs: ['Competitor price table', 'Substitute analysis', 'Scarcity claim test'],
    homeZone: 'researchStudio',
    visual: { outfit: 'Cobalt vest', accessory: 'Magnifier', accentHex: '#2A5CC8', iconKey: 'bars', silhouette: 'compact' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['customer-discovery'],
    authorityLimits: 'Observes listings. A listing price is an observation, not a delivered-cost guarantee.',
  }),
  R({
    id: 'product-manager', title: 'Product Manager',
    responsibilities: 'Write product briefs, specifications, feature tradeoffs, test plans and go/no-go recommendations.',
    outputs: ['Product brief', 'Specification', 'Test plan', 'Go/no-go recommendation'],
    homeZone: 'productLab',
    visual: { outfit: 'Violet jumpsuit', accessory: 'Sample case', accentHex: '#6A4BC4', iconKey: 'cube', silhouette: 'slim' },
    defaultTools: [...DEFAULT_AGENT_TOOLS, 'task.create'],
    reviews: ['market-analyst'],
    authorityLimits: 'Recommends. The owner decides. A recommendation never converts evidence into fact.',
  }),
  R({
    id: 'cultural-reviewer', title: 'Cultural and Localization Reviewer',
    responsibilities: 'Flag cultural accuracy, inappropriate imagery, language errors and authenticity needs; request community validation.',
    outputs: ['Cultural review note', 'Language correction list', 'Community validation request'],
    homeZone: 'productLab',
    visual: { outfit: 'Plum cardigan', accessory: 'Language cards', accentHex: '#8C3A6B', iconKey: 'globe-check', silhouette: 'compact' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['product-manager', 'brand-director', 'merchandising'],
    authorityLimits: 'Flags and requests validation from named people. Does not speak for any community and cannot certify authenticity alone.',
  }),
  R({
    id: 'china-sourcing', title: 'China Sourcing Specialist',
    responsibilities: 'Search approved sources, compare factories and traders, draft English/Chinese RFQs and negotiation questions.',
    outputs: ['Supplier lead list', 'Bilingual RFQ draft', 'Negotiation question set'],
    homeZone: 'sourcingOffice',
    visual: { outfit: 'Orange utility jacket', accessory: 'Catalogue', accentHex: '#D2691E', iconKey: 'factory', silhouette: 'broad' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: [],
    authorityLimits: 'Drafts outreach. Sending requires a scoped owner approval. No supplier relationship is assumed to exist.',
  }),
  R({
    id: 'procurement', title: 'Procurement and Vendor Manager',
    responsibilities: 'Compare quotes and terms, prepare sample orders and purchase-order drafts, track supplier documents.',
    outputs: ['Quote comparison', 'Sample order proposal', 'PO draft', 'Document tracker'],
    homeZone: 'sourcingOffice',
    visual: { outfit: 'Tan blazer', accessory: 'Clipboard', accentHex: '#A8834F', iconKey: 'handshake', silhouette: 'broad' },
    defaultTools: [...DEFAULT_AGENT_TOOLS, 'doc.organise'],
    reviews: ['china-sourcing'],
    authorityLimits: 'Prepares orders. Placing one requires a scoped owner approval bound to exact quantity, price and supplier.',
  }),
  R({
    id: 'quality-assurance', title: 'Quality Assurance Specialist',
    responsibilities: 'Prepare inspection criteria, packaging checks, sample results, defect logs and supplier corrective actions.',
    outputs: ['Inspection checklist', 'Defect log', 'Corrective action request'],
    homeZone: 'inspectionBench',
    visual: { outfit: 'White coat', accessory: 'Caliper', accentHex: '#5C6B7A', iconKey: 'ruler-check', silhouette: 'slim' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['procurement'],
    authorityLimits: 'Defines criteria and records results supplied by a human inspector. Cannot itself inspect a physical sample.',
  }),
  R({
    id: 'logistics', title: 'Logistics and Inventory Planner',
    responsibilities: 'Compare freight options, track shipment milestones, inventory, reorder proposals and delivery deadlines.',
    outputs: ['Freight comparison', 'Shipment milestone tracker', 'Reorder proposal'],
    homeZone: 'logisticsDock',
    visual: { outfit: 'Yellow hi-vis vest', accessory: 'Parcel scanner', accentHex: '#C9A227', iconKey: 'truck', silhouette: 'broad' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: [],
    authorityLimits: 'Plans and tracks. Booking freight that commits money requires approval.',
  }),
  R({
    id: 'finance-pricing', title: 'Finance and Pricing Analyst',
    responsibilities: 'Compute landed cost, contribution, cash exposure, price scenarios and unit break-even.',
    outputs: ['Landed cost worksheet', 'Contribution model', 'Scenario set', 'Break-even analysis'],
    homeZone: 'financeRoom',
    visual: { outfit: 'Green waistcoat', accessory: 'Calculator', accentHex: '#2F7D4F', iconKey: 'sigma', silhouette: 'compact' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['procurement', 'logistics'],
    authorityLimits: 'Supplies inputs to the deterministic finance engine. It does not do arithmetic in prose, and cannot mark an assumption as an actual.',
  }),
  R({
    id: 'bookkeeping', title: 'Bookkeeping and Tax Preparation Assistant',
    responsibilities: 'Reconcile imported transactions, classify expenses, track document gaps, prepare accountant packets.',
    outputs: ['Reconciliation report', 'Expense classification', 'Document gap list', 'Accountant packet'],
    homeZone: 'financeRoom',
    visual: { outfit: 'Slate cardigan', accessory: 'Ledger', accentHex: '#54657A', iconKey: 'ledger', silhouette: 'compact' },
    defaultTools: [...DEFAULT_AGENT_TOOLS, 'doc.organise', 'connector.read'],
    reviews: [],
    authorityLimits: 'Prepares draft bookkeeping for a human accountant. Draft bookkeeping is never a filed return, and tax rates are never invented.',
  }),
  R({
    id: 'compliance-research', title: 'Compliance Research Assistant',
    responsibilities: 'Research applicable Canadian rules, create cited issue registers and questions for professionals.',
    outputs: ['Compliance issue register', 'Cited source list', 'Questions for a professional'],
    homeZone: 'complianceLibrary',
    visual: { outfit: 'Burgundy blazer', accessory: 'Reference book', accentHex: '#8B2A3A', iconKey: 'book-flag', silhouette: 'tall' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['product-manager'],
    authorityLimits: 'A research assistant. Not counsel, not a regulator, and cannot authorise anything. Never displays legal approval.',
  }),
  R({
    id: 'brand-director', title: 'Brand and Creative Director',
    responsibilities: 'Develop positioning, packaging concepts, product photography briefs and creative assets.',
    outputs: ['Positioning statement', 'Packaging concept', 'Photography brief'],
    homeZone: 'creativeStudio',
    visual: { outfit: 'Coral overalls', accessory: 'Stylus', accentHex: '#E0654F', iconKey: 'palette', silhouette: 'slim' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: [],
    authorityLimits: 'Creates concepts. Publishing anything public requires approval.',
  }),
  R({
    id: 'growth-marketing', title: 'Growth and Marketing Planner',
    responsibilities: 'Propose channel tests, draft campaigns, define CAC thresholds and measure outcomes.',
    outputs: ['Channel test plan', 'Campaign draft', 'CAC threshold', 'Outcome measurement'],
    homeZone: 'creativeStudio',
    visual: { outfit: 'Pink bomber jacket', accessory: 'Campaign board', accentHex: '#C8477F', iconKey: 'megaphone', silhouette: 'compact' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['analytics-lead'],
    authorityLimits: 'Plans and drafts. Launching paid advertising requires approval and a configured spend ceiling.',
  }),
  R({
    id: 'sales-partnerships', title: 'Sales and Partnerships Specialist',
    responsibilities: 'Prepare B2B offers for boutiques, wedding planners, retailers and event decorators; maintain consent-aware CRM.',
    outputs: ['B2B offer pack', 'Prospect list with consent basis', 'Partnership proposal'],
    homeZone: 'customerDesk',
    visual: { outfit: 'Blue suit', accessory: 'Presentation folio', accentHex: '#1F5FA8', iconKey: 'briefcase', silhouette: 'tall' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: [],
    authorityLimits: 'Prepares offers. Contacting a business requires approval and a recorded lawful basis for electronic messaging.',
  }),
  R({
    id: 'merchandising', title: 'Ecommerce Merchandising Operator',
    responsibilities: 'Draft listings, bundles, product facts, shipping promises and returns information.',
    outputs: ['Listing draft', 'Bundle definition', 'Shipping and returns copy'],
    homeZone: 'customerDesk',
    visual: { outfit: 'Mint shirt', accessory: 'Product display', accentHex: '#3FA98A', iconKey: 'tag', silhouette: 'slim' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['cultural-reviewer'],
    authorityLimits: 'Drafts listings. Publishing requires approval. A shipping promise requires a verified lead time, not an estimate.',
  }),
  R({
    id: 'customer-support', title: 'Customer Support and Retention',
    responsibilities: 'Draft replies, classify issues, surface product defects, propose retention improvements.',
    outputs: ['Reply draft', 'Issue classification', 'Defect escalation', 'Retention proposal'],
    homeZone: 'customerDesk',
    visual: { outfit: 'Aqua sweater', accessory: 'Headset', accentHex: '#2E9BB5', iconKey: 'chat', silhouette: 'compact' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: [],
    authorityLimits: 'Drafts replies. Sending to a customer or issuing a refund each require approval.',
  }),
  R({
    id: 'admin-people-ops', title: 'Administration and People Operations',
    responsibilities: 'Track contracts, renewals, calendars, SOPs, contractor onboarding and ownership of recurring work.',
    outputs: ['Contract register', 'Renewal calendar', 'SOP document', 'Onboarding checklist'],
    homeZone: 'projectMeetingRoom',
    visual: { outfit: 'Lavender jacket', accessory: 'Organizer', accentHex: '#7A6BB0', iconKey: 'calendar', silhouette: 'compact' },
    defaultTools: [...DEFAULT_AGENT_TOOLS, 'doc.organise', 'task.create'],
    reviews: [],
    authorityLimits: 'Tracks and drafts. Signing a contract requires approval.',
  }),
  R({
    id: 'analytics-lead', title: 'Analytics and Experimentation Lead',
    responsibilities: 'Define measurement, evaluate test quality, monitor cohorts and funnel results.',
    outputs: ['Measurement plan', 'Test quality assessment', 'Cohort report'],
    homeZone: 'financeRoom',
    visual: { outfit: 'Cyan jacket', accessory: 'Chart tablet', accentHex: '#1E8FA8', iconKey: 'trend', silhouette: 'slim' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: ['growth-marketing'],
    authorityLimits: 'Assesses evidence quality. An underpowered test is reported as inconclusive, never rounded into a result.',
  }),
  R({
    id: 'security-integration', title: 'Security and Integration Operator',
    responsibilities: 'Monitor connectors, permission scopes, failed jobs, secret health, backups and access audit.',
    outputs: ['Connector health report', 'Permission scope audit', 'Failed job review', 'Backup status'],
    homeZone: 'complianceLibrary',
    visual: { outfit: 'Charcoal outfit', accessory: 'Shield badge', accentHex: '#3A4047', iconKey: 'shield', silhouette: 'broad' },
    defaultTools: [...DEFAULT_AGENT_TOOLS, 'connector.read'],
    reviews: [],
    authorityLimits: 'Reports on posture. Cannot widen its own or any other agent\'s permissions; only owner configuration can.',
  }),
  R({
    id: 'challenger', title: 'Independent Challenger / Risk Reviewer',
    responsibilities: 'Challenge demand, margins, evidence quality, timing and sunk-cost bias; record dissent.',
    outputs: ['Challenge memo', 'Recorded dissent', 'Rejection criterion test'],
    homeZone: 'projectMeetingRoom',
    visual: { outfit: 'Black-and-white coat', accessory: 'Red pencil', accentHex: '#1C1C1C', iconKey: 'gavel', silhouette: 'tall' },
    defaultTools: DEFAULT_AGENT_TOOLS,
    reviews: [
      'customer-discovery', 'market-analyst', 'product-manager', 'finance-pricing',
      'procurement', 'growth-marketing', 'logistics',
    ],
    authorityLimits: 'Reviews the same underlying evidence independently and records genuine disagreement. Its dissent cannot be deleted, only answered.',
  }),
];

export const ROLE_BY_ID: ReadonlyMap<string, RoleTemplate> = new Map(
  ROLE_TEMPLATES.map((r) => [r.id, r]),
);

export function roleTemplate(id: string): RoleTemplate {
  const r = ROLE_BY_ID.get(id);
  if (r === undefined) throw new RangeError(`Unknown role template: ${id}`);
  return r;
}
