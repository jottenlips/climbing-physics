import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Sky, Line, Text, Html } from "@react-three/drei";
import * as THREE from "three";
import {
  PlacedHold,
  HoldType,
  HoldDirection,
  HOLD_INFO,
  makeHoldId,
  holdToPullHand,
  holdToPullFoot,
} from "../holds/holdTypes";
import {
  ClimberConfig,
  PullDirection,
  computeForces,
} from "../physics/climbingPhysics";
import { WallSegment, segmentToWorld } from "../App";

type Limb = "leftHand" | "rightHand" | "leftFoot" | "rightFoot";
type GamePhase = "auto" | "crux" | "protection" | "idle" | "following";
type V3 = [number, number, number];

function v3add(a: V3, b: V3): V3 { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function v3sub(a: V3, b: V3): V3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function v3scale(a: V3, s: number): V3 { return [a[0]*s, a[1]*s, a[2]*s]; }
function v3len(a: V3): number { return Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]); }
function v3normalize(a: V3): V3 { const l = v3len(a)||1; return [a[0]/l, a[1]/l, a[2]/l]; }
function v3cross(a: V3, b: V3): V3 { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function v3dot(a: V3, b: V3): number { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

function clampToReach(origin: V3, target: V3, maxReach: number): V3 {
  const toTarget = v3sub(target, origin);
  const dist = v3len(toTarget);
  if (dist <= maxReach) return target;
  return v3add(origin, v3scale(v3normalize(toTarget), maxReach));
}

function solveIK2Bone(origin: V3, target: V3, lenUpper: number, lenLower: number, bendDir: V3): V3 {
  const toTarget = v3sub(target, origin);
  const dist = v3len(toTarget);
  const totalLen = lenUpper + lenLower;
  if (dist >= totalLen * 0.999) return v3add(origin, v3scale(v3normalize(toTarget), lenUpper));
  if (dist < Math.abs(lenUpper - lenLower) + 0.001) return v3add(origin, v3scale(v3normalize(bendDir), lenUpper * 0.5));
  const cosAngle = (lenUpper*lenUpper + dist*dist - lenLower*lenLower) / (2*lenUpper*dist);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  const forward = v3normalize(toTarget);
  const bendAlongFwd = v3dot(bendDir, forward);
  let up = v3sub(bendDir, v3scale(forward, bendAlongFwd));
  if (v3len(up) < 0.001) { up = v3cross(forward, [1,0,0]); if (v3len(up) < 0.001) up = v3cross(forward, [0,1,0]); }
  up = v3normalize(up);
  const jointDir = v3add(v3scale(forward, Math.cos(angle)), v3scale(up, Math.sin(angle)));
  return v3add(origin, v3scale(jointDir, lenUpper));
}

function MPJoint({ position, size = 0.025, color = "#ddccbb" }: { position: V3; size?: number; color?: string }) {
  return <mesh position={position}><sphereGeometry args={[size, 10, 10]} /><meshStandardMaterial color={color} roughness={0.6} /></mesh>;
}

function MPLimb({ from, to, color = "#cc9977", width = 2 }: { from: V3; to: V3; color?: string; width?: number }) {
  return <Line points={[from, to]} color={color} lineWidth={width} />;
}

interface CruxSequence {
  startY: number;
  endY: number;
  holds: PlacedHold[];
  solved: boolean;
}

interface PitchData {
  pitchNumber: number;
  heightMeters: number;
  segments: WallSegment[];
  holds: PlacedHold[];
  cruxes: CruxSequence[];
  completed: boolean;
}

// ---------- seeded RNG ----------
function seededRng(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

const HOLD_DIFFICULTY: Record<string, number> = {
  jug: 2, crimp: 8, sloper: 7, pinch: 8, pocket: 6,
  volume: 2, "foot-chip": 0, "foot-edge": 0, "smear-pad": 0,
};



// ---------- pitch generation ----------
function generatePitch(pitchNumber: number, baseY: number): PitchData {
  const rand = seededRng(pitchNumber * 7919 + 42);
  const heightMeters = 30 + rand() * 10;
  const baseAngle = -5 + rand() * 25;
  const numSeg = 1 + Math.floor(rand() * 3);
  const segments: WallSegment[] = [];
  let rem = heightMeters;
  for (let i = 0; i < numSeg; i++) {
    const h = i === numSeg - 1 ? rem : rem * (0.25 + rand() * 0.45);
    rem -= h;
    segments.push({ height: h, angleDeg: Math.round(baseAngle + (rand() - 0.5) * 18) });
  }

  const holds: PlacedHold[] = [];
  const cruxes: CruxSequence[] = [];

  // Generate holds in sections: jug ladder (easy) then crux (hard)
  const numCruxes = 1 + Math.floor(rand() * 2 + pitchNumber * 0.3);
  // Crux sections are short and intense — only 2-3m tall
  const cruxHeight = 2 + rand() * 1.5;
  const totalCruxHeight = numCruxes * cruxHeight;
  const easyHeight = (heightMeters - totalCruxHeight) / (numCruxes + 1);
  const sectionHeight = 0; // unused, computed per-section below

  let currentY = baseY;
  void sectionHeight; // computed per-section
  for (let section = 0; section < numCruxes * 2 + 1; section++) {
    const isCrux = section % 2 === 1;
    const secHeight = isCrux ? cruxHeight : easyHeight;
    const sectionEnd = currentY + secHeight;

    if (isCrux) {
      // Crux: multiple paths — easier on left, harder on right
      const cruxHolds: PlacedHold[] = [];
      const cruxDifficulty = Math.min(3, Math.floor(pitchNumber * 0.4 + rand() * 1.5));
      const dirs: HoldDirection[] = ["up", "left", "right", "up-left", "up-right"];

      const maxStep = 0.6;
      const numMoves = Math.max(3, Math.ceil(secHeight / maxStep));
      const stepH = secHeight / numMoves;

      // === LEFT PATH (easier) — jugs mixed with easier crimps, more holds ===
      // Centered around x=-0.8, spread -1.2 to -0.4
      const easyTypes: HoldType[] = ["jug", "jug", "jug", "pinch", "crimp"];
      let leftX = -0.8 + (rand() - 0.5) * 0.15;
      for (let i = 0; i < numMoves; i++) {
        const y = currentY + (i + 0.5) * stepH;
        const dx = (rand() - 0.5) * 0.2;
        leftX = Math.max(-1.2, Math.min(-0.4, leftX + dx));
        const type = easyTypes[Math.floor(rand() * easyTypes.length)];
        const dir = dirs[Math.floor(rand() * dirs.length)];
        const hold: PlacedHold = {
          id: makeHoldId(), x: leftX, y, type, direction: dir,
          usage: "both",
        };
        cruxHolds.push(hold);
        holds.push(hold);
        // Extra hold on some steps for easier path
        if (rand() > 0.5) {
          const extraX = Math.max(-1.2, Math.min(-0.4, leftX + (rand() - 0.5) * 0.25));
          const extraHold: PlacedHold = {
            id: makeHoldId(), x: extraX, y: y + (rand() - 0.5) * stepH * 0.3,
            type: "jug", direction: dir, usage: "both",
          };
          cruxHolds.push(extraHold);
          holds.push(extraHold);
        }
      }

      // === RIGHT PATH (harder) — crimps, slopers, pockets, sparser ===
      // Centered around x=0.8, spread 0.4 to 1.2
      const hardTypes: HoldType[] = cruxDifficulty <= 1
        ? ["crimp", "pinch", "pocket", "crimp"]
        : ["crimp", "sloper", "pinch", "pocket", "sloper"];
      let rightX = 0.8 + (rand() - 0.5) * 0.15;
      for (let i = 0; i < numMoves; i++) {
        const y = currentY + (i + 0.5) * stepH;
        const dx = (rand() - 0.5) * 0.2;
        rightX = Math.max(0.4, Math.min(1.2, rightX + dx));
        const type = hardTypes[Math.floor(rand() * hardTypes.length)];
        const dir = dirs[Math.floor(rand() * dirs.length)];
        const hold: PlacedHold = {
          id: makeHoldId(), x: rightX, y, type, direction: dir,
          usage: "both",
        };
        cruxHolds.push(hold);
        holds.push(hold);
      }

      // === REACH HOLDS — high risk/reward, at the outer edges ===
      const numReach = 2 + Math.floor(rand() * 2);
      const reachTypes: HoldType[] = ["jug", "jug", "pinch"];
      for (let i = 0; i < numReach; i++) {
        const y = currentY + (1.5 + Math.floor(rand() * (numMoves - 2))) * stepH + stepH * 0.3;
        const side = rand() > 0.5 ? 1 : -1;
        const x = side * (1.0 + rand() * 0.35);
        const type = reachTypes[Math.floor(rand() * reachTypes.length)];
        const dir = dirs[Math.floor(rand() * dirs.length)];
        const hold: PlacedHold = {
          id: makeHoldId(), x, y: Math.max(currentY + 0.4, Math.min(sectionEnd - 0.2, y)),
          type, direction: dir, usage: "both",
        };
        cruxHolds.push(hold);
        holds.push(hold);
      }

      // === CROSSOVER HOLD — single hold in the dead zone, commits you to switching ===
      const crossY = currentY + (Math.floor(numMoves / 2) + (rand() - 0.5)) * stepH;
      const crossType = rand() > 0.3 ? "jug" : "pinch";
      const crossHold: PlacedHold = {
        id: makeHoldId(), x: (rand() - 0.5) * 0.3,
        y: Math.max(currentY + 0.5, Math.min(sectionEnd - 0.5, crossY)),
        type: crossType as HoldType, direction: dirs[Math.floor(rand() * dirs.length)], usage: "both",
      };
      cruxHolds.push(crossHold);
      holds.push(crossHold);

      // Dense foot holds across the full width — spread for both divergent paths
      const numFeet = Math.max(6, Math.ceil(secHeight / 0.35) * 3);
      for (let i = 0; i < numFeet; i++) {
        const row = Math.floor(i / 3);
        const totalRows = Math.ceil(numFeet / 3);
        const y = currentY + (row + 0.3) * (secHeight / totalRows);
        // Spread across left zone, center, and right zone
        const col = i % 3;
        const x = col === 0 ? -(0.4 + rand() * 0.7) : col === 1 ? (rand() - 0.5) * 0.3 : (0.4 + rand() * 0.7);
        const hold: PlacedHold = {
          id: makeHoldId(), x, y,
          type: rand() > 0.5 ? "foot-chip" : "foot-edge",
          direction: "up", usage: "foot",
        };
        cruxHolds.push(hold);
        holds.push(hold);
      }
      cruxes.push({ startY: currentY, endY: sectionEnd, holds: cruxHolds, solved: false });
    } else {
      // Easy section: dense jug ladder — every 0.35m, always reachable
      const stepSize = 0.35;
      const numHolds = Math.max(6, Math.ceil(secHeight / stepSize));
      const holdSpacing = secHeight / numHolds;
      for (let i = 0; i < numHolds; i++) {
        const y = currentY + (i + 0.5) * holdSpacing;
        // Alternate left/right slightly for natural ladder
        const x = (i % 2 === 0 ? -0.15 : 0.15) + (rand() - 0.5) * 0.2;
        holds.push({
          id: makeHoldId(), x, y,
          type: "jug", direction: "up", usage: "both",
        });
      }
    }
    currentY = sectionEnd;
  }

  // Top anchor
  holds.push({
    id: makeHoldId(), x: 0, y: baseY + heightMeters - 0.3,
    type: "jug", direction: "up", usage: "both",
  });

  return { pitchNumber, heightMeters, segments, holds, cruxes, completed: false };
}

// Use flat wall coordinates directly
const towerSegmentToWorld = segmentToWorld;

// ===================== SCENE COMPONENTS =====================

function SandstoneWall({ segments }: { segments: WallSegment[] }) {
  const wallWidth = 4.5;
  const segData = useMemo(() => {
    const d: { baseY: number; baseZ: number; angleRad: number; height: number }[] = [];
    let cy = 0, cz = 0;
    for (const seg of segments) {
      const ar = (seg.angleDeg * Math.PI) / 180;
      d.push({ baseY: cy, baseZ: cz, angleRad: ar, height: seg.height });
      cy += seg.height * Math.cos(ar); cz += seg.height * Math.sin(ar);
    }
    return d;
  }, [segments]);

  return (
    <group>
      {segData.map((seg, i) => (
        <mesh key={i}
          position={[0, seg.baseY + (seg.height * Math.cos(seg.angleRad)) / 2, seg.baseZ + (seg.height * Math.sin(seg.angleRad)) / 2]}
          rotation={[seg.angleRad, 0, 0]}>
          <planeGeometry args={[wallWidth, seg.height]} />
          <meshStandardMaterial color="#c4854a" roughness={0.95} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* Strata bands */}
      {segData.map((seg, i) => {
        const stripes = [];
        for (let j = 0; j < Math.floor(seg.height / 2); j++) {
          const frac = (j + 0.5) / (Math.floor(seg.height / 2) + 1);
          stripes.push(
            <mesh key={`${i}-${j}`}
              position={[0, seg.baseY + seg.height * frac * Math.cos(seg.angleRad), seg.baseZ + seg.height * frac * Math.sin(seg.angleRad) + 0.001]}
              rotation={[seg.angleRad, 0, 0]}>
              <planeGeometry args={[wallWidth, 0.08]} />
              <meshStandardMaterial color={j % 2 === 0 ? "#b87840" : "#d09060"} roughness={1} side={THREE.DoubleSide} transparent opacity={0.6} />
            </mesh>
          );
        }
        return <group key={`s-${i}`}>{stripes}</group>;
      })}
    </group>
  );
}

function SandstoneArches() {
  return (
    <group>
      <NaturalArch position={[60, 0, -80]} rotation={[0, -0.3, 0]} span={20} legHeight={8} thickness={4} />
    </group>
  );
}

function NaturalArch({ position, rotation, span, legHeight, thickness }: {
  position: [number, number, number]; rotation: [number, number, number];
  span: number; legHeight: number; thickness: number; color?: string;
}) {
  const rand = useMemo(() => seededRng(Math.round(position[0] * 100 + position[2] * 7)), [position]);

  // Arch curve — just the top span, no pillars in the curve
  const archCurve = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const archRadius = span / 2;
    const archHeight = span * 0.35;
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = Math.PI * t;
      pts.push(new THREE.Vector3(
        Math.cos(angle) * archRadius,
        legHeight + Math.sin(angle) * archHeight,
        0,
      ));
    }
    return new THREE.CatmullRomCurve3(pts);
  }, [span, legHeight]);

  // Bumpy surface blocks overlaid on the solid shape
  const surfaceBlocks = useMemo(() => {
    const r = rand;
    const parts: { pos: V3; size: V3; color: string; rot: V3 }[] = [];

    // Irregular surface bumps on the pillars
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 5; i++) {
        const y = (i / 5) * legHeight + r() * legHeight * 0.15;
        const sz = thickness * (0.3 + r() * 0.4);
        parts.push({
          pos: [side * span / 2 + (r() - 0.5) * thickness * 0.3, y, (r() - 0.5) * thickness * 0.4],
          size: [sz, sz * (0.5 + r() * 0.5), sz * (0.6 + r() * 0.4)],
          color: `hsl(${18 + r() * 12}, ${40 + r() * 15}%, ${36 + r() * 14}%)`,
          rot: [(r() - 0.5) * 0.15, (r() - 0.5) * 0.15, (r() - 0.5) * 0.1],
        });
      }
    }

    // Talus at base
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? -1 : 1;
      const sz = 0.4 + r() * 1.2;
      parts.push({
        pos: [side * (span / 2 + 0.5 + r() * 2), sz * 0.35, (r() - 0.5) * 2.5],
        size: [sz, sz * 0.6, sz * 0.7],
        color: `hsl(${20 + r() * 8}, ${35 + r() * 10}%, ${33 + r() * 15}%)`,
        rot: [(r() - 0.5) * 0.2, r() * 0.3, (r() - 0.5) * 0.2],
      });
    }

    return parts;
  }, [rand, span, legHeight, thickness]);

  const baseColor = useMemo(() => {
    const r = rand;
    return `hsl(${20 + r() * 8}, ${42 + r() * 10}%, ${40 + r() * 8}%)`;
  }, [rand]);

  return (
    <group position={position} rotation={rotation}>
      {/* Left pillar — solid box */}
      <mesh position={[-span / 2, legHeight / 2, 0]}>
        <boxGeometry args={[thickness, legHeight, thickness * 0.8]} />
        <meshStandardMaterial color={baseColor} roughness={0.95} flatShading />
      </mesh>
      {/* Right pillar — solid box */}
      <mesh position={[span / 2, legHeight / 2, 0]}>
        <boxGeometry args={[thickness, legHeight, thickness * 0.8]} />
        <meshStandardMaterial color={baseColor} roughness={0.95} flatShading />
      </mesh>
      {/* Arch span — tube geometry */}
      <mesh>
        <tubeGeometry args={[archCurve, 32, thickness * 0.5, 6, false]} />
        <meshStandardMaterial color={baseColor} roughness={0.95} flatShading />
      </mesh>
      {/* Surface detail blocks for craggy texture */}
      {surfaceBlocks.map((b, i) => (
        <mesh key={i} position={b.pos} rotation={b.rot}>
          <boxGeometry args={b.size} />
          <meshStandardMaterial color={b.color} roughness={0.95} flatShading />
        </mesh>
      ))}
    </group>
  );
}

