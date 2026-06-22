"use client";

import React, { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import VelocityZmqListener, { DecodePacket } from "../ZmqListener";
import ZmqClient from "../ZmqClient";
import { upload } from "@vercel/blob/client";

declare namespace YT {
  class Player {
    constructor(el: string | HTMLElement, opts: Record<string, unknown>);
    playVideo(): void;
    pauseVideo(): void;
    loadVideoById(id: string): void;
    destroy(): void;
  }
}

const ROOM_SIZE = 24;
const HALF = ROOM_SIZE / 2;

const CAM_POS_CENTER: [number, number, number] = [0, 2, 0];
const CAM_POS_EDGE: [number, number, number] = [0, 2, HALF - 0.5];
const INITIAL_YAW = 0;
const YAW_LIMIT = Math.PI / 2;
const PITCH_LIMIT = Math.PI / 5;

const TARGET_DIST = 8;
const TARGET_X_SPREAD = 20;
const TARGET_Y_MIN = 0.5;
const TARGET_Y_MAX = 12;

const ZMQ_SCALE = 0.015;

type AimPoint = { x: number; y: number };

const WALL_PAD = 1.5;
const FLOOR_PAD = 0.5;
const CEIL_HEIGHT = 8;

function randomTargetPos(fullRange: boolean): [number, number, number] {
  if (fullRange) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    let x = Math.sin(phi) * Math.cos(theta) * TARGET_DIST;
    let y = Math.sin(phi) * Math.sin(theta) * TARGET_DIST;
    let z = Math.cos(phi) * TARGET_DIST;
    const limit = HALF - WALL_PAD;
    x = Math.max(-limit, Math.min(limit, x));
    z = Math.max(-limit, Math.min(limit, z));
    y = Math.max(FLOOR_PAD, Math.min(CEIL_HEIGHT - WALL_PAD, y));
    return [x, y, z];
  }
  const limit = HALF - WALL_PAD;
  const x = Math.max(-limit, Math.min(limit, (Math.random() - 0.5) * TARGET_X_SPREAD));
  const y = TARGET_Y_MIN + Math.random() * (Math.min(TARGET_Y_MAX, CEIL_HEIGHT - WALL_PAD) - TARGET_Y_MIN);
  const z = -TARGET_DIST;
  return [x, y, z];
}

const STAR_COUNT = 300;

function Stars({ fullRange }: { fullRange: boolean }) {
  const positions = useMemo(() => {
    const pos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      if (fullRange) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 35 + Math.random() * 10;
        pos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
        pos[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * r;
        pos[i * 3 + 2] = Math.cos(phi) * r;
      } else {
        pos[i * 3] = (Math.random() - 0.5) * 28;
        pos[i * 3 + 1] = 1 + Math.random() * 14;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 28;
      }
    }
    return pos;
  }, [fullRange]);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.06} color="#aaaaff" transparent opacity={0.35} sizeAttenuation />
    </points>
  );
}

function Room({ floorColor }: { floorColor: string }) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[ROOM_SIZE, ROOM_SIZE]} />
        <meshStandardMaterial color={floorColor} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 16, 0]}>
        <planeGeometry args={[ROOM_SIZE, ROOM_SIZE]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 8, -ROOM_SIZE / 2]}>
        <planeGeometry args={[ROOM_SIZE, 16]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 8, ROOM_SIZE / 2]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[ROOM_SIZE, 16]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-ROOM_SIZE / 2, 8, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[ROOM_SIZE, 16]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[ROOM_SIZE / 2, 8, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[ROOM_SIZE, 16]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <gridHelper args={[ROOM_SIZE, 20, "#6666aa", "#4a4a70"]} />
    </group>
  );
}

function FPSControls({ deltaRef, fullRange, sensitivityRef }: { deltaRef: React.MutableRefObject<AimPoint>; fullRange: boolean; sensitivityRef: React.MutableRefObject<number> }) {
  const { camera } = useThree();
  const euler = useRef(new THREE.Euler(0, INITIAL_YAW, 0, "YXZ"));
  const prevFullRange = useRef(fullRange);

  useEffect(() => {
    euler.current.set(0, INITIAL_YAW, 0, "YXZ");
    camera.position.set(...(fullRange ? CAM_POS_CENTER : CAM_POS_EDGE));
    camera.quaternion.setFromEuler(euler.current);
    prevFullRange.current = fullRange;
  }, [camera, fullRange]);

  useFrame(() => {

    const dx = deltaRef.current.x;
    const dy = deltaRef.current.y;
    if (dx === 0 && dy === 0) return;

    const sens = 0.002 * sensitivityRef.current;
    euler.current.y -= dx * sens;
    euler.current.x -= dy * sens;
    if (!fullRange) {
      euler.current.y = Math.max(INITIAL_YAW - YAW_LIMIT, Math.min(INITIAL_YAW + YAW_LIMIT, euler.current.y));
    }
    if (!fullRange) {
      euler.current.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, euler.current.x));
    }
    camera.quaternion.setFromEuler(euler.current);

    deltaRef.current.x = 0;
    deltaRef.current.y = 0;
  });

  return null;
}

function CursorControls({ deltaRef, aimRef, sensitivityRef, crosshairRef }: {
  deltaRef: React.MutableRefObject<AimPoint>;
  aimRef: React.MutableRefObject<AimPoint>;
  sensitivityRef: React.MutableRefObject<number>;
  crosshairRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { camera } = useThree();
  const initialized = useRef(false);

  useFrame(() => {
    if (!initialized.current) {
      const euler = new THREE.Euler(0, INITIAL_YAW, 0, "YXZ");
      camera.quaternion.setFromEuler(euler);
      initialized.current = true;
    }

    const dx = deltaRef.current.x;
    const dy = deltaRef.current.y;
    if (dx === 0 && dy === 0) return;

    const sens = 0.0015 * sensitivityRef.current;
    aimRef.current.x += dx * sens;
    aimRef.current.y -= dy * sens;
    aimRef.current.x = Math.max(-1, Math.min(1, aimRef.current.x));
    aimRef.current.y = Math.max(-1, Math.min(1, aimRef.current.y));

    deltaRef.current.x = 0;
    deltaRef.current.y = 0;

    if (crosshairRef.current) {
      crosshairRef.current.style.left = `${(aimRef.current.x + 1) / 2 * 100}%`;
      crosshairRef.current.style.top = `${(1 - aimRef.current.y) / 2 * 100}%`;
    }
  });

  return null;
}

function isTargetHit(scene: THREE.Scene, camera: THREE.Camera, raycaster: THREE.Raycaster, aim: AimPoint): boolean {
  raycaster.setFromCamera(new THREE.Vector2(aim.x, aim.y), camera);
  const intersects = raycaster.intersectObjects(scene.children, true);
  for (const intersect of intersects) {
    let obj: THREE.Object3D | null = intersect.object;
    while (obj) {
      if ((obj as any).__isTarget) return true;
      obj = obj.parent;
    }
  }
  return false;
}

interface ShootHandlerProps {
  onShot: () => void;
  onHit: () => void;
  aimRef: React.MutableRefObject<AimPoint>;
}

function ShootHandler({ onShot, onHit, aimRef }: ShootHandlerProps) {
  const { camera, scene } = useThree();
  const raycaster = useRef(new THREE.Raycaster());

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!document.pointerLockElement || e.button !== 0) return;
      onShot();
      if (isTargetHit(scene, camera, raycaster.current, aimRef.current)) {
        onHit();
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [camera, scene, onShot, onHit, aimRef]);

  return null;
}

