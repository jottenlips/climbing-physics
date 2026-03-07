import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import ClimbingScene from "./components/ClimbingScene";
import { RagdollPart } from "./components/ClimbingScene";
import ForcePanel from "./components/ForcePanel";
import { ClimberConfig, PullDirection, computeForces } from "./physics/climbingPhysics";
import { PlacedHold, HoldType, HoldDirection, HoldUsage, HOLD_INFO, holdToPullHand, holdToPullFoot, planRoute, ClimbMove, makeHoldId, StartHolds } from "./holds/holdTypes";

interface ClimberState {
  bodyWeightKg: number;
  gripStrengthKg: number;
  heightFt: number;
  apeIndexIn: number;
  bodyRotationDeg: number;
  wallAngleDeg: number;
  leftHandPull: PullDirection;
  rightHandPull: PullDirection;
  leftFootPull: PullDirection;
  rightFootPull: PullDirection;
  leftKneeTurnDeg: number;
  rightKneeTurnDeg: number;
  hipOffset: number;
  torsoOffset: number;
  leftHandOn: boolean;
  rightHandOn: boolean;
  leftFootOn: boolean;
  rightFootOn: boolean;
  lhX: number;
  lhY: number;
  rhX: number;
  rhY: number;
  lfX: number;
  lfY: number;
  rfX: number;
  rfY: number;
}

function feetToFtIn(ft: number): string {
  const feet = Math.floor(ft);
  const inches = Math.round((ft - feet) * 12);
  return `${feet}'${inches}"`;
}

function comfortablePose(angleDeg: number) {
  const t = Math.max(0, angleDeg) / 90; // 0=vert, 1=roof
  const slab = Math.max(0, -angleDeg) / 30;

  // Hands at a comfortable height — not fully extended overhead
  const handSpreadX = 0.22 + t * 0.06;
  const handY = 1.6 + t * 0.1 + slab * 0.1;

  // Feet well below hands — wide stance, legs extended
  const footSpreadX = 0.25 + t * 0.08;
  const footY = 0.1 + t * 0.05 - slab * 0.1;

  return {
    lhX: -handSpreadX, lhY: handY,
    rhX: handSpreadX, rhY: handY + 0.1,
    lfX: -footSpreadX, lfY: footY,
    rfX: footSpreadX, rfY: footY + 0.05,
  };
}

type PresetAngles = Record<string, number>;
const PRESET_ANGLES: PresetAngles = {
  "Slab": -15, "Vertical": 0, "15 OH": 15, "30 OH": 30, "45 Steep": 45, "Roof": 80,
};

const TWIST_PRESETS: Record<string, { twist: number; lKnee: number; rKnee: number }> = {
  "Square": { twist: 0, lKnee: 0, rKnee: 0 },
  "R Drop Knee": { twist: 40, lKnee: 0, rKnee: -70 },
  "L Drop Knee": { twist: -40, lKnee: -70, rKnee: 0 },
  "R Flag": { twist: 25, lKnee: 0, rKnee: 50 },
  "L Flag": { twist: -25, lKnee: 50, rKnee: 0 },
};

const HAND_PULL_OPTIONS: PullDirection[] = ["down", "side", "undercling", "gaston", "sloper"];
const FOOT_PULL_OPTIONS: PullDirection[] = ["edge", "smear", "toe-hook", "heel-hook", "toe-cam", "backstep"];

export interface WallSegment {
  height: number;   // height of this segment in meters
  angleDeg: number;  // 0 = vertical, positive = overhang, negative = slab
}

// Given wall-local (x, wallY) and segments, compute world position and the segment's angle
export function segmentToWorld(x: number, wallY: number, segments: WallSegment[]): { pos: [number, number, number]; angleDeg: number } {
  let curWorldY = 0;
  let curWorldZ = 0;
  let remaining = wallY;
  for (const seg of segments) {
    const angleRad = (seg.angleDeg * Math.PI) / 180;
    if (remaining <= seg.height) {
      const wy = curWorldY + remaining * Math.cos(angleRad);
      const wz = curWorldZ + remaining * Math.sin(angleRad);
      return { pos: [x, wy, wz], angleDeg: seg.angleDeg };
    }
    curWorldY += seg.height * Math.cos(angleRad);
    curWorldZ += seg.height * Math.sin(angleRad);
    remaining -= seg.height;
  }
  // Past top of wall: extend last segment
  const last = segments[segments.length - 1];
  const angleRad = (last.angleDeg * Math.PI) / 180;
  return {
    pos: [x, curWorldY + remaining * Math.cos(angleRad), curWorldZ + remaining * Math.sin(angleRad)],
    angleDeg: last.angleDeg,
  };
}

// Get the angle at a given wallY
export function angleAtHeight(wallY: number, segments: WallSegment[]): number {
  let remaining = wallY;
  for (const seg of segments) {
    if (remaining <= seg.height) return seg.angleDeg;
    remaining -= seg.height;
  }
  return segments[segments.length - 1].angleDeg;
}

// Total wall height
export function totalWallHeight(segments: WallSegment[]): number {
  return segments.reduce((sum, s) => sum + s.height, 0);
}

interface RoutePreset {
  name: string;
  grade: string;
  wallAngle: number;
  segments?: WallSegment[];
  holds: Omit<PlacedHold, "id">[];
}

