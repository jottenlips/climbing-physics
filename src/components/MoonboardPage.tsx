import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Line, Text } from "@react-three/drei";
import * as THREE from "three";
import { HoldType, HoldDirection, HoldUsage, HOLD_INFO, holdToPullHand, holdToPullFoot, PlacedHold, StartHolds, planRoute } from "../holds/holdTypes";
import { ClimberConfig, PullDirection, computeForces as computeClimberForces } from "../physics/climbingPhysics";
import { Climber, SittingClimber } from "./ClimbingScene";

// ---- Moonboard Hold ----
interface MoonboardHold {
  id: string;
  row: number; // 0-17 (bottom to top)
  col: number; // 0-10 (left to right)
  type: HoldType;
  direction: HoldDirection;
  usage: HoldUsage;
  isStart?: boolean;
  isFinish?: boolean;
}

let _mbHoldId = 0;
function makeMbHoldId(): string {
  return `mbh_${++_mbHoldId}_${Date.now()}`;
}

// ---- Preset routes ----
interface PresetRoute {
  name: string;
  grade: string;
  holds: Omit<MoonboardHold, "id">[];
}

const PRESET_ROUTES: PresetRoute[] = [
  {
    name: "Warm Up",
    grade: "V3",
    holds: [
      { row: 1, col: 3, type: "jug", direction: "up", usage: "foot", isStart: true },
      { row: 1, col: 7, type: "jug", direction: "up", usage: "foot", isStart: true },
      { row: 4, col: 4, type: "jug", direction: "up", usage: "both" },
      { row: 4, col: 6, type: "jug", direction: "up", usage: "both" },
      { row: 7, col: 3, type: "jug", direction: "up", usage: "both" },
      { row: 7, col: 7, type: "jug", direction: "up", usage: "both" },
      { row: 10, col: 5, type: "jug", direction: "up", usage: "both" },
      { row: 10, col: 3, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 13, col: 4, type: "jug", direction: "up", usage: "both" },
      { row: 13, col: 7, type: "jug", direction: "up", usage: "both" },
      { row: 16, col: 5, type: "jug", direction: "up", usage: "hand", isFinish: true },
      { row: 16, col: 6, type: "jug", direction: "up", usage: "hand", isFinish: true },
    ],
  },
  {
    name: "Side Pull Traverse",
    grade: "V4",
    holds: [
      { row: 1, col: 1, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 1, col: 3, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 4, col: 1, type: "jug", direction: "right", usage: "both" },
      { row: 4, col: 3, type: "jug", direction: "left", usage: "both" },
      { row: 6, col: 4, type: "crimp", direction: "right", usage: "hand" },
      { row: 7, col: 5, type: "sloper", direction: "up", usage: "both" },
      { row: 6, col: 3, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 9, col: 6, type: "crimp", direction: "left", usage: "hand" },
      { row: 9, col: 8, type: "pinch", direction: "up", usage: "hand" },
      { row: 8, col: 7, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 12, col: 7, type: "jug", direction: "up", usage: "both" },
      { row: 12, col: 9, type: "jug", direction: "up", usage: "both" },
      { row: 11, col: 8, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 15, col: 8, type: "jug", direction: "up", usage: "hand" },
      { row: 16, col: 9, type: "jug", direction: "up", usage: "hand", isFinish: true },
    ],
  },
  {
    name: "Crimp Line",
    grade: "V5",
    holds: [
      { row: 1, col: 4, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 1, col: 6, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 4, col: 5, type: "crimp", direction: "up", usage: "both" },
      { row: 4, col: 6, type: "crimp", direction: "up", usage: "both" },
      { row: 7, col: 4, type: "crimp", direction: "up-right", usage: "hand" },
      { row: 7, col: 7, type: "crimp", direction: "up-left", usage: "hand" },
      { row: 6, col: 5, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 6, col: 6, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 10, col: 5, type: "crimp", direction: "up", usage: "hand" },
      { row: 10, col: 6, type: "crimp", direction: "up", usage: "hand" },
      { row: 9, col: 5, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 13, col: 4, type: "crimp", direction: "up", usage: "hand" },
      { row: 13, col: 7, type: "crimp", direction: "up", usage: "hand" },
      { row: 12, col: 6, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 16, col: 5, type: "jug", direction: "up", usage: "hand", isFinish: true },
      { row: 16, col: 6, type: "jug", direction: "up", usage: "hand", isFinish: true },
    ],
  },
  {
    name: "Overhang Power",
    grade: "V6",
    holds: [
      { row: 1, col: 3, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 1, col: 7, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 3, col: 4, type: "jug", direction: "down", usage: "both" },
      { row: 3, col: 7, type: "jug", direction: "up", usage: "both" },
      { row: 6, col: 3, type: "pinch", direction: "up", usage: "hand" },
      { row: 6, col: 8, type: "sloper", direction: "up", usage: "hand" },
      { row: 5, col: 5, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 5, col: 6, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 9, col: 5, type: "crimp", direction: "up-left", usage: "hand" },
      { row: 9, col: 7, type: "pocket", direction: "up", usage: "hand" },
      { row: 8, col: 4, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 12, col: 4, type: "sloper", direction: "up-right", usage: "hand" },
      { row: 12, col: 6, type: "pinch", direction: "up", usage: "hand" },
      { row: 11, col: 5, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 15, col: 5, type: "jug", direction: "up", usage: "hand" },
      { row: 16, col: 5, type: "jug", direction: "up", usage: "hand", isFinish: true },
      { row: 16, col: 6, type: "jug", direction: "up", usage: "hand", isFinish: true },
    ],
  },
  {
    name: "Pinch & Twist",
    grade: "V5",
    holds: [
      { row: 1, col: 5, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 1, col: 6, type: "foot-edge", direction: "up", usage: "foot", isStart: true },
      { row: 4, col: 4, type: "pinch", direction: "up", usage: "both" },
      { row: 4, col: 7, type: "pinch", direction: "up", usage: "both" },
      { row: 7, col: 3, type: "pinch", direction: "right", usage: "hand" },
      { row: 7, col: 8, type: "pinch", direction: "left", usage: "hand" },
      { row: 6, col: 5, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 6, col: 6, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 10, col: 5, type: "pinch", direction: "up", usage: "hand" },
      { row: 10, col: 6, type: "sloper", direction: "up", usage: "hand" },
      { row: 9, col: 4, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 13, col: 4, type: "jug", direction: "up-right", usage: "hand" },
      { row: 13, col: 7, type: "jug", direction: "up-left", usage: "hand" },
      { row: 12, col: 5, type: "foot-edge", direction: "up", usage: "foot" },
      { row: 16, col: 5, type: "jug", direction: "up", usage: "hand", isFinish: true },
      { row: 16, col: 6, type: "jug", direction: "up", usage: "hand", isFinish: true },
    ],
  },
  {
    name: "Campus King",
    grade: "V7",
    holds: [
      { row: 2, col: 4, type: "jug", direction: "up", usage: "both", isStart: true },
      { row: 2, col: 7, type: "jug", direction: "up", usage: "both", isStart: true },
      { row: 6, col: 5, type: "crimp", direction: "up", usage: "hand" },
      { row: 6, col: 6, type: "crimp", direction: "up", usage: "hand" },
      { row: 5, col: 4, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 5, col: 7, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 10, col: 4, type: "crimp", direction: "up", usage: "hand" },
      { row: 10, col: 7, type: "crimp", direction: "up", usage: "hand" },
      { row: 9, col: 5, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 14, col: 5, type: "pocket", direction: "up", usage: "hand" },
      { row: 14, col: 6, type: "pocket", direction: "up", usage: "hand" },
      { row: 13, col: 5, type: "foot-chip", direction: "up", usage: "foot" },
      { row: 17, col: 5, type: "jug", direction: "up", usage: "hand", isFinish: true },
      { row: 17, col: 6, type: "jug", direction: "up", usage: "hand", isFinish: true },
    ],
  },
];

// ---- Material / lumber constants (imperial) ----
const WOOD_DENSITY_LB_FT3 = 35;
const PLYWOOD_DENSITY_LB_FT3 = 40;

const TWO_BY_SIX = { width: 1.5 / 12, depth: 5.5 / 12 };
const TWO_BY_FOUR = { width: 1.5 / 12, depth: 3.5 / 12 };
const SIX_BY_SIX = { width: 5.5 / 12, depth: 5.5 / 12 };

const ALLOWABLE_BENDING_PSF = 1000 * 144;
const E_MOD_PSF = 1_400_000 * 144;

const CHAIN_CAPACITY: Record<string, number> = {
  "3/16": 800,
  "1/4": 1300,
  "5/16": 1900,
  "3/8": 2650,
};

type FrameType = "2x6" | "2x4";

type BoardSize = "mini" | "full";

interface BoardConfig {
  boardSize: BoardSize;
  angleDeg: number;
  studSpacingIn: number;
  climberWeightLb: number;
  dynamicMultiplier: number;
  suspensionType: "chain" | "2x6-arms";
  numChains: number;
  chainSize: string;
  chainWallAnchor: "eye-bolt-stud" | "through-bolt";
  wallAnchorHeightFt: number;
  numWallAnchors: number;
  ceilingHeightFt: number;
  kickerHeightIn: number;
  frameType: FrameType;
}

const BOARD_WIDTH_FT = 8;
function getBoardHeightFt(size: BoardSize): number {
  return size === "full" ? 12 : 8;
}
function getBoardSheets(size: BoardSize): number {
  return size === "full" ? 3 : 2;
}
function getBoardRows(size: BoardSize): number {
  return size === "full" ? 25 : 17; // more rows on full board
}

const DEFAULT_CONFIG: BoardConfig = {
  boardSize: "mini",
  angleDeg: 40,
  studSpacingIn: 16,
  climberWeightLb: 180,
  dynamicMultiplier: 2.0,
  suspensionType: "chain",
  numChains: 4,
  chainSize: "1/4",
  chainWallAnchor: "eye-bolt-stud",
  wallAnchorHeightFt: 8,
  numWallAnchors: 4,
  ceilingHeightFt: 9,
  kickerHeightIn: 6,
  frameType: "2x6",
};

// ---- Physics calculations ----
interface BoardForceResult {
  boardWeightLb: number;
  plywoodWeightLb: number;
  frameWeightLb: number;
  kickerWeightLb: number;
  totalDeadLoadLb: number;
  climberForceLb: number;
  totalLoadLb: number;
  boardTopY: number;
  boardTopZ: number;
  kickerBaseZ: number;
  suspensionLengthFt: number;
  suspensionAngleDeg: number;
  wallAnchorY: number;
  wallAnchorZ: number;
  suspensionTensionLb: number;
  suspensionVerticalLb: number;
  suspensionHorizontalLb: number;
  totalSuspensionCapacityLb: number;
  suspensionSafetyFactor: number;
  armBucklingSafetyFactor: number;
  kickerCompressionLb: number;
  kickerBucklingSafetyFactor: number;
  anchorPullOutLb: number;
  anchorSafetyFactor: number;
  maxStudBendingMomentFtLb: number;
  studBendingSafetyFactor: number;
  maxStudDeflectionIn: number;
  overturningMomentFtLb: number;
  resistingMomentFtLb: number;
  momentSafetyFactor: number;
  safe: boolean;
  warnings: string[];
}

