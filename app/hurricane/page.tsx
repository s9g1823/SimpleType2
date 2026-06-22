"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import VelocityZmqListener, { DecodePacket } from "../ZmqListener";
import ZmqClient from "../ZmqClient";

// ---------- Constants ----------
const BASE_SPEED = 5;            // m/s at analog magnitude 1.0
const CHAR_BODY_RADIUS = 0.35;
const CHAR_FEET_Y = 0;           // y of character's "feet"
const BCI_MOVE_SCALE = 0.01;

// Platform layout — all platforms sit on the road centerline (x = 0).
const PLATFORM_Z_START = 9;
const PLATFORM_HEIGHT = 0.15;
const PLATFORM_GAP_DEFAULT = 5;    // meters between targets (configurable)
const PLATFORM_GAP_JITTER = 0.15;  // ±15% random jitter around the chosen distance

// World decoration
const GROUND_SIZE = 280;
const ACCENT = "#38bdf8";
const PLATFORM_COLORS = ["#06b6d4", "#a855f7", "#f59e0b"]; // cyan, violet, amber

// TPM tracking
const TPM_ROLLING_WINDOW_MS = 60_000;
const HUD_REFRESH_MS = 250;

// ---------- Audio feedback ----------
class AudioFeedback {
  private ctx: AudioContext | null = null;
  // sustained "on target" voice
  private holdOsc: OscillatorNode | null = null;
  private holdGain: GainNode | null = null;
  private holdLp: BiquadFilterNode | null = null;
  private currentlyOn = false;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  // Must be called from a user-gesture handler so the AudioContext can start.
  unlock(): void {
    this.ensureCtx();
  }