function DesertFloor() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#c49a6c" roughness={1} />
    </mesh>
  );
}

function SandstoneFormations() {
  const formations = useMemo(() => {
    const rand = seededRng(999);
    const r: { pos: [number, number, number]; scale: [number, number, number]; color: string }[] = [];
    for (const [bx, bz] of [[-30, -25], [-18, -30], [25, -28], [35, -22], [-40, -18], [42, -35], [-25, -40], [15, -38]] as [number, number][]) {
      const h = 3 + rand() * 12, w = 4 + rand() * 8;
      r.push({ pos: [bx + rand() * 3, h * 0.45, bz + rand() * 3], scale: [w, h, w * (0.6 + rand() * 0.5)],
        color: `hsl(${18 + rand() * 12}, ${45 + rand() * 15}%, ${40 + rand() * 15}%)` });
    }
    for (let i = 0; i < 10; i++) {
      const sz = 0.2 + rand() * 0.6;
      r.push({ pos: [(rand() - 0.5) * 15, sz * 0.4, 2 + rand() * 8],
        scale: [sz * (0.8 + rand() * 0.6), sz * (0.5 + rand() * 0.5), sz * (0.7 + rand() * 0.5)],
        color: `hsl(${20 + rand() * 10}, ${35 + rand() * 15}%, ${35 + rand() * 20}%)` });
    }
    return r;
  }, []);
  return <group>{formations.map((f, i) => (
    <mesh key={i} position={f.pos} scale={f.scale}><dodecahedronGeometry args={[1, 0]} /><meshStandardMaterial color={f.color} roughness={0.95} flatShading /></mesh>
  ))}</group>;
}