function TrackHandler({ aimRef, trackingRef, dwellRef }: {
  aimRef: React.MutableRefObject<AimPoint>;
  trackingRef: React.MutableRefObject<{
    bucketOn: number[];
    bucketTotal: number[];
    lastSecIdx: number;
    lockedSeconds: number;
  }>;
  dwellRef: React.MutableRefObject<number>;
}) {
  const { camera, scene } = useThree();
  const raycaster = useRef(new THREE.Raycaster());

  useFrame((_, delta) => {
    if (!document.pointerLockElement) {
      dwellRef.current = 0;
      return;
    }
    const tr = trackingRef.current;
    tr.lockedSeconds += delta;
    const curSec = Math.floor(tr.lockedSeconds);
    if (curSec !== tr.lastSecIdx) {
      let step = tr.lastSecIdx + 1;
      while (step <= curSec) {
        const idx = step % 60;
        tr.bucketOn[idx] = 0;
        tr.bucketTotal[idx] = 0;
        step++;
      }
      tr.lastSecIdx = curSec;
    }
    const idx = curSec % 60;
    tr.bucketTotal[idx] += delta;
    const onTarget = isTargetHit(scene, camera, raycaster.current, aimRef.current);
    if (onTarget) {
      tr.bucketOn[idx] += delta;
      dwellRef.current = 1;
    } else {
      dwellRef.current = 0;
    }
  });

  return null;
}

function DwellHandler({ onHit, dwellTime, dwellRef, aimRef }: {
  onHit: () => void;
  dwellTime: number;
  dwellRef: React.MutableRefObject<number>;
  aimRef: React.MutableRefObject<AimPoint>;
}) {
  const { camera, scene } = useThree();
  const raycaster = useRef(new THREE.Raycaster());
  const hoverStart = useRef<number | null>(null);

  useFrame(() => {
    if (!document.pointerLockElement) {
      hoverStart.current = null;
      dwellRef.current = 0;
      return;
    }
    const hovering = isTargetHit(scene, camera, raycaster.current, aimRef.current);
    if (hovering) {
      if (hoverStart.current === null) hoverStart.current = performance.now();
      const elapsed = (performance.now() - hoverStart.current) / 1000;
      dwellRef.current = dwellTime > 0 ? Math.min(elapsed / dwellTime, 1) : 1;
      if (elapsed >= dwellTime) {
        onHit();
        hoverStart.current = null;
        dwellRef.current = 0;
      }
    } else {
      hoverStart.current = null;
      dwellRef.current = 0;
    }
  });

  return null;
}

// ---------- Red dot target texture ----------
// A simple solid red circle on a transparent background, shared by all targets.
let _redDotTexture: THREE.CanvasTexture | null = null;

function getRedDotTexture(): THREE.CanvasTexture {
  if (_redDotTexture) return _redDotTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "#ff4444");
  grad.addColorStop(0.85, "#ff1a1a");
  grad.addColorStop(1, "rgba(255,26,26,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(128, 128, 128, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _redDotTexture = tex;
  return tex;
}

function TaggedTarget({ position, radius, dwellRef, moving, precise, preciseSpeedRef }: {
  position: [number, number, number];
  radius: number;
  dwellRef: React.MutableRefObject<number>;
  moving: boolean;
  precise: boolean;
  preciseSpeedRef: React.MutableRefObject<number>;
}) {
  const spriteRef = useRef<THREE.Sprite>(null);
  const matRef = useRef<THREE.SpriteMaterial>(null);
  const motionSeed = useRef({
    f1: 0.3 + Math.random() * 0.3,
    f2: 0.35 + Math.random() * 0.35,
    f3: 0.2 + Math.random() * 0.2,
    p1: Math.random() * Math.PI * 2,
    p2: Math.random() * Math.PI * 2,
    p3: Math.random() * Math.PI * 2,
  });
  const virtTime = useRef(0);

  useEffect(() => {
    if (spriteRef.current) {
      (spriteRef.current as any).__isTarget = true;
    }
  }, []);

  useFrame(({ clock }, delta) => {
    if (spriteRef.current) {
      if (precise) {
        virtTime.current += delta * (preciseSpeedRef.current ?? 1);
        const t = virtTime.current;
        const s = motionSeed.current;
        const xSpan = 9;
        const ySpan = 2.5;
        const yCenter = 3.5;
        spriteRef.current.position.x = Math.sin(t * s.f1 + s.p1) * xSpan;
        spriteRef.current.position.y = yCenter + Math.sin(t * s.f2 + s.p2) * ySpan;
        spriteRef.current.position.z = -TARGET_DIST + Math.cos(t * s.f3 + s.p3) * 0.5;
      } else {
        const t = clock.elapsedTime;
        spriteRef.current.position.x = position[0];
        spriteRef.current.position.z = position[2];
        spriteRef.current.position.y = moving
          ? position[1] + Math.sin(t * 2) * 0.3
          : position[1];
      }
      const hoverScale = 1 + dwellRef.current * 0.18;
      const s = radius * 2 * hoverScale;
      spriteRef.current.scale.set(s, s, 1);
    }
    if (matRef.current) {
      const t = dwellRef.current;
      matRef.current.color.setRGB(1, 1 - t * 0.3, 1 - t * 0.3);
    }
  });

  const dotTexture = useMemo(
    () => (typeof window !== "undefined" ? getRedDotTexture() : null),
    [],
  );

  return (
    <sprite
      ref={spriteRef}
      position={position}
      scale={[radius * 2, radius * 2, 1]}
    >
      <spriteMaterial
        ref={matRef}
        map={dotTexture ?? undefined}
        color="#ffffff"
        transparent
        depthWrite={false}
      />
    </sprite>
  );
}

