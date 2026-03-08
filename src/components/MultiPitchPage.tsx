import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line, Text, Html, useTexture } from "@react-three/drei";
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

function v3add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function v3sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function v3scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function v3len(a: V3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}
function v3normalize(a: V3): V3 {
  const l = v3len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function v3cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function v3dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function clampToReach(origin: V3, target: V3, maxReach: number): V3 {
  const toTarget = v3sub(target, origin);
  const dist = v3len(toTarget);
  if (dist <= maxReach) return target;
  return v3add(origin, v3scale(v3normalize(toTarget), maxReach));
}

function solveIK2Bone(
  origin: V3,
  target: V3,
  lenUpper: number,
  lenLower: number,
  bendDir: V3,
): V3 {
  const toTarget = v3sub(target, origin);
  const dist = v3len(toTarget);
  const totalLen = lenUpper + lenLower;
  if (dist >= totalLen * 0.999)
    return v3add(origin, v3scale(v3normalize(toTarget), lenUpper));
  if (dist < Math.abs(lenUpper - lenLower) + 0.001)
    return v3add(origin, v3scale(v3normalize(bendDir), lenUpper * 0.5));
  const cosAngle =
    (lenUpper * lenUpper + dist * dist - lenLower * lenLower) /
    (2 * lenUpper * dist);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  const forward = v3normalize(toTarget);
  const bendAlongFwd = v3dot(bendDir, forward);
  let up = v3sub(bendDir, v3scale(forward, bendAlongFwd));
  if (v3len(up) < 0.001) {
    up = v3cross(forward, [1, 0, 0]);
    if (v3len(up) < 0.001) up = v3cross(forward, [0, 1, 0]);
  }
  up = v3normalize(up);
  const jointDir = v3add(
    v3scale(forward, Math.cos(angle)),
    v3scale(up, Math.sin(angle)),
  );
  return v3add(origin, v3scale(jointDir, lenUpper));
}

function MPJoint({
  position,
  size = 0.025,
  color = "#ddccbb",
}: {
  position: V3;
  size?: number;
  color?: string;
}) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[size, 10, 10]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
}

function MPLimb({
  from,
  to,
  color = "#cc9977",
  width = 2,
}: {
  from: V3;
  to: V3;
  color?: string;
  width?: number;
}) {
  return <Line points={[from, to]} color={color} lineWidth={width} />;
}

type CruxShape = "split" | "straight" | "zigzag" | "overhang";

// YDS grade system
// Number grade (5.10-5.14) based on wall angle: slab/vert=5.10, slight overhang=5.11, steep=5.12, roof=5.13-14
// Letter grade (a-d) based on progression within the game — each letter = higher multiplier
// a=1x, b=2x, c=3x, d=4x points
const GRADE_LETTERS = ["a", "b", "c", "d"] as const;
const LETTER_MULTIPLIER: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };

function angleToNumberGrade(angleDeg: number): string {
  if (angleDeg < 5) return "5.10"; // slab / vertical
  if (angleDeg < 15) return "5.11"; // slight overhang
  if (angleDeg < 25) return "5.12"; // overhang
  if (angleDeg < 35) return "5.13"; // steep overhang
  return "5.14"; // roof
}

function diffToLetterIdx(diff: number): number {
  return Math.max(0, Math.min(3, Math.floor(diff)));
}

function makeGrade(angleDeg: number, letterIdx: number): string {
  return `${angleToNumberGrade(angleDeg)}${GRADE_LETTERS[Math.max(0, Math.min(3, letterIdx))]}`;
}

function gradeMultiplier(grade: string): number {
  const letter = grade.slice(-1);
  return LETTER_MULTIPLIER[letter] ?? 1;
}

type PowerUpType = "gummy" | "weed" | "beer" | "chalk";
interface PowerUp {
  id: string;
  x: number;
  y: number;
  type: PowerUpType;
  collected: boolean;
}

const POWERUP_INFO: Record<
  PowerUpType,
  { label: string; emoji: string; fatReduction: number; color: string }
> = {
  gummy: {
    label: "Gummy Worms",
    emoji: "🐛",
    fatReduction: 15,
    color: "#ff6699",
  },
  weed: {
    label: "Send Smoke",
    emoji: "🌿",
    fatReduction: 25,
    color: "#44bb44",
  },
  beer: {
    label: "Summit Beer",
    emoji: "🍺",
    fatReduction: 20,
    color: "#ddaa33",
  },
  chalk: { label: "Chalk Up", emoji: "🤍", fatReduction: 18, color: "#ffffff" },
};

interface CruxSequence {
  startY: number;
  endY: number;
  holds: PlacedHold[];
  solved: boolean;
  shape: CruxShape;
  hardSide?: "left" | "right";
  grade: string;
  difficulty: number;
  hardGrade?: string;
  easyGrade?: string;
  powerUps: PowerUp[];
}

interface PitchData {
  pitchNumber: number;
  heightMeters: number;
  segments: WallSegment[];
  holds: PlacedHold[];
  cruxes: CruxSequence[];
  completed: boolean;
  isTraversal?: boolean;
  traversalDir?: "left" | "right";
  xOffset: number; // cumulative horizontal offset from traversals
}

// ---------- seeded RNG ----------
function seededRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const HOLD_DIFFICULTY: Record<string, number> = {
  jug: 2,
  crimp: 8,
  sloper: 7,
  pinch: 8,
  pocket: 6,
  volume: 2,
  "foot-chip": 0,
  "foot-edge": 0,
  "smear-pad": 0,
};

// ---------- pitch generation ----------
function generatePitch(pitchNumber: number, baseY: number): PitchData {
  const rand = seededRng(pitchNumber * 7919 + 42);
  // 20% chance of a short, crux-heavy pitch (back-to-back cruxes, ~20m)
  const isShortCruxPitch = rand() < 0.2;
  const heightMeters = isShortCruxPitch ? 18 + rand() * 4 : 30 + rand() * 10;
  const baseAngle = -5 + rand() * 25;
  const numSeg = 1 + Math.floor(rand() * 3);
  const segments: WallSegment[] = [];
  let rem = heightMeters;
  for (let i = 0; i < numSeg; i++) {
    const h = i === numSeg - 1 ? rem : rem * (0.25 + rand() * 0.45);
    rem -= h;
    segments.push({
      height: h,
      angleDeg: Math.round(baseAngle + (rand() - 0.5) * 18),
    });
  }

  const holds: PlacedHold[] = [];
  const cruxes: CruxSequence[] = [];

  // Generate holds in sections: jug ladder (easy) then crux (hard)
  const numCruxes = isShortCruxPitch
    ? 2
    : 1 + Math.floor(rand() * 2 + pitchNumber * 0.3);
  // Crux sections are short and intense — only 2-3m tall
  const cruxHeight = 2 + rand() * 1.5;
  const totalCruxHeight = numCruxes * cruxHeight;
  // Short crux pitches: cruxes back-to-back (no easy section between them)
  const startWithCrux = isShortCruxPitch ? true : rand() < 0.3;
  const numEasySections = isShortCruxPitch
    ? 1
    : startWithCrux
      ? numCruxes
      : numCruxes + 1;
  const easyHeight =
    (heightMeters - totalCruxHeight) / Math.max(1, numEasySections);
  const sectionHeight = 0; // unused, computed per-section below

  let currentY = baseY;
  void sectionHeight; // computed per-section
  // Short crux pitch layout: [easy, crux, crux] — back-to-back cruxes
  // Normal layout: alternating easy/crux sections
  const totalSections = isShortCruxPitch
    ? 3
    : startWithCrux
      ? numCruxes * 2
      : numCruxes * 2 + 1;
  for (let section = 0; section < totalSections; section++) {
    const isCrux = isShortCruxPitch
      ? section >= 1
      : startWithCrux
        ? section % 2 === 0
        : section % 2 === 1;
    const secHeight = isCrux ? cruxHeight : easyHeight;
    const sectionEnd = currentY + secHeight;

    if (isCrux) {
      const cruxHolds: PlacedHold[] = [];
      // Find wall angle at this crux height to determine number grade (5.10-5.14)
      let cruxAngle = 0;
      let accH = 0;
      for (const seg of segments) {
        if (accH + seg.height > currentY) {
          cruxAngle = seg.angleDeg;
          break;
        }
        accH += seg.height;
      }
      // Letter grade (a-d) scales with pitch number + crux index
      const cruxIdx = Math.floor(section / 2);
      const letterIdx = diffToLetterIdx(
        (pitchNumber - 1) * 0.8 + cruxIdx * 0.5 + rand() * 1.2,
      );
      const grade = makeGrade(cruxAngle, letterIdx);

      const dirs: HoldDirection[] = [
        "up",
        "left",
        "right",
        "up-left",
        "up-right",
      ];
      // More moves at higher letter grades
      const maxStep = Math.max(0.35, 0.6 - letterIdx * 0.05);
      const numMoves = Math.max(3, Math.ceil(secHeight / maxStep));
      const stepH = secHeight / numMoves;

      // Pick a crux shape: split, straight, zigzag, overhang
      const cruxTypes = ["split", "straight", "zigzag", "overhang"] as const;
      const cruxType = cruxTypes[Math.floor(rand() * cruxTypes.length)];

      // Hold types scale with letter grade (a=easiest, d=hardest) and wall angle
      const isOverhangCrux = cruxAngle > 10;
      const hardTypes: HoldType[] =
        letterIdx <= 0
          ? ["crimp", "pinch", "pocket", "crimp"] // a: crimps/pinches
          : letterIdx <= 1
            ? ["crimp", "sloper", "pinch", "pocket", "sloper"] // b: add slopers
            : letterIdx <= 2
              ? isOverhangCrux
                ? ["sloper", "sloper", "pinch", "pocket"]
                : ["sloper", "crimp", "sloper", "pinch", "pocket"] // c
              : ["sloper", "sloper", "crimp", "sloper", "pocket"]; // d: sloper heavy
      const easyTypes: HoldType[] =
        letterIdx <= 1
          ? ["jug", "jug", "jug", "pinch", "crimp"]
          : ["jug", "jug", "pinch", "crimp", "pocket"];

      const addHold = (h: PlacedHold) => {
        cruxHolds.push(h);
        holds.push(h);
      };
      const addFoot = (x: number, y: number) => {
        addHold({
          id: makeHoldId(),
          x,
          y,
          type: rand() > 0.5 ? "foot-chip" : "foot-edge",
          direction: "up",
          usage: "foot",
        });
      };

      // For split cruxes, determine which side is easy/hard
      const leftIsEasy = rand() > 0.5;

      if (cruxType === "split") {
        // === SPLIT: Two divergent paths (original U-shape) ===
        // Entry holds stepping from center to each path
        for (let step = 0; step < 3; step++) {
          for (const side of [-1, 1]) {
            const entryX = side * step * 0.4;
            const entryY = currentY + step * 0.25;
            addHold({
              id: makeHoldId(),
              x: entryX,
              y: entryY,
              type: "jug",
              direction: "up",
              usage: "both",
            });
            addFoot(entryX, entryY - 0.3);
          }
        }
        const leftTypes = leftIsEasy ? easyTypes : hardTypes;
        const rightTypes = leftIsEasy ? hardTypes : easyTypes;

        // Left path
        let leftX = -1.2 + (rand() - 0.5) * 0.15;
        for (let i = 0; i < numMoves; i++) {
          const y = currentY + (i + 0.5) * stepH;
          leftX = Math.max(-1.6, Math.min(-0.8, leftX + (rand() - 0.5) * 0.2));
          addHold({
            id: makeHoldId(),
            x: leftX,
            y,
            type: leftTypes[Math.floor(rand() * leftTypes.length)],
            direction: dirs[Math.floor(rand() * dirs.length)],
            usage: "both",
          });
          if (leftIsEasy && rand() > 0.5)
            addHold({
              id: makeHoldId(),
              x: Math.max(-1.6, Math.min(-0.8, leftX + (rand() - 0.5) * 0.25)),
              y: y + (rand() - 0.5) * stepH * 0.3,
              type: "jug",
              direction: dirs[Math.floor(rand() * dirs.length)],
              usage: "both",
            });
          addFoot(leftX + (rand() - 0.5) * 0.2, y - 0.2);
        }
        // Right path
        let rightX = 1.2 + (rand() - 0.5) * 0.15;
        for (let i = 0; i < numMoves; i++) {
          const y = currentY + (i + 0.5) * stepH;
          rightX = Math.max(0.8, Math.min(1.6, rightX + (rand() - 0.5) * 0.2));
          addHold({
            id: makeHoldId(),
            x: rightX,
            y,
            type: rightTypes[Math.floor(rand() * rightTypes.length)],
            direction: dirs[Math.floor(rand() * dirs.length)],
            usage: "both",
          });
          if (!leftIsEasy && rand() > 0.5)
            addHold({
              id: makeHoldId(),
              x: Math.max(0.8, Math.min(1.6, rightX + (rand() - 0.5) * 0.25)),
              y: y + (rand() - 0.5) * stepH * 0.3,
              type: "jug",
              direction: dirs[Math.floor(rand() * dirs.length)],
              usage: "both",
            });
          addFoot(rightX + (rand() - 0.5) * 0.2, y - 0.2);
        }
        // === CONVERGENCE: step paths back to center at top ===
        for (let step = 0; step < 3; step++) {
          for (const side of [-1, 1]) {
            const convX = side * (0.8 - step * 0.4);
            const convY = sectionEnd - 0.6 + step * 0.2;
            addHold({
              id: makeHoldId(),
              x: convX,
              y: convY,
              type: "jug",
              direction: "up",
              usage: "both",
            });
            addFoot(convX, convY - 0.25);
          }
        }
      } else if (cruxType === "straight") {
        // === STRAIGHT: Single path up the center, hard holds, minimal lateral movement ===
        let pathX = (rand() - 0.5) * 0.3;
        for (let i = 0; i < numMoves; i++) {
          const y = currentY + (i + 0.5) * stepH;
          pathX = Math.max(-0.5, Math.min(0.5, pathX + (rand() - 0.5) * 0.15));
          const type = hardTypes[Math.floor(rand() * hardTypes.length)];
          addHold({
            id: makeHoldId(),
            x: pathX,
            y,
            type,
            direction: dirs[Math.floor(rand() * dirs.length)],
            usage: "both",
          });
          if (rand() > 0.7)
            addHold({
              id: makeHoldId(),
              x: pathX + (rand() > 0.5 ? 0.3 : -0.3),
              y: y + (rand() - 0.5) * 0.2,
              type: "jug",
              direction: "up",
              usage: "both",
            });
          addFoot(pathX + (rand() - 0.5) * 0.3, y - 0.2);
        }
      } else if (cruxType === "zigzag") {
        // === ZIGZAG: Path weaves left and right, requiring lateral moves ===
        const zigWidth = 0.4 + rand() * 0.3; // moderate zig width (reachable)
        let side = rand() > 0.5 ? 1 : -1;
        let prevX = 0;
        for (let i = 0; i < numMoves; i++) {
          const y = currentY + (i + 0.5) * stepH;
          if (i > 0 && i % 2 === 0) side *= -1; // alternate every 2 moves
          const x = side * zigWidth + (rand() - 0.5) * 0.1;
          const clampedX = Math.max(-1.0, Math.min(1.0, x));
          const type = (rand() > 0.5 ? hardTypes : easyTypes)[
            Math.floor(rand() * hardTypes.length)
          ];
          addHold({
            id: makeHoldId(),
            x: clampedX,
            y,
            type,
            direction: dirs[Math.floor(rand() * dirs.length)],
            usage: "both",
          });
          // Intermediate hold between big lateral moves (ensures reachability)
          if (Math.abs(clampedX - prevX) > 0.5) {
            addHold({
              id: makeHoldId(),
              x: (clampedX + prevX) / 2,
              y: y - stepH * 0.4,
              type: "jug",
              direction: "up",
              usage: "both",
            });
          }
          prevX = clampedX;
          addFoot(clampedX * 0.7, y - 0.25);
          addFoot(-clampedX * 0.3, y - 0.15);
        }
      } else {
        // === OVERHANG: Steeper section — slopers, body tension, closer spacing ===
        const overhangAngle = 25 + rand() * 20;
        const newSegs: WallSegment[] = [];
        let accH = 0;
        let inserted = false;
        for (const seg of segments) {
          const segStart = accH;
          const segEnd = accH + seg.height;
          if (!inserted && segEnd > currentY && segStart < sectionEnd) {
            const beforeH = Math.max(0, currentY - segStart);
            const afterH = Math.max(0, segEnd - sectionEnd);
            if (beforeH > 0.5)
              newSegs.push({ height: beforeH, angleDeg: seg.angleDeg });
            newSegs.push({ height: secHeight, angleDeg: overhangAngle });
            if (afterH > 0.5)
              newSegs.push({ height: afterH, angleDeg: seg.angleDeg });
            inserted = true;
          } else {
            newSegs.push(seg);
          }
          accH = segEnd;
        }
        if (inserted) {
          segments.length = 0;
          segments.push(...newSegs);
        }

        // Overhang holds: use full stepH (not tighter) to ensure coverage
        let pathX = (rand() - 0.5) * 0.3;
        for (let i = 0; i < numMoves; i++) {
          const y = currentY + (i + 0.5) * stepH;
          pathX = Math.max(-0.8, Math.min(0.8, pathX + (rand() - 0.5) * 0.3));
          const overhangTypes: HoldType[] = [
            "sloper",
            "crimp",
            "pinch",
            "sloper",
            "pocket",
          ];
          const type = overhangTypes[Math.floor(rand() * overhangTypes.length)];
          addHold({
            id: makeHoldId(),
            x: pathX,
            y,
            type,
            direction: dirs[Math.floor(rand() * dirs.length)],
            usage: "both",
          });
          addFoot(pathX + (rand() > 0.5 ? 0.4 : -0.4), y - 0.15);
          addFoot(pathX + (rand() - 0.5) * 0.2, y - 0.3);
          if (rand() > 0.8)
            addHold({
              id: makeHoldId(),
              x: pathX + (rand() - 0.5) * 0.3,
              y: y + 0.15,
              type: "jug",
              direction: "up",
              usage: "both",
            });
        }
      }

      // === EXIT HOLDS — ensure crux can always be completed ===
      // Place a jug near the top of the crux so climber can always reach endY - 0.5
      addHold({
        id: makeHoldId(),
        x: 0,
        y: sectionEnd - 0.3,
        type: "jug",
        direction: "up",
        usage: "both",
      });
      addHold({
        id: makeHoldId(),
        x: -0.2,
        y: sectionEnd - 0.15,
        type: "jug",
        direction: "up",
        usage: "both",
      });
      addFoot(0, sectionEnd - 0.6);
      addFoot(0.15, sectionEnd - 0.8);

      // === REACH HOLDS for all crux types ===
      const numReach = 2 + Math.floor(rand() * 2);
      const reachTypes: HoldType[] = ["jug", "jug", "pinch"];
      for (let i = 0; i < numReach; i++) {
        const y =
          currentY +
          (1.5 + Math.floor(rand() * Math.max(1, numMoves - 2))) * stepH +
          stepH * 0.3;
        const side = rand() > 0.5 ? 1 : -1;
        const x = side * (1.0 + rand() * 0.35);
        addHold({
          id: makeHoldId(),
          x,
          y: Math.max(currentY + 0.4, Math.min(sectionEnd - 0.2, y)),
          type: reachTypes[Math.floor(rand() * reachTypes.length)],
          direction: dirs[Math.floor(rand() * dirs.length)],
          usage: "both",
        });
      }

      // === POWER-UPS — 1-2 per crux, placed on actual holds so they're in the route path ===
      const powerUpTypes: PowerUpType[] = ["gummy", "weed", "beer", "chalk"];
      const numPowerUps = 1 + Math.floor(rand() * 2);
      const cruxPowerUps: PowerUp[] = [];
      // Pick random holds from the crux to place power-ups on
      const eligibleHolds = cruxHolds.filter((h) => h.usage !== "foot");
      for (let i = 0; i < numPowerUps && eligibleHolds.length > 0; i++) {
        const pickIdx = Math.floor(rand() * eligibleHolds.length);
        const pickedHold = eligibleHolds.splice(pickIdx, 1)[0];
        cruxPowerUps.push({
          id: makeHoldId(),
          x: pickedHold.x,
          y: pickedHold.y,
          type: powerUpTypes[Math.floor(rand() * powerUpTypes.length)],
          collected: false,
        });
      }

      // For split cruxes, hard side gets current letter, easy side drops 1-2 letters
      const easyLetterIdx = Math.max(
        0,
        letterIdx - 1 - Math.floor(rand() * 1.5),
      );
      cruxes.push({
        startY: currentY,
        endY: sectionEnd,
        holds: cruxHolds,
        solved: false,
        shape: cruxType,
        difficulty: letterIdx,
        grade,
        hardSide:
          cruxType === "split" ? (leftIsEasy ? "right" : "left") : undefined,
        hardGrade: cruxType === "split" ? grade : undefined,
        easyGrade:
          cruxType === "split"
            ? makeGrade(cruxAngle, easyLetterIdx)
            : undefined,
        powerUps: cruxPowerUps,
      });
    } else {
      // Easy section: meandering jug path — sine wave + random drift
      const stepSize = 0.35;
      const numHolds = Math.max(6, Math.ceil(secHeight / stepSize));
      const holdSpacing = secHeight / numHolds;
      const waveFreq = 0.5 + rand() * 0.8; // how fast the path sways
      const waveAmp = 0.3 + rand() * 0.4; // how wide the sway
      const wavePhase = rand() * Math.PI * 2;
      let driftX = (rand() - 0.5) * 0.3;
      for (let i = 0; i < numHolds; i++) {
        const y = currentY + (i + 0.5) * holdSpacing;
        const t = i / numHolds;
        // Sine wave for smooth sweeping, plus slow drift
        driftX += (rand() - 0.5) * 0.08;
        driftX = Math.max(-0.5, Math.min(0.5, driftX));
        const waveX =
          Math.sin(t * Math.PI * 2 * waveFreq + wavePhase) * waveAmp;
        const x = waveX + driftX + (i % 2 === 0 ? -0.08 : 0.08);
        holds.push({
          id: makeHoldId(),
          x: Math.max(-1.0, Math.min(1.0, x)),
          y,
          type: "jug",
          direction: "up",
          usage: "both",
        });
        // Foot holds follow the path
        if (i % 2 === 0) {
          holds.push({
            id: makeHoldId(),
            x: Math.max(-1.0, Math.min(1.0, x + (rand() - 0.5) * 0.15)),
            y: y - 0.15,
            type: "foot-edge",
            direction: "up",
            usage: "foot",
          });
        }
      }
    }
    currentY = sectionEnd;
  }

  // Top anchor
  holds.push({
    id: makeHoldId(),
    x: 0,
    y: baseY + heightMeters - 0.3,
    type: "jug",
    direction: "up",
    usage: "both",
  });

  return {
    pitchNumber,
    heightMeters,
    segments,
    holds,
    cruxes,
    completed: false,
    isTraversal: false,
    xOffset: 0,
  };
}

