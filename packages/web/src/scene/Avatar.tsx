import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Group } from 'three';
import { ROLE_BY_ID, type AgentPresence, type Zone } from '@sqhq/shared';
import { PALETTE, STATUS, type StatusKey } from './palette.js';
import {
  type Vec3, addVec, findPath, headingBetween, pathLength, pointAlong, zoneCentre,
} from './navigation.js';

export interface AvatarProps {
  readonly presence: AgentPresence;
  readonly offset: Vec3;
  readonly selected: boolean;
  readonly reducedMotion: boolean;
  readonly showNameplates: boolean;
  readonly quality: 'low' | 'medium' | 'high';
  readonly onSelect: (agentId: string) => void;
}

const WALK_SPEED = 3.2; // metres per second

function statusKey(activity: AgentPresence['activity']): StatusKey {
  return activity.kind;
}

/** Body proportions per role silhouette, so agents differ in shape not just hue. */
const SILHOUETTE = {
  slim: { torsoW: 0.42, torsoD: 0.26, torsoH: 0.72, legH: 0.78, headR: 0.19, shoulder: 0.1 },
  broad: { torsoW: 0.62, torsoD: 0.36, torsoH: 0.68, legH: 0.7, headR: 0.21, shoulder: 0.16 },
  tall: { torsoW: 0.46, torsoD: 0.28, torsoH: 0.8, legH: 0.92, headR: 0.19, shoulder: 0.12 },
  compact: { torsoW: 0.54, torsoD: 0.32, torsoH: 0.58, legH: 0.62, headR: 0.2, shoulder: 0.13 },
  robotic: { torsoW: 0.5, torsoD: 0.34, torsoH: 0.7, legH: 0.74, headR: 0.18, shoulder: 0.14 },
} as const;

/**
 * One agent, drawn from real geometry.
 *
 * Movement is interpolated along the navigation graph in a frame loop. It is
 * cosmetic: the avatar's arrival never gates a result. When the backend reports
 * a new zone the walk simply retargets, and the inspector already shows the new
 * truth.
 */
