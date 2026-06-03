"use client";

import React, { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import VelocityZmqListener, { DecodePacket } from "../ZmqListener";
import ZmqClient from "../ZmqClient";

const BCI_ACCUMULATOR_SCALE = 0.015;
const BCI_FRAME_SCALE = 0.0015;
const BCI_MOVE_SCALE = 0.01;
const BCI_MOVE_DECAY_PER_SEC = 3;

// ─── Types ───────────────────────────────────────────────────────────────────

type Vec3 = [number, number, number];
type Phase = "settings" | "running" | "results";
type StretchBehavior = "basic" | "small" | "erratic" | "multihit";
type InputMode = "gamepad" | "bci_aim" | "bci_move";

interface Wall { pos: Vec3; size: Vec3 }
interface JumpBlock { pos: Vec3; size: Vec3 }
interface FloorTile { pos: Vec3; size: [number, number] }
interface GateDef {
  tileIndex: number;
  sideWalls: Wall[];
  gateInsert: Wall;
}
interface StretchDef {
  walls: Wall[];
  gates: GateDef[];
  blocks: JumpBlock[];
  floors: FloorTile[];
  platform: Vec3;
  platformSize: number;
  corridorWidth: number;
  playerStart: Vec3;
  playerYaw: number;
  targetRadius: number;
  hitsRequired: number;
  behavior: StretchBehavior;
  mazeTargets: Vec3[];
  targetTiles: number[];
}

interface ArrowInfo { visible: boolean; x: number; y: number; angle: number }

interface StretchResult {
  time: number;
  shots: number;
  hits: number;
  wallHits: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PLAYER_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.3;
const MOVE_SPEED = 6;
const JUMP_VELOCITY = 5.5;
const GRAVITY = -12;
const GROUND_Y = 0;
const WALL_HEIGHT = 1;
const WALL_THICKNESS = 0.3;
const CORRIDOR_WIDTH = 5;
const PLATFORM_SIZE = 3;
const PLATFORM_HEIGHT = 0.15;

// Tile 0 hosts 4 targets (warm-up), tiles 1-8 each host 1 target.
const TARGET_TILE_SEQUENCE: number[] = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const TARGETS_PER_STRETCH = TARGET_TILE_SEQUENCE.length;
const SENSITIVITY_BASE = 0.035;

const PITCH_LIMIT = Math.PI / 2.2;

// ─── Stretch Definitions ─────────────────────────────────────────────────────
// 9-square S-shaped path: forward, forward, right, right, forward, forward, left, left, forward

const TILE_GRID: [number, number][] = [
  [0, 0], [0, 1], [1, 1], [2, 1],
  [2, 2], [2, 3], [1, 3], [0, 3],
  [0, 4],
];

// Target offsets in [col, row] grid units, parallel to TARGET_TILE_SEQUENCE.
const TARGET_OFFSETS: [number, number][] = [
  [-1.5, 0],
  [1.5, 0],
  [-1, -1.2],
  [1, -1.2],
  [-1.5, 1],
  [1, -0.5],
  [3.5, 1],
  [3.5, 2],
  [3.5, 3],
  [1, 4.5],
  [-1.5, 3],
  [-1.5, 4.5],
];

function buildStretch(
  targetRadius: number,
  hitsRequired: number,
  behavior: StretchBehavior,
  platformSize: number,
  corridorWidth: number,
): StretchDef {
  const walls: Wall[] = [];
  const floors: FloorTile[] = [];
  const ts = corridorWidth;
  const hw = ts / 2;
  const wt = WALL_THICKNESS;
  const H = WALL_HEIGHT;

  const pathMap = new Map<string, number>();
  for (let i = 0; i < TILE_GRID.length; i++) {
    pathMap.set(`${TILE_GRID[i][0]},${TILE_GRID[i][1]}`, i);
  }
  const isNeighbor = (i: number, col: number, row: number) => {
    const j = pathMap.get(`${col},${row}`);
    return j !== undefined && Math.abs(j - i) === 1;
  };

  const gates: GateDef[] = [];
  const gateOpening = ts * 0.4;
  const gateWallLen = (ts - gateOpening) / 2;
  const gatedEdges = new Set<string>();

  const addGate = (tileIdx: number, edgeKey: string, sideWalls: Wall[], gateInsert: Wall) => {
    if (gatedEdges.has(edgeKey)) return;
    gatedEdges.add(edgeKey);
    gates.push({ tileIndex: tileIdx, sideWalls, gateInsert });
  };

  for (let i = 0; i < TILE_GRID.length; i++) {
    const [col, row] = TILE_GRID[i];
    const cx = col * ts;
    const cz = -row * ts;
    const isLast = i === TILE_GRID.length - 1;

    floors.push({ pos: [cx, 0.01, cz], size: [ts, ts] });

    // North edge (z-)
    if (isNeighbor(i, col, row + 1)) {
      const j = pathMap.get(`${col},${row + 1}`)!;
      addGate(Math.min(i, j), `h:${col},${Math.max(row, row + 1)}`,
        [{ pos: [cx - hw + gateWallLen / 2, H / 2, cz - hw], size: [gateWallLen, H, wt] },
         { pos: [cx + hw - gateWallLen / 2, H / 2, cz - hw], size: [gateWallLen, H, wt] }],
        { pos: [cx, H / 2, cz - hw], size: [gateOpening, H, wt] });
    } else if (!isLast) {
      walls.push({ pos: [cx, H / 2, cz - hw], size: [ts + wt, H, wt] });
    }

    // South edge (z+)
    if (isNeighbor(i, col, row - 1)) {
      const j = pathMap.get(`${col},${row - 1}`)!;
      addGate(Math.min(i, j), `h:${col},${Math.max(row, row - 1)}`,
        [{ pos: [cx - hw + gateWallLen / 2, H / 2, cz + hw], size: [gateWallLen, H, wt] },
         { pos: [cx + hw - gateWallLen / 2, H / 2, cz + hw], size: [gateWallLen, H, wt] }],
        { pos: [cx, H / 2, cz + hw], size: [gateOpening, H, wt] });
    } else {
      walls.push({ pos: [cx, H / 2, cz + hw], size: [ts + wt, H, wt] });
    }

    // East edge (x+)
    if (isNeighbor(i, col + 1, row)) {
      const j = pathMap.get(`${col + 1},${row}`)!;
      addGate(Math.min(i, j), `v:${Math.max(col, col + 1)},${row}`,
        [{ pos: [cx + hw, H / 2, cz - hw + gateWallLen / 2], size: [wt, H, gateWallLen] },
         { pos: [cx + hw, H / 2, cz + hw - gateWallLen / 2], size: [wt, H, gateWallLen] }],
        { pos: [cx + hw, H / 2, cz], size: [wt, H, gateOpening] });
    } else {
      walls.push({ pos: [cx + hw, H / 2, cz], size: [wt, H, ts + wt] });
    }

    // West edge (x-)
    if (isNeighbor(i, col - 1, row)) {
      const j = pathMap.get(`${col - 1},${row}`)!;
      addGate(Math.min(i, j), `v:${Math.max(col, col - 1)},${row}`,
        [{ pos: [cx - hw, H / 2, cz - hw + gateWallLen / 2], size: [wt, H, gateWallLen] },
         { pos: [cx - hw, H / 2, cz + hw - gateWallLen / 2], size: [wt, H, gateWallLen] }],
        { pos: [cx - hw, H / 2, cz], size: [wt, H, gateOpening] });
    } else {
      walls.push({ pos: [cx - hw, H / 2, cz], size: [wt, H, ts + wt] });
    }
  }

  // Platform area after tile 9
  const [lastCol, lastRow] = TILE_GRID[TILE_GRID.length - 1];
  const px = lastCol * ts;
  const pz = -(lastRow + 1) * ts;
  const lastIdx = TILE_GRID.length - 1;

  floors.push({ pos: [px, 0.01, pz], size: [ts, ts] });
  walls.push({ pos: [px, H / 2, pz - hw], size: [ts + wt, H, wt] });
  walls.push({ pos: [px + hw, H / 2, pz], size: [wt, H, ts + wt] });
  walls.push({ pos: [px - hw, H / 2, pz], size: [wt, H, ts + wt] });
  // Gate between tile 9 and platform area
  gates.push({
    tileIndex: lastIdx,
    sideWalls: [
      { pos: [px - hw + gateWallLen / 2, H / 2, pz + hw], size: [gateWallLen, H, wt] },
      { pos: [px + hw - gateWallLen / 2, H / 2, pz + hw], size: [gateWallLen, H, wt] },
    ],
    gateInsert: { pos: [px, H / 2, pz + hw], size: [gateOpening, H, wt] },
  });

  const mazeTargets: Vec3[] = TARGET_OFFSETS.map(([c, r]) => [
    c * ts,
    0.5 + Math.random() * 1.5,
    -r * ts,
  ] as Vec3);
  const targetTiles: number[] = [...TARGET_TILE_SEQUENCE];

  return {
    walls,
    gates,
    blocks: [],
    floors,
    platform: [px, PLATFORM_HEIGHT / 2, pz],
    platformSize,
    corridorWidth,
    playerStart: [0, PLAYER_HEIGHT, 0],
    playerYaw: 0,
    targetRadius,
    hitsRequired,
    behavior,
    mazeTargets,
    targetTiles,
  };
}

const STRETCH_CONFIGS = [
  { radius: 0.35, hits: 1, behavior: "basic" as StretchBehavior, platSize: 3.0, corridor: 8 },
  { radius: 0.12, hits: 1, behavior: "small" as StretchBehavior, platSize: 2.0, corridor: 6 },
  { radius: 0.10, hits: 1, behavior: "erratic" as StretchBehavior, platSize: 1.2, corridor: 4.5 },
  { radius: 0.15, hits: 3, behavior: "multihit" as StretchBehavior, platSize: 0.8, corridor: 3 },
];

function buildStretches(walkwayMult: number): StretchDef[] {
  return STRETCH_CONFIGS.map(c =>
    buildStretch(c.radius, c.hits, c.behavior, c.platSize, c.corridor * walkwayMult)
  );
}


// ─── Collision helpers ───────────────────────────────────────────────────────

function aabbCollision(
  px: number, pz: number, pr: number,
  bx: number, bz: number, bw: number, bd: number,
): boolean {
  const closestX = Math.max(bx - bw / 2, Math.min(px, bx + bw / 2));
  const closestZ = Math.max(bz - bd / 2, Math.min(pz, bz + bd / 2));
  const dx = px - closestX;
  const dz = pz - closestZ;
  return (dx * dx + dz * dz) < (pr * pr);
}

function resolveCollision(
  px: number, pz: number, pr: number,
  bx: number, bz: number, bw: number, bd: number,
): [number, number] {
  const closestX = Math.max(bx - bw / 2, Math.min(px, bx + bw / 2));
  const closestZ = Math.max(bz - bd / 2, Math.min(pz, bz + bd / 2));
  const dx = px - closestX;
  const dz = pz - closestZ;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.0001) return [px + pr, pz];
  const nx = dx / dist;
  const nz = dz / dist;
  const pen = pr - dist;
  return [px + nx * pen, pz + nz * pen];
}

// ─── Hit detection ───────────────────────────────────────────────────────────

function isTargetHit(scene: THREE.Scene, camera: THREE.Camera, raycaster: THREE.Raycaster): boolean {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const intersects = raycaster.intersectObjects(scene.children, true);
  for (const intersect of intersects) {
    if ((intersect.object as any).__isTarget) return true;
  }
  return false;
}

// ─── Buzzer sound (wall collision) ───────────────────────────────────────────

function playBuzz(audioCtx: React.MutableRefObject<AudioContext | null>) {
  if (!audioCtx.current) audioCtx.current = new AudioContext();
  const ctx = audioCtx.current;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(120, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(80, ctx.currentTime + 0.25);
  gain.gain.setValueAtTime(0.4, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.25);
}

// ─── Pop sound ───────────────────────────────────────────────────────────────

function playPop(audioCtx: React.MutableRefObject<AudioContext | null>) {
  if (!audioCtx.current) audioCtx.current = new AudioContext();
  const ctx = audioCtx.current;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.15);
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.15);
}