function JoshuaTree({ position }: { position: [number, number, number] }) {
  const rand = useMemo(() => seededRng(Math.round(position[0] * 100 + position[2] * 77)), [position]);
  const tree = useMemo(() => {
    const r = rand;
    const trunkH = 1.5 + r() * 2.5;
    const trunkR = 0.08 + r() * 0.05;
    // 2-4 branches forking from the top
    const numBranches = 2 + Math.floor(r() * 3);
    const branches: { angle: number; tilt: number; len: number; r: number }[] = [];
    for (let i = 0; i < numBranches; i++) {
      branches.push({
        angle: (i / numBranches) * Math.PI * 2 + (r() - 0.5) * 0.5,
        tilt: 0.4 + r() * 0.6,
        len: 0.6 + r() * 1.0,
        r: trunkR * (0.5 + r() * 0.3),
      });
    }
    return { trunkH, trunkR, branches };
  }, [rand]);

  return (
    <group position={position}>
      {/* Trunk — rough, shaggy bark */}
      <mesh position={[0, tree.trunkH / 2, 0]}>
        <cylinderGeometry args={[tree.trunkR * 0.85, tree.trunkR, tree.trunkH, 6]} />
        <meshStandardMaterial color="#5a4a35" roughness={1} flatShading />
      </mesh>
      {/* Branches with spiky leaf clusters */}
      {tree.branches.map((b, i) => {
        const bx = Math.sin(b.angle) * 0.05;
        const bz = Math.cos(b.angle) * 0.05;
        const ex = bx + Math.sin(b.angle) * Math.sin(b.tilt) * b.len;
        const ey = tree.trunkH + Math.cos(b.tilt) * b.len;
        const ez = bz + Math.cos(b.angle) * Math.sin(b.tilt) * b.len;
        return (
          <group key={i}>
            {/* Branch */}
            <MPLimb from={[bx, tree.trunkH, bz]} to={[ex, ey, ez]} color="#5a4a35" width={3} />
            {/* Spiky leaf cluster at tip */}
            <mesh position={[ex, ey + 0.15, ez]}>
              <dodecahedronGeometry args={[0.2 + b.len * 0.15, 0]} />
              <meshStandardMaterial color="#5a7a3a" roughness={0.9} flatShading />
            </mesh>
            <mesh position={[ex, ey + 0.25, ez]}>
              <coneGeometry args={[0.12 + b.len * 0.08, 0.25, 5]} />
              <meshStandardMaterial color="#4a6a2a" roughness={0.9} flatShading />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function DesertPlants() {
  const plants = useMemo(() => {
    const rand = seededRng(333);
    return Array.from({ length: 20 }, () => {
      const angle = rand() * Math.PI * 2, dist = 5 + rand() * 25;
      return {
        pos: [Math.cos(angle) * dist, 0, Math.sin(angle) * dist] as [number, number, number],
        type: rand() > 0.5 ? "joshua" as const : "sage" as const,
      };
    });
  }, []);
  return <group>{plants.map((p, i) => p.type === "joshua" ? (
    <JoshuaTree key={i} position={p.pos} />
  ) : (
    <mesh key={i} position={[p.pos[0], 0.15, p.pos[2]]}><sphereGeometry args={[0.25, 6, 6]} /><meshStandardMaterial color="#8a9a6a" roughness={0.9} /></mesh>
  ))}</group>;
}

function MPBird({ cx, cy, cz, radius, speed, phase }: {
  cx: number; cy: number; cz: number; radius: number; speed: number; phase: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const leftWingRef = useRef<THREE.Mesh>(null);
  const rightWingRef = useRef<THREE.Mesh>(null);

  const wingGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, 0,  0.3, 0, -0.04,  0.55, 0.02, -0.08,  0, 0, 0.03,  0.3, 0, 0.01,
    ], 3));
    geo.setIndex([0, 1, 4, 0, 4, 3, 1, 2, 4]);
    geo.computeVertexNormals();
    return geo;
  }, []);

  useFrame(() => {
    if (!groupRef.current) return;
    const t = Date.now() * 0.001;
    const angle = t * speed + phase;
    groupRef.current.position.set(
      cx + Math.sin(angle) * radius,
      cy + Math.sin(angle * 1.3) * 0.8,
      cz + Math.cos(angle * 0.7) * radius * 0.6
    );
    const dx = Math.cos(angle) * radius * speed;
    const dz = -Math.sin(angle * 0.7) * radius * 0.6 * speed * 0.7;
    groupRef.current.rotation.y = Math.atan2(dx, dz);
    groupRef.current.rotation.z = -Math.cos(angle) * 0.15;

    const flapCycle = (t * 2.5 + phase * 3) % 4;
    let flapAngle: number;
    if (flapCycle < 0.3) flapAngle = Math.sin((flapCycle / 0.3) * Math.PI) * 0.5;
    else if (flapCycle < 0.6) flapAngle = Math.sin(((flapCycle - 0.3) / 0.3) * Math.PI) * -0.3;
    else flapAngle = Math.sin((flapCycle - 0.6) * 0.3) * 0.05;

    if (leftWingRef.current) leftWingRef.current.rotation.z = flapAngle;
    if (rightWingRef.current) rightWingRef.current.rotation.z = -flapAngle;
  });

  return (
    <group ref={groupRef}>
      <mesh><capsuleGeometry args={[0.015, 0.06, 4, 6]} /><meshStandardMaterial color="#2a2a2a" roughness={0.9} flatShading /></mesh>
      <mesh ref={leftWingRef} geometry={wingGeo}><meshStandardMaterial color="#1a1a1a" roughness={0.8} side={THREE.DoubleSide} flatShading /></mesh>
      <mesh ref={rightWingRef} geometry={wingGeo} scale={[-1, 1, 1]}><meshStandardMaterial color="#1a1a1a" roughness={0.8} side={THREE.DoubleSide} flatShading /></mesh>
      <mesh position={[0, 0, 0.04]} rotation={[0.2, 0, 0]}>
        <bufferGeometry><bufferAttribute attach="attributes-position" array={new Float32Array([-0.02, 0, 0, 0.02, 0, 0, 0, 0, 0.04])} count={3} itemSize={3} /></bufferGeometry>
        <meshStandardMaterial color="#1a1a1a" side={THREE.DoubleSide} flatShading />
      </mesh>
    </group>
  );
}

function DesertBirds() {
  const birds = useMemo(() => {
    const rand = seededRng(555);
    return Array.from({ length: 8 }, () => ({
      cx: (rand() - 0.5) * 40,
      cy: 15 + rand() * 20,
      cz: -15 + (rand() - 0.5) * 30,
      radius: 4 + rand() * 8,
      speed: 0.1 + rand() * 0.1,
      phase: rand() * Math.PI * 2,
    }));
  }, []);
  return <group>{birds.map((b, i) => <MPBird key={i} {...b} />)}</group>;
}

// --- Holds ---
function HoldMesh({ hold, segments, onClick, isAssigned, isReachable, pulseHighlight, isCrux, reachFraction }: {
  hold: PlacedHold; segments: WallSegment[]; onClick?: () => void;
  isAssigned?: boolean; isReachable?: boolean; pulseHighlight?: boolean; isCrux?: boolean;
  reachFraction?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { pos } = towerSegmentToWorld(hold.x, hold.y, segments);
  const info = HOLD_INFO[hold.type];
  const baseScale = hold.type === "jug" || hold.type === "volume" ? 0.06 : hold.type === "foot-chip" ? 0.035 : 0.05;
  const scale = (isReachable || isCrux) ? baseScale * 1.3 : baseScale;
  const isRisky = isReachable && reachFraction !== undefined && reachFraction > 0.8;
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    if (isRisky) {
      // Risky holds pulse red/orange as warning
      meshRef.current.scale.setScalar(1 + Math.sin(clock.getElapsedTime() * 4) * 0.2);
    } else {
      meshRef.current.scale.setScalar(pulseHighlight ? 1 + Math.sin(clock.getElapsedTime() * 6) * 0.3 : 1);
    }
  });
  const riskyColor = "#ff6600";
  return (
    <mesh ref={meshRef} position={[pos[0], pos[1], pos[2] + 0.02]}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
      <sphereGeometry args={[scale, 8, 8]} />
      <meshStandardMaterial
        color={isAssigned ? "#fff" : isRisky ? riskyColor : pulseHighlight ? "#aaffaa" : isReachable ? info.color : isCrux ? info.color : "#555"}
        emissive={isAssigned ? "#ffff00" : isRisky ? "#ff2200" : pulseHighlight ? "#44ff44" : isCrux ? "#ff4400" : isReachable ? info.color : "#000"}
        emissiveIntensity={isAssigned ? 0.6 : isRisky ? 0.7 : pulseHighlight ? 0.8 : isCrux ? 0.3 : isReachable ? 0.15 : 0}
        roughness={0.8} />
    </mesh>
  );
}

// --- Protection gear (cam/nut placed in crack) ---
function ProtectionPiece({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {/* Cam lobes */}
      <mesh rotation={[0, 0, Math.PI / 4]}>
        <torusGeometry args={[0.03, 0.008, 6, 8, Math.PI]} />
        <meshStandardMaterial color="#ddaa22" metalness={0.7} />
      </mesh>
      <mesh rotation={[0, 0, -Math.PI / 4]}>
        <torusGeometry args={[0.03, 0.008, 6, 8, Math.PI]} />
        <meshStandardMaterial color="#ddaa22" metalness={0.7} />
      </mesh>
      {/* Stem */}
      <mesh position={[0, -0.04, 0]}>
        <cylinderGeometry args={[0.004, 0.004, 0.06, 4]} />
        <meshStandardMaterial color="#999" metalness={0.9} />
      </mesh>
      {/* Carabiner */}
      <mesh position={[0, -0.08, 0]}>
        <torusGeometry args={[0.015, 0.004, 6, 10]} />
        <meshStandardMaterial color="#ccc" metalness={0.9} />
      </mesh>
    </group>
  );
}

// --- Belayer ---
function Belayer({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 1.6, 0]}><sphereGeometry args={[0.065, 10, 10]} /><meshStandardMaterial color="#ddbbaa" /></mesh>
      <mesh position={[0, 1.66, 0]}><sphereGeometry args={[0.075, 10, 10]} /><meshStandardMaterial color="#cc3333" /></mesh>
      <mesh position={[0, 1.3, 0]}><cylinderGeometry args={[0.08, 0.09, 0.35, 8]} /><meshStandardMaterial color="#aa6633" /></mesh>
      <mesh position={[0, 1.08, 0]}><cylinderGeometry args={[0.1, 0.1, 0.06, 8]} /><meshStandardMaterial color="#333" /></mesh>
      <mesh position={[-0.12, 1.25, 0.06]} rotation={[0.3, 0, 0.2]}><cylinderGeometry args={[0.02, 0.02, 0.25, 6]} /><meshStandardMaterial color="#cc9977" /></mesh>
      <mesh position={[0.12, 1.15, 0.04]} rotation={[-0.5, 0, -0.3]}><cylinderGeometry args={[0.02, 0.02, 0.25, 6]} /><meshStandardMaterial color="#cc9977" /></mesh>
      <mesh position={[-0.04, 0.75, 0]}><cylinderGeometry args={[0.03, 0.03, 0.6, 6]} /><meshStandardMaterial color="#556644" /></mesh>
      <mesh position={[0.04, 0.75, 0]}><cylinderGeometry args={[0.03, 0.03, 0.6, 6]} /><meshStandardMaterial color="#556644" /></mesh>
      <Text position={[0, 1.95, 0]} fontSize={0.1} color="#ffcc00" anchorX="center">On belay!</Text>
    </group>
  );
}

// --- Rope ---
function Rope({ climberPos, belayerPos, anchors }: {
  climberPos: [number, number, number]; belayerPos: [number, number, number]; anchors: [number, number, number][];
}) {
  const points = useMemo(() => {
    // Sort anchors by height (highest first, near climber) to prevent z-clipping/zig-zag
    const sorted = [...anchors].sort((a, b) => b[1] - a[1]);
    const pts: [number, number, number][] = [climberPos, ...sorted, belayerPos];
    const result: [number, number, number][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      for (let j = 0; j <= 10; j++) {
        const t = j / 10;
        const sag = Math.sin(t * Math.PI) * Math.min(0.5, Math.abs(a[1] - b[1]) * 0.05);
        result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag, a[2] + (b[2] - a[2]) * t + sag * 0.3]);
      }
    }
    return result;
  }, [climberPos, belayerPos, anchors]);
  return (
    <>
      <Line points={points} color="#ddaa33" lineWidth={2.5} />
      {anchors.map((a, i) => (
        <group key={i} position={a}>
          <mesh><torusGeometry args={[0.018, 0.005, 6, 10]} /><meshStandardMaterial color="#ccc" metalness={0.9} /></mesh>
          <mesh position={[0, -0.035, 0]}><boxGeometry args={[0.01, 0.05, 0.006]} /><meshStandardMaterial color="#2255cc" /></mesh>
        </group>
      ))}
    </>
  );
}