function getFrameDims(ft: FrameType) {
  return ft === "2x6" ? TWO_BY_SIX : TWO_BY_FOUR;
}

function computeBoardForces(cfg: BoardConfig): BoardForceResult {
  const warnings: string[] = [];
  const BOARD_H_FT = getBoardHeightFt(cfg.boardSize);
  const numSheets = getBoardSheets(cfg.boardSize);
  const angleRad = (cfg.angleDeg * Math.PI) / 180;
  const kickerFt = cfg.kickerHeightIn / 12;
  const frame = getFrameDims(cfg.frameType);

  const sectionMod = (frame.width * frame.depth ** 2) / 6;
  const momentInertia = (frame.width * frame.depth ** 3) / 12;

  const plywoodVolFt3 = numSheets * (4 * 8 * (0.75 / 12));
  const plywoodWeightLb = plywoodVolFt3 * PLYWOOD_DENSITY_LB_FT3;

  const numStuds = Math.floor(BOARD_WIDTH_FT / (cfg.studSpacingIn / 12)) + 1;
  const studVolEach = frame.width * frame.depth * BOARD_H_FT;
  const railVolEach = frame.width * frame.depth * BOARD_WIDTH_FT;
  const frameWeightLb = (numStuds * studVolEach + 3 * railVolEach) * WOOD_DENSITY_LB_FT3;

  const kickerVolFt3 = SIX_BY_SIX.width * SIX_BY_SIX.depth * BOARD_WIDTH_FT;
  const kickerWeightLb = kickerVolFt3 * WOOD_DENSITY_LB_FT3;

  const boardWeightLb = plywoodWeightLb + frameWeightLb;
  const totalDeadLoadLb = boardWeightLb + kickerWeightLb;

  const climberForceLb = cfg.climberWeightLb * cfg.dynamicMultiplier;
  const totalLoadLb = totalDeadLoadLb + climberForceLb;

  // Board geometry: hinge at kicker top-front edge, board extends up and out
  const kickerWidthFt = SIX_BY_SIX.width; // 6x6 cross-section = distance from wall to hinge
  const boardTopY = kickerFt + BOARD_H_FT * Math.cos(angleRad);
  const boardTopZ = kickerWidthFt + BOARD_H_FT * Math.sin(angleRad);
  const kickerBaseZ = boardTopZ; // how far out the board extends from wall

  // Wall anchor point (on the wall surface, Z ≈ 0)
  const wallAnchorY = cfg.wallAnchorHeightFt;
  const wallAnchorZ = 0;

  // Suspension geometry: from board top to wall anchor
  const suspDY = wallAnchorY - boardTopY;
  const suspDZ = wallAnchorZ - boardTopZ; // negative (chain goes toward wall)
  const suspensionLengthFt = Math.sqrt(suspDY ** 2 + suspDZ ** 2);
  // Angle from horizontal: steep = more vertical, shallow = more horizontal
  const suspAngleFromHoriz = Math.atan2(Math.abs(suspDY), Math.abs(suspDZ));
  const suspensionAngleDeg = (suspAngleFromHoriz * 180) / Math.PI;

  if (boardTopY > cfg.ceilingHeightFt) {
    warnings.push(`Board top (${boardTopY.toFixed(1)}') exceeds ceiling (${cfg.ceilingHeightFt}'). Reduce angle.`);
  }
  if (cfg.wallAnchorHeightFt > cfg.ceilingHeightFt) {
    warnings.push(`Wall anchor (${cfg.wallAnchorHeightFt}') is above ceiling (${cfg.ceilingHeightFt}').`);
  }

  // Overturning moment about the hinge (kicker base)
  // Board CG and climber position measured as horizontal distance from wall
  const boardCGZ = kickerWidthFt + (BOARD_H_FT / 2) * Math.sin(angleRad);
  const climberZ = kickerWidthFt + (BOARD_H_FT * 0.67) * Math.sin(angleRad);
  const overturningMomentFtLb = boardWeightLb * boardCGZ + climberForceLb * climberZ;

  // Suspension must provide horizontal force to resist overturning
  // The horizontal component of chain tension resists the moment
  // Chain tension decomposed: T_horiz = T * cos(suspAngle), T_vert = T * sin(suspAngle)
  // where suspAngle is from horizontal
  const numSusp = cfg.numChains;
  const totalHorizForceNeeded = overturningMomentFtLb / Math.max(boardTopY - kickerFt, 0.1);

  // Chain angle affects how much tension is needed for the required horizontal force
  // T = F_horiz / cos(angleFromHoriz) — shallower angle = lower tension
  // But if anchor is above board top, chain pulls UP and IN
  const cosAngle = Math.abs(suspDZ) / Math.max(suspensionLengthFt, 0.01);
  const sinAngle = Math.abs(suspDY) / Math.max(suspensionLengthFt, 0.01);

  const pullOutPerSusp = totalHorizForceNeeded / numSusp;
  // Tension per chain: horizontal component must equal pullOutPerSusp
  const suspensionTensionLb = cosAngle > 0.01 ? pullOutPerSusp / cosAngle : pullOutPerSusp;
  const suspensionHorizontalLb = pullOutPerSusp;
  const suspensionVerticalLb = suspensionTensionLb * sinAngle;

  let totalSuspensionCapacityLb: number;
  let suspensionSafetyFactor: number;
  let armBucklingSafetyFactor = Infinity;

  if (cfg.suspensionType === "chain") {
    totalSuspensionCapacityLb = numSusp * (CHAIN_CAPACITY[cfg.chainSize] ?? 1300);
    suspensionSafetyFactor = totalSuspensionCapacityLb / Math.max(numSusp * suspensionTensionLb, 1);
    if (suspensionSafetyFactor < 2) {
      warnings.push(`Chain safety factor is low (${suspensionSafetyFactor.toFixed(1)}x). Use heavier chain or more chains.`);
    }
  } else {
    const armLen = Math.max(suspensionLengthFt, 0.5);
    const eulerArm = (Math.PI ** 2 * E_MOD_PSF * momentInertia) / (armLen ** 2);
    armBucklingSafetyFactor = eulerArm / Math.max(suspensionTensionLb, 1);
    const armTensileCapacity = 3000;
    const armCapPerUnit = Math.min(eulerArm, armTensileCapacity);
    totalSuspensionCapacityLb = numSusp * armCapPerUnit;
    suspensionSafetyFactor = armCapPerUnit / Math.max(suspensionTensionLb, 1);
    if (armBucklingSafetyFactor < 2) {
      warnings.push(`2x6 arm buckling SF is low (${armBucklingSafetyFactor.toFixed(1)}x). Arms may need to be doubled.`);
    }
  }

  const resistingMomentFtLb = numSusp * suspensionHorizontalLb * (boardTopY - kickerFt);
  const momentSafetyFactor = resistingMomentFtLb / Math.max(overturningMomentFtLb, 1);

  const kickerCompressionLb = totalLoadLb;
  const I_6x6 = (SIX_BY_SIX.width * SIX_BY_SIX.depth ** 3) / 12;
  const eulerKicker = kickerFt > 0.01
    ? (Math.PI ** 2 * E_MOD_PSF * I_6x6) / (kickerFt ** 2) : Infinity;
  const kickerBucklingSafetyFactor = kickerCompressionLb > 0
    ? eulerKicker / kickerCompressionLb : Infinity;

  const anchorPullOutLb = (numSusp * suspensionTensionLb) / Math.max(cfg.numWallAnchors, 1);
  const anchorCapacity = cfg.chainWallAnchor === "through-bolt" ? 2000 : 500;
  const anchorSafetyFactor = anchorCapacity / Math.max(anchorPullOutLb, 1);

  if (anchorSafetyFactor < 2) {
    warnings.push(`Wall anchor SF is low (${anchorSafetyFactor.toFixed(1)}x). Use through-bolts or add more anchors.`);
  }

  // Stud bending: climber load distributed across adjacent studs via 3/4" plywood
  // Plywood distributes load over ~2 stud bays on each side of the contact point
  const studSpacingFt = cfg.studSpacingIn / 12;
  const distributionWidth = Math.min(4 * studSpacingFt, BOARD_WIDTH_FT); // load spreads ~2 bays each side
  const studsShareLoad = Math.max(2, Math.ceil(distributionWidth / studSpacingFt));
  const pointLoadOnStud = climberForceLb / studsShareLoad;
  // Simply supported stud with center point load (worst case)
  const maxStudBendingMomentFtLb = (pointLoadOnStud * BOARD_H_FT) / 4;
  const studBendingStressPsf = maxStudBendingMomentFtLb / sectionMod;
  const studBendingSafetyFactor = ALLOWABLE_BENDING_PSF / Math.max(studBendingStressPsf, 1);

  if (studBendingSafetyFactor < 1.5) {
    warnings.push(`Stud bending SF is low (${studBendingSafetyFactor.toFixed(1)}x). Consider closer stud spacing or 2x6s.`);
  }

  const maxStudDeflectionFt = (pointLoadOnStud * BOARD_H_FT ** 3) / (48 * E_MOD_PSF * momentInertia);
  const maxStudDeflectionIn = maxStudDeflectionFt * 12;

  if (maxStudDeflectionIn > 0.5) {
    warnings.push(`Stud deflection is ${maxStudDeflectionIn.toFixed(2)}" — board may feel bouncy.`);
  }

  if (cfg.angleDeg > 50) {
    warnings.push("Steep overhang (>50°) — high forces on suspension and anchors.");
  }

  if (cfg.frameType === "2x4" && cfg.angleDeg > 35) {
    warnings.push("2x4 frame on steep overhang — consider upgrading to 2x6 for stiffness.");
  }

  const safe = suspensionSafetyFactor >= 2
    && anchorSafetyFactor >= 2
    && studBendingSafetyFactor >= 1.5
    && kickerBucklingSafetyFactor >= 2
    && boardTopY <= cfg.ceilingHeightFt
    && maxStudDeflectionIn <= 1.0;

  if (safe && warnings.length === 0) {
    warnings.push("Design looks good! All safety factors are adequate.");
  }

  return {
    boardWeightLb, plywoodWeightLb, frameWeightLb, kickerWeightLb,
    totalDeadLoadLb, climberForceLb, totalLoadLb,
    boardTopY, boardTopZ, kickerBaseZ,
    suspensionLengthFt, suspensionAngleDeg, wallAnchorY, wallAnchorZ,
    suspensionTensionLb, suspensionVerticalLb, suspensionHorizontalLb,
    totalSuspensionCapacityLb, suspensionSafetyFactor, armBucklingSafetyFactor,
    kickerCompressionLb, kickerBucklingSafetyFactor,
    anchorPullOutLb, anchorSafetyFactor,
    maxStudBendingMomentFtLb, studBendingSafetyFactor, maxStudDeflectionIn,
    overturningMomentFtLb, resistingMomentFtLb, momentSafetyFactor,
    safe, warnings,
  };
}