// ─── 3D Components ──────────────────────────────────────────────────────────

const FLOOR_PALETTE = [
  new THREE.Color("#2d4a3e"),  // deep forest teal
  new THREE.Color("#3b5249"),  // sage
  new THREE.Color("#4a3f35"),  // warm umber
  new THREE.Color("#3d4f5f"),  // dusty slate blue
  new THREE.Color("#4e3d2d"),  // terracotta brown
  new THREE.Color("#2e3d4a"),  // evening teal
  new THREE.Color("#3f4a3a"),  // moss
  new THREE.Color("#4a3a3f"),  // muted plum earth
];

function PlayerHighlight({ floors, playerRef }: {
  floors: FloorTile[];
  playerRef: React.MutableRefObject<{ x: number; y: number; z: number; vy: number; grounded: boolean }>;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!meshRef.current) return;
    const p = playerRef.current;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (Math.abs(p.x - f.pos[0]) < f.size[0] / 2 && Math.abs(p.z - f.pos[2]) < f.size[1] / 2) {
        const dx = p.x - f.pos[0];
        const dz = p.z - f.pos[2];
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; best = i; }
      }
    }
    if (best >= 0) {
      const f = floors[best];
      meshRef.current.position.set(f.pos[0], 0.02, f.pos[2]);
      meshRef.current.scale.set(f.size[0], f.size[1], 1);
      meshRef.current.visible = true;
    } else {
      meshRef.current.visible = false;
    }
  });

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.12} depthWrite={false} />
    </mesh>
  );
}