// ---------- traversal pitch generation ----------
// Traversal pitches use wide X range (-4 to 4) for sideways movement
// The traversalWidth field tells the renderer to draw a wide panel
function generateTraversalPitch(pitchNumber: number, baseY: number): PitchData {
  const rand = seededRng(pitchNumber * 7919 + 42);
  const dir: "left" | "right" = rand() < 0.5 ? "left" : "right";
  const heightMeters = 4; // short — just enough vertical space for the climber
  const segments: WallSegment[] = [{ height: heightMeters, angleDeg: 0 }]; // vertical slab

  const holds: PlacedHold[] = [];
  const makeHoldId = () => `t${pitchNumber}_${holds.length}`;

  const cruxHolds: PlacedHold[] = [];
  const numMoves = 10 + Math.floor(rand() * 4); // 10-13 moves across
  const xSign = dir === "right" ? 1 : -1;
  // Holds traverse from near center out to ±4
  const traverseLen = 3.5 + rand() * 1.5; // 3.5-5m horizontal
  const startX = 0;
  const xStep = (xSign * traverseLen) / numMoves;

  const dirs: HoldDirection[] = ["up", "left", "right", "up-left", "up-right"];
  const handTypes: HoldType[] = ["crimp", "pinch", "sloper", "jug", "pocket"];
  const letterIdx = diffToLetterIdx((pitchNumber - 1) * 0.8 + rand() * 1.5);
  const grade = makeGrade(0, letterIdx);

  // Midpoint Y for the traverse band
  const midY = baseY + heightMeters * 0.5;

  for (let i = 0; i < numMoves; i++) {
    const x = startX + xStep * (i + 0.5) + (rand() - 0.5) * 0.2;
    // Small vertical wave — climber stays roughly at same height
    const yOff =
      Math.sin((i / numMoves) * Math.PI * 2) * 0.3 + (rand() - 0.5) * 0.2;
    const y = midY + yOff;

    const hType =
      i === 0 || i === numMoves - 1
        ? "jug"
        : handTypes[Math.floor(rand() * handTypes.length)];
    cruxHolds.push({
      id: makeHoldId(),
      x,
      y,
      type: hType,
      direction: dirs[Math.floor(rand() * dirs.length)],
      usage: "both",
    });
    holds.push(cruxHolds[cruxHolds.length - 1]);

    // Foot hold below
    cruxHolds.push({
      id: makeHoldId(),
      x: x + (rand() - 0.5) * 0.15,
      y: y - 0.3 - rand() * 0.2,
      type: "foot-edge",
      direction: "up",
      usage: "foot",
    });
    holds.push(cruxHolds[cruxHolds.length - 1]);

    // Intermediate holds for reachability
    if (i > 0 && rand() < 0.5) {
      const midX = startX + xStep * i + (rand() - 0.5) * 0.1;
      cruxHolds.push({
        id: makeHoldId(),
        x: midX,
        y: midY + (rand() - 0.5) * 0.3,
        type: handTypes[Math.floor(rand() * handTypes.length)],
        direction: dirs[Math.floor(rand() * dirs.length)],
        usage: "both",
      });
      holds.push(cruxHolds[cruxHolds.length - 1]);
    }
  }

  // Exit holds — climb back up at the end of the traverse
  const endX = startX + xStep * numMoves;
  for (let i = 0; i < 3; i++) {
    const ey = midY + 0.5 + i * 0.5;
    holds.push({
      id: makeHoldId(),
      x: endX + (rand() - 0.5) * 0.2,
      y: ey,
      type: "jug",
      direction: "up",
      usage: "both",
    });
    cruxHolds.push(holds[holds.length - 1]);
  }

  // Power-ups
  const powerUpTypes: PowerUpType[] = ["gummy", "weed", "beer", "chalk"];
  const eligibleHolds = cruxHolds.filter((h) => h.usage !== "foot");
  const cruxPowerUps: PowerUp[] = [];
  if (eligibleHolds.length > 0) {
    const pickIdx = Math.floor(rand() * eligibleHolds.length);
    const pickedHold = eligibleHolds[pickIdx];
    cruxPowerUps.push({
      id: makeHoldId(),
      x: pickedHold.x,
      y: pickedHold.y,
      type: powerUpTypes[Math.floor(rand() * powerUpTypes.length)],
      collected: false,
    });
  }

  // Top anchor
  holds.push({
    id: makeHoldId(),
    x: endX,
    y: baseY + heightMeters - 0.3,
    type: "jug",
    direction: "up",
    usage: "both",
  });

  const cruxes: CruxSequence[] = [
    {
      startY: baseY,
      endY: baseY + heightMeters - 0.5,
      holds: cruxHolds,
      solved: false,
      shape: "straight",
      difficulty: letterIdx,
      grade,
      powerUps: cruxPowerUps,
    },
  ];

  return {
    pitchNumber,
    heightMeters,
    segments,
    holds,
    cruxes,
    completed: false,
    isTraversal: true,
    traversalDir: dir,
    xOffset: 0,
  };
}

// Use flat wall coordinates directly
const towerSegmentToWorld = segmentToWorld;

// Apply xOffset to all holds and crux holds/powerups in a pitch
function applyPitchXOffset(pitch: PitchData, xOff: number): PitchData {
  if (xOff === 0) return pitch;
  return {
    ...pitch,
    xOffset: xOff,
    holds: pitch.holds.map((h) => ({ ...h, x: h.x + xOff })),
    cruxes: pitch.cruxes.map((c) => ({
      ...c,
      holds: c.holds.map((h) => ({ ...h, x: h.x + xOff })),
      powerUps: c.powerUps.map((p) => ({ ...p, x: p.x + xOff })),
    })),
  };
}

// Compute the xOffset for a new pitch based on the previous pitch
function getNextXOffset(prevPitch: PitchData): number {
  if (!prevPitch.isTraversal || !prevPitch.traversalDir)
    return prevPitch.xOffset;
  const shift = prevPitch.traversalDir === "right" ? 4 : -4;
  return prevPitch.xOffset + shift;
}

// Get a position offset along the wall's outward normal (for protection, rope anchors)
function wallSurfacePos(
  x: number,
  wallY: number,
  segments: WallSegment[],
  outwardOffset: number,
): [number, number, number] {
  const w = towerSegmentToWorld(x, wallY, segments);
  const ar = (w.angleDeg * Math.PI) / 180;
  // Normal for wall at angle a: (0, -sin(a), cos(a))
  return [
    w.pos[0],
    w.pos[1] - Math.sin(ar) * outwardOffset,
    w.pos[2] + Math.cos(ar) * outwardOffset,
  ];
}

// ===================== SCENE COMPONENTS =====================

function SandstoneWall({ pitches: wallPitches }: { pitches: PitchData[] }) {
  const wallWidth = 5.5;
  const segData = useMemo(() => {
    const result: {
      xOff: number;
      baseY: number;
      baseZ: number;
      angleRad: number;
      height: number;
    }[] = [];
    let cy = 0,
      cz = 0;
    for (const pitch of wallPitches) {
      for (const seg of pitch.segments) {
        const ar = (seg.angleDeg * Math.PI) / 180;
        result.push({
          xOff: pitch.xOffset,
          baseY: cy,
          baseZ: cz,
          angleRad: ar,
          height: seg.height,
        });
        cy += seg.height * Math.cos(ar);
        cz += seg.height * Math.sin(ar);
      }
    }
    return result;
  }, [wallPitches]);

  return (
    <group>
      {segData.map((seg, i) => (
        <mesh
          key={i}
          position={[
            seg.xOff,
            seg.baseY + (seg.height * Math.cos(seg.angleRad)) / 2,
            seg.baseZ + (seg.height * Math.sin(seg.angleRad)) / 2,
          ]}
          rotation={[seg.angleRad, 0, 0]}
        >
          <planeGeometry args={[wallWidth, seg.height]} />
          <meshStandardMaterial
            color="#c4854a"
            roughness={0.95}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {/* Strata bands */}
      {segData.map((seg, i) => {
        const stripes = [];
        for (let j = 0; j < Math.floor(seg.height / 2); j++) {
          const frac = (j + 0.5) / (Math.floor(seg.height / 2) + 1);
          stripes.push(
            <mesh
              key={`${i}-${j}`}
              position={[
                seg.xOff,
                seg.baseY + seg.height * frac * Math.cos(seg.angleRad),
                seg.baseZ + seg.height * frac * Math.sin(seg.angleRad) + 0.001,
              ]}
              rotation={[seg.angleRad, 0, 0]}
            >
              <planeGeometry args={[wallWidth, 0.08]} />
              <meshStandardMaterial
                color={j % 2 === 0 ? "#b87840" : "#d09060"}
                roughness={1}
                side={THREE.DoubleSide}
                transparent
                opacity={0.6}
              />
            </mesh>,
          );
        }
        return <group key={`s-${i}`}>{stripes}</group>;
      })}
    </group>
  );
}

// --- Traversal wall panel — extends left or right from tower (disabled) ---
// @ts-ignore: kept for future use
function _TraversalWall({
  baseY,
  dir,
  segments,
  pitchXOffset,
}: {
  baseY: number;
  dir: "left" | "right";
  segments: WallSegment[];
  pitchXOffset: number;
}) {
  const { pos } = towerSegmentToWorld(0, baseY, segments);
  const wallHeight = 4;
  const wallLength = 7;
  const panelX =
    pitchXOffset + (dir === "right" ? wallLength / 2 : -wallLength / 2);

  return (
    <group>
      {/* Main traverse panel */}
      <mesh position={[panelX, pos[1] + wallHeight / 2, pos[2]]}>
        <planeGeometry args={[wallLength, wallHeight]} />
        <meshStandardMaterial
          color="#c4854a"
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Strata bands */}
      {[0.3, 0.6].map((f, i) => (
        <mesh
          key={i}
          position={[panelX, pos[1] + wallHeight * f, pos[2] + 0.001]}
        >
          <planeGeometry args={[wallLength, 0.06]} />
          <meshStandardMaterial
            color={i % 2 === 0 ? "#b87840" : "#d09060"}
            roughness={1}
            side={THREE.DoubleSide}
            transparent
            opacity={0.6}
          />
        </mesh>
      ))}
      {/* Connection to tower */}
      <mesh
        position={[
          pitchXOffset + (dir === "right" ? 0.5 : -0.5),
          pos[1] + wallHeight / 2,
          pos[2],
        ]}
      >
        <planeGeometry args={[1.5, wallHeight]} />
        <meshStandardMaterial
          color="#b87840"
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Direction arrow on wall */}
      <Text
        position={[panelX, pos[1] + wallHeight + 0.3, pos[2] + 0.05]}
        fontSize={0.3}
        color="#ff8844"
        anchorX="center"
        fontWeight={700}
      >
        {dir === "right" ? "TRAVERSE →" : "← TRAVERSE"}
      </Text>
    </group>
  );
}

function SandstoneArches() {
  return (
    <group>
      <NaturalArch
        position={[60, 0, -80]}
        rotation={[0, -0.3, 0]}
        span={20}
        legHeight={8}
        thickness={4}
      />
    </group>
  );
}

function NaturalArch({
  position,
  rotation,
  span,
  legHeight,
  thickness,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  span: number;
  legHeight: number;
  thickness: number;
  color?: string;
}) {
  const rand = useMemo(
    () => seededRng(Math.round(position[0] * 100 + position[2] * 7)),
    [position],
  );

  // Arch curve — just the top span, no pillars in the curve
  const archCurve = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const archRadius = span / 2;
    const archHeight = span * 0.35;
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = Math.PI * t;
      pts.push(
        new THREE.Vector3(
          Math.cos(angle) * archRadius,
          legHeight + Math.sin(angle) * archHeight,
          0,
        ),
      );
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
          pos: [
            (side * span) / 2 + (r() - 0.5) * thickness * 0.3,
            y,
            (r() - 0.5) * thickness * 0.4,
          ],
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

function DesertSky() {
  const texture = useTexture("/desertbg.JPG");
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return (
    <mesh>
      <sphereGeometry args={[500, 64, 32]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} />
    </mesh>
  );
}

function DesertFloor() {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.01, 0]}
      receiveShadow
    >
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#c49a6c" roughness={1} />
    </mesh>
  );
}

