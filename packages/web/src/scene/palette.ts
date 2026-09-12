/**
 * Scene palette: warm daylight, soft ivory architecture, oak, with restrained
 * teal, cobalt, amber and coral accents. Colours are decorative only. Every
 * state that matters is also carried by a glyph and by text, so nothing depends
 * on colour vision.
 */
export const PALETTE = {
  // Floor plates are deliberately LIGHTER and warmer than the ground, and the
  // ground is darker than it first appears necessary. In an isometric view with
  // soft light, too little value separation makes the whole campus read as one
  // grey plane and the rooms stop being legible as rooms.
  floor: '#fbf4e8',
  floorEdge: '#f0e2cb',
  wall: '#f7f2ea',
  glass: '#bcd5da',
  oak: '#b0783c',
  oakDark: '#7d5a2e',
  metal: '#b6b2ab',
  plant: '#3f6b3c',
  plantPot: '#bd7f56',
  ground: '#cdbfa8',
  groundRim: '#b9a88d',
  teal: '#0f7b7b',
  cobalt: '#2a5cc8',
  amber: '#c9891f',
  coral: '#e0654f',
  skin: '#d9b79a',
  hair: '#4a3b32',
  paper: '#fbf8f2',
} as const;

export const ACCENT_BY_ZONE = {
  teal: PALETTE.teal,
  cobalt: PALETTE.cobalt,
  amber: PALETTE.amber,
  coral: PALETTE.coral,
} as const;

/**
 * Status colours, each paired with a glyph in STATUS_GLYPH so the state reads
 * without colour. Errors are deliberately a different SHAPE of indicator, not
 * merely a different hue, because "thinking" and "broken" must not look alike.
 */
export const STATUS = {
  idle: { color: '#9aa3ab', glyph: '○', label: 'Idle' },
  working: { color: PALETTE.teal, glyph: '▶', label: 'Working' },
  waiting_dependency: { color: PALETTE.amber, glyph: '⋯', label: 'Blocked on a dependency' },
  waiting_approval: { color: PALETTE.cobalt, glyph: '⏸', label: 'Waiting for your approval' },
  waiting_input: { color: PALETTE.cobalt, glyph: '?', label: 'Waiting for your input' },
  errored: { color: PALETTE.coral, glyph: '✕', label: 'Errored' },
  paused: { color: '#8b8680', glyph: '‖', label: 'Paused' },
  archived: { color: '#6f6a65', glyph: '▢', label: 'Archived' },
} as const;

export type StatusKey = keyof typeof STATUS;