function GateInsertMesh({ wall }: { wall: Wall }) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (matRef.current) {
      const t = clock.getElapsedTime();
      matRef.current.emissiveIntensity = 0.18 + Math.sin(t * 1.8) * 0.08;
    }
  });
  return (
    <mesh position={wall.pos}>
      <boxGeometry args={wall.size} />
      <meshStandardMaterial
        ref={matRef}
        color="#a89484"
        emissive="#8a6a4a"
        emissiveIntensity={0.18}
      />
    </mesh>
  );
}

function MazeGeometry({ walls, gateInserts, floors, wallFlash, playerRef }: {
  walls: Wall[];
  gateInserts: Wall[];
  floors: FloorTile[];
  wallFlash: boolean;
  playerRef: React.MutableRefObject<{ x: number; y: number; z: number; vy: number; grounded: boolean }>;
}) {
  return (
    <group>
      {floors.map((f, i) => (
        <mesh key={`floor-${i}`} rotation={[-Math.PI / 2, 0, 0]} position={f.pos}>
          <planeGeometry args={f.size} />
          <meshStandardMaterial color={FLOOR_PALETTE[i % FLOOR_PALETTE.length]} />
        </mesh>
      ))}
      <PlayerHighlight floors={floors} playerRef={playerRef} />
      {walls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos}>
          <boxGeometry args={w.size} />
          <meshStandardMaterial
            color={wallFlash ? "#cc2222" : "#6666aa"}
            emissive={wallFlash ? "#ff0000" : "#333366"}
            emissiveIntensity={wallFlash ? 0.8 : 0.3}
          />
        </mesh>
      ))}
      {gateInserts.map((g, i) => (
        <GateInsertMesh key={`gate-${i}`} wall={g} />
      ))}
    </group>
  );
}

function BenchmarkTarget({ position, radius, hitProgress, behavior }: {
  position: Vec3;
  radius: number;
  hitProgress: number;
  behavior: StretchBehavior;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const erraticSeed = useRef({
    f1: 0.8 + Math.random() * 1.0,
    f2: 1.0 + Math.random() * 1.0,
    f3: 0.6 + Math.random() * 1.0,
    p1: Math.random() * Math.PI * 2,
    p2: Math.random() * Math.PI * 2,
    p3: Math.random() * Math.PI * 2,
  });

  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    if (meshRef.current) (meshRef.current as any).__isTarget = true;
  }, []);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    if (behavior === "erratic" || behavior === "multihit") {
      const s = erraticSeed.current;
      groupRef.current.position.x = position[0] + Math.sin(t * s.f1 + s.p1) * 0.35;
      groupRef.current.position.y = position[1] + Math.sin(t * s.f2 + s.p2) * 0.25;
      groupRef.current.position.z = position[2] + Math.cos(t * s.f3 + s.p3) * 0.35;
    }
    // basic and small: no movement, targets stay still
  });

  const hp = hitProgress;
  const r = Math.round(255 - hp * 155);
  const g = Math.round(34 + hp * 100);
  const b = Math.round(102 + hp * 50);
  const color = `rgb(${r},${g},${b})`;
  const emissive = `rgb(${Math.round(255 - hp * 180)},${Math.round(0 + hp * 40)},${Math.round(68 + hp * 40)})`;

  return (
    <group ref={groupRef} position={position}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[radius, 32, 32]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.8 - hp * 0.5} />
      </mesh>
    </group>
  );
}

const _projected = new THREE.Vector3();

function DirectionSensor({ targetPos, arrowRef }: {
  targetPos: Vec3;
  arrowRef: React.MutableRefObject<ArrowInfo>;
}) {
  const { camera } = useThree();

  useFrame(() => {
    _projected.set(targetPos[0], targetPos[1], targetPos[2]).project(camera);

    const onScreen = _projected.z > 0 && _projected.z < 1
      && Math.abs(_projected.x) < 0.85 && Math.abs(_projected.y) < 0.85;

    if (onScreen) {
      arrowRef.current = { visible: false, x: 0, y: 0, angle: 0 };
      return;
    }

    let sx = _projected.x;
    let sy = -_projected.y;
    if (_projected.z > 1 || _projected.z < 0) {
      sx = -sx;
      sy = -sy;
    }

    const angle = Math.atan2(sy, sx);
    const margin = 50;
    const halfW = window.innerWidth / 2 - margin;
    const halfH = window.innerHeight / 2 - margin;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const scale = Math.min(
      halfW / (Math.abs(cos) || 0.001),
      halfH / (Math.abs(sin) || 0.001),
    );

    arrowRef.current = {
      visible: true,
      x: window.innerWidth / 2 + cos * scale,
      y: window.innerHeight / 2 + sin * scale,
      angle,
    };
  });

  return null;
}

function DirectionArrow({ active, arrowRef }: {
  active: boolean;
  arrowRef: React.MutableRefObject<ArrowInfo>;
}) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    let raf: number;
    const update = () => {
      if (elRef.current) {
        const a = arrowRef.current;
        if (!a.visible) {
          elRef.current.style.display = "none";
        } else {
          elRef.current.style.display = "block";
          elRef.current.style.left = `${a.x}px`;
          elRef.current.style.top = `${a.y}px`;
          elRef.current.style.transform = `translate(-50%, -50%) rotate(${a.angle}rad)`;
        }
      }
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [active, arrowRef]);

  if (!active) return null;

  return (
    <div ref={elRef} style={{
      position: "fixed",
      zIndex: 11,
      pointerEvents: "none",
      display: "none",
      fontSize: "32px",
      color: "#ff2266",
      textShadow: "0 0 12px rgba(255,34,102,0.8)",
      fontFamily: "monospace",
      fontWeight: "bold",
    }}>
      ▶
    </div>
  );
}