// ---- Hold grid position to board-local coords ----
function holdToLocal(row: number, col: number, boardW: number, boardH: number, maxRows: number = 17): { x: number; y: number } {
  return {
    x: -boardW / 2 + 0.12 + col * (boardW - 0.24) / 10,
    y: 0.12 + row * (boardH - 0.24) / maxRows,
  };
}

// ---- Convert MoonboardHolds to PlacedHolds for planRoute ----
function mbHoldsToPlaced(holds: MoonboardHold[], boardW: number, boardH: number, maxRows: number = 17): PlacedHold[] {
  return holds.map(h => {
    const pos = holdToLocal(h.row, h.col, boardW, boardH, maxRows);
    return { id: h.id, x: pos.x, y: pos.y, type: h.type, direction: h.direction, usage: h.usage };
  });
}

// ---- Climber state for animation ----
interface MBClimberState {
  lhX: number; lhY: number;
  rhX: number; rhY: number;
  lfX: number; lfY: number;
  rfX: number; rfY: number;
  bodyRotationDeg: number;
  hipOffset: number;
  torsoOffset: number;
  leftKneeTurnDeg: number;
  rightKneeTurnDeg: number;
  leftHandPull: PullDirection;
  rightHandPull: PullDirection;
  leftFootPull: PullDirection;
  rightFootPull: PullDirection;
  leftHandOn: boolean;
  rightHandOn: boolean;
  leftFootOn: boolean;
  rightFootOn: boolean;
}

function limbXKey(limb: string): keyof MBClimberState {
  return limb === "leftHand" ? "lhX" : limb === "rightHand" ? "rhX" : limb === "leftFoot" ? "lfX" : "rfX";
}
function limbYKey(limb: string): keyof MBClimberState {
  return limb === "leftHand" ? "lhY" : limb === "rightHand" ? "rhY" : limb === "leftFoot" ? "lfY" : "rfY";
}
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function easeInOut(t: number) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
function easeOut(t: number) { return 1 - (1 - t) * (1 - t); }

// ---- Moonboard Climber (wraps full Climber with animation) ----
// Matches main app's animation system from App.tsx
function MoonboardClimberFull({ holds, boardW, boardH, climberWeightLb, angleDeg, isPlaying, onComplete, onFall, maxRows }: {
  holds: MoonboardHold[];
  boardW: number;
  boardH: number;
  climberWeightLb: number;
  angleDeg: number;
  isPlaying: boolean;
  onComplete: () => void;
  onFall: (reason: string) => void;
  maxRows: number;
}) {
  const colToX = useCallback((c: number) => -boardW / 2 + 0.12 + c * (boardW - 0.24) / 10, [boardW]);
  const isOverhang = angleDeg > 10;
  const heightFt = 5.75;
  const apeIndexIn = 72;
  const gripStrengthKg = 70;
  const bodyWeightKg = climberWeightLb / 2.20462;

  // Find start holds (lowest 2 hand-usable holds)
  const startInfo = useMemo(() => {
    const sorted = [...holds].sort((a, b) => a.row - b.row);
    const handUsable = sorted.filter(h => h.usage !== "foot");
    if (handUsable.length < 2) return null;
    const lh = handUsable[0];
    const rh = handUsable[1];
    const [left, right] = lh.col <= rh.col ? [lh, rh] : [rh, lh];
    const lhPos = holdToLocal(left.row, left.col, boardW, boardH, maxRows);
    const rhPos = holdToLocal(right.row, right.col, boardW, boardH, maxRows);
    return { left, right, lhPos, rhPos };
  }, [holds, boardW, boardH]);

  // Initial climber state: hands on start holds, feet on kicker
  const initialState = useMemo((): MBClimberState | null => {
    if (!startInfo) return null;
    return {
      lhX: startInfo.lhPos.x, lhY: startInfo.lhPos.y,
      rhX: startInfo.rhPos.x, rhY: startInfo.rhPos.y,
      lfX: colToX(4), lfY: -0.02,
      rfX: colToX(6), rfY: -0.02,
      bodyRotationDeg: 0,
      hipOffset: isOverhang ? 0.25 : 0.4,
      torsoOffset: 0.5,
      leftKneeTurnDeg: 0, rightKneeTurnDeg: 0,
      leftHandPull: "down", rightHandPull: "down",
      leftFootPull: "edge", rightFootPull: "edge",
      leftHandOn: true, rightHandOn: true,
      leftFootOn: true, rightFootOn: true,
    };
  }, [startInfo, isOverhang, colToX]);

  const [cState, setCState] = useState<MBClimberState | null>(null);
  const simRef = useRef<number | null>(null);
  const snapRef = useRef<MBClimberState | null>(null);
  const stateRef = useRef<MBClimberState | null>(null);
  const fatigueRef = useRef({ left: 0, right: 0 });

  // Keep stateRef current
  useEffect(() => { stateRef.current = cState; }, [cState]);

  // Reset to initial when not playing
  useEffect(() => {
    if (!isPlaying && initialState) {
      setCState(initialState);
      fatigueRef.current = { left: 0, right: 0 };
    }
  }, [isPlaying, initialState]);

  // Initialize on mount
  useEffect(() => {
    if (!cState && initialState) setCState(initialState);
  }, [initialState, cState]);

  // Stable callback refs to avoid effect re-triggering
  const onCompleteRef = useRef(onComplete);
  const onFallRef = useRef(onFall);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onFallRef.current = onFall; }, [onFall]);

  // Run animation when isPlaying changes to true
  useEffect(() => {
    if (!isPlaying || !startInfo || !initialState) return;

    // Reset to start position
    setCState(initialState);
    snapRef.current = { ...initialState };
    fatigueRef.current = { left: 0, right: 0 };

    // Convert holds to PlacedHold format for planRoute
    const placed = mbHoldsToPlaced(holds, boardW, boardH, maxRows);
    const lhPlaced: PlacedHold = { id: startInfo.left.id, x: startInfo.lhPos.x, y: startInfo.lhPos.y,
      type: startInfo.left.type, direction: startInfo.left.direction, usage: startInfo.left.usage };
    const rhPlaced: PlacedHold = { id: startInfo.right.id, x: startInfo.rhPos.x, y: startInfo.rhPos.y,
      type: startInfo.right.type, direction: startInfo.right.direction, usage: startInfo.right.usage };
    const sh: StartHolds = { leftHand: lhPlaced, rightHand: rhPlaced };

    const moves = planRoute(placed, angleDeg, sh);
    if (moves.length === 0) { onCompleteRef.current(); return; }

    let currentMoveIdx = 0;
    let stopped = false;
    const moveStartTime = performance.now();

    // Schedule timing for each move (matching main app: setup=50ms pause, regular=150ms)
    const schedule: { start: number; duration: number; pause: number }[] = [];
    let cumTime = 0;
    for (const m of moves) {
      const pause = m.isSetup ? 50 : 150;
      schedule.push({ start: cumTime, duration: m.duration, pause });
      cumTime += m.duration + pause;
    }

    // Fatigue cost per hold type (matching main app)
    const fatigueCost: Record<string, number> = {
      crimp: 15, sloper: 12, pinch: 14, pocket: 13, volume: 6, jug: 5,
      "foot-chip": 3, "foot-edge": 3,
    };
    const steepBonus = Math.max(0, angleDeg) * 0.15;

    const animate = (now: number) => {
      if (stopped) return;
      const globalElapsed = now - moveStartTime;

      let moveIdx = currentMoveIdx;
      while (moveIdx < moves.length - 1 &&
        globalElapsed >= schedule[moveIdx].start + schedule[moveIdx].duration + schedule[moveIdx].pause) {
        moveIdx++;
      }

      // Check if done
      const lastIdx = moves.length - 1;
      if (moveIdx === lastIdx &&
        globalElapsed >= schedule[lastIdx].start + schedule[lastIdx].duration + schedule[lastIdx].pause) {
        stopped = true;
        onCompleteRef.current();
        return;
      }

      // Move transition — capture snap and compute fatigue
      if (moveIdx !== currentMoveIdx) {
        const prevMove = moves[currentMoveIdx];
        currentMoveIdx = moveIdx;
        setCState(prev => { snapRef.current = prev ? { ...prev } : null; return prev; });

        // Fatigue tracking (matching main app)
        const m = moves[moveIdx];
        const isHand = m.limb === "leftHand" || m.limb === "rightHand";
        if (isHand && !m.isSetup && prevMove) {
          const cost = (fatigueCost[m.holdType ?? "jug"] ?? 5) + steepBonus;
          const side = m.limb === "leftHand" ? "left" : "right";
          const otherSide = side === "left" ? "right" : "left";
          fatigueRef.current[side] = Math.min(100, fatigueRef.current[side] + cost);
          fatigueRef.current[otherSide] = Math.max(0, fatigueRef.current[otherSide] - 3); // resting arm recovers
        }
      }

      const m = moves[moveIdx];
      const moveElapsed = globalElapsed - schedule[moveIdx].start;
      const rawT = Math.min(1, moveElapsed / m.duration);
      const snap = snapRef.current;
      if (!snap) { simRef.current = requestAnimationFrame(animate); return; }

      const kx = limbXKey(m.limb);
      const ky = limbYKey(m.limb);
      const fromX = snap[kx] as number;
      const fromY = snap[ky] as number;
      const toX = m.targetX;
      const toY = m.targetY;
      const bodyT = easeInOut(Math.min(1, rawT * 1.2));
      const isHand = m.limb === "leftHand" || m.limb === "rightHand";

      // Reach check (matching main app)
      if (!m.isSetup && rawT > 0.1 && rawT < 0.3) {
        const footMidX = (snap.lfX + snap.rfX) / 2;
        const footMidY = (snap.lfY + snap.rfY) / 2;
        if (isHand) {
          const sx = footMidX + (m.limb === "leftHand" ? -0.15 : 0.15);
          const sy = footMidY + 0.75;
          const armReach = (apeIndexIn / 2) * 0.0254 * (heightFt / 5.75);
          if (Math.sqrt((toX - sx) ** 2 + (toY - sy) ** 2) > armReach * 1.2) {
            stopped = true; onFallRef.current("reach"); return;
          }
        } else {
          // Leg reach check
          const hipMidY = (snap.lhY + snap.rhY + snap.lfY + snap.rfY) / 4;
          const legReach = 0.95 * (heightFt / 5.75);
          if (Math.sqrt((toX - fromX) ** 2 + (toY - hipMidY) ** 2) > legReach * 1.2) {
            stopped = true; onFallRef.current("reach"); return;
          }
        }
      }

      // Grip check using torque physics (matching main app)
      if (!m.isSetup && isHand && rawT > 0.85) {
        const s = stateRef.current;
        if (s) {
          const cogX = (s.lfX + s.rfX) / 2 + ((s.lhX + s.rhX) / 2 - (s.lfX + s.rfX) / 2) * 0.55;
          const cogY = (s.lfY + s.rfY) / 2 + ((s.lhY + s.rhY) / 2 - (s.lfY + s.rfY) / 2) * 0.55;
          const liveConfig: ClimberConfig = {
            bodyWeightKg, gripStrengthKg, heightFt, apeIndexIn,
            bodyRotationDeg: s.bodyRotationDeg,
            wallAngleDeg: angleDeg, // actual wall angle for physics
            leftHandPull: s.leftHandPull, rightHandPull: s.rightHandPull,
            leftFootPull: s.leftFootPull, rightFootPull: s.rightFootPull,
            leftKneeTurnDeg: s.leftKneeTurnDeg, rightKneeTurnDeg: s.rightKneeTurnDeg,
            hipOffset: s.hipOffset, torsoOffset: s.torsoOffset,
            leftHandOn: true, rightHandOn: true,
            leftFootOn: true, rightFootOn: true,
            leftHand: { x: s.lhX, y: s.lhY }, rightHand: { x: s.rhX, y: s.rhY },
            leftFoot: { x: s.lfX, y: s.lfY }, rightFoot: { x: s.rfX, y: s.rfY },
            centerOfGravity: { x: cogX, y: cogY },
          };
          const result = computeClimberForces(liveConfig);
          // Fatigue reduces effective grip
          const side = m.limb === "leftHand" ? "left" : "right";
          const fatigueMult = 1 - fatigueRef.current[side] / 250;
          if (!result.canHold || result.gripStrengthPercentUsed > 100 * fatigueMult) {
            stopped = true; onFallRef.current("grip"); return;
          }
        }
      }

      // Limb arc animation (matching main app 4-phase timing)
      let limbT: number;
      let limbArcOffset = 0;
      if (m.isSetup) {
        limbT = easeInOut(rawT);
      } else if (rawT < 0.15) {
        // Phase 1: no limb movement (weight shift only)
        limbT = 0;
      } else if (rawT < 0.25) {
        // Phase 2: limb starts lifting
        const phaseT = (rawT - 0.15) / 0.1;
        limbT = easeOut(phaseT) * 0.05;
        limbArcOffset = phaseT * m.arcHeight * 0.5;
      } else if (rawT < 0.85) {
        // Phase 3: main reach with full arc
        const phaseT = (rawT - 0.25) / 0.6;
        limbT = 0.05 + easeInOut(phaseT) * 0.85;
        limbArcOffset = Math.sin(phaseT * Math.PI) * m.arcHeight;
      } else {
        // Phase 4: landing approach
        const phaseT = (rawT - 0.85) / 0.15;
        limbT = 0.9 + easeOut(phaseT) * 0.1;
        limbArcOffset = (1 - easeOut(phaseT)) * m.arcHeight * 0.15;
      }

      const currentLimbX = lerp(fromX, toX, limbT);
      const currentLimbY = lerp(fromY, toY, limbT);

      const pullKey = m.limb === "leftHand" ? "leftHandPull"
        : m.limb === "rightHand" ? "rightHandPull"
        : m.limb === "leftFoot" ? "leftFootPull" : "rightFootPull";
      const pullDir = m.holdType
        ? (isHand ? holdToPullHand(m.holdType, m.holdDirection) : holdToPullFoot(m.holdType, m.holdDirection, isOverhang))
        : null;

      // Weight shift anticipation (matching main app)
      let anticipationTwist = 0;
      let anticipationHipShift = 0;
      if (!m.isSetup && isHand && rawT < 0.15) {
        const antiT = easeInOut(rawT / 0.15);
        const reachDir = toX - fromX;
        anticipationTwist = -reachDir * 25 * antiT;
        anticipationHipShift = -reachDir * 0.08 * antiT;
      }

      const arcTorsoBonus = isHand ? limbArcOffset * 0.15 : 0;

      setCState(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          [kx]: currentLimbX + anticipationHipShift,
          [ky]: currentLimbY,
          bodyRotationDeg: rawT < 0.15
            ? snap.bodyRotationDeg + anticipationTwist
            : lerp(snap.bodyRotationDeg, m.bodyTwist, bodyT),
          hipOffset: Math.min(1, lerp(snap.hipOffset, m.hipOffset, bodyT)),
          torsoOffset: Math.min(1, lerp(snap.torsoOffset, m.torsoOffset, bodyT) + arcTorsoBonus),
          leftKneeTurnDeg: lerp(snap.leftKneeTurnDeg, m.leftKneeTurn, bodyT),
          rightKneeTurnDeg: lerp(snap.rightKneeTurnDeg, m.rightKneeTurn, bodyT),
          leftHandOn: true, rightHandOn: true,
          leftFootOn: true, rightFootOn: true,
          ...(pullDir ? { [pullKey]: pullDir } : {}),
        };
      });

      simRef.current = requestAnimationFrame(animate);
    };

    simRef.current = requestAnimationFrame(animate);

    return () => {
      stopped = true;
      if (simRef.current) { cancelAnimationFrame(simRef.current); simRef.current = null; }
    };
  // Stable deps only — callbacks use refs, colToX is memoized
  }, [isPlaying, holds, boardW, boardH, angleDeg, bodyWeightKg, gripStrengthKg, heightFt, apeIndexIn, startInfo, initialState, isOverhang]);

  if (!cState) return null;

  const cogX = (cState.lfX + cState.rfX) / 2 + ((cState.lhX + cState.rhX) / 2 - (cState.lfX + cState.rfX) / 2) * 0.55;
  const cogY = (cState.lfY + cState.rfY) / 2 + ((cState.lhY + cState.rhY) / 2 - (cState.lfY + cState.rfY) / 2) * 0.55;

  // Render config: wallAngleDeg=0 because board group rotation handles overhang visually
  // But forces use the actual angle for correct torque physics
  const config: ClimberConfig = {
    bodyWeightKg, gripStrengthKg, heightFt, apeIndexIn,
    wallAngleDeg: angleDeg, // climber is outside board group, handles wall angle natively
    bodyRotationDeg: cState.bodyRotationDeg,
    leftHandPull: cState.leftHandPull, rightHandPull: cState.rightHandPull,
    leftFootPull: cState.leftFootPull, rightFootPull: cState.rightFootPull,
    leftKneeTurnDeg: cState.leftKneeTurnDeg, rightKneeTurnDeg: cState.rightKneeTurnDeg,
    hipOffset: cState.hipOffset, torsoOffset: cState.torsoOffset,
    leftHandOn: cState.leftHandOn, rightHandOn: cState.rightHandOn,
    leftFootOn: cState.leftFootOn, rightFootOn: cState.rightFootOn,
    leftHand: { x: cState.lhX, y: cState.lhY },
    rightHand: { x: cState.rhX, y: cState.rhY },
    leftFoot: { x: cState.lfX, y: cState.lfY },
    rightFoot: { x: cState.rfX, y: cState.rfY },
    centerOfGravity: { x: cogX, y: cogY },
  };

  const renderForces = computeClimberForces(config);
  return <Climber config={config} forces={renderForces} />;
}

