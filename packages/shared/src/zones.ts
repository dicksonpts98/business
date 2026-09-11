/** Office zones. Each is a real place in the 3D scene and a dashboard route. */
export const ZONES = [
  'founderCommandDesk', 'researchStudio', 'productLab', 'sourcingOffice',
  'inspectionBench', 'logisticsDock', 'financeRoom', 'creativeStudio',
  'customerDesk', 'complianceLibrary', 'projectMeetingRoom',
] as const;
export type Zone = (typeof ZONES)[number];

export const ZONE_LABEL: Record<Zone, string> = {
  founderCommandDesk: 'Founder command desk',
  researchStudio: 'Research studio',
  productLab: 'Product lab',
  sourcingOffice: 'Sourcing office',
  inspectionBench: 'Inspection bench',
  logisticsDock: 'Logistics dock',
  financeRoom: 'Finance room',
  creativeStudio: 'Creative studio',
  customerDesk: 'Customer desk',
  complianceLibrary: 'Compliance library',
  projectMeetingRoom: 'Project meeting room',
};

/** Floor-plan anchor in metres, and the dashboard the room opens. */
export interface ZoneSpec {
  readonly zone: Zone;
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number];
  readonly dashboard: string;
  readonly accent: 'teal' | 'cobalt' | 'amber' | 'coral';
}

export const ZONE_LAYOUT: readonly ZoneSpec[] = [
  { zone: 'founderCommandDesk', position: [0, 0, -9], size: [7, 5], dashboard: 'decisions', accent: 'cobalt' },
  { zone: 'researchStudio', position: [-11, 0, -4], size: [7, 6], dashboard: 'evidence', accent: 'teal' },
  { zone: 'productLab', position: [-11, 0, 4], size: [7, 6], dashboard: 'opportunities', accent: 'amber' },
  { zone: 'sourcingOffice', position: [11, 0, -4], size: [7, 6], dashboard: 'suppliers', accent: 'amber' },
  { zone: 'inspectionBench', position: [11, 0, 4], size: [7, 6], dashboard: 'quality', accent: 'coral' },
  { zone: 'logisticsDock', position: [11, 0, 12], size: [7, 6], dashboard: 'shipments', accent: 'cobalt' },
  { zone: 'financeRoom', position: [-4, 0, 12], size: [7, 6], dashboard: 'finance', accent: 'teal' },
  { zone: 'creativeStudio', position: [-11, 0, 12], size: [7, 6], dashboard: 'creative', accent: 'coral' },
  { zone: 'customerDesk', position: [4, 0, 12], size: [7, 6], dashboard: 'customers', accent: 'teal' },
  { zone: 'complianceLibrary', position: [4, 0, -9], size: [7, 5], dashboard: 'compliance', accent: 'cobalt' },
  { zone: 'projectMeetingRoom', position: [-4, 0, -9], size: [7, 5], dashboard: 'tasks', accent: 'amber' },
];

/**
 * Navigation graph between zone centres. Avatars walk these edges. The graph is
 * purely cosmetic: it governs how movement is drawn and never gates, delays or
 * orders backend execution.
 */
export const NAV_EDGES: readonly (readonly [Zone, Zone])[] = [
  ['founderCommandDesk', 'projectMeetingRoom'],
  ['founderCommandDesk', 'complianceLibrary'],
  ['projectMeetingRoom', 'researchStudio'],
  ['projectMeetingRoom', 'financeRoom'],
  ['complianceLibrary', 'sourcingOffice'],
  ['complianceLibrary', 'customerDesk'],
  ['researchStudio', 'productLab'],
  ['productLab', 'creativeStudio'],
  ['creativeStudio', 'financeRoom'],
  ['financeRoom', 'customerDesk'],
  ['customerDesk', 'logisticsDock'],
  ['sourcingOffice', 'inspectionBench'],
  ['inspectionBench', 'logisticsDock'],
];
