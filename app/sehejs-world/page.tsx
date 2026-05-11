"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import VelocityZmqListener, { DecodePacket } from "../ZmqListener";
import ZmqClient from "../ZmqClient";

const ROOM_SIZE = 24;
const HALF = ROOM_SIZE / 2;

const CAM_POS: [number, number, number] = [0, 2, HALF - 0.5];
const INITIAL_YAW = 0;
const YAW_LIMIT = Math.PI / 3;
const PITCH_LIMIT = Math.PI / 4;

const TARGET_DEPTH = -4;
const TARGET_X_SPREAD = 16;
const TARGET_Y_MIN = 0.5;
const TARGET_Y_MAX = 7;

const ZMQ_SCALE = 0.015;

type AimPoint = { x: number; y: number };

function randomTargetPos(): [number, number, number] {
  const x = (Math.random() - 0.5) * TARGET_X_SPREAD;
  const y = TARGET_Y_MIN + Math.random() * (TARGET_Y_MAX - TARGET_Y_MIN);
  return [x, y, TARGET_DEPTH];
}

function Room() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[ROOM_SIZE, ROOM_SIZE]} />
        <meshStandardMaterial color="#1a1a30" />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 8, 0]}>
        <planeGeometry args={[ROOM_SIZE, ROOM_SIZE]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 4, -ROOM_SIZE / 2]}>
        <planeGeometry args={[ROOM_SIZE, 8]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 4, ROOM_SIZE / 2]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[ROOM_SIZE, 8]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-ROOM_SIZE / 2, 4, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[ROOM_SIZE, 8]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[ROOM_SIZE / 2, 4, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[ROOM_SIZE, 8]} />
        <meshStandardMaterial color="#1a1a2e" side={THREE.DoubleSide} />
      </mesh>
      <gridHelper args={[ROOM_SIZE, 20, "#444488", "#2a2a50"]} />
    </group>
  );
}

function FPSControls({ deltaRef }: { deltaRef: React.MutableRefObject<AimPoint> }) {
  const { camera } = useThree();
  const euler = useRef(new THREE.Euler(0, INITIAL_YAW, 0, "YXZ"));
  const initialized = useRef(false);

  useFrame(() => {
    if (!initialized.current) {
      euler.current.set(0, INITIAL_YAW, 0, "YXZ");
      camera.quaternion.setFromEuler(euler.current);
      initialized.current = true;
    }

    const dx = deltaRef.current.x;
    const dy = deltaRef.current.y;
    if (dx === 0 && dy === 0) return;

    const sensitivity = 0.002;
    euler.current.y -= dx * sensitivity;
    euler.current.x -= dy * sensitivity;
    euler.current.y = Math.max(INITIAL_YAW - YAW_LIMIT, Math.min(INITIAL_YAW + YAW_LIMIT, euler.current.y));
    euler.current.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, euler.current.x));
    camera.quaternion.setFromEuler(euler.current);

    deltaRef.current.x = 0;
    deltaRef.current.y = 0;
  });

  return null;
}

function CursorControls({ deltaRef, aimRef }: { deltaRef: React.MutableRefObject<AimPoint>; aimRef: React.MutableRefObject<AimPoint> }) {
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

    const sensitivity = 0.0015;
    aimRef.current.x += dx * sensitivity;
    aimRef.current.y -= dy * sensitivity;
    aimRef.current.x = Math.max(-1, Math.min(1, aimRef.current.x));
    aimRef.current.y = Math.max(-1, Math.min(1, aimRef.current.y));

    deltaRef.current.x = 0;
    deltaRef.current.y = 0;
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

const COLOR_IDLE = new THREE.Color("#ff2266");
const COLOR_HOVER = new THREE.Color("#44ff88");
const EMISSIVE_IDLE = new THREE.Color("#ff0044");
const EMISSIVE_HOVER = new THREE.Color("#22cc66");

function TaggedTarget({ position, radius, dwellRef, moving }: {
  position: [number, number, number];
  radius: number;
  dwellRef: React.MutableRefObject<number>;
  moving: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  useEffect(() => {
    if (meshRef.current) {
      (meshRef.current as any).__isTarget = true;
    }
  }, []);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      meshRef.current.position.y = moving
        ? position[1] + Math.sin(clock.elapsedTime * 2) * 0.3
        : position[1];
    }
    if (matRef.current) {
      const t = dwellRef.current;
      matRef.current.color.copy(COLOR_IDLE).lerp(COLOR_HOVER, t);
      matRef.current.emissive.copy(EMISSIVE_IDLE).lerp(EMISSIVE_HOVER, t);
      matRef.current.emissiveIntensity = 0.8 + t * 0.6;
    }
  });

  return (
    <mesh ref={meshRef} position={position}>
      <sphereGeometry args={[radius, 32, 32]} />
      <meshStandardMaterial ref={matRef} color="#ff2266" emissive="#ff0044" emissiveIntensity={0.8} />
    </mesh>
  );
}