// ---- Hold direction arrow ----
function directionRotationZ(dir: HoldDirection): number {
  switch (dir) {
    case "up": return 0;
    case "down": return Math.PI;
    case "left": return Math.PI / 2;
    case "right": return -Math.PI / 2;
    case "up-left": return Math.PI / 4;
    case "up-right": return -Math.PI / 4;
    case "down-left": return (Math.PI * 3) / 4;
    case "down-right": return (-Math.PI * 3) / 4;
  }
}

// ---- Hold 3D rendering ----
function MoonboardHold3D({ hold, boardW, boardH, onClick, eraserMode, maxRows = 17 }: {
  hold: MoonboardHold;
  boardW: number;
  boardH: number;
  onClick?: (id: string) => void;
  eraserMode?: boolean;
  maxRows?: number;
}) {
  const pos = holdToLocal(hold.row, hold.col, boardW, boardH, maxRows);
  const info = HOLD_INFO[hold.type];
  const baseColor = eraserMode ? "#ff4444" : info.color;
  const ringColor = hold.isStart ? "#00ff00" : hold.isFinish ? "#ff0000" : undefined;
  const dz = directionRotationZ(hold.direction);

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (onClick) onClick(hold.id);
  }, [onClick, hold.id]);

  return (
    <group>
      <mesh position={[pos.x, pos.y, 0.01]} rotation={[0, 0, dz]} onClick={handleClick}>
        <boxGeometry args={[0.08, 0.04, 0.03]} />
        <meshStandardMaterial color={baseColor} roughness={0.7} />
      </mesh>
      {/* Direction arrow */}
      {hold.direction !== "up" && (
        <mesh position={[pos.x, pos.y, 0.03]} rotation={[0, 0, dz]}>
          <coneGeometry args={[0.012, 0.025, 3]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.7} />
        </mesh>
      )}
      {ringColor && (
        <mesh position={[pos.x, pos.y, 0.035]}>
          <torusGeometry args={[0.04, 0.005, 8, 16]} />
          <meshBasicMaterial color={ringColor} />
        </mesh>
      )}
    </group>
  );
}