interface ArrowInfo {
  visible: boolean;
  x: number;
  y: number;
  angle: number;
}

const _projected = new THREE.Vector3();

function DirectionSensor({ targetPos, arrowRef }: {
  targetPos: [number, number, number];
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
    const hw = window.innerWidth / 2 - margin;
    const hh = window.innerHeight / 2 - margin;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const scale = Math.min(
      hw / (Math.abs(cos) || 0.001),
      hh / (Math.abs(sin) || 0.001),
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

function DirectionArrow({ locked, arrowRef }: {
  locked: boolean;
  arrowRef: React.MutableRefObject<ArrowInfo>;
}) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!locked) return;
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
  }, [locked, arrowRef]);

  if (!locked) return null;

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

function Skybox() {
  return (
    <group>
      <mesh>
        <sphereGeometry args={[50, 32, 32]} />
        <meshBasicMaterial color="#0a0a20" side={THREE.BackSide} />
      </mesh>
      {/* Latitude rings */}
      {[-20, -10, 0, 10, 20].map((y) => (
        <mesh key={`lat-${y}`} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[Math.sqrt(50 * 50 - y * y) - 0.08, Math.sqrt(50 * 50 - y * y) + 0.08, 64]} />
          <meshBasicMaterial color={y === 0 ? "#8899ee" : "#6677cc"} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* Longitude lines */}
      {Array.from({ length: 12 }, (_, i) => (i * Math.PI) / 6).map((angle) => (
        <mesh key={`lon-${angle}`} rotation={[0, angle, 0]}>
          <torusGeometry args={[50, 0.1, 8, 64]} />
          <meshBasicMaterial color="#6677cc" />
        </mesh>
      ))}
      {/* Axis markers */}
      <pointLight position={[0, 48, 0]} intensity={2.0} color="#4488ff" distance={20} />
      <pointLight position={[0, -48, 0]} intensity={2.0} color="#ff4444" distance={20} />
    </group>
  );
}

type Mode = "dwell" | "active" | "precise";
type AimStyle = "fps" | "cursor";

interface SceneProps {
  targetPos: [number, number, number];
  targetRadius: number;
  mode: Mode;
  aimStyle: AimStyle;
  dwellTime: number;
  dwellRef: React.MutableRefObject<number>;
  aimRef: React.MutableRefObject<AimPoint>;
  deltaRef: React.MutableRefObject<AimPoint>;
  arrowRef: React.MutableRefObject<ArrowInfo>;
  sensitivityRef: React.MutableRefObject<number>;
  crosshairRef: React.RefObject<HTMLDivElement | null>;
  onHit: () => void;
  onShot: () => void;
  locked: boolean;
  moving: boolean;
  fullRange: boolean;
  floorColor: string;
  trackingRef: React.MutableRefObject<{
    bucketOn: number[];
    bucketTotal: number[];
    lastSecIdx: number;
    lockedSeconds: number;
  }>;
  preciseSpeedRef: React.MutableRefObject<number>;
}

function Scene({ targetPos, targetRadius, mode, aimStyle, dwellTime, dwellRef, aimRef, deltaRef, arrowRef, sensitivityRef, crosshairRef, onHit, onShot, locked, moving, fullRange, floorColor, trackingRef, preciseSpeedRef }: SceneProps) {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 10, 5]} intensity={1.0} />
      <pointLight position={[0, 6, 0]} intensity={0.6} color="#4444ff" />
      <pointLight position={[0, 3, 0]} intensity={0.3} color="#ffffff" />
      {fullRange ? <Skybox /> : <Room floorColor={floorColor} />}
      <Stars fullRange={fullRange} />
      <TaggedTarget position={targetPos} radius={targetRadius} dwellRef={dwellRef} moving={moving} precise={mode === "precise"} preciseSpeedRef={preciseSpeedRef} />
      <DirectionSensor targetPos={targetPos} arrowRef={arrowRef} />
      {mode === "precise" ? (
        <TrackHandler aimRef={aimRef} trackingRef={trackingRef} dwellRef={dwellRef} />
      ) : mode === "active" ? (
        <ShootHandler onShot={onShot} onHit={onHit} aimRef={aimRef} />
      ) : (
        <DwellHandler onHit={onHit} dwellTime={dwellTime} dwellRef={dwellRef} aimRef={aimRef} />
      )}
      {aimStyle === "fps" ? (
        <FPSControls deltaRef={deltaRef} fullRange={fullRange} sensitivityRef={sensitivityRef} />
      ) : (
        <CursorControls deltaRef={deltaRef} aimRef={aimRef} sensitivityRef={sensitivityRef} crosshairRef={crosshairRef} />
      )}
    </>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

interface StatsDisplayProps {
  kpm: number;
  accuracy: number;
  elapsed: number;
  mode: Mode;
  inputSource: "mouse" | "zmq" | "gamepad";
}

const INPUT_LABEL: Record<string, string> = { mouse: "Mouse", zmq: "ZMQ", gamepad: "Gamepad" };
const INPUT_COLOR: Record<string, string> = { mouse: "#ff6b6b", zmq: "#4ecdc4", gamepad: "#c084fc" };

function StatsDisplay({ kpm, accuracy, elapsed, mode, inputSource }: StatsDisplayProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        left: 20,
        color: "white",
        fontFamily: "monospace",
        fontSize: "18px",
        zIndex: 10,
        pointerEvents: "none",
        textShadow: "0 0 10px rgba(0,0,0,0.8)",
      }}
    >
      <div style={{ fontSize: "24px", marginBottom: 8 }}>{formatTime(elapsed)}</div>
      {mode !== "precise" && <div>KPM: {kpm.toFixed(0)}</div>}
      {mode === "active" && <div>Accuracy: {accuracy.toFixed(1)}%</div>}
      {mode === "precise" && (
        <div>Tracking: {Number.isNaN(accuracy) ? "--" : `${accuracy.toFixed(1)}%`}</div>
      )}
      <div style={{ fontSize: "12px", color: INPUT_COLOR[inputSource], marginTop: 8, fontWeight: "bold" }}>
        {"● "}{INPUT_LABEL[inputSource]}
      </div>
    </div>
  );
}

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