// --- Climber with clickable limb controls ---
function MPClimber({ limbPositions, segments, selectedLimb, onLimbClick, fatigue, phase }: {
  limbPositions: Record<Limb, { x: number; y: number }>; segments: WallSegment[];
  selectedLimb: Limb | null; onLimbClick: (limb: Limb) => void;
  fatigue: { left: number; right: number }; phase: GamePhase;
}) {
  const lh: V3 = towerSegmentToWorld(limbPositions.leftHand.x, limbPositions.leftHand.y, segments).pos as V3;
  const rh: V3 = towerSegmentToWorld(limbPositions.rightHand.x, limbPositions.rightHand.y, segments).pos as V3;
  const lf: V3 = towerSegmentToWorld(limbPositions.leftFoot.x, limbPositions.leftFoot.y, segments).pos as V3;
  const rf: V3 = towerSegmentToWorld(limbPositions.rightFoot.x, limbPositions.rightFoot.y, segments).pos as V3;

  // Body proportions (height ~5.75ft)
  const s = 1.0;
  const torsoLen = 0.3 * s;
  const shoulderW = 0.115 * s;
  const hipW = 0.085 * s;
  const headRadius = 0.065 * s;
  const neckLen = 0.035 * s;
  const armLen = 0.45 * s;
  const upperArm = armLen * 0.42;
  const forearm = armLen * 0.33;
  const handLen = armLen * 0.25;
  const legLen = 0.47 * s;
  const thigh = legLen * 0.52;
  const shin = legLen * 0.4;
  const footHeight = legLen * 0.08;
  const armReach = upperArm + forearm + handLen;
  const legReach = thigh + shin + footHeight;

  // Compute CoG from limb positions
  const feetMidX = (limbPositions.leftFoot.x + limbPositions.rightFoot.x) / 2;
  const handsMidX = (limbPositions.leftHand.x + limbPositions.rightHand.x) / 2;
  const cogX = feetMidX + (handsMidX - feetMidX) * 0.55;
  const feetMidY = (limbPositions.leftFoot.y + limbPositions.rightFoot.y) / 2;
  const handsMidY = (limbPositions.leftHand.y + limbPositions.rightHand.y) / 2;
  const cogH = feetMidY + (handsMidY - feetMidY) * 0.55;

  // Place body parts on wall surface with normal offset
  const toWorld = (x: number, h: number, d: number): V3 => {
    const base = towerSegmentToWorld(x, h, segments);
    return [base.pos[0], base.pos[1], base.pos[2] + d] as V3;
  };

  const bodyOff = 0.15 * s;
  const chestOff = 0.12 * s;

  const pelvis = toWorld(cogX, cogH, bodyOff);
  const chest = toWorld(cogX, cogH + torsoLen, chestOff);
  const head = toWorld(cogX, cogH + torsoLen + neckLen + headRadius, chestOff * 0.95);

  const shoulderL = toWorld(cogX - shoulderW, cogH + torsoLen, chestOff);
  const shoulderR = toWorld(cogX + shoulderW, cogH + torsoLen, chestOff);
  const hipL = toWorld(cogX - hipW, cogH, bodyOff);
  const hipR = toWorld(cogX + hipW, cogH, bodyOff);

  // Clamp limb targets to reach
  const lhClamped = clampToReach(shoulderL, lh, armReach);
  const rhClamped = clampToReach(shoulderR, rh, armReach);
  const lfClamped = clampToReach(hipL, lf, legReach);
  const rfClamped = clampToReach(hipR, rf, legReach);

  // Derive wrist/ankle positions
  const wristFrom = (shoulder: V3, hand: V3): V3 => {
    const d = v3len(v3sub(hand, shoulder));
    if (d < 0.001) return hand;
    return v3add(shoulder, v3scale(v3normalize(v3sub(hand, shoulder)), Math.max(0, d - handLen)));
  };
  const ankleFrom = (hip: V3, foot: V3): V3 => {
    const d = v3len(v3sub(foot, hip));
    if (d < 0.001) return foot;
    return v3add(hip, v3scale(v3normalize(v3sub(foot, hip)), Math.max(0, d - footHeight)));
  };

  const wristL = wristFrom(shoulderL, lhClamped);
  const wristR = wristFrom(shoulderR, rhClamped);
  const ankleL = ankleFrom(hipL, lfClamped);
  const ankleR = ankleFrom(hipR, rfClamped);

  // Elbow bend direction
  const computeElbowBend = (shoulder: V3, wrist: V3, lateralSign: number): V3 => {
    const armMid: V3 = [(shoulder[0]+wrist[0])/2, (shoulder[1]+wrist[1])/2, (shoulder[2]+wrist[2])/2];
    const midToBody = v3sub(chest, armMid);
    const limbDir = v3normalize(v3sub(wrist, shoulder));
    const along = v3dot(midToBody, limbDir);
    let outward = v3sub(midToBody, v3scale(limbDir, along));
    const outLen = v3len(outward);
    if (outLen < 0.01) outward = [0, 0, 1];
    else outward = v3scale(outward, 1/outLen);
    const down: V3 = [0, -1, 0];
    const lateral: V3 = [lateralSign, 0, 0];
    let desired = v3normalize(v3add(v3add(v3scale(down, 1.0), v3scale(lateral, 0.5)), v3scale(outward, 0.3)));
    const forward = v3normalize(v3sub(wrist, shoulder));
    if (Math.abs(v3dot(desired, forward)) > 0.95) {
      desired = v3normalize(v3add(v3scale(outward, 0.7), v3scale(lateral, 0.3)));
    }
    return desired;
  };

  // Knee bend direction
  const computeKneeBend = (hip: V3, ankle: V3, lateralSign: number): V3 => {
    const hipToAnkle = v3sub(ankle, hip);
    const legDist = v3len(hipToAnkle);
    const maxLeg = thigh + shin;
    const bunchFactor = Math.max(0, 1 - legDist / (maxLeg * 0.95));
    const footToChest = v3sub(chest, ankle);
    const limbAxis = legDist > 0.001 ? v3normalize(hipToAnkle) : [0,-1,0] as V3;
    const alongLimb = v3dot(footToChest, limbAxis);
    let outward = v3sub(footToChest, v3scale(limbAxis, alongLimb));
    const outLen = v3len(outward);
    if (outLen < 0.01) outward = v3normalize(v3add(v3sub(chest, hip), [0, 0, 0.1]));
    else outward = v3scale(outward, 1/outLen);
    const footBelow = Math.max(0, Math.min(1, (hip[1]-ankle[1])/(maxLeg*0.5)));
    return v3normalize(v3add(
      v3add(v3scale(outward, 0.7), v3scale([0,1,0], footBelow * 0.3)),
      [lateralSign * (0.2 + bunchFactor * 0.5), 0, 0]
    ));
  };

  // Solve IK for all limbs
  const elbowBendL = computeElbowBend(shoulderL, wristL, -1);
  const elbowBendR = computeElbowBend(shoulderR, wristR, 1);
  const elbowL = solveIK2Bone(shoulderL, wristL, upperArm, forearm, elbowBendL);
  const elbowR = solveIK2Bone(shoulderR, wristR, upperArm, forearm, elbowBendR);

  const kneeBendL = computeKneeBend(hipL, ankleL, -1);
  const kneeBendR = computeKneeBend(hipR, ankleR, 1);
  let kneeL = solveIK2Bone(hipL, ankleL, thigh, shin, kneeBendL);
  let kneeR = solveIK2Bone(hipR, ankleR, thigh, shin, kneeBendR);

  // Clamp knees
  const clampKnee = (knee: V3, hip: V3, ankle: V3): V3 => {
    const k: V3 = [...knee];
    const minY = Math.min(hip[1], ankle[1]) - 0.05;
    if (k[1] < minY) k[1] = minY;
    if (k[1] < 0) k[1] = 0;
    const bodyZ = Math.max(hip[2], ankle[2], pelvis[2]);
    if (k[2] < bodyZ) k[2] = bodyZ;
    return k;
  };
  kneeL = clampKnee(kneeL, hipL, ankleL);
  kneeR = clampKnee(kneeR, hipR, ankleR);

  const skinColor = "#ddbbaa";
  const limbColor = "#cc9977";
  const torsoColor = "#5588aa";

  const limbColors: Record<Limb, string> = {
    leftHand: "#ff6644", rightHand: "#44aaff", leftFoot: "#ff9944", rightFoot: "#44ccaa",
  };
  const limbLabels: Record<Limb, string> = {
    leftHand: "LH", rightHand: "RH", leftFoot: "LF", rightFoot: "RF",
  };

  const showControls = phase === "crux";

  // Torso cylinder orientation
  const torsoMid: V3 = [(chest[0]+pelvis[0])/2, (chest[1]+pelvis[1])/2, (chest[2]+pelvis[2])/2];
  const torsoDir = v3normalize(v3sub(chest, pelvis));
  const torsoQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(...torsoDir)
  );

  // Head direction for beanie
  const headDir = v3normalize(v3sub(head, chest));
  const beaniePos = v3add(head, v3scale(headDir, headRadius * 0.35));
  const headQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(...headDir)
  );

  return (
    <group>
      {/* Head */}
      <mesh position={head}><sphereGeometry args={[headRadius, 16, 16]} /><meshStandardMaterial color={skinColor} roughness={0.7} /></mesh>
      {/* Beanie */}
      <group position={beaniePos} quaternion={headQuat}>
        <mesh><sphereGeometry args={[headRadius * 1.05, 12, 8, 0, Math.PI*2, 0, Math.PI*0.55]} /><meshStandardMaterial color="#1a1a1a" roughness={0.95} /></mesh>
        <mesh position={[0, -headRadius*0.7*0.15, 0]}><cylinderGeometry args={[headRadius*1.07, headRadius*1.09, headRadius*0.7*0.25, 14]} /><meshStandardMaterial color="#222222" roughness={0.9} /></mesh>
      </group>

      {/* Neck */}
      <MPLimb from={head} to={chest} color={skinColor} width={3} />

      {/* Torso */}
      <mesh position={torsoMid} quaternion={torsoQuat}>
        <cylinderGeometry args={[shoulderW * 0.8, hipW, torsoLen * 0.95, 12]} />
        <meshStandardMaterial color={torsoColor} roughness={0.7} />
      </mesh>
      <MPLimb from={shoulderL} to={shoulderR} color={torsoColor} width={4} />
      <MPLimb from={hipL} to={hipR} color={torsoColor} width={3} />

      {/* Harness */}
      <mesh position={pelvis}><cylinderGeometry args={[hipW*1.1, hipW*1.1, 0.06, 8]} /><meshStandardMaterial color="#333" /></mesh>

      {/* Left arm: shoulder → elbow → wrist → hand */}
      <MPLimb from={shoulderL} to={elbowL} color={limbColor} width={3.5} />
      <MPLimb from={elbowL} to={wristL} color={limbColor} width={2.5} />
      <MPLimb from={wristL} to={lhClamped} color={limbColor} width={1.5} />
      <MPJoint position={shoulderL} size={0.032*s} color={skinColor} />
      <MPJoint position={elbowL} size={0.024*s} color={skinColor} />
      <MPJoint position={wristL} size={0.016*s} color={skinColor} />

      {/* Right arm */}
      <MPLimb from={shoulderR} to={elbowR} color={limbColor} width={3.5} />
      <MPLimb from={elbowR} to={wristR} color={limbColor} width={2.5} />
      <MPLimb from={wristR} to={rhClamped} color={limbColor} width={1.5} />
      <MPJoint position={shoulderR} size={0.032*s} color={skinColor} />
      <MPJoint position={elbowR} size={0.024*s} color={skinColor} />
      <MPJoint position={wristR} size={0.016*s} color={skinColor} />

      {/* Left leg: hip → knee → ankle → foot */}
      <MPLimb from={hipL} to={kneeL} color="#445566" width={4} />
      <MPLimb from={kneeL} to={ankleL} color="#445566" width={3} />
      <MPLimb from={ankleL} to={lfClamped} color="#445566" width={2} />
      <MPJoint position={hipL} size={0.034*s} color={skinColor} />
      <MPJoint position={kneeL} size={0.028*s} color={skinColor} />
      <MPJoint position={ankleL} size={0.018*s} color={skinColor} />

      {/* Right leg */}
      <MPLimb from={hipR} to={kneeR} color="#445566" width={4} />
      <MPLimb from={kneeR} to={ankleR} color="#445566" width={3} />
      <MPLimb from={ankleR} to={rfClamped} color="#445566" width={2} />
      <MPJoint position={hipR} size={0.034*s} color={skinColor} />
      <MPJoint position={kneeR} size={0.028*s} color={skinColor} />
      <MPJoint position={ankleR} size={0.018*s} color={skinColor} />

      {/* Clickable limb controls — large and obvious during crux */}
      {(["leftHand", "rightHand", "leftFoot", "rightFoot"] as Limb[]).map(limb => {
        const pos = limb === "leftHand" ? lhClamped : limb === "rightHand" ? rhClamped : limb === "leftFoot" ? lfClamped : rfClamped;
        const isSel = selectedLimb === limb;
        const isHand = limb.includes("Hand");
        const fat = limb === "leftHand" ? fatigue.left : limb === "rightHand" ? fatigue.right : 0;
        const fatColor = fat > 80 ? "#ff3333" : fat > 50 ? "#ffaa00" : limbColors[limb];
        // During crux, make controls large and glowing
        const baseSize = showControls ? 0.06 : 0.025;
        const selSize = showControls ? 0.08 : 0.035;
        const size = isSel ? selSize : baseSize;

        // Offset when matched (two limbs at same position) so both are clickable
        const isLeft = limb === "leftHand" || limb === "leftFoot";
        const matchOffset: V3 = (() => {
          if (!showControls) return [0, 0, 0] as V3;
          const other = limb === "leftHand" ? rhClamped : limb === "rightHand" ? lhClamped
            : limb === "leftFoot" ? rfClamped : lfClamped;
          const dist = Math.sqrt((pos[0] - other[0]) ** 2 + (pos[1] - other[1]) ** 2);
          if (dist < 0.08) return [isLeft ? -0.08 : 0.08, 0, 0] as V3;
          return [0, 0, 0] as V3;
        })();
        const offsetPos: V3 = [pos[0] + matchOffset[0], pos[1] + matchOffset[1], pos[2] + matchOffset[2]];

        return (
          <group key={limb}>
            {/* Outer glow ring during crux */}
            {showControls && (
              <mesh position={[offsetPos[0], offsetPos[1], offsetPos[2] + 0.02]}>
                <ringGeometry args={[size * 1.1, size * 1.6, 16]} />
                <meshBasicMaterial color={isSel ? "#ffff00" : limbColors[limb]} transparent opacity={isSel ? 0.8 : 0.4} side={THREE.DoubleSide} />
              </mesh>
            )}
            {/* Main clickable sphere */}
            <mesh position={offsetPos}
              onClick={(e) => { e.stopPropagation(); if (showControls) onLimbClick(limb); }}>
              <sphereGeometry args={[size, 12, 12]} />
              <meshStandardMaterial
                color={isSel ? "#ffffff" : isHand ? fatColor : limbColors[limb]}
                emissive={isSel ? "#ffff00" : showControls ? limbColors[limb] : "#000"}
                emissiveIntensity={isSel ? 1.0 : showControls ? 0.6 : 0}
                transparent={showControls}
                opacity={showControls ? 0.9 : 1} />
            </mesh>
            {/* Always-visible label during crux — big and clickable */}
            {showControls && (
              <Html position={[offsetPos[0], offsetPos[1] + (isHand ? 0.12 : -0.1), offsetPos[2] + 0.08]} center
                style={{ userSelect: "none" }}>
                <div onClick={(e) => { e.stopPropagation(); onLimbClick(limb); }}
                  style={{
                    background: isSel ? limbColors[limb] : "rgba(0,0,0,0.85)",
                    color: "#fff", padding: "4px 10px", borderRadius: 6,
                    fontSize: 13, fontWeight: 800, fontFamily: "system-ui",
                    border: `2px solid ${isSel ? "#fff" : limbColors[limb]}`,
                    whiteSpace: "nowrap", cursor: "pointer",
                    boxShadow: isSel ? `0 0 12px ${limbColors[limb]}` : "0 2px 8px rgba(0,0,0,0.5)",
                    transition: "all 0.15s",
                  }}>
                  {limbLabels[limb]}
                  {isHand && fat > 20 && <span style={{ color: fatColor, marginLeft: 4 }}>{Math.round(fat)}%</span>}
                </div>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

// --- Camera ---
function FollowCamera({ targetY, phase, wallNormalZ, wallNormalY }: {
  targetY: number; phase: GamePhase; wallNormalZ: number; wallNormalY: number;
}) {
  const ref = useRef<any>(null);
  useFrame(() => {
    if (!ref.current) return;
    const isCrux = phase === "crux";
    const isAuto = phase === "auto";
    // Camera behind climber relative to wall face normal
    const camDist = isCrux ? 5.0 : 8;
    const goalCamZ = Math.max(2, wallNormalZ * camDist);
    const goalCamX = isCrux ? 2.0 : 3.5;
    const goalHeight = targetY + wallNormalY * camDist * 0.3 + (isCrux ? 1.2 : 2.5);
    const goalTargetX = 0;
    const goalTargetZ = Math.max(0, wallNormalZ * 0.3);
    // Very slow smoothing during auto-climb to prevent shakiness
    const smooth = isAuto ? 0.012 : 0.025;
    const ySmooth = isAuto ? 0.015 : isCrux ? 0.04 : 0.03;

    ref.current.target.x += (goalTargetX - ref.current.target.x) * smooth;
    ref.current.target.y += (targetY - ref.current.target.y) * ySmooth;
    ref.current.target.z += (goalTargetZ - ref.current.target.z) * smooth;
    ref.current.object.position.x += (goalCamX - ref.current.object.position.x) * smooth;
    ref.current.object.position.y += (goalHeight - ref.current.object.position.y) * ySmooth;
    ref.current.object.position.z += (goalCamZ - ref.current.object.position.z) * smooth;
  });
  return <OrbitControls ref={ref} makeDefault minDistance={2} maxDistance={30} target={[0, targetY, 0.5]} />;
}

// --- Crux zone marker ---
function CruxZone({ startY, endY, segments, active, solved }: {
  startY: number; endY: number; segments: WallSegment[]; active: boolean; solved: boolean;
}) {
  const startW = towerSegmentToWorld(-1.8, startY, segments);
  const endW = towerSegmentToWorld(-1.8, endY, segments);
  const midY = (startW.pos[1] + endW.pos[1]) / 2;
  const color = solved ? "#44cc66" : active ? "#ff4400" : "#ff880088";
  return (
    <group>
      <Text position={[startW.pos[0], midY, startW.pos[2] + 0.1]} fontSize={0.25}
        color={color} anchorX="center" fontWeight={700}>
        {solved ? "SENT" : active ? "CRUX" : "CRUX"}
      </Text>
    </group>
  );
}

// ===================== MAIN =====================
export default function MultiPitchPage({ onBack }: { onBack: () => void }) {
  const [pitches, setPitches] = useState<PitchData[]>(() => [generatePitch(1, 0)]);
  const [currentPitchIdx, setCurrentPitchIdx] = useState(0);
  const currentPitch = pitches[currentPitchIdx];

  const allHolds = useMemo(() => pitches.flatMap(p => p.holds), [pitches]);
  const allSegments = useMemo(() => pitches.flatMap(p => p.segments), [pitches]);

  const [limbPos, setLimbPos] = useState<Record<Limb, { x: number; y: number }>>({
    leftHand: { x: -0.2, y: 0.6 }, rightHand: { x: 0.2, y: 0.8 },
    leftFoot: { x: -0.2, y: 0.15 }, rightFoot: { x: 0.2, y: 0.2 },
  });
  const [limbHolds, setLimbHolds] = useState<Record<Limb, string | null>>({
    leftHand: null, rightHand: null, leftFoot: null, rightFoot: null,
  });

  const [fatigue, setFatigue] = useState({ left: 0, right: 0 });
  const [gripUsed, setGripUsed] = useState(0);
  const [score, setScore] = useState(0);
  const [moveCount, setMoveCount] = useState(0);
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [selectedLimb, setSelectedLimb] = useState<Limb | null>(null);
  const [gameOver, setGameOver] = useState(false);
  const [fell, setFell] = useState(false);
  const [falling, setFalling] = useState(false);
  const [fallOffset, setFallOffset] = useState(0);
  const [ropeAnchors, setRopeAnchors] = useState<[number, number, number][]>([]);
  const [protectionPoints, setProtectionPoints] = useState<[number, number, number][]>([]);
  const [cruxTimer, setCruxTimer] = useState(100);
  const [activeCruxIdx, setActiveCruxIdx] = useState(-1);
  const [autoClimbing, setAutoClimbing] = useState(false);
  const [followerProgress, setFollowerProgress] = useState(0); // 0..1 during "following" phase
  const [message, setMessage] = useState<string | null>(null);
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const animRef = useRef<number | null>(null);
  const limbPosRef = useRef(limbPos);
  limbPosRef.current = limbPos;
  const completePitchRef = useRef<() => void>(() => {});

  const showMessage = useCallback((msg: string, duration = 2000) => {
    setMessage(msg);
    if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    messageTimeoutRef.current = setTimeout(() => setMessage(null), duration);
  }, []);

  // Trigger fall animation then game over
  const triggerFall = useCallback(() => {
    if (falling || gameOver) return;
    setFalling(true);
    setFell(true);
    showMessage("FALLING!", 2000);

    let frame = 0;
    const startPos = { ...limbPosRef.current };
    const fallAnim = () => {
      frame++;
      const t = frame / 40;
      setFallOffset(t * t * 4);

      // Limbs go limp — spread and drop
      const drop = t * t * 3;
      setLimbPos(() => ({
        leftHand: { x: startPos.leftHand.x - t * 0.3, y: startPos.leftHand.y - drop * 0.4 },
        rightHand: { x: startPos.rightHand.x + t * 0.3, y: startPos.rightHand.y - drop * 0.3 },
        leftFoot: { x: startPos.leftFoot.x - t * 0.4, y: startPos.leftFoot.y - drop },
        rightFoot: { x: startPos.rightFoot.x + t * 0.4, y: startPos.rightFoot.y - drop * 0.9 },
      }));

      if (frame < 40) {
        requestAnimationFrame(fallAnim);
      } else {
        setGameOver(true);
        setFalling(false);
      }
    };
    requestAnimationFrame(fallAnim);
  }, [falling, gameOver, showMessage]);

  // Pitch metrics
  const pitchTopY = useMemo(() => {
    let y = 0; for (let i = 0; i <= currentPitchIdx; i++) y += pitches[i].heightMeters; return y;
  }, [pitches, currentPitchIdx]);
  const pitchBaseY = useMemo(() => {
    let y = 0; for (let i = 0; i < currentPitchIdx; i++) y += pitches[i].heightMeters; return y;
  }, [pitches, currentPitchIdx]);

  const highestLimb = Math.max(limbPos.leftHand.y, limbPos.rightHand.y);
  const pitchProgress = Math.min(100, ((highestLimb - pitchBaseY) / currentPitch.heightMeters) * 100);

  // Physics
  const wallAngle = useMemo(() => {
    const avgY = (limbPos.leftHand.y + limbPos.rightHand.y + limbPos.leftFoot.y + limbPos.rightFoot.y) / 4;
    let remaining = avgY;
    for (const seg of allSegments) { if (remaining <= seg.height) return seg.angleDeg; remaining -= seg.height; }
    return allSegments[allSegments.length - 1]?.angleDeg ?? 0;
  }, [limbPos, allSegments]);
  const isOverhang = wallAngle > 10;

  const physicsConfig = useMemo((): ClimberConfig => {
    const getPull = (limb: Limb): PullDirection => {
      const hid = limbHolds[limb]; if (!hid) return limb.includes("Hand") ? "down" : "edge";
      const h = allHolds.find(x => x.id === hid); if (!h) return limb.includes("Hand") ? "down" : "edge";
      return limb.includes("Hand") ? holdToPullHand(h.type, h.direction) : holdToPullFoot(h.type, h.direction, isOverhang);
    };
    return {
      bodyWeightKg: 70, gripStrengthKg: 45, heightFt: 5.75, apeIndexIn: 69,
      bodyRotationDeg: 0, wallAngleDeg: wallAngle,
      leftHandPull: getPull("leftHand"), rightHandPull: getPull("rightHand"),
      leftFootPull: getPull("leftFoot"), rightFootPull: getPull("rightFoot"),
      leftKneeTurnDeg: 0, rightKneeTurnDeg: 0, hipOffset: 0.35, torsoOffset: 0.5,
      leftHandOn: true, rightHandOn: true, leftFootOn: true, rightFootOn: true,
      leftHand: limbPos.leftHand, rightHand: limbPos.rightHand,
      leftFoot: limbPos.leftFoot, rightFoot: limbPos.rightFoot,
      centerOfGravity: {
        x: (limbPos.leftFoot.x + limbPos.rightFoot.x) / 2 + ((limbPos.leftHand.x + limbPos.rightHand.x) / 2 - (limbPos.leftFoot.x + limbPos.rightFoot.x) / 2) * 0.55,
        y: (limbPos.leftFoot.y + limbPos.rightFoot.y) / 2 + ((limbPos.leftHand.y + limbPos.rightHand.y) / 2 - (limbPos.leftFoot.y + limbPos.rightFoot.y) / 2) * 0.55,
      },
    };
  }, [limbPos, wallAngle, limbHolds, allHolds, isOverhang]);

  const forces = useMemo(() => computeForces(physicsConfig), [physicsConfig]);
  useEffect(() => { setGripUsed(forces.gripStrengthPercentUsed); }, [forces]);

  // Reach checks — generous so puzzle is about sequence, not pixel hunting
  const canReach = useCallback((limb: Limb, hold: PlacedHold) => {
    const isHand = limb.includes("Hand");
    // Reach from current body center (average of all limbs)
    const cx = (limbPos.leftHand.x + limbPos.rightHand.x + limbPos.leftFoot.x + limbPos.rightFoot.x) / 4;
    const cy = (limbPos.leftHand.y + limbPos.rightHand.y + limbPos.leftFoot.y + limbPos.rightFoot.y) / 4;
    if (isHand) {
      const sx = cx + (limb === "leftHand" ? -0.12 : 0.12), sy = cy + 0.3;
      return Math.sqrt((hold.x - sx) ** 2 + (hold.y - sy) ** 2) <= 1.4;
    }
    const hx = cx + (limb === "leftFoot" ? -0.06 : 0.06), hy = cy - 0.1;
    return Math.sqrt((hold.x - hx) ** 2 + (hold.y - hy) ** 2) <= 1.2;
  }, [limbPos]);

  // --- Find current/next crux ---
  // Store in refs so auto-climb loop always reads fresh values
  const allHoldsRef = useRef(allHolds);
  allHoldsRef.current = allHolds;
  const pitchRef = useRef(currentPitch);
  pitchRef.current = currentPitch;
  const pitchTopYRef = useRef(pitchTopY);
  pitchTopYRef.current = pitchTopY;

  const animateLimb = useCallback((limb: Limb, toX: number, toY: number, duration: number): Promise<void> => {
    return new Promise(resolve => {
      const from = { ...limbPosRef.current[limb] };
      const startTime = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const arc = Math.sin(eased * Math.PI) * 0.06;
        const newPos = { x: from.x + (toX - from.x) * eased, y: from.y + (toY - from.y) * eased + arc };
        const update = (prev: Record<Limb, { x: number; y: number }>) => {
          const next = { ...prev, [limb]: newPos };
          limbPosRef.current = next; // keep ref in sync for auto-climb reads
          return next;
        };
        if (t < 1) {
          setLimbPos(update);
          animRef.current = requestAnimationFrame(tick);
        } else {
          const finalPos = { x: toX, y: toY };
          setLimbPos(prev => {
            const next = { ...prev, [limb]: finalPos };
            limbPosRef.current = next;
            return next;
          });
          resolve();
        }
      };
      animRef.current = requestAnimationFrame(tick);
    });
  }, []);

  const runAutoClimb = useCallback(async () => {
    if (autoClimbing || gameOver) return;
    setAutoClimbing(true);
    setPhase("auto");

    let safetyCounter = 0;
    while (safetyCounter < 300) {
      safetyCounter++;
      const lp = limbPosRef.current;
      const holds = allHoldsRef.current;
      const pitch = pitchRef.current;
      const topY = pitchTopYRef.current;

      const currentMaxY = Math.max(lp.leftHand.y, lp.rightHand.y);

      // Find next unsolved crux
      let cruxStart = topY;
      for (let i = 0; i < pitch.cruxes.length; i++) {
        if (!pitch.cruxes[i].solved && currentMaxY < pitch.cruxes[i].endY) {
          cruxStart = pitch.cruxes[i].startY;
          break;
        }
      }

      // At crux? Stop.
      if (currentMaxY >= cruxStart - 0.5) break;

      // At top? Stop.
      if (currentMaxY >= topY - 1) break;

      // Alternate hands
      const movingHand: Limb = lp.leftHand.y <= lp.rightHand.y ? "leftHand" : "rightHand";
      const movingFoot: Limb = movingHand === "leftHand" ? "leftFoot" : "rightFoot";
      const movingHandY = lp[movingHand].y;

      // Find next hold above moving hand — any non-foot hold
      const candidates = holds
        .filter(h => h.y > movingHandY + 0.05 && h.y < cruxStart && h.usage !== "foot")
        .sort((a, b) => a.y - b.y);

      if (candidates.length === 0) break;

      const target = candidates[0];

      // Find foot hold
      const footTarget = holds
        .filter(h => h.y > lp[movingFoot].y - 0.2 && h.y < target.y + 0.3 && h.usage !== "hand")
        .sort((a, b) => Math.abs(a.y - (target.y - 0.35)) - Math.abs(b.y - (target.y - 0.35)))[0];

      // Move foot first
      if (footTarget) {
        await animateLimb(movingFoot, footTarget.x, footTarget.y, 200);
      }

      // Move hand
      await animateLimb(movingHand, target.x, target.y, 300);
      setLimbHolds(prev => ({ ...prev, [movingHand]: target.id }));

      // Recovery on jugs
      setFatigue(prev => ({
        left: Math.max(0, prev.left - 2),
        right: Math.max(0, prev.right - 2),
      }));
      setMoveCount(c => c + 1);
      setScore(s => s + 5);

      // Tiny pause
      await new Promise(r => setTimeout(r, 10));
    }

    setAutoClimbing(false);

    // Determine what stopped us — read fresh values
    const lp = limbPosRef.current;
    const pitch = pitchRef.current;
    const topY = pitchTopYRef.current;
    const maxY = Math.max(lp.leftHand.y, lp.rightHand.y);

    for (let i = 0; i < pitch.cruxes.length; i++) {
      if (!pitch.cruxes[i].solved && maxY >= pitch.cruxes[i].startY - 1) {
        // Place protection before the crux
        const proY = pitch.cruxes[i].startY - 0.5;
        const protPos = towerSegmentToWorld(lp.rightHand.x, proY, allSegments);
        setProtectionPoints(prev => [...prev, [protPos.pos[0], protPos.pos[1], protPos.pos[2] + 0.03]]);
        setRopeAnchors(prev => [...prev, [protPos.pos[0], protPos.pos[1], protPos.pos[2] + 0.05]]);

        setPhase("crux");
        setActiveCruxIdx(i);
        setCruxTimer(100);
        setFatigue(prev => ({ left: Math.min(prev.left, 15), right: Math.min(prev.right, 15) }));
        showMessage("Pro placed! CRUX ahead — place each limb carefully", 3000);
        return;
      }
    }

    if (maxY >= topY - 2) {
      // Reached top — auto-complete the pitch
      setPhase("protection");
      showMessage("Topping out! Building anchor...", 2000);
      setTimeout(() => {
        completePitchRef.current();
      }, 2000);
    } else {
      setPhase("idle");
    }
  }, [autoClimbing, gameOver, animateLimb, showMessage]);

  // Auto-start climbing when idle (no button needed for easy sections)
  useEffect(() => {
    if (phase !== "idle" || gameOver || autoClimbing) return;
    const timer = setTimeout(() => {
      runAutoClimb();
    }, 500);
    return () => clearTimeout(timer);
  }, [phase, gameOver, autoClimbing, runAutoClimb]);

  // --- Crux timer: fatigue based on body position quality ---
  useEffect(() => {
    if (phase !== "crux" || gameOver) return;
    const interval = setInterval(() => {
      setCruxTimer(prev => {
        const next = Math.max(0, prev - 0.2); // ~50 seconds before timeout
        if (next <= 0) { triggerFall(); }
        return next;
      });

      // Position quality affects pump rate
      const lp = limbPosRef.current;
      const feetMidY = (lp.leftFoot.y + lp.rightFoot.y) / 2;
      const handsMidY = (lp.leftHand.y + lp.rightHand.y) / 2;
      const feetMidX = (lp.leftFoot.x + lp.rightFoot.x) / 2;
      const handsMidX = (lp.leftHand.x + lp.rightHand.x) / 2;

      // Penalties only kick in for really bad positions
      const extension = Math.max(0, (handsMidY - feetMidY) - 1.0) * 0.5;
      const lean = Math.max(0, Math.abs(handsMidX - feetMidX) - 0.3) * 0.4;

      const positionPenalty = extension + lean;
      const baseFatigue = isOverhang ? 0.15 : 0.06;
      const totalFatigue = baseFatigue + positionPenalty;

      setFatigue(prev => ({
        left: Math.min(100, prev.left + totalFatigue),
        right: Math.min(100, prev.right + totalFatigue),
      }));
    }, 100);
    return () => clearInterval(interval);
  }, [phase, gameOver, isOverhang, triggerFall]);

  // Check fatigue/grip failure — only during crux
  useEffect(() => {
    if (gameOver || falling || phase !== "crux") return;
    if (fatigue.left >= 100 || fatigue.right >= 100) {
      triggerFall();
    }
  }, [fatigue, gameOver, falling, phase, triggerFall]);

  // --- Crux: handle limb click ---
  const handleLimbClick = useCallback((limb: Limb) => {
    if (phase !== "crux" || gameOver) return;
    setSelectedLimb(prev => prev === limb ? null : limb);
  }, [phase, gameOver]);

  // --- Crux: handle hold click ---
  const handleHoldClick = useCallback((holdId: string) => {
    if (phase !== "crux" || gameOver) return;

    // If no limb selected and clicking a hold a limb is on, select that limb
    if (!selectedLimb) {
      for (const [limb, hid] of Object.entries(limbHolds)) {
        if (hid === holdId) {
          setSelectedLimb(limb as Limb);
          return;
        }
      }
      return;
    }
    const hold = allHolds.find(h => h.id === holdId);
    if (!hold) return;
    if (!canReach(selectedLimb, hold)) return;

    const isHand = selectedLimb.includes("Hand");
    if (isHand && hold.usage === "foot") return;
    if (!isHand && hold.usage === "hand") return;

    // Animate
    const from = { ...limbPos[selectedLimb] };
    const startTime = performance.now();
    const limb = selectedLimb;
    const animate = (now: number) => {
      const t = Math.min(1, (now - startTime) / 250);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const arc = Math.sin(eased * Math.PI) * 0.07;
      setLimbPos(prev => ({ ...prev, [limb]: { x: from.x + (hold.x - from.x) * eased, y: from.y + (hold.y - from.y) * eased + arc } }));
      if (t < 1) requestAnimationFrame(animate);
      else setLimbPos(prev => ({ ...prev, [limb]: { x: hold.x, y: hold.y } }));
    };
    requestAnimationFrame(animate);

    setLimbHolds(prev => ({ ...prev, [limb]: holdId }));

    // Fatigue cost — reaches near max range are riskier
    if (isHand) {
      const cx = (limbPos.leftHand.x + limbPos.rightHand.x + limbPos.leftFoot.x + limbPos.rightFoot.x) / 4;
      const cy = (limbPos.leftHand.y + limbPos.rightHand.y + limbPos.leftFoot.y + limbPos.rightFoot.y) / 4;
      const sx = cx + (limb === "leftHand" ? -0.12 : 0.12), sy = cy + 0.3;
      const dist = Math.sqrt((hold.x - sx) ** 2 + (hold.y - sy) ** 2);
      const reachFraction = dist / 1.4; // 0..1, where 1 = max reach

      const baseCost = HOLD_DIFFICULTY[hold.type] || 3;
      // Reaching far adds extra fatigue (up to 2x at max reach)
      const reachPenalty = reachFraction > 0.7 ? (reachFraction - 0.7) * 20 : 0;
      const cost = baseCost + reachPenalty;
      const steepBonus = Math.max(0, wallAngle) * 0.05;
      const side = limb === "leftHand" ? "left" : "right";
      const other = side === "left" ? "right" : "left";
      setFatigue(prev => ({
        [side]: Math.min(100, prev[side] + cost + steepBonus),
        [other]: Math.max(0, prev[other] - 8), // resting arm recovers well
      } as { left: number; right: number }));

      // Chance of slipping on max-reach holds — higher fatigue = more likely
      if (reachFraction > 0.8) {
        const armFatigue = limb === "leftHand" ? fatigue.left : fatigue.right;
        const slipChance = (reachFraction - 0.8) * 2 * (armFatigue / 100); // 0-40% at absolute max
        if (Math.random() < slipChance) {
          showMessage("SLIPPED! Couldn't hold the reach!", 2000);
          triggerFall();
          return;
        }
      }
    }

    setMoveCount(c => c + 1);
    setScore(s => s + 15 + Math.round(cruxTimer * 0.2));
    setCruxTimer(Math.min(100, cruxTimer + 8)); // small time bonus per move
    setSelectedLimb(null);

    // Check if crux is solved (climber passed the end)
    if (activeCruxIdx >= 0) {
      const crux = currentPitch.cruxes[activeCruxIdx];
      const newHighest = Math.max(hold.y, limbPosRef.current.leftHand.y, limbPosRef.current.rightHand.y);
      if (newHighest >= crux.endY - 0.5) {
        // Crux solved! Place protection
        setPitches(prev => {
          const updated = [...prev];
          const p = { ...updated[currentPitchIdx] };
          const cruxes = [...p.cruxes];
          cruxes[activeCruxIdx] = { ...cruxes[activeCruxIdx], solved: true };
          p.cruxes = cruxes;
          updated[currentPitchIdx] = p;
          return updated;
        });

        setPhase("protection");
        showMessage("CRUX SENT! Placing protection...", 2500);

        // Place protection (cam)
        const protPos = towerSegmentToWorld(hold.x, hold.y, allSegments);
        setProtectionPoints(prev => [...prev, [protPos.pos[0], protPos.pos[1], protPos.pos[2] + 0.03]]);

        // Add rope anchor at protection
        setRopeAnchors(prev => [...prev, [protPos.pos[0], protPos.pos[1], protPos.pos[2] + 0.05]]);

        // Fatigue recovery at rest
        setFatigue(prev => ({
          left: Math.max(0, prev.left - 20),
          right: Math.max(0, prev.right - 20),
        }));

        setScore(s => s + 100);

        // Stop and let user press "Climb Up" to continue
        setTimeout(() => {
          setPhase("idle");
          setActiveCruxIdx(-1);
        }, 2500);
      }
    }
  }, [phase, selectedLimb, gameOver, allHolds, canReach, limbPos, limbHolds, wallAngle, allSegments, cruxTimer, activeCruxIdx, currentPitch, currentPitchIdx, showMessage, fatigue, triggerFall]);

  // Muscle Through — skip crux at a heavy stamina cost
  const muscleThrough = useCallback(() => {
    if (phase !== "crux" || gameOver || activeCruxIdx < 0) return;
    const crux = currentPitch.cruxes[activeCruxIdx];

    // Mark crux as solved
    setPitches(prev => {
      const updated = [...prev];
      const p = { ...updated[currentPitchIdx] };
      const cruxes = [...p.cruxes];
      cruxes[activeCruxIdx] = { ...cruxes[activeCruxIdx], solved: true };
      p.cruxes = cruxes;
      updated[currentPitchIdx] = p;
      return updated;
    });

    // Move climber to top of crux
    setLimbPos({
      leftHand: { x: -0.15, y: crux.endY - 0.2 },
      rightHand: { x: 0.15, y: crux.endY },
      leftFoot: { x: -0.15, y: crux.endY - 0.8 },
      rightFoot: { x: 0.15, y: crux.endY - 0.6 },
    });

    // Heavy cost — halve stamina timer, spike fatigue
    setCruxTimer(prev => prev * 0.5);
    setFatigue(prev => ({
      left: Math.min(95, prev.left + 35),
      right: Math.min(95, prev.right + 35),
    }));

    // Place protection
    const protPos = towerSegmentToWorld(0, crux.endY, allSegments);
    setProtectionPoints(prev => [...prev, [protPos.pos[0], protPos.pos[1], protPos.pos[2] + 0.03]]);
    setRopeAnchors(prev => [...prev, [protPos.pos[0], protPos.pos[1], protPos.pos[2] + 0.05]]);

    setPhase("protection");
    showMessage("MUSCLED THROUGH! Exhausted...", 2500);
    setTimeout(() => {
      setPhase("idle");
      setActiveCruxIdx(-1);
    }, 2500);
  }, [phase, gameOver, activeCruxIdx, currentPitch, currentPitchIdx, allSegments, showMessage]);

  // Pitch completion — follower climbs up fast, then next pitch starts
  const completePitch = useCallback(() => {
    const bonus = Math.round((100 - fatigue.left) + (100 - fatigue.right) + 200);
    setScore(s => s + bonus);
    setPitches(prev => {
      const updated = [...prev];
      updated[currentPitchIdx] = { ...updated[currentPitchIdx], completed: true };
      updated.push(generatePitch(currentPitchIdx + 2, pitchTopY));
      return updated;
    });
    const ap = towerSegmentToWorld(0, pitchTopY - 0.5, allSegments);
    setRopeAnchors(prev => [...prev, [ap.pos[0], ap.pos[1], ap.pos[2] + 0.05]]);
    setProtectionPoints(prev => [...prev, [ap.pos[0], ap.pos[1], ap.pos[2] + 0.03]]);
    setFatigue(prev => ({ left: Math.max(0, prev.left - 30), right: Math.max(0, prev.right - 30) }));

    // Start follower climbing animation
    setPhase("following");
    setFollowerProgress(0);
    showMessage("Pitch complete! Follower climbing up...", 4000);

    let frame = 0;
    const totalFrames = 90; // ~1.5 seconds at 60fps
    const followAnim = () => {
      frame++;
      const t = Math.min(1, frame / totalFrames);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      setFollowerProgress(eased);
      if (frame < totalFrames) {
        requestAnimationFrame(followAnim);
      } else {
        // Follower arrived — transition to next pitch
        setFollowerProgress(0);
        setCurrentPitchIdx(i => i + 1);
        setRopeAnchors([]);
        setProtectionPoints([]);
        setPhase("idle");
        showMessage("Follower at anchor. Lead on!", 2000);
      }
    };
    requestAnimationFrame(followAnim);
  }, [currentPitchIdx, pitchTopY, allSegments, fatigue, showMessage]);
  completePitchRef.current = completePitch;

  // Reset
  const resetGame = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setPitches([generatePitch(1, 0)]); setCurrentPitchIdx(0);
    setLimbPos({ leftHand: { x: -0.2, y: 0.6 }, rightHand: { x: 0.2, y: 0.8 }, leftFoot: { x: -0.2, y: 0.15 }, rightFoot: { x: 0.2, y: 0.2 } });
    setLimbHolds({ leftHand: null, rightHand: null, leftFoot: null, rightFoot: null });
    setFatigue({ left: 0, right: 0 }); setGripUsed(0); setScore(0); setMoveCount(0);
    setPhase("idle"); setSelectedLimb(null); setGameOver(false); setFell(false);
    setRopeAnchors([]); setProtectionPoints([]); setCruxTimer(100); setActiveCruxIdx(-1);
    setAutoClimbing(false); setFollowerProgress(0); setMessage(null); setFalling(false); setFallOffset(0);
  }, []);

  // World positions
  const climberWorldInfo = useMemo(() => {
    const avgY = (limbPos.leftHand.y + limbPos.rightHand.y + limbPos.leftFoot.y + limbPos.rightFoot.y) / 4;
    const w = towerSegmentToWorld(0, avgY, allSegments);
    const angleRad = (w.angleDeg * Math.PI) / 180;
    // Wall normal points outward: for angle 0 (vertical) normal is (0,0,1)
    // For overhang (positive angle) normal tilts down: (0, -sin, cos)
    return {
      worldY: w.pos[1] - fallOffset,
      normalZ: Math.cos(angleRad),
      normalY: -Math.sin(angleRad),
    };
  }, [limbPos, allSegments, fallOffset]);
  const climberWorldY = climberWorldInfo.worldY;

  const climberHarnessPos = useMemo((): [number, number, number] => {
    const w = towerSegmentToWorld((limbPos.leftFoot.x + limbPos.rightFoot.x) / 2, (limbPos.leftFoot.y + limbPos.rightFoot.y) / 2 + 0.35, allSegments);
    return [w.pos[0], w.pos[1] - fallOffset, w.pos[2] + 0.15];
  }, [limbPos, allSegments, fallOffset]);

  const belayerPos = useMemo((): [number, number, number] => {
    const basePos = (): [number, number, number] => {
      if (currentPitchIdx === 0) return [0.8, 0, 1.8];
      const w = towerSegmentToWorld(0.3, pitchBaseY, allSegments);
      return [w.pos[0] + 0.8, w.pos[1], w.pos[2] + 1.2];
    };
    const base = basePos();
    if (phase === "following" && followerProgress > 0) {
      // Follower climbs from base to the top of the current pitch
      const topW = towerSegmentToWorld(0.3, pitchTopY - 0.5, allSegments);
      const top: [number, number, number] = [topW.pos[0] + 0.8, topW.pos[1], topW.pos[2] + 1.2];
      return [
        base[0] + (top[0] - base[0]) * followerProgress,
        base[1] + (top[1] - base[1]) * followerProgress,
        base[2] + (top[2] - base[2]) * followerProgress,
      ];
    }
    return base;
  }, [currentPitchIdx, pitchBaseY, pitchTopY, allSegments, phase, followerProgress]);

  // Reachable holds (only during crux)
  const { reachableHoldIds, reachFractionMap } = useMemo(() => {
    if (phase !== "crux" || !selectedLimb) return { reachableHoldIds: new Set<string>(), reachFractionMap: new Map<string, number>() };
    const ids = new Set<string>();
    const fracs = new Map<string, number>();
    const isHand = selectedLimb.includes("Hand");
    const cx = (limbPos.leftHand.x + limbPos.rightHand.x + limbPos.leftFoot.x + limbPos.rightFoot.x) / 4;
    const cy = (limbPos.leftHand.y + limbPos.rightHand.y + limbPos.leftFoot.y + limbPos.rightFoot.y) / 4;
    const maxReach = isHand ? 1.4 : 1.2;
    const ox = cx + (isHand ? (selectedLimb === "leftHand" ? -0.12 : 0.12) : (selectedLimb === "leftFoot" ? -0.06 : 0.06));
    const oy = cy + (isHand ? 0.3 : -0.1);
    for (const h of allHolds) {
      if (isHand && h.usage === "foot") continue;
      if (!isHand && h.usage === "hand") continue;
      if (canReach(selectedLimb, h)) {
        ids.add(h.id);
        const dist = Math.sqrt((h.x - ox) ** 2 + (h.y - oy) ** 2);
        fracs.set(h.id, dist / maxReach);
      }
    }
    return { reachableHoldIds: ids, reachFractionMap: fracs };
  }, [phase, selectedLimb, allHolds, canReach, limbPos]);

  const assignedHoldIds = useMemo(() => {
    const s = new Set<string>(); for (const v of Object.values(limbHolds)) if (v) s.add(v); return s;
  }, [limbHolds]);

  // Current crux hold ids
  const cruxHoldIds = useMemo(() => {
    if (activeCruxIdx < 0) return new Set<string>();
    return new Set(currentPitch.cruxes[activeCruxIdx]?.holds.map(h => h.id) ?? []);
  }, [activeCruxIdx, currentPitch.cruxes]);

  const pill: React.CSSProperties = {
    padding: "7px 10px", borderRadius: 8, border: "none", cursor: "pointer",
    fontSize: 12, fontFamily: "system-ui, -apple-system, sans-serif", fontWeight: 600,
    touchAction: "manipulation", color: "#fff", minHeight: 36, minWidth: 36,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
  };

  const timerColor = cruxTimer > 60 ? "#44cc66" : cruxTimer > 30 ? "#ffaa00" : "#ff3333";
  const gripColor = gripUsed > 90 ? "#ff3333" : gripUsed > 60 ? "#ffaa00" : "#44cc66";

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* 3D Scene */}
      <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}>
        <Canvas camera={{ position: [4, climberWorldY + 2, 8], fov: 50 }} style={{ background: "#2a1a0a" }}>
          <Sky sunPosition={[80, 30, -60]} turbidity={10} rayleigh={2} mieCoefficient={0.01} mieDirectionalG={0.95} />
          <mesh position={[80, 30, -60]}><sphereGeometry args={[4, 16, 16]} /><meshBasicMaterial color="#ffddaa" /></mesh>
          <ambientLight intensity={0.5} color="#ffeedd" />
          <directionalLight position={[80, 30, -60]} intensity={1.0} color="#ffccaa" castShadow />
          <pointLight position={[-3, 5, 4]} intensity={0.2} color="#ffddcc" />
          <fog attach="fog" args={["#c4956a", 25, 80]} />

          <DesertFloor /><SandstoneFormations /><SandstoneArches /><DesertPlants /><DesertBirds />
          <SandstoneWall segments={allSegments} />

          {allHolds.map(hold => (
            <HoldMesh key={hold.id} hold={hold} segments={allSegments}
              onClick={() => handleHoldClick(hold.id)}
              isAssigned={assignedHoldIds.has(hold.id)}
              isReachable={reachableHoldIds.has(hold.id)}
              pulseHighlight={reachableHoldIds.has(hold.id) && !!selectedLimb}
              isCrux={cruxHoldIds.has(hold.id)}
              reachFraction={reachFractionMap.get(hold.id)} />
          ))}

          <MPClimber limbPositions={limbPos} segments={allSegments}
            selectedLimb={selectedLimb} onLimbClick={handleLimbClick}
            fatigue={fatigue} phase={phase} />

          <Belayer position={belayerPos} />
          <Rope climberPos={climberHarnessPos}
            belayerPos={[belayerPos[0], belayerPos[1] + 1.1, belayerPos[2] - 0.1]}
            anchors={ropeAnchors} />

          {/* Protection pieces */}
          {protectionPoints.map((p, i) => <ProtectionPiece key={i} position={p} />)}

          {/* Crux zone markers */}
          {currentPitch.cruxes.map((crux, i) => (
            <CruxZone key={i} startY={crux.startY} endY={crux.endY} segments={allSegments}
              active={i === activeCruxIdx} solved={crux.solved} />
          ))}

          {/* Pitch markers */}
          {pitches.map((p, i) => {
            let my = 0; for (let j = 0; j < i; j++) my += pitches[j].heightMeters;
            const w = towerSegmentToWorld(-1.8, my + 1, allSegments);
            return <Text key={i} position={[w.pos[0], w.pos[1], w.pos[2] + 0.1]} fontSize={0.35}
              color={i === currentPitchIdx ? "#ffcc00" : p.completed ? "#44cc66" : "#666"} anchorX="center">{`P${p.pitchNumber}`}</Text>;
          })}

          <FollowCamera targetY={climberWorldY} phase={phase}
            wallNormalZ={climberWorldInfo.normalZ} wallNormalY={climberWorldInfo.normalY} />
        </Canvas>
      </div>

      {/* === HUD === */}

      {/* Top bar */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 20, display: "flex", justifyContent: "center", padding: "8px 12px", pointerEvents: "none" }}>
        <div style={{ background: "rgba(0,0,0,0.85)", padding: "8px 14px", borderRadius: 10, backdropFilter: "blur(8px)", display: "flex", gap: 16, alignItems: "center", fontSize: 13, fontWeight: 600 }}>
          <span style={{ color: "#ffcc00" }}>P{currentPitch.pitchNumber}</span>
          <span style={{ color: "#aaa" }}>{Math.round(currentPitch.heightMeters)}m</span>
          <span style={{ color: "#fff" }}>Score: {score}</span>
          <span style={{ color: phase === "crux" ? "#ff4400" : phase === "auto" ? "#44cc66" : phase === "protection" ? "#ffcc00" : phase === "following" ? "#44aaff" : "#888" }}>
            {phase === "crux" ? "CRUX" : phase === "auto" ? "CLIMBING" : phase === "protection" ? "PLACING PRO" : phase === "following" ? "FOLLOWER" : "READY"}
          </span>
        </div>
      </div>

      {/* Message banner — subtle, at bottom, doesn't block view */}
      {message && (
        <div style={{ position: "absolute", bottom: 90, left: "50%", transform: "translateX(-50%)", zIndex: 30,
          background: "rgba(0,0,0,0.6)", color: "#ffcc00", padding: "6px 16px", borderRadius: 8,
          fontSize: 13, fontWeight: 600, textAlign: "center", backdropFilter: "blur(6px)",
          letterSpacing: 1, pointerEvents: "none", whiteSpace: "nowrap" }}>
          {message}
        </div>
      )}

      {/* Crux timer (only during crux) */}
      {phase === "crux" && (
        <div style={{ position: "absolute", top: 44, left: "50%", transform: "translateX(-50%)", width: 240, zIndex: 20, pointerEvents: "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#999", marginBottom: 2 }}>
            <span>Stamina</span>
            <span style={{ color: timerColor }}>{Math.round(cruxTimer)}%</span>
          </div>
          <div style={{ height: 8, background: "rgba(0,0,0,0.6)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${cruxTimer}%`, height: "100%", background: timerColor, borderRadius: 4, transition: "width 0.1s linear" }} />
          </div>
        </div>
      )}

      {/* Hand fatigue bars — always visible */}
      <div style={{ position: "absolute", top: phase === "crux" ? 68 : 44, left: "50%", transform: "translateX(-50%)", width: 240, zIndex: 20, pointerEvents: "none" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#aaa", marginBottom: 1 }}>
              <span>L Hand</span>
              <span style={{ color: fatigue.left > 70 ? "#ff4444" : fatigue.left > 40 ? "#ffaa22" : "#66cc66" }}>{Math.round(fatigue.left)}%</span>
            </div>
            <div style={{ height: 5, background: "rgba(0,0,0,0.6)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${fatigue.left}%`, height: "100%", borderRadius: 3, transition: "width 0.2s",
                background: fatigue.left > 70 ? "#ff4444" : fatigue.left > 40 ? "#ffaa22" : "#66cc66" }} />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#aaa", marginBottom: 1 }}>
              <span>R Hand</span>
              <span style={{ color: fatigue.right > 70 ? "#ff4444" : fatigue.right > 40 ? "#ffaa22" : "#66cc66" }}>{Math.round(fatigue.right)}%</span>
            </div>
            <div style={{ height: 5, background: "rgba(0,0,0,0.6)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${fatigue.right}%`, height: "100%", borderRadius: 3, transition: "width 0.2s",
                background: fatigue.right > 70 ? "#ff4444" : fatigue.right > 40 ? "#ffaa22" : "#66cc66" }} />
            </div>
          </div>
        </div>
      </div>

      {/* Right side meters */}
      <div style={{ position: "absolute", top: 80, right: 12, zIndex: 20, width: 110, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ background: "rgba(0,0,0,0.8)", padding: "5px 8px", borderRadius: 7, backdropFilter: "blur(8px)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#999", marginBottom: 2 }}>
            <span>Grip</span><span style={{ color: gripColor }}>{Math.round(gripUsed)}%</span>
          </div>
          <div style={{ height: 5, background: "#333", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, gripUsed)}%`, height: "100%", background: gripColor, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        </div>
        <div style={{ background: "rgba(0,0,0,0.8)", padding: "5px 8px", borderRadius: 7, backdropFilter: "blur(8px)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#999", marginBottom: 2 }}>
            <span>Pitch</span><span style={{ color: "#88ccff" }}>{Math.round(pitchProgress)}%</span>
          </div>
          <div style={{ height: 4, background: "#333", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${pitchProgress}%`, height: "100%", background: "#4488ff", borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        </div>
      </div>

      {/* Crux instruction — always visible during crux */}
      {phase === "crux" && !gameOver && (
        <div style={{ position: "absolute", top: 96, left: "50%", transform: "translateX(-50%)", zIndex: 20,
          background: "rgba(0,0,0,0.9)", color: selectedLimb ? "#88ff44" : "#ff8844",
          padding: "8px 18px", borderRadius: 10, maxWidth: 320, textAlign: "center",
          fontSize: 14, fontWeight: 700, backdropFilter: "blur(8px)",
          border: `1px solid ${selectedLimb ? "#88ff44" : "#ff8844"}`,
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)", pointerEvents: "none" }}>
          {!selectedLimb
            ? <>1. Click a limb label <span style={{ color: "#ff6644" }}>LH</span> <span style={{ color: "#44aaff" }}>RH</span> <span style={{ color: "#ff9944" }}>LF</span> <span style={{ color: "#44ccaa" }}>RF</span></>
            : <>2. Now click a <span style={{ color: "#88ff44" }}>glowing hold</span> to move there</>
          }
        </div>
      )}


      {/* Game over */}
      {gameOver && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 50,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}>
          <div style={{ background: "rgba(30,20,10,0.95)", borderRadius: 16, padding: "32px 40px",
            textAlign: "center", maxWidth: 340, border: "2px solid #cc6633" }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: fell ? "#ff4444" : "#ffcc00", marginBottom: 8 }}>
              {fell ? "FALL!" : "SENT!"}
            </div>
            <div style={{ color: "#ccc", fontSize: 14, marginBottom: 16 }}>
              {fell ? (gripUsed > 100 ? "Grip strength exceeded" : fatigue.left >= 100 || fatigue.right >= 100 ? "Too pumped!" : "Ran out of stamina!") : "Clean send!"}
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: 20, marginBottom: 20, color: "#fff", fontSize: 16 }}>
              <div><div style={{ fontSize: 11, color: "#999" }}>Score</div>{score}</div>
              <div><div style={{ fontSize: 11, color: "#999" }}>Moves</div>{moveCount}</div>
              <div><div style={{ fontSize: 11, color: "#999" }}>Pitches</div>{pitches.filter(p => p.completed).length}</div>
              <div><div style={{ fontSize: 11, color: "#999" }}>Height</div>{Math.round(highestLimb)}m</div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={resetGame} style={{ ...pill, background: "#cc6633", padding: "10px 20px", fontSize: 14 }}>Climb Again</button>
              <button onClick={onBack} style={{ ...pill, background: "#555", padding: "10px 20px", fontSize: 14 }}>Back</button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 20, background: "rgba(20,15,10,0.95)",
        borderTop: "1px solid #554433", backdropFilter: "blur(12px)",
        padding: "8px 10px calc(44px + env(safe-area-inset-bottom, 0px))", display: "flex", justifyContent: "center" }}>
        <div style={{ display: "flex", gap: 8, maxWidth: 520, width: "100%", justifyContent: "center" }}>
          <button onClick={onBack} style={{ ...pill, background: "#555", flex: 1, maxWidth: 90 }}>&larr; Menu</button>
          {phase === "idle" && !gameOver && (
            <div style={{ ...pill, background: "rgba(34,68,136,0.8)", flex: 1, maxWidth: 160, fontSize: 13 }}>
              Starting...
            </div>
          )}
          {phase === "auto" && (
            <div style={{ ...pill, background: "rgba(34,102,34,0.8)", flex: 1, maxWidth: 160, fontSize: 13 }}>
              Auto-climbing...
            </div>
          )}
          {phase === "crux" && (
            <button onClick={muscleThrough} style={{ ...pill, background: "#993300", flex: 1, maxWidth: 180, fontSize: 13,
              border: "1px solid #cc6600", cursor: "pointer" }}>
              &#128170; Muscle Through
            </button>
          )}
          {phase === "protection" && (
            <div style={{ ...pill, background: "rgba(180,140,0,0.8)", flex: 1, maxWidth: 160, fontSize: 13 }}>
              Placing gear...
            </div>
          )}
          <div style={{ ...pill, background: "rgba(40,30,20,0.9)", flex: 1, maxWidth: 200, fontSize: 10, color: "#ccc" }}>
            {pitches.filter(p => p.completed).length} pitches &middot; {Math.round(pitches.filter(p => p.completed).reduce((s, p) => s + p.heightMeters, 0))}m
          </div>
          <button onClick={resetGame} style={{ ...pill, background: "#993322", flex: 1, maxWidth: 80 }}>Reset</button>
        </div>
      </div>
    </div>
  );
}
