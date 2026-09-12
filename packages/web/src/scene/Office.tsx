import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Vector3 } from 'three';
import { ZONE_LAYOUT, type AgentPresence, type ZoneSpec } from '@sqhq/shared';
import { Avatar } from './Avatar.js';
import { Room } from './Room.js';
import { PALETTE } from './palette.js';
import { deskOffset, zoneCentre } from './navigation.js';

export type Quality = 'low' | 'medium' | 'high';

export interface OfficeProps {
  readonly presence: readonly AgentPresence[];
  readonly selectedAgentId: string | null;
  readonly selectedZone: string | null;
  readonly badgeByZone: Readonly<Record<string, number>>;
  readonly quality: Quality;
  readonly reducedMotion: boolean;
  readonly showLabels: boolean;
  readonly followSelected: boolean;
  readonly paused: boolean;
  readonly resetSignal: number;
  readonly onSelectAgent: (agentId: string | null) => void;
  readonly onOpenZone: (spec: ZoneSpec) => void;
  readonly onOpenPrototype: () => void;
}

/**
 * The 3D office.
 *
 * Real WebGL: perspective camera on an orbit rig, a directional key light with
 * a shadow map, and geometry for every room, desk and agent. Nothing here is a
 * CSS transform, a sprite or a video.
 */
export function Office(props: OfficeProps): React.JSX.Element {
  const { quality, paused } = props;
  return (
    <Canvas
      shadows={quality !== 'low'}
      dpr={quality === 'high' ? [1, 2] : [1, 1.25]}
      // `demand` means the scene renders when something changes or a frame is
      // explicitly requested, so a still office costs nothing.
      frameloop={paused ? 'never' : 'always'}
      camera={{ position: [30, 27, 34], fov: 30, near: 0.5, far: 220 }}
      gl={{ antialias: quality !== 'low', powerPreference: 'high-performance' }}
      onPointerMissed={() => props.onSelectAgent(null)}
      aria-label="Three-dimensional office view. An equivalent table view is available."
    >
      <SceneContents {...props} />
    </Canvas>
  );
}

function SceneContents({
  presence, selectedAgentId, selectedZone, badgeByZone, quality, reducedMotion,
  showLabels, followSelected, resetSignal, onSelectAgent, onOpenZone, onOpenPrototype,
}: OfficeProps): React.JSX.Element {
  const controls = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();

  // Group agents by zone so desks are allocated deterministically and two
  // agents never occupy the same square metre.
  const offsets = useMemo(() => {
    const byZone = new Map<string, AgentPresence[]>();
    for (const agent of presence) {
      const list = byZone.get(agent.zone) ?? [];
      list.push(agent);
      byZone.set(agent.zone, list);
    }
    const result = new Map<string, readonly [number, number, number]>();
    for (const [, agents] of byZone) {
      agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
      agents.forEach((agent, index) => {
        result.set(agent.agentId, deskOffset(index, agents.length));
      });
    }
    return result;
  }, [presence]);

  /* Reset the camera on request. */
  useEffect(() => {
    if (resetSignal === 0) return;
    camera.position.set(30, 27, 34);
    controls.current?.target.set(0, 0, 1.75);
    controls.current?.update();
  }, [resetSignal, camera]);

  /* Focus the selected agent once when selection changes. */
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (selectedAgentId === null || selectedAgentId === lastFocused.current) return;
    lastFocused.current = selectedAgentId;
    const agent = presence.find((a) => a.agentId === selectedAgentId);
    if (agent === undefined) return;
    const [x, , z] = zoneCentre(agent.zone);
    controls.current?.target.set(x, 0.9, z);
    controls.current?.update();
  }, [selectedAgentId, presence]);

  /* Optional follow. Never forces the camera when the user has not asked. */
  const followTarget = useRef(new Vector3());
  useFrame(() => {
    if (!followSelected || selectedAgentId === null) return;
    const agent = presence.find((a) => a.agentId === selectedAgentId);
    if (agent === undefined || controls.current === null) return;
    const [x, , z] = zoneCentre(agent.zone);
    followTarget.current.set(x, 0.9, z);
    controls.current.target.lerp(followTarget.current, 0.06);
    controls.current.update();
  });

  return (
    <>
      {/* Warm daylight: a soft fill plus one directional key casting shadows. */}
      <color attach="background" args={[PALETTE.ground]} />
      <hemisphereLight args={['#fff6e8', '#cbbfae', 1.05]} />
      <directionalLight
        position={[18, 26, 12]}
        intensity={1.5}
        color="#fff1dc"
        castShadow={quality !== 'low'}
        shadow-mapSize-width={quality === 'high' ? 2048 : 1024}
        shadow-mapSize-height={quality === 'high' ? 2048 : 1024}
        shadow-camera-left={-34}
        shadow-camera-right={34}
        shadow-camera-top={34}
        shadow-camera-bottom={-34}
        shadow-bias={-0.0005}
      />
      <directionalLight position={[-14, 12, -10]} intensity={0.35} color="#dfe8ff" />

      {/* Surrounding ground */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.3, 1]}>
        <planeGeometry args={[90, 80]} />
        <meshStandardMaterial color={PALETTE.ground} roughness={0.96} />
      </mesh>

      {/*
        A raised podium the rooms sit on. Without it the floor plates read as
        decals painted on an infinite plane; with it the office reads as a
        building with an edge, which is what makes the isometric view feel like
        a miniature campus rather than a diagram.
      */}
      <mesh receiveShadow castShadow position={[0, -0.15, 1.75]}>
        <boxGeometry args={[32, 0.3, 30]} />
        <meshStandardMaterial color={PALETTE.groundRim} roughness={0.9} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 1.75]}>
        <planeGeometry args={[31.4, 29.4]} />
        <meshStandardMaterial color={PALETTE.floorEdge} roughness={0.94} />
      </mesh>

      {ZONE_LAYOUT.map((spec) => (
        <Room
          key={spec.zone}
          spec={spec}
          selected={selectedZone === spec.zone}
          badgeCount={badgeByZone[spec.zone] ?? 0}
          quality={quality}
          showLabels={showLabels}
          onOpen={onOpenZone}
          {...(spec.zone === 'productLab' ? { onOpenPrototype: () => onOpenPrototype() } : {})}
        />
      ))}

      {presence.map((agent) => (
        <Avatar
          key={agent.agentId}
          presence={agent}
          offset={offsets.get(agent.agentId) ?? [0, 0, 0]}
          selected={agent.agentId === selectedAgentId}
          reducedMotion={reducedMotion}
          showNameplates={showLabels}
          quality={quality}
          onSelect={onSelectAgent}
        />
      ))}

      <OrbitControls
        ref={controls}
        target={[0, 0, 1.75]}
        enableDamping
        dampingFactor={0.08}
        // Keep the camera above the floor plane so the office is always read
        // from above, which is what makes the layout legible.
        minPolarAngle={0.15}
        maxPolarAngle={Math.PI / 2.35}
        minDistance={8}
        maxDistance={80}
        makeDefault
      />
    </>
  );
}