function SandstoneFormations() {
  const formations = useMemo(() => {
    const rand = seededRng(999);
    const r: {
      pos: [number, number, number];
      scale: [number, number, number];
      color: string;
    }[] = [];
    for (const [bx, bz] of [
      [-30, -25],
      [-18, -30],
      [25, -28],
      [35, -22],
      [-40, -18],
      [42, -35],
      [-25, -40],
      [15, -38],
    ] as [number, number][]) {
      const h = 3 + rand() * 12,
        w = 4 + rand() * 8;
      r.push({
        pos: [bx + rand() * 3, h * 0.45, bz + rand() * 3],
        scale: [w, h, w * (0.6 + rand() * 0.5)],
        color: `hsl(${18 + rand() * 12}, ${45 + rand() * 15}%, ${40 + rand() * 15}%)`,
      });
    }
    for (let i = 0; i < 10; i++) {
      const sz = 0.2 + rand() * 0.6;
      r.push({
        pos: [(rand() - 0.5) * 15, sz * 0.4, 2 + rand() * 8],
        scale: [
          sz * (0.8 + rand() * 0.6),
          sz * (0.5 + rand() * 0.5),
          sz * (0.7 + rand() * 0.5),
        ],
        color: `hsl(${20 + rand() * 10}, ${35 + rand() * 15}%, ${35 + rand() * 20}%)`,
      });
    }
    return r;
  }, []);
  return (
    <group>
      {formations.map((f, i) => (
        <mesh key={i} position={f.pos} scale={f.scale}>
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={f.color} roughness={0.95} flatShading />
        </mesh>
      ))}
    </group>
  );
}

function JoshuaTree({ position }: { position: [number, number, number] }) {
  const rand = useMemo(
    () => seededRng(Math.round(position[0] * 100 + position[2] * 77)),
    [position],
  );
  const tree = useMemo(() => {
    const r = rand;
    const trunkH = 1.5 + r() * 2.5;
    const trunkR = 0.08 + r() * 0.05;
    // 2-4 branches forking from the top
    const numBranches = 2 + Math.floor(r() * 3);
    const branches: { angle: number; tilt: number; len: number; r: number }[] =
      [];
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
        <cylinderGeometry
          args={[tree.trunkR * 0.85, tree.trunkR, tree.trunkH, 6]}
        />
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
            <MPLimb
              from={[bx, tree.trunkH, bz]}
              to={[ex, ey, ez]}
              color="#5a4a35"
              width={3}
            />
            {/* Spiky leaf cluster at tip */}
            <mesh position={[ex, ey + 0.15, ez]}>
              <dodecahedronGeometry args={[0.2 + b.len * 0.15, 0]} />
              <meshStandardMaterial
                color="#5a7a3a"
                roughness={0.9}
                flatShading
              />
            </mesh>
            <mesh position={[ex, ey + 0.25, ez]}>
              <coneGeometry args={[0.12 + b.len * 0.08, 0.25, 5]} />
              <meshStandardMaterial
                color="#4a6a2a"
                roughness={0.9}
                flatShading
              />
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
      const angle = rand() * Math.PI * 2,
        dist = 5 + rand() * 25;
      return {
        pos: [Math.cos(angle) * dist, 0, Math.sin(angle) * dist] as [
          number,
          number,
          number,
        ],
        type: rand() > 0.5 ? ("joshua" as const) : ("sage" as const),
      };
    });
  }, []);
  return (
    <group>
      {plants.map((p, i) =>
        p.type === "joshua" ? (
          <JoshuaTree key={i} position={p.pos} />
        ) : (
          <mesh key={i} position={[p.pos[0], 0.15, p.pos[2]]}>
            <sphereGeometry args={[0.25, 6, 6]} />
            <meshStandardMaterial color="#8a9a6a" roughness={0.9} />
          </mesh>
        ),
      )}
    </group>
  );
}

function MPBird({
  cx,
  cy,
  cz,
  radius,
  speed,
  phase,
}: {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  speed: number;
  phase: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const leftWingRef = useRef<THREE.Mesh>(null);
  const rightWingRef = useRef<THREE.Mesh>(null);

  const wingGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [0, 0, 0, 0.3, 0, -0.04, 0.55, 0.02, -0.08, 0, 0, 0.03, 0.3, 0, 0.01],
        3,
      ),
    );
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
      cz + Math.cos(angle * 0.7) * radius * 0.6,
    );
    const dx = Math.cos(angle) * radius * speed;
    const dz = -Math.sin(angle * 0.7) * radius * 0.6 * speed * 0.7;
    groupRef.current.rotation.y = Math.atan2(dx, dz);
    groupRef.current.rotation.z = -Math.cos(angle) * 0.15;

    const flapCycle = (t * 2.5 + phase * 3) % 4;
    let flapAngle: number;
    if (flapCycle < 0.3)
      flapAngle = Math.sin((flapCycle / 0.3) * Math.PI) * 0.5;
    else if (flapCycle < 0.6)
      flapAngle = Math.sin(((flapCycle - 0.3) / 0.3) * Math.PI) * -0.3;
    else flapAngle = Math.sin((flapCycle - 0.6) * 0.3) * 0.05;

    if (leftWingRef.current) leftWingRef.current.rotation.z = flapAngle;
    if (rightWingRef.current) rightWingRef.current.rotation.z = -flapAngle;
  });

  return (
    <group ref={groupRef}>
      <mesh>
        <capsuleGeometry args={[0.015, 0.06, 4, 6]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.9} flatShading />
      </mesh>
      <mesh ref={leftWingRef} geometry={wingGeo}>
        <meshStandardMaterial
          color="#1a1a1a"
          roughness={0.8}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      <mesh ref={rightWingRef} geometry={wingGeo} scale={[-1, 1, 1]}>
        <meshStandardMaterial
          color="#1a1a1a"
          roughness={0.8}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      <mesh position={[0, 0, 0.04]} rotation={[0.2, 0, 0]}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={new Float32Array([-0.02, 0, 0, 0.02, 0, 0, 0, 0, 0.04])}
            count={3}
            itemSize={3}
          />
        </bufferGeometry>
        <meshStandardMaterial
          color="#1a1a1a"
          side={THREE.DoubleSide}
          flatShading
        />
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
  return (
    <group>
      {birds.map((b, i) => (
        <MPBird key={i} {...b} />
      ))}
    </group>
  );
}

// --- Holds ---
function HoldMesh({
  hold,
  segments,
  onClick,
  isAssigned,
  isReachable,
  pulseHighlight,
  isCrux,
  reachFraction,
}: {
  hold: PlacedHold;
  segments: WallSegment[];
  onClick?: () => void;
  isAssigned?: boolean;
  isReachable?: boolean;
  pulseHighlight?: boolean;
  isCrux?: boolean;
  reachFraction?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { pos } = towerSegmentToWorld(hold.x, hold.y, segments);
  const info = HOLD_INFO[hold.type];
  const baseScale =
    hold.type === "jug" || hold.type === "volume"
      ? 0.06
      : hold.type === "foot-chip"
        ? 0.035
        : 0.05;
  const scale = isReachable || isCrux ? baseScale * 1.3 : baseScale;
  const isReachRisky =
    isReachable && reachFraction !== undefined && reachFraction > 0.8;
  const holdDiff = HOLD_DIFFICULTY[hold.type] || 0;
  const isDifficultHold = isReachable && holdDiff >= 6; // crimps, slopers, pinches, pockets pulse red only when clickable
  const isRisky = isReachRisky || isDifficultHold;
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    if (isRisky) {
      // Risky holds pulse red — intensity scales with difficulty
      const pulseSpeed = isDifficultHold ? 3 + holdDiff * 0.3 : 4;
      const pulseAmp = isDifficultHold ? 0.1 + (holdDiff / 10) * 0.15 : 0.2;
      meshRef.current.scale.setScalar(
        1 + Math.sin(clock.getElapsedTime() * pulseSpeed) * pulseAmp,
      );
    } else {
      meshRef.current.scale.setScalar(
        pulseHighlight ? 1 + Math.sin(clock.getElapsedTime() * 6) * 0.3 : 1,
      );
    }
  });
  // Color gradient: difficulty 6=orange, 7=red-orange, 8=red
  const riskyColor =
    holdDiff >= 8 ? "#ff3300" : holdDiff >= 7 ? "#ff5500" : "#ff6600";
  return (
    <mesh
      ref={meshRef}
      position={[pos[0], pos[1], pos[2] + 0.02]}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <sphereGeometry args={[scale, 8, 8]} />
      <meshStandardMaterial
        color={
          isAssigned
            ? "#fff"
            : isRisky
              ? riskyColor
              : pulseHighlight
                ? "#aaffaa"
                : isReachable
                  ? info.color
                  : isCrux
                    ? info.color
                    : "#555"
        }
        emissive={
          isAssigned
            ? "#ffff00"
            : isRisky
              ? "#ff2200"
              : pulseHighlight
                ? "#44ff44"
                : isCrux
                  ? "#ff4400"
                  : isReachable
                    ? info.color
                    : "#000"
        }
        emissiveIntensity={
          isAssigned
            ? 0.6
            : isRisky
              ? 0.7
              : pulseHighlight
                ? 0.8
                : isCrux
                  ? 0.3
                  : isReachable
                    ? 0.15
                    : 0
        }
        roughness={0.8}
      />
    </mesh>
  );
}

// --- Power-up floating above holds — custom 3D shapes with shiny edges ---
function PowerUpMesh({
  powerUp,
  segments,
}: {
  powerUp: PowerUp;
  segments: WallSegment[];
}) {
  const ref = useRef<THREE.Group>(null);
  const { pos } = towerSegmentToWorld(powerUp.x, powerUp.y, segments);
  const info = POWERUP_INFO[powerUp.type];
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.position.y = pos[1] + 0.15 + Math.sin(t * 2.5) * 0.04;
    ref.current.rotation.y = t * 2.0;
  });
  return (
    <group ref={ref} position={[pos[0], pos[1] + 0.15, pos[2] + 0.15]}>
      {/* Outer glow ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.07, 0.008, 8, 20]} />
        <meshStandardMaterial
          color={info.color}
          emissive={info.color}
          emissiveIntensity={1.2}
          transparent
          opacity={0.5}
        />
      </mesh>

      {powerUp.type === "gummy" && (
        // Gummy worm: segmented wiggly cylinder
        <group>
          {[0, 1, 2, 3, 4].map((i) => (
            <mesh
              key={i}
              position={[
                Math.sin(i * 0.8) * 0.015,
                (i - 2) * 0.012,
                Math.cos(i * 0.8) * 0.01,
              ]}
            >
              <sphereGeometry args={[0.018 - i * 0.001, 8, 8]} />
              <meshStandardMaterial
                color={i % 2 === 0 ? "#ff4488" : "#ffcc44"}
                metalness={0.3}
                roughness={0.2}
                emissive={i % 2 === 0 ? "#ff2266" : "#ffaa00"}
                emissiveIntensity={0.5}
              />
            </mesh>
          ))}
        </group>
      )}

      {powerUp.type === "weed" && (
        // Cannabis leaf: 7 pointed leaflets radiating from center + stem
        <group>
          {/* 7 leaflets — serrated elongated shapes at different angles */}
          {[
            { angle: 0, len: 0.045, w: 0.009 }, // center top (tallest)
            { angle: 0.45, len: 0.038, w: 0.008 }, // upper right
            { angle: -0.45, len: 0.038, w: 0.008 }, // upper left
            { angle: 0.85, len: 0.03, w: 0.007 }, // mid right
            { angle: -0.85, len: 0.03, w: 0.007 }, // mid left
            { angle: 1.2, len: 0.02, w: 0.005 }, // lower right
            { angle: -1.2, len: 0.02, w: 0.005 }, // lower left
          ].map((leaf, i) => (
            <group key={i} rotation={[0, 0, leaf.angle]}>
              {/* Main leaflet blade */}
              <mesh position={[0, leaf.len / 2 + 0.005, 0]}>
                <boxGeometry args={[leaf.w, leaf.len, 0.002]} />
                <meshStandardMaterial
                  color={i === 0 ? "#2d9e2d" : "#33aa33"}
                  metalness={0.2}
                  roughness={0.3}
                  emissive="#22aa22"
                  emissiveIntensity={0.6}
                />
              </mesh>
              {/* Pointed tip */}
              <mesh position={[0, leaf.len + 0.005, 0]}>
                <coneGeometry args={[leaf.w / 2, 0.008, 4]} />
                <meshStandardMaterial
                  color="#2d9e2d"
                  metalness={0.2}
                  roughness={0.3}
                  emissive="#22aa22"
                  emissiveIntensity={0.6}
                />
              </mesh>
              {/* Serrations — small notches along the leaf edge */}
              {i < 5 &&
                [0.3, 0.6].map((f, si) => (
                  <mesh
                    key={si}
                    position={[leaf.w / 2 + 0.002, leaf.len * f + 0.005, 0]}
                  >
                    <boxGeometry args={[0.004, 0.005, 0.001]} />
                    <meshStandardMaterial
                      color="#44bb44"
                      emissive="#33aa33"
                      emissiveIntensity={0.4}
                    />
                  </mesh>
                ))}
            </group>
          ))}
          {/* Stem */}
          <mesh position={[0, -0.02, 0]}>
            <cylinderGeometry args={[0.003, 0.002, 0.025, 4]} />
            <meshStandardMaterial
              color="#228822"
              emissive="#116611"
              emissiveIntensity={0.3}
            />
          </mesh>
        </group>
      )}

      {powerUp.type === "beer" && (
        // Beer can/mug shape
        <group>
          {/* Can body */}
          <mesh>
            <cylinderGeometry args={[0.02, 0.02, 0.05, 10]} />
            <meshStandardMaterial
              color="#ddaa22"
              metalness={0.7}
              roughness={0.15}
              emissive="#cc9900"
              emissiveIntensity={0.4}
            />
          </mesh>
          {/* Foam top */}
          <mesh position={[0, 0.028, 0]}>
            <cylinderGeometry args={[0.022, 0.02, 0.01, 10]} />
            <meshStandardMaterial
              color="#ffffee"
              metalness={0.1}
              roughness={0.4}
              emissive="#ffffcc"
              emissiveIntensity={0.3}
            />
          </mesh>
          {/* Handle */}
          <mesh position={[0.028, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <torusGeometry args={[0.015, 0.004, 6, 8, Math.PI]} />
            <meshStandardMaterial
              color="#ccaa33"
              metalness={0.6}
              roughness={0.2}
            />
          </mesh>
        </group>
      )}

      {powerUp.type === "chalk" && (
        // Chalk: white particle cloud
        <group>
          {[...Array(12)].map((_, i) => {
            const a = (i / 12) * Math.PI * 2;
            const r = 0.015 + (i % 3) * 0.01;
            const h = ((i % 4) - 1.5) * 0.015;
            return (
              <mesh key={i} position={[Math.cos(a) * r, h, Math.sin(a) * r]}>
                <sphereGeometry args={[0.004 + (i % 3) * 0.002, 4, 4]} />
                <meshStandardMaterial
                  color="#ffffff"
                  emissive="#ffffff"
                  emissiveIntensity={0.8}
                  transparent
                  opacity={0.7 + (i % 3) * 0.1}
                />
              </mesh>
            );
          })}
          {/* Central chalk block */}
          <mesh>
            <boxGeometry args={[0.02, 0.025, 0.015]} />
            <meshStandardMaterial
              color="#f0f0f0"
              metalness={0.05}
              roughness={0.9}
              emissive="#dddddd"
              emissiveIntensity={0.3}
            />
          </mesh>
        </group>
      )}

      {/* Sparkle highlights */}
      {[0, 1, 2].map((i) => (
        <mesh
          key={`sparkle-${i}`}
          position={[
            Math.sin(i * 2.1) * 0.05,
            Math.cos(i * 1.7) * 0.04,
            Math.sin(i * 3.3) * 0.03,
          ]}
        >
          <sphereGeometry args={[0.005, 4, 4]} />
          <meshStandardMaterial
            color="#fff"
            emissive="#fff"
            emissiveIntensity={2}
          />
        </mesh>
      ))}
    </group>
  );
}