const Crosshair = React.forwardRef<HTMLDivElement, {
  locked: boolean;
  aimStyle: AimStyle;
}>(function Crosshair({ locked, aimStyle }, ref) {
  if (!locked) return null;

  const isCenter = aimStyle === "fps";

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        left: isCenter ? "50%" : "50%",
        top: isCenter ? "50%" : "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      <div style={{ width: 2, height: 20, background: "rgba(0,255,0,0.9)", position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
      <div style={{ width: 20, height: 2, background: "rgba(0,255,0,0.9)", position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
    </div>
  );
});

export default function SehejsWorld() {
  const [targetPos, setTargetPos] = useState<[number, number, number]>(() => randomTargetPos(false));
  const [locked, setLocked] = useState(false);
  const [kpm, setKpm] = useState(0);
  const [accuracy, setAccuracy] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [inputSource, setInputSource] = useState<"mouse" | "zmq" | "gamepad">("mouse");
  const [lastPeakKpm, setLastPeakKpm] = useState<number | null>(null);
  const peakKpm = useRef(0);

  const [mode, setMode] = useState<"dwell" | "active">("dwell");
  const [precise, setPrecise] = useState(false);
  const [aimStyle, setAimStyle] = useState<AimStyle>("fps");
  const [targetRadius, setTargetRadius] = useState(0.35);
  const [preciseRadius, setPreciseRadius] = useState(0.5);
  const [preciseSpeed, setPreciseSpeed] = useState(1.0);
  const preciseSpeedRef = useRef(1.0);
  useEffect(() => { preciseSpeedRef.current = preciseSpeed; }, [preciseSpeed]);
  const [dwellTime, setDwellTime] = useState(1);
  const trackingRef = useRef<{
    bucketOn: number[];
    bucketTotal: number[];
    lastSecIdx: number;
    lockedSeconds: number;
  }>({
    bucketOn: new Array(60).fill(0),
    bucketTotal: new Array(60).fill(0),
    lastSecIdx: 0,
    lockedSeconds: 0,
  });
  const [sensitivity, setSensitivity] = useState(1.0);
  const sensitivityRef = useRef(1.0);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  const [deadzone, setDeadzone] = useState(0);
  const deadzoneRef = useRef(0);
  useEffect(() => { deadzoneRef.current = deadzone; }, [deadzone]);
  const [gamepadStick, setGamepadStick] = useState<"left" | "right">("right");
  const gamepadStickRef = useRef<"left" | "right">("right");
  useEffect(() => { gamepadStickRef.current = gamepadStick; }, [gamepadStick]);
  const [gamepadSlot, setGamepadSlot] = useState(2);
  const gamepadSlotRef = useRef(2);
  useEffect(() => { gamepadSlotRef.current = gamepadSlot; }, [gamepadSlot]);
  const [moving, setMoving] = useState(false);
  const [fullRange, setFullRange] = useState(false);
  const [floorColor, setFloorColor] = useState("#3a3a5a");

  const effectiveMode: Mode = precise ? "precise" : mode;
  const effectiveAimStyle: AimStyle = precise ? "fps" : aimStyle;
  const effectiveFullRange = precise ? false : fullRange;
  const effectiveRadius = precise ? preciseRadius : targetRadius;
  const effectiveMoving = precise ? true : moving;
  const effectiveModeRef = useRef<Mode>(effectiveMode);
  useEffect(() => { effectiveModeRef.current = effectiveMode; }, [effectiveMode]);
  const fullRangeRef = useRef(false);
  useEffect(() => { fullRangeRef.current = effectiveFullRange; }, [effectiveFullRange]);
  const dwellRef = useRef(0);
  const aimRef = useRef<AimPoint>({ x: 0, y: 0 });
  const deltaRef = useRef<AimPoint>({ x: 0, y: 0 });
  const arrowRef = useRef<ArrowInfo>({ visible: false, x: 0, y: 0, angle: 0 });
  const crosshairRef = useRef<HTMLDivElement>(null);

  const totalShots = useRef(0);
  const totalHits = useRef(0);
  const killTimestamps = useRef<number[]>([]);
  const startTime = useRef<number | null>(null);
  const accumulatedTime = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recRafRef = useRef<number>(0);
  const ytPlayerRef = useRef<YT.Player | null>(null);
  const ytReadyRef = useRef(false);
  const hasPlayedFirstSession = useRef(false);

  const zmqService = useRef(VelocityZmqListener.factory());

  useEffect(() => {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    (window as any).onYouTubeIframeAPIReady = () => {
      ytReadyRef.current = true;
    };
    return () => {
      document.head.removeChild(tag);
      delete (window as any).onYouTubeIframeAPIReady;
    };
  }, []);

  useEffect(() => {
    if (inputSource === "zmq") {
      const svc = zmqService.current;
      svc.start();
      const handleZmqData = (data: DecodePacket) => {
        if (!document.pointerLockElement) return;
        deltaRef.current.x += data.final_velocity_x * ZMQ_SCALE;
        deltaRef.current.y += data.final_velocity_y * ZMQ_SCALE;
      };
      svc.events.on(ZmqClient.EVENT_MESSAGE, handleZmqData);
      return () => {
        svc.events.off(ZmqClient.EVENT_MESSAGE, handleZmqData);
        svc.stop();
      };
    } else if (inputSource === "gamepad") {
      const SENSITIVITY = 12;
      let raf: number;
      let lastTime = performance.now();
      const poll = () => {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        const gp = navigator.getGamepads()[gamepadSlotRef.current];
        if (gp) {
          const dz = deadzoneRef.current;
          const axisX = gamepadStickRef.current === "left" ? 0 : 2;
          const axisY = gamepadStickRef.current === "left" ? 1 : 3;
          const rx = Math.abs(gp.axes[axisX]) > dz ? gp.axes[axisX] : 0;
          const ry = Math.abs(gp.axes[axisY]) > dz ? gp.axes[axisY] : 0;
          if (rx !== 0 || ry !== 0) {
            deltaRef.current.x += rx * SENSITIVITY * sensitivityRef.current * dt * 60;
            deltaRef.current.y += ry * SENSITIVITY * sensitivityRef.current * dt * 60;
          }
        }
        raf = requestAnimationFrame(poll);
      };
      raf = requestAnimationFrame(poll);
      return () => cancelAnimationFrame(raf);
    } else {
      const onMouseMove = (e: MouseEvent) => {
        if (!document.pointerLockElement) return;
        deltaRef.current.x += e.movementX;
        deltaRef.current.y += e.movementY;
      };
      document.addEventListener("mousemove", onMouseMove);
      return () => document.removeEventListener("mousemove", onMouseMove);
    }
  }, [inputSource]);

  const playPop = useCallback(() => {
    if (!audioCtx.current) audioCtx.current = new AudioContext();
    const ctx = audioCtx.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  }, []);

  const handleHit = useCallback(() => {
    totalHits.current++;
    killTimestamps.current.push(Date.now());
    playPop();
    setTargetPos(randomTargetPos(fullRangeRef.current));
  }, [playPop]);

  const handleShot = useCallback(() => {
    totalShots.current++;
  }, []);

  useEffect(() => {
    if (locked) {
      if (ytPlayerRef.current) {
        try { ytPlayerRef.current.pauseVideo(); } catch { /* not ready */ }
      }
      startTime.current = Date.now();
      accumulatedTime.current = 0;
      peakKpm.current = 0;
      totalShots.current = 0;
      totalHits.current = 0;
      killTimestamps.current = [];
      trackingRef.current.bucketOn.fill(0);
      trackingRef.current.bucketTotal.fill(0);
      trackingRef.current.lastSecIdx = 0;
      trackingRef.current.lockedSeconds = 0;
      aimRef.current = { x: 0, y: 0 };
      setKpm(0);
      setAccuracy(0);
      setElapsed(0);

      const glCanvas = document.querySelector("canvas");
      if (glCanvas) {
        try {
          const compCanvas = document.createElement("canvas");
          compCanvas.width = glCanvas.width;
          compCanvas.height = glCanvas.height;
          const ctx = compCanvas.getContext("2d")!;

          const compositeFrame = () => {
            compCanvas.width = glCanvas.width;
            compCanvas.height = glCanvas.height;
            const w = compCanvas.width;
            const h = compCanvas.height;
            ctx.drawImage(glCanvas, 0, 0);

            const cx = effectiveAimStyle === "cursor"
              ? ((aimRef.current.x + 1) / 2) * w
              : w / 2;
            const cy = effectiveAimStyle === "cursor"
              ? ((1 - aimRef.current.y) / 2) * h
              : h / 2;
            ctx.strokeStyle = "rgba(0,255,0,0.9)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy - 10);
            ctx.lineTo(cx, cy + 10);
            ctx.moveTo(cx - 10, cy);
            ctx.lineTo(cx + 10, cy);
            ctx.stroke();

            const now = Date.now();
            const running = startTime.current ? (now - startTime.current) / 1000 : 0;
            const secs = Math.floor(accumulatedTime.current + running);
            const mins = Math.floor(secs / 60);
            const rem = secs % 60;
            const recentKills = killTimestamps.current.filter((t) => now - t < 60000).length;
            const shotAcc = totalShots.current > 0
              ? (totalHits.current / totalShots.current) * 100
              : 0;
            const tr = trackingRef.current;
            let trackAccText = "--";
            if (tr.lockedSeconds >= 60) {
              let totalOn = 0;
              let totalTime = 0;
              for (let i = 0; i < 60; i++) {
                totalOn += tr.bucketOn[i];
                totalTime += tr.bucketTotal[i];
              }
              const acc = totalTime > 0 ? (totalOn / totalTime) * 100 : 0;
              trackAccText = `${acc.toFixed(1)}%`;
            }

            ctx.font = "bold 24px monospace";
            ctx.fillStyle = "white";
            ctx.shadowColor = "rgba(0,0,0,0.8)";
            ctx.shadowBlur = 10;
            ctx.textBaseline = "top";
            ctx.fillText(
              `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`,
              20, 20,
            );
            ctx.font = "18px monospace";
            if (effectiveMode !== "precise") {
              ctx.fillText(`KPM: ${recentKills}`, 20, 52);
            }
            if (effectiveMode === "active") {
              ctx.fillText(`Accuracy: ${shotAcc.toFixed(1)}%`, 20, 76);
            } else if (effectiveMode === "precise") {
              ctx.fillText(`Tracking: ${trackAccText}`, 20, 52);
            }
            ctx.shadowBlur = 0;

            recRafRef.current = requestAnimationFrame(compositeFrame);
          };
          recRafRef.current = requestAnimationFrame(compositeFrame);

          const stream = compCanvas.captureStream(30);
          chunksRef.current = [];
          const recorder = new MediaRecorder(stream, {
            mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
              ? "video/webm;codecs=vp9"
              : "video/webm",
          });
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
          };
          recorder.start();
          mediaRecorderRef.current = recorder;
        } catch {
          mediaRecorderRef.current = null;
        }
      }
    } else if (startTime.current !== null) {
      setLastPeakKpm(peakKpm.current);
      startTime.current = null;

      cancelAnimationFrame(recRafRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        const src = inputSource;
        const aim = effectiveAimStyle;
        const range = effectiveFullRange;
        const modeTag = effectiveMode;
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "video/webm" });
          chunksRef.current = [];
          if (blob.size === 0) return;
          const url = URL.createObjectURL(blob);
          const now = new Date();
          const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
          const filename = `sehej-world-${ts}-${modeTag}-${src}-${aim}-${range ? "360" : "front"}.webm`;
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);

          upload(filename, blob, {
            access: "public",
            handleUploadUrl: "/api/share-recording",
            contentType: "video/webm",
            clientPayload: JSON.stringify({
              source: "sehejs-world",
              inputSource: src,
              aimStyle: aim,
              fullRange: range,
              mode: modeTag,
            }),
          }).catch((err) => {
            console.error("Recording upload/email failed:", err);
          });
        };
        recorder.stop();
      }
      mediaRecorderRef.current = null;

      const COUNTRY = [
        "6PLPmmfeNd4", // Waylon Jennings - Are You Sure Hank Done It This Way
        "i85ob2DackI", // Waylon & Willie - Mammas Don't Let Your Babies Grow Up to Be Cowboys
        "r7qovpFAGrQ", // Lil Nas X - Old Town Road
        "1vrEljMfXYo", // Johnny Cash - Ring of Fire
        "Ib_eW6WSs5o", // Merle Haggard - Mama Tried
        "DJ_4bsOmDcg", // Willie Nelson - On the Road Again
        "wRKNwwpsyOg", // Dolly Parton - Jolene
        "nrigbqKUWtk", // Johnny Cash - Folsom Prison Blues
        "6z2t-KfoPjg", // Hank Williams - Your Cheatin Heart
        "NHxS8wlDngI", // George Strait - Check Yes Or No
        "wtVeDaZxAXo", // George Strait - Amarillo By Morning
        "YWKeuYcDAoo", // Patsy Cline - Crazy
        "d05tQrhNMkA", // Brooks & Dunn - Boot Scootin Boogie
        "aIq1LvzSLsk", // Toby Keith - Should've Been A Cowboy
        "FHL3Y27kEgM", // Kenny Rogers & Dolly Parton - Islands In The Stream
        "IUmnTfsY3hI", // John Denver - Take Me Home Country Roads
        "eOB4VdlkzO4", // John Denver - Rocky Mountain High
        "4zAThXFOy2c", // Chris Stapleton - Tennessee Whiskey
        "lA8F9sIhGdg", // Zach Bryan - Something in the Orange
        "aXmmyuIqZyo", // Luke Combs - Fast Car
        "uXyxFMbqKYA", // Luke Combs - When It Rains It Pours
        "t6g2tKgF9HQ", // Luke Combs - Beautiful Crazy
        "mj4efhy6n0o", // Luke Combs - I Ain't No Cowboy
        "2MULzgiH5qE", // Morgan Wallen - Last Night
        "FjBp30kjzTc", // Morgan Wallen - Whiskey Glasses
        "j-lwWgYLb68", // Tyler Childers - Feathered Indians
        "oOIJecsnaWg", // Tyler Childers - Whitehouse Road
        "_9TShlMkQnc", // Tim McGraw - Live Like You Were Dying
        "Bb_qGChk0GI", // Tim McGraw - Humble And Kind
        "KNZH-emehxA", // Shania Twain - You're Still The One
        "DDkCe2cUHAA", // Shania Twain - Man I Feel Like A Woman
        "eiBinM-f-Pk", // Keith Urban - Somebody Like You
        "SoIKv3xxuMA", // Keith Urban - Blue Ain't Your Color
        "zplc4Ienkws", // Reba McEntire - Fancy
        "JW5UEW2kYvc", // Alan Jackson - Chattahoochee
        "QrM39m22jH4", // Dierks Bentley - Drunk On A Plane
        "Lb9q1ScC4cg", // Jason Aldean - Dirt Road Anthem
        "l2gGXlW6wSY", // Eric Church - Springsteen
        "usGv0gB2zEU", // Eric Church - Drink In My Hand
        "lHdXQAQHjd8", // Alabama - Song Of The South
        "M6WfM0cXWSQ", // Alabama - Mountain Music
        "7hx4gdlfamo", // Kenny Rogers - The Gambler
        "AM-b8P1yj9w", // Tammy Wynette - Stand By Your Man
        "lydBPm2KRaU", // Carrie Underwood - Jesus Take The Wheel
        "WaSy8yy-mr8", // Carrie Underwood - Before He Cheats
        "X6nxHNrIwJA", // Brad Paisley - Mud On The Tires
        "pojL_35QlSI", // The Chicks - Not Ready To Make Nice
        "dom7VlltBUc", // The Chicks - Wide Open Spaces
        "KtKXc_v2iLE", // Randy Travis - Forever and Ever Amen
        "kQ8xqyoZXCc", // Kacey Musgraves - Follow Your Arrow
        "GZfj2Ir3GgQ", // Kacey Musgraves - Merry Go Round
        "v2LixP7n_hM", // Cody Johnson - Til You Can't
        "YsMB0i5YTOc", // HARDY - Wait in the Truck
        "NpDYfkymaSE", // Sturgill Simpson - In Bloom
        "6gBV-Nzq7Pg", // Sturgill Simpson - Turtles All The Way Down
        "OxB1t2EEK0M", // Hank Williams - Hey Good Lookin
        "EyWTL3QfXMQ", // Garth Brooks - Friends in Low Places
        "lhyijN4ftko", // Garth Brooks - The Dance
        "xZjosn2u1gA", // Blake Shelton - Honey Bee
        "npEGrqZFmb8", // Blake Shelton - God Gave Me You
        "aWQdEDtveB0", // Miranda Lambert - Gunpowder & Lead
        "DQYNM6SjD_o", // Miranda Lambert - The House That Built Me
        "QWIcz3ab358", // Zach Bryan - Revival
        "FvW6_-TP5cs", // Hank Williams - I'm So Lonesome I Could Cry
        "hvKyBcCDOB4", // Darius Rucker - Wagon Wheel
        "byQIPdHMpjc", // Billy Ray Cyrus - Achy Breaky Heart
        "CNIEFbPa3ig", // Zach Bryan - Heading South
      ];
      if (hasPlayedFirstSession.current && ytReadyRef.current) {
        const pick = COUNTRY[Math.floor(Math.random() * COUNTRY.length)];
        const div = document.getElementById("yt-player");
        if (div && !ytPlayerRef.current) {
          ytPlayerRef.current = new YT.Player("yt-player", {
            height: "1",
            width: "1",
            videoId: pick,
            playerVars: { autoplay: 1, loop: 1, playlist: COUNTRY.join(",") },
          });
        } else if (ytPlayerRef.current) {
          try {
            ytPlayerRef.current.loadVideoById(pick);
            ytPlayerRef.current.playVideo();
          } catch { /* not ready */ }
        }
      }
      hasPlayedFirstSession.current = true;
    }
  }, [locked]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      killTimestamps.current = killTimestamps.current.filter((t) => now - t < 60000);
      const currentKpm = killTimestamps.current.length;
      if (currentKpm > peakKpm.current) peakKpm.current = currentKpm;
      setKpm(currentKpm);
      if (effectiveModeRef.current === "precise") {
        const tr = trackingRef.current;
        if (tr.lockedSeconds < 60) {
          setAccuracy(NaN);
        } else {
          let totalOn = 0;
          let totalTime = 0;
          for (let i = 0; i < 60; i++) {
            totalOn += tr.bucketOn[i];
            totalTime += tr.bucketTotal[i];
          }
          setAccuracy(totalTime > 0 ? (totalOn / totalTime) * 100 : 0);
        }
      } else {
        setAccuracy(
          totalShots.current > 0
            ? (totalHits.current / totalShots.current) * 100
            : 0,
        );
      }
      const running = startTime.current ? (now - startTime.current) / 1000 : 0;
      setElapsed(Math.floor(accumulatedTime.current + running));
    }, 100);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const onLockChange = () => {
      setLocked(!!document.pointerLockElement);
    };
    const onExitClick = (e: MouseEvent) => {
      if ((e.button === 1 || e.button === 2) && document.pointerLockElement) {
        document.exitPointerLock();
      }
    };
    document.addEventListener("pointerlockchange", onLockChange);
    const onContextMenu = (e: Event) => e.preventDefault();
    document.addEventListener("mousedown", onExitClick);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousedown", onExitClick);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  const requestLock = useCallback(() => {
    const canvas = document.querySelector("canvas");
    canvas?.requestPointerLock();
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative", overflow: "hidden" }}>
      <div id="yt-player" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
      <StatsDisplay kpm={kpm} accuracy={accuracy} elapsed={elapsed} mode={effectiveMode} inputSource={inputSource} />

      <Crosshair ref={crosshairRef} locked={locked} aimStyle={effectiveAimStyle} />
      {effectiveFullRange && <DirectionArrow locked={locked} arrowRef={arrowRef} />}

      {!locked && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 20,
            background: "rgba(0,0,0,0.7)",
            cursor: "pointer",
          }}
          onClick={requestLock}
        >
          <h1 style={{ color: "white", fontFamily: "monospace", fontSize: "48px", marginBottom: "10px" }}>
            Sehej&apos;s World
          </h1>
          {lastPeakKpm !== null && (
            <div style={{ color: "#ff2266", fontFamily: "monospace", fontSize: "28px", marginBottom: "12px" }}>
              Peak KPM: {lastPeakKpm}
            </div>
          )}
          <p style={{ color: "#aaa", fontFamily: "monospace", fontSize: "20px", marginBottom: "40px" }}>
            Click to start &middot; Escape to pause
          </p>

          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 12,
              padding: "24px 32px",
              minWidth: 280,
              maxHeight: "60vh",
              overflowY: "auto",
              cursor: "default",
            }}
          >
            <div style={{ color: "white", fontFamily: "monospace", fontSize: "16px", marginBottom: 20, textAlign: "center" }}>
              Settings
            </div>

            {/* Game style toggle (Standard vs Precise) */}
            <div style={{ marginBottom: 20 }}>
              <div style={LABEL}>Game Style</div>
              <div style={{ display: "flex", gap: 8 }}>
                {([
                  { id: "standard", label: "Standard" },
                  { id: "precise", label: "Precise" },
                ] as const).map((g) => {
                  const selected = (g.id === "precise") === precise;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setPrecise(g.id === "precise")}
                      style={{
                        flex: 1,
                        padding: "8px 0",
                        fontFamily: "monospace",
                        fontSize: "14px",
                        border: "1px solid",
                        borderColor: selected ? "#ff2266" : "rgba(255,255,255,0.2)",
                        borderRadius: 6,
                        background: selected ? "rgba(255,34,102,0.2)" : "transparent",
                        color: selected ? "#ff2266" : "#888",
                        cursor: "pointer",
                      }}
                    >
                      {g.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ color: "#666", fontFamily: "monospace", fontSize: "12px", marginTop: 6 }}>
                {precise
                  ? "Track the drifting target — accuracy = % time on target"
                  : "Standard shoot / dwell practice"}
              </div>
            </div>

            {/* Precise-mode controls */}
            {precise && (
              <>
                <div style={{ marginBottom: 20 }}>
                  <div style={LABEL}>Target Size: {preciseRadius.toFixed(2)}</div>
                  <input
                    type="range"
                    min={0.15}
                    max={1.5}
                    step={0.05}
                    value={preciseRadius}
                    onChange={(e) => setPreciseRadius(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#555", fontFamily: "monospace", fontSize: "11px" }}>
                    <span>Small</span>
                    <span>Large</span>
                  </div>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <div style={LABEL}>Target Speed: {preciseSpeed.toFixed(2)}×</div>
                  <input
                    type="range"
                    min={0.25}
                    max={2.5}
                    step={0.05}
                    value={preciseSpeed}
                    onChange={(e) => setPreciseSpeed(parseFloat(e.target.value))}
                    style={SLIDER}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#555", fontFamily: "monospace", fontSize: "11px" }}>
                    <span>Slow</span>
                    <span>Fast</span>
                  </div>
                </div>
              </>
            )}

            {/* Input source toggle */}
            <div style={{ marginBottom: 20 }}>
              <div style={LABEL}>Input</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["mouse", "zmq", "gamepad"] as const).map((src) => (
                  <button
                    key={src}
                    onClick={() => setInputSource(src)}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontFamily: "monospace",
                      fontSize: "14px",
                      border: "1px solid",
                      borderColor: inputSource === src ? "#ff2266" : "rgba(255,255,255,0.2)",
                      borderRadius: 6,
                      background: inputSource === src ? "rgba(255,34,102,0.2)" : "transparent",
                      color: inputSource === src ? "#ff2266" : "#888",
                      cursor: "pointer",
                      textTransform: "uppercase",
                    }}
                  >
                    {src}
                  </button>
                ))}
              </div>
            </div>

            {/* Gamepad settings */}
            {inputSource === "gamepad" && (
              <>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ ...LABEL, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
                        fontSize: "13px",
                        padding: "2px 6px",
                        textAlign: "right",
                      }}
                    />
                  </div>
                  <a
                    href="https://hardwaretester.com/gamepad"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-block",
                      marginTop: 4,
                      fontSize: "11px",
                      color: "rgba(255,255,255,0.5)",
                      textDecoration: "none",
                      fontFamily: "monospace",
                    }}
                  >
                    Test gamepad ↗
                  </a>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <div style={LABEL}>Joystick</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["left", "right"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setGamepadStick(s)}
                        style={{
                          flex: 1,
                          padding: "8px 0",
                          fontFamily: "monospace",
                          fontSize: "14px",
                          border: "1px solid",
                          borderColor: gamepadStick === s ? "#ff2266" : "rgba(255,255,255,0.2)",
                          borderRadius: 6,
                          background: gamepadStick === s ? "rgba(255,34,102,0.2)" : "transparent",
                          color: gamepadStick === s ? "#ff2266" : "#888",
                          cursor: "pointer",
                          textTransform: "capitalize",
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Sensitivity slider */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ ...LABEL, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Sensitivity</span>
                <input
                  type="number"
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={sensitivity}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) setSensitivity(Math.min(5, Math.max(0.1, v)));
                  }}
                  style={{
                    width: 60,
                    background: "rgba(255,255,255,0.1)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 4,
                    color: "#fff",
                    fontFamily: "monospace",
                    fontSize: "13px",
                    padding: "2px 6px",
                    textAlign: "right",
                  }}
                />
              </div>
              <input
                type="range"
                min={0.1}
                max={5}
                step={0.1}
                value={sensitivity}
                onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                style={SLIDER}
              />
              <div style={{ display: "flex", justifyContent: "space-between", color: "#555", fontFamily: "monospace", fontSize: "11px" }}>
                <span>Slow</span>
                <span>Fast</span>
              </div>
            </div>

            {/* Deadzone slider */}
            <div style={{ marginBottom: 20 }}>
                <div style={{ ...LABEL, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>Deadzone</span>
                  <input
                    type="number"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={deadzone}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) setDeadzone(Math.min(0.5, Math.max(0, v)));
                    }}
                    style={{
                      width: 60,
                      background: "rgba(255,255,255,0.1)",
                      border: "1px solid rgba(255,255,255,0.2)",
                      borderRadius: 4,
                      color: "#fff",
                      fontFamily: "monospace",
                      fontSize: "13px",
                      padding: "2px 6px",
                      textAlign: "right",
                    }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={deadzone}
                  onChange={(e) => setDeadzone(parseFloat(e.target.value))}
                  style={SLIDER}
                />
                <div style={{ display: "flex", justifyContent: "space-between", color: "#555", fontFamily: "monospace", fontSize: "11px" }}>
                  <span>None</span>
                  <span>0.5</span>
                </div>
              </div>

            {!precise && (
            <>
            {/* Aim style toggle */}
            <div style={{ marginBottom: 20 }}>
              <div style={LABEL}>Aim Style</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["fps", "cursor"] as AimStyle[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setAimStyle(s)}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontFamily: "monospace",
                      fontSize: "14px",
                      border: "1px solid",
                      borderColor: aimStyle === s ? "#ff2266" : "rgba(255,255,255,0.2)",
                      borderRadius: 6,
                      background: aimStyle === s ? "rgba(255,34,102,0.2)" : "transparent",
                      color: aimStyle === s ? "#ff2266" : "#888",
                      cursor: "pointer",
                      textTransform: "uppercase",
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div style={{ color: "#666", fontFamily: "monospace", fontSize: "12px", marginTop: 6 }}>
                {aimStyle === "fps" ? "Camera rotates, crosshair fixed at center" : "Camera fixed, crosshair moves freely"}
              </div>
            </div>

            {/* Mode toggle */}
            <div style={{ marginBottom: 20 }}>
              <div style={LABEL}>Mode</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["dwell", "active"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontFamily: "monospace",
                      fontSize: "14px",
                      border: "1px solid",
                      borderColor: mode === m ? "#ff2266" : "rgba(255,255,255,0.2)",
                      borderRadius: 6,
                      background: mode === m ? "rgba(255,34,102,0.2)" : "transparent",
                      color: mode === m ? "#ff2266" : "#888",
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <div style={{ color: "#666", fontFamily: "monospace", fontSize: "12px", marginTop: 6 }}>
                {mode === "dwell" ? "Hover crosshair over target to kill" : "Click to shoot targets"}
              </div>
            </div>

            {/* Dwell time slider */}
            {mode === "dwell" && (
              <div style={{ marginBottom: 20 }}>
                <div style={LABEL}>Dwell Time: {dwellTime.toFixed(2)}s</div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={dwellTime}
                  onChange={(e) => setDwellTime(parseFloat(e.target.value))}
                  style={SLIDER}
                />
                <div style={{ display: "flex", justifyContent: "space-between", color: "#555", fontFamily: "monospace", fontSize: "11px" }}>
                  <span>Instant</span>
                  <span>2s</span>
                </div>
              </div>
            )}

            {/* Target size slider */}
            <div style={{ marginBottom: 20 }}>
              <div style={LABEL}>Target Size: {targetRadius.toFixed(2)}</div>
              <input
                type="range"
                min={0.15}
                max={1.5}
                step={0.05}
                value={targetRadius}
                onChange={(e) => setTargetRadius(parseFloat(e.target.value))}
                style={SLIDER}
              />
              <div style={{ display: "flex", justifyContent: "space-between", color: "#555", fontFamily: "monospace", fontSize: "11px" }}>
                <span>Small</span>
                <span>Large</span>
              </div>
            </div>

            {/* 360 targets toggle */}
            <div style={{ marginBottom: 20 }}>
              <div style={LABEL}>360° Targets</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["off", "on"] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setFullRange(opt === "on")}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontFamily: "monospace",
                      fontSize: "14px",
                      border: "1px solid",
                      borderColor: (opt === "on") === fullRange ? "#ff2266" : "rgba(255,255,255,0.2)",
                      borderRadius: 6,
                      background: (opt === "on") === fullRange ? "rgba(255,34,102,0.2)" : "transparent",
                      color: (opt === "on") === fullRange ? "#ff2266" : "#888",
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
              <div style={{ color: "#666", fontFamily: "monospace", fontSize: "12px", marginTop: 6 }}>
                {fullRange ? "Targets spawn all around you" : "Targets spawn in front of you"}
              </div>
            </div>

            {/* Moving targets toggle */}
            <div>
              <div style={LABEL}>Moving Targets</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["off", "on"] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setMoving(opt === "on")}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontFamily: "monospace",
                      fontSize: "14px",
                      border: "1px solid",
                      borderColor: (opt === "on") === moving ? "#ff2266" : "rgba(255,255,255,0.2)",
                      borderRadius: 6,
                      background: (opt === "on") === moving ? "rgba(255,34,102,0.2)" : "transparent",
                      color: (opt === "on") === moving ? "#ff2266" : "#888",
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
              <div style={{ color: "#666", fontFamily: "monospace", fontSize: "12px", marginTop: 6 }}>
                {moving ? "Targets bob up and down" : "Targets stay still"}
              </div>
            </div>
            </>
            )}

            {/* Floor color */}
            <div>
              <div style={LABEL}>Floor Color</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {([
                  { label: "Purple", color: "#3a3a5a" },
                  { label: "Slate", color: "#555588" },
                  { label: "Light", color: "#cccccc" },
                ] as const).map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => setFloorColor(preset.color)}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontFamily: "monospace",
                      fontSize: "14px",
                      border: "1px solid",
                      borderColor: floorColor === preset.color ? "#ff2266" : "rgba(255,255,255,0.2)",
                      borderRadius: 6,
                      background: floorColor === preset.color ? "rgba(255,34,102,0.2)" : "transparent",
                      color: floorColor === preset.color ? "#ff2266" : "#888",
                      cursor: "pointer",
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
                <input
                  type="color"
                  value={floorColor}
                  onChange={(e) => setFloorColor(e.target.value)}
                  style={{ width: 36, height: 36, border: "none", borderRadius: 6, cursor: "pointer", background: "transparent" }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <Canvas
        camera={{ fov: 90, near: 0.1, far: 100, position: effectiveFullRange ? CAM_POS_CENTER : CAM_POS_EDGE }}
        style={{ width: "100%", height: "100%" }}
      >
        <Scene
          targetPos={targetPos}
          targetRadius={effectiveRadius}
          mode={effectiveMode}
          aimStyle={effectiveAimStyle}
          dwellTime={dwellTime}
          dwellRef={dwellRef}
          aimRef={aimRef}
          deltaRef={deltaRef}
          arrowRef={arrowRef}
          sensitivityRef={sensitivityRef}
          crosshairRef={crosshairRef}
          onHit={handleHit}
          onShot={handleShot}
          locked={locked}
          moving={effectiveMoving}
          fullRange={effectiveFullRange}
          floorColor={floorColor}
          trackingRef={trackingRef}
          preciseSpeedRef={preciseSpeedRef}
        />
      </Canvas>
    </div>
  );
}