  setOn(active: boolean): void {
    if (active === this.currentlyOn) return;
    this.currentlyOn = active;
    const ctx = this.ensureCtx();
    const now = ctx.currentTime;
    if (active) {
      // Stop any prior voice first.
      this.stopHold(now);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 220;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 800;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.04);
      osc.connect(lp).connect(gain).connect(ctx.destination);
      osc.start(now);
      this.holdOsc = osc;
      this.holdLp = lp;
      this.holdGain = gain;
    } else {
      this.stopHold(now);
    }
  }

  private stopHold(now: number): void {
    if (this.holdGain && this.holdOsc) {
      const g = this.holdGain;
      const osc = this.holdOsc;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 0.06);
      osc.stop(now + 0.08);
    }
    this.holdOsc = null;
    this.holdGain = null;
    this.holdLp = null;
  }

  playComplete(): void {
    const ctx = this.ensureCtx();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const t = now + i * 0.08;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    });
  }

  playLeave(): void {
    const ctx = this.ensureCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(130, now + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(g).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  }

  dispose(): void {
    if (this.holdOsc) {
      try {
        this.holdOsc.stop();
      } catch {
        // already stopped
      }
    }
    this.holdOsc = null;
    this.holdGain = null;
    this.holdLp = null;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

type AnalogMode = "none" | "gamepad" | "zmq" | "zmq-digital";

interface PlatformDef {
  id: number;
  position: [number, number, number]; // top-center of disc (y = disc top surface)
  baseColor: string;
}

interface DwellState {
  activeId: number | null;
  progress: number; // seconds accumulated on the active platform
}

// One on→off (or on→complete) attempt at a platform.
interface AttemptRecord {
  startMs: number;        // performance.now() when the foot first touched
  endMs: number;          // 0 while still on; otherwise the leaving timestamp
  durationMs: number;     // endMs - startMs
  outcome: "off" | "complete";
}

// Aggregated per-platform metrics. Persists even after a platform is pruned
// from the visible pool so the CSV/tables include the full run history.
interface PlatformStats {
  platformId: number;
  platformZ: number;
  platformX: number;
  totalDistanceM: number;     // path length traveled while on this platform (all attempts)
  radiusSamples: number[];    // distance from platform center each sampled frame
  attempts: AttemptRecord[];  // every step-on event
  // Path-efficiency metrics, only set when the platform is actually completed.
  // straightLine is the Euclidean distance from the previous completion (or
  // run origin for target 0) to this completion; pathLength is the cumulative
  // walked path between the two events; pathEfficiency is straight/path,
  // clamped to [0, 1] (1.0 if pathLength is 0).
  straightLineFromPreviousM?: number;
  pathLengthFromPreviousM?: number;
  pathEfficiency?: number;
}

// ---------- World generation ----------
function nextGapZ(base: number): number {
  const jitter = base * PLATFORM_GAP_JITTER;
  return base + (Math.random() * 2 - 1) * jitter;
}


// ---------- Character ----------
// Dirty-simple: the body is rigidly clamped to posRef every frame. No bob,
// no facing rotation, no easing — exactly mirrors the player's position so
// what you press is what you see.
function Character({
  posRef,
}: {
  posRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.position.copy(posRef.current);
  });

  return (
    <group ref={groupRef}>
      {/* Body capsule */}
      <mesh position={[0, 0.7, 0]} castShadow>
        <capsuleGeometry args={[CHAR_BODY_RADIUS, 0.6, 8, 16]} />
        <meshStandardMaterial color="#d8d8de" roughness={0.6} />
      </mesh>
      {/* Head */}
      <mesh position={[0, 1.42, 0]} castShadow>
        <sphereGeometry args={[0.26, 18, 18]} />
        <meshStandardMaterial color="#e8b889" />
      </mesh>
    </group>
  );
}

// ---------- Platform ----------
function PlatformView({
  platform,
  radiusRef,
  dwellTimeRef,
  dwellStateRef,
  completedRef,
}: {
  platform: PlatformDef;
  radiusRef: React.MutableRefObject<number>;
  dwellTimeRef: React.MutableRefObject<number>;
  dwellStateRef: React.MutableRefObject<DwellState>;
  completedRef: React.MutableRefObject<Set<number>>;
}) {
  const baseRef = useRef<THREE.Mesh>(null);
  const baseMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const fillRef = useRef<THREE.Mesh>(null);
  const fillMatRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(() => {
    const radius = Math.max(0.05, radiusRef.current);
    const isCompleted = completedRef.current.has(platform.id);
    const isActive = dwellStateRef.current.activeId === platform.id;
    const progress = isActive
      ? Math.min(1, dwellStateRef.current.progress / Math.max(0.001, dwellTimeRef.current))
      : 0;

    // The (empty) outline disc that marks where to step.
    if (baseRef.current) {
      baseRef.current.scale.x = radius;
      baseRef.current.scale.z = radius;
    }
    if (baseMatRef.current) {
      baseMatRef.current.emissiveIntensity = isActive ? 0.25 : 0.1;
    }

    // The fill that grows from the center outward.
    if (fillRef.current) {
      const fillRadius = isCompleted ? radius : progress * radius;
      const s = Math.max(0.001, fillRadius);
      fillRef.current.scale.x = s;
      fillRef.current.scale.z = s;
      fillRef.current.visible = isCompleted || progress > 0.001;
    }
    if (fillMatRef.current) {
      if (isCompleted) {
        fillMatRef.current.emissiveIntensity = 0.35;
        fillMatRef.current.opacity = 0.85;
      } else {
        fillMatRef.current.emissiveIntensity = 0.7 + progress * 0.5;
        fillMatRef.current.opacity = 0.95;
      }
    }
  });

  return (
    <group position={platform.position}>
      {/* Outline / target ring — desaturated base. */}
      <mesh ref={baseRef} receiveShadow>
        <cylinderGeometry args={[1, 1, PLATFORM_HEIGHT, 48]} />
        <meshStandardMaterial
          ref={baseMatRef}
          color={platform.baseColor}
          emissive={platform.baseColor}
          emissiveIntensity={0.1}
          roughness={0.85}
          transparent
          opacity={0.35}
          depthWrite={false}
        />
      </mesh>
      {/* Center-out fill — vivid, slightly raised to avoid z-fighting. */}
      <mesh ref={fillRef} position={[0, PLATFORM_HEIGHT + 0.012, 0]}>
        <cylinderGeometry args={[1, 1, 0.02, 48]} />
        <meshStandardMaterial
          ref={fillMatRef}
          color={platform.baseColor}
          emissive={platform.baseColor}
          emissiveIntensity={0.7}
          roughness={0.4}
          transparent
          opacity={0.95}
          depthWrite={false}
        />
      </mesh>
      {/* Precise red center dot — always visible above the fill. */}
      <mesh position={[0, PLATFORM_HEIGHT + 0.05, 0]} renderOrder={5}>
        <cylinderGeometry args={[0.06, 0.06, 0.015, 20]} />
        <meshStandardMaterial
          color="#ff1f3d"
          emissive="#ff1f3d"
          emissiveIntensity={1.2}
          toneMapped={false}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

// ---------- World decor ----------
function Ground({
  posRef,
}: {
  posRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const grassRef = useRef<THREE.Mesh>(null);
  // The grass plane follows the player's z so the world feels infinite.
  useFrame(() => {
    const pz = posRef.current.z;
    if (grassRef.current) grassRef.current.position.z = pz;
  });
  return (
    <mesh ref={grassRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
      <meshStandardMaterial color="#4a7a3a" roughness={0.9} />
    </mesh>
  );
}

function Sun() {
  return (
    <mesh position={[20, 35, -40]}>
      <sphereGeometry args={[3, 24, 24]} />
      <meshBasicMaterial color="#fff4cc" />
    </mesh>
  );
}

// ---------- Camera ----------
function ThirdPersonCamera({
  targetRef,
  pausedRef,
}: {
  targetRef: React.MutableRefObject<THREE.Vector3>;
  pausedRef: React.MutableRefObject<boolean>;
}) {
  const { camera } = useThree();
  const desired = useMemo(() => new THREE.Vector3(), []);
  const lookAt = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (pausedRef.current) return;
    const t = targetRef.current;
    // Snap (no easing) so what the player presses is what they see — the
    // previous lerp made the camera lag, which read as a phantom backward
    // drift whenever the character stopped suddenly.
    desired.set(t.x, t.y + 8, t.z - 4);
    camera.position.copy(desired);
    lookAt.set(t.x, t.y + 0.3, t.z + 6);
    camera.lookAt(lookAt);
  });
  return null;
}

// ---------- Movement + dwell controller ----------
function MovementController({
  platforms,
  posRef,
  pausedRef,
  keyRef,
  gamepadRef,
  bciRef,
  analogModeRef,
  sensitivityRef,
  invertZRef,
  dwellTimeRef,
  platformRadiusRef,
  dwellStateRef,
  completedRef,
  statsRef,
  cumPathRef,
  lastCompletionPosRef,
  playMsGetterRef,
  onComplete,
}: {
  platforms: PlatformDef[];
  posRef: React.MutableRefObject<THREE.Vector3>;
  pausedRef: React.MutableRefObject<boolean>;
  keyRef: React.MutableRefObject<{ w: boolean; a: boolean; s: boolean; d: boolean }>;
  gamepadRef: React.MutableRefObject<{ lx: number; ly: number }>;
  bciRef: React.MutableRefObject<{ x: number; y: number }>;
  analogModeRef: React.MutableRefObject<AnalogMode>;
  sensitivityRef: React.MutableRefObject<number>;
  invertZRef: React.MutableRefObject<boolean>;
  dwellTimeRef: React.MutableRefObject<number>;
  platformRadiusRef: React.MutableRefObject<number>;
  dwellStateRef: React.MutableRefObject<DwellState>;
  completedRef: React.MutableRefObject<Set<number>>;
  statsRef: React.MutableRefObject<Map<number, PlatformStats>>;
  // Cumulative walked path length (m) since the last completion (or run start).
  cumPathRef: React.MutableRefObject<number>;
  // Player (x, z) at the moment of the previous completion (or (0, 0) initially).
  lastCompletionPosRef: React.MutableRefObject<{ x: number; z: number }>;
  // Returns elapsed active play time in ms (excludes pauses).
  playMsGetterRef: React.MutableRefObject<() => number>;
  onComplete: (id: number) => void;
}) {
  // Track which platform was being stood on last frame so we can detect
  // step-on / step-off edges and update per-platform stats accordingly.
  const prevStandingIdRef = useRef<number | null>(null);
  // Last frame's position (xz) while standing on a platform — used to
  // accumulate path length on that platform.
  const lastStandingPosRef = useRef<{ x: number; z: number } | null>(null);

  useFrame((_, dt) => {
    if (pausedRef.current) return;
    const clampedDt = Math.min(dt, 0.05);

    // ---- Compute input vector ----
    let inputX = 0;
    let inputZ = 0;

    // WASD always. The follow camera looks down +Z (right-handed, +Y up),
    // which means world +X is screen-LEFT — so D / right-stick / +x BCI all
    // map to world -X to feel correct on screen.
    const k = keyRef.current;
    const zSign = invertZRef.current ? -1 : 1;
    if (k.w) inputZ += zSign;
    if (k.s) inputZ -= zSign;
    if (k.a) inputX += 1;
    if (k.d) inputX -= 1;

    // Analog: gamepad or zmq
    const mode = analogModeRef.current;
    if (mode === "gamepad") {
      inputX -= gamepadRef.current.lx;
      inputZ += -gamepadRef.current.ly * zSign;
    } else if (mode === "zmq" || mode === "zmq-digital") {
      inputX -= bciRef.current.x;
      inputZ += bciRef.current.y * zSign;
    }

    // Clamp magnitude to 1
    const mag = Math.hypot(inputX, inputZ);
    if (mag > 1) {
      inputX /= mag;
      inputZ /= mag;
    }

    const activeSpeed = BASE_SPEED * sensitivityRef.current;
    const dx = inputX * activeSpeed * clampedDt;
    const dz = inputZ * activeSpeed * clampedDt;
    posRef.current.x += dx;
    posRef.current.z += dz;
    posRef.current.y = CHAR_FEET_Y;

    // Accumulate the player's walked path since the last completion. Used to
    // compute per-target path efficiency (straight-line / actual-path).
    cumPathRef.current += Math.hypot(dx, dz);

    // ---- Dwell detection ----
    const radius = Math.max(0.05, platformRadiusRef.current);
    const radiusSq = radius * radius;
    let standing: PlatformDef | null = null;
    for (const p of platforms) {
      if (completedRef.current.has(p.id)) continue;
      const ddx = posRef.current.x - p.position[0];
      const ddz = posRef.current.z - p.position[2];
      if (ddx * ddx + ddz * ddz <= radiusSq) {
        standing = p;
        break;
      }
    }

    // ---- Stats: detect step-on / step-off edges ----
    const curId = standing ? standing.id : null;
    const prevId = prevStandingIdRef.current;
    const nowPlayMs = playMsGetterRef.current();

    if (prevId !== curId) {
      // Close the previous platform's open attempt (if any) as "off".
      if (prevId != null) {
        const ps = statsRef.current.get(prevId);
        if (ps && ps.attempts.length > 0) {
          const last = ps.attempts[ps.attempts.length - 1];
          if (last.endMs === 0) {
            last.endMs = nowPlayMs;
            last.durationMs = Math.max(0, nowPlayMs - last.startMs);
            last.outcome = "off";
          }
        }
      }
      // Open a new attempt on the newly-touched platform.
      if (standing) {
        let ps = statsRef.current.get(standing.id);
        if (!ps) {
          ps = {
            platformId: standing.id,
            platformX: standing.position[0],
            platformZ: standing.position[2],
            totalDistanceM: 0,
            radiusSamples: [],
            attempts: [],
          };
          statsRef.current.set(standing.id, ps);
        }
        ps.attempts.push({
          startMs: nowPlayMs,
          endMs: 0,
          durationMs: 0,
          outcome: "off",
        });
        lastStandingPosRef.current = {
          x: posRef.current.x,
          z: posRef.current.z,
        };
      } else {
        lastStandingPosRef.current = null;
      }
    }

    // While on a platform, accumulate distance + radius sample.
    if (standing) {
      const ps = statsRef.current.get(standing.id);
      if (ps) {
        const cx = standing.position[0];
        const cz = standing.position[2];
        const offX = posRef.current.x - cx;
        const offZ = posRef.current.z - cz;
        ps.radiusSamples.push(Math.hypot(offX, offZ));
        if (lastStandingPosRef.current) {
          const mx = posRef.current.x - lastStandingPosRef.current.x;
          const mz = posRef.current.z - lastStandingPosRef.current.z;
          ps.totalDistanceM += Math.hypot(mx, mz);
        }
        lastStandingPosRef.current = {
          x: posRef.current.x,
          z: posRef.current.z,
        };
      }
    }

    prevStandingIdRef.current = curId;

    // ---- Dwell progress / completion ----
    if (standing) {
      if (dwellStateRef.current.activeId !== standing.id) {
        dwellStateRef.current.activeId = standing.id;
        dwellStateRef.current.progress = 0;
      }
      dwellStateRef.current.progress += clampedDt;
      if (dwellStateRef.current.progress >= dwellTimeRef.current) {
        // Mark the in-progress attempt as completed before flipping the
        // completed flag (so the off-edge below skips it next frame).
        const ps = statsRef.current.get(standing.id);
        if (ps) {
          if (ps.attempts.length > 0) {
            const last = ps.attempts[ps.attempts.length - 1];
            if (last.endMs === 0) {
              last.endMs = nowPlayMs;
              last.durationMs = Math.max(0, nowPlayMs - last.startMs);
              last.outcome = "complete";
            }
          }
          // Snapshot path-efficiency metrics for this target. straightLine is
          // measured from the previous completion (or run origin for #0) to
          // the player's position right now.
          const sx = posRef.current.x - lastCompletionPosRef.current.x;
          const sz = posRef.current.z - lastCompletionPosRef.current.z;
          const straightLine = Math.hypot(sx, sz);
          const pathLen = cumPathRef.current;
          ps.straightLineFromPreviousM = straightLine;
          ps.pathLengthFromPreviousM = pathLen;
          ps.pathEfficiency =
            pathLen > 0 ? Math.min(1, straightLine / pathLen) : 1;
        }
        // Reset the path accumulator from this completion forward.
        lastCompletionPosRef.current = {
          x: posRef.current.x,
          z: posRef.current.z,
        };
        cumPathRef.current = 0;
        completedRef.current.add(standing.id);
        onComplete(standing.id);
        dwellStateRef.current.activeId = null;
        dwellStateRef.current.progress = 0;
      }
    } else {
      dwellStateRef.current.activeId = null;
      dwellStateRef.current.progress = 0;
    }
  });

  return null;
}

// ---------- Precise mode: red tracking dot ----------
const PRECISE_DOT_Z_OFFSET = 6; // how far ahead of the player the dot floats
const PRECISE_AMPLITUDE = 4;    // max X oscillation range (meters)

function PreciseDot({
  posRef,
  pausedRef,
  dotXRef,
  speedRef,
  smoothnessRef,
  sizeRef,
}: {
  posRef: React.MutableRefObject<THREE.Vector3>;
  pausedRef: React.MutableRefObject<boolean>;
  dotXRef: React.MutableRefObject<number>;
  speedRef: React.MutableRefObject<number>;
  smoothnessRef: React.MutableRefObject<number>;
  sizeRef: React.MutableRefObject<number>;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const tRef = useRef(0);

  useFrame((_, dt) => {
    if (pausedRef.current || !meshRef.current) return;
    tRef.current += dt * speedRef.current;
    const t = tRef.current;

    // Smoothness: 1 = pure sine, 0 = sharp square-ish wave.
    // We lerp between sin(t) and sign(sin(t)) * |sin(t)|^0.15 (an
    // almost-square waveform that retains continuous edges).
    const raw = Math.sin(t);
    const sharp = Math.sign(raw) * Math.pow(Math.abs(raw), 0.15);
    const s = smoothnessRef.current;
    const wave = s * raw + (1 - s) * sharp;

    const x = wave * PRECISE_AMPLITUDE;
    dotXRef.current = x;

    const radius = sizeRef.current;
    meshRef.current.position.set(x, 0.08, posRef.current.z + PRECISE_DOT_Z_OFFSET);
    meshRef.current.scale.set(radius, 1, radius);
  });

  return (
    <mesh ref={meshRef} position={[0, 0.08, PRECISE_DOT_Z_OFFSET]}>
      <cylinderGeometry args={[1, 1, 0.04, 32]} />
      <meshStandardMaterial
        color="#ff1f3d"
        emissive="#ff1f3d"
        emissiveIntensity={1.4}
        toneMapped={false}
        roughness={0.3}
      />
    </mesh>
  );
}

// ---------- Precise mode: per-frame distance tracker ----------
function PreciseTracker({
  posRef,
  pausedRef,
  dotXRef,
  instantDistRef,
  samplesRef,
  playMsGetterRef,
}: {
  posRef: React.MutableRefObject<THREE.Vector3>;
  pausedRef: React.MutableRefObject<boolean>;
  dotXRef: React.MutableRefObject<number>;
  instantDistRef: React.MutableRefObject<number>;
  samplesRef: React.MutableRefObject<{ t: number; d: number }[]>;
  playMsGetterRef: React.MutableRefObject<() => number>;
}) {
  useFrame(() => {
    if (pausedRef.current) return;
    const dist = Math.abs(posRef.current.x - dotXRef.current);
    instantDistRef.current = dist;
    samplesRef.current.push({ t: playMsGetterRef.current(), d: dist });
  });
  return null;
}

// ---------- Precise mode: movement only (no dwell) ----------
function PreciseMovementController({
  posRef,
  pausedRef,
  keyRef,
  gamepadRef,
  bciRef,
  analogModeRef,
  sensitivityRef,
  invertZRef,
}: {
  posRef: React.MutableRefObject<THREE.Vector3>;
  pausedRef: React.MutableRefObject<boolean>;
  keyRef: React.MutableRefObject<{ w: boolean; a: boolean; s: boolean; d: boolean }>;
  gamepadRef: React.MutableRefObject<{ lx: number; ly: number }>;
  bciRef: React.MutableRefObject<{ x: number; y: number }>;
  analogModeRef: React.MutableRefObject<AnalogMode>;
  sensitivityRef: React.MutableRefObject<number>;
  invertZRef: React.MutableRefObject<boolean>;
}) {
  useFrame((_, dt) => {
    if (pausedRef.current) return;
    const clampedDt = Math.min(dt, 0.05);

    let inputX = 0;
    let inputZ = 0;

    const k = keyRef.current;
    const zSign = invertZRef.current ? -1 : 1;
    if (k.w) inputZ += zSign;
    if (k.s) inputZ -= zSign;
    if (k.a) inputX += 1;
    if (k.d) inputX -= 1;

    const mode = analogModeRef.current;
    if (mode === "gamepad") {
      inputX -= gamepadRef.current.lx;
      inputZ += -gamepadRef.current.ly * zSign;
    } else if (mode === "zmq" || mode === "zmq-digital") {
      inputX -= bciRef.current.x;
      inputZ += bciRef.current.y * zSign;
    }

    const mag = Math.hypot(inputX, inputZ);
    if (mag > 1) {
      inputX /= mag;
      inputZ /= mag;
    }

    const activeSpeed = BASE_SPEED * sensitivityRef.current;
    posRef.current.x += inputX * activeSpeed * clampedDt;
    posRef.current.z += inputZ * activeSpeed * clampedDt;
    posRef.current.y = CHAR_FEET_Y;
  });
  return null;
}

// ---------- Scene composition ----------
function Scene(props: {
  gameStyle: "standard" | "precise";
  // Standard props
  platforms: PlatformDef[];
  dwellTimeRef: React.MutableRefObject<number>;
  platformRadiusRef: React.MutableRefObject<number>;
  dwellStateRef: React.MutableRefObject<DwellState>;
  completedRef: React.MutableRefObject<Set<number>>;
  statsRef: React.MutableRefObject<Map<number, PlatformStats>>;
  cumPathRef: React.MutableRefObject<number>;
  lastCompletionPosRef: React.MutableRefObject<{ x: number; z: number }>;
  onComplete: (id: number) => void;
  // Precise props
  dotXRef: React.MutableRefObject<number>;
  dotSpeedRef: React.MutableRefObject<number>;
  dotSmoothnessRef: React.MutableRefObject<number>;
  dotSizeRef: React.MutableRefObject<number>;
  preciseInstantDistRef: React.MutableRefObject<number>;
  preciseDistSamplesRef: React.MutableRefObject<{ t: number; d: number }[]>;
  // Shared
  posRef: React.MutableRefObject<THREE.Vector3>;
  pausedRef: React.MutableRefObject<boolean>;
  keyRef: React.MutableRefObject<{ w: boolean; a: boolean; s: boolean; d: boolean }>;
  gamepadRef: React.MutableRefObject<{ lx: number; ly: number }>;
  bciRef: React.MutableRefObject<{ x: number; y: number }>;
  analogModeRef: React.MutableRefObject<AnalogMode>;
  sensitivityRef: React.MutableRefObject<number>;
  invertZRef: React.MutableRefObject<boolean>;
  playMsGetterRef: React.MutableRefObject<() => number>;
}) {
  const isStandard = props.gameStyle === "standard";
  return (
    <>
      <color attach="background" args={["#7ec8ff"]} />
      <fog attach="fog" args={["#7ec8ff", 60, 220]} />
      <hemisphereLight args={["#ffffff", "#557744", 0.6]} />
      <directionalLight
        position={[20, 30, 10]}
        intensity={1.0}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <Sun />
      <Ground posRef={props.posRef} />
      <Character posRef={props.posRef} />

      {isStandard ? (
        <>
          {props.platforms.map((p) => (
            <PlatformView
              key={p.id}
              platform={p}
              radiusRef={props.platformRadiusRef}
              dwellTimeRef={props.dwellTimeRef}
              dwellStateRef={props.dwellStateRef}
              completedRef={props.completedRef}
            />
          ))}
          <MovementController
            platforms={props.platforms}
            posRef={props.posRef}
            pausedRef={props.pausedRef}
            keyRef={props.keyRef}
            gamepadRef={props.gamepadRef}
            bciRef={props.bciRef}
            analogModeRef={props.analogModeRef}
            sensitivityRef={props.sensitivityRef}
            invertZRef={props.invertZRef}
            dwellTimeRef={props.dwellTimeRef}
            platformRadiusRef={props.platformRadiusRef}
            dwellStateRef={props.dwellStateRef}
            completedRef={props.completedRef}
            statsRef={props.statsRef}
            cumPathRef={props.cumPathRef}
            lastCompletionPosRef={props.lastCompletionPosRef}
            playMsGetterRef={props.playMsGetterRef}
            onComplete={props.onComplete}
          />
        </>
      ) : (
        <>
          <PreciseDot
            posRef={props.posRef}
            pausedRef={props.pausedRef}
            dotXRef={props.dotXRef}
            speedRef={props.dotSpeedRef}
            smoothnessRef={props.dotSmoothnessRef}
            sizeRef={props.dotSizeRef}
          />
          <PreciseTracker
            posRef={props.posRef}
            pausedRef={props.pausedRef}
            dotXRef={props.dotXRef}
            instantDistRef={props.preciseInstantDistRef}
            samplesRef={props.preciseDistSamplesRef}
            playMsGetterRef={props.playMsGetterRef}
          />
          <PreciseMovementController
            posRef={props.posRef}
            pausedRef={props.pausedRef}
            keyRef={props.keyRef}
            gamepadRef={props.gamepadRef}
            bciRef={props.bciRef}
            analogModeRef={props.analogModeRef}
            sensitivityRef={props.sensitivityRef}
            invertZRef={props.invertZRef}
          />
        </>
      )}

      <ThirdPersonCamera targetRef={props.posRef} pausedRef={props.pausedRef} />
    </>
  );
}

function formatPlayTime(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function computeMedian(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// Time (ms) from the player's first step-on to the moment the platform
// completed. Returns null if the platform has not been completed yet.
function computeTimeToComplete(ps: PlatformStats): number | null {
  if (ps.attempts.length === 0) return null;
  const completed = ps.attempts.find((a) => a.outcome === "complete");
  if (!completed || completed.endMs === 0) return null;
  const firstStart = ps.attempts[0].startMs;
  return Math.max(0, completed.endMs - firstStart);
}

// ---------- UI styles ----------
const LABEL: React.CSSProperties = {
  color: "#ddd",
  fontFamily: "monospace",
  fontSize: "14px",
  marginBottom: 4,
};
const SLIDER: React.CSSProperties = {
  width: "100%",
  accentColor: ACCENT,
};

// ---------- Digital gamepad mapping ----------
// Converts raw analog stick into digital WASD. The stick area is split into:
//   - center deadzone (magnitude < dz): no direction
//   - four cardinal wedges (Up/Down/Left/Right): each ±HALF_WEDGE from the
//     cardinal axis. Outside the wedges are diagonal dead zones.
const DEFAULT_HALF_WEDGE_DEG = 30; // each cardinal zone spans ±30° (60° total)

type DigitalDir = "up" | "down" | "left" | "right" | null;

// Cardinal centers in atan2 space (x,y where y+ = down on screen / stick):
//   right = 0, down = π/2, left = ±π, up = -π/2
const CARDINAL_ANGLES: { dir: DigitalDir; center: number }[] = [
  { dir: "right", center: 0 },
  { dir: "down",  center: Math.PI / 2 },
  { dir: "left",  center: Math.PI },
  { dir: "up",    center: -Math.PI / 2 },
];

function classifyDigitalDir(rawX: number, rawY: number, dz: number, halfWedgeDeg: number): DigitalDir {
  const mag = Math.hypot(rawX, rawY);
  if (mag < dz) return null;
  const halfWedgeRad = (halfWedgeDeg * Math.PI) / 180;
  const angle = Math.atan2(rawY, rawX); // -π .. π
  for (const c of CARDINAL_ANGLES) {
    let diff = angle - c.center;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) <= halfWedgeRad) return c.dir;
  }
  return null; // in a diagonal dead zone
}

// ---------- Gamepad viewer ----------
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function GamepadViewer({
  slotRef,
  stickRef,
  deadzoneRef,
  halfWedgeRef,
}: {
  slotRef: React.MutableRefObject<number>;
  stickRef: React.MutableRefObject<"left" | "right">;
  deadzoneRef: React.MutableRefObject<number>;
  halfWedgeRef: React.MutableRefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 260;
    const H = 340;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const ctrX = W / 2;
    const ctrY = 150;
    const R = 104;

    // Direction labels and their angles (atan2 space)
    const DIRS: { dir: DigitalDir; label: string; angle: number }[] = [
      { dir: "right", label: "D",  angle: 0 },
      { dir: "down",  label: "S",  angle: Math.PI / 2 },
      { dir: "left",  label: "A",  angle: Math.PI },
      { dir: "up",    label: "W",  angle: -Math.PI / 2 },
    ];

    let raf = 0;
    const draw = () => {
      const pads = navigator.getGamepads();
      const gp = pads[slotRef.current];
      const connected = !!gp;
      const axOff = stickRef.current === "right" ? 2 : 0;
      const rawX = gp ? gp.axes[axOff] || 0 : 0;
      const rawY = gp ? gp.axes[axOff + 1] || 0 : 0;
      const dz = deadzoneRef.current;
      const hwDeg = halfWedgeRef.current;
      const hwRad = (hwDeg * Math.PI) / 180;
      const mag = Math.hypot(rawX, rawY);
      const activeDir = classifyDigitalDir(rawX, rawY, dz, hwDeg);

      ctx.clearRect(0, 0, W, H);

      // Panel background
      ctx.fillStyle = "rgba(10,12,24,0.82)";
      roundRect(ctx, 0, 0, W, H, 12);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 12);
      ctx.stroke();

      // ---- Draw directional wedges ----
      for (const d of DIRS) {
        const a0 = d.angle - hwRad;
        const a1 = d.angle + hwRad;
        const isActive = activeDir === d.dir;

        // Filled wedge (from deadzone ring to outer ring)
        ctx.beginPath();
        ctx.arc(ctrX, ctrY, R * dz, a0, a1);
        ctx.arc(ctrX, ctrY, R, a1, a0, true);
        ctx.closePath();
        ctx.fillStyle = isActive
          ? "rgba(56,189,248,0.28)"
          : "rgba(255,255,255,0.04)";
        ctx.fill();

        // Wedge border lines (the threshold boundaries)
        ctx.strokeStyle = isActive
          ? "rgba(56,189,248,0.7)"
          : "rgba(255,255,255,0.18)";
        ctx.lineWidth = isActive ? 2 : 1;
        for (const a of [a0, a1]) {
          ctx.beginPath();
          ctx.moveTo(ctrX + Math.cos(a) * R * dz, ctrY + Math.sin(a) * R * dz);
          ctx.lineTo(ctrX + Math.cos(a) * R, ctrY + Math.sin(a) * R);
          ctx.stroke();
        }

        // Direction label at 70% radius along the cardinal axis
        const lx = ctrX + Math.cos(d.angle) * R * 0.70;
        const ly = ctrY + Math.sin(d.angle) * R * 0.70;
        ctx.font = isActive ? "bold 16px monospace" : "14px monospace";
        ctx.fillStyle = isActive ? "#fff" : "rgba(255,255,255,0.4)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(d.label, lx, ly);
      }

      // ---- Diagonal dead zone labels ----
      const diagAngles = [Math.PI / 4, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, -Math.PI / 4];
      for (const a of diagAngles) {
        const lx = ctrX + Math.cos(a) * R * 0.58;
        const ly = ctrY + Math.sin(a) * R * 0.58;
        ctx.font = "9px monospace";
        ctx.fillStyle = "rgba(255,90,90,0.45)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("DZ", lx, ly);
      }

      // ---- Concentric granularity rings ----
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (const f of [0.25, 0.5, 0.75]) {
        ctx.beginPath();
        ctx.arc(ctrX, ctrY, R * f, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Outer boundary
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ctrX, ctrY, R, 0, Math.PI * 2);
      ctx.stroke();

      // ---- Center deadzone disc ----
      ctx.beginPath();
      ctx.arc(ctrX, ctrY, R * dz, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,60,60,0.12)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,90,90,0.55)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      // "DZ" label in center
      if (dz > 0.05) {
        ctx.font = "9px monospace";
        ctx.fillStyle = "rgba(255,90,90,0.6)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("DZ", ctrX, ctrY + R * dz * 0.45);
      }

      // ---- Stick position dot ----
      const dispMag = Math.min(1, mag);
      const nx = mag > 0 ? rawX / mag : 0;
      const ny = mag > 0 ? rawY / mag : 0;
      const px = ctrX + nx * dispMag * R;
      const py = ctrY + ny * dispMag * R;

      const dotColor = !connected
        ? "#666"
        : activeDir != null
          ? ACCENT
          : "rgba(180,180,200,0.7)";

      // Line from center to dot
      ctx.strokeStyle = dotColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ctrX, ctrY);
      ctx.lineTo(px, py);
      ctx.stroke();

      // Dot
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Center pip
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.arc(ctrX, ctrY, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // ---- Header ----
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.font = "700 13px monospace";
      ctx.fillStyle = "#fff";
      ctx.fillText(stickRef.current === "right" ? "RIGHT STICK" : "LEFT STICK", 14, 24);
      ctx.textAlign = "right";
      ctx.fillStyle = connected ? "#5fe08a" : "#e05f5f";
      ctx.fillText(connected ? "● LIVE" : "○ NONE", W - 14, 24);

      // Active direction indicator
      ctx.textAlign = "center";
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = activeDir != null ? ACCENT : "rgba(255,255,255,0.3)";
      ctx.fillText(
        activeDir != null ? `→ ${activeDir.toUpperCase()}` : "—",
        W / 2, 40,
      );

      // ---- Numeric readouts ----
      const fmt = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(3);
      const yText = ctrY + R + 28;
      ctx.font = "12px monospace";
      ctx.fillStyle = "#cde";
      ctx.textAlign = "left";
      ctx.fillText(`X ${fmt(rawX)}`, 18, yText);
      ctx.fillText(`Y ${fmt(rawY)}`, 18, yText + 18);
      ctx.textAlign = "right";
      const ang = (Math.atan2(rawY, rawX) * 180) / Math.PI;
      ctx.fillText(`MAG ${mag.toFixed(3)}`, W - 18, yText);
      ctx.fillText(`${ang.toFixed(0)}°`, W - 18, yText + 18);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [slotRef, stickRef, deadzoneRef, halfWedgeRef]);

  return <canvas ref={canvasRef} style={{ display: "block" }} />;
}

function ZmqViewer({
  zmqRawRef,
  deadzoneRef,
  halfWedgeRef,
}: {
  zmqRawRef: React.MutableRefObject<{ x: number; y: number }>;
  deadzoneRef: React.MutableRefObject<number>;
  halfWedgeRef: React.MutableRefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 260;
    const H = 340;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const ctrX = W / 2;
    const ctrY = 150;
    const R = 104;

    const DIRS: { dir: DigitalDir; label: string; angle: number }[] = [
      { dir: "right", label: "D",  angle: 0 },
      { dir: "down",  label: "S",  angle: Math.PI / 2 },
      { dir: "left",  label: "A",  angle: Math.PI },
      { dir: "up",    label: "W",  angle: -Math.PI / 2 },
    ];

    let raf = 0;
    const draw = () => {
      const rawX = zmqRawRef.current.x;
      const rawY = zmqRawRef.current.y;
      const hasSignal = rawX !== 0 || rawY !== 0;
      const dz = deadzoneRef.current;
      const hwDeg = halfWedgeRef.current;
      const hwRad = (hwDeg * Math.PI) / 180;
      const mag = Math.hypot(rawX, rawY);
      const activeDir = classifyDigitalDir(rawX, rawY, dz, hwDeg);

      ctx.clearRect(0, 0, W, H);

      ctx.fillStyle = "rgba(10,12,24,0.82)";
      roundRect(ctx, 0, 0, W, H, 12);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 12);
      ctx.stroke();

      for (const d of DIRS) {
        const a0 = d.angle - hwRad;
        const a1 = d.angle + hwRad;
        const isActive = activeDir === d.dir;

        ctx.beginPath();
        ctx.arc(ctrX, ctrY, R * dz, a0, a1);
        ctx.arc(ctrX, ctrY, R, a1, a0, true);
        ctx.closePath();
        ctx.fillStyle = isActive
          ? "rgba(56,189,248,0.28)"
          : "rgba(255,255,255,0.04)";
        ctx.fill();

        ctx.strokeStyle = isActive
          ? "rgba(56,189,248,0.7)"
          : "rgba(255,255,255,0.18)";
        ctx.lineWidth = isActive ? 2 : 1;
        for (const a of [a0, a1]) {
          ctx.beginPath();
          ctx.moveTo(ctrX + Math.cos(a) * R * dz, ctrY + Math.sin(a) * R * dz);
          ctx.lineTo(ctrX + Math.cos(a) * R, ctrY + Math.sin(a) * R);
          ctx.stroke();
        }

        const lx = ctrX + Math.cos(d.angle) * R * 0.70;
        const ly = ctrY + Math.sin(d.angle) * R * 0.70;
        ctx.font = isActive ? "bold 16px monospace" : "14px monospace";
        ctx.fillStyle = isActive ? "#fff" : "rgba(255,255,255,0.4)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(d.label, lx, ly);
      }

      const diagAngles = [Math.PI / 4, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, -Math.PI / 4];
      for (const a of diagAngles) {
        const lx = ctrX + Math.cos(a) * R * 0.58;
        const ly = ctrY + Math.sin(a) * R * 0.58;
        ctx.font = "9px monospace";
        ctx.fillStyle = "rgba(255,90,90,0.45)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("DZ", lx, ly);
      }

      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (const f of [0.25, 0.5, 0.75]) {
        ctx.beginPath();
        ctx.arc(ctrX, ctrY, R * f, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ctrX, ctrY, R, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(ctrX, ctrY, R * dz, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,60,60,0.12)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,90,90,0.55)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      if (dz > 0.05) {
        ctx.font = "9px monospace";
        ctx.fillStyle = "rgba(255,90,90,0.6)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("DZ", ctrX, ctrY + R * dz * 0.45);
      }

      const dispMag = Math.min(1, mag);
      const nx = mag > 0 ? rawX / mag : 0;
      const ny = mag > 0 ? rawY / mag : 0;
      const px = ctrX + nx * dispMag * R;
      const py = ctrY + ny * dispMag * R;

      const dotColor = !hasSignal && mag < 0.001
        ? "#666"
        : activeDir != null
          ? ACCENT
          : "rgba(180,180,200,0.7)";

      ctx.strokeStyle = dotColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ctrX, ctrY);
      ctx.lineTo(px, py);
      ctx.stroke();

      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.arc(ctrX, ctrY, 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.font = "700 13px monospace";
      ctx.fillStyle = "#fff";
      ctx.fillText("ZMQ INPUT", 14, 24);
      ctx.textAlign = "right";
      ctx.fillStyle = hasSignal ? "#5fe08a" : "#e0c75f";
      ctx.fillText(hasSignal ? "● LIVE" : "○ IDLE", W - 14, 24);

      ctx.textAlign = "center";
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = activeDir != null ? ACCENT : "rgba(255,255,255,0.3)";
      ctx.fillText(
        activeDir != null ? `→ ${activeDir.toUpperCase()}` : "—",
        W / 2, 40,
      );

      const fmt = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(3);
      const yText = ctrY + R + 28;
      ctx.font = "12px monospace";
      ctx.fillStyle = "#cde";
      ctx.textAlign = "left";
      ctx.fillText(`X ${fmt(rawX)}`, 18, yText);
      ctx.fillText(`Y ${fmt(rawY)}`, 18, yText + 18);
      ctx.textAlign = "right";
      const ang = (Math.atan2(rawY, rawX) * 180) / Math.PI;
      ctx.fillText(`MAG ${mag.toFixed(3)}`, W - 18, yText);
      ctx.fillText(`${ang.toFixed(0)}°`, W - 18, yText + 18);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [zmqRawRef, deadzoneRef, halfWedgeRef]);

  return <canvas ref={canvasRef} style={{ display: "block" }} />;
}

// Build the first platform — the only one that exists at run start.
// Subsequent platforms are spawned in front of the player on completion.
function buildInitialPool(): { platforms: PlatformDef[]; nextId: number } {
  const first: PlatformDef = {
    id: 0,
    position: [0, PLATFORM_HEIGHT, PLATFORM_Z_START],
    baseColor: PLATFORM_COLORS[0],
  };
  return { platforms: [first], nextId: 1 };
}

// Spawn a new platform at the given world position with the next id.
function spawnPlatform(
  id: number,
  x: number,
  z: number,
): PlatformDef {
  return {
    id,
    position: [x, PLATFORM_HEIGHT, z],
    baseColor: PLATFORM_COLORS[id % PLATFORM_COLORS.length],
  };
}

// ---------- Main page ----------
export default function Hurricane() {
  // Game style: "standard" = dwell platforms, "precise" = track the dot
  type GameStyle = "standard" | "precise";
  const [gameStyle, setGameStyle] = useState<GameStyle>("standard");

  // Settings (live-editable) — shared
  const [analogMode, setAnalogMode] = useState<AnalogMode>("none");
  const [gamepadSlot, setGamepadSlot] = useState(0);
  const [gamepadStick, setGamepadStick] = useState<"left" | "right">("left");
  const [sensitivity, setSensitivity] = useState(0.25);
  const [deadzone, setDeadzone] = useState(0.1);
  const [halfWedge, setHalfWedge] = useState(DEFAULT_HALF_WEDGE_DEG);
  const [invertZ, setInvertZ] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);

  // Settings — Standard mode only
  const [dwellTime, setDwellTime] = useState(2);
  const [platformRadius, setPlatformRadius] = useState(0.5);
  const [targetDistance, setTargetDistance] = useState(PLATFORM_GAP_DEFAULT);

  // Settings — Precise mode only
  const [dotSpeed, setDotSpeed] = useState(1.0);
  const [dotSmoothness, setDotSmoothness] = useState(0.8);
  const [dotSize, setDotSize] = useState(0.3);

  // Refs synced from state for use inside useFrame
  const dwellTimeRef = useRef(dwellTime);
  const platformRadiusRef = useRef(platformRadius);
  const analogModeRef = useRef<AnalogMode>(analogMode);
  const gamepadSlotRef = useRef(gamepadSlot);
  const gamepadStickRef = useRef(gamepadStick);
  const sensitivityRef = useRef(sensitivity);
  const deadzoneRef = useRef(deadzone);
  const halfWedgeRef = useRef(halfWedge);
  const invertZRef = useRef(invertZ);
  const targetDistanceRef = useRef(targetDistance);
  const dotSpeedRef = useRef(dotSpeed);
  const dotSmoothnessRef = useRef(dotSmoothness);
  const dotSizeRef = useRef(dotSize);
  useEffect(() => { dwellTimeRef.current = dwellTime; }, [dwellTime]);
  useEffect(() => { platformRadiusRef.current = platformRadius; }, [platformRadius]);
  useEffect(() => { analogModeRef.current = analogMode; }, [analogMode]);
  useEffect(() => { gamepadSlotRef.current = gamepadSlot; }, [gamepadSlot]);
  useEffect(() => { gamepadStickRef.current = gamepadStick; }, [gamepadStick]);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { deadzoneRef.current = deadzone; }, [deadzone]);
  useEffect(() => { halfWedgeRef.current = halfWedge; }, [halfWedge]);
  useEffect(() => { invertZRef.current = invertZ; }, [invertZ]);
  useEffect(() => { targetDistanceRef.current = targetDistance; }, [targetDistance]);
  useEffect(() => { dotSpeedRef.current = dotSpeed; }, [dotSpeed]);
  useEffect(() => { dotSmoothnessRef.current = dotSmoothness; }, [dotSmoothness]);
  useEffect(() => { dotSizeRef.current = dotSize; }, [dotSize]);

  // The precise dot's current X, written by PreciseDot, read by PreciseTracker
  const dotXRef = useRef(0);

  // Pause toggles pointer-lock-free; the actual pausedRef.current value is
  // assigned in a useEffect below that accounts for BOTH the settings overlay
  // and the stats overlay.
  const pausedRef = useRef(true);

  // Game state refs
  const posRef = useRef(new THREE.Vector3(0, CHAR_FEET_Y, 0));
  const dwellStateRef = useRef<DwellState>({ activeId: null, progress: 0 });
  const completedRef = useRef<Set<number>>(new Set());

  // Audio feedback (created once, on the client only — guarded for SSR).
  const audioRef = useRef<AudioFeedback | null>(null);
  if (audioRef.current === null && typeof window !== "undefined") {
    audioRef.current = new AudioFeedback();
  }

  // Per-platform stats — persists across the whole run, including for
  // platforms that have already been pruned out of the visible pool.
  const statsRef = useRef<Map<number, PlatformStats>>(new Map());
  // Path-efficiency accumulators. cumPathRef sums |dx, dz| since the last
  // completion (or run start); lastCompletionPosRef holds the player's
  // position at that moment (origin for the very first target).
  const cumPathRef = useRef(0);
  const lastCompletionPosRef = useRef({ x: 0, z: 0 });
  // Active-play-time getter (set below once currentPlayMs is defined).
  const playMsGetterRef = useRef<() => number>(() => 0);
  // Forward ref to downloadCsv so resetRun (defined above downloadCsv) can
  // trigger a save without a circular useCallback dependency.
  const downloadCsvRef = useRef<() => void>(() => {});

  // Input refs
  const keyRef = useRef({ w: false, a: false, s: false, d: false });
  const gamepadRef = useRef({ lx: 0, ly: 0 });
  const bciRef = useRef({ x: 0, y: 0 });
  const zmqRawRef = useRef({ x: 0, y: 0 });
  const zmqService = useRef<ReturnType<typeof VelocityZmqListener.factory> | null>(null);

  // ---- Platform pool ----
  // At any moment exactly one platform exists. When the player completes it,
  // handleComplete swaps in a new one spawned directly in front of the
  // player's current position (so only walking forward gets them there).
  const initialPool = useMemo(() => buildInitialPool(), []);
  const [platforms, setPlatforms] = useState<PlatformDef[]>(initialPool.platforms);
  const nextIdRef = useRef(initialPool.nextId);

  // Active target is always whatever's in `platforms`. The Scene receives
  // this directly — kept as a slice in case we ever want a transitional
  // "old + new" frame.
  const activePlatforms = platforms;

  // ---- TPM tracking ----
  // Wall-clock-independent play time, paused while settings overlay is open.
  // `playStartRef` is null when paused; `accumulatedPlayMsRef` is the sum of
  // all completed play segments. `currentPlayMs` returns total active play.
  const playStartRef = useRef<number | null>(null);
  const accumulatedPlayMsRef = useRef(0);
  const completionPlayMsRef = useRef<number[]>([]);
  const completedCountRef = useRef(0);

  const currentPlayMs = useCallback(() => {
    let ms = accumulatedPlayMsRef.current;
    if (playStartRef.current != null) {
      ms += performance.now() - playStartRef.current;
    }
    return ms;
  }, []);

  // Keep the getter ref in sync so MovementController can timestamp attempts
  // in active-play time (excludes paused intervals).
  useEffect(() => {
    playMsGetterRef.current = currentPlayMs;
  }, [currentPlayMs]);

  // Play-clock pause/resume lives in a useEffect below that accounts for both
  // the settings overlay and the stats overlay.

  // ---- Precise tracking accumulators ----
  // Per-frame distance samples (array of {playMs, distance}) for rolling avg.
  const preciseDistSamplesRef = useRef<{ t: number; d: number }[]>([]);
  // Written every frame by PreciseTracker; read by HUD interval.
  const preciseInstantDistRef = useRef(0);

  // HUD display state, refreshed at ~4 Hz.
  const [hud, setHud] = useState({
    completedCount: 0,
    tpmRolling: NaN as number,
    playSeconds: 0,
    preciseInstant: 0,
    preciseRollingAvg: 0,
  });
  useEffect(() => {
    const id = window.setInterval(() => {
      const playMs = currentPlayMs();
      const windowStart = playMs - TPM_ROLLING_WINDOW_MS;
      // Drop completions outside the rolling window.
      const inWindow = completionPlayMsRef.current.filter((t) => t >= windowStart);
      completionPlayMsRef.current = inWindow;
      const oneMinuteReached = playMs >= TPM_ROLLING_WINDOW_MS;
      const tpmRolling = oneMinuteReached
        ? (inWindow.length * 60_000) / TPM_ROLLING_WINDOW_MS
        : NaN;
      // Precise rolling average distance (same 60s window).
      const pSamples = preciseDistSamplesRef.current;
      const pInWindow = pSamples.filter((s) => s.t >= windowStart);
      preciseDistSamplesRef.current = pInWindow;
      const preciseRollingAvg =
        pInWindow.length > 0
          ? pInWindow.reduce((sum, s) => sum + s.d, 0) / pInWindow.length
          : 0;
      setHud({
        completedCount: completedCountRef.current,
        tpmRolling,
        playSeconds: playMs / 1000,
        preciseInstant: preciseInstantDistRef.current,
        preciseRollingAvg,
      });
    }, HUD_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [currentPlayMs]);

  // Keyboard
  useEffect(() => {
    const isEditing = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = (el as HTMLElement).tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
    };
    const setKey = (e: KeyboardEvent, v: boolean) => {
      switch (e.code) {
        case "KeyW": keyRef.current.w = v; break;
        case "KeyA": keyRef.current.a = v; break;
        case "KeyS": keyRef.current.s = v; break;
        case "KeyD": keyRef.current.d = v; break;
        default: return;
      }
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        // Stats overlay takes precedence — close it first if it's open.
        if (statsOpenRef.current) {
          setStatsOpen(false);
        } else {
          setSettingsOpen((s) => !s);
        }
        keyRef.current = { w: false, a: false, s: false, d: false };
        return;
      }
      if (isEditing()) return;
      setKey(e, true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (isEditing()) return;
      setKey(e, false);
    };
    const onBlur = () => {
      keyRef.current = { w: false, a: false, s: false, d: false };
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Gamepad polling — digitized to WASD-style cardinal directions.
  // The raw stick is classified into one of four cardinal wedges (or center/
  // diagonal dead zones). The output is snapped to ±1 on a single axis.
  useEffect(() => {
    if (analogMode !== "gamepad") {
      gamepadRef.current.lx = 0;
      gamepadRef.current.ly = 0;
      return;
    }
    let raf = 0;
    const poll = () => {
      const pads = navigator.getGamepads();
      const gp = pads[gamepadSlotRef.current];
      if (gp) {
        const axOff = gamepadStickRef.current === "right" ? 2 : 0;
        const rawX = gp.axes[axOff] || 0;
        const rawY = gp.axes[axOff + 1] || 0;
        const dir = classifyDigitalDir(rawX, rawY, deadzoneRef.current, halfWedgeRef.current);
        switch (dir) {
          case "left":  gamepadRef.current.lx = -1; gamepadRef.current.ly =  0; break;
          case "right": gamepadRef.current.lx =  1; gamepadRef.current.ly =  0; break;
          case "up":    gamepadRef.current.lx =  0; gamepadRef.current.ly = -1; break;
          case "down":  gamepadRef.current.lx =  0; gamepadRef.current.ly =  1; break;
          default:      gamepadRef.current.lx =  0; gamepadRef.current.ly =  0; break;
        }
      } else {
        gamepadRef.current.lx = 0;
        gamepadRef.current.ly = 0;
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [analogMode]);

  // ZMQ — analog or digital mode
  const zmqIsDigital = analogMode === "zmq-digital";
  const zmqActive = analogMode === "zmq" || analogMode === "zmq-digital";
  useEffect(() => {
    if (!zmqActive) {
      bciRef.current.x = 0;
      bciRef.current.y = 0;
      return;
    }
    if (!zmqService.current) zmqService.current = VelocityZmqListener.factory();
    const svc = zmqService.current;
    svc.start();
    const handle = (data: DecodePacket) => {
      const sx = data.final_velocity_x * BCI_MOVE_SCALE;
      const sy = data.final_velocity_y * BCI_MOVE_SCALE;
      const cx = Math.max(-1, Math.min(1, sx));
      const cy = Math.max(-1, Math.min(1, sy));
      zmqRawRef.current.x = cx;
      zmqRawRef.current.y = cy;
      if (zmqIsDigital) {
        const dir = classifyDigitalDir(cx, cy, deadzoneRef.current, halfWedgeRef.current);
        switch (dir) {
          case "left":  bciRef.current.x = -1; bciRef.current.y =  0; break;
          case "right": bciRef.current.x =  1; bciRef.current.y =  0; break;
          case "up":    bciRef.current.x =  0; bciRef.current.y = -1; break;
          case "down":  bciRef.current.x =  0; bciRef.current.y =  1; break;
          default:      bciRef.current.x =  0; bciRef.current.y =  0; break;
        }
      } else {
        bciRef.current.x = cx;
        bciRef.current.y = cy;
      }
    };
    svc.events.on(ZmqClient.EVENT_MESSAGE, handle);
    return () => {
      svc.events.off(ZmqClient.EVENT_MESSAGE, handle);
      svc.stop();
      bciRef.current.x = 0;
      bciRef.current.y = 0;
      zmqRawRef.current.x = 0;
      zmqRawRef.current.y = 0;
    };
  }, [zmqActive, zmqIsDigital]);

  // Unlock the AudioContext on first user gesture (browsers block audio
  // until then). The listeners stay attached so any subsequent gesture also
  // resumes the context if the browser re-suspends it.
  useEffect(() => {
    const unlock = () => {
      audioRef.current?.unlock();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Poll dwell + completion state each frame and emit audio cues on
  // step-on / step-off / completion edges. Completion is checked first so a
  // chime plays instead of the leave-thunk on the frame a target is cleared.
  useEffect(() => {
    let raf = 0;
    let prevActive: number | null = null;
    let prevCompleted = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        const curActive = dwellStateRef.current.activeId;
        const curCompleted = completedCountRef.current;
        if (curCompleted > prevCompleted) {
          a.playComplete();
          a.setOn(false);
        } else if (prevActive !== curActive) {
          if (curActive != null) {
            a.setOn(true);
          } else if (prevActive != null) {
            a.playLeave();
            a.setOn(false);
          }
        }
        prevActive = curActive;
        prevCompleted = curCompleted;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audioRef.current?.setOn(false);
    };
  }, []);

  // Tear down the AudioContext on unmount.
  useEffect(() => {
    return () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, []);

  const handleComplete = useCallback((completedId: number) => {
    completedCountRef.current += 1;
    completionPlayMsRef.current.push(currentPlayMs());
    // Spawn the next target directly in front of the player (current x, plus
    // a gap in z). Compute id + position OUTSIDE the setPlatforms updater so
    // React Strict Mode's double-invoke doesn't double-bump the id counter.
    const newId = nextIdRef.current++;
    const newX = posRef.current.x;
    const newZ = posRef.current.z + nextGapZ(targetDistanceRef.current);
    const next = spawnPlatform(newId, newX, newZ);
    setPlatforms((prev) => {
      const filtered = prev.filter((p) => p.id !== completedId);
      return [...filtered, next];
    });
  }, [currentPlayMs]);

  const resetRun = useCallback(() => {
    if (statsRef.current.size > 0) {
      downloadCsvRef.current();
    }
    posRef.current.set(0, CHAR_FEET_Y, 0);
    completedRef.current = new Set();
    dwellStateRef.current = { activeId: null, progress: 0 };
    completedCountRef.current = 0;
    completionPlayMsRef.current = [];
    accumulatedPlayMsRef.current = 0;
    playStartRef.current = null;
    statsRef.current = new Map();
    cumPathRef.current = 0;
    lastCompletionPosRef.current = { x: 0, z: 0 };
    preciseDistSamplesRef.current = [];
    preciseInstantDistRef.current = 0;
    dotXRef.current = 0;
    setHud({ completedCount: 0, tpmRolling: NaN, playSeconds: 0, preciseInstant: 0, preciseRollingAvg: 0 });
    // Re-seed the platform pool so the run starts on a fresh course.
    const seed = buildInitialPool();
    nextIdRef.current = seed.nextId;
    setPlatforms(seed.platforms);
  }, []);

  // ---------- Stats overlay ----------
  const [statsOpen, setStatsOpen] = useState(false);
  // Mirror of statsOpen so the keyboard handler (which is registered once) can
  // synchronously see the latest value without going through a state updater.
  const statsOpenRef = useRef(statsOpen);
  useEffect(() => {
    statsOpenRef.current = statsOpen;
  }, [statsOpen]);
  // Snapshot of stats data taken when the overlay opens, sorted by platform id.
  const [statsSnapshot, setStatsSnapshot] = useState<PlatformStats[]>([]);
  useEffect(() => {
    if (!statsOpen) return;
    const snapshot = Array.from(statsRef.current.values()).sort(
      (a, b) => a.platformId - b.platformId,
    );
    setStatsSnapshot(snapshot);
  }, [statsOpen]);

  // Pause whenever EITHER overlay is open.
  useEffect(() => {
    pausedRef.current = settingsOpen || statsOpen;
  }, [settingsOpen, statsOpen]);

  // Pause the play clock whenever any overlay is open.
  useEffect(() => {
    const overlayOpen = settingsOpen || statsOpen;
    if (overlayOpen) {
      if (playStartRef.current != null) {
        accumulatedPlayMsRef.current += performance.now() - playStartRef.current;
        playStartRef.current = null;
      }
    } else {
      playStartRef.current = performance.now();
    }
  }, [settingsOpen, statsOpen]);

  const downloadCsv = useCallback(() => {
    const lines: string[] = [];
    lines.push(
      [
        "platform_id",
        "platform_z_m",
        "platform_x_m",
        "completed",
        "time_to_complete_ms",
        "step_off_count",
        "total_distance_on_platform_m",
        "median_radius_m",
        "mean_radius_m",
        "straight_line_from_previous_m",
        "actual_path_from_previous_m",
        "path_efficiency",
      ].join(","),
    );

    const all = Array.from(statsRef.current.values()).sort(
      (a, b) => a.platformId - b.platformId,
    );
    for (const ps of all) {
      if (ps.attempts.length === 0) continue;
      const median = computeMedian(ps.radiusSamples);
      const mean =
        ps.radiusSamples.length > 0
          ? ps.radiusSamples.reduce((s, v) => s + v, 0) / ps.radiusSamples.length
          : 0;
      const stepOffs = ps.attempts.filter((a) => a.outcome === "off").length;
      const completed = ps.attempts.some((a) => a.outcome === "complete") ? 1 : 0;
      const ttp = computeTimeToComplete(ps);
      lines.push(
        [
          ps.platformId,
          ps.platformZ.toFixed(3),
          ps.platformX.toFixed(3),
          completed,
          ttp == null ? "" : ttp.toFixed(0),
          stepOffs,
          ps.totalDistanceM.toFixed(3),
          median.toFixed(3),
          mean.toFixed(3),
          ps.straightLineFromPreviousM == null
            ? ""
            : ps.straightLineFromPreviousM.toFixed(3),
          ps.pathLengthFromPreviousM == null
            ? ""
            : ps.pathLengthFromPreviousM.toFixed(3),
          ps.pathEfficiency == null ? "" : ps.pathEfficiency.toFixed(3),
        ].join(","),
      );
    }

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `hurricane-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // Keep the forward ref in sync so resetRun can call the latest downloadCsv.
  downloadCsvRef.current = downloadCsv;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#7ec8ff",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* HUD */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          zIndex: 10,
          color: "white",
          fontFamily: "monospace",
          fontSize: 18,
          textShadow: "0 0 8px rgba(0,0,0,0.7)",
          pointerEvents: "none",
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>
          Hurricane {gameStyle === "precise" ? "· Precise" : ""}
        </div>
        {gameStyle === "standard" ? (
          <>
            <div style={{ marginTop: 6 }}>
              Targets: {hud.completedCount}
            </div>
            <div style={{ marginTop: 2 }}>
              TPM (1 min): {Number.isFinite(hud.tpmRolling)
                ? hud.tpmRolling.toFixed(1)
                : "--"}
              {!Number.isFinite(hud.tpmRolling) && (
                <span style={{ color: "#aac", fontSize: 12, marginLeft: 6 }}>
                  (smoothing... {Math.max(0, 60 - Math.floor(hud.playSeconds))}s)
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 6 }}>
              Distance: {hud.preciseInstant.toFixed(2)} m
            </div>
            <div style={{ marginTop: 2 }}>
              Avg (60s): {hud.preciseRollingAvg.toFixed(2)} m
            </div>
          </>
        )}
        <div style={{ fontSize: 12, color: "#cce", marginTop: 4 }}>
          Play time: {formatPlayTime(hud.playSeconds)}
        </div>
        <div style={{ fontSize: 12, color: "#cce", marginTop: 2 }}>
          Esc to {settingsOpen ? "resume" : "pause / open settings"}
        </div>
      </div>

      {/* Input viewer (top-left, below HUD) — gamepad or ZMQ mode */}
      {analogMode === "gamepad" && (
        <div
          style={{
            position: "absolute",
            top: 150,
            left: 16,
            zIndex: 10,
          }}
        >
          <GamepadViewer slotRef={gamepadSlotRef} stickRef={gamepadStickRef} deadzoneRef={deadzoneRef} halfWedgeRef={halfWedgeRef} />
        </div>
      )}
      {analogMode === "zmq-digital" && (
        <div
          style={{
            position: "absolute",
            top: 150,
            left: 16,
            zIndex: 10,
          }}
        >
          <ZmqViewer zmqRawRef={zmqRawRef} deadzoneRef={deadzoneRef} halfWedgeRef={halfWedgeRef} />
        </div>
      )}

      {/* Stats button (top-right) */}
      <button
        onClick={() => setStatsOpen((s) => !s)}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          zIndex: 10,
          padding: "8px 14px",
          fontFamily: "monospace",
          fontSize: 13,
          border: `1px solid ${ACCENT}`,
          borderRadius: 8,
          background: "rgba(0,0,0,0.45)",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        Stats / CSV
      </button>

      {/* Pause / settings overlay */}
      {settingsOpen && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "rgba(20,20,40,0.92)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 12,
              padding: "28px 32px",
              minWidth: 320,
              maxHeight: "82vh",
              overflowY: "auto",
              color: "white",
              fontFamily: "monospace",
            }}
          >
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                marginBottom: 6,
                textAlign: "center",
              }}
            >
              Hurricane
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#aab",
                marginBottom: 22,
                textAlign: "center",
              }}
            >
              {gameStyle === "standard"
                ? "WASD to walk · dwell on platforms to clear them"
                : "WASD to move · stay as close to the red dot as possible"}
            </div>

            {/* Game style toggle */}
            <div style={{ marginBottom: 20 }}>
              <div style={LABEL}>Game Style</div>
              <div style={{ display: "flex", gap: 8 }}>
                {([
                  { id: "standard" as const, label: "Standard" },
                  { id: "precise" as const, label: "Precise" },
                ]).map((g) => {
                  const selected = gameStyle === g.id;
                  return (
                    <button
                      key={g.id}
                      onClick={() => { setGameStyle(g.id); resetRun(); }}
                      style={{
                        flex: 1,
                        padding: "8px 4px",
                        fontFamily: "monospace",
                        fontSize: 13,
                        fontWeight: selected ? 700 : 400,
                        border: "1px solid",
                        borderColor: selected ? ACCENT : "rgba(255,255,255,0.2)",
                        borderRadius: 6,
                        background: selected ? "rgba(56,189,248,0.22)" : "transparent",
                        color: selected ? "#fff" : "#888",
                        cursor: "pointer",
                      }}
                    >
                      {g.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Standard-only settings */}
            {gameStyle === "standard" && (
              <>
                {/* Dwell time */}
                <div style={{ marginBottom: 18 }}>
                  <div style={LABEL}>Dwell Time: {dwellTime.toFixed(2)} s</div>
                  <input
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.1}
                    value={dwellTime}
                    onChange={(e) => setDwellTime(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>0.5s</span>
                    <span>10s</span>
                  </div>
                </div>

                {/* Target size */}
                <div style={{ marginBottom: 18 }}>
                  <div style={LABEL}>Target Radius: {platformRadius.toFixed(2)} m</div>
                  <input
                    type="range"
                    min={0.25}
                    max={3}
                    step={0.05}
                    value={platformRadius}
                    onChange={(e) => setPlatformRadius(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>0.25 m</span>
                    <span>3 m</span>
                  </div>
                </div>

                {/* Target distance */}
                <div style={{ marginBottom: 18 }}>
                  <div style={LABEL}>Target Distance: {targetDistance.toFixed(1)} m</div>
                  <input
                    type="range"
                    min={3}
                    max={30}
                    step={0.5}
                    value={targetDistance}
                    onChange={(e) => setTargetDistance(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>3 m</span>
                    <span>30 m</span>
                  </div>
                </div>
              </>
            )}

            {/* Precise-only settings */}
            {gameStyle === "precise" && (
              <>
                {/* Dot speed */}
                <div style={{ marginBottom: 18 }}>
                  <div style={LABEL}>Dot Speed: {dotSpeed.toFixed(2)}</div>
                  <input
                    type="range"
                    min={0.1}
                    max={5}
                    step={0.05}
                    value={dotSpeed}
                    onChange={(e) => setDotSpeed(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>Slow</span>
                    <span>Fast</span>
                  </div>
                </div>

                {/* Dot smoothness */}
                <div style={{ marginBottom: 18 }}>
                  <div style={LABEL}>Dot Smoothness: {dotSmoothness.toFixed(2)}</div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={dotSmoothness}
                    onChange={(e) => setDotSmoothness(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>Jerky</span>
                    <span>Smooth</span>
                  </div>
                </div>

                {/* Dot size */}
                <div style={{ marginBottom: 18 }}>
                  <div style={LABEL}>Dot Size: {dotSize.toFixed(2)} m</div>
                  <input
                    type="range"
                    min={0.1}
                    max={1.5}
                    step={0.05}
                    value={dotSize}
                    onChange={(e) => setDotSize(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>Small</span>
                    <span>Large</span>
                  </div>
                </div>
              </>
            )}

            {/* Analog input mode */}
            <div style={{ marginBottom: 18 }}>
              <div style={LABEL}>Analog Input</div>
              <div style={{ display: "flex", gap: 6 }}>
                {(
                  [
                    { id: "none", label: "WASD only" },
                    { id: "gamepad", label: "Gamepad" },
                    { id: "zmq", label: "ZMQ" },
                    { id: "zmq-digital", label: "ZMQ Digital" },
                  ] as const
                ).map((opt) => {
                  const sel = analogMode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setAnalogMode(opt.id)}
                      style={{
                        flex: 1,
                        padding: "8px 4px",
                        fontFamily: "monospace",
                        fontSize: 12,
                        border: "1px solid",
                        borderColor: sel ? ACCENT : "rgba(255,255,255,0.2)",
                        borderRadius: 6,
                        background: sel ? "rgba(56,189,248,0.22)" : "transparent",
                        color: sel ? "#fff" : "#888",
                        cursor: "pointer",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Gamepad-only settings */}
            {analogMode === "gamepad" && (
              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    ...LABEL,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>Gamepad Slot</span>
                  <input
                    type="number"
                    min={0}
                    max={7}
                    step={1}
                    value={gamepadSlot}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      if (!isNaN(v)) setGamepadSlot(Math.min(7, Math.max(0, v)));
                    }}
                    style={{
                      width: 48,
                      background: "rgba(255,255,255,0.1)",
                      border: "1px solid rgba(255,255,255,0.2)",
                      borderRadius: 4,
                      color: "#fff",
                      fontFamily: "monospace",
                      fontSize: 13,
                      padding: "2px 6px",
                      textAlign: "right",
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  {(["left", "right"] as const).map((s) => {
                    const sel = gamepadStick === s;
                    return (
                      <button
                        key={s}
                        onClick={() => setGamepadStick(s)}
                        style={{
                          flex: 1,
                          padding: "6px 4px",
                          fontFamily: "monospace",
                          fontSize: 12,
                          border: "1px solid",
                          borderColor: sel ? ACCENT : "rgba(255,255,255,0.2)",
                          borderRadius: 6,
                          background: sel ? "rgba(56,189,248,0.22)" : "transparent",
                          color: sel ? "#fff" : "#888",
                          cursor: "pointer",
                        }}
                      >
                        {s === "left" ? "Left Stick" : "Right Stick"}
                      </button>
                    );
                  })}
                </div>
                <a
                  href="https://hardwaretester.com/gamepad"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    marginTop: 4,
                    fontSize: 11,
                    color: "rgba(255,255,255,0.5)",
                    textDecoration: "none",
                  }}
                >
                  Test gamepad ↗
                </a>
              </div>
            )}

            {/* Digital mapping settings — shared by gamepad & ZMQ Digital */}
            {(analogMode === "gamepad" || analogMode === "zmq-digital") && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ marginBottom: 4, fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase" }}>
                  Digital Mapping
                </div>
                <div style={{ marginTop: 8 }}>
                  <div style={LABEL}>Center Deadzone: {deadzone.toFixed(2)}</div>
                  <input
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={deadzone}
                    onChange={(e) => setDeadzone(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>0</span>
                    <span>0.5</span>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div style={LABEL}>Direction Wedge: ±{halfWedge}° ({halfWedge * 2}° total)</div>
                  <input
                    type="range"
                    min={10}
                    max={45}
                    step={1}
                    value={halfWedge}
                    onChange={(e) => setHalfWedge(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "#666",
                    }}
                  >
                    <span>±10° (narrow)</span>
                    <span>±45° (no gap)</span>
                  </div>
                </div>
              </div>
            )}

            {/* Invert forward/backward */}
            <div style={{ marginBottom: 18 }}>
              <button
                onClick={() => setInvertZ((v) => !v)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontFamily: "monospace",
                  fontSize: 13,
                  border: "1px solid",
                  borderColor: invertZ ? ACCENT : "rgba(255,255,255,0.2)",
                  borderRadius: 6,
                  background: invertZ ? "rgba(56,189,248,0.22)" : "transparent",
                  color: invertZ ? "#fff" : "#888",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>Reverse W/S</span>
                <span>{invertZ ? "ON" : "OFF"}</span>
              </button>
              <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
                {invertZ ? "S/Down = forward, W/Up = backward" : "W/Up = forward, S/Down = backward"}
              </div>
            </div>

            {/* Sensitivity */}
            <div style={{ marginBottom: 22 }}>
              <div style={LABEL}>Speed: {sensitivity.toFixed(2)}×</div>
              <input
                type="range"
                min={0.25}
                max={3}
                step={0.05}
                value={sensitivity}
                onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                style={SLIDER}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "#666",
                }}
              >
                <span>Slow</span>
                <span>Fast</span>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setSettingsOpen(false)}
                style={{
                  flex: 1,
                  padding: "12px 0",
                  fontFamily: "monospace",
                  fontSize: 15,
                  border: `1px solid ${ACCENT}`,
                  borderRadius: 8,
                  background: "rgba(56,189,248,0.28)",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                {hud.completedCount > 0 || hud.playSeconds > 0 ? "Resume" : "Start"}
              </button>
              <button
                onClick={() => {
                  resetRun();
                  setSettingsOpen(false);
                }}
                style={{
                  padding: "12px 16px",
                  fontFamily: "monospace",
                  fontSize: 13,
                  border: "1px solid rgba(255,255,255,0.25)",
                  borderRadius: 8,
                  background: "transparent",
                  color: "#ccc",
                  cursor: "pointer",
                }}
              >
                Reset run
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats overlay */}
      {statsOpen && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 25,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "rgba(20,20,40,0.94)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 12,
              padding: "24px 28px",
              width: "min(880px, 92vw)",
              maxHeight: "88vh",
              display: "flex",
              flexDirection: "column",
              color: "white",
              fontFamily: "monospace",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                Per-platform stats
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={downloadCsv}
                  disabled={statsSnapshot.length === 0}
                  style={{
                    padding: "8px 14px",
                    fontFamily: "monospace",
                    fontSize: 13,
                    border: `1px solid ${ACCENT}`,
                    borderRadius: 8,
                    background:
                      statsSnapshot.length === 0
                        ? "rgba(56,189,248,0.06)"
                        : "rgba(56,189,248,0.28)",
                    color: statsSnapshot.length === 0 ? "#888" : "#fff",
                    cursor:
                      statsSnapshot.length === 0 ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  Download CSV
                </button>
                <button
                  onClick={() => setStatsOpen(false)}
                  style={{
                    padding: "8px 14px",
                    fontFamily: "monospace",
                    fontSize: 13,
                    border: "1px solid rgba(255,255,255,0.25)",
                    borderRadius: 8,
                    background: "transparent",
                    color: "#ccc",
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "#aab", marginBottom: 16 }}>
              Game paused while this overlay is open. Stats reset with “Reset run”.
            </div>

            <div style={{ overflowY: "auto", flex: 1, paddingRight: 6 }}>
              {statsSnapshot.length === 0 ? (
                <div style={{ color: "#aab", fontSize: 13, padding: "12px 0" }}>
                  No data yet — step on a platform to start logging.
                </div>
              ) : (
                <>
                  {/* Summary table */}
                  <div
                    style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}
                  >
                    Summary
                  </div>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: 12,
                      marginBottom: 22,
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          textAlign: "left",
                          color: "#aac",
                          borderBottom: "1px solid rgba(255,255,255,0.15)",
                        }}
                      >
                        <th style={{ padding: "4px 8px" }}>#</th>
                        <th style={{ padding: "4px 8px" }}>z (m)</th>
                        <th style={{ padding: "4px 8px" }}>completed</th>
                        <th style={{ padding: "4px 8px" }}>
                          time to pop
                        </th>
                        <th style={{ padding: "4px 8px" }}>path eff</th>
                        <th style={{ padding: "4px 8px" }}>step-offs</th>
                        <th style={{ padding: "4px 8px" }}>
                          dist on plat (m)
                        </th>
                        <th style={{ padding: "4px 8px" }}>
                          median radius (m)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {statsSnapshot.map((ps) => {
                        const median = computeMedian(ps.radiusSamples);
                        const stepOffs = ps.attempts.filter(
                          (a) => a.outcome === "off",
                        ).length;
                        const completed = ps.attempts.some(
                          (a) => a.outcome === "complete",
                        );
                        const ttp = computeTimeToComplete(ps);
                        return (
                          <tr
                            key={ps.platformId}
                            style={{
                              borderBottom:
                                "1px solid rgba(255,255,255,0.05)",
                            }}
                          >
                            <td style={{ padding: "4px 8px" }}>
                              {ps.platformId}
                            </td>
                            <td style={{ padding: "4px 8px" }}>
                              {ps.platformZ.toFixed(1)}
                            </td>
                            <td
                              style={{
                                padding: "4px 8px",
                                color: completed ? "#7be08a" : "#888",
                              }}
                            >
                              {completed ? "✓" : "—"}
                            </td>
                            <td style={{ padding: "4px 8px" }}>
                              {ttp == null ? "—" : formatMs(ttp)}
                            </td>
                            <td style={{ padding: "4px 8px" }}>
                              {ps.pathEfficiency === undefined
                                ? "—"
                                : `${(ps.pathEfficiency * 100).toFixed(0)}%`}
                            </td>
                            <td style={{ padding: "4px 8px" }}>{stepOffs}</td>
                            <td style={{ padding: "4px 8px" }}>
                              {ps.totalDistanceM.toFixed(2)}
                            </td>
                            <td style={{ padding: "4px 8px" }}>
                              {median.toFixed(3)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <Canvas
        shadows
        camera={{ fov: 60, near: 0.1, far: 300, position: [0, 4, -7] }}
        style={{ width: "100%", height: "100%" }}
      >
        <Scene
          gameStyle={gameStyle}
          platforms={activePlatforms}
          posRef={posRef}
          pausedRef={pausedRef}
          keyRef={keyRef}
          gamepadRef={gamepadRef}
          bciRef={bciRef}
          analogModeRef={analogModeRef}
          sensitivityRef={sensitivityRef}
          invertZRef={invertZRef}
          dwellTimeRef={dwellTimeRef}
          platformRadiusRef={platformRadiusRef}
          dwellStateRef={dwellStateRef}
          completedRef={completedRef}
          statsRef={statsRef}
          cumPathRef={cumPathRef}
          lastCompletionPosRef={lastCompletionPosRef}
          playMsGetterRef={playMsGetterRef}
          onComplete={handleComplete}
          dotXRef={dotXRef}
          dotSpeedRef={dotSpeedRef}
          dotSmoothnessRef={dotSmoothnessRef}
          dotSizeRef={dotSizeRef}
          preciseInstantDistRef={preciseInstantDistRef}
          preciseDistSamplesRef={preciseDistSamplesRef}
        />
      </Canvas>
    </div>
  );
}