const ROUTE_PRESETS: RoutePreset[] = [
  {
    name: "Ladder", grade: "V0", wallAngle: 0,
    holds: [
      { x: -0.3, y: 0.4, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.3, y: 0.6, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.3, y: 1.2, type: "jug", direction: "up", usage: "both" },
      { x: 0.3, y: 1.6, type: "jug", direction: "up", usage: "both" },
      { x: -0.2, y: 1.4, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 1.8, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 2.0, type: "jug", direction: "up", usage: "both" },
      { x: 0.2, y: 2.4, type: "jug", direction: "up", usage: "both" },
      { x: -0.1, y: 2.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 2.6, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.3, y: 2.8, type: "jug", direction: "up", usage: "both" },
      { x: 0.1, y: 3.2, type: "jug", direction: "up", usage: "both" },
      { x: -0.2, y: 3.0, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 3.4, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.6, type: "jug", direction: "up", usage: "both" },
      { x: 0.2, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Crimp Rail", grade: "V2", wallAngle: 15,
    holds: [
      { x: 0.0, y: 0.8, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.3, y: 1.0, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.2, y: 1.4, type: "crimp", direction: "up", usage: "both" },
      { x: 0.3, y: 1.8, type: "crimp", direction: "up", usage: "both" },
      { x: -0.1, y: 2.2, type: "crimp", direction: "up", usage: "both" },
      { x: 0.2, y: 2.6, type: "crimp", direction: "up", usage: "both" },
      { x: 0.0, y: 1.6, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 2.1, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.0, type: "crimp", direction: "up", usage: "both" },
      { x: 0.2, y: 3.4, type: "crimp", direction: "up", usage: "both" },
      { x: 0.0, y: 2.9, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 3.3, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Slab Smears", grade: "V1", wallAngle: -10,
    holds: [
      { x: -0.2, y: 0.8, type: "smear-pad", direction: "up", usage: "foot" },
      { x: 0.3, y: 1.1, type: "smear-pad", direction: "up", usage: "foot" },
      { x: -0.1, y: 1.5, type: "sloper", direction: "up", usage: "both" },
      { x: 0.2, y: 2.0, type: "sloper", direction: "up", usage: "both" },
      { x: -0.3, y: 2.5, type: "sloper", direction: "up", usage: "both" },
      { x: 0.0, y: 1.8, type: "smear-pad", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.0, type: "sloper", direction: "up", usage: "both" },
      { x: -0.2, y: 3.4, type: "sloper", direction: "up", usage: "both" },
      { x: 0.1, y: 2.8, type: "smear-pad", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.2, type: "smear-pad", direction: "up", usage: "foot" },
      { x: 0.0, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Overhang Jugs", grade: "V1", wallAngle: 30,
    holds: [
      { x: -0.2, y: 0.9, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.2, y: 1.0, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.3, y: 1.5, type: "jug", direction: "up", usage: "both" },
      { x: 0.3, y: 1.9, type: "jug", direction: "up", usage: "both" },
      { x: -0.1, y: 2.3, type: "jug", direction: "up", usage: "both" },
      { x: 0.2, y: 2.7, type: "jug", direction: "up", usage: "both" },
      { x: 0.0, y: 1.7, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.2, y: 2.2, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.2, y: 3.1, type: "jug", direction: "up", usage: "both" },
      { x: 0.1, y: 3.5, type: "jug", direction: "up", usage: "both" },
      { x: 0.1, y: 2.9, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.3, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.0, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Side Pulls", grade: "V3", wallAngle: 20,
    holds: [
      { x: -0.4, y: 1.3, type: "crimp", direction: "right", usage: "hand" },
      { x: 0.4, y: 1.7, type: "crimp", direction: "left", usage: "hand" },
      { x: -0.3, y: 2.1, type: "pinch", direction: "right", usage: "hand" },
      { x: 0.3, y: 2.5, type: "pinch", direction: "left", usage: "hand" },
      { x: 0.0, y: 1.0, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.2, y: 1.5, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 1.9, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 2.4, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 2.9, type: "crimp", direction: "right", usage: "hand" },
      { x: 0.3, y: 3.3, type: "pinch", direction: "left", usage: "hand" },
      { x: 0.1, y: 2.8, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.0, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Steep Pockets", grade: "V4", wallAngle: 45,
    holds: [
      { x: -0.1, y: 0.9, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.2, y: 1.1, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.2, y: 1.5, type: "pocket", direction: "up", usage: "hand" },
      { x: 0.3, y: 1.9, type: "pocket", direction: "up", usage: "hand" },
      { x: -0.1, y: 2.3, type: "pocket", direction: "up", usage: "hand" },
      { x: 0.2, y: 2.7, type: "pocket", direction: "up", usage: "hand" },
      { x: 0.0, y: 1.7, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 2.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 3.1, type: "pocket", direction: "up", usage: "hand" },
      { x: 0.1, y: 3.5, type: "pocket", direction: "up", usage: "hand" },
      { x: 0.0, y: 2.9, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.3, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.0, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Underclings", grade: "V3", wallAngle: 25,
    holds: [
      { x: -0.3, y: 1.3, type: "crimp", direction: "down", usage: "hand" },
      { x: 0.2, y: 1.5, type: "jug", direction: "up", usage: "both" },
      { x: -0.1, y: 1.9, type: "crimp", direction: "down", usage: "hand" },
      { x: 0.3, y: 2.3, type: "jug", direction: "up", usage: "both" },
      { x: -0.2, y: 2.7, type: "crimp", direction: "down", usage: "hand" },
      { x: 0.0, y: 1.0, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.2, y: 1.6, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.1, y: 2.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.1, type: "jug", direction: "up", usage: "both" },
      { x: -0.2, y: 3.5, type: "crimp", direction: "down", usage: "hand" },
      { x: 0.0, y: 2.9, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.3, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Volume Traverse", grade: "V2", wallAngle: 10,
    holds: [
      { x: -0.8, y: 1.5, type: "volume", direction: "up", usage: "both" },
      { x: -0.3, y: 1.7, type: "sloper", direction: "right", usage: "hand" },
      { x: 0.2, y: 1.5, type: "volume", direction: "up", usage: "both" },
      { x: 0.7, y: 1.7, type: "sloper", direction: "left", usage: "hand" },
      { x: -0.6, y: 0.9, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.1, y: 1.0, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.4, y: 0.9, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.5, y: 2.1, type: "jug", direction: "up", usage: "both" },
      { x: -0.2, y: 2.5, type: "volume", direction: "up", usage: "both" },
      { x: 0.3, y: 2.9, type: "sloper", direction: "up", usage: "both" },
      { x: -0.1, y: 3.3, type: "volume", direction: "up", usage: "both" },
      { x: 0.2, y: 2.3, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.1, y: 2.8, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.2, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.0, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Roof Problem", grade: "V5", wallAngle: 70,
    holds: [
      { x: -0.2, y: 1.2, type: "jug", direction: "up", usage: "both" },
      { x: 0.2, y: 1.2, type: "jug", direction: "up", usage: "both" },
      { x: -0.3, y: 1.6, type: "jug", direction: "up", usage: "hand" },
      { x: 0.3, y: 2.0, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 2.4, type: "jug", direction: "up", usage: "hand" },
      { x: 0.2, y: 2.8, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 1.4, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 1.9, type: "jug", direction: "down", usage: "foot" },
      { x: 0.1, y: 2.3, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 3.2, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 3.6, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 2.7, type: "jug", direction: "down", usage: "foot" },
      { x: 0.0, y: 3.1, type: "jug", direction: "down", usage: "foot" },
      { x: 0.0, y: 3.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Roof to Vert", grade: "V4", wallAngle: 80,
    segments: [{ height: 1.5, angleDeg: 0 }, { height: 1.5, angleDeg: 80 }, { height: 2, angleDeg: 0 }],
    holds: [
      { x: -0.3, y: 0.8, type: "jug", direction: "up", usage: "both" },
      { x: 0.3, y: 0.9, type: "jug", direction: "up", usage: "both" },
      { x: -0.2, y: 1.3, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 1.0, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 1.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 1.7, type: "jug", direction: "up", usage: "hand" },
      { x: -0.3, y: 2.1, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 1.6, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 2.0, type: "jug", direction: "down", usage: "foot" },
      { x: 0.1, y: 2.5, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 2.4, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 3.0, type: "crimp", direction: "up", usage: "hand" },
      { x: 0.2, y: 3.4, type: "crimp", direction: "up", usage: "hand" },
      { x: -0.1, y: 2.9, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.3, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 3.8, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 4.2, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 3.7, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 4.1, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.0, y: 4.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Cave Exit", grade: "V6", wallAngle: 60,
    segments: [{ height: 1.0, angleDeg: 60 }, { height: 1.5, angleDeg: 30 }, { height: 2.5, angleDeg: 0 }],
    holds: [
      { x: -0.2, y: 0.5, type: "jug", direction: "up", usage: "both" },
      { x: 0.3, y: 0.6, type: "jug", direction: "up", usage: "both" },
      { x: 0.0, y: 0.3, type: "jug", direction: "down", usage: "foot" },
      { x: -0.3, y: 1.0, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 0.8, type: "jug", direction: "down", usage: "foot" },
      { x: 0.2, y: 1.4, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 1.3, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 1.8, type: "pinch", direction: "up", usage: "hand" },
      { x: 0.3, y: 2.2, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 1.7, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.1, y: 2.1, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 2.7, type: "crimp", direction: "up", usage: "hand" },
      { x: -0.3, y: 3.1, type: "crimp", direction: "up", usage: "hand" },
      { x: 0.0, y: 2.6, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 3.0, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.5, type: "jug", direction: "up", usage: "hand" },
      { x: 0.2, y: 3.9, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 3.4, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.8, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 4.3, type: "crimp", direction: "up", usage: "hand" },
      { x: 0.1, y: 4.6, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 4.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.0, y: 4.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Slab to Overhang", grade: "V3", wallAngle: -10,
    segments: [{ height: 2, angleDeg: -10 }, { height: 1.5, angleDeg: 35 }, { height: 1.5, angleDeg: 0 }],
    holds: [
      { x: -0.2, y: 0.6, type: "sloper", direction: "up", usage: "both" },
      { x: 0.3, y: 0.7, type: "sloper", direction: "up", usage: "both" },
      { x: 0.0, y: 0.4, type: "smear-pad", direction: "up", usage: "foot" },
      { x: -0.1, y: 0.8, type: "smear-pad", direction: "up", usage: "foot" },
      { x: 0.1, y: 1.2, type: "crimp", direction: "up", usage: "hand" },
      { x: -0.3, y: 1.6, type: "crimp", direction: "up", usage: "hand" },
      { x: 0.0, y: 1.1, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 1.5, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 2.1, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 2.5, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 2.0, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 2.4, type: "jug", direction: "down", usage: "foot" },
      { x: 0.3, y: 2.9, type: "crimp", direction: "up", usage: "hand" },
      { x: -0.2, y: 3.3, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 2.8, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.8, type: "jug", direction: "up", usage: "hand" },
      { x: -0.2, y: 4.2, type: "crimp", direction: "up", usage: "hand" },
      { x: 0.0, y: 3.7, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 4.1, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 4.6, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 4.5, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.0, y: 4.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Full Roof", grade: "V7", wallAngle: 85,
    segments: [{ height: 1, angleDeg: 0 }, { height: 2, angleDeg: 85 }, { height: 2, angleDeg: 0 }],
    holds: [
      { x: -0.2, y: 0.5, type: "jug", direction: "up", usage: "both" },
      { x: 0.2, y: 0.6, type: "jug", direction: "up", usage: "both" },
      { x: 0.0, y: 0.3, type: "foot-edge", direction: "up", usage: "foot" },
      { x: -0.3, y: 0.9, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 0.7, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 1.3, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 1.7, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 1.2, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 1.6, type: "jug", direction: "down", usage: "foot" },
      { x: 0.3, y: 2.1, type: "jug", direction: "up", usage: "hand" },
      { x: -0.2, y: 2.5, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 2.0, type: "jug", direction: "down", usage: "foot" },
      { x: -0.1, y: 2.4, type: "jug", direction: "down", usage: "foot" },
      { x: 0.0, y: 2.9, type: "jug", direction: "up", usage: "hand" },
      { x: 0.2, y: 3.3, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 2.8, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 3.8, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 4.2, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 3.7, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 4.1, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 4.6, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 4.5, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.0, y: 4.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
  {
    name: "Kick to Roof", grade: "V5", wallAngle: 20,
    segments: [{ height: 2, angleDeg: 20 }, { height: 1, angleDeg: 70 }, { height: 2, angleDeg: 10 }],
    holds: [
      { x: -0.3, y: 0.7, type: "jug", direction: "up", usage: "both" },
      { x: 0.2, y: 0.8, type: "jug", direction: "up", usage: "both" },
      { x: -0.1, y: 0.5, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.1, y: 0.9, type: "foot-edge", direction: "up", usage: "foot" },
      { x: 0.0, y: 1.3, type: "pinch", direction: "up", usage: "hand" },
      { x: -0.3, y: 1.7, type: "crimp", direction: "up", usage: "hand" },
      { x: 0.1, y: 1.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.2, y: 1.6, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 2.1, type: "jug", direction: "up", usage: "hand" },
      { x: -0.1, y: 2.5, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 2.0, type: "jug", direction: "down", usage: "foot" },
      { x: -0.2, y: 2.4, type: "jug", direction: "down", usage: "foot" },
      { x: 0.3, y: 2.9, type: "jug", direction: "up", usage: "hand" },
      { x: -0.2, y: 3.3, type: "jug", direction: "up", usage: "hand" },
      { x: 0.1, y: 2.8, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 3.2, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.1, y: 3.8, type: "jug", direction: "up", usage: "hand" },
      { x: -0.2, y: 4.2, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 3.7, type: "foot-chip", direction: "up", usage: "foot" },
      { x: -0.1, y: 4.1, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.2, y: 4.6, type: "jug", direction: "up", usage: "hand" },
      { x: 0.0, y: 4.5, type: "foot-chip", direction: "up", usage: "foot" },
      { x: 0.0, y: 4.8, type: "jug", direction: "up", usage: "hand" },
    ],
  },
];

// --- Compact slider ---
function Slider({ label, value, min, max, step, onChange, suffix }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
      <label style={{ width: 70, fontSize: 11, color: "#aaa", flexShrink: 0 }}>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: "#4488ff", height: 24, touchAction: "manipulation" }} />
      <span style={{ width: 40, fontSize: 11, textAlign: "right", color: "#ccc", flexShrink: 0 }}>
        {value.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)}{suffix ?? ""}
      </span>
    </div>
  );
}

const DEFAULT_STATE: ClimberState = {
  bodyWeightKg: 70, gripStrengthKg: 45, heightFt: 5.75, apeIndexIn: 69,
  bodyRotationDeg: 0, wallAngleDeg: 45,
  leftHandPull: "down", rightHandPull: "down",
  leftFootPull: "edge" as PullDirection, rightFootPull: "edge" as PullDirection,
  leftKneeTurnDeg: 0, rightKneeTurnDeg: 0,
  hipOffset: 0.35, torsoOffset: 0.5,
  leftHandOn: true, rightHandOn: true, leftFootOn: true, rightFootOn: true,
  ...comfortablePose(45),
};

// --- Share/Load route via URL ---
interface SharedRoute {
  s: WallSegment[];                       // segments
  h: [number, number, string, string, string][]; // holds: [x, y, type, dir, usage]
}

function encodeRoute(segments: WallSegment[], holds: PlacedHold[]): string {
  const data: SharedRoute = {
    s: segments,
    h: holds.map(h => [
      Math.round(h.x * 100) / 100,
      Math.round(h.y * 100) / 100,
      h.type, h.direction, h.usage,
    ]),
  };
  return btoa(JSON.stringify(data));
}

function decodeRoute(encoded: string): { segments: WallSegment[]; holds: PlacedHold[] } | null {
  try {
    const data: SharedRoute = JSON.parse(atob(encoded));
    const holds: PlacedHold[] = data.h.map(([x, y, type, direction, usage]) => ({
      id: makeHoldId(), x, y,
      type: type as HoldType,
      direction: direction as HoldDirection,
      usage: usage as HoldUsage,
    }));
    return { segments: data.s, holds };
  } catch {
    return null;
  }
}

function getSharedRouteFromURL(): { segments: WallSegment[]; holds: PlacedHold[] } | null {
  const params = new URLSearchParams(window.location.search);
  const route = params.get("route");
  if (!route) return null;
  return decodeRoute(route);
}

// Bottom sheet panel types
type PanelType = "none" | "routes" | "holds" | "settings" | "forces";

function App() {
  const [state, setState] = useState<ClimberState>(DEFAULT_STATE);
  const [activePreset, setActivePreset] = useState("45 Steep");
  const [activeTwist, setActiveTwist] = useState("Square");
  const [wallSegments, setWallSegments] = useState<WallSegment[]>([{ height: 4, angleDeg: 45 }]);

  // Hold placement
  const [placedHolds, setPlacedHolds] = useState<PlacedHold[]>([]);
  const [selectedHoldType, setSelectedHoldType] = useState<HoldType>("jug");
  const [selectedDirection, setSelectedDirection] = useState<HoldDirection>("up");
  const [selectedUsage, setSelectedUsage] = useState<HoldUsage>("both");
  const [placingMode, setPlacingMode] = useState(false);
  const [eraserMode, setEraserMode] = useState(false);

  // UI state
  const [activePanel, setActivePanel] = useState<PanelType>("none");
  const [showCopied, setShowCopied] = useState(false);

  // Load shared route from URL on mount
  useEffect(() => {
    const shared = getSharedRouteFromURL();
    if (shared && shared.holds.length > 0) {
      setPlacedHolds(shared.holds);
      setWallSegments(shared.segments);
      const angle = shared.segments[0]?.angleDeg ?? 0;
      const handUsable = [...shared.holds].filter(h => h.usage !== "foot").sort((a, b) => a.y - b.y);
      if (handUsable.length >= 1) {
        const lh = handUsable[0]; const rh = handUsable[1] || handUsable[0];
        const [left, right] = lh.x <= rh.x ? [lh, rh] : [rh, lh];
        const footY = Math.max(0.15, Math.min(left.y, right.y) - 0.6);
        setState(prev => ({
          ...prev,
          bodyRotationDeg: 0,
          leftHandPull: "down", rightHandPull: "down",
          leftFootPull: "edge" as PullDirection, rightFootPull: "edge" as PullDirection,
          leftKneeTurnDeg: 0, rightKneeTurnDeg: 0,
          hipOffset: 0.35, torsoOffset: 0.5,
          leftHandOn: true, rightHandOn: true, leftFootOn: true, rightFootOn: true,
          wallAngleDeg: angle,
          lhX: left.x, lhY: left.y, rhX: right.x, rhY: right.y,
          lfX: left.x, lfY: footY, rfX: right.x, rfY: footY,
        }));
      }
    }
  }, []);

  const shareRoute = useCallback(() => {
    const encoded = encodeRoute(wallSegments, placedHolds);
    const url = new URL(window.location.href);
    url.searchParams.set("route", encoded);
    window.history.replaceState(null, "", url.toString());
    navigator.clipboard.writeText(url.toString()).then(() => {
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 2000);
    }).catch(() => {
      // Fallback: just update URL
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 2000);
    });
  }, [wallSegments, placedHolds]);

  // Start holds derived from climber state
  const startHolds = useMemo<StartHolds>(() => ({
    leftHand: { id: "start_lh", x: state.lhX, y: state.lhY, type: selectedHoldType, direction: selectedDirection, usage: "hand" },
    rightHand: { id: "start_rh", x: state.rhX, y: state.rhY, type: selectedHoldType, direction: selectedDirection, usage: "hand" },
  }), [state.lhX, state.lhY, state.rhX, state.rhY, selectedHoldType, selectedDirection]);

  // Simulation
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFalling, setIsFalling] = useState(false);
  const [fallReason, setFallReason] = useState<"reach" | "grip">("reach");
  const [ragdollParts, setRagdollParts] = useState<RagdollPart[] | undefined>(undefined);
  const [sittingOnGround, setSittingOnGround] = useState(false);
  const [toppedOut, setToppedOut] = useState(false);
  const [simMoveIndex, setSimMoveIndex] = useState(0);
  const [fatigue, setFatigue] = useState({ left: 0, right: 0 }); // 0-100%

  const allHoldsOnWall = useMemo(() => [
    ...(toppedOut || sittingOnGround || isPlaying ? [] : [startHolds.leftHand, startHolds.rightHand]),
    ...placedHolds,
  ], [startHolds, placedHolds, toppedOut, sittingOnGround, isPlaying]);
  const simRef = useRef<number | null>(null);
  const movesRef = useRef<ClimbMove[]>([]);
  const snapRef = useRef<ClimberState | null>(null);
  const stateRef = useRef<ClimberState>(state);
  stateRef.current = state;

  const handleWallClick = useCallback((x: number, y: number) => {
    if (!placingMode || eraserMode) return;
    setPlacedHolds((prev) => [
      ...prev,
      { id: makeHoldId(), x, y, type: selectedHoldType, direction: selectedDirection, usage: selectedUsage },
    ]);
  }, [placingMode, eraserMode, selectedHoldType, selectedDirection, selectedUsage]);

  const removeHold = useCallback((id: string) => {
    setPlacedHolds((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const undoHold = useCallback(() => {
    setPlacedHolds((prev) => prev.slice(0, -1));
  }, []);

  const handleHoldClick = useCallback((id: string) => {
    if (!eraserMode) return;
    if (id === "start_lh" || id === "start_rh") return;
    removeHold(id);
  }, [eraserMode, removeHold]);

  // --- Helpers ---
  function limbXKey(limb: string) { return limb === "leftHand" ? "lhX" : limb === "rightHand" ? "rhX" : limb === "leftFoot" ? "lfX" : "rfX"; }
  function limbYKey(limb: string) { return limb === "leftHand" ? "lhY" : limb === "rightHand" ? "rhY" : limb === "leftFoot" ? "lfY" : "rfY"; }
  function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
  function easeInOut(t: number) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
  function easeOut(t: number) { return 1 - (1 - t) * (1 - t); }

  const stopSim = useCallback(() => {
    if (simRef.current) { cancelAnimationFrame(simRef.current); simRef.current = null; }
    setIsPlaying(false); setIsFalling(false); setSimMoveIndex(0);
    setRagdollParts(undefined); setSittingOnGround(false); setToppedOut(false); setFatigue({ left: 0, right: 0 });
    movesRef.current = []; snapRef.current = null;
  }, []);

  const buildRagdoll = useCallback((s: ClimberState): RagdollPart[] => {
    const scale = s.heightFt / 5.75;
    const toWorld = (x: number, h: number, d: number): [number, number, number] => {
      const { pos, angleDeg } = segmentToWorld(x, h, wallSegments);
      const ar = (angleDeg * Math.PI) / 180;
      const sn: [number, number, number] = [0, -Math.sin(ar), Math.cos(ar)];
      return [pos[0], pos[1] + d * sn[1], pos[2] + d * sn[2]];
    };

    const cogX = (s.lhX + s.rhX + s.lfX + s.rfX) / 4;
    const cogY = (s.lhY + s.rhY + s.lfY + s.rfY) / 4;
    const hipOff = 0.15 * scale;

    const pelvisW = toWorld(cogX, cogY, hipOff);
    const chestW = toWorld(cogX, cogY + 0.30 * scale, hipOff * 1.5);
    const headW = toWorld(cogX, cogY + 0.40 * scale, hipOff * 1.4);
    const lhW = toWorld(s.lhX, s.lhY, 0.03);
    const rhW = toWorld(s.rhX, s.rhY, 0.03);
    const lfW = toWorld(s.lfX, s.lfY, 0.03);
    const rfW = toWorld(s.rfX, s.rfY, 0.03);

    const midPt = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
      (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2,
    ];

    const rndV = (base: number, spread: number): [number, number, number] => [
      (Math.random() - 0.5) * spread,
      base + Math.random() * spread * 0.5,
      (Math.random() - 0.5) * spread * 0.5 + 1.5, // push away from wall
    ];
    const rndAng = (s: number): [number, number, number] => [
      (Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s,
    ];

    const skinColor = "#ddbbaa";
    const limbColor = "#cc9977";
    const torsoColor = "#5588aa";
    const legColor = "#445566";
    const shoeColor = "#334455";

    return [
      // Head
      { shape: "sphere", color: skinColor, size: [0.065 * scale, 0, 0],
        position: headW, velocity: rndV(2, 3), rotation: [0, 0, 0], angularVel: rndAng(8) },
      // Torso
      { shape: "cylinder", color: torsoColor, size: [0.09 * scale, 0.28 * scale, 0],
        position: midPt(chestW, pelvisW), velocity: rndV(1.5, 2), rotation: [0, 0, 0], angularVel: rndAng(5) },
      // Left upper arm
      { shape: "cylinder", color: limbColor, size: [0.02 * scale, 0.18 * scale, 0],
        position: midPt(chestW, midPt(chestW, lhW)), velocity: rndV(2, 4), rotation: [0, 0, 0], angularVel: rndAng(10) },
      // Left forearm
      { shape: "cylinder", color: limbColor, size: [0.016 * scale, 0.15 * scale, 0],
        position: midPt(midPt(chestW, lhW), lhW), velocity: rndV(2.5, 4), rotation: [0, 0, 0], angularVel: rndAng(12) },
      // Right upper arm
      { shape: "cylinder", color: limbColor, size: [0.02 * scale, 0.18 * scale, 0],
        position: midPt(chestW, midPt(chestW, rhW)), velocity: rndV(2, 4), rotation: [0, 0, 0], angularVel: rndAng(10) },
      // Right forearm
      { shape: "cylinder", color: limbColor, size: [0.016 * scale, 0.15 * scale, 0],
        position: midPt(midPt(chestW, rhW), rhW), velocity: rndV(2.5, 4), rotation: [0, 0, 0], angularVel: rndAng(12) },
      // Left thigh
      { shape: "cylinder", color: legColor, size: [0.025 * scale, 0.22 * scale, 0],
        position: midPt(pelvisW, midPt(pelvisW, lfW)), velocity: rndV(1, 3), rotation: [0, 0, 0], angularVel: rndAng(8) },
      // Left shin
      { shape: "cylinder", color: legColor, size: [0.02 * scale, 0.18 * scale, 0],
        position: midPt(midPt(pelvisW, lfW), lfW), velocity: rndV(1.5, 3), rotation: [0, 0, 0], angularVel: rndAng(10) },
      // Right thigh
      { shape: "cylinder", color: legColor, size: [0.025 * scale, 0.22 * scale, 0],
        position: midPt(pelvisW, midPt(pelvisW, rfW)), velocity: rndV(1, 3), rotation: [0, 0, 0], angularVel: rndAng(8) },
      // Right shin
      { shape: "cylinder", color: legColor, size: [0.02 * scale, 0.18 * scale, 0],
        position: midPt(midPt(pelvisW, rfW), rfW), velocity: rndV(1.5, 3), rotation: [0, 0, 0], angularVel: rndAng(10) },
      // Left hand
      { shape: "sphere", color: skinColor, size: [0.018 * scale, 0, 0],
        position: lhW, velocity: rndV(3, 5), rotation: [0, 0, 0], angularVel: rndAng(15) },
      // Right hand
      { shape: "sphere", color: skinColor, size: [0.018 * scale, 0, 0],
        position: rhW, velocity: rndV(3, 5), rotation: [0, 0, 0], angularVel: rndAng(15) },
      // Left foot
      { shape: "box", color: shoeColor, size: [0.035 * scale, 0.025 * scale, 0.07 * scale],
        position: lfW, velocity: rndV(2, 4), rotation: [0, 0, 0], angularVel: rndAng(10) },
      // Right foot
      { shape: "box", color: shoeColor, size: [0.035 * scale, 0.025 * scale, 0.07 * scale],
        position: rfW, velocity: rndV(2, 4), rotation: [0, 0, 0], angularVel: rndAng(10) },
    ];
  }, []);

  const triggerFall = useCallback((reason: "reach" | "grip" = "reach") => {
    setIsFalling(true); setFallReason(reason);
    const fallStart = performance.now();

    // Phase 1: Peel off the wall (600ms)
    const peelDuration = 600;
    const fallAnimate = (now: number) => {
      const elapsed = now - fallStart;
      const t = Math.min(1, elapsed / peelDuration);
      const eased = t * t;

      setState((prev) => ({
        ...prev,
        lhY: prev.lhY - eased * 0.06, rhY: prev.rhY - eased * 0.06,
        lfY: prev.lfY - eased * 0.06, rfY: prev.rfY - eased * 0.06,
        leftHandOn: false, rightHandOn: false, leftFootOn: false, rightFootOn: false,
        torsoOffset: Math.min(1, prev.torsoOffset + eased * 0.4),
        hipOffset: Math.min(1, prev.hipOffset + eased * 0.2),
      }));

      if (t < 1) {
        simRef.current = requestAnimationFrame(fallAnimate);
      } else {
        // Phase 2: Switch to ragdoll
        const parts = buildRagdoll(stateRef.current);
        setRagdollParts(parts);
        // After ragdoll settles, show sitting climber
        setTimeout(() => {
          setRagdollParts(undefined);
          setSittingOnGround(true);
          setIsPlaying(false);
          if (simRef.current) { cancelAnimationFrame(simRef.current); simRef.current = null; }
        }, 3500);
      }
    };
    simRef.current = requestAnimationFrame(fallAnimate);
  }, [stopSim, buildRagdoll]);

  const resetClimber = useCallback(() => {
    stopSim(); setState(DEFAULT_STATE);
  }, [stopSim]);

  const clearHolds = useCallback(() => {
    setPlacedHolds([]);
    setWallSegments([{ height: 4, angleDeg: 45 }]);
    setState({ ...DEFAULT_STATE });
    stopSim();
    setSittingOnGround(false);
    setToppedOut(false);
    setRagdollParts(undefined);
    setIsFalling(false);
    setFatigue({ left: 0, right: 0 });
  }, [stopSim]);

  const loadRoute = useCallback((preset: RoutePreset) => {
    stopSim();
    const holds = preset.holds.map(h => ({ ...h, id: makeHoldId() }));
    setPlacedHolds(holds);
    setWallSegments(preset.segments || [{ height: 4, angleDeg: preset.wallAngle }]);
    const handUsable = [...holds].filter(h => h.usage !== "foot").sort((a, b) => a.y - b.y);
    const lh = handUsable[0]; const rh = handUsable[1] || handUsable[0];
    const [left, right] = lh.x <= rh.x ? [lh, rh] : [rh, lh];
    const footY = Math.max(0.15, Math.min(left.y, right.y) - 0.6);
    setState(prev => ({
      ...prev,
      bodyRotationDeg: 0,
      leftHandPull: "down", rightHandPull: "down",
      leftFootPull: "edge" as PullDirection, rightFootPull: "edge" as PullDirection,
      leftKneeTurnDeg: 0, rightKneeTurnDeg: 0,
      hipOffset: 0.35, torsoOffset: 0.5,
      leftHandOn: true, rightHandOn: true, leftFootOn: true, rightFootOn: true,
      wallAngleDeg: preset.wallAngle,
      lhX: left.x, lhY: left.y, rhX: right.x, rhY: right.y,
      lfX: left.x, lfY: footY, rfX: right.x, rfY: footY,
    }));
    setPlacingMode(false); setEraserMode(false); setActivePanel("none");
  }, [stopSim]);

  const repositionAtStart = useCallback(() => {
    const handUsable = [...placedHolds].filter(h => h.usage !== "foot").sort((a, b) => a.y - b.y);
    if (handUsable.length < 1) return;
    const lh = handUsable[0]; const rh = handUsable[1] || handUsable[0];
    const [left, right] = lh.x <= rh.x ? [lh, rh] : [rh, lh];
    const footY = Math.max(0.15, Math.min(left.y, right.y) - 0.6);
    setState(prev => ({
      ...prev,
      bodyRotationDeg: 0,
      leftHandPull: "down", rightHandPull: "down",
      leftFootPull: "edge" as PullDirection, rightFootPull: "edge" as PullDirection,
      leftKneeTurnDeg: 0, rightKneeTurnDeg: 0,
      hipOffset: 0.35, torsoOffset: 0.5,
      leftHandOn: true, rightHandOn: true, leftFootOn: true, rightFootOn: true,
      wallAngleDeg: prev.wallAngleDeg,
      lhX: left.x, lhY: left.y, rhX: right.x, rhY: right.y,
      lfX: left.x, lfY: footY, rfX: right.x, rfY: footY,
    }));
  }, [placedHolds]);

  const pendingRestartRef = useRef(false);

  const startSim = useCallback(() => {
    // If sitting after a fall or topped out, reposition climber then restart
    if (sittingOnGround || toppedOut) {
      setSittingOnGround(false); setToppedOut(false); setRagdollParts(undefined);
      setIsFalling(false); setFatigue({ left: 0, right: 0 });
      repositionAtStart();
      pendingRestartRef.current = true;
      return;
    }
    const moves = planRoute(placedHolds, state.wallAngleDeg, startHolds);
    if (moves.length === 0) return;
    movesRef.current = moves; setIsPlaying(true); setSimMoveIndex(0);
    snapRef.current = { ...state }; setActivePanel("none");

    let currentMoveIdx = 0;
    let stopped = false;
    const moveStartTime = performance.now();
    const schedule: { start: number; duration: number; pause: number }[] = [];
    let cumTime = 0;
    for (const m of moves) {
      const pause = m.isSetup ? 50 : 150;
      schedule.push({ start: cumTime, duration: m.duration, pause });
      cumTime += m.duration + pause;
    }

    const animate = (now: number) => {
      if (stopped) return;
      const globalElapsed = now - moveStartTime;
      let moveIdx = currentMoveIdx;
      while (moveIdx < moves.length - 1 &&
             globalElapsed >= schedule[moveIdx].start + schedule[moveIdx].duration + schedule[moveIdx].pause) {
        moveIdx++;
      }
      // Check if last move is complete
      const lastIdx = moves.length - 1;
      if (moveIdx === lastIdx &&
          globalElapsed >= schedule[lastIdx].start + schedule[lastIdx].duration + schedule[lastIdx].pause) {
        // Climb complete! Top out.
        // Climb complete — stop cleanly and show top-out
        stopped = true;
        // Move climber state off-screen so nothing bleeds through
        setState(prev => ({
          ...prev,
          leftHandOn: false, rightHandOn: false,
          leftFootOn: false, rightFootOn: false,
          lhX: 0, lhY: -5, rhX: 0, rhY: -5,
          lfX: 0, lfY: -5, rfX: 0, rfY: -5,
        }));
        setToppedOut(true); setIsPlaying(false);
        if (simRef.current) { cancelAnimationFrame(simRef.current); simRef.current = null; }
        return;
      }
      if (moveIdx !== currentMoveIdx) {
        // Update fatigue when transitioning to a new move
        const prevMove = moves[currentMoveIdx];
        if (!prevMove.isSetup && (prevMove.limb === "leftHand" || prevMove.limb === "rightHand")) {
          const holdDifficulty: Record<string, number> = {
            jug: 5, crimp: 15, sloper: 12, pinch: 14, pocket: 13, volume: 6,
            "foot-chip": 3, "foot-edge": 3, "smear-pad": 3,
          };
          const cost = holdDifficulty[prevMove.holdType || "jug"] || 8;
          const steepBonus = Math.max(0, stateRef.current.wallAngleDeg) * 0.15;
          const side = prevMove.limb === "leftHand" ? "left" : "right";
          const other = side === "left" ? "right" : "left";
          setFatigue(prev => ({
            [side]: Math.min(100, prev[side] + cost + steepBonus),
            [other]: Math.max(0, prev[other] - 3), // resting arm recovers
          } as { left: number; right: number }));
        }
        currentMoveIdx = moveIdx; setSimMoveIndex(moveIdx);
        setState((prev) => { snapRef.current = { ...prev }; return prev; });
      }

      const m = moves[moveIdx];
      const moveElapsed = globalElapsed - schedule[moveIdx].start;
      const rawT = Math.min(1, moveElapsed / m.duration);
      const snap = snapRef.current!;
      const kx = limbXKey(m.limb); const ky = limbYKey(m.limb);
      const fromX = snap[kx] as number; const fromY = snap[ky] as number;
      const toX = m.targetX; const toY = m.targetY;
      const bodyT = easeInOut(Math.min(1, rawT * 1.2));

      let limbT: number; let limbArcOffset = 0;
      if (m.isSetup) { limbT = easeInOut(rawT); }
      else if (rawT < 0.15) { limbT = 0; }
      else if (rawT < 0.25) {
        const phaseT = (rawT - 0.15) / 0.10;
        limbT = easeOut(phaseT) * 0.05; limbArcOffset = phaseT * m.arcHeight * 0.5;
      } else if (rawT < 0.85) {
        const phaseT = (rawT - 0.25) / 0.60;
        limbT = 0.05 + easeInOut(phaseT) * 0.85;
        limbArcOffset = Math.sin(phaseT * Math.PI) * m.arcHeight;
      } else {
        const phaseT = (rawT - 0.85) / 0.15;
        limbT = 0.90 + easeOut(phaseT) * 0.10;
        limbArcOffset = (1 - easeOut(phaseT)) * m.arcHeight * 0.15;
      }

      const currentLimbX = lerp(fromX, toX, limbT);
      const currentLimbY = lerp(fromY, toY, limbT);
      const isHand = m.limb === "leftHand" || m.limb === "rightHand";

      // Reach check
      if (!m.isSetup && rawT > 0.1 && rawT < 0.3) {
        const snap2 = snapRef.current!;
        const footMidX = (snap2.lfX + snap2.rfX) / 2;
        const footMidY = (snap2.lfY + snap2.rfY) / 2;
        if (isHand) {
          const sx = footMidX + (m.limb === "leftHand" ? -0.15 : 0.15);
          const sy = footMidY + 0.75;
          const armReach = (snap2.apeIndexIn / 2) * 0.0254 * (snap2.heightFt / 5.75);
          if (Math.sqrt((toX - sx) ** 2 + (toY - sy) ** 2) > armReach * 1.2) {
            stopped = true; triggerFall("reach"); return;
          }
        } else {
          const hx = footMidX + (m.limb === "leftFoot" ? -0.08 : 0.08);
          const hy = footMidY + 0.45;
          const legReach = 0.95 * (snap2.heightFt / 5.75);
          if (Math.sqrt((toX - hx) ** 2 + (toY - hy) ** 2) > legReach * 1.2) {
            stopped = true; triggerFall("reach"); return;
          }
        }
      }

      // Grip check
      if (!m.isSetup && isHand && rawT > 0.85) {
        const s = stateRef.current;
        const liveConfig: ClimberConfig = {
          bodyWeightKg: s.bodyWeightKg, gripStrengthKg: s.gripStrengthKg,
          heightFt: s.heightFt, apeIndexIn: s.apeIndexIn,
          bodyRotationDeg: s.bodyRotationDeg, wallAngleDeg: s.wallAngleDeg,
          leftHandPull: s.leftHandPull, rightHandPull: s.rightHandPull,
          leftFootPull: s.leftFootPull, rightFootPull: s.rightFootPull,
          leftKneeTurnDeg: s.leftKneeTurnDeg, rightKneeTurnDeg: s.rightKneeTurnDeg,
          hipOffset: s.hipOffset, torsoOffset: s.torsoOffset,
          leftHandOn: s.leftHandOn, rightHandOn: s.rightHandOn,
          leftFootOn: s.leftFootOn, rightFootOn: s.rightFootOn,
          leftHand: { x: s.lhX, y: s.lhY }, rightHand: { x: s.rhX, y: s.rhY },
          leftFoot: { x: s.lfX, y: s.lfY }, rightFoot: { x: s.rfX, y: s.rfY },
          centerOfGravity: { x: (s.lfX + s.rfX) / 2 + ((s.lhX + s.rhX) / 2 - (s.lfX + s.rfX) / 2) * 0.55, y: (s.lfY + s.rfY) / 2 + ((s.lhY + s.rhY) / 2 - (s.lfY + s.rfY) / 2) * 0.55 },
        };
        if (!computeForces(liveConfig).canHold) { stopped = true; triggerFall("grip"); return; }
      }

      const pullKey = m.limb === "leftHand" ? "leftHandPull" : m.limb === "rightHand" ? "rightHandPull" : m.limb === "leftFoot" ? "leftFootPull" : "rightFootPull";
      const isOH = state.wallAngleDeg > 10;
      const pullDir = m.holdType ? (isHand ? holdToPullHand(m.holdType, m.holdDirection) : holdToPullFoot(m.holdType, m.holdDirection, isOH)) : null;

      setState((prev) => {
        const arcTorsoBonus = isHand ? limbArcOffset * 0.15 : 0;

        // Weight shift anticipation: before a hand move, lean opposite
        // to load the standing foot and coil for the reach.
        let anticipationTwist = 0;
        let anticipationHipShift = 0;
        if (!m.isSetup && isHand && rawT < 0.15) {
          const antiT = easeInOut(rawT / 0.15); // 0→1 during wind-up
          const reachDir = toX - fromX; // positive = reaching right
          // Counter-rotate: lean opposite to reach direction
          anticipationTwist = -reachDir * 25 * antiT;
          // Shift hips toward the standing foot (opposite side of reach)
          anticipationHipShift = -reachDir * 0.08 * antiT;
        }

        const targetTwist = rawT < 0.15
          ? snap.bodyRotationDeg + anticipationTwist
          : m.bodyTwist;

        return {
          ...prev,
          [kx]: currentLimbX + anticipationHipShift,
          [ky]: currentLimbY,
          bodyRotationDeg: rawT < 0.15
            ? targetTwist
            : lerp(snap.bodyRotationDeg, m.bodyTwist, bodyT),
          hipOffset: Math.min(1, lerp(snap.hipOffset, m.hipOffset, bodyT)),
          torsoOffset: Math.min(1, lerp(snap.torsoOffset, m.torsoOffset, bodyT) + arcTorsoBonus),
          leftKneeTurnDeg: lerp(snap.leftKneeTurnDeg, m.leftKneeTurn, bodyT),
          rightKneeTurnDeg: lerp(snap.rightKneeTurnDeg, m.rightKneeTurn, bodyT),
          leftHandOn: true, rightHandOn: true, leftFootOn: true, rightFootOn: true,
          ...(pullDir ? { [pullKey]: pullDir } : {}),
        };
      });
      simRef.current = requestAnimationFrame(animate);
    };
    simRef.current = requestAnimationFrame(animate);
  }, [placedHolds, state.wallAngleDeg, state, stopSim, startHolds, selectedHoldType, selectedDirection, sittingOnGround, toppedOut, repositionAtStart]);

  useEffect(() => { return () => { if (simRef.current) cancelAnimationFrame(simRef.current); }; }, []);

  // Deferred restart after repositioning from a fall
  useEffect(() => {
    if (pendingRestartRef.current && !sittingOnGround && !toppedOut && !isPlaying) {
      pendingRestartRef.current = false;
      // Small delay to ensure state is settled
      requestAnimationFrame(() => startSim());
    }
  }, [sittingOnGround, toppedOut, isPlaying, startSim]);

  const set = useCallback((key: keyof ClimberState, value: number | string | boolean) => {
    setState((s) => ({ ...s, [key]: value }));
  }, []);

  const applyPreset = useCallback((name: string) => {
    const angleDeg = PRESET_ANGLES[name];
    if (angleDeg === undefined) return;
    setActivePreset(name);
    setWallSegments([{ height: 4, angleDeg }]);
    setState((prev) => ({
      ...prev, wallAngleDeg: angleDeg, ...comfortablePose(angleDeg),
      ...(angleDeg <= 0 ? { leftFootOn: true, rightFootOn: true } : {}),
    }));
  }, []);

  const applyTwist = useCallback((name: string) => {
    const t = TWIST_PRESETS[name];
    if (!t) return;
    setActiveTwist(name);
    setState((prev) => ({ ...prev, bodyRotationDeg: t.twist, leftKneeTurnDeg: t.lKnee, rightKneeTurnDeg: t.rKnee }));
  }, []);

  const config: ClimberConfig = useMemo(() => ({
    bodyWeightKg: state.bodyWeightKg, gripStrengthKg: state.gripStrengthKg,
    heightFt: state.heightFt, apeIndexIn: state.apeIndexIn,
    bodyRotationDeg: state.bodyRotationDeg, wallAngleDeg: state.wallAngleDeg,
    leftHandPull: state.leftHandPull, rightHandPull: state.rightHandPull,
    leftFootPull: state.leftFootPull, rightFootPull: state.rightFootPull,
    leftKneeTurnDeg: state.leftKneeTurnDeg, rightKneeTurnDeg: state.rightKneeTurnDeg,
    hipOffset: state.hipOffset, torsoOffset: state.torsoOffset,
    leftHandOn: state.leftHandOn, rightHandOn: state.rightHandOn,
    leftFootOn: state.leftFootOn, rightFootOn: state.rightFootOn,
    leftHand: { x: state.lhX, y: state.lhY }, rightHand: { x: state.rhX, y: state.rhY },
    leftFoot: { x: state.lfX, y: state.lfY }, rightFoot: { x: state.rfX, y: state.rfY },
    centerOfGravity: { x: (state.lfX + state.rfX) / 2 + ((state.lhX + state.rhX) / 2 - (state.lfX + state.rfX) / 2) * 0.55, y: (state.lfY + state.rfY) / 2 + ((state.lhY + state.rhY) / 2 - (state.lfY + state.rfY) / 2) * 0.55 },
  }), [state]);

  const forces = useMemo(() => computeForces(config), [config]);

  const togglePanel = (p: PanelType) => setActivePanel(prev => prev === p ? "none" : p);

  // ========================= RENDER =========================
  const pill: React.CSSProperties = {
    padding: "7px 10px", borderRadius: 8, border: "none", cursor: "pointer",
    fontSize: 12, fontFamily: "system-ui, -apple-system, sans-serif", fontWeight: 600,
    touchAction: "manipulation", color: "#fff", minHeight: 36, minWidth: 36,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
  };

  const chip: React.CSSProperties = {
    padding: "8px 12px", borderRadius: 8, border: "1px solid #444", cursor: "pointer",
    fontSize: 13, fontFamily: "system-ui, sans-serif", fontWeight: 500,
    touchAction: "manipulation", color: "#ddd", background: "rgba(50,50,50,0.9)",
    minHeight: 40,
  };

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* 3D Scene */}
      <ClimbingScene config={config} placedHolds={allHoldsOnWall} wallSegments={wallSegments}
        onWallClick={handleWallClick} onHoldClick={handleHoldClick}
        placingMode={placingMode} eraserMode={eraserMode}
        ragdollParts={ragdollParts} sittingOnGround={sittingOnGround} toppedOut={toppedOut} />

      {/* === SITTING MESSAGE === */}
      {sittingOnGround && !isPlaying && (
        <div style={{
          position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
          zIndex: 20, background: "rgba(0,0,0,0.75)", color: "#ff9944", padding: "8px 16px",
          borderRadius: 10, fontSize: 13, fontWeight: 600,
          backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
        }}>
          Fell off! Press Play to retry
        </div>
      )}

      {/* === TOPPED OUT MESSAGE === */}
      {toppedOut && !isPlaying && (
        <div style={{
          position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
          zIndex: 20, background: "rgba(0,100,0,0.85)", color: "#fff", padding: "10px 20px",
          borderRadius: 12, fontSize: 15, fontWeight: 700, textAlign: "center",
          backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
        }}>
          Sent! Press Play to climb again
        </div>
      )}

      {/* === TOP STATUS BAR === */}
      {isPlaying && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0,
          display: "flex", justifyContent: "center", padding: "12px 16px",
          zIndex: 20, pointerEvents: "none",
        }}>
          {isFalling ? (
            <div style={{
              background: "rgba(220,40,40,0.95)", color: "#fff", padding: "10px 20px",
              borderRadius: 12, fontSize: 15, fontWeight: 700, pointerEvents: "auto",
              backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
            }}>
              {fallReason === "grip" ? "Grip exceeded!" : "Can't reach hold!"}
            </div>
          ) : (
            <div style={{
              background: "rgba(0,0,0,0.75)", padding: "8px 14px",
              borderRadius: 10, fontSize: 13, fontWeight: 600,
              backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
              minWidth: 180,
            }}>
              <div style={{ color: "#4488ff" }}>
                Move {simMoveIndex + 1} / {movesRef.current.length}
              </div>
              {/* Grip bar */}
              {(() => {
                const grip = forces.gripStrengthPercentUsed;
                const gc = grip > 90 ? "#ff3333" : grip > 60 ? "#ffaa00" : "#44cc66";
                return (
                  <div style={{ width: "100%", fontSize: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2, color: "#999" }}>
                      <span>Grip</span>
                      <span style={{ color: gc }}>{Math.round(grip)}%</span>
                    </div>
                    <div style={{ height: 5, background: "#333", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{
                        width: `${Math.min(100, grip)}%`, height: "100%", background: gc,
                        borderRadius: 2, transition: "width 0.3s, background 0.3s",
                      }} />
                    </div>
                  </div>
                );
              })()}
              {/* Fatigue bars */}
              <div style={{ display: "flex", gap: 10, width: "100%", fontSize: 10 }}>
                {(["left", "right"] as const).map(side => {
                  const val = fatigue[side];
                  const color = val > 80 ? "#ff3333" : val > 50 ? "#ffaa00" : "#44cc66";
                  return (
                    <div key={side} style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2, color: "#999" }}>
                        <span>{side === "left" ? "L" : "R"} arm</span>
                        <span style={{ color }}>{Math.round(val)}%</span>
                      </div>
                      <div style={{ height: 4, background: "#333", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          width: `${val}%`, height: "100%", background: color,
                          borderRadius: 2, transition: "width 0.3s, background 0.3s",
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* === PLACING MODE INDICATOR === */}
      {placingMode && !isPlaying && (
        <div style={{
          position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
          zIndex: 20, display: "flex", gap: 8, alignItems: "center",
        }}>
          <div style={{
            background: eraserMode ? "rgba(200,80,40,0.9)" : "rgba(50,160,50,0.9)",
            color: "#fff", padding: "8px 16px", borderRadius: 10, fontSize: 14, fontWeight: 600,
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
          }}>
            {eraserMode ? "Tap hold to erase" : `Tap wall to place ${HOLD_INFO[selectedHoldType].label}`}
          </div>
        </div>
      )}

      {/* === FORCE BADGE (top right) === */}
      {!isPlaying && (
        <button onClick={() => togglePanel("forces")} style={{
          position: "absolute", top: 12, right: 12, zIndex: 20,
          background: forces.canHold ? "rgba(0,140,60,0.85)" : "rgba(200,30,30,0.85)",
          color: "#fff", border: "none", borderRadius: 10, padding: "8px 12px",
          fontSize: 12, fontWeight: 600, cursor: "pointer", touchAction: "manipulation",
          backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
          fontFamily: "system-ui, sans-serif",
        }}>
          {forces.gripStrengthPercentUsed.toFixed(0)}% grip
        </button>
      )}

      {/* === HOLD COUNT BADGE (top left) === */}
      {!isPlaying && placedHolds.length > 0 && (
        <div style={{
          position: "absolute", top: 12, left: 12, zIndex: 20,
          background: "rgba(0,0,0,0.7)", color: "#aaa", borderRadius: 10,
          padding: "8px 12px", fontSize: 12, fontWeight: 500,
          backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
        }}>
          {placedHolds.length} hold{placedHolds.length !== 1 ? "s" : ""}
        </div>
      )}

      {/* === BOTTOM ACTION BAR === */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 20,
        background: "rgba(20,20,25,0.95)", borderTop: "1px solid #333",
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        padding: "8px 10px calc(44px + env(safe-area-inset-bottom, 0px))",
        display: "flex", flexDirection: "column", alignItems: "center",
      }}><div style={{ width: "100%", maxWidth: 520 }}>
        {/* Main action buttons */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {!isPlaying ? (
            <>
              <button onClick={() => { togglePanel("routes"); setPlacingMode(false); }}
                style={{ ...pill, background: activePanel === "routes" ? "#4488ff" : "#333", flex: 1, maxWidth: 140 }}>
                Routes
              </button>
              <button onClick={() => {
                if (placingMode) { setPlacingMode(false); setEraserMode(false); setActivePanel("none"); }
                else { setPlacingMode(true); setActivePanel("holds"); }
              }}
                style={{ ...pill, background: placingMode ? "#44aa44" : "#333", flex: 1, maxWidth: 140 }}>
                {placingMode ? "Done" : "Place"}
              </button>
              <button onClick={startSim}
                style={{ ...pill, background: "#2266cc", flex: 1, maxWidth: 140 }}>
                &#9654; Play
              </button>
              <button onClick={() => togglePanel("settings")}
                style={{ ...pill, background: activePanel === "settings" ? "#4488ff" : "#333", width: 44, fontSize: 18 }}>
                &#9881;
              </button>
              {placedHolds.length > 0 && (
                <button onClick={shareRoute}
                  style={{ ...pill, background: showCopied ? "#44aa44" : "#555", flex: 1, maxWidth: 100 }}>
                  {showCopied ? "✓ Copied" : "↗ Share"}
                </button>
              )}
            </>
          ) : (
            <div style={{ display: "flex", gap: 6, flex: 1, maxWidth: 300 }}>
              <button onClick={stopSim}
                style={{ ...pill, background: "#cc3322", flex: 1 }}>
                &#9632; Stop
              </button>
              {!isFalling && (
                <button onClick={() => triggerFall("grip")}
                  style={{ ...pill, background: "#885522", flex: 1 }}>
                  &#128555; Fall
                </button>
              )}
            </div>
          )}
        </div>

        {/* Secondary actions when placing */}
        {placingMode && !isPlaying && (
          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8 }}>
            <button onClick={() => setEraserMode(!eraserMode)}
              style={{ ...chip, background: eraserMode ? "#cc6644" : "#333", fontSize: 12 }}>
              {eraserMode ? "Erasing" : "Eraser"}
            </button>
            {placedHolds.length > 0 && (
              <button onClick={undoHold} style={{ ...chip, fontSize: 12 }}>Undo</button>
            )}
            <button onClick={resetClimber} style={{ ...chip, fontSize: 12 }}>Reset</button>
            {placedHolds.length > 0 && (
              <button onClick={clearHolds} style={{ ...chip, fontSize: 12, color: "#ff6666" }}>Clear All</button>
            )}
          </div>
        )}

        {/* Non-placing secondary */}
        {!placingMode && !isPlaying && placedHolds.length > 0 && (
          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8 }}>
            <button onClick={resetClimber} style={{ ...chip, fontSize: 12 }}>Reset</button>
            <button onClick={clearHolds} style={{ ...chip, fontSize: 12, color: "#ff6666" }}>Clear All</button>
          </div>
        )}
      </div></div>

      {/* === BOTTOM SHEET PANELS === */}
      {activePanel !== "none" && !isPlaying && (
        <div style={{
          position: "absolute", bottom: placingMode ? 175 : placedHolds.length > 0 ? 155 : 115,
          left: "50%", transform: "translateX(-50%)",
          width: "100%", maxWidth: 520, zIndex: 15,
          maxHeight: "60vh", overflowY: "auto", WebkitOverflowScrolling: "touch",
          background: "rgba(20,20,28,0.97)", borderTop: "1px solid #444",
          borderRadius: "16px 16px 0 0",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          padding: "16px 16px 8px",
        }}>
          {/* Drag handle */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "#555" }} />
          </div>

          {/* --- ROUTES PANEL --- */}
          {activePanel === "routes" && (
            <div>
              <h3 style={{ margin: "0 0 12px", color: "#fff", fontSize: 16, fontWeight: 700 }}>Route Presets</h3>
              <div style={{ maxHeight: 260, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, paddingRight: 4 }}>
                  {ROUTE_PRESETS.map((r) => (
                    <button key={r.name} onClick={() => loadRoute(r)} style={{
                      padding: "12px", background: "#2a2a35", border: "1px solid #444",
                      borderRadius: 10, cursor: "pointer", touchAction: "manipulation",
                      textAlign: "left", color: "#fff",
                    }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{r.name}</div>
                      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                        {r.grade} &middot; {r.segments
                          ? `${r.segments.length} seg`
                          : r.wallAngle > 0 ? `${r.wallAngle}° OH` : r.wallAngle < 0 ? "Slab" : "Vert"}
                        &middot; {r.holds.length} holds
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* --- HOLDS PANEL --- */}
          {activePanel === "holds" && (
            <div>
              {/* Usage tabs + Direction in one row */}
              <div style={{ display: "flex", gap: 4, marginBottom: 6, alignItems: "center" }}>
                {(["both", "hand", "foot"] as HoldUsage[]).map((u) => (
                  <button key={u} onClick={() => {
                    setSelectedUsage(u);
                    if (u === "foot" && !["foot-chip", "foot-edge", "smear-pad"].includes(selectedHoldType))
                      setSelectedHoldType("foot-chip");
                  }} style={{
                    ...chip, padding: "4px 8px", fontSize: 11, textAlign: "center",
                    background: selectedUsage === u ? (u === "foot" ? "#2255aa" : u === "hand" ? "#aa4422" : "#227744") : "#2a2a35",
                    fontWeight: selectedUsage === u ? 700 : 500,
                  }}>
                    {u === "both" ? "Any" : u === "hand" ? "Hand" : "Foot"}
                  </button>
                ))}
                <span style={{ width: 1, height: 20, background: "#444", margin: "0 2px" }} />
                {(["up", "up-left", "up-right", "left", "right", "down-left", "down-right", "down"] as HoldDirection[]).map((d) => {
                  const arrows: Record<string, string> = {
                    "up": "\u2191", "down": "\u2193", "left": "\u2190", "right": "\u2192",
                    "up-left": "\u2196", "up-right": "\u2197", "down-left": "\u2199", "down-right": "\u2198",
                  };
                  return (
                    <button key={d} onClick={() => setSelectedDirection(d)} style={{
                      ...chip, padding: "4px 6px", fontSize: 13, textAlign: "center", minWidth: 28,
                      background: selectedDirection === d ? "#4488ff" : "#2a2a35",
                      color: selectedDirection === d ? "#fff" : "#999",
                      fontWeight: selectedDirection === d ? 700 : 400,
                    }}>
                      {arrows[d]}
                    </button>
                  );
                })}
              </div>

              {/* Hold type grid - compact horizontal strip */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(Object.keys(HOLD_INFO) as HoldType[]).map((type) => {
                  const info = HOLD_INFO[type];
                  const isFootType = type === "foot-chip" || type === "foot-edge" || type === "smear-pad";
                  if (selectedUsage === "hand" && isFootType) return null;
                  if (selectedUsage === "foot" && !isFootType && type === "pinch") return null;
                  return (
                    <button key={type} onClick={() => { setSelectedHoldType(type); setSelectedUsage(info.defaultUsage); }}
                      style={{
                        padding: "4px 8px", background: selectedHoldType === type ? "rgba(68,136,255,0.25)" : "#2a2a35",
                        border: selectedHoldType === type ? `2px solid ${info.color}` : "1px solid #444",
                        borderRadius: 8, cursor: "pointer", touchAction: "manipulation",
                        display: "flex", alignItems: "center", gap: 4, color: "#ddd",
                      }}>
                      <span style={{
                        width: 12, height: 12, borderRadius: type === "sloper" || type === "smear-pad" ? "50%" : 3,
                        background: info.color, flexShrink: 0,
                      }} />
                      <span style={{ fontSize: 10, fontWeight: 600, whiteSpace: "nowrap" }}>{info.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* --- SETTINGS PANEL --- */}
          {activePanel === "settings" && (
            <div>
              <h3 style={{ margin: "0 0 12px", color: "#fff", fontSize: 16, fontWeight: 700 }}>Settings</h3>

              {/* Wall angle presets */}
              <div style={{ color: "#888", fontSize: 12, marginBottom: 6, fontWeight: 600 }}>Wall Angle</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
                {Object.keys(PRESET_ANGLES).map((name) => (
                  <button key={name} onClick={() => applyPreset(name)} style={{
                    ...chip, fontSize: 12, padding: "6px 10px",
                    background: activePreset === name ? "#4488ff" : "#2a2a35",
                    fontWeight: activePreset === name ? 700 : 500,
                  }}>
                    {name}
                  </button>
                ))}
              </div>

              {/* Climber settings */}
              <div style={{ color: "#888", fontSize: 12, marginBottom: 6, fontWeight: 600 }}>Climber</div>
              <div style={{ background: "#1a1a22", borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <Slider label="Weight" value={state.bodyWeightKg} min={30} max={136} step={1} onChange={(v) => set("bodyWeightKg", v)} suffix={`kg / ${(state.bodyWeightKg * 2.20462).toFixed(0)} lbs`} />
                <Slider label="Grip" value={state.gripStrengthKg} min={10} max={100} step={1} onChange={(v) => set("gripStrengthKg", v)} suffix={`kg / ${(state.gripStrengthKg * 2.20462).toFixed(0)} lbs`} />
                <Slider label="Height" value={state.heightFt} min={4.5} max={7} step={0.08333} onChange={(v) => set("heightFt", v)} />
                <div style={{ fontSize: 11, color: "#666", marginBottom: 4, paddingLeft: 74 }}>
                  {feetToFtIn(state.heightFt)} / {(state.heightFt * 30.48).toFixed(0)}cm
                </div>
                <Slider label="Ape Index" value={state.apeIndexIn} min={54} max={84} step={0.5} onChange={(v) => set("apeIndexIn", v)} suffix='"' />
              </div>

              {/* Wall Segments */}
              <div style={{ color: "#888", fontSize: 12, marginBottom: 6, fontWeight: 600 }}>Wall Segments</div>
              <div style={{ background: "#1a1a22", borderRadius: 10, padding: 12, marginBottom: 10 }}>
                {wallSegments.map((seg, i) => (
                  <div key={i} style={{ marginBottom: 8, padding: 8, background: "#222233", borderRadius: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "#aaa", fontWeight: 600 }}>Segment {i + 1}</span>
                      {wallSegments.length > 1 && (
                        <button onClick={() => {
                          setWallSegments(prev => prev.filter((_, j) => j !== i));
                        }} style={{ background: "#553333", color: "#ff6666", border: "none", borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>✕</button>
                      )}
                    </div>
                    <Slider label="Height" value={seg.height} min={0.5} max={6} step={0.25} onChange={(v) => {
                      setWallSegments(prev => prev.map((s, j) => j === i ? { ...s, height: v } : s));
                    }} suffix="m" />
                    <Slider label="Angle" value={seg.angleDeg} min={-30} max={90} step={1} onChange={(v) => {
                      setWallSegments(prev => prev.map((s, j) => j === i ? { ...s, angleDeg: v } : s));
                      // Update climber wallAngleDeg to match where they are
                      const avgY = (state.lhY + state.rhY) / 2;
                      const newSegs = wallSegments.map((s, j) => j === i ? { ...s, angleDeg: v } : s);
                      const angle = angleAtHeight(avgY, newSegs);
                      setState(prev => ({ ...prev, wallAngleDeg: angle }));
                    }} suffix="°" />
                  </div>
                ))}
                <button onClick={() => {
                  const lastAngle = wallSegments[wallSegments.length - 1].angleDeg;
                  setWallSegments(prev => [...prev, { height: 2, angleDeg: lastAngle }]);
                }} style={{
                  width: "100%", padding: "6px", background: "#334455", color: "#88bbff", border: "1px solid #445566",
                  borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, marginBottom: 4,
                }}>+ Add Segment</button>
                <div style={{ fontSize: 10, color: "#666", textAlign: "center" }}>
                  Total: {totalWallHeight(wallSegments).toFixed(1)}m
                </div>
              </div>

              {/* Body position */}
              <div style={{ color: "#888", fontSize: 12, marginBottom: 6, fontWeight: 600 }}>Body Position</div>
              <div style={{ background: "#1a1a22", borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <Slider label="Twist" value={state.bodyRotationDeg} min={-90} max={90} step={1} onChange={(v) => set("bodyRotationDeg", v)} suffix="\u00b0" />
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                  {Object.keys(TWIST_PRESETS).map((name) => (
                    <button key={name} onClick={() => applyTwist(name)} style={{
                      ...chip, fontSize: 10, padding: "4px 8px",
                      background: activeTwist === name ? "#4488ff" : "#2a2a35",
                    }}>
                      {name}
                    </button>
                  ))}
                </div>
                <Slider label="Hip Dist" value={state.hipOffset} min={0} max={1} step={0.05} onChange={(v) => set("hipOffset", v)} />
                <Slider label="Torso" value={state.torsoOffset} min={0} max={1} step={0.05} onChange={(v) => set("torsoOffset", v)} />
              </div>

              {/* Limbs (collapsed sections) */}
              <div style={{ color: "#888", fontSize: 12, marginBottom: 6, fontWeight: 600 }}>Limb Positions</div>
              <div style={{ background: "#1a1a22", borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 12, color: "#ff8866", fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  Left Hand
                  <button onClick={() => set("leftHandOn", !state.leftHandOn)} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid #555", background: state.leftHandOn ? "#4a4" : "#a44", color: "#fff", cursor: "pointer" }}>{state.leftHandOn ? "On" : "Off"}</button>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <select value={state.leftHandPull} onChange={(e) => set("leftHandPull", e.target.value)}
                    style={{ flex: 1, background: "#333", color: "#eee", border: "1px solid #555", borderRadius: 6, padding: "6px 8px", fontSize: 13, fontFamily: "inherit" }}>
                    {HAND_PULL_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <Slider label="X" value={state.lhX} min={-1} max={1} step={0.05} onChange={(v) => set("lhX", v)} />
                <Slider label="Y" value={state.lhY} min={0} max={3} step={0.05} onChange={(v) => set("lhY", v)} />

                <div style={{ fontSize: 12, color: "#ff8866", fontWeight: 600, margin: "8px 0 4px", display: "flex", alignItems: "center", gap: 6 }}>
                  Right Hand
                  <button onClick={() => set("rightHandOn", !state.rightHandOn)} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid #555", background: state.rightHandOn ? "#4a4" : "#a44", color: "#fff", cursor: "pointer" }}>{state.rightHandOn ? "On" : "Off"}</button>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <select value={state.rightHandPull} onChange={(e) => set("rightHandPull", e.target.value)}
                    style={{ flex: 1, background: "#333", color: "#eee", border: "1px solid #555", borderRadius: 6, padding: "6px 8px", fontSize: 13, fontFamily: "inherit" }}>
                    {HAND_PULL_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <Slider label="X" value={state.rhX} min={-1} max={1} step={0.05} onChange={(v) => set("rhX", v)} />
                <Slider label="Y" value={state.rhY} min={0} max={3} step={0.05} onChange={(v) => set("rhY", v)} />

                <div style={{ fontSize: 12, color: "#6699ff", fontWeight: 600, margin: "8px 0 4px", display: "flex", alignItems: "center", gap: 6 }}>
                  Left Foot
                  <button onClick={() => set("leftFootOn", !state.leftFootOn)} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid #555", background: state.leftFootOn ? "#4a4" : "#a44", color: "#fff", cursor: "pointer" }}>{state.leftFootOn ? "On" : "Off"}</button>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <select value={state.leftFootPull} onChange={(e) => set("leftFootPull", e.target.value)}
                    style={{ flex: 1, background: "#333", color: "#eee", border: "1px solid #555", borderRadius: 6, padding: "6px 8px", fontSize: 13, fontFamily: "inherit" }}>
                    {FOOT_PULL_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <Slider label="X" value={state.lfX} min={-1} max={1} step={0.05} onChange={(v) => set("lfX", v)} />
                <Slider label="Y" value={state.lfY} min={0} max={2} step={0.05} onChange={(v) => set("lfY", v)} />
                <Slider label="Knee" value={state.leftKneeTurnDeg} min={-90} max={90} step={1} onChange={(v) => set("leftKneeTurnDeg", v)} suffix="\u00b0" />

                <div style={{ fontSize: 12, color: "#6699ff", fontWeight: 600, margin: "8px 0 4px", display: "flex", alignItems: "center", gap: 6 }}>
                  Right Foot
                  <button onClick={() => set("rightFootOn", !state.rightFootOn)} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid #555", background: state.rightFootOn ? "#4a4" : "#a44", color: "#fff", cursor: "pointer" }}>{state.rightFootOn ? "On" : "Off"}</button>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <select value={state.rightFootPull} onChange={(e) => set("rightFootPull", e.target.value)}
                    style={{ flex: 1, background: "#333", color: "#eee", border: "1px solid #555", borderRadius: 6, padding: "6px 8px", fontSize: 13, fontFamily: "inherit" }}>
                    {FOOT_PULL_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <Slider label="X" value={state.rfX} min={-1} max={1} step={0.05} onChange={(v) => set("rfX", v)} />
                <Slider label="Y" value={state.rfY} min={0} max={2} step={0.05} onChange={(v) => set("rfY", v)} />
                <Slider label="Knee" value={state.rightKneeTurnDeg} min={-90} max={90} step={1} onChange={(v) => set("rightKneeTurnDeg", v)} suffix="\u00b0" />
              </div>
            </div>
          )}

          {/* --- FORCES PANEL --- */}
          {activePanel === "forces" && <ForcePanel forces={forces} />}
        </div>
      )}
    </div>
  );
}

export default App;