function ShootHandler({ onShot, onHit, gamepadSlotRef }: {
  onShot: () => void;
  onHit: () => void;
  gamepadSlotRef: React.MutableRefObject<number>;
}) {
  const { camera, scene } = useThree();
  const raycaster = useRef(new THREE.Raycaster());
  const prevButtonStates = useRef<boolean[]>([]);

  const fireShot = useCallback(() => {
    onShot();
    if (isTargetHit(scene, camera, raycaster.current)) {
      onHit();
    }
  }, [camera, scene, onShot, onHit]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      fireShot();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [fireShot]);

  useFrame(() => {
    const gp = navigator.getGamepads()[gamepadSlotRef.current];
    if (!gp) {
      prevButtonStates.current = [];
      return;
    }
    let rising = false;
    for (let i = 0; i < gp.buttons.length; i++) {
      const pressed = gp.buttons[i]?.pressed || false;
      const wasPressed = prevButtonStates.current[i] || false;
      if (pressed && !wasPressed) rising = true;
      prevButtonStates.current[i] = pressed;
    }
    if (rising) fireShot();
  });

  return null;
}

function PlayerController({
  playerRef,
  eulerRef,
  gamepadRef,
  bciDeltaRef,
  bciMoveRef,
  walls,
  blocks,
  floors,
  sensitivityRef,
  stretchStart,
  onWallBreach,
}: {
  playerRef: React.MutableRefObject<{ x: number; y: number; z: number; vy: number; grounded: boolean }>;
  eulerRef: React.MutableRefObject<THREE.Euler>;
  gamepadRef: React.MutableRefObject<{ lx: number; ly: number; rx: number; ry: number }>;
  bciDeltaRef: React.MutableRefObject<{ x: number; y: number }>;
  bciMoveRef: React.MutableRefObject<{ x: number; y: number }>;
  walls: Wall[];
  blocks: JumpBlock[];
  floors: FloorTile[];
  sensitivityRef: React.MutableRefObject<number>;
  stretchStart: Vec3;
  onWallBreach: () => void;
}) {
  const { camera } = useThree();

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const p = playerRef.current;
    const gp = gamepadRef.current;

    const sens = SENSITIVITY_BASE * sensitivityRef.current;
    eulerRef.current.y -= gp.rx * sens;
    eulerRef.current.x -= gp.ry * sens;

    const bdx = bciDeltaRef.current.x;
    const bdy = bciDeltaRef.current.y;
    if (bdx !== 0 || bdy !== 0) {
      const bciSens = BCI_FRAME_SCALE * sensitivityRef.current;
      eulerRef.current.y -= bdx * bciSens;
      eulerRef.current.x -= bdy * bciSens;
      bciDeltaRef.current.x = 0;
      bciDeltaRef.current.y = 0;
    }

    eulerRef.current.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, eulerRef.current.x));
    camera.quaternion.setFromEuler(eulerRef.current);

    const moveDecay = Math.exp(-BCI_MOVE_DECAY_PER_SEC * dt);
    bciMoveRef.current.x *= moveDecay;
    bciMoveRef.current.y *= moveDecay;

    const yaw = eulerRef.current.y;
    const lx = gp.lx + bciMoveRef.current.x;
    const ly = gp.ly + bciMoveRef.current.y;
    const forward = -ly;
    const strafe = lx;
    const moveX = (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * MOVE_SPEED * dt;
    const moveZ = (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * MOVE_SPEED * dt;

    let nx = p.x + moveX;
    let nz = p.z + moveZ;

    // Detect wall contact — touching a wall snaps player to nearest corridor center
    let hitWall = false;
    for (const w of walls) {
      if (aabbCollision(nx, nz, PLAYER_RADIUS, w.pos[0], w.pos[2], w.size[0], w.size[2])) {
        hitWall = true;
        break;
      }
    }

    if (hitWall) {
      onWallBreach();
      let bestDist = Infinity;
      let bestX = nx, bestZ = nz;
      for (const f of floors) {
        const dx = nx - f.pos[0];
        const dz = nz - f.pos[2];
        const dist = dx * dx + dz * dz;
        if (dist < bestDist) {
          bestDist = dist;
          bestX = f.pos[0];
          bestZ = f.pos[2];
        }
      }
      nx = bestX;
      nz = bestZ;
    }

    const allObstacles = [...walls, ...blocks];
    for (const obs of allObstacles) {
      if (p.y - PLAYER_HEIGHT >= obs.pos[1] + obs.size[1] / 2 - 0.1) continue;
      if (aabbCollision(nx, nz, PLAYER_RADIUS, obs.pos[0], obs.pos[2], obs.size[0], obs.size[2])) {
        [nx, nz] = resolveCollision(nx, nz, PLAYER_RADIUS, obs.pos[0], obs.pos[2], obs.size[0], obs.size[2]);
      }
    }

    p.x = nx;
    p.z = nz;

    p.vy += GRAVITY * dt;
    p.y += p.vy * dt;

    let floorY = GROUND_Y + PLAYER_HEIGHT;
    for (const b of blocks) {
      const hx = b.size[0] / 2;
      const hz = b.size[2] / 2;
      if (p.x > b.pos[0] - hx && p.x < b.pos[0] + hx &&
          p.z > b.pos[2] - hz && p.z < b.pos[2] + hz) {
        const topY = b.pos[1] + b.size[1] / 2 + PLAYER_HEIGHT;
        if (p.y <= topY && p.y > topY - 0.5 && p.vy <= 0) {
          floorY = Math.max(floorY, topY);
        }
      }
    }

    if (p.y <= floorY) {
      p.y = floorY;
      p.vy = 0;
      p.grounded = true;
    }

    if (p.y < -5) {
      p.x = stretchStart[0];
      p.y = stretchStart[1];
      p.z = stretchStart[2];
      p.vy = 0;
      p.grounded = true;
    }

    camera.position.set(p.x, p.y, p.z);
  });

  return null;
}

const STAR_COUNT = 300;

function Stars() {
  const positions = useMemo(() => {
    const pos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 80 + Math.random() * 20;
      pos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      pos[i * 3 + 1] = Math.abs(Math.sin(phi) * Math.sin(theta) * r);
      pos[i * 3 + 2] = Math.cos(phi) * r;
    }
    return pos;
  }, []);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.06} color="#aaaaff" transparent opacity={0.35} sizeAttenuation />
    </points>
  );
}

// ─── Scene Composer ──────────────────────────────────────────────────────────