// ---- 3D Visualization ----
function BoardScene({ cfg, forces, holds, onBoardClick, onHoldClick, eraserMode, isPlaying, onComplete, onFall, showClimber }: {
  cfg: BoardConfig; forces: BoardForceResult;
  holds: MoonboardHold[];
  onBoardClick?: (row: number, col: number) => void;
  onHoldClick?: (id: string) => void;
  eraserMode?: boolean;
  isPlaying: boolean;
  onComplete: () => void;
  onFall: (reason: string) => void;
  showClimber: boolean;
}) {
  const angleRad = (cfg.angleDeg * Math.PI) / 180;
  const S = 0.3;
  const frame = getFrameDims(cfg.frameType);

  const BOARD_H_FT = getBoardHeightFt(cfg.boardSize);
  const numSheets = getBoardSheets(cfg.boardSize);
  const maxRows = getBoardRows(cfg.boardSize);
  const boardH = BOARD_H_FT * S;
  const boardW = BOARD_WIDTH_FT * S;
  const ceilH = cfg.ceilingHeightFt * S;

  const numStuds = Math.floor(BOARD_WIDTH_FT / (cfg.studSpacingIn / 12)) + 1;
  const studSpacing = boardW / Math.max(numStuds - 1, 1);
  const studW = frame.width * S;
  const studD = frame.depth * S;

  const postW = SIX_BY_SIX.width * S; // 6x6 cross-section dimension
  const kickerH = (cfg.kickerHeightIn / 12) * S; // kicker height off ground
  const fScale = S / 200;

  // Wall stud positions (16" OC, 12' wide wall)
  const wallStudPositions = useMemo(() => {
    const wallWidthScene = 12 * S;
    const studSpaceScene = (16 / 12) * S;
    const nStuds = Math.floor(wallWidthScene / studSpaceScene) + 1;
    return Array.from({ length: nStuds }, (_, i) => -wallWidthScene / 2 + i * studSpaceScene);
  }, []);

  // Chains/arms snap to nearest wall stud positions
  const chainPositions = useMemo(() => {
    // Generate ideal evenly-spaced positions across the board
    const ideal: number[] = [];
    for (let i = 0; i < cfg.numChains; i++) {
      ideal.push(-boardW / 2 + boardW * (i + 0.5) / cfg.numChains);
    }
    // Snap each to nearest wall stud, avoiding duplicates
    const used = new Set<number>();
    return ideal.map(ix => {
      let bestStud = wallStudPositions[0];
      let bestDist = Infinity;
      for (const sx of wallStudPositions) {
        const d = Math.abs(sx - ix);
        if (d < bestDist && !used.has(sx)) {
          bestDist = d;
          bestStud = sx;
        }
      }
      used.add(bestStud);
      return bestStud;
    });
  }, [cfg.numChains, boardW, wallStudPositions]);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 8, 5]} intensity={0.8} />
      <pointLight position={[-3, 4, 3]} intensity={0.3} />

      {/* Garage floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[12 * S, 8 * S]} />
        <meshStandardMaterial color="#555" roughness={0.9} />
      </mesh>

      {/* Back wall (transparent drywall) */}
      <mesh position={[0, ceilH / 2, -0.05]}>
        <planeGeometry args={[12 * S, ceilH + 0.1]} />
        <meshStandardMaterial color="#bbb" roughness={0.8} side={THREE.DoubleSide} transparent opacity={0.15} />
      </mesh>
      {/* Wall studs (2x4 @ 16" OC) */}
      {(() => {
        const wallWidthScene = 12 * S;
        const studSpaceFt = 16 / 12;
        const studSpaceScene = studSpaceFt * S;
        const twoByFourW = (1.5 / 12) * S;
        const twoByFourD = (3.5 / 12) * S;
        const nStuds = Math.floor(wallWidthScene / studSpaceScene) + 1;
        return Array.from({ length: nStuds }).map((_, i) => {
          const x = -wallWidthScene / 2 + i * studSpaceScene;
          return (
            <mesh key={`ws${i}`} position={[x, ceilH / 2, -0.05 - twoByFourD / 2]}>
              <boxGeometry args={[twoByFourW, ceilH, twoByFourD]} />
              <meshStandardMaterial color="#c4a46c" roughness={0.9} />
            </mesh>
          );
        });
      })()}
      {/* Wall plates */}
      {(() => {
        const wallWidthScene = 12 * S;
        const twoByFourD = (3.5 / 12) * S;
        const plateH = (1.5 / 12) * S;
        return [0.02, ceilH - 0.02].map((y, i) => (
          <mesh key={`plate${i}`} position={[0, y, -0.05 - twoByFourD / 2]}>
            <boxGeometry args={[wallWidthScene, plateH, twoByFourD]} />
            <meshStandardMaterial color="#b89a5c" roughness={0.9} />
          </mesh>
        ));
      })()}

      {/* Ceiling */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, ceilH, 4 * S]}>
        <planeGeometry args={[12 * S, 8 * S]} />
        <meshStandardMaterial color="#777" roughness={0.8} side={THREE.DoubleSide} transparent opacity={0.15} />
      </mesh>

      {/* Side walls */}
      {[-1, 1].map(side => (
        <mesh key={side} position={[side * 6 * S, ceilH / 2, 4 * S]} rotation={[0, side * Math.PI / 2, 0]}>
          <planeGeometry args={[8 * S, ceilH + 0.1]} />
          <meshStandardMaterial color="#887" roughness={0.85} side={THREE.DoubleSide} transparent opacity={0.2} />
        </mesh>
      ))}

      {/* === KICKER — single 6x6 x 8' post lying at wall base === */}
      <mesh position={[0, kickerH / 2, postW / 2]} rotation={[0, 0, Math.PI / 2]}>
        <boxGeometry args={[kickerH, BOARD_WIDTH_FT * S, postW]} />
        <meshStandardMaterial color="#8a6a3a" roughness={0.9} />
      </mesh>

      {/* Hinge bolts at kicker front-top edge */}
      {[-boardW / 3, 0, boardW / 3].map((x, i) => (
        <mesh key={`hinge${i}`} position={[x, kickerH, postW]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.06, 8]} />
          <meshStandardMaterial color="#888" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}

      {/* === BOARD (hinges at kicker front-top edge) === */}
      <group position={[0, kickerH, postW]} rotation={[angleRad, 0, 0]}>
        {/* Plywood sheets (4'x8' each, stacked vertically) */}
        {Array.from({ length: numSheets }).map((_, si) => {
          const sheetH = boardH / numSheets;
          const cy = sheetH * (si + 0.5);
          const colors = ["#d4a85c", "#cda055", "#c89a50"];
          return (
            <mesh key={`ply${si}`} position={[0, cy, 0.001]}>
              <planeGeometry args={[boardW, sheetH - 0.005]} />
              <meshStandardMaterial color={colors[si % colors.length]} roughness={0.7} side={THREE.DoubleSide} />
            </mesh>
          );
        })}
        {/* Plywood seam lines */}
        {Array.from({ length: numSheets - 1 }).map((_, si) => {
          const seamY = boardH * (si + 1) / numSheets;
          return <Line key={`seam${si}`} points={[[-boardW / 2, seamY, 0.003], [boardW / 2, seamY, 0.003]]} color="#9a7a4a" lineWidth={1.5} />;
        })}

        {/* Frame studs */}
        {Array.from({ length: numStuds }).map((_, i) => {
          const x = -boardW / 2 + i * studSpacing;
          return (
            <mesh key={`stud${i}`} position={[x, boardH / 2, -(studD / 2 + 0.002)]}>
              <boxGeometry args={[studW, boardH, studD]} />
              <meshStandardMaterial color="#c49a5c" roughness={0.85} />
            </mesh>
          );
        })}

        {/* Rails — top, bottom, and at each plywood seam */}
        {(() => {
          const railYs = [studW / 2, boardH - studW / 2];
          for (let si = 1; si < numSheets; si++) railYs.push(boardH * si / numSheets);
          return railYs.map((ry, i) => (
            <mesh key={`rail${i}`} position={[0, ry, -(studD / 2 + 0.002)]}>
              <boxGeometry args={[boardW, studW, studD]} />
              <meshStandardMaterial color="#b88a4c" roughness={0.85} />
            </mesh>
          ));
        })()}

        {/* Kicker foot chips — row of small footholds along bottom edge */}
        {Array.from({ length: 11 }).map((_, col) => {
          const x = -boardW / 2 + 0.12 + col * (boardW - 0.24) / 10;
          return (
            <group key={`kfc${col}`}>
              <mesh position={[x, -0.02, 0.005]}>
                <boxGeometry args={[0.04, 0.015, 0.02]} />
                <meshStandardMaterial color="#8899aa" roughness={0.8} />
              </mesh>
              {/* Small label dot */}
              <mesh position={[x, -0.035, 0.005]}>
                <circleGeometry args={[0.008, 6]} />
                <meshBasicMaterial color="#667788" />
              </mesh>
            </group>
          );
        })}

        {/* T-nut grid — clickable */}
        {Array.from({ length: maxRows + 1 }).map((_, row) =>
          Array.from({ length: 11 }).map((_, col) => {
            const p = holdToLocal(row, col, boardW, boardH, maxRows);
            const hasHold = holds.some(h => h.row === row && h.col === col);
            return (
              <mesh key={`tn${row}-${col}`} position={[p.x, p.y, 0.004]}
                onClick={(e: ThreeEvent<MouseEvent>) => {
                  e.stopPropagation();
                  if (onBoardClick && !hasHold) onBoardClick(row, col);
                }}>
                <circleGeometry args={[0.04, 8]} />
                <meshBasicMaterial color={hasHold ? "#44ff44" : "#777"} transparent opacity={hasHold ? 1 : 0.3} />
              </mesh>
            );
          })
        )}

        {/* Placed holds */}
        {holds.map(h => (
          <MoonboardHold3D key={h.id} hold={h} boardW={boardW} boardH={boardH}
            onClick={eraserMode ? onHoldClick : undefined} eraserMode={eraserMode} maxRows={maxRows} />
        ))}

      </group>

      {/* Full climber model — outside board group so Climber handles wall angle natively */}
      {showClimber && holds.length >= 2 && (
        <group position={[0, kickerH, postW]}>
          <MoonboardClimberFull holds={holds} boardW={boardW} boardH={boardH}
            climberWeightLb={cfg.climberWeightLb} angleDeg={cfg.angleDeg}
            isPlaying={isPlaying} onComplete={onComplete} onFall={onFall} maxRows={maxRows} />
        </group>
      )}

      {/* Sitting climber smoking under board when toggled off */}
      {!showClimber && (
        <group position={[boardW * 0.3, 0, postW + 0.5]} rotation={[0, -Math.PI * 0.3, 0]}>
          <SittingClimber scale={cfg.climberWeightLb > 200 ? 1.1 : 1.0} />
        </group>
      )}

      {/* === SUSPENSION (chains or 2x6 arms) === */}
      {chainPositions.map((x, i) => {
        const pivotY = kickerH;
        const pivotZ = postW;
        const boardTopWorldY = pivotY
          + boardH * Math.cos(angleRad)
          + (studD / 2) * Math.sin(angleRad);
        const boardTopWorldZ = pivotZ
          + boardH * Math.sin(angleRad)
          - (studD / 2) * Math.cos(angleRad);
        const wallAnchorWorldY = cfg.wallAnchorHeightFt * S;
        const suspStart: [number, number, number] = [x, boardTopWorldY, boardTopWorldZ];
        const suspEnd: [number, number, number] = [x, wallAnchorWorldY, -0.02];

        if (cfg.suspensionType === "chain") {
          const midY = (suspStart[1] + suspEnd[1]) / 2 - 0.03;
          const midZ = (suspStart[2] + suspEnd[2]) / 2;
          return (
            <group key={`susp${i}`}>
              <Line points={[suspStart, [x, midY, midZ], suspEnd]} color="#aaa" lineWidth={3} />
              <mesh position={suspStart}>
                <torusGeometry args={[0.03, 0.008, 8, 12]} />
                <meshStandardMaterial color="#bbb" metalness={0.8} roughness={0.3} />
              </mesh>
              <mesh position={suspEnd}>
                <torusGeometry args={[0.025, 0.006, 8, 12]} />
                <meshStandardMaterial color="#999" metalness={0.8} roughness={0.3} />
              </mesh>
            </group>
          );
        } else {
          const dx = suspEnd[0] - suspStart[0];
          const dy = suspEnd[1] - suspStart[1];
          const dz = suspEnd[2] - suspStart[2];
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const midPos: [number, number, number] = [
            (suspStart[0] + suspEnd[0]) / 2,
            (suspStart[1] + suspEnd[1]) / 2,
            (suspStart[2] + suspEnd[2]) / 2,
          ];
          const armAngle = Math.atan2(dz, dy);
          return (
            <group key={`susp${i}`}>
              <mesh position={midPos} rotation={[armAngle, 0, 0]}>
                <boxGeometry args={[studW, len, studD]} />
                <meshStandardMaterial color="#b89a5c" roughness={0.85} />
              </mesh>
              <mesh position={suspStart}>
                <boxGeometry args={[studW * 2, 0.02, studD * 2]} />
                <meshStandardMaterial color="#888" metalness={0.6} roughness={0.4} />
              </mesh>
              <mesh position={suspEnd}>
                <boxGeometry args={[studW * 2, 0.02, studD * 2]} />
                <meshStandardMaterial color="#888" metalness={0.6} roughness={0.4} />
              </mesh>
            </group>
          );
        }
      })}

      {/* Wall anchor points */}
      {chainPositions.map((x, i) => (
        <mesh key={`anchor${i}`} position={[x, cfg.wallAnchorHeightFt * S, -0.02]}>
          <cylinderGeometry args={[0.02, 0.02, 0.04, 8]} />
          <meshStandardMaterial color="#666" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}

      {/* === FORCE ARROWS === */}
      {(() => {
        const pivotY = kickerH;
        const pivotZ = postW;
        const btY = pivotY + boardH * Math.cos(angleRad) + (studD / 2) * Math.sin(angleRad);
        const btZ = pivotZ + boardH * Math.sin(angleRad) - (studD / 2) * Math.cos(angleRad);
        const cgY = pivotY + (boardH / 2) * Math.cos(angleRad);
        const cgZ = pivotZ + (boardH / 2) * Math.sin(angleRad);
        const wallAnchorY = cfg.wallAnchorHeightFt * S;

        return (
          <>
            <ForceArrow
              from={[boardW / 2 + 0.15, btY, btZ]}
              dir={[0, wallAnchorY - btY, -btZ]}
              magnitude={forces.suspensionTensionLb * cfg.numChains * fScale}
              color="#ffaa00"
              label={`${Math.round(forces.suspensionTensionLb * cfg.numChains)} lb ${cfg.suspensionType === "chain" ? "chains" : "arms"} total`}
            />
            <ForceArrow
              from={[boardW / 2 + 0.15, btY - 0.15, btZ]}
              dir={[0, wallAnchorY - btY, -btZ]}
              magnitude={forces.suspensionTensionLb * fScale}
              color="#cc8800"
              label={`${Math.round(forces.suspensionTensionLb)} lb each`}
            />
            <ForceArrow
              from={[-boardW / 2 - 0.15, cgY, cgZ]}
              dir={[0, -1, 0]}
              magnitude={forces.totalLoadLb * fScale}
              color="#4444ff"
              label={`${Math.round(forces.totalLoadLb)} lb gravity`}
            />
            <ForceArrow
              from={[-boardW / 2 - 0.15, cgY + 0.2, cgZ + 0.1]}
              dir={[0, -1, 0]}
              magnitude={forces.climberForceLb * fScale}
              color="#ff6644"
              label={`${Math.round(forces.climberForceLb)} lb climber (${cfg.dynamicMultiplier}x)`}
            />
            <ForceArrow
              from={[boardW / 2 + 0.15, kickerH / 2, postW / 2]}
              dir={[0, -1, 0]}
              magnitude={forces.kickerCompressionLb * fScale}
              color="#44cc44"
              label={`${Math.round(forces.kickerCompressionLb)} lb kicker`}
            />
            <ForceArrow
              from={[-boardW / 2 - 0.15, wallAnchorY, -0.05]}
              dir={[0, 0, 1]}
              magnitude={forces.anchorPullOutLb * fScale}
              color="#cc44cc"
              label={`${Math.round(forces.anchorPullOutLb)} lb/anchor (${cfg.numWallAnchors})`}
            />
            <ForceArrow
              from={[boardW / 2 + 0.15, cgY, cgZ]}
              dir={[0, 0, 1]}
              magnitude={forces.suspensionHorizontalLb * fScale}
              color="#ff44ff"
              label={`${Math.round(forces.suspensionHorizontalLb)} lb horiz. pull`}
            />
          </>
        );
      })()}

      {/* Dimension labels */}
      {(() => {
        const pivotY = kickerH;
        const pivotZ = postW;
        const btY = pivotY + boardH * Math.cos(angleRad);
        const btZ = pivotZ + boardH * Math.sin(angleRad);
        const cgY = (pivotY + btY) / 2;
        const cgZ = (pivotZ + btZ) / 2;
        return (
          <>
            <Text position={[-boardW / 2 - 0.4, cgY, cgZ]} fontSize={0.12} color="#fff" anchorX="right">
              8' x 8' board
            </Text>
            <Text position={[0, -0.15, btZ / 2]} fontSize={0.1} color="#ccc" anchorX="center">
              {(btZ / S).toFixed(1)}' from wall
            </Text>
            <Text position={[boardW / 2 + 0.5, btY + 0.1, btZ]} fontSize={0.1} color="#ddd" anchorX="left">
              {cfg.angleDeg}° overhang
            </Text>
            <Text position={[boardW / 2 + 0.5, ceilH, 0]} fontSize={0.09} color="#999" anchorX="left">
              {cfg.ceilingHeightFt}' ceiling
            </Text>
            <Text position={[boardW / 2 + 0.5, cfg.wallAnchorHeightFt * S, -0.1]} fontSize={0.09} color="#aaa" anchorX="left">
              {cfg.suspensionType === "chain" ? "chain" : "arm"}: {forces.suspensionLengthFt.toFixed(1)}'
            </Text>
          </>
        );
      })()}

      <OrbitControls target={[0, kickerH + boardH * Math.cos(angleRad) * 0.4, postW + boardH * Math.sin(angleRad) * 0.3]} />
    </>
  );
}

function ForceArrow({ from, dir, magnitude, color, label }: {
  from: [number, number, number]; dir: [number, number, number];
  magnitude: number; color: string; label: string;
}) {
  const len = Math.min(Math.abs(magnitude), 2);
  const norm = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
  const d: [number, number, number] = [dir[0] / norm, dir[1] / norm, dir[2] / norm];
  const to: [number, number, number] = [
    from[0] + d[0] * len,
    from[1] + d[1] * len,
    from[2] + d[2] * len,
  ];
  return (
    <group>
      <Line points={[from, to]} color={color} lineWidth={3} />
      <mesh position={to}>
        <coneGeometry args={[0.04, 0.1, 6]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <Text position={[to[0] + d[0] * 0.1, to[1] + d[1] * 0.1 + 0.08, to[2] + d[2] * 0.1]}
        fontSize={0.08} color={color} anchorX="center">
        {label}
      </Text>
    </group>
  );
}

// ---- UI Components ----
function sfColor(sf: number): string {
  if (sf >= 3) return "#44cc44";
  if (sf >= 2) return "#88cc44";
  if (sf >= 1.5) return "#cccc44";
  if (sf >= 1) return "#ff8844";
  return "#ff4444";
}

function SFBadge({ label, value }: { label: string; value: number }) {
  const display = value >= 100 ? "99+" : value.toFixed(1);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #333" }}>
      <span style={{ color: "#ccc", fontSize: 13 }}>{label}</span>
      <span style={{ color: sfColor(value), fontWeight: 700, fontSize: 13 }}>{display}x</span>
    </div>
  );
}

function ForceRow({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 }}>
      <span style={{ color: "#aaa" }}>{label}</span>
      <span style={{ color: "#eee" }}>{typeof value === "number" && value % 1 !== 0 ? value.toFixed(1) : Math.round(value)} {unit}</span>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#bbb", marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ color: "#fff" }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "#cc6633" }} />
    </div>
  );
}