type Mode = "dwell" | "active";
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
  onHit: () => void;
  onShot: () => void;
  locked: boolean;
  moving: boolean;
}

function Scene({ targetPos, targetRadius, mode, aimStyle, dwellTime, dwellRef, aimRef, deltaRef, onHit, onShot, locked, moving }: SceneProps) {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 10, 5]} intensity={1.0} />
      <pointLight position={[0, 6, 0]} intensity={0.6} color="#4444ff" />
      <pointLight position={[0, 3, 0]} intensity={0.3} color="#ffffff" />
      <Room />
      <TaggedTarget position={targetPos} radius={targetRadius} dwellRef={dwellRef} moving={moving} />
      {mode === "active" ? (
        <ShootHandler onShot={onShot} onHit={onHit} aimRef={aimRef} />
      ) : (
        <DwellHandler onHit={onHit} dwellTime={dwellTime} dwellRef={dwellRef} aimRef={aimRef} />
      )}
      {aimStyle === "fps" ? (
        <FPSControls deltaRef={deltaRef} />
      ) : (
        <CursorControls deltaRef={deltaRef} aimRef={aimRef} />
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
  zmqConnected: boolean;
}

function StatsDisplay({ kpm, accuracy, elapsed, mode, zmqConnected }: StatsDisplayProps) {
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
      <div>KPM: {kpm.toFixed(0)}</div>
      {mode === "active" && <div>Accuracy: {accuracy.toFixed(1)}%</div>}
      <div style={{ fontSize: "12px", color: zmqConnected ? "#4ecdc4" : "#ff6b6b", marginTop: 8, fontWeight: "bold" }}>
        {"● "}{zmqConnected ? "ZMQ Connected" : "Mouse Mode"}
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

function Crosshair({ locked, aimStyle, aimRef }: {
  locked: boolean;
  aimStyle: AimStyle;
  aimRef: React.MutableRefObject<AimPoint>;
}) {
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (aimStyle !== "cursor" || !locked) return;
    let raf: number;
    const update = () => {
      if (dotRef.current) {
        const px = (aimRef.current.x + 1) / 2 * 100;
        const py = (1 - aimRef.current.y) / 2 * 100;
        dotRef.current.style.left = `${px}%`;
        dotRef.current.style.top = `${py}%`;
      }
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [aimStyle, locked, aimRef]);

  if (!locked) return null;

  const isCenter = aimStyle === "fps";

  return (
    <div
      ref={dotRef}
      style={{
        position: "absolute",
        left: isCenter ? "50%" : undefined,
        top: isCenter ? "50%" : undefined,
        transform: "translate(-50%, -50%)",
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      <div style={{ width: 2, height: 20, background: "rgba(255,255,255,0.8)", position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
      <div style={{ width: 20, height: 2, background: "rgba(255,255,255,0.8)", position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }} />
    </div>
  );
}

export default function SehejsWorld() {
  const [targetPos, setTargetPos] = useState<[number, number, number]>(() => randomTargetPos());
  const [locked, setLocked] = useState(false);
  const [kpm, setKpm] = useState(0);
  const [accuracy, setAccuracy] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [isZmqConnected, setIsZmqConnected] = useState(false);
  const [lastPeakKpm, setLastPeakKpm] = useState<number | null>(null);
  const peakKpm = useRef(0);

  const [mode, setMode] = useState<Mode>("dwell");
  const [aimStyle, setAimStyle] = useState<AimStyle>("fps");
  const [targetRadius, setTargetRadius] = useState(0.5);
  const [dwellTime, setDwellTime] = useState(0.5);
  const [moving, setMoving] = useState(false);
  const dwellRef = useRef(0);
  const aimRef = useRef<AimPoint>({ x: 0, y: 0 });
  const deltaRef = useRef<AimPoint>({ x: 0, y: 0 });

  const totalShots = useRef(0);
  const totalHits = useRef(0);
  const killTimestamps = useRef<number[]>([]);
  const startTime = useRef<number | null>(null);
  const accumulatedTime = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);

  const zmqService = useRef(VelocityZmqListener.factory());
  const zmqTimeoutRef = useRef<NodeJS.Timeout>();
  const zmqConnectedRef = useRef(false);

  // Start ZMQ listener
  useEffect(() => {
    zmqService.current.start();
    return () => {
      zmqService.current.stop();
      if (zmqTimeoutRef.current) clearTimeout(zmqTimeoutRef.current);
    };
  }, []);

  // Handle ZMQ velocity data
  useEffect(() => {
    function handleZmqData(data: DecodePacket) {
      if (!document.pointerLockElement) return;

      setIsZmqConnected(true);
      zmqConnectedRef.current = true;

      if (zmqTimeoutRef.current) clearTimeout(zmqTimeoutRef.current);
      zmqTimeoutRef.current = setTimeout(() => {
        setIsZmqConnected(false);
        zmqConnectedRef.current = false;
      }, 3000);

      deltaRef.current.x += data.final_velocity_x * ZMQ_SCALE;
      deltaRef.current.y += data.final_velocity_y * ZMQ_SCALE;
    }

    zmqService.current.events.on(ZmqClient.EVENT_MESSAGE, handleZmqData);
    return () => {
      zmqService.current.events.off(ZmqClient.EVENT_MESSAGE, handleZmqData);
    };
  }, []);

  // Mouse fallback — only when ZMQ is not connected
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!document.pointerLockElement) return;
      if (zmqConnectedRef.current) return;
      deltaRef.current.x += e.movementX;
      deltaRef.current.y += e.movementY;
    };

    document.addEventListener("mousemove", onMouseMove);
    return () => document.removeEventListener("mousemove", onMouseMove);
  }, []);

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
    setTargetPos(randomTargetPos());
  }, [playPop]);

  const handleShot = useCallback(() => {
    totalShots.current++;
  }, []);

  useEffect(() => {
    if (locked) {
      startTime.current = Date.now();
      accumulatedTime.current = 0;
      peakKpm.current = 0;
      totalShots.current = 0;
      totalHits.current = 0;
      killTimestamps.current = [];
      aimRef.current = { x: 0, y: 0 };
      setKpm(0);
      setAccuracy(0);
      setElapsed(0);
    } else if (startTime.current !== null) {
      setLastPeakKpm(peakKpm.current);
      startTime.current = null;
    }
  }, [locked]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      killTimestamps.current = killTimestamps.current.filter((t) => now - t < 60000);
      const currentKpm = killTimestamps.current.length;
      if (currentKpm > peakKpm.current) peakKpm.current = currentKpm;
      setKpm(currentKpm);
      setAccuracy(
        totalShots.current > 0
          ? (totalHits.current / totalShots.current) * 100
          : 0,
      );
      const running = startTime.current ? (now - startTime.current) / 1000 : 0;
      setElapsed(Math.floor(accumulatedTime.current + running));
    }, 100);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const onLockChange = () => {
      setLocked(!!document.pointerLockElement);
    };
    const onMiddleClick = (e: MouseEvent) => {
      if (e.button === 1 && document.pointerLockElement) {
        document.exitPointerLock();
      }
    };
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousedown", onMiddleClick);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousedown", onMiddleClick);
    };
  }, []);

  const requestLock = useCallback(() => {
    const canvas = document.querySelector("canvas");
    canvas?.requestPointerLock();
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative", overflow: "hidden" }}>
      <StatsDisplay kpm={kpm} accuracy={accuracy} elapsed={elapsed} mode={mode} zmqConnected={isZmqConnected} />

      <Crosshair locked={locked} aimStyle={aimStyle} aimRef={aimRef} />

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
                {(["dwell", "active"] as Mode[]).map((m) => (
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
          </div>
        </div>
      )}

      <Canvas
        camera={{ fov: 90, near: 0.1, far: 100, position: CAM_POS }}
        style={{ width: "100%", height: "100%" }}
      >
        <Scene
          targetPos={targetPos}
          targetRadius={targetRadius}
          mode={mode}
          aimStyle={aimStyle}
          dwellTime={dwellTime}
          dwellRef={dwellRef}
          aimRef={aimRef}
          deltaRef={deltaRef}
          onHit={handleHit}
          onShot={handleShot}
          locked={locked}
          moving={moving}
        />
      </Canvas>
    </div>
  );
}