function BenchmarkScene({
  stretch,
  targetsHit,
  targetPos,
  targetRadius,
  showTarget,
  hitProgress,
  behavior,
  playerRef,
  eulerRef,
  gamepadRef,
  gamepadSlotRef,
  bciDeltaRef,
  bciMoveRef,
  arrowRef,
  sensitivityRef,
  onShot,
  onHit,
  onWallBreach,
  wallFlash,
}: {
  stretch: StretchDef;
  targetsHit: number;
  targetPos: Vec3 | null;
  targetRadius: number;
  showTarget: boolean;
  hitProgress: number;
  behavior: StretchBehavior;
  playerRef: React.MutableRefObject<{ x: number; y: number; z: number; vy: number; grounded: boolean }>;
  eulerRef: React.MutableRefObject<THREE.Euler>;
  gamepadRef: React.MutableRefObject<{ lx: number; ly: number; rx: number; ry: number }>;
  gamepadSlotRef: React.MutableRefObject<number>;
  bciDeltaRef: React.MutableRefObject<{ x: number; y: number }>;
  bciMoveRef: React.MutableRefObject<{ x: number; y: number }>;
  arrowRef: React.MutableRefObject<ArrowInfo>;
  sensitivityRef: React.MutableRefObject<number>;
  wallFlash: boolean;
  onShot: () => void;
  onHit: () => void;
  onWallBreach: () => void;
}) {
  const renderedWalls = useMemo(() => {
    const sideWalls = stretch.gates.flatMap(g => g.sideWalls);
    return [...stretch.walls, ...sideWalls];
  }, [stretch]);

  const currentTile = stretch.targetTiles[targetsHit] ?? TILE_GRID.length;
  const closedGateInserts = useMemo(
    () => stretch.gates.filter(g => currentTile <= g.tileIndex).map(g => g.gateInsert),
    [stretch, currentTile]
  );

  const collisionWalls = useMemo(
    () => [...renderedWalls, ...closedGateInserts],
    [renderedWalls, closedGateInserts]
  );

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.0} />
      <pointLight position={[0, 8, 0]} intensity={0.4} color="#4444ff" />
      <Stars />
      <MazeGeometry walls={renderedWalls} gateInserts={closedGateInserts} floors={stretch.floors} wallFlash={wallFlash} playerRef={playerRef} />
      {showTarget && targetPos && (
        <>
          <BenchmarkTarget
            position={targetPos}
            radius={targetRadius}
            hitProgress={hitProgress}
            behavior={behavior}
          />
          <DirectionSensor targetPos={targetPos} arrowRef={arrowRef} />
        </>
      )}
      <ShootHandler onShot={onShot} onHit={onHit} gamepadSlotRef={gamepadSlotRef} />
      <PlayerController
        playerRef={playerRef}
        eulerRef={eulerRef}
        gamepadRef={gamepadRef}
        bciDeltaRef={bciDeltaRef}
        bciMoveRef={bciMoveRef}
        walls={collisionWalls}
        blocks={stretch.blocks}
        floors={stretch.floors}
        sensitivityRef={sensitivityRef}
        stretchStart={stretch.playerStart}
        onWallBreach={onWallBreach}
      />
    </>
  );
}

// ─── UI Styles ───────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  color: "#ccc",
  fontFamily: "monospace",
  fontSize: "14px",
  marginBottom: 4,
};

const SLIDER: React.CSSProperties = {
  width: "100%",
  accentColor: "#ff2266",
  cursor: "pointer",
};

// ─── Crosshair ───────────────────────────────────────────────────────────────

function Crosshair({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div style={{
      position: "absolute",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: 10,
      pointerEvents: "none",
    }}>
      <div style={{ width: 2, height: 20, background: "rgba(0,255,0,0.9)", position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
      <div style={{ width: 20, height: 2, background: "rgba(0,255,0,0.9)", position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
    </div>
  );
}

// ─── HUD ─────────────────────────────────────────────────────────────────────

function HUD({ phase, stretchIdx, elapsed, shots, hits, targetsHit, wallCollisions }: {
  phase: Phase;
  stretchIdx: number;
  elapsed: number;
  shots: number;
  hits: number;
  targetsHit: number;
  wallCollisions: number;
}) {
  if (phase !== "running") return null;
  const acc = shots > 0 ? Math.round((hits / shots) * 100) : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;

  return (
    <div style={{
      position: "absolute",
      top: 16,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 20,
      pointerEvents: "none",
      display: "flex",
      gap: 24,
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#fff",
      textShadow: "0 0 8px rgba(0,0,0,0.8)",
    }}>
      <div>Stretch <span style={{ color: "#ff2266" }}>{stretchIdx + 1}</span>/4</div>
      <div>Time: {timeStr}</div>
      <div>Targets: {targetsHit}/{TARGETS_PER_STRETCH}</div>
      <div>Accuracy: {acc}%</div>
      <div>Wall Hits: <span style={{ color: wallCollisions === 0 ? "#00ff66" : "#ff2266" }}>{wallCollisions}</span></div>
    </div>
  );
}

// ─── Results Screen ──────────────────────────────────────────────────────────

function ResultsScreen({ results, totalTime, onRestart }: {
  results: StretchResult[];
  totalTime: number;
  onRestart: () => void;
}) {
  const totalShots = results.reduce((s, r) => s + r.shots, 0);
  const totalHits = results.reduce((s, r) => s + r.hits, 0);
  const totalWallHits = results.reduce((s, r) => s + r.wallHits, 0);
  const totalAcc = totalShots > 0 ? Math.round((totalHits / totalShots) * 100) : 0;
  const mins = Math.floor(totalTime / 60);
  const secs = totalTime % 60;

  return (
    <div style={{
      position: "absolute",
      inset: 0,
      zIndex: 30,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.85)",
    }}>
      <div style={{
        background: "rgba(20,20,40,0.95)",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: 12,
        padding: 32,
        maxWidth: 500,
        width: "90%",
        fontFamily: "monospace",
        color: "#fff",
      }}>
        <h2 style={{ textAlign: "center", margin: "0 0 24px 0", color: "#ff2266", fontSize: "24px" }}>
          Benchmark Complete
        </h2>

        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, fontSize: "18px" }}>
          <span>Total Time:</span>
          <span style={{ color: "#00ff66" }}>{mins}:{secs.toString().padStart(2, "0")}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, fontSize: "18px" }}>
          <span>Overall Accuracy:</span>
          <span style={{ color: "#00ff66" }}>{totalAcc}% ({totalHits}/{totalShots})</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24, fontSize: "18px" }}>
          <span>Total Wall Hits:</span>
          <span style={{ color: totalWallHits === 0 ? "#00ff66" : "#ff2266" }}>{totalWallHits}</span>
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 16 }}>
          <div style={{ fontSize: "14px", color: "#888", marginBottom: 12 }}>Per-Stretch Breakdown</div>
          {results.map((r, i) => {
            const acc = r.shots > 0 ? Math.round((r.hits / r.shots) * 100) : 0;
            const m = Math.floor(r.time / 60);
            const s = r.time % 60;
            return (
              <div key={i} style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: i < results.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                fontSize: "14px",
              }}>
                <span>Stretch {i + 1} ({STRETCH_CONFIGS[i]?.behavior})</span>
                <span>{m}:{s.toString().padStart(2, "0")} — {acc}% — <span style={{ color: r.wallHits === 0 ? "#00ff66" : "#ff2266" }}>{r.wallHits} walls</span></span>
              </div>
            );
          })}
        </div>

        <button
          onClick={onRestart}
          style={{
            width: "100%",
            marginTop: 24,
            padding: "12px 0",
            fontFamily: "monospace",
            fontSize: "16px",
            border: "1px solid #ff2266",
            borderRadius: 8,
            background: "rgba(255,34,102,0.15)",
            color: "#ff2266",
            cursor: "pointer",
          }}
        >
          Restart Benchmark
        </button>
      </div>
    </div>
  );
}