// --- Power-up collection burst animation ---
function PowerUpBurst({
  position,
  color,
  onDone,
}: {
  position: [number, number, number];
  color: string;
  onDone: () => void;
}) {
  const ref = useRef<THREE.Group>(null);
  const startTime = useRef(0);
  const particles = useRef(
    [...Array(10)].map(() => ({
      vx: (Math.random() - 0.5) * 0.08,
      vy: Math.random() * 0.06 + 0.02,
      vz: (Math.random() - 0.5) * 0.08,
      size: 0.008 + Math.random() * 0.01,
    })),
  );

  useFrame(({ clock }) => {
    if (!ref.current) return;
    if (startTime.current === 0) startTime.current = clock.getElapsedTime();
    const elapsed = clock.getElapsedTime() - startTime.current;
    const t = elapsed / 0.8; // 0.8 second animation

    if (t >= 1) {
      onDone();
      return;
    }

    const children = ref.current.children;
    for (let i = 0; i < children.length; i++) {
      const p = particles.current[i];
      if (!p) continue;
      const child = children[i] as THREE.Mesh;
      child.position.set(
        p.vx * elapsed * 8,
        p.vy * elapsed * 8 - elapsed * elapsed * 2,
        p.vz * elapsed * 8,
      );
      child.scale.setScalar(1 - t * 0.7);
      if (child.material && "opacity" in child.material) {
        (child.material as THREE.MeshStandardMaterial).opacity = 1 - t;
      }
    }
  });

  return (
    <group ref={ref} position={position}>
      {particles.current.map((p, i) => (
        <mesh key={i}>
          <sphereGeometry args={[p.size, 6, 6]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={2}
            transparent
            opacity={1}
          />
        </mesh>
      ))}
    </group>
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

// --- Portaledge (only appears after first pitch) ---
function Portaledge({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {/* Frame */}
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[0.9, 0.04, 0.55]} />
        <meshStandardMaterial color="#2a4a2a" roughness={0.9} />
      </mesh>
      {/* Fabric bed */}
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.82, 0.02, 0.48]} />
        <meshStandardMaterial color="#3a6a3a" roughness={1} />
      </mesh>
      {/* Corner poles */}
      {[
        [-0.4, 0, -0.24],
        [0.4, 0, -0.24],
        [-0.4, 0, 0.24],
        [0.4, 0, 0.24],
      ].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]}>
          <cylinderGeometry args={[0.012, 0.012, 0.06, 6]} />
          <meshStandardMaterial color="#666" metalness={0.6} />
        </mesh>
      ))}
      {/* Suspension straps */}
      <mesh position={[-0.15, 0.35, -0.3]} rotation={[0.8, 0, 0.15]}>
        <cylinderGeometry args={[0.008, 0.008, 0.6, 4]} />
        <meshStandardMaterial color="#887744" />
      </mesh>
      <mesh position={[0.15, 0.35, -0.3]} rotation={[0.8, 0, -0.15]}>
        <cylinderGeometry args={[0.008, 0.008, 0.6, 4]} />
        <meshStandardMaterial color="#887744" />
      </mesh>
      {/* Masterpoint */}
      <mesh position={[0, 0.6, -0.5]}>
        <torusGeometry args={[0.03, 0.008, 8, 12]} />
        <meshStandardMaterial color="#999" metalness={0.8} />
      </mesh>
    </group>
  );
}

// --- Belayer (stands on portaledge surface at y=0.06) ---
function Belayer({ position }: { position: [number, number, number] }) {
  // Belayer body positioned so feet sit on y=0 (the group origin)
  // Portaledge surface is at y=0.06, so caller offsets position accordingly
  return (
    <group position={position}>
      {/* Feet */}
      <mesh position={[-0.04, 0.02, 0.02]}>
        <boxGeometry args={[0.05, 0.03, 0.1]} />
        <meshStandardMaterial color="#443322" />
      </mesh>
      <mesh position={[0.04, 0.02, 0.02]}>
        <boxGeometry args={[0.05, 0.03, 0.1]} />
        <meshStandardMaterial color="#443322" />
      </mesh>
      {/* Legs */}
      <mesh position={[-0.04, 0.35, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.6, 6]} />
        <meshStandardMaterial color="#556644" />
      </mesh>
      <mesh position={[0.04, 0.35, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.6, 6]} />
        <meshStandardMaterial color="#556644" />
      </mesh>
      {/* Harness */}
      <mesh position={[0, 0.68, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 0.06, 8]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      {/* Torso */}
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.08, 0.09, 0.35, 8]} />
        <meshStandardMaterial color="#aa6633" />
      </mesh>
      {/* Arms */}
      <mesh position={[-0.12, 0.85, 0.06]} rotation={[0.3, 0, 0.2]}>
        <cylinderGeometry args={[0.02, 0.02, 0.25, 6]} />
        <meshStandardMaterial color="#cc9977" />
      </mesh>
      <mesh position={[0.12, 0.75, 0.04]} rotation={[-0.5, 0, -0.3]}>
        <cylinderGeometry args={[0.02, 0.02, 0.25, 6]} />
        <meshStandardMaterial color="#cc9977" />
      </mesh>
      {/* Head */}
      <mesh position={[0, 1.2, 0]}>
        <sphereGeometry args={[0.065, 10, 10]} />
        <meshStandardMaterial color="#ddbbaa" />
      </mesh>
      {/* Helmet */}
      <mesh position={[0, 1.26, 0]}>
        <sphereGeometry args={[0.075, 10, 10]} />
        <meshStandardMaterial color="#cc3333" />
      </mesh>
    </group>
  );
}

// --- Rope ---
function Rope({
  climberPos,
  belayerPos,
  anchors,
}: {
  climberPos: [number, number, number];
  belayerPos: [number, number, number];
  anchors: [number, number, number][];
}) {
  const points = useMemo(() => {
    // Sort anchors by height (highest first, near climber) to prevent z-clipping/zig-zag
    const sorted = [...anchors].sort((a, b) => b[1] - a[1]);
    const pts: [number, number, number][] = [climberPos, ...sorted, belayerPos];
    const result: [number, number, number][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i],
        b = pts[i + 1];
      for (let j = 0; j <= 10; j++) {
        const t = j / 10;
        const sag =
          Math.sin(t * Math.PI) * Math.min(0.5, Math.abs(a[1] - b[1]) * 0.05);
        result.push([
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t - sag,
          a[2] + (b[2] - a[2]) * t + sag * 0.3,
        ]);
      }
    }
    return result;
  }, [climberPos, belayerPos, anchors]);
  return (
    <>
      <Line points={points} color="#ddaa33" lineWidth={2.5} />
      {anchors.map((a, i) => (
        <group key={i} position={a}>
          <mesh>
            <torusGeometry args={[0.018, 0.005, 6, 10]} />
            <meshStandardMaterial color="#ccc" metalness={0.9} />
          </mesh>
          <mesh position={[0, -0.035, 0]}>
            <boxGeometry args={[0.01, 0.05, 0.006]} />
            <meshStandardMaterial color="#2255cc" />
          </mesh>
        </group>
      ))}
    </>
  );
}

// --- Climber with clickable limb controls ---
function MPClimber({
  limbPositions,
  segments,
  selectedLimb,
  onLimbClick,
  fatigue,
  phase,
}: {
  limbPositions: Record<Limb, { x: number; y: number }>;
  segments: WallSegment[];
  selectedLimb: Limb | null;
  onLimbClick: (limb: Limb) => void;
  fatigue: { left: number; right: number };
  phase: GamePhase;
}) {
  const lh: V3 = towerSegmentToWorld(
    limbPositions.leftHand.x,
    limbPositions.leftHand.y,
    segments,
  ).pos as V3;
  const rh: V3 = towerSegmentToWorld(
    limbPositions.rightHand.x,
    limbPositions.rightHand.y,
    segments,
  ).pos as V3;
  const lf: V3 = towerSegmentToWorld(
    limbPositions.leftFoot.x,
    limbPositions.leftFoot.y,
    segments,
  ).pos as V3;
  const rf: V3 = towerSegmentToWorld(
    limbPositions.rightFoot.x,
    limbPositions.rightFoot.y,
    segments,
  ).pos as V3;

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
  const head = toWorld(
    cogX,
    cogH + torsoLen + neckLen + headRadius,
    chestOff * 0.95,
  );

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
    return v3add(
      shoulder,
      v3scale(v3normalize(v3sub(hand, shoulder)), Math.max(0, d - handLen)),
    );
  };
  const ankleFrom = (hip: V3, foot: V3): V3 => {
    const d = v3len(v3sub(foot, hip));
    if (d < 0.001) return foot;
    return v3add(
      hip,
      v3scale(v3normalize(v3sub(foot, hip)), Math.max(0, d - footHeight)),
    );
  };

  const wristL = wristFrom(shoulderL, lhClamped);
  const wristR = wristFrom(shoulderR, rhClamped);
  const ankleL = ankleFrom(hipL, lfClamped);
  const ankleR = ankleFrom(hipR, rfClamped);

  // Elbow bend direction
  const computeElbowBend = (
    shoulder: V3,
    wrist: V3,
    lateralSign: number,
  ): V3 => {
    const armMid: V3 = [
      (shoulder[0] + wrist[0]) / 2,
      (shoulder[1] + wrist[1]) / 2,
      (shoulder[2] + wrist[2]) / 2,
    ];
    const midToBody = v3sub(chest, armMid);
    const limbDir = v3normalize(v3sub(wrist, shoulder));
    const along = v3dot(midToBody, limbDir);
    let outward = v3sub(midToBody, v3scale(limbDir, along));
    const outLen = v3len(outward);
    if (outLen < 0.01) outward = [0, 0, 1];
    else outward = v3scale(outward, 1 / outLen);
    const down: V3 = [0, -1, 0];
    const lateral: V3 = [lateralSign, 0, 0];
    let desired = v3normalize(
      v3add(
        v3add(v3scale(down, 1.0), v3scale(lateral, 0.5)),
        v3scale(outward, 0.3),
      ),
    );
    const forward = v3normalize(v3sub(wrist, shoulder));
    if (Math.abs(v3dot(desired, forward)) > 0.95) {
      desired = v3normalize(
        v3add(v3scale(outward, 0.7), v3scale(lateral, 0.3)),
      );
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
    const limbAxis =
      legDist > 0.001 ? v3normalize(hipToAnkle) : ([0, -1, 0] as V3);
    const alongLimb = v3dot(footToChest, limbAxis);
    let outward = v3sub(footToChest, v3scale(limbAxis, alongLimb));
    const outLen = v3len(outward);
    if (outLen < 0.01)
      outward = v3normalize(v3add(v3sub(chest, hip), [0, 0, 0.1]));
    else outward = v3scale(outward, 1 / outLen);
    const footBelow = Math.max(
      0,
      Math.min(1, (hip[1] - ankle[1]) / (maxLeg * 0.5)),
    );
    return v3normalize(
      v3add(v3add(v3scale(outward, 0.7), v3scale([0, 1, 0], footBelow * 0.3)), [
        lateralSign * (0.2 + bunchFactor * 0.5),
        0,
        0,
      ]),
    );
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
    leftHand: "#ff6644",
    rightHand: "#44aaff",
    leftFoot: "#ff9944",
    rightFoot: "#44ccaa",
  };
  const limbLabels: Record<Limb, string> = {
    leftHand: "LH",
    rightHand: "RH",
    leftFoot: "LF",
    rightFoot: "RF",
  };

  const showControls = phase === "crux";

  // Torso cylinder orientation
  const torsoMid: V3 = [
    (chest[0] + pelvis[0]) / 2,
    (chest[1] + pelvis[1]) / 2,
    (chest[2] + pelvis[2]) / 2,
  ];
  const torsoDir = v3normalize(v3sub(chest, pelvis));
  const torsoQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(...torsoDir),
  );

  // Head direction for beanie
  const headDir = v3normalize(v3sub(head, chest));
  const beaniePos = v3add(head, v3scale(headDir, headRadius * 0.35));
  const headQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(...headDir),
  );

  return (
    <group>
      {/* Head */}
      <mesh position={head}>
        <sphereGeometry args={[headRadius, 16, 16]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Beanie */}
      <group position={beaniePos} quaternion={headQuat}>
        <mesh>
          <sphereGeometry
            args={[headRadius * 1.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]}
          />
          <meshStandardMaterial color="#1a1a1a" roughness={0.95} />
        </mesh>
        <mesh position={[0, -headRadius * 0.7 * 0.15, 0]}>
          <cylinderGeometry
            args={[
              headRadius * 1.07,
              headRadius * 1.09,
              headRadius * 0.7 * 0.25,
              14,
            ]}
          />
          <meshStandardMaterial color="#222222" roughness={0.9} />
        </mesh>
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
      <mesh position={pelvis}>
        <cylinderGeometry args={[hipW * 1.1, hipW * 1.1, 0.06, 8]} />
        <meshStandardMaterial color="#333" />
      </mesh>

      {/* Left arm: shoulder → elbow → wrist → hand */}
      <MPLimb from={shoulderL} to={elbowL} color={limbColor} width={3.5} />
      <MPLimb from={elbowL} to={wristL} color={limbColor} width={2.5} />
      <MPLimb from={wristL} to={lhClamped} color={limbColor} width={1.5} />
      <MPJoint position={shoulderL} size={0.032 * s} color={skinColor} />
      <MPJoint position={elbowL} size={0.024 * s} color={skinColor} />
      <MPJoint position={wristL} size={0.016 * s} color={skinColor} />

      {/* Right arm */}
      <MPLimb from={shoulderR} to={elbowR} color={limbColor} width={3.5} />
      <MPLimb from={elbowR} to={wristR} color={limbColor} width={2.5} />
      <MPLimb from={wristR} to={rhClamped} color={limbColor} width={1.5} />
      <MPJoint position={shoulderR} size={0.032 * s} color={skinColor} />
      <MPJoint position={elbowR} size={0.024 * s} color={skinColor} />
      <MPJoint position={wristR} size={0.016 * s} color={skinColor} />

      {/* Left leg: hip → knee → ankle → foot */}
      <MPLimb from={hipL} to={kneeL} color="#445566" width={4} />
      <MPLimb from={kneeL} to={ankleL} color="#445566" width={3} />
      <MPLimb from={ankleL} to={lfClamped} color="#445566" width={2} />
      <MPJoint position={hipL} size={0.034 * s} color={skinColor} />
      <MPJoint position={kneeL} size={0.028 * s} color={skinColor} />
      <MPJoint position={ankleL} size={0.018 * s} color={skinColor} />

      {/* Right leg */}
      <MPLimb from={hipR} to={kneeR} color="#445566" width={4} />
      <MPLimb from={kneeR} to={ankleR} color="#445566" width={3} />
      <MPLimb from={ankleR} to={rfClamped} color="#445566" width={2} />
      <MPJoint position={hipR} size={0.034 * s} color={skinColor} />
      <MPJoint position={kneeR} size={0.028 * s} color={skinColor} />
      <MPJoint position={ankleR} size={0.018 * s} color={skinColor} />

      {/* Clickable limb controls — large and obvious during crux */}
      {(["leftHand", "rightHand", "leftFoot", "rightFoot"] as Limb[]).map(
        (limb) => {
          const pos =
            limb === "leftHand"
              ? lhClamped
              : limb === "rightHand"
                ? rhClamped
                : limb === "leftFoot"
                  ? lfClamped
                  : rfClamped;
          const isSel = selectedLimb === limb;
          const isHand = limb.includes("Hand");
          const fat =
            limb === "leftHand"
              ? fatigue.left
              : limb === "rightHand"
                ? fatigue.right
                : 0;
          const fatColor =
            fat > 80 ? "#ff3333" : fat > 50 ? "#ffaa00" : limbColors[limb];

          // When a limb is selected, hide all other limb hitboxes so holds are easier to click
          const hideHitbox = selectedLimb !== null && !isSel;

          // During crux, make controls large and glowing
          const baseSize = showControls ? 0.06 : 0.025;
          const selSize = showControls ? 0.08 : 0.035;
          const size = isSel ? selSize : baseSize;

          // Offset when any limbs are close so all are clickable (only when no limb selected)
          const isLeft = limb === "leftHand" || limb === "leftFoot";
          const matchOffset: V3 = (() => {
            if (!showControls || hideHitbox) return [0, 0, 0] as V3;
            const allPositions = {
              leftHand: lhClamped,
              rightHand: rhClamped,
              leftFoot: lfClamped,
              rightFoot: rfClamped,
            };
            let offsetX = 0,
              offsetY = 0;
            const minDist = 0.15;
            for (const [otherLimb, otherPos] of Object.entries(allPositions)) {
              if (otherLimb === limb) continue;
              const dx = pos[0] - otherPos[0];
              const dy = pos[1] - otherPos[1];
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < minDist) {
                offsetX += isLeft ? -0.1 : 0.1;
                offsetY += isHand ? 0.08 : -0.08;
              }
            }
            return [offsetX, offsetY, 0] as V3;
          })();
          const offsetPos: V3 = [
            pos[0] + matchOffset[0],
            pos[1] + matchOffset[1],
            pos[2] + matchOffset[2],
          ];

          // Don't render interactive elements for non-selected limbs when one is selected
          if (hideHitbox) return null;

          return (
            <group key={limb}>
              {/* Outer glow ring during crux */}
              {showControls && (
                <mesh
                  position={[offsetPos[0], offsetPos[1], offsetPos[2] + 0.02]}
                >
                  <ringGeometry args={[size * 1.1, size * 1.6, 16]} />
                  <meshBasicMaterial
                    color={isSel ? "#ffff00" : limbColors[limb]}
                    transparent
                    opacity={isSel ? 0.8 : 0.4}
                    side={THREE.DoubleSide}
                  />
                </mesh>
              )}
              {/* Main clickable sphere */}
              <mesh
                position={offsetPos}
                onClick={(e) => {
                  e.stopPropagation();
                  if (showControls) onLimbClick(limb);
                }}
              >
                <sphereGeometry args={[size, 12, 12]} />
                <meshStandardMaterial
                  color={
                    isSel ? "#ffffff" : isHand ? fatColor : limbColors[limb]
                  }
                  emissive={
                    isSel ? "#ffff00" : showControls ? limbColors[limb] : "#000"
                  }
                  emissiveIntensity={isSel ? 1.0 : showControls ? 0.6 : 0}
                  transparent={showControls}
                  opacity={showControls ? 0.9 : 1}
                />
              </mesh>
              {/* Always-visible label during crux — big and clickable */}
              {showControls && (
                <Html
                  position={[
                    offsetPos[0],
                    offsetPos[1] + (isHand ? 0.12 : -0.1),
                    offsetPos[2] + 0.08,
                  ]}
                  center
                  style={{ userSelect: "none" }}
                >
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      onLimbClick(limb);
                    }}
                    style={{
                      background: isSel ? limbColors[limb] : "rgba(0,0,0,0.85)",
                      color: "#fff",
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 800,
                      fontFamily: "system-ui",
                      border: `2px solid ${isSel ? "#fff" : limbColors[limb]}`,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      boxShadow: isSel
                        ? `0 0 12px ${limbColors[limb]}`
                        : "0 2px 8px rgba(0,0,0,0.5)",
                      transition: "all 0.15s",
                    }}
                  >
                    {limbLabels[limb]}
                    {isHand && fat > 20 && (
                      <span style={{ color: fatColor, marginLeft: 4 }}>
                        {Math.round(fat)}%
                      </span>
                    )}
                  </div>
                </Html>
              )}
            </group>
          );
        },
      )}
    </group>
  );
}