// Direction selector arrows
const DIR_ARROWS: { dir: HoldDirection; label: string; gridArea: string }[] = [
  { dir: "up-left", label: "↖", gridArea: "1/1" },
  { dir: "up", label: "↑", gridArea: "1/2" },
  { dir: "up-right", label: "↗", gridArea: "1/3" },
  { dir: "left", label: "←", gridArea: "2/1" },
  { dir: "right", label: "→", gridArea: "2/3" },
  { dir: "down-left", label: "↙", gridArea: "3/1" },
  { dir: "down", label: "↓", gridArea: "3/2" },
  { dir: "down-right", label: "↘", gridArea: "3/3" },
];

// ---- Main Page ----
export default function MoonboardPage({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<BoardConfig>(DEFAULT_CONFIG);
  const update = useCallback((patch: Partial<BoardConfig>) => setCfg(c => {
    const next = { ...c, ...patch };
    // Wall anchors always match number of chains/arms
    next.numWallAnchors = next.numChains;
    return next;
  }), []);

  const forces = useMemo(() => computeBoardForces(cfg), [cfg]);

  // Hold placement state
  const [holds, setHolds] = useState<MoonboardHold[]>([
    { id: makeMbHoldId(), row: 3, col: 4, type: "jug", direction: "up", usage: "both", isStart: true },
    { id: makeMbHoldId(), row: 3, col: 6, type: "jug", direction: "up", usage: "both", isStart: true },
  ]);
  const [selectedHoldType, setSelectedHoldType] = useState<HoldType>("jug");
  const [selectedDirection, setSelectedDirection] = useState<HoldDirection>("up");
  const [placingMode, setPlacingMode] = useState(false);
  const [eraserMode, setEraserMode] = useState(false);
  const [holdMark, setHoldMark] = useState<"none" | "start" | "finish">("none");
  const [showClimber, setShowClimber] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [climbStatus, setClimbStatus] = useState<string | null>(null);

  const handleClimbComplete = useCallback(() => {
    setIsPlaying(false);
    setClimbStatus("Topped out!");
  }, []);
  const handleClimbFall = useCallback((reason: string) => {
    setIsPlaying(false);
    setClimbStatus(reason === "grip" ? "Lost grip - fell!" : reason === "reach" ? "Can't reach - fell!" : `Fell: ${reason}`);
  }, []);

  const handleBoardClick = useCallback((row: number, col: number) => {
    if (!placingMode || eraserMode) return;
    setHolds(prev => [...prev, {
      id: makeMbHoldId(),
      row, col,
      type: selectedHoldType,
      direction: selectedDirection,
      usage: HOLD_INFO[selectedHoldType].defaultUsage,
      isStart: holdMark === "start",
      isFinish: holdMark === "finish",
    }]);
  }, [placingMode, eraserMode, selectedHoldType, selectedDirection, holdMark]);

  const handleHoldClick = useCallback((id: string) => {
    if (eraserMode) {
      setHolds(prev => prev.filter(h => h.id !== id));
    }
  }, [eraserMode]);

  const loadPreset = useCallback((route: PresetRoute) => {
    setHolds(route.holds.map(h => ({ ...h, id: makeMbHoldId() })));
  }, []);

  const pill: React.CSSProperties = {
    border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600, color: "#fff",
  };

  const numStuds = Math.floor(BOARD_WIDTH_FT / (cfg.studSpacingIn / 12)) + 1;

  // Mobile panel state
  const [mobileTab, setMobileTab] = useState<"3d" | "config" | "results">("3d");
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const isMobile = windowWidth < 768;

  const mobileTabBtn = (tab: "3d" | "config" | "results", label: string) => (
    <button key={tab} onClick={() => setMobileTab(tab)}
      style={{ flex: 1, border: "none", padding: "8px 4px", fontSize: 12, fontWeight: 700, cursor: "pointer",
        color: mobileTab === tab ? "#fff" : "#888",
        background: mobileTab === tab ? "#cc6633" : "#333",
        borderBottom: mobileTab === tab ? "2px solid #ff8844" : "2px solid transparent",
      }}>
      {label}
    </button>
  );

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: isMobile ? "column" : "row",
      fontFamily: "system-ui, -apple-system, sans-serif", background: "#1a1a1a" }}>

      {/* Mobile tab bar */}
      {isMobile && (
        <div style={{ display: "flex", background: "#222", borderBottom: "1px solid #444", flexShrink: 0 }}>
          <button onClick={onBack} style={{ ...pill, background: "#555", padding: "8px 12px", fontSize: 11, borderRadius: 0 }}>Back</button>
          {mobileTabBtn("3d", "3D View")}
          {mobileTabBtn("config", "Config")}
          {mobileTabBtn("results", "Results")}
        </div>
      )}

      {/* Left panel — controls */}
      <div style={{ overflowY: "auto", padding: isMobile ? 12 : 16, background: "#222",
        ...(isMobile
          ? { flex: 1, display: mobileTab === "config" ? "block" : "none" }
          : { width: 300, minWidth: 300, height: "100%", borderRight: "1px solid #444" }),
      }}>
        {!isMobile && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <button onClick={onBack} style={{ ...pill, background: "#555", padding: "6px 12px", fontSize: 12 }}>Back</button>
          <h2 style={{ color: "#cc6633", fontSize: 18, margin: 0 }}>Moonboard Builder</h2>
        </div>
        )}

        {/* Board size toggle */}
        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Board Size</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {(["mini", "full"] as BoardSize[]).map(s => (
              <button key={s} onClick={() => update({ boardSize: s })}
                style={{ ...pill, padding: "5px 14px", fontSize: 12,
                  background: cfg.boardSize === s ? "#cc6633" : "#444" }}>
                {s === "mini" ? "Mini (8'x8')" : "Full (8'x12')"}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#aaccaa" }}>
            {getBoardSheets(cfg.boardSize)}x 4'x8' sheets of 3/4" plywood ({BOARD_WIDTH_FT}' x {getBoardHeightFt(cfg.boardSize)}' board)
          </div>
        </div>

        {/* Preset Routes */}
        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Preset Routes</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {PRESET_ROUTES.map((route, i) => (
              <button key={i} onClick={() => loadPreset(route)}
                style={{ ...pill, padding: "4px 8px", fontSize: 10, background: "#444" }}>
                {route.name} ({route.grade})
              </button>
            ))}
          </div>
        </div>

        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Board Angle</div>
          <Slider label="Overhang Angle" value={cfg.angleDeg} min={15} max={55} step={1} unit="°" onChange={v => update({ angleDeg: v })} />
          <Slider label="Ceiling Height" value={cfg.ceilingHeightFt} min={7} max={14} step={0.5} unit="'" onChange={v => update({ ceilingHeightFt: v })} />
          <div style={{ fontSize: 11, color: "#888" }}>
            Board top: {forces.boardTopY.toFixed(1)}' &bull; Standoff: {forces.kickerBaseZ.toFixed(1)}' from wall
          </div>
        </div>

        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Kicker Post</div>
          <Slider label="Post Height" value={cfg.kickerHeightIn} min={4} max={12} step={1} unit='"' onChange={v => update({ kickerHeightIn: v })} />
          <div style={{ fontSize: 11, color: "#888" }}>
            6x6 post at base — keeps board off floor
          </div>
        </div>

        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Frame Construction</div>
          {/* Frame type toggle */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {(["2x6", "2x4"] as FrameType[]).map(t => (
              <button key={t} onClick={() => update({ frameType: t })}
                style={{ ...pill, padding: "4px 10px", fontSize: 11,
                  background: cfg.frameType === t ? "#cc6633" : "#444" }}>
                {t} Frame
              </button>
            ))}
          </div>
          <Slider label="Stud Spacing" value={cfg.studSpacingIn} min={12} max={32} step={2} unit='"' onChange={v => update({ studSpacingIn: v })} />
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
            {numStuds} studs ({cfg.frameType} SPF) + 3 rails (top, mid-seam, bottom)
          </div>
          <div style={{ fontSize: 11, color: "#888" }}>
            Plywood: {Math.round(forces.plywoodWeightLb)} lb &bull; Frame: {Math.round(forces.frameWeightLb)} lb
          </div>
        </div>

        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Suspension</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {(["chain", "2x6-arms"] as const).map(t => (
              <button key={t} onClick={() => update({ suspensionType: t })}
                style={{ ...pill, padding: "4px 10px", fontSize: 11,
                  background: cfg.suspensionType === t ? "#cc6633" : "#444" }}>
                {t === "chain" ? "Chains" : "2x6 Arms"}
              </button>
            ))}
          </div>
          <Slider label={cfg.suspensionType === "chain" ? "Number of Chains" : "Number of Arms"} value={cfg.numChains} min={2} max={6} step={1} unit="" onChange={v => update({ numChains: v })} />
          {cfg.suspensionType === "chain" && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
              {Object.keys(CHAIN_CAPACITY).map(size => (
                <button key={size} onClick={() => update({ chainSize: size })}
                  style={{ ...pill, padding: "3px 8px", fontSize: 11,
                    background: cfg.chainSize === size ? "#cc6633" : "#444" }}>
                  {size}" ({CHAIN_CAPACITY[size]} lb)
                </button>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, color: "#888" }}>
            Length needed: {forces.suspensionLengthFt.toFixed(1)}' each &bull; Attaches to wall behind
          </div>
        </div>

        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Wall Anchors</div>
          <Slider label="Anchor Height on Wall" value={cfg.wallAnchorHeightFt} min={4} max={12} step={0.5} unit="'" onChange={v => update({ wallAnchorHeightFt: v })} />
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {(["eye-bolt-stud", "through-bolt"] as const).map(t => (
              <button key={t} onClick={() => update({ chainWallAnchor: t })}
                style={{ ...pill, padding: "4px 10px", fontSize: 11,
                  background: cfg.chainWallAnchor === t ? "#cc6633" : "#444" }}>
                {t === "eye-bolt-stud" ? "Eye Bolts" : "Through-Bolts"}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#888" }}>
            {cfg.numChains} anchor points (1 per {cfg.suspensionType === "chain" ? "chain" : "arm"})
          </div>
        </div>

        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Loading</div>
          <Slider label="Climber Weight" value={cfg.climberWeightLb} min={100} max={250} step={5} unit=" lb" onChange={v => update({ climberWeightLb: v })} />
          <Slider label="Dynamic Multiplier" value={cfg.dynamicMultiplier} min={1.0} max={3.0} step={0.1} unit="x"
            onChange={v => update({ dynamicMultiplier: v })} />
          <div style={{ fontSize: 11, color: "#888", marginTop: -4 }}>
            1.0 = static hang, 2.0 = dynamic move, 3.0 = campus/dyno
          </div>
        </div>
      </div>

      {/* Center — 3D view */}
      <div style={{ flex: 1, position: "relative",
        ...(isMobile ? { display: mobileTab === "3d" ? "flex" : "none", flexDirection: "column" as const, minHeight: 0 } : {}),
      }}>
        <Canvas camera={{ position: isMobile ? [6, 2.5, 6] : [5, 2, 5], fov: isMobile ? 55 : 50 }} style={{ background: "#1a1a1a", flex: 1 }}>
          <BoardScene cfg={cfg} forces={forces} holds={holds}
            onBoardClick={placingMode ? handleBoardClick : undefined}
            onHoldClick={eraserMode ? handleHoldClick : undefined}
            eraserMode={eraserMode}
            isPlaying={isPlaying} onComplete={handleClimbComplete} onFall={handleClimbFall}
            showClimber={showClimber} />
        </Canvas>
        {/* Hold placement toolbar */}
        <div style={{ position: "absolute", bottom: isMobile ? 4 : 16, left: isMobile ? 4 : 16, right: isMobile ? 4 : 16,
          background: "rgba(0,0,0,0.9)", borderRadius: isMobile ? 8 : 12, padding: isMobile ? "6px 8px" : "8px 12px" }}>
          <div style={{ display: "flex", gap: isMobile ? 4 : 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => { setPlacingMode(!placingMode); setEraserMode(false); }}
              style={{ border: "none", borderRadius: 8, padding: isMobile ? "5px 8px" : "6px 14px", cursor: "pointer",
                fontWeight: 600, fontSize: isMobile ? 11 : 12,
                color: "#fff", background: placingMode ? "#cc6633" : "#555" }}>
              {placingMode ? "Placing" : "Place"}
            </button>
            <button onClick={() => { setEraserMode(!eraserMode); setPlacingMode(false); }}
              style={{ border: "none", borderRadius: 8, padding: isMobile ? "5px 8px" : "6px 14px", cursor: "pointer",
                fontWeight: 600, fontSize: isMobile ? 11 : 12,
                color: "#fff", background: eraserMode ? "#ff4444" : "#555" }}>
              Erase
            </button>

            {placingMode && (
              <>
                <span style={{ color: "#555", fontSize: 11 }}>|</span>
                {/* Hold types */}
                {(["jug", "crimp", "sloper", "pinch", "pocket", "foot-chip", "foot-edge"] as HoldType[]).map(t => (
                  <button key={t} onClick={() => setSelectedHoldType(t)}
                    style={{ border: "none", borderRadius: 6, padding: isMobile ? "3px 5px" : "4px 8px",
                      cursor: "pointer", fontSize: isMobile ? 9 : 10, fontWeight: 600,
                      color: "#fff", background: selectedHoldType === t ? HOLD_INFO[t].color : "#444" }}>
                    {HOLD_INFO[t].label}
                  </button>
                ))}
                <span style={{ color: "#555", fontSize: 11 }}>|</span>
                {/* Markers */}
                {(["none", "start", "finish"] as const).map(m => (
                  <button key={m} onClick={() => setHoldMark(m)}
                    style={{ border: "none", borderRadius: 6, padding: isMobile ? "3px 5px" : "4px 8px", cursor: "pointer",
                      fontSize: isMobile ? 9 : 10, fontWeight: 600,
                      color: "#fff", background: holdMark === m ? (m === "start" ? "#00cc00" : m === "finish" ? "#cc0000" : "#666") : "#444" }}>
                    {m === "none" ? "Normal" : m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </>
            )}

            <span style={{ color: "#555", fontSize: 11 }}>|</span>
            <button onClick={() => { setShowClimber(!showClimber); if (!showClimber) { setIsPlaying(false); setClimbStatus(null); } }}
              style={{ border: "none", borderRadius: 8, padding: isMobile ? "5px 8px" : "6px 14px", cursor: "pointer",
                fontWeight: 600, fontSize: isMobile ? 11 : 12,
                color: "#fff", background: showClimber ? "#cc6633" : "#555" }}>
              {showClimber ? "Climber" : "No Climber"}
            </button>
            {showClimber && holds.length >= 2 && (
              <button onClick={() => {
                if (isPlaying) { setIsPlaying(false); setClimbStatus(null); }
                else { setClimbStatus(null); setIsPlaying(true); setPlacingMode(false); setEraserMode(false); }
              }}
                style={{ border: "none", borderRadius: 8, padding: isMobile ? "5px 8px" : "6px 14px", cursor: "pointer",
                  fontWeight: 600, fontSize: isMobile ? 11 : 12,
                  color: "#fff", background: isPlaying ? "#ff4444" : "#44aa44" }}>
                {isPlaying ? "Stop" : "Play"}
              </button>
            )}
            {climbStatus && (
              <span style={{ color: climbStatus.includes("Topped") ? "#44cc44" : "#ff6644", fontSize: 12, fontWeight: 700 }}>
                {climbStatus}
              </span>
            )}

            <span style={{ color: "#888", fontSize: isMobile ? 10 : 11, marginLeft: "auto" }}>{holds.length} holds</span>
            {holds.length > 0 && (
              <button onClick={() => setHolds([])}
                style={{ border: "none", borderRadius: 6, padding: isMobile ? "3px 6px" : "4px 8px", cursor: "pointer",
                  fontSize: isMobile ? 10 : 11, fontWeight: 600, color: "#fff", background: "#666" }}>
                Clear
              </button>
            )}
          </div>

          {/* Direction selector (shown when placing) */}
          {placingMode && (
            <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, marginTop: isMobile ? 4 : 8 }}>
              <span style={{ color: "#888", fontSize: isMobile ? 10 : 11 }}>Direction:</span>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(3, ${isMobile ? 24 : 28}px)`, gridTemplateRows: `repeat(3, ${isMobile ? 20 : 24}px)`, gap: 2 }}>
                {DIR_ARROWS.map(({ dir, label, gridArea }) => (
                  <button key={dir} onClick={() => setSelectedDirection(dir)}
                    style={{
                      gridArea, border: "none", borderRadius: 4, cursor: "pointer",
                      fontSize: 14, fontWeight: 700, padding: 0,
                      color: selectedDirection === dir ? "#fff" : "#888",
                      background: selectedDirection === dir ? "#cc6633" : "#333",
                    }}>
                    {label}
                  </button>
                ))}
                {/* Center dot (no direction = up) */}
                <button onClick={() => setSelectedDirection("up")}
                  style={{
                    gridArea: "2/2", border: "none", borderRadius: 4, cursor: "pointer",
                    fontSize: 10, fontWeight: 700, padding: 0,
                    color: selectedDirection === "up" ? "#fff" : "#888",
                    background: selectedDirection === "up" ? "#cc6633" : "#333",
                  }}>
                  •
                </button>
              </div>
              <span style={{ color: "#666", fontSize: 10 }}>{selectedDirection}</span>
            </div>
          )}
        </div>
      </div>

      {/* Right panel — results */}
      <div style={{ overflowY: "auto", padding: isMobile ? 12 : 16, background: "#222",
        ...(isMobile
          ? { flex: 1, display: mobileTab === "results" ? "block" : "none" }
          : { width: 280, minWidth: 280, height: "100%", borderLeft: "1px solid #444" }),
      }}>
        {/* Verdict */}
        <div style={{
          background: forces.safe ? "#1a3a1a" : "#3a1a1a",
          border: `2px solid ${forces.safe ? "#44cc44" : "#ff4444"}`,
          borderRadius: 10, padding: 12, marginBottom: 12, textAlign: "center",
        }}>
          <div style={{ color: forces.safe ? "#44cc44" : "#ff4444", fontWeight: 700, fontSize: 16 }}>
            {forces.safe ? "DESIGN LOOKS SAFE" : "NEEDS ATTENTION"}
          </div>
        </div>

        {/* Safety factors */}
        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Safety Factors (min 2.0x)</div>
          <SFBadge label={cfg.suspensionType === "chain" ? "Chain Tension" : "Arm Strength"} value={forces.suspensionSafetyFactor} />
          {cfg.suspensionType === "2x6-arms" && <SFBadge label="Arm Buckling" value={forces.armBucklingSafetyFactor} />}
          <SFBadge label="Wall Anchors" value={forces.anchorSafetyFactor} />
          <SFBadge label={`${cfg.frameType} Stud Bending`} value={forces.studBendingSafetyFactor} />
          <SFBadge label="Kicker Buckling" value={forces.kickerBucklingSafetyFactor} />
          <SFBadge label="Overturning" value={forces.momentSafetyFactor} />
        </div>

        {/* Forces */}
        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Forces</div>
          <ForceRow label="Board weight" value={forces.totalDeadLoadLb} unit="lb" />
          <ForceRow label="Climber load" value={forces.climberForceLb} unit="lb" />
          <ForceRow label="Total load" value={forces.totalLoadLb} unit="lb" />
          <div style={{ borderTop: "1px solid #444", margin: "6px 0" }} />
          <ForceRow label={`${cfg.suspensionType === "chain" ? "Chain" : "Arm"} force (each)`} value={forces.suspensionTensionLb} unit="lb" />
          <ForceRow label="Total capacity" value={forces.totalSuspensionCapacityLb} unit="lb" />
          <ForceRow label="Kicker compression" value={forces.kickerCompressionLb} unit="lb" />
          <ForceRow label="Anchor load (each)" value={forces.anchorPullOutLb} unit="lb" />
        </div>

        {/* Geometry */}
        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Geometry</div>
          <ForceRow label="Board top height" value={forces.boardTopY} unit="ft" />
          <ForceRow label="Base standoff" value={forces.kickerBaseZ} unit="ft" />
          <ForceRow label={`${cfg.suspensionType === "chain" ? "Chain" : "Arm"} length`} value={forces.suspensionLengthFt} unit="ft" />
          <ForceRow label="Suspension angle" value={forces.suspensionAngleDeg} unit="°" />
        </div>

        {/* Stiffness */}
        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Stiffness</div>
          <ForceRow label="Max stud deflection" value={forces.maxStudDeflectionIn} unit='"' />
          <div style={{ fontSize: 11, color: forces.maxStudDeflectionIn > 0.5 ? "#ff8844" : "#888", marginTop: 4 }}>
            {forces.maxStudDeflectionIn > 0.5 ? "Board will feel bouncy" : "Board will feel solid"}
          </div>
        </div>

        {/* Warnings */}
        {forces.warnings.length > 0 && (
          <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
            <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Notes</div>
            {forces.warnings.map((w, i) => (
              <div key={i} style={{
                fontSize: 11, color: w.includes("CRITICAL") ? "#ff4444" : w.includes("good") ? "#44cc44" : "#ff8844",
                marginBottom: 6, lineHeight: 1.4,
              }}>
                {w}
              </div>
            ))}
          </div>
        )}

        {/* Cut list */}
        <div style={{ background: "#2a2a2a", borderRadius: 10, padding: 12 }}>
          <div style={{ color: "#cc6633", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Materials List</div>
          <div style={{ fontSize: 11, color: "#ccc", lineHeight: 1.8 }}>
            <div>{getBoardSheets(cfg.boardSize)}x sheets 3/4" plywood (4' x 8')</div>
            <div>{numStuds}x {cfg.frameType}x{getBoardHeightFt(cfg.boardSize)}' studs</div>
            <div>{getBoardSheets(cfg.boardSize) + 1}x {cfg.frameType}x8' rails (top, bottom, seams)</div>
            <div>1x 6x6x8' post (kicker)</div>
            {cfg.suspensionType === "chain" ? (
              <>
                <div>{cfg.numChains}x {cfg.chainSize}" chain @ {Math.ceil(forces.suspensionLengthFt)}' each</div>
                <div>{cfg.numChains}x quick links or carabiners</div>
              </>
            ) : (
              <div>{cfg.numChains}x {cfg.frameType}x{Math.ceil(forces.suspensionLengthFt)}' arms</div>
            )}
            <div>{cfg.numWallAnchors}x {cfg.chainWallAnchor === "through-bolt" ? "through-bolts" : "eye bolts"} (wall)</div>
            <div>3" construction screws (box)</div>
            <div>T-nuts + 3/8" bolts for holds</div>
          </div>
        </div>

        {/* Disclaimer */}
        <div style={{ background: "#2a1a1a", border: "1px solid #664444", borderRadius: 10, padding: 10, marginTop: 12, fontSize: 10, color: "#cc8888", lineHeight: 1.5 }}>
          This tool is for planning purposes only. Structural calculations have NOT been verified by a licensed professional engineer. Consult a qualified structural engineer before building.
        </div>
      </div>
    </div>
  );
}
