import { Html } from '@react-three/drei';
import { ZONE_LABEL, type ZoneSpec } from '@sqhq/shared';
import { ACCENT_BY_ZONE, PALETTE } from './palette.js';

export interface RoomProps {
  readonly spec: ZoneSpec;
  readonly selected: boolean;
  readonly badgeCount: number;
  readonly quality: 'low' | 'medium' | 'high';
  readonly showLabels: boolean;
  readonly onOpen: (spec: ZoneSpec) => void;
  readonly onOpenPrototype?: (spec: ZoneSpec) => void;
}

/** One office zone: floor plate, glass partitions, desks, and its own signage. */
export function Room({
  spec, selected, badgeCount, quality, showLabels, onOpen, onOpenPrototype,
}: RoomProps): React.JSX.Element {
  const [x, , z] = spec.position;
  const [w, d] = spec.size;
  const accent = ACCENT_BY_ZONE[spec.accent];
  const wallHeight = 1.5;
  const detailed = quality !== 'low';

  return (
    <group position={[x, 0, z]}>
      {/* Floor plate */}
      <mesh
        receiveShadow
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.01, 0]}
        onClick={(e) => { e.stopPropagation(); onOpen(spec); }}
      >
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial
          color={selected ? PALETTE.floorEdge : PALETTE.floor}
          roughness={0.92}
        />
      </mesh>

      {/* Accent threshold strip, so each room reads as its own department */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, d / 2 - 0.12]}>
        <planeGeometry args={[w * 0.8, 0.14]} />
        <meshBasicMaterial color={accent} />
      </mesh>

      {/* Glass partitions on two sides, low enough to see over */}
      {detailed && ([[0, -d / 2, w, 0], [-w / 2, 0, d, Math.PI / 2]] as const).map(
        ([gx, gz, len, rot]) => (
          <mesh key={`${gx}-${gz}`} position={[gx, wallHeight / 2, gz]} rotation={[0, rot, 0]} castShadow>
            <boxGeometry args={[len, wallHeight, 0.06]} />
            <meshStandardMaterial
              color={PALETTE.glass}
              transparent
              opacity={0.26}
              roughness={0.08}
              metalness={0.1}
            />
          </mesh>
        ))}

      {/* Oak desk */}
      <group position={[0, 0, -d / 4]}>
        <mesh castShadow receiveShadow position={[0, 0.72, 0]}>
          <boxGeometry args={[w * 0.6, 0.07, 0.85]} />
          <meshStandardMaterial color={PALETTE.oak} roughness={0.66} />
        </mesh>
        {detailed && ([-1, 1] as const).map((side) => (
          <mesh key={side} castShadow position={[side * (w * 0.28), 0.36, 0]}>
            <boxGeometry args={[0.07, 0.72, 0.72]} />
            <meshStandardMaterial color={PALETTE.oakDark} roughness={0.75} />
          </mesh>
        ))}
        {/* A monitor, so a desk reads as a workstation */}
        {detailed && (
          <group position={[0, 0.76, -0.22]}>
            <mesh castShadow position={[0, 0.24, 0]}>
              <boxGeometry args={[0.62, 0.36, 0.03]} />
              <meshStandardMaterial color="#2a2f35" roughness={0.35} />
            </mesh>
            <mesh position={[0, 0.06, 0]}>
              <boxGeometry args={[0.07, 0.14, 0.07]} />
              <meshStandardMaterial color={PALETTE.metal} metalness={0.5} roughness={0.4} />
            </mesh>
          </group>
        )}
      </group>

      {/*
        A product prototype on the product-lab table. Clicking it opens the
        opportunity dossier, which is the same record the table view shows.
      */}
      {spec.zone === 'productLab' && (
        <group
          position={[w * 0.26, 0.78, d * 0.22]}
          onClick={(e) => { e.stopPropagation(); (onOpenPrototype ?? onOpen)(spec); }}
        >
          <mesh castShadow>
            <boxGeometry args={[0.46, 0.1, 0.3]} />
            <meshStandardMaterial color={PALETTE.coral} roughness={0.5} />
          </mesh>
          <mesh castShadow position={[0, 0.09, 0]}>
            <boxGeometry args={[0.4, 0.08, 0.26]} />
            <meshStandardMaterial color={PALETTE.paper} roughness={0.85} />
          </mesh>
          {showLabels && (
            <Html position={[0, 0.4, 0]} center distanceFactor={16} zIndexRange={[15, 0]}>
              <button
                type="button"
                className="prototype-tag"
                onClick={(e) => { e.stopPropagation(); (onOpenPrototype ?? onOpen)(spec); }}
                aria-label="Open the opportunity dossier for the prototype on the product lab table"
              >
                Prototype dossier
              </button>
            </Html>
          )}
        </group>
      )}

      {/* Plant */}
      {detailed && (
        <group position={[w / 2 - 0.55, 0, d / 2 - 0.55]}>
          <mesh castShadow position={[0, 0.16, 0]}>
            <cylinderGeometry args={[0.16, 0.12, 0.32, quality === 'high' ? 16 : 8]} />
            <meshStandardMaterial color={PALETTE.plantPot} roughness={0.8} />
          </mesh>
          <mesh castShadow position={[0, 0.56, 0]}>
            <sphereGeometry args={[0.3, quality === 'high' ? 14 : 8, quality === 'high' ? 12 : 6]} />
            <meshStandardMaterial color={PALETTE.plant} roughness={0.9} />
          </mesh>
        </group>
      )}

      {/* Room signage as a DOM overlay: readable, selectable, screen-reader friendly */}
      {showLabels && (
        <Html position={[0, wallHeight + 0.5, d / 2 - 0.1]} center distanceFactor={18} zIndexRange={[10, 0]}>
          <button
            type="button"
            className={`room-sign${selected ? ' room-sign-selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); onOpen(spec); }}
            aria-label={`Open the ${ZONE_LABEL[spec.zone]} dashboard${
              badgeCount > 0 ? `. ${badgeCount} item${badgeCount === 1 ? '' : 's'} need attention.` : ''}`}
          >
            <span className="room-sign-accent" style={{ background: accent }} aria-hidden="true" />
            {ZONE_LABEL[spec.zone]}
            {badgeCount > 0 && <span className="room-sign-badge">{badgeCount}</span>}
          </button>
        </Html>
      )}
    </group>
  );
}