// --- Camera ---
function FollowCamera({
  targetY,
  phase,
  wallNormalZ,
  wallNormalY,
  climberPos,
  isTraversal,
  traversalDir,
}: {
  targetY: number;
  phase: GamePhase;
  wallNormalZ: number;
  wallNormalY: number;
  climberPos: [number, number, number];
  isTraversal?: boolean;
  traversalDir?: "left" | "right";
}) {
  const ref = useRef<any>(null);
  const cruxCam = useRef<{
    pos: [number, number, number];
    target: [number, number, number];
  } | null>(null);
  const prevPhase = useRef(phase);
  const isCrux = phase === "crux";

  useFrame(({ camera }) => {
    if (!ref.current) return;
    const isAuto = phase === "auto";

    // On crux entry, lock camera position — computed once, never changes
    if (isCrux && prevPhase.current !== "crux") {
      if (isTraversal) {
        // Traversal: zoom out to show the full horizontal panel, centered on the traverse
        const xCenter = traversalDir === "right" ? 3 : -3;
        cruxCam.current = {
          pos: [xCenter, climberPos[1] + 3.0, climberPos[2] + 12.0],
          target: [xCenter, climberPos[1] + 0.5, climberPos[2]],
        };
      } else {
        cruxCam.current = {
          pos: [climberPos[0] + 2.5, climberPos[1] + 2.0, climberPos[2] + 7.0],
          target: [climberPos[0], climberPos[1] + 0.5, climberPos[2]],
        };
      }
    }
    if (!isCrux) cruxCam.current = null;
    prevPhase.current = phase;

    // During crux: hard-set camera every frame, no lerp, no movement
    if (isCrux && cruxCam.current) {
      const g = cruxCam.current;
      camera.position.set(g.pos[0], g.pos[1], g.pos[2]);
      camera.lookAt(g.target[0], g.target[1], g.target[2]);
      ref.current.target.set(g.target[0], g.target[1], g.target[2]);
      ref.current.object.position.set(g.pos[0], g.pos[1], g.pos[2]);
      ref.current.update();
      return; // absolutely no other camera logic during crux
    }

    let goalCamX: number, goalCamY: number, goalCamZ: number;
    let goalTargetX: number, goalTargetY: number, goalTargetZ: number;
    const smooth = 0.015;

    if (isAuto) {
      const camDist = 14;
      goalCamZ = Math.max(2, wallNormalZ * camDist);
      goalCamX = 5;
      goalCamY = targetY + wallNormalY * camDist * 0.3 + 5;
      goalTargetX = 0;
      goalTargetY = targetY;
      goalTargetZ = Math.max(0, wallNormalZ * 0.3);
    } else {
      const camDist = 8;
      goalCamZ = Math.max(2, wallNormalZ * camDist);
      goalCamX = 3.5;
      goalCamY = targetY + wallNormalY * camDist * 0.3 + 2.5;
      goalTargetX = 0;
      goalTargetY = targetY;
      goalTargetZ = Math.max(0, wallNormalZ * 0.3);
    }

    ref.current.target.x += (goalTargetX - ref.current.target.x) * smooth;
    ref.current.target.y += (goalTargetY - ref.current.target.y) * smooth;
    ref.current.target.z += (goalTargetZ - ref.current.target.z) * smooth;
    ref.current.object.position.x +=
      (goalCamX - ref.current.object.position.x) * smooth;
    ref.current.object.position.y +=
      (goalCamY - ref.current.object.position.y) * smooth;
    ref.current.object.position.z +=
      (goalCamZ - ref.current.object.position.z) * smooth;
  });
  return (
    <OrbitControls
      ref={ref}
      makeDefault
      minDistance={2}
      maxDistance={30}
      target={[0, targetY, 0.5]}
      enabled={!isCrux}
      enableRotate={!isCrux}
      enablePan={!isCrux}
      enableZoom={!isCrux}
    />
  );
}

// --- Crux zone marker ---
function CruxZone({
  startY,
  endY,
  segments,
  active,
  solved,
  shape,
  hardSide,
  grade,
  hardGrade,
  easyGrade,
}: {
  startY: number;
  endY: number;
  segments: WallSegment[];
  active: boolean;
  solved: boolean;
  shape: CruxShape;
  hardSide?: "left" | "right";
  grade: string;
  hardGrade?: string;
  easyGrade?: string;
}) {
  const startW = towerSegmentToWorld(-1.8, startY, segments);
  const endW = towerSegmentToWorld(-1.8, endY, segments);
  const midY = (startW.pos[1] + endW.pos[1]) / 2;
  const color = solved ? "#44cc66" : active ? "#ff4400" : "#ff880088";
  const leftW = towerSegmentToWorld(-1.2, startY + 0.5, segments);
  const rightW = towerSegmentToWorld(1.2, startY + 0.5, segments);
  return (
    <group>
      <Text
        position={[startW.pos[0], midY, startW.pos[2] + 0.1]}
        fontSize={0.22}
        color={color}
        anchorX="center"
        fontWeight={700}
      >
        {solved ? "SENT" : `${grade} ${gradeMultiplier(grade)}x`}
      </Text>
      {shape === "split" &&
        active &&
        !solved &&
        hardSide &&
        hardGrade &&
        easyGrade && (
          <>
            <Text
              position={[leftW.pos[0], leftW.pos[1], leftW.pos[2] + 0.12]}
              fontSize={0.14}
              color={hardSide === "left" ? "#ff6644" : "#66cc44"}
              anchorX="center"
              fontWeight={600}
            >
              {hardSide === "left"
                ? `${hardGrade} ${gradeMultiplier(hardGrade)}x`
                : `${easyGrade} ${gradeMultiplier(easyGrade)}x`}
            </Text>
            <Text
              position={[rightW.pos[0], rightW.pos[1], rightW.pos[2] + 0.12]}
              fontSize={0.14}
              color={hardSide === "right" ? "#ff6644" : "#66cc44"}
              anchorX="center"
              fontWeight={600}
            >
              {hardSide === "right"
                ? `${hardGrade} ${gradeMultiplier(hardGrade)}x`
                : `${easyGrade} ${gradeMultiplier(easyGrade)}x`}
            </Text>
          </>
        )}
    </group>
  );
}