export function Avatar({
  presence, offset, selected, reducedMotion, showNameplates, quality, onSelect,
}: AvatarProps): React.JSX.Element {
  const group = useRef<Group>(null);
  const [hovered, setHovered] = useState(false);
  const armLeft = useRef<Group>(null);
  const armRight = useRef<Group>(null);

  const role = ROLE_BY_ID.get(presence.roleId);
  const accent = role?.visual.accentHex ?? PALETTE.cobalt;
  const shape = SILHOUETTE[role?.visual.silhouette ?? 'compact'];
  const status = STATUS[statusKey(presence.activity)];

  const target = useMemo<Vec3>(
    () => addVec(zoneCentre(presence.zone), offset),
    [presence.zone, offset],
  );

  // Walk state: where we came from, where we are going, and how far along.
  const [path, setPath] = useState<Vec3[]>([target]);
  const progress = useRef(1);
  const currentZone = useRef<Zone>(presence.zone);
  const [walking, setWalking] = useState(false);

  useEffect(() => {
    if (currentZone.current === presence.zone) {
      setPath([target]);
      progress.current = 1;
      return;
    }
    const route = findPath(currentZone.current, presence.zone).map((z) => zoneCentre(z));
    const withOffset: Vec3[] = [...route.slice(0, -1), target];
    currentZone.current = presence.zone;
    if (reducedMotion) {
      // No traversal animation: appear at the destination immediately.
      setPath([target]);
      progress.current = 1;
      setWalking(false);
      return;
    }
    setPath(withOffset);
    progress.current = 0;
    setWalking(true);
  }, [presence.zone, target, reducedMotion]);

  const totalLength = useMemo(() => pathLength(path), [path]);

  useFrame((state, delta) => {
    const node = group.current;
    if (node === null) return;

    if (progress.current < 1 && totalLength > 0) {
      progress.current = Math.min(1, progress.current + (WALK_SPEED * delta) / totalLength);
      if (progress.current >= 1 && walking) setWalking(false);
    }
    const position = pointAlong(path, progress.current);
    node.position.set(position[0], position[1], position[2]);

    if (progress.current < 1) {
      const ahead = pointAlong(path, Math.min(1, progress.current + 0.02));
      node.rotation.y = headingBetween(position, ahead);
    }

    if (reducedMotion) {
      node.position.y = 0;
      if (armLeft.current !== null) armLeft.current.rotation.x = 0;
      if (armRight.current !== null) armRight.current.rotation.x = 0;
      return;
    }

    const t = state.clock.elapsedTime;
    if (progress.current < 1) {
      // Walking: a small vertical bob and opposed arm swing.
      node.position.y = Math.abs(Math.sin(t * 9)) * 0.045;
      if (armLeft.current !== null) armLeft.current.rotation.x = Math.sin(t * 9) * 0.7;
      if (armRight.current !== null) armRight.current.rotation.x = -Math.sin(t * 9) * 0.7;
    } else if (presence.activity.kind === 'working') {
      // Working at a desk: small typing motion, forearms only.
      node.position.y = 0;
      if (armLeft.current !== null) armLeft.current.rotation.x = -1.1 + Math.sin(t * 11) * 0.12;
      if (armRight.current !== null) armRight.current.rotation.x = -1.1 + Math.sin(t * 11 + 1.6) * 0.12;
    } else {
      // Idle, waiting and errored are all visibly STILL. An avatar that keeps
      // typing while its task is blocked is a lie the scene must not tell.
      node.position.y = 0;
      if (armLeft.current !== null) armLeft.current.rotation.x = 0;
      if (armRight.current !== null) armRight.current.rotation.x = 0;
    }
  });

  const dimmed = presence.activity.kind === 'paused' || presence.activity.kind === 'archived';
  const opacity = dimmed ? 0.45 : 1;
  const isRobot = role?.visual.silhouette === 'robotic';

  return (
    <group ref={group} position={target as unknown as [number, number, number]}>
      {/* Selection and status ring. Errors use a distinct, larger broken ring. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        {presence.activity.kind === 'errored'
          ? <ringGeometry args={[0.52, 0.68, 20, 1, 0, Math.PI * 1.45]} />
          : <ringGeometry args={[0.44, selected ? 0.62 : 0.54, 28]} />}
        <meshBasicMaterial
          color={selected ? PALETTE.cobalt : status.color}
          transparent
          opacity={selected ? 0.95 : 0.6}
        />
      </mesh>

      {/* Legs */}
      {[-0.13, 0.13].map((x) => (
        <mesh key={x} castShadow position={[x, shape.legH / 2, 0]}>
          <capsuleGeometry args={[0.085, shape.legH * 0.7, 3, quality === 'low' ? 6 : 12]} />
          <meshStandardMaterial color={PALETTE.oakDark} roughness={0.8} transparent={dimmed} opacity={opacity} />
        </mesh>
      ))}

      {/* Torso, carrying the role accent */}
      <mesh castShadow position={[0, shape.legH + shape.torsoH / 2, 0]}>
        {isRobot
          ? <boxGeometry args={[shape.torsoW, shape.torsoH, shape.torsoD]} />
          : <capsuleGeometry args={[shape.torsoW / 2, shape.torsoH * 0.62, 4, quality === 'low' ? 8 : 16]} />}
        <meshStandardMaterial color={accent} roughness={0.62} transparent={dimmed} opacity={opacity} />
      </mesh>

      {/* Shoulders, widening the broad silhouettes visibly. The rotation belongs
          on the mesh: a geometry has no transform of its own. */}
      <mesh
        castShadow
        position={[0, shape.legH + shape.torsoH * 0.92, 0]}
        rotation={[0, 0, Math.PI / 2]}
      >
        <capsuleGeometry args={[shape.shoulder, shape.torsoW * 0.8, 3, quality === 'low' ? 6 : 12]} />
        <meshStandardMaterial color={accent} roughness={0.62} transparent={dimmed} opacity={opacity} />
      </mesh>

      {/* Arms */}
      <group ref={armLeft} position={[-(shape.torsoW / 2 + 0.06), shape.legH + shape.torsoH * 0.86, 0]}>
        <mesh castShadow position={[0, -0.26, 0]}>
          <capsuleGeometry args={[0.062, 0.4, 3, quality === 'low' ? 6 : 10]} />
          <meshStandardMaterial color={accent} roughness={0.7} transparent={dimmed} opacity={opacity} />
        </mesh>
      </group>
      <group ref={armRight} position={[shape.torsoW / 2 + 0.06, shape.legH + shape.torsoH * 0.86, 0]}>
        <mesh castShadow position={[0, -0.26, 0]}>
          <capsuleGeometry args={[0.062, 0.4, 3, quality === 'low' ? 6 : 10]} />
          <meshStandardMaterial color={accent} roughness={0.7} transparent={dimmed} opacity={opacity} />
        </mesh>
        {/* The role accessory, held in the right hand. */}
        <Accessory roleId={presence.roleId} quality={quality} />
      </group>

      {/* Head */}
      <mesh castShadow position={[0, shape.legH + shape.torsoH + shape.headR + 0.06, 0]}>
        {isRobot
          ? <boxGeometry args={[shape.headR * 1.7, shape.headR * 1.7, shape.headR * 1.7]} />
          : <sphereGeometry args={[shape.headR, quality === 'low' ? 10 : 20, quality === 'low' ? 8 : 16]} />}
        <meshStandardMaterial
          color={isRobot ? PALETTE.metal : PALETTE.skin}
          roughness={isRobot ? 0.35 : 0.75}
          metalness={isRobot ? 0.5 : 0}
          transparent={dimmed}
          opacity={opacity}
        />
      </mesh>
      {isRobot && (
        <mesh position={[0, shape.legH + shape.torsoH + shape.headR * 2.4, 0]}>
          <capsuleGeometry args={[0.018, 0.14, 2, 6]} />
          <meshStandardMaterial color={PALETTE.metal} metalness={0.7} roughness={0.3} />
        </mesh>
      )}

      {/*
        Labels are DOM overlays rather than 3D text: selectable, screen-reader
        readable, scaling with the browser's font settings, and needing no font
        file at runtime.

        Only the SELECTED or HOVERED agent gets a full nameplate. Showing every
        agent's name and role at once buried the avatars behind a wall of text
        and made the office unreadable — the labels occluded the very thing they
        were labelling. Everyone else carries a small status chip, which keeps
        each agent identifiable at a glance without crowding the scene. The
        keyboard roster beside the canvas lists every agent unconditionally, so
        nothing is hidden from someone not using a pointer.
      */}
      {showNameplates && (selected || hovered ? (
        <Html
          position={[0, shape.legH + shape.torsoH + shape.headR * 2 + 0.46, 0]}
          center
          distanceFactor={11}
          zIndexRange={[30, 10]}
        >
          <button
            type="button"
            className={`nameplate${selected ? ' nameplate-selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); onSelect(presence.agentId); }}
            aria-label={`${presence.name}, ${role?.title ?? presence.roleId}. ${status.label}.${
              presence.activity.kind === 'working' ? ` Working on ${presence.activity.summary}.` : ''
            }`}
          >
            <span className="nameplate-glyph" style={{ color: status.color }} aria-hidden="true">
              {status.glyph}
            </span>
            <span className="nameplate-name">{presence.name}</span>
            <span className="nameplate-role">{role?.title ?? presence.roleId}</span>
          </button>
        </Html>
      ) : (
        <Html
          position={[0, shape.legH + shape.torsoH + shape.headR * 2 + 0.3, 0]}
          center
          distanceFactor={17}
          zIndexRange={[12, 0]}
        >
          <button
            type="button"
            className="name-chip"
            onClick={(e) => { e.stopPropagation(); onSelect(presence.agentId); }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            aria-label={`${presence.name}, ${role?.title ?? presence.roleId}. ${status.label}.`}
          >
            <span style={{ color: status.color }} aria-hidden="true">{status.glyph}</span>
            <span className="name-chip-text">{presence.name.split(' ')[0]}</span>
          </button>
        </Html>
      ))}

      {/* A generous invisible hit target, so clicking an avatar is not fiddly. */}
      <mesh
        position={[0, 0.9, 0]}
        onClick={(e) => { e.stopPropagation(); onSelect(presence.agentId); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
        visible={false}
      >
        <boxGeometry args={[0.9, 1.9, 0.9]} />
      </mesh>
    </group>
  );
}

/** A small distinguishing prop per role, built from primitives. */
function Accessory({ roleId, quality }: { roleId: string; quality: 'low' | 'medium' | 'high' }): React.JSX.Element | null {
  const segments = quality === 'low' ? 6 : 12;
  switch (roleId) {
    case 'chief-of-staff':
    case 'analytics-lead':
      return (
        <mesh position={[0.1, -0.44, 0.06]} rotation={[0.5, 0, 0]} castShadow>
          <boxGeometry args={[0.2, 0.28, 0.02]} />
          <meshStandardMaterial color="#2b2f36" roughness={0.4} />
        </mesh>
      );
    case 'procurement':
    case 'quality-assurance':
    case 'bookkeeping':
      return (
        <mesh position={[0.1, -0.44, 0.06]} rotation={[0.5, 0, 0]} castShadow>
          <boxGeometry args={[0.19, 0.26, 0.015]} />
          <meshStandardMaterial color={PALETTE.paper} roughness={0.9} />
        </mesh>
      );
    case 'market-analyst':
      return (
        <group position={[0.1, -0.46, 0.04]} rotation={[0.4, 0, 0]}>
          <mesh castShadow>
            <torusGeometry args={[0.07, 0.014, 6, segments]} />
            <meshStandardMaterial color={PALETTE.metal} metalness={0.6} roughness={0.3} />
          </mesh>
          <mesh position={[0, -0.11, 0]} castShadow>
            <capsuleGeometry args={[0.012, 0.1, 2, 6]} />
            <meshStandardMaterial color={PALETTE.oakDark} roughness={0.7} />
          </mesh>
        </group>
      );
    case 'logistics':
      return (
        <mesh position={[0.11, -0.44, 0.05]} castShadow>
          <boxGeometry args={[0.16, 0.16, 0.16]} />
          <meshStandardMaterial color={PALETTE.oak} roughness={0.85} />
        </mesh>
      );
    case 'finance-pricing':
      return (
        <mesh position={[0.1, -0.44, 0.05]} rotation={[0.5, 0, 0]} castShadow>
          <boxGeometry args={[0.12, 0.2, 0.025]} />
          <meshStandardMaterial color="#2f3a33" roughness={0.5} />
        </mesh>
      );
    case 'customer-support':
      // Headset: a band over the head is drawn by the caller's group offset.
      return (
        <mesh position={[0.09, -0.42, 0.04]} castShadow>
          <torusGeometry args={[0.05, 0.012, 6, segments]} />
          <meshStandardMaterial color="#32383d" roughness={0.4} />
        </mesh>
      );
    case 'challenger':
      return (
        <mesh position={[0.09, -0.46, 0.04]} rotation={[0, 0, 0.3]} castShadow>
          <capsuleGeometry args={[0.012, 0.16, 2, 6]} />
          <meshStandardMaterial color={PALETTE.coral} roughness={0.6} />
        </mesh>
      );
    case 'compliance-research':
    case 'cultural-reviewer':
      return (
        <mesh position={[0.1, -0.44, 0.05]} rotation={[0.4, 0, 0]} castShadow>
          <boxGeometry args={[0.17, 0.22, 0.05]} />
          <meshStandardMaterial color="#7d2430" roughness={0.7} />
        </mesh>
      );
    case 'brand-director':
    case 'merchandising':
      return (
        <mesh position={[0.09, -0.46, 0.04]} rotation={[0, 0, 0.25]} castShadow>
          <capsuleGeometry args={[0.013, 0.18, 2, 6]} />
          <meshStandardMaterial color={PALETTE.metal} metalness={0.5} roughness={0.35} />
        </mesh>
      );
    case 'china-sourcing':
      return (
        <mesh position={[0.1, -0.44, 0.05]} rotation={[0.45, 0, 0]} castShadow>
          <boxGeometry args={[0.2, 0.24, 0.035]} />
          <meshStandardMaterial color={PALETTE.amber} roughness={0.7} />
        </mesh>
      );
    default:
      return (
        <mesh position={[0.1, -0.44, 0.05]} rotation={[0.45, 0, 0]} castShadow>
          <boxGeometry args={[0.16, 0.22, 0.02]} />
          <meshStandardMaterial color={PALETTE.paper} roughness={0.9} />
        </mesh>
      );
  }
}