// ─── Settings Panel ──────────────────────────────────────────────────────────

function SettingsPanel({ onStart, inputMode, setInputMode, gamepadSlot, setGamepadSlot, deadzone, setDeadzone, sensitivity, setSensitivity, walkwayWidth, setWalkwayWidth, bubbleSize, setBubbleSize }: {
  onStart: () => void;
  inputMode: InputMode;
  setInputMode: (v: InputMode) => void;
  gamepadSlot: number;
  setGamepadSlot: (v: number) => void;
  deadzone: number;
  setDeadzone: (v: number) => void;
  sensitivity: number;
  setSensitivity: (v: number) => void;
  walkwayWidth: number;
  setWalkwayWidth: (v: number) => void;
  bubbleSize: number;
  setBubbleSize: (v: number) => void;
}) {
  const modeBtn = (mode: InputMode, label: string, hint: string) => {
    const selected = inputMode === mode;
    return (
      <button
        onClick={() => setInputMode(mode)}
        style={{
          flex: 1,
          padding: "12px 10px",
          fontFamily: "monospace",
          fontSize: "13px",
          textAlign: "left",
          border: selected ? "1px solid #ff2266" : "1px solid rgba(255,255,255,0.2)",
          borderRadius: 8,
          background: selected ? "rgba(255,34,102,0.18)" : "rgba(255,255,255,0.05)",
          color: selected ? "#ff6699" : "#bbb",
          cursor: "pointer",
        }}
      >
        <div style={{ fontWeight: "bold", marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: "11px", color: selected ? "#ffaacc" : "#777", lineHeight: 1.3 }}>{hint}</div>
      </button>
    );
  };
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      zIndex: 30,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.85)",
    }}>
      <div style={{
        background: "rgba(20,20,40,0.95)",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: 12,
        padding: 32,
        maxWidth: 420,
        width: "90%",
        fontFamily: "monospace",
        color: "#fff",
      }}>
        <h2 style={{ textAlign: "center", margin: "0 0 8px 0", color: "#ff2266", fontSize: "24px" }}>
          WildWorld
        </h2>
        <p style={{ textAlign: "center", color: "#888", fontSize: "13px", margin: "0 0 24px 0" }}>
          FPS Benchmark — 4 stretches, 10 targets each
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <div style={LABEL}>Input Mode</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {modeBtn("gamepad", "Gaming console", "Left stick: move | Right stick: aim")}
              {modeBtn("bci_aim", "BCI aim + QuadStick move", "QuadStick left stick: move | BCI (ZMQ): aim")}
              {modeBtn("bci_move", "BCI move + QuadStick aim", "BCI (ZMQ): move | QuadStick left stick: aim")}
            </div>
          </div>

          <div>
            <div style={{ ...LABEL, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Gamepad Slot</span>
              <a
                href="https://hardwaretester.com/gamepad"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "11px",
                  color: "rgba(255,255,255,0.5)",
                  textDecoration: "none",
                }}
              >
                Test gamepad ↗
              </a>
            </div>
            <input
              type="number"
              min={0}
              max={7}
              value={gamepadSlot}
              onChange={(e) => setGamepadSlot(Math.max(0, Math.min(7, parseInt(e.target.value) || 0)))}
              style={{
                width: "100%",
                background: "rgba(255,255,255,0.1)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6,
                padding: "8px 12px",
                fontFamily: "monospace",
                fontSize: "14px",
                color: "#fff",
              }}
            />
          </div>

          <div>
            <div style={LABEL}>Deadzone: {deadzone.toFixed(2)}</div>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={deadzone}
              onChange={(e) => setDeadzone(parseFloat(e.target.value))}
              style={SLIDER}
            />
          </div>

          <div>
            <div style={LABEL}>Sensitivity: {sensitivity.toFixed(1)}</div>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
              style={SLIDER}
            />
          </div>

          <div>
            <div style={LABEL}>Walkway Width: {walkwayWidth.toFixed(1)}x</div>
            <input
              type="range"
              min={0.3}
              max={2.0}
              step={0.1}
              value={walkwayWidth}
              onChange={(e) => setWalkwayWidth(parseFloat(e.target.value))}
              style={SLIDER}
            />
          </div>

          <div>
            <div style={LABEL}>Target Size: {bubbleSize.toFixed(1)}x</div>
            <input
              type="range"
              min={0.3}
              max={3.0}
              step={0.1}
              value={bubbleSize}
              onChange={(e) => setBubbleSize(parseFloat(e.target.value))}
              style={SLIDER}
            />
          </div>

          <div style={{ color: "#666", fontSize: "12px", lineHeight: 1.5 }}>
            {inputMode === "gamepad" && (
              <>Left stick: move &nbsp;|&nbsp; Right stick: aim<br />Any controller button or left click: shoot</>
            )}
            {inputMode === "bci_aim" && (
              <>QuadStick left stick: move &nbsp;|&nbsp; BCI (ZMQ): aim<br />Any QuadStick button or left click: shoot</>
            )}
            {inputMode === "bci_move" && (
              <>BCI (ZMQ): move &nbsp;|&nbsp; QuadStick left stick: aim<br />Any QuadStick button or left click: shoot</>
            )}
          </div>

          <button
            onClick={onStart}
            style={{
              width: "100%",
              padding: "14px 0",
              fontFamily: "monospace",
              fontSize: "18px",
              border: "1px solid #00ff66",
              borderRadius: 8,
              background: "rgba(0,255,102,0.15)",
              color: "#00ff66",
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            Start Benchmark
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function WildWorld() {
  const [phase, setPhase] = useState<Phase>("settings");
  const [elapsed, setElapsed] = useState(0);

  const [stretchIdx, setStretchIdx] = useState(0);
  const [targetPos, setTargetPos] = useState<Vec3 | null>(null);
  const [targetsHit, setTargetsHit] = useState(0);
  const [targetHP, setTargetHP] = useState(0);

  const [wallCollisions, setWallCollisions] = useState(0);
  const wallBreachCooldown = useRef(false);
  const [wallFlash, setWallFlash] = useState(false);

  const [walkwayWidth, setWalkwayWidth] = useState(1.0);
  const [bubbleSize, setBubbleSize] = useState(1.0);

  const stretches = useMemo(() => buildStretches(walkwayWidth), [walkwayWidth]);

  const [inputMode, setInputMode] = useState<InputMode>("gamepad");
  const [gamepadSlot, setGamepadSlot] = useState(0);
  const [deadzone, setDeadzone] = useState(0);
  const [sensitivity, setSensitivity] = useState(1);

  const inputModeRef = useRef<InputMode>("gamepad");
  useEffect(() => { inputModeRef.current = inputMode; }, [inputMode]);

  const sensitivityRef = useRef(1);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);

  const deadzoneRef = useRef(0);
  useEffect(() => { deadzoneRef.current = deadzone; }, [deadzone]);

  const gamepadSlotRef = useRef(0);
  useEffect(() => { gamepadSlotRef.current = gamepadSlot; }, [gamepadSlot]);

  const zmqService = useRef<ReturnType<typeof VelocityZmqListener.factory> | null>(null);

  const playerRef = useRef({ x: 0, y: PLAYER_HEIGHT, z: 0, vy: 0, grounded: true });
  const eulerRef = useRef(new THREE.Euler(0, 0, 0, "YXZ"));
  const gamepadRef = useRef({ lx: 0, ly: 0, rx: 0, ry: 0 });
  const bciDeltaRef = useRef({ x: 0, y: 0 });
  const bciMoveRef = useRef({ x: 0, y: 0 });
  const arrowRef = useRef<ArrowInfo>({ visible: false, x: 0, y: 0, angle: 0 });
  const audioCtx = useRef<AudioContext | null>(null);

  const totalShotsRef = useRef(0);
  const totalHitsRef = useRef(0);
  const stretchShotsRef = useRef(0);
  const stretchHitsRef = useRef(0);
  const stretchWallHitsRef = useRef(0);
  const startTimeRef = useRef(0);
  const stretchStartRef = useRef(0);
  const [results, setResults] = useState<StretchResult[]>([]);
  const [totalTime, setTotalTime] = useState(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentStretch = stretches[stretchIdx] || stretches[0];

  // Gamepad polling
  useEffect(() => {
    if (phase !== "running") return;
    let raf: number;
    const poll = () => {
      const gamepads = navigator.getGamepads();
      const gp = gamepads[gamepadSlotRef.current];
      if (gp) {
        const dz = deadzoneRef.current;
        const applyDz = (v: number) => Math.abs(v) < dz ? 0 : v;
        const mode = inputModeRef.current;
        if (mode === "bci_move") {
          gamepadRef.current.lx = 0;
          gamepadRef.current.ly = 0;
        } else {
          gamepadRef.current.lx = applyDz(gp.axes[0] || 0);
          gamepadRef.current.ly = applyDz(gp.axes[1] || 0);
        }
        if (mode === "bci_aim") {
          gamepadRef.current.rx = 0;
          gamepadRef.current.ry = 0;
        } else if (mode === "bci_move") {
          gamepadRef.current.rx = applyDz(gp.axes[0] || 0);
          gamepadRef.current.ry = applyDz(gp.axes[1] || 0);
        } else {
          gamepadRef.current.rx = applyDz(gp.axes[2] || 0);
          gamepadRef.current.ry = applyDz(gp.axes[3] || 0);
        }
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // BCI (ZMQ) — drives aim (bci_aim) or movement (bci_move) while playing.
  useEffect(() => {
    if (phase !== "running" || inputMode === "gamepad") return;
    if (!zmqService.current) zmqService.current = VelocityZmqListener.factory();
    const svc = zmqService.current;
    svc.start();
    const handleZmqData = (data: DecodePacket) => {
      if (inputModeRef.current === "bci_aim") {
        bciDeltaRef.current.x += data.final_velocity_x * BCI_ACCUMULATOR_SCALE;
        bciDeltaRef.current.y += data.final_velocity_y * BCI_ACCUMULATOR_SCALE;
      } else if (inputModeRef.current === "bci_move") {
        const sx = data.final_velocity_x * BCI_MOVE_SCALE;
        const sy = data.final_velocity_y * BCI_MOVE_SCALE;
        bciMoveRef.current.x = Math.max(-1, Math.min(1, sx));
        bciMoveRef.current.y = Math.max(-1, Math.min(1, sy));
      }
    };
    svc.events.on(ZmqClient.EVENT_MESSAGE, handleZmqData);
    return () => {
      svc.events.off(ZmqClient.EVENT_MESSAGE, handleZmqData);
      svc.stop();
      bciDeltaRef.current.x = 0;
      bciDeltaRef.current.y = 0;
      bciMoveRef.current.x = 0;
      bciMoveRef.current.y = 0;
    };
  }, [phase, inputMode]);

  // Timer
  useEffect(() => {
    if (phase === "running") {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  const initStretch = useCallback((idx: number) => {
    const s = stretches[idx];
    playerRef.current = { x: s.playerStart[0], y: s.playerStart[1], z: s.playerStart[2], vy: 0, grounded: true };
    eulerRef.current.set(0, s.playerYaw, 0, "YXZ");
    setTargetsHit(0);
    stretchShotsRef.current = 0;
    stretchHitsRef.current = 0;
    stretchWallHitsRef.current = 0;
    stretchStartRef.current = Date.now();
    setTargetHP(0);
    setTargetPos(null);
  }, [stretches]);

  const handleStart = useCallback(() => {
    setPhase("running");
    setStretchIdx(0);
    setResults([]);
    setWallCollisions(0);
    totalShotsRef.current = 0;
    totalHitsRef.current = 0;
    startTimeRef.current = Date.now();
    initStretch(0);
  }, [initStretch]);

  const handleWallBreach = useCallback(() => {
    if (phase !== "running" || wallBreachCooldown.current) return;
    wallBreachCooldown.current = true;
    setWallCollisions(prev => prev + 1);
    stretchWallHitsRef.current++;
    playBuzz(audioCtx);
    setWallFlash(true);
    setTimeout(() => { setWallFlash(false); }, 300);
    setTimeout(() => { wallBreachCooldown.current = false; }, 400);
  }, [phase]);

  const handleShot = useCallback(() => {
    if (phase !== "running") return;
    totalShotsRef.current++;
    stretchShotsRef.current++;
  }, [phase]);

  const handleHit = useCallback(() => {
    if (phase !== "running") return;
    totalHitsRef.current++;
    stretchHitsRef.current++;
    playPop(audioCtx);

    const s = stretches[stretchIdx];
    const newHP = targetHP + 1;

    if (newHP < s.hitsRequired) {
      setTargetHP(newHP);
      return;
    }

    setTargetHP(0);
    const newHitCount = targetsHit + 1;
    setTargetsHit(newHitCount);
    setTargetPos(null);

    if (newHitCount >= TARGETS_PER_STRETCH) {
      const stretchTime = Math.floor((Date.now() - stretchStartRef.current) / 1000);
      const result: StretchResult = {
        time: stretchTime,
        shots: stretchShotsRef.current,
        hits: stretchHitsRef.current,
        wallHits: stretchWallHitsRef.current,
      };

      setResults(prev => [...prev, result]);

      if (stretchIdx >= stretches.length - 1) {
        setTotalTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
        setPhase("results");
      } else {
        const nextIdx = stretchIdx + 1;
        setStretchIdx(nextIdx);
        initStretch(nextIdx);
      }
    }
  }, [phase, targetsHit, stretchIdx, targetHP, initStretch, stretches]);

  // Tile-based target activation: show target only when player is on the correct tile
  useEffect(() => {
    if (phase !== "running") return;
    if (targetsHit >= TARGETS_PER_STRETCH) return;
    const s = stretches[stretchIdx];
    const tileIdx = s.targetTiles[targetsHit];
    const tile = TILE_GRID[tileIdx];
    if (!tile) return;
    const ts = s.corridorWidth;
    let raf: number;
    const check = () => {
      const p = playerRef.current;
      const tileX = tile[0] * ts;
      const tileZ = -tile[1] * ts;
      const onTile = Math.abs(p.x - tileX) < ts / 2 && Math.abs(p.z - tileZ) < ts / 2;
      if (onTile) {
        setTargetPos(s.mazeTargets[targetsHit] || null);
      } else {
        setTargetPos(null);
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [phase, stretchIdx, targetsHit, stretches]);

  const handleRestart = useCallback(() => {
    setPhase("settings");
    setStretchIdx(0);
    setTargetsHit(0);
    setElapsed(0);
    setResults([]);
    setTargetPos(null);
    setTargetHP(0);
    setWallCollisions(0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "settings") handleRestart();
      if (phase === "running") {
        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
          e.preventDefault();
          setBubbleSize(v => Math.min(3.0, Math.round((v + 0.1) * 10) / 10));
        } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
          e.preventDefault();
          setBubbleSize(v => Math.max(0.3, Math.round((v - 0.1) * 10) / 10));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, handleRestart]);

  const showTarget = phase === "running" && targetPos !== null;

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative", overflow: "hidden" }}>
      {phase === "settings" && (
        <SettingsPanel
          onStart={handleStart}
          inputMode={inputMode}
          setInputMode={setInputMode}
          gamepadSlot={gamepadSlot}
          setGamepadSlot={setGamepadSlot}
          deadzone={deadzone}
          setDeadzone={setDeadzone}
          sensitivity={sensitivity}
          setSensitivity={setSensitivity}
          walkwayWidth={walkwayWidth}
          setWalkwayWidth={setWalkwayWidth}
          bubbleSize={bubbleSize}
          setBubbleSize={setBubbleSize}
        />
      )}

      {phase === "results" && (
        <ResultsScreen results={results} totalTime={totalTime} onRestart={handleRestart} />
      )}

      <HUD
        phase={phase}
        stretchIdx={stretchIdx}
        elapsed={elapsed}
        shots={totalShotsRef.current}
        hits={totalHitsRef.current}
        targetsHit={targetsHit}
        wallCollisions={wallCollisions}
      />

      <Crosshair active={phase === "running"} />

      {phase === "running" && (
        <div style={{
          position: "absolute",
          bottom: 16,
          right: 20,
          zIndex: 20,
          fontFamily: "monospace",
          fontSize: "11px",
          color: "rgba(255,255,255,0.5)",
          textShadow: "0 0 6px rgba(0,0,0,0.8)",
          pointerEvents: "none",
          textAlign: "right",
          lineHeight: 1.4,
        }}>
          <div>Target Size <span style={{ color: "rgba(255,255,255,0.85)" }}>{bubbleSize.toFixed(1)}x</span></div>
          <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>← → to adjust</div>
        </div>
      )}

      <DirectionArrow
        active={phase === "running" && targetPos !== null}
        arrowRef={arrowRef}
      />

      <Canvas
        camera={{ fov: 90, near: 0.1, far: 200, position: [0, PLAYER_HEIGHT, 0] }}
        style={{ width: "100%", height: "100%" }}
      >
        <BenchmarkScene
          stretch={currentStretch}
          targetsHit={targetsHit}
          targetPos={targetPos}
          targetRadius={currentStretch.targetRadius * bubbleSize}
          showTarget={showTarget}
          hitProgress={currentStretch.hitsRequired > 1 ? targetHP / currentStretch.hitsRequired : 0}
          behavior={currentStretch.behavior}
          playerRef={playerRef}
          eulerRef={eulerRef}
          gamepadRef={gamepadRef}
          gamepadSlotRef={gamepadSlotRef}
          bciDeltaRef={bciDeltaRef}
          bciMoveRef={bciMoveRef}
          arrowRef={arrowRef}
          sensitivityRef={sensitivityRef}
          onShot={handleShot}
          onHit={handleHit}
          onWallBreach={handleWallBreach}
          wallFlash={wallFlash}
        />
      </Canvas>
    </div>
  );
}