// ===================== MAIN =====================
export default function MultiPitchPage({ onBack }: { onBack: () => void }) {
  const [climberName, setClimberName] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [gameStarted, setGameStarted] = useState(false);
  const urlDebug =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") !== null;
  const isDebug = climberName.toLowerCase() === "debug" || urlDebug;
  const [debugNoFall, setDebugNoFall] = useState(false);
  const [debugMenuOpen, setDebugMenuOpen] = useState(false);

  const [pitches, setPitches] = useState<PitchData[]>(() => [
    generatePitch(1, 0),
  ]);
  const [currentPitchIdx, setCurrentPitchIdx] = useState(0);
  const currentPitch = pitches[currentPitchIdx];

  const allHolds = useMemo(() => pitches.flatMap((p) => p.holds), [pitches]);
  const allSegments = useMemo(
    () => pitches.flatMap((p) => p.segments),
    [pitches],
  );

  const [limbPos, setLimbPos] = useState<
    Record<Limb, { x: number; y: number }>
  >({
    leftHand: { x: -0.2, y: 0.6 },
    rightHand: { x: 0.2, y: 0.8 },
    leftFoot: { x: -0.2, y: 0.15 },
    rightFoot: { x: 0.2, y: 0.2 },
  });
  const [limbHolds, setLimbHolds] = useState<Record<Limb, string | null>>({
    leftHand: null,
    rightHand: null,
    leftFoot: null,
    rightFoot: null,
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
  const [fallCount, setFallCount] = useState(0);
  const [muscleCount, setMuscleCount] = useState(0);
  const [fallOffset, setFallOffset] = useState(0);
  const [ropeAnchors, setRopeAnchors] = useState<[number, number, number][]>(
    [],
  );
  const [protectionPoints, setProtectionPoints] = useState<
    [number, number, number][]
  >([]);
  const [protectionYs, setProtectionYs] = useState<number[]>([]); // wall-local Y of each protection
  // Meters climbed (total across all pitches)
  const [activeCruxIdx, setActiveCruxIdx] = useState(-1);
  const [autoClimbing, setAutoClimbing] = useState(false);
  const [followerProgress, setFollowerProgress] = useState(0); // 0..1 during "following" phase
  const [message, setMessage] = useState<string | null>(null);
  const [powerUpBursts, setPowerUpBursts] = useState<
    { id: string; pos: [number, number, number]; color: string }[]
  >([]);
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

  // Trigger fall animation — catch at last protection or game over if no pro
  const triggerFall = useCallback(() => {
    if (falling || gameOver) return;
    if (debugNoFall) {
      showMessage("Debug: Fall blocked!", 1000);
      return;
    }
    setFalling(true);
    setFell(true);
    showMessage("FALLING!", 2000);

    const newFallCount = fallCount + 1;
    setFallCount(newFallCount);
    const lastProY =
      protectionYs.length > 0 ? protectionYs[protectionYs.length - 1] : null;
    const hasPro = lastProY !== null && newFallCount < 10;

    let frame = 0;
    const startPos = { ...limbPosRef.current };
    const fallAnim = () => {
      frame++;
      const t = frame / 40;
      setFallOffset(t * t * 4);

      // Limbs go limp — spread and drop
      const drop = t * t * 3;
      setLimbPos(() => ({
        leftHand: {
          x: startPos.leftHand.x - t * 0.3,
          y: startPos.leftHand.y - drop * 0.4,
        },
        rightHand: {
          x: startPos.rightHand.x + t * 0.3,
          y: startPos.rightHand.y - drop * 0.3,
        },
        leftFoot: {
          x: startPos.leftFoot.x - t * 0.4,
          y: startPos.leftFoot.y - drop,
        },
        rightFoot: {
          x: startPos.rightFoot.x + t * 0.4,
          y: startPos.rightFoot.y - drop * 0.9,
        },
      }));

      if (frame < 40) {
        requestAnimationFrame(fallAnim);
      } else {
        setFalling(false);
        if (hasPro) {
          // Caught by protection — reset climber to last pro placement
          const catchY = lastProY - 0.5;
          setLimbPos({
            leftHand: { x: -0.2, y: catchY + 0.6 },
            rightHand: { x: 0.2, y: catchY + 0.8 },
            leftFoot: { x: -0.15, y: catchY + 0.1 },
            rightFoot: { x: 0.15, y: catchY + 0.25 },
          });
          setFallOffset(0);
          setFell(false);
          setSelectedLimb(null);
          setLimbHolds({
            leftHand: null,
            rightHand: null,
            leftFoot: null,
            rightFoot: null,
          });
          // Partial fatigue recovery from resting on the rope
          setFatigue((prev) => ({
            left: Math.max(0, prev.left - 15),
            right: Math.max(0, prev.right - 15),
          }));
          setPhase("crux");
          showMessage("Caught by protection! Try again.", 2500);
        } else {
          // No protection — ground fall, game over
          setGameOver(true);
        }
      }
    };
    requestAnimationFrame(fallAnim);
  }, [falling, gameOver, showMessage, protectionYs, fallCount, debugNoFall]);

  // Pitch metrics
  const pitchTopY = useMemo(() => {
    let y = 0;
    for (let i = 0; i <= currentPitchIdx; i++) y += pitches[i].heightMeters;
    return y;
  }, [pitches, currentPitchIdx]);
  const pitchBaseY = useMemo(() => {
    let y = 0;
    for (let i = 0; i < currentPitchIdx; i++) y += pitches[i].heightMeters;
    return y;
  }, [pitches, currentPitchIdx]);

  const highestLimb = Math.max(limbPos.leftHand.y, limbPos.rightHand.y);
  const pitchProgress = Math.min(
    100,
    ((highestLimb - pitchBaseY) / currentPitch.heightMeters) * 100,
  );

  // Physics
  const wallAngle = useMemo(() => {
    const avgY =
      (limbPos.leftHand.y +
        limbPos.rightHand.y +
        limbPos.leftFoot.y +
        limbPos.rightFoot.y) /
      4;
    let remaining = avgY;
    for (const seg of allSegments) {
      if (remaining <= seg.height) return seg.angleDeg;
      remaining -= seg.height;
    }
    return allSegments[allSegments.length - 1]?.angleDeg ?? 0;
  }, [limbPos, allSegments]);
  const isOverhang = wallAngle > 10;

  const physicsConfig = useMemo((): ClimberConfig => {
    const getPull = (limb: Limb): PullDirection => {
      const hid = limbHolds[limb];
      if (!hid) return limb.includes("Hand") ? "down" : "edge";
      const h = allHolds.find((x) => x.id === hid);
      if (!h) return limb.includes("Hand") ? "down" : "edge";
      return limb.includes("Hand")
        ? holdToPullHand(h.type, h.direction)
        : holdToPullFoot(h.type, h.direction, isOverhang);
    };
    return {
      bodyWeightKg: 70,
      gripStrengthKg: 45,
      heightFt: 5.75,
      apeIndexIn: 69,
      bodyRotationDeg: 0,
      wallAngleDeg: wallAngle,
      leftHandPull: getPull("leftHand"),
      rightHandPull: getPull("rightHand"),
      leftFootPull: getPull("leftFoot"),
      rightFootPull: getPull("rightFoot"),
      leftKneeTurnDeg: 0,
      rightKneeTurnDeg: 0,
      hipOffset: 0.35,
      torsoOffset: 0.5,
      leftHandOn: true,
      rightHandOn: true,
      leftFootOn: true,
      rightFootOn: true,
      leftHand: limbPos.leftHand,
      rightHand: limbPos.rightHand,
      leftFoot: limbPos.leftFoot,
      rightFoot: limbPos.rightFoot,
      centerOfGravity: {
        x:
          (limbPos.leftFoot.x + limbPos.rightFoot.x) / 2 +
          ((limbPos.leftHand.x + limbPos.rightHand.x) / 2 -
            (limbPos.leftFoot.x + limbPos.rightFoot.x) / 2) *
            0.55,
        y:
          (limbPos.leftFoot.y + limbPos.rightFoot.y) / 2 +
          ((limbPos.leftHand.y + limbPos.rightHand.y) / 2 -
            (limbPos.leftFoot.y + limbPos.rightFoot.y) / 2) *
            0.55,
      },
    };
  }, [limbPos, wallAngle, limbHolds, allHolds, isOverhang]);

  const forces = useMemo(() => computeForces(physicsConfig), [physicsConfig]);
  useEffect(() => {
    setGripUsed(forces.gripStrengthPercentUsed);
  }, [forces]);

  // Reach checks — generous so puzzle is about sequence, not pixel hunting
  const canReach = useCallback(
    (limb: Limb, hold: PlacedHold) => {
      const isHand = limb.includes("Hand");
      const traverse = currentPitch.isTraversal;
      // Reach from current body center (average of all limbs)
      const cx =
        (limbPos.leftHand.x +
          limbPos.rightHand.x +
          limbPos.leftFoot.x +
          limbPos.rightFoot.x) /
        4;
      const cy =
        (limbPos.leftHand.y +
          limbPos.rightHand.y +
          limbPos.leftFoot.y +
          limbPos.rightFoot.y) /
        4;
      if (isHand) {
        const sx = cx + (limb === "leftHand" ? -0.12 : 0.12),
          sy = cy + 0.3;
        const dx = Math.abs(hold.x - sx);
        const dy = Math.abs(hold.y - sy);
        // Traversals need wider lateral reach
        const maxLat = traverse ? 1.0 : 0.7;
        const maxDist = traverse ? 1.3 : 1.1;
        return (
          dx <= maxLat && dy <= 1.0 && Math.sqrt(dx ** 2 + dy ** 2) <= maxDist
        );
      }
      const hx = cx + (limb === "leftFoot" ? -0.06 : 0.06),
        hy = cy - 0.1;
      const dx = Math.abs(hold.x - hx);
      const dy = Math.abs(hold.y - hy);
      const maxLatF = traverse ? 0.9 : 0.6;
      const maxDistF = traverse ? 1.1 : 0.9;
      return (
        dx <= maxLatF && dy <= 0.9 && Math.sqrt(dx ** 2 + dy ** 2) <= maxDistF
      );
    },
    [limbPos, currentPitch.isTraversal],
  );

  // --- Find current/next crux ---
  // Store in refs so auto-climb loop always reads fresh values
  const allHoldsRef = useRef(allHolds);
  allHoldsRef.current = allHolds;
  const pitchRef = useRef(currentPitch);
  pitchRef.current = currentPitch;
  const pitchTopYRef = useRef(pitchTopY);
  pitchTopYRef.current = pitchTopY;

  const animateLimb = useCallback(
    (limb: Limb, toX: number, toY: number, duration: number): Promise<void> => {
      return new Promise((resolve) => {
        const from = { ...limbPosRef.current[limb] };
        const startTime = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - startTime) / duration);
          const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          const arc = Math.sin(eased * Math.PI) * 0.06;
          const newPos = {
            x: from.x + (toX - from.x) * eased,
            y: from.y + (toY - from.y) * eased + arc,
          };
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
            setLimbPos((prev) => {
              const next = { ...prev, [limb]: finalPos };
              limbPosRef.current = next;
              return next;
            });
            resolve();
          }
        };
        animRef.current = requestAnimationFrame(tick);
      });
    },
    [],
  );

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
      const movingHand: Limb =
        lp.leftHand.y <= lp.rightHand.y ? "leftHand" : "rightHand";
      const movingFoot: Limb =
        movingHand === "leftHand" ? "leftFoot" : "rightFoot";
      const movingHandY = lp[movingHand].y;

      // Find next hold above moving hand — any non-foot hold
      const candidates = holds
        .filter(
          (h) =>
            h.y > movingHandY + 0.05 && h.y < cruxStart && h.usage !== "foot",
        )
        .sort((a, b) => a.y - b.y);

      if (candidates.length === 0) break;

      const target = candidates[0];

      // Find foot hold
      const footTarget = holds
        .filter(
          (h) =>
            h.y > lp[movingFoot].y - 0.2 &&
            h.y < target.y + 0.3 &&
            h.usage !== "hand",
        )
        .sort(
          (a, b) =>
            Math.abs(a.y - (target.y - 0.35)) -
            Math.abs(b.y - (target.y - 0.35)),
        )[0];

      // Move foot first
      if (footTarget) {
        await animateLimb(movingFoot, footTarget.x, footTarget.y, 60);
      }

      // Move hand
      await animateLimb(movingHand, target.x, target.y, 80);
      setLimbHolds((prev) => ({ ...prev, [movingHand]: target.id }));

      // Recovery on jugs
      setFatigue((prev) => ({
        left: Math.max(0, prev.left - 2),
        right: Math.max(0, prev.right - 2),
      }));
      setMoveCount((c) => c + 1);
      setScore((s) => s + 5);

      // Tiny pause
      await new Promise((r) => setTimeout(r, 20));
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
        setProtectionPoints((prev) => [
          ...prev,
          wallSurfacePos(lp.rightHand.x, proY, allSegments, 0.03),
        ]);
        setProtectionYs((prev) => [...prev, proY]);
        setRopeAnchors((prev) => [
          ...prev,
          wallSurfacePos(lp.rightHand.x, proY, allSegments, 0.06),
        ]);

        setPhase("crux");
        setActiveCruxIdx(i);
        setFatigue((prev) => ({
          left: Math.min(prev.left, 15),
          right: Math.min(prev.right, 15),
        }));

        // For traversals, reposition climber to mid-height where holds are
        if (pitch.isTraversal) {
          const cruxMidY = pitch.cruxes[i].startY + 2;
          setLimbPos({
            leftHand: { x: -0.2, y: cruxMidY + 0.6 },
            rightHand: { x: 0.2, y: cruxMidY + 0.8 },
            leftFoot: { x: -0.15, y: cruxMidY + 0.1 },
            rightFoot: { x: 0.15, y: cruxMidY + 0.25 },
          });
        }

        const cruxInfo = pitch.cruxes[i];
        const traversalLabel = pitch.isTraversal
          ? ` TRAVERSE ${pitch.traversalDir?.toUpperCase()}!`
          : "";
        showMessage(
          `${cruxInfo.grade} — ${gradeMultiplier(cruxInfo.grade)}x points${traversalLabel}`,
          3000,
        );
        return;
      }
    }

    if (maxY >= topY - 3) {
      // Close enough to top — auto-complete the pitch
      setPhase("protection");
      showMessage("Topping out! Building anchor...", 2000);
      setTimeout(() => {
        completePitchRef.current();
      }, 2000);
    } else {
      // Got stuck — no holds found above. Skip to nearest crux or top out.
      const nextCrux = pitch.cruxes.find((c) => !c.solved && maxY < c.endY);
      if (nextCrux) {
        // Teleport to crux start
        const jumpY = nextCrux.startY - 0.3;
        setLimbPos({
          leftHand: { x: -0.2, y: jumpY + 0.6 },
          rightHand: { x: 0.2, y: jumpY + 0.8 },
          leftFoot: { x: -0.15, y: jumpY + 0.1 },
          rightFoot: { x: 0.15, y: jumpY + 0.25 },
        });
        setPhase("idle"); // will re-trigger auto-climb which hits the crux
      } else {
        // All cruxes solved, but can't reach top — force top-out
        setPhase("protection");
        showMessage("Topping out! Building anchor...", 2000);
        setTimeout(() => {
          completePitchRef.current();
        }, 2000);
      }
    }
  }, [autoClimbing, gameOver, animateLimb, showMessage]);

  // Auto-start climbing when idle (no button needed for easy sections)
  useEffect(() => {
    if (!gameStarted || phase !== "idle" || gameOver || autoClimbing) return;
    const timer = setTimeout(() => {
      runAutoClimb();
    }, 500);
    return () => clearTimeout(timer);
  }, [gameStarted, phase, gameOver, autoClimbing, runAutoClimb]);

  // --- Crux fatigue: position quality affects pump rate ---
  useEffect(() => {
    if (phase !== "crux" || gameOver) return;
    const interval = setInterval(() => {
      const lp = limbPosRef.current;
      const feetMidY = (lp.leftFoot.y + lp.rightFoot.y) / 2;
      const handsMidY = (lp.leftHand.y + lp.rightHand.y) / 2;
      const feetMidX = (lp.leftFoot.x + lp.rightFoot.x) / 2;
      const handsMidX = (lp.leftHand.x + lp.rightHand.x) / 2;

      const extension = Math.max(0, handsMidY - feetMidY - 1.0) * 0.5;
      const lean = Math.max(0, Math.abs(handsMidX - feetMidX) - 0.3) * 0.4;

      const positionPenalty = extension + lean;
      const baseFatigue = isOverhang ? 0.15 : 0.06;
      const totalFatigue = baseFatigue + positionPenalty;

      setFatigue((prev) => ({
        left: Math.min(100, prev.left + totalFatigue),
        right: Math.min(100, prev.right + totalFatigue),
      }));
    }, 100);
    return () => clearInterval(interval);
  }, [phase, gameOver, isOverhang]);

  // Check fatigue/grip failure — only during crux
  useEffect(() => {
    if (gameOver || falling || phase !== "crux") return;
    if (fatigue.left >= 100 || fatigue.right >= 100) {
      triggerFall();
    }
  }, [fatigue, gameOver, falling, phase, triggerFall]);

  // --- Crux: handle limb click ---
  // Once a limb is selected, you can only deselect it (click same limb) — must move it or deselect before picking another
  const handleLimbClick = useCallback(
    (limb: Limb) => {
      if (phase !== "crux" || gameOver) return;
      setSelectedLimb((prev) => {
        if (prev === limb) return null; // same limb — deselect
        if (prev !== null) return prev; // different limb already selected — ignore

        // Check if any holds are reachable for this limb
        const isHand = limb.includes("Hand");
        const hasReachable = allHolds.some((h) => {
          if (isHand && h.usage === "foot") return false;
          if (!isHand && h.usage === "hand") return false;
          return canReach(limb, h);
        });

        if (!hasReachable && isHand) {
          // No hand holds reachable — prompt to move feet first
          showMessage("No holds in reach! Move a foot first.", 2000);
          return null;
        }

        return limb;
      });
    },
    [phase, gameOver, allHolds, canReach, showMessage],
  );

  // --- Crux: handle hold click ---
  const handleHoldClick = useCallback(
    (holdId: string) => {
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
      const hold = allHolds.find((h) => h.id === holdId);
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
        setLimbPos((prev) => ({
          ...prev,
          [limb]: {
            x: from.x + (hold.x - from.x) * eased,
            y: from.y + (hold.y - from.y) * eased + arc,
          },
        }));
        if (t < 1) requestAnimationFrame(animate);
        else
          setLimbPos((prev) => ({ ...prev, [limb]: { x: hold.x, y: hold.y } }));
      };
      requestAnimationFrame(animate);

      setLimbHolds((prev) => ({ ...prev, [limb]: holdId }));

      // Fatigue cost — reaches near max range are riskier
      if (isHand) {
        const cx =
          (limbPos.leftHand.x +
            limbPos.rightHand.x +
            limbPos.leftFoot.x +
            limbPos.rightFoot.x) /
          4;
        const cy =
          (limbPos.leftHand.y +
            limbPos.rightHand.y +
            limbPos.leftFoot.y +
            limbPos.rightFoot.y) /
          4;
        const sx = cx + (limb === "leftHand" ? -0.12 : 0.12),
          sy = cy + 0.3;
        const dist = Math.sqrt((hold.x - sx) ** 2 + (hold.y - sy) ** 2);
        const reachFraction = dist / 1.4; // 0..1, where 1 = max reach

        const baseCost = HOLD_DIFFICULTY[hold.type] || 3;
        // Reaching far adds extra fatigue (up to 2x at max reach)
        const reachPenalty =
          reachFraction > 0.7 ? (reachFraction - 0.7) * 20 : 0;
        // Cumulative fatigue: each move adds a small escalating cost (pump builds)
        const pumpPenalty = Math.min(moveCount * 0.4, 8); // +0.4 per move, caps at +8
        const cost = baseCost + reachPenalty + pumpPenalty;
        const steepBonus = Math.max(0, wallAngle) * 0.05;
        const side = limb === "leftHand" ? "left" : "right";
        const other = side === "left" ? "right" : "left";
        setFatigue(
          (prev) =>
            ({
              [side]: Math.min(100, prev[side] + cost + steepBonus),
              [other]: Math.max(0, prev[other] - 8), // resting arm recovers well
            }) as { left: number; right: number },
        );

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

        // Matching risk — moving to a hold another hand is already on is risky
        const otherHand = limb === "leftHand" ? "rightHand" : "leftHand";
        if (limbHolds[otherHand] === holdId) {
          const armFatigue = limb === "leftHand" ? fatigue.left : fatigue.right;
          const matchSlipChance = 0.05 + (armFatigue / 100) * 0.25; // 5-30% based on fatigue
          const holdDiff = HOLD_DIFFICULTY[hold.type] || 3;
          const adjustedChance = matchSlipChance * (holdDiff / 8); // harder holds = riskier match
          if (Math.random() < adjustedChance) {
            showMessage("BARN DOOR! Lost it matching hands!", 2000);
            triggerFall();
            return;
          }
        }
      }

      setMoveCount((c) => c + 1);
      // Points scale with grade letter: a=1x, b=2x, c=3x, d=4x
      const activeCrux =
        activeCruxIdx >= 0 ? currentPitch.cruxes[activeCruxIdx] : null;
      let moveGrade = activeCrux?.grade ?? "5.10a";
      if (
        activeCrux?.shape === "split" &&
        activeCrux.hardSide &&
        activeCrux.easyGrade
      ) {
        const onHardSide =
          (activeCrux.hardSide === "left" && hold.x < -0.3) ||
          (activeCrux.hardSide === "right" && hold.x > 0.3);
        moveGrade = onHardSide
          ? (activeCrux.hardGrade ?? moveGrade)
          : activeCrux.easyGrade;
      }
      const pointMultiplier = gradeMultiplier(moveGrade);
      setScore((s) => s + 15 * pointMultiplier);
      setSelectedLimb(null);

      // Check for power-up collection — any uncollected powerup within reach
      if (activeCrux) {
        const collectRange = 0.5;
        activeCrux.powerUps.forEach((pu, puIdx) => {
          if (pu.collected) return;
          const dx = Math.abs(hold.x - pu.x);
          const dy = Math.abs(hold.y - pu.y);
          if (dx < collectRange && dy < collectRange) {
            // Collect it
            const info = POWERUP_INFO[pu.type];
            setPitches((prev) => {
              const updated = [...prev];
              const p = { ...updated[currentPitchIdx] };
              const cruxes = [...p.cruxes];
              const crux = { ...cruxes[activeCruxIdx] };
              const pups = [...crux.powerUps];
              pups[puIdx] = { ...pups[puIdx], collected: true };
              crux.powerUps = pups;
              cruxes[activeCruxIdx] = crux;
              p.cruxes = cruxes;
              updated[currentPitchIdx] = p;
              return updated;
            });
            setFatigue((prev) => ({
              left: Math.max(0, prev.left - info.fatReduction),
              right: Math.max(0, prev.right - info.fatReduction),
            }));
            showMessage(
              `${info.emoji} ${info.label}! -${info.fatReduction}% fatigue`,
              2000,
            );
            // Spawn burst animation at power-up position
            const puWorld = towerSegmentToWorld(pu.x, pu.y, allSegments);
            setPowerUpBursts((prev) => [
              ...prev,
              {
                id: pu.id,
                pos: [
                  puWorld.pos[0],
                  puWorld.pos[1] + 0.15,
                  puWorld.pos[2] + 0.15,
                ],
                color: info.color,
              },
            ]);
          }
        });
      }

      // Check if crux is solved (climber passed the end)
      if (activeCruxIdx >= 0) {
        const crux = currentPitch.cruxes[activeCruxIdx];
        const lps = limbPosRef.current;
        const newHighest = Math.max(
          hold.y,
          lps.leftHand.y,
          lps.rightHand.y,
          lps.leftFoot.y,
          lps.rightFoot.y,
        );
        // For traversals, check if climber reached the far end (X) or exit holds (Y)
        const isTraverse = currentPitch.isTraversal;
        const traverseDone =
          isTraverse &&
          ((currentPitch.traversalDir === "right" &&
            Math.max(lps.leftHand.x, lps.rightHand.x) >= 3.0) ||
            (currentPitch.traversalDir === "left" &&
              Math.min(lps.leftHand.x, lps.rightHand.x) <= -3.0));
        if (traverseDone || newHighest >= crux.endY - 0.8) {
          // Crux solved! Place protection
          setPitches((prev) => {
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
          setProtectionPoints((prev) => [
            ...prev,
            wallSurfacePos(hold.x, hold.y, allSegments, 0.03),
          ]);
          setProtectionYs((prev) => [...prev, hold.y]);
          setRopeAnchors((prev) => [
            ...prev,
            wallSurfacePos(hold.x, hold.y, allSegments, 0.06),
          ]);

          // Fatigue recovery at rest
          setFatigue((prev) => ({
            left: Math.max(0, prev.left - 20),
            right: Math.max(0, prev.right - 20),
          }));

          setScore((s) => s + 100);

          // Stop and let user press "Climb Up" to continue
          setTimeout(() => {
            setPhase("idle");
            setActiveCruxIdx(-1);
          }, 2500);
        }
      }
    },
    [
      phase,
      selectedLimb,
      gameOver,
      allHolds,
      canReach,
      limbPos,
      limbHolds,
      wallAngle,
      allSegments,
      activeCruxIdx,
      currentPitch,
      currentPitchIdx,
      showMessage,
      fatigue,
      triggerFall,
    ],
  );

  // Muscle Through — power through 3 moves at a heavy forearm cost
  const muscleThrough = useCallback(() => {
    if (
      phase !== "crux" ||
      gameOver ||
      activeCruxIdx < 0 ||
      (!isDebug && muscleCount >= 3)
    )
      return;
    if (!isDebug) setMuscleCount((c) => c + 1);
    const crux = currentPitch.cruxes[activeCruxIdx];
    const lp = limbPosRef.current;
    const currentHighest = Math.max(lp.leftHand.y, lp.rightHand.y);

    // Find the next 3 hand holds above current position
    const upHolds = crux.holds
      .filter((h) => h.y > currentHighest + 0.05 && h.usage !== "foot")
      .sort((a, b) => a.y - b.y)
      .slice(0, 3);

    if (upHolds.length === 0) return;

    const targetHold = upHolds[upHolds.length - 1]; // highest of the 3
    const targetY = targetHold.y;

    // Move climber up 3 holds
    setLimbPos({
      leftHand: { x: targetHold.x - 0.15, y: targetY - 0.2 },
      rightHand: { x: targetHold.x + 0.15, y: targetY },
      leftFoot: { x: targetHold.x - 0.15, y: targetY - 0.8 },
      rightFoot: { x: targetHold.x + 0.15, y: targetY - 0.6 },
    });

    // Heavy forearm cost — 25% each arm
    setFatigue((prev) => ({
      left: Math.min(95, prev.left + 25),
      right: Math.min(95, prev.right + 25),
    }));

    showMessage(`Powered through ${upHolds.length} moves!`, 1500);

    // Check if this solves the crux
    if (targetY >= crux.endY - 0.8) {
      setPitches((prev) => {
        const updated = [...prev];
        const p = { ...updated[currentPitchIdx] };
        const cruxes = [...p.cruxes];
        cruxes[activeCruxIdx] = { ...cruxes[activeCruxIdx], solved: true };
        p.cruxes = cruxes;
        updated[currentPitchIdx] = p;
        return updated;
      });

      setProtectionPoints((prev) => [
        ...prev,
        wallSurfacePos(0, crux.endY, allSegments, 0.03),
      ]);
      setProtectionYs((prev) => [...prev, crux.endY]);
      setRopeAnchors((prev) => [
        ...prev,
        wallSurfacePos(0, crux.endY, allSegments, 0.06),
      ]);

      setPhase("protection");
      setTimeout(() => {
        setPhase("idle");
        setActiveCruxIdx(-1);
      }, 2000);
    }
  }, [
    phase,
    gameOver,
    activeCruxIdx,
    currentPitch,
    currentPitchIdx,
    allSegments,
    showMessage,
  ]);

  // Pitch completion — follower climbs up fast, then next pitch starts
  const completePitch = useCallback(() => {
    const bonus = Math.round(100 - fatigue.left + (100 - fatigue.right) + 200);
    setScore((s) => s + bonus);
    setPitches((prev) => {
      const updated = [...prev];
      updated[currentPitchIdx] = {
        ...updated[currentPitchIdx],
        completed: true,
      };
      const nextPitchNum = currentPitchIdx + 2;
      const newPitch = generatePitch(nextPitchNum, pitchTopY);
      updated.push(newPitch);
      return updated;
    });
    setRopeAnchors((prev) => [
      ...prev,
      wallSurfacePos(0, pitchTopY - 0.5, allSegments, 0.06),
    ]);
    setProtectionPoints((prev) => [
      ...prev,
      wallSurfacePos(0, pitchTopY - 0.5, allSegments, 0.03),
    ]);
    setProtectionYs((prev) => [...prev, pitchTopY - 0.5]);
    setFatigue((prev) => ({
      left: Math.max(0, prev.left - 30),
      right: Math.max(0, prev.right - 30),
    }));

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
        // Follower arrived — transition to next pitch, clear old pitch data
        setFollowerProgress(0);
        setCurrentPitchIdx((i) => i + 1);
        // Clear holds and crux data from completed pitches to free memory
        setPitches((prev) =>
          prev.map((p) =>
            p.completed
              ? {
                  ...p,
                  holds: [],
                  cruxes: p.cruxes.map((c) => ({
                    ...c,
                    holds: [],
                    powerUps: [],
                  })),
                }
              : p,
          ),
        );
        setRopeAnchors([]);
        setProtectionPoints([]);
        setProtectionYs([]);
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
    setPitches([generatePitch(1, 0)]);
    setCurrentPitchIdx(0);
    setLimbPos({
      leftHand: { x: -0.2, y: 0.6 },
      rightHand: { x: 0.2, y: 0.8 },
      leftFoot: { x: -0.2, y: 0.15 },
      rightFoot: { x: 0.2, y: 0.2 },
    });
    setLimbHolds({
      leftHand: null,
      rightHand: null,
      leftFoot: null,
      rightFoot: null,
    });
    setFatigue({ left: 0, right: 0 });
    setGripUsed(0);
    setScore(0);
    setMoveCount(0);
    setFallCount(0);
    setMuscleCount(0);
    setPhase("idle");
    setSelectedLimb(null);
    setGameOver(false);
    setFell(false);
    setRopeAnchors([]);
    setProtectionPoints([]);
    setProtectionYs([]);
    setActiveCruxIdx(-1);
    setAutoClimbing(false);
    setFollowerProgress(0);
    setMessage(null);
    setFalling(false);
    setFallOffset(0);
  }, []);

  // World positions
  const climberWorldInfo = useMemo(() => {
    const avgY =
      (limbPos.leftHand.y +
        limbPos.rightHand.y +
        limbPos.leftFoot.y +
        limbPos.rightFoot.y) /
      4;
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
    const w = towerSegmentToWorld(
      (limbPos.leftFoot.x + limbPos.rightFoot.x) / 2,
      (limbPos.leftFoot.y + limbPos.rightFoot.y) / 2 + 0.35,
      allSegments,
    );
    return [w.pos[0], w.pos[1] - fallOffset, w.pos[2] + 0.15];
  }, [limbPos, allSegments, fallOffset]);

  const belayerPos = useMemo((): [number, number, number] => {
    const xOff = currentPitch.xOffset;
    const basePos = (): [number, number, number] => {
      if (currentPitchIdx === 0) return [0.8, 0, 1.8];
      const w = towerSegmentToWorld(0.3, pitchBaseY, allSegments);
      return [w.pos[0] + 0.8 + xOff, w.pos[1], w.pos[2] + 1.2];
    };
    const base = basePos();
    if (phase === "following" && followerProgress > 0) {
      // Follower climbs from base to the top of the current pitch
      const topW = towerSegmentToWorld(0.3, pitchTopY - 0.5, allSegments);
      const nextXOff = pitches[currentPitchIdx + 1]?.xOffset ?? xOff;
      const top: [number, number, number] = [
        topW.pos[0] + 0.8 + nextXOff,
        topW.pos[1],
        topW.pos[2] + 1.2,
      ];
      return [
        base[0] + (top[0] - base[0]) * followerProgress,
        base[1] + (top[1] - base[1]) * followerProgress,
        base[2] + (top[2] - base[2]) * followerProgress,
      ];
    }
    return base;
  }, [
    currentPitchIdx,
    pitchBaseY,
    pitchTopY,
    allSegments,
    phase,
    followerProgress,
    currentPitch.xOffset,
    pitches,
  ]);

  // Reachable holds (only during crux)
  const { reachableHoldIds, reachFractionMap } = useMemo(() => {
    if (phase !== "crux" || !selectedLimb)
      return {
        reachableHoldIds: new Set<string>(),
        reachFractionMap: new Map<string, number>(),
      };
    const ids = new Set<string>();
    const fracs = new Map<string, number>();
    const isHand = selectedLimb.includes("Hand");
    const cx =
      (limbPos.leftHand.x +
        limbPos.rightHand.x +
        limbPos.leftFoot.x +
        limbPos.rightFoot.x) /
      4;
    const cy =
      (limbPos.leftHand.y +
        limbPos.rightHand.y +
        limbPos.leftFoot.y +
        limbPos.rightFoot.y) /
      4;
    const maxReach = isHand ? 1.4 : 1.2;
    const ox =
      cx +
      (isHand
        ? selectedLimb === "leftHand"
          ? -0.12
          : 0.12
        : selectedLimb === "leftFoot"
          ? -0.06
          : 0.06);
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
    const s = new Set<string>();
    for (const v of Object.values(limbHolds)) if (v) s.add(v);
    return s;
  }, [limbHolds]);

  // Current crux hold ids
  const cruxHoldIds = useMemo(() => {
    if (activeCruxIdx < 0) return new Set<string>();
    return new Set(
      currentPitch.cruxes[activeCruxIdx]?.holds.map((h) => h.id) ?? [],
    );
  }, [activeCruxIdx, currentPitch.cruxes]);

  const pill: React.CSSProperties = {
    padding: "7px 10px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontWeight: 600,
    touchAction: "manipulation",
    color: "#fff",
    minHeight: 36,
    minWidth: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  };

  // Debug: skip to a specific pitch type
  type DebugPitchType =
    | "normal"
    | "short-crux"
    | "traverse-left"
    | "traverse-right";
  const debugSkipTo = useCallback(
    (type: DebugPitchType) => {
      if (!isDebug) return;
      const nextPitchNum = currentPitchIdx + 2;
      let nextXOff = 0;
      setPitches((prev) => {
        const updated = [...prev];
        updated[currentPitchIdx] = {
          ...updated[currentPitchIdx],
          completed: true,
        };
        const prevPitch = updated[currentPitchIdx];
        nextXOff = getNextXOffset(prevPitch);
        let newPitch: PitchData;
        if (type === "traverse-left" || type === "traverse-right") {
          const dir = type === "traverse-left" ? "left" : "right";
          newPitch = generateTraversalPitch(
            nextPitchNum + (dir === "left" ? 1000 : 2000),
            pitchTopY,
          );
          newPitch.traversalDir = dir;
        } else if (type === "short-crux") {
          newPitch = generatePitch(nextPitchNum + 5000, pitchTopY);
        } else {
          newPitch = generatePitch(nextPitchNum, pitchTopY);
        }
        newPitch = applyPitchXOffset(newPitch, nextXOff);
        updated.push(newPitch);
        return updated;
      });
      const newBaseY = pitchTopY;
      const isTraverse = type === "traverse-left" || type === "traverse-right";
      // For traversals, place climber at the mid-height where holds are
      const climbY = isTraverse ? newBaseY + 2 : newBaseY;
      setLimbPos({
        leftHand: { x: -0.2 + nextXOff, y: climbY + 0.6 },
        rightHand: { x: 0.2 + nextXOff, y: climbY + 0.8 },
        leftFoot: { x: -0.15 + nextXOff, y: climbY + 0.1 },
        rightFoot: { x: 0.15 + nextXOff, y: climbY + 0.25 },
      });
      setLimbHolds({
        leftHand: null,
        rightHand: null,
        leftFoot: null,
        rightFoot: null,
      });
      setCurrentPitchIdx((i) => i + 1);
      setRopeAnchors([]);
      setProtectionPoints([]);
      setProtectionYs([]);
      setSelectedLimb(null);
      if (isTraverse) {
        // Go directly into crux mode for traversals
        setActiveCruxIdx(0);
        setPhase("crux");
      } else {
        setActiveCruxIdx(-1);
        setPhase("idle");
      }
      const labels: Record<DebugPitchType, string> = {
        normal: "Normal pitch",
        "short-crux": "Short crux pitch",
        "traverse-left": "Traverse left",
        "traverse-right": "Traverse right",
      };
      showMessage(`Debug: ${labels[type]}`, 1500);
    },
    [isDebug, currentPitchIdx, pitchTopY, showMessage],
  );

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        position: "relative",
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* 3D Scene */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
        }}
      >
        <Canvas
          camera={{ position: [4, climberWorldY + 2, 8], fov: 50 }}
          style={{ background: "#2a1a0a" }}
        >
          <DesertSky />
          <ambientLight intensity={0.5} color="#ffeedd" />
          <directionalLight
            position={[80, 30, -60]}
            intensity={1.0}
            color="#ffccaa"
            castShadow
          />
          <pointLight position={[-3, 5, 4]} intensity={0.2} color="#ffddcc" />

          <DesertFloor />
          <SandstoneFormations />
          <SandstoneArches />
          <DesertPlants />
          <DesertBirds />
          <SandstoneWall pitches={pitches} />


          {allHolds.map((hold) => (
            <HoldMesh
              key={hold.id}
              hold={hold}
              segments={allSegments}
              onClick={() => handleHoldClick(hold.id)}
              isAssigned={assignedHoldIds.has(hold.id)}
              isReachable={reachableHoldIds.has(hold.id)}
              pulseHighlight={reachableHoldIds.has(hold.id) && !!selectedLimb}
              isCrux={cruxHoldIds.has(hold.id)}
              reachFraction={reachFractionMap.get(hold.id)}
            />
          ))}

          <MPClimber
            limbPositions={limbPos}
            segments={allSegments}
            selectedLimb={selectedLimb}
            onLimbClick={handleLimbClick}
            fatigue={fatigue}
            phase={phase}
          />

          {/* Name tag above climber's head */}
          <group
            position={[
              climberHarnessPos[0],
              climberHarnessPos[1] + 1.0,
              climberHarnessPos[2],
            ]}
          >
            {gameStarted ? (
              <Text
                fontSize={0.12}
                color="#ffcc00"
                anchorX="center"
                anchorY="bottom"
                fontWeight={700}
                outlineWidth={0.01}
                outlineColor="#000"
              >
                {climberName}
              </Text>
            ) : (
              <Html center>
                <div style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#cc9966",
                      marginBottom: 4,
                      fontFamily: "system-ui",
                    }}
                  >
                    Enter your name
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setClimberName(nameInput.trim() || "Climber");
                      setGameStarted(true);
                    }}
                  >
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      placeholder="Climber name..."
                      autoFocus
                      maxLength={20}
                      style={{
                        width: 140,
                        padding: "6px 10px",
                        fontSize: 14,
                        borderRadius: 6,
                        border: "2px solid #cc6633",
                        background: "rgba(0,0,0,0.7)",
                        color: "#fff",
                        outline: "none",
                        textAlign: "center",
                        fontFamily: "inherit",
                      }}
                    />
                    <button
                      type="submit"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: 6,
                        padding: "5px 0",
                        borderRadius: 6,
                        border: "none",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                        background: "#cc6633",
                        color: "#fff",
                      }}
                    >
                      Climb On
                    </button>
                  </form>
                </div>
              </Html>
            )}
          </group>

          {/* Portaledge only appears after first pitch */}
          {currentPitchIdx > 0 && phase !== "following" && (
            <Portaledge position={belayerPos} />
          )}
          {/* Belayer stands on portaledge surface (y+0.06) or ground */}
          <Belayer
            position={[
              belayerPos[0],
              belayerPos[1] + (currentPitchIdx > 0 ? 0.06 : 0),
              belayerPos[2],
            ]}
          />
          <Rope
            climberPos={climberHarnessPos}
            belayerPos={[
              belayerPos[0],
              belayerPos[1] + (currentPitchIdx > 0 ? 0.76 : 0.7),
              belayerPos[2] - 0.05,
            ]}
            anchors={ropeAnchors}
          />

          {/* Protection pieces */}
          {protectionPoints.map((p, i) => (
            <ProtectionPiece key={i} position={p} />
          ))}

          {/* Crux zone markers */}
          {currentPitch.cruxes.map((crux, i) => (
            <CruxZone
              key={i}
              startY={crux.startY}
              endY={crux.endY}
              segments={allSegments}
              active={i === activeCruxIdx}
              solved={crux.solved}
              shape={crux.shape}
              hardSide={crux.hardSide}
              grade={crux.grade}
              hardGrade={crux.hardGrade}
              easyGrade={crux.easyGrade}
            />
          ))}

          {/* Power-ups in active crux */}
          {activeCruxIdx >= 0 &&
            currentPitch.cruxes[activeCruxIdx]?.powerUps
              .filter((pu) => !pu.collected)
              .map((pu) => (
                <PowerUpMesh key={pu.id} powerUp={pu} segments={allSegments} />
              ))}

          {/* Power-up collection bursts */}
          {powerUpBursts.map((b) => (
            <PowerUpBurst
              key={b.id}
              position={b.pos}
              color={b.color}
              onDone={() =>
                setPowerUpBursts((prev) => prev.filter((x) => x.id !== b.id))
              }
            />
          ))}

          {/* Pitch markers */}
          {pitches.map((p, i) => {
            let my = 0;
            for (let j = 0; j < i; j++) my += pitches[j].heightMeters;
            const w = towerSegmentToWorld(-1.8, my + 1, allSegments);
            return (
              <Text
                key={i}
                position={[w.pos[0], w.pos[1], w.pos[2] + 0.1]}
                fontSize={0.35}
                color={
                  i === currentPitchIdx
                    ? "#ffcc00"
                    : p.completed
                      ? "#44cc66"
                      : "#666"
                }
                anchorX="center"
              >{`P${p.pitchNumber}`}</Text>
            );
          })}

          <FollowCamera
            targetY={climberWorldY}
            phase={phase}
            wallNormalZ={climberWorldInfo.normalZ}
            wallNormalY={climberWorldInfo.normalY}
            climberPos={climberHarnessPos}
            isTraversal={currentPitch.isTraversal}
            traversalDir={currentPitch.traversalDir}
          />
        </Canvas>
      </div>

      {/* === HUD === */}

      {/* Top bar */}
      {/* Top-left: minimal info */}
      <div
        style={{
          position: "absolute",
          top: 6,
          left: 8,
          zIndex: 20,
          pointerEvents: "none",
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11,
          fontWeight: 500,
          color: "#999",
          opacity: 0.7,
        }}
      >
        <span style={{ color: "#cc9900" }}>P{currentPitch.pitchNumber}</span>
        <span>{Math.round(pitchProgress)}%</span>
        <span style={{ color: "#aaa" }}>{score}pts</span>
      </div>

      {/* Stats now consolidated in bottom bar */}

      {/* Message — small, bottom */}
      {message && (
        <div
          style={{
            position: "absolute",
            bottom: 80,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            background: "rgba(0,0,0,0.4)",
            color: "#ddb844",
            padding: "4px 12px",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 500,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            opacity: 0.8,
          }}
        >
          {message}
        </div>
      )}

      {/* Crux hint — only first few seconds, then fades */}
      {phase === "crux" && !gameOver && !selectedLimb && (
        <div
          style={{
            position: "absolute",
            bottom: 80,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            color: "#ff884488",
            fontSize: 10,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          tap a limb, then tap a hold
        </div>
      )}

      {/* Game over */}
      {gameOver && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(6px)",
          }}
        >
          <div
            style={{
              background: "rgba(30,20,10,0.95)",
              borderRadius: 16,
              padding: "32px 40px",
              textAlign: "center",
              maxWidth: 340,
              border: "2px solid #cc6633",
            }}
          >
            <div
              style={{
                fontSize: 28,
                fontWeight: 800,
                color: fell ? "#ff4444" : "#ffcc00",
                marginBottom: 8,
              }}
            >
              {fell ? "FALL!" : "SENT!"}
            </div>
            <div style={{ color: "#ccc", fontSize: 14, marginBottom: 16 }}>
              {fell
                ? fallCount >= 10
                  ? "Too many falls — exhausted!"
                  : gripUsed > 100
                    ? "Grip strength exceeded"
                    : fatigue.left >= 100 || fatigue.right >= 100
                      ? "Too pumped!"
                      : "Lost grip!"
                : "Clean send!"}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 20,
                marginBottom: 20,
                color: "#fff",
                fontSize: 16,
              }}
            >
              <div>
                <div style={{ fontSize: 11, color: "#999" }}>Score</div>
                {score}
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#999" }}>Moves</div>
                {moveCount}
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#999" }}>Pitches</div>
                {pitches.filter((p) => p.completed).length}
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#999" }}>Height</div>
                {Math.round(highestLimb)}m
              </div>
              {fell && (
                <div>
                  <div style={{ fontSize: 11, color: "#999" }}>Falls</div>
                  {fallCount}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                onClick={resetGame}
                style={{
                  ...pill,
                  background: "#cc6633",
                  padding: "10px 20px",
                  fontSize: 14,
                }}
              >
                Climb Again
              </button>
              <button
                onClick={onBack}
                style={{
                  ...pill,
                  background: "#555",
                  padding: "10px 20px",
                  fontSize: 14,
                }}
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar — stats + controls */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 20,
          background: "rgba(20,15,10,0.9)",
          borderTop: "1px solid #443322",
          backdropFilter: "blur(10px)",
          padding: "6px 10px calc(44px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {/* Stat meters — compact: arm | progress + meters | arm */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            maxWidth: 280,
            margin: "0 auto 4px",
            width: "100%",
            gap: 6,
          }}
        >
          {/* Left forearm */}
          {(() => {
            const lCol =
              fatigue.left > 70
                ? "#ff4444"
                : fatigue.left > 40
                  ? "#ffaa22"
                  : "#66cc66";
            const lPump = Math.min(1, fatigue.left / 100);
            return (
              <div
                style={{
                  width: 32,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <svg width="22" height="32" viewBox="0 0 28 40">
                  <rect
                    x="8"
                    y="0"
                    width="12"
                    height="8"
                    rx="3"
                    fill={lCol}
                    opacity={0.9}
                  />
                  <rect
                    x="6"
                    y="7"
                    width="16"
                    height="4"
                    rx="2"
                    fill={lCol}
                    opacity={0.8}
                  />
                  <rect
                    x={10 - lPump * 3}
                    y="10"
                    width={8 + lPump * 6}
                    height="26"
                    rx="4"
                    fill={lCol}
                    opacity={0.7 + lPump * 0.3}
                    style={{ transition: "all 0.3s" }}
                  />
                  <rect
                    x="9"
                    y="36"
                    width="10"
                    height="4"
                    rx="2"
                    fill="#aa8866"
                  />
                  {fatigue.left > 50 && (
                    <line
                      x1="12"
                      y1="14"
                      x2="11"
                      y2="30"
                      stroke="rgba(200,60,60,0.6)"
                      strokeWidth={lPump * 1.5}
                    />
                  )}
                  {fatigue.left > 70 && (
                    <line
                      x1="16"
                      y1="12"
                      x2="17"
                      y2="28"
                      stroke="rgba(200,60,60,0.5)"
                      strokeWidth={lPump}
                    />
                  )}
                </svg>
                <span style={{ fontSize: 8, fontWeight: 700, color: lCol }}>
                  {Math.round(fatigue.left)}%
                </span>
              </div>
            );
          })()}
          {/* Center: pitch progress + meters climbed */}
          <div style={{ flex: 1, textAlign: "center" }}>
            <div
              style={{
                height: 5,
                background: "rgba(255,255,255,0.1)",
                borderRadius: 3,
                overflow: "hidden",
                marginBottom: 2,
              }}
            >
              <div
                style={{
                  width: `${pitchProgress}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #4488ff, #66bbff)",
                  borderRadius: 3,
                  transition: "width 0.3s",
                }}
              />
            </div>
            <div style={{ fontSize: 10, color: "#aaa", fontWeight: 600 }}>
              {Math.round(highestLimb)}m
              <span style={{ color: "#666", fontWeight: 400 }}>
                {" "}
                &middot; P{currentPitch.pitchNumber}
              </span>
            </div>
          </div>
          {/* Right forearm */}
          {(() => {
            const rCol =
              fatigue.right > 70
                ? "#ff4444"
                : fatigue.right > 40
                  ? "#ffaa22"
                  : "#66cc66";
            const rPump = Math.min(1, fatigue.right / 100);
            return (
              <div
                style={{
                  width: 32,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <svg
                  width="22"
                  height="32"
                  viewBox="0 0 28 40"
                  style={{ transform: "scaleX(-1)" }}
                >
                  <rect
                    x="8"
                    y="0"
                    width="12"
                    height="8"
                    rx="3"
                    fill={rCol}
                    opacity={0.9}
                  />
                  <rect
                    x="6"
                    y="7"
                    width="16"
                    height="4"
                    rx="2"
                    fill={rCol}
                    opacity={0.8}
                  />
                  <rect
                    x={10 - rPump * 3}
                    y="10"
                    width={8 + rPump * 6}
                    height="26"
                    rx="4"
                    fill={rCol}
                    opacity={0.7 + rPump * 0.3}
                    style={{ transition: "all 0.3s" }}
                  />
                  <rect
                    x="9"
                    y="36"
                    width="10"
                    height="4"
                    rx="2"
                    fill="#aa8866"
                  />
                  {fatigue.right > 50 && (
                    <line
                      x1="12"
                      y1="14"
                      x2="11"
                      y2="30"
                      stroke="rgba(200,60,60,0.6)"
                      strokeWidth={rPump * 1.5}
                    />
                  )}
                  {fatigue.right > 70 && (
                    <line
                      x1="16"
                      y1="12"
                      x2="17"
                      y2="28"
                      stroke="rgba(200,60,60,0.5)"
                      strokeWidth={rPump}
                    />
                  )}
                </svg>
                <span style={{ fontSize: 8, fontWeight: 700, color: rCol }}>
                  {Math.round(fatigue.right)}%
                </span>
              </div>
            );
          })()}
        </div>
        {/* Controls row */}
        <div
          style={{
            display: "flex",
            gap: 8,
            maxWidth: 520,
            margin: "0 auto",
            width: "100%",
            justifyContent: "center",
          }}
        >
          <button
            onClick={onBack}
            style={{
              ...pill,
              background: "#444",
              flex: 1,
              maxWidth: 70,
              fontSize: 11,
            }}
          >
            Menu
          </button>
          {phase === "crux" && (
            <button
              onClick={muscleThrough}
              disabled={!isDebug && muscleCount >= 3}
              style={{
                ...pill,
                background: !isDebug && muscleCount >= 3 ? "#333" : "#993300",
                flex: 1,
                maxWidth: 160,
                fontSize: 12,
                border: `1px solid ${!isDebug && muscleCount >= 3 ? "#555" : "#cc6600"}`,
                cursor:
                  !isDebug && muscleCount >= 3 ? "not-allowed" : "pointer",
                opacity: !isDebug && muscleCount >= 3 ? 0.5 : 1,
              }}
            >
              Muscle {isDebug ? "∞" : `(${3 - muscleCount})`}
            </button>
          )}
          <div
            style={{
              ...pill,
              background: "rgba(40,30,20,0.7)",
              flex: 1,
              maxWidth: 160,
              fontSize: 10,
              color: "#999",
            }}
          >
            {climberName} &middot; {score}pts
          </div>
          <button
            onClick={resetGame}
            style={{
              ...pill,
              background: "#882222",
              flex: 1,
              maxWidth: 60,
              fontSize: 11,
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Debug menu */}
      {isDebug && (
        <>
          <button
            onClick={() => setDebugMenuOpen((p) => !p)}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 60,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid #ff0066",
              background: "rgba(80,0,30,0.8)",
              color: "#ff0066",
              fontSize: 10,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            DBG
          </button>
          {debugMenuOpen && (
            <div
              style={{
                position: "absolute",
                top: 32,
                right: 8,
                zIndex: 60,
                background: "rgba(20,0,10,0.95)",
                border: "1px solid #ff0066",
                borderRadius: 10,
                padding: 12,
                minWidth: 160,
              }}
            >
              <div
                style={{
                  color: "#ff0066",
                  fontSize: 11,
                  fontWeight: 700,
                  marginBottom: 8,
                }}
              >
                DEBUG MENU
              </div>
              <div style={{ color: "#888", fontSize: 9, marginBottom: 4 }}>
                SKIP TO PITCH TYPE:
              </div>
              {(
                [
                  ["normal", "Normal"],
                  ["short-crux", "Short Crux (2x)"],
                ] as [DebugPitchType, string][]
              ).map(([type, label]) => (
                <button
                  key={type}
                  onClick={() => debugSkipTo(type)}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "6px 10px",
                    marginBottom: 3,
                    borderRadius: 6,
                    border: "none",
                    background: "#333",
                    color: "#fff",
                    fontSize: 11,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {label}
                </button>
              ))}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 0",
                  color: "#fff",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={debugNoFall}
                  onChange={(e) => setDebugNoFall(e.target.checked)}
                />
                No Fall
              </label>
              <div style={{ fontSize: 9, color: "#666", marginTop: 6 }}>
                Muscle: ∞ | Falls: {fallCount}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
