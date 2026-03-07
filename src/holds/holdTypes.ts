export type HoldType = "jug" | "crimp" | "sloper" | "pinch" | "pocket" | "volume"
  | "foot-chip" | "foot-edge" | "smear-pad";

export type HoldDirection = "up" | "down" | "left" | "right";

// "hand" = primarily a handhold, "foot" = primarily a foothold, "both" = usable by either
export type HoldUsage = "hand" | "foot" | "both";

export interface PlacedHold {
  id: string;
  x: number;   // lateral position on wall
  y: number;   // height along wall
  type: HoldType;
  direction: HoldDirection;
  usage: HoldUsage;
}

export const HOLD_INFO: Record<HoldType, {
  label: string;
  color: string;
  description: string;
  defaultUsage: HoldUsage;
}> = {
  jug:        { label: "Jug",        color: "#dd5533", description: "Large positive hold - easy grip",        defaultUsage: "both" },
  crimp:      { label: "Crimp",      color: "#ddaa22", description: "Small edge - finger strength",           defaultUsage: "both" },
  sloper:     { label: "Sloper",     color: "#7766cc", description: "Round, friction-dependent",              defaultUsage: "both" },
  pinch:      { label: "Pinch",      color: "#44aa88", description: "Squeeze hold - thumb opposition",        defaultUsage: "hand" },
  pocket:     { label: "Pocket",     color: "#cc5599", description: "Hole - 1-3 finger pocket",               defaultUsage: "both" },
  volume:     { label: "Volume",     color: "#6688bb", description: "Large geometric shape",                  defaultUsage: "both" },
  "foot-chip":  { label: "Foot Chip",  color: "#8899aa", description: "Tiny nub - feet only",                 defaultUsage: "foot" },
  "foot-edge":  { label: "Foot Edge",  color: "#77aa77", description: "Small rail for edging",                defaultUsage: "foot" },
  "smear-pad":  { label: "Smear Pad",  color: "#998877", description: "Textured area for smearing",          defaultUsage: "foot" },
};

// Map hold type + direction to the best pull direction for hands
export function holdToPullHand(type: HoldType, dir: HoldDirection): "down" | "side" | "undercling" | "gaston" | "sloper" {
  // Direction modifies the natural pull direction
  if (dir === "down") return "undercling";
  if (dir === "left") return "side";
  if (dir === "right") return "side";
  // dir === "up" (default)
  switch (type) {
    case "jug": return "down";
    case "crimp": return "down";
    case "sloper": return "sloper";
    case "pinch": return "side";
    case "pocket": return "down";
    case "volume": return "sloper";
    case "foot-chip": return "down";
    case "foot-edge": return "down";
    case "smear-pad": return "sloper";
  }
}

// Map hold type + direction to the best foot technique
export function holdToPullFoot(
  type: HoldType,
  dir: HoldDirection,
  isOverhang: boolean
): "edge" | "smear" | "toe-hook" | "heel-hook" | "toe-cam" | "backstep" {
  // Overhanging terrain favors hooks
  if (isOverhang && dir === "down") return "toe-hook";
  if (isOverhang && (dir === "left" || dir === "right")) return "heel-hook";

  switch (type) {
    case "jug":
      return dir === "down" ? "toe-hook" : "edge";
    case "crimp":
    case "foot-edge":
      return dir === "left" || dir === "right" ? "backstep" : "edge";
    case "sloper":
    case "volume":
    case "smear-pad":
      return "smear";
    case "pinch":
      return "toe-cam";
    case "pocket":
      return "toe-cam";
    case "foot-chip":
      return "edge";
  }
}

type Limb = "leftHand" | "rightHand" | "leftFoot" | "rightFoot";

export interface ClimbMove {
  limb: Limb;
  targetX: number;
  targetY: number;
  holdType: HoldType | null;
  holdDirection: HoldDirection;
  holdUsage: HoldUsage;
  bodyTwist: number;
  hipOffset: number;
  torsoOffset: number;
  leftKneeTurn: number;
  rightKneeTurn: number;
  duration: number;
  arcHeight: number;
  isSetup: boolean;
}

export interface StartHolds {
  leftHand: PlacedHold;
  rightHand: PlacedHold;
}

export function planRoute(holds: PlacedHold[], wallAngleDeg: number, startHolds: StartHolds): ClimbMove[] {
  const moves: ClimbMove[] = [];
  const isOverhang = wallAngleDeg > 10;
  const isSlab = wallAngleDeg < -5;
  const steepness = Math.max(0, wallAngleDeg) / 90; // 0..1

  const ARM_REACH = 0.85;
  const LEG_REACH = 0.95;

  // Start position: hands on start holds, feet below
  const startFootY = Math.max(0.15, Math.min(startHolds.leftHand.y, startHolds.rightHand.y) - 0.6);

  const current: Record<Limb, { x: number; y: number }> = {
    leftFoot:  { x: startHolds.leftHand.x, y: startFootY },
    rightFoot: { x: startHolds.rightHand.x, y: startFootY },
    leftHand:  { x: startHolds.leftHand.x, y: startHolds.leftHand.y },
    rightHand: { x: startHolds.rightHand.x, y: startHolds.rightHand.y },
  };

  // --- Classify holds ---
  // Hand targets: holds the climber needs to grab (sorted bottom to top)
  // These are the "route" — the sequence of hand moves.
  // Foot-only holds are never hand targets.
  // The start holds are already grabbed, so exclude holds at the same position.
  const handTargets = [...holds]
    .filter(h => h.usage !== "foot")
    .filter(h => {
      // Skip holds that are at/below the start hand positions (already there)
      // Skip holds that the climber is already holding
      const isAtStart = (Math.abs(h.x - startHolds.leftHand.x) < 0.05 && Math.abs(h.y - startHolds.leftHand.y) < 0.05)
        || (Math.abs(h.x - startHolds.rightHand.x) < 0.05 && Math.abs(h.y - startHolds.rightHand.y) < 0.05);
      if (isAtStart) return false;
      const startMaxY = Math.max(startHolds.leftHand.y, startHolds.rightHand.y);
      return h.y > startMaxY - 0.05;
    })
    .sort((a, b) => a.y - b.y);

  // All holds usable as footholds
  const footCandidates = [...holds]
    .filter(h => h.usage !== "hand")
    .sort((a, b) => a.y - b.y);

  // --- Utility functions ---
  const distBetween = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

  const shoulderPos = (hand: Limb) => {
    const footMidX = (current.leftFoot.x + current.rightFoot.x) / 2;
    const footAvgY = (current.leftFoot.y + current.rightFoot.y) / 2;
    return {
      x: footMidX + (hand === "leftHand" ? -0.15 : 0.15),
      y: footAvgY + 0.75,
    };
  };

  const hipPos = (foot: Limb) => {
    const footMidX = (current.leftFoot.x + current.rightFoot.x) / 2;
    const footAvgY = (current.leftFoot.y + current.rightFoot.y) / 2;
    return {
      x: footMidX + (foot === "leftFoot" ? -0.08 : 0.08),
      y: footAvgY + 0.45,
    };
  };

  const canHandReach = (hand: Limb, hold: { x: number; y: number }) =>
    distBetween(shoulderPos(hand), hold) <= ARM_REACH;

  const canFootReach = (foot: Limb, hold: { x: number; y: number }) =>
    distBetween(hipPos(foot), hold) <= LEG_REACH;

  // --- Setup moves (instant snap to start position) ---
  const setupMove = (limb: Limb, hold: PlacedHold | null, x: number, y: number): ClimbMove => ({
    limb, targetX: x, targetY: y,
    holdType: hold?.type ?? null,
    holdDirection: hold?.direction ?? "up",
    holdUsage: hold?.usage ?? "both",
    bodyTwist: 0, hipOffset: isOverhang ? 0.1 : 0.3, torsoOffset: 0.5,
    leftKneeTurn: 0, rightKneeTurn: 0,
    duration: 400, arcHeight: 0, isSetup: true,
  });

  moves.push(setupMove("leftFoot", null, current.leftFoot.x, current.leftFoot.y));
  moves.push(setupMove("rightFoot", null, current.rightFoot.x, current.rightFoot.y));
  moves.push(setupMove("leftHand", startHolds.leftHand, current.leftHand.x, current.leftHand.y));
  moves.push(setupMove("rightHand", startHolds.rightHand, current.rightHand.x, current.rightHand.y));

  // --- Body position computation ---
  const computeBody = (movingLimb?: Limb) => {
    const handMidX = (current.leftHand.x + current.rightHand.x) / 2;
    const footMidX = (current.leftFoot.x + current.rightFoot.x) / 2;
    const handAvgY = (current.leftHand.y + current.rightHand.y) / 2;
    const footAvgY = (current.leftFoot.y + current.rightFoot.y) / 2;
    const span = Math.max(0.3, handAvgY - footAvgY);

    // Twist toward reaching hand
    let twist = 0;
    if (movingLimb === "leftHand") twist = Math.min(35, 15 + steepness * 20);
    else if (movingLimb === "rightHand") twist = -Math.min(35, 15 + steepness * 20);
    else {
      const cogX = footMidX * 0.7 + handMidX * 0.3;
      twist = Math.max(-25, Math.min(25, (cogX - footMidX) * 60));
    }
    if (!isOverhang) twist *= 0.5;

    const hipOff = isOverhang
      ? Math.max(0.05, 0.15 - steepness * 0.08)
      : isSlab ? Math.max(0.2, 0.5 - span * 0.1)
      : Math.max(0.1, Math.min(0.5, 0.25 + span * 0.05));

    const torsoOff = isOverhang
      ? Math.max(0.3, 0.45 - steepness * 0.1)
      : Math.min(0.7, 0.5 + span * 0.05);

    let lKnee = 0, rKnee = 0;
    if (isOverhang) {
      if (twist > 10) rKnee = -Math.min(70, twist * 2);
      else if (twist < -10) lKnee = -Math.min(70, Math.abs(twist) * 2);
    }
    if (steepness > 0.3 && movingLimb) {
      if (movingLimb === "leftHand" && current.rightFoot.y < current.leftFoot.y)
        rKnee = Math.min(rKnee, -50 * steepness);
      else if (movingLimb === "rightHand" && current.leftFoot.y < current.rightFoot.y)
        lKnee = Math.min(lKnee, -50 * steepness);
    }

    return { twist, hipOff, torsoOff, lKnee, rKnee };
  };

  // --- Make a move (updates current positions) ---
  const makeMove = (limb: Limb, hold: PlacedHold): ClimbMove => {
    const moveDist = distBetween(current[limb], hold);
    current[limb] = { x: hold.x, y: hold.y };
    const body = computeBody(limb);
    const isHand = limb === "leftHand" || limb === "rightHand";
    const baseDur = isHand ? 700 : 500;
    const distFactor = Math.min(1.5, moveDist / 0.5);
    const duration = baseDur + distFactor * 300;
    const baseArc = isHand ? 0.25 : 0.1;
    const arcHeight = Math.min(0.6, baseArc + distFactor * 0.15 + (isOverhang ? 0.1 : 0));

    return {
      limb, targetX: hold.x, targetY: hold.y,
      holdType: hold.type, holdDirection: hold.direction, holdUsage: hold.usage,
      bodyTwist: body.twist, hipOffset: body.hipOff, torsoOffset: body.torsoOff,
      leftKneeTurn: body.lKnee, rightKneeTurn: body.rKnee,
      duration, arcHeight, isSetup: false,
    };
  };

  // --- Find the best foothold near a target ---
  const findFoothold = (targetX: number, targetY: number, exclude: Set<string>): PlacedHold => {
    let best: PlacedHold | null = null;
    let bestScore = -Infinity;

    for (const fh of footCandidates) {
      if (exclude.has(fh.id)) continue;
      if (fh.y > targetY + 0.4 || fh.y < targetY - 1.0) continue;
      const d = distBetween({ x: targetX, y: targetY }, fh);
      if (d > LEG_REACH) continue;

      // Prefer: close to target height, same lateral side, actual footholds over "both"
      const yScore = 1 - Math.abs(fh.y - targetY) * 1.2;
      const xScore = 1 - Math.abs(fh.x - targetX) * 0.4;
      const typeBonus = fh.usage === "foot" ? 0.3 : 0;
      const score = yScore + xScore * 0.5 + typeBonus;
      if (score > bestScore) { bestScore = score; best = fh; }
    }

    return best || {
      id: "synthetic", x: targetX, y: targetY,
      type: "foot-chip" as HoldType, direction: "up" as HoldDirection, usage: "foot" as HoldUsage,
    };
  };

  // --- Pick which hand grabs a hold ---
  const pickHand = (hold: PlacedHold, lastSide: "left" | "right"): Limb => {
    const handMidX = (current.leftHand.x + current.rightHand.x) / 2;
    const isLeft = hold.x <= handMidX;
    const sameSide: Limb = isLeft ? "leftHand" : "rightHand";
    const otherSide: Limb = isLeft ? "rightHand" : "leftHand";

    const score = (h: Limb) => {
      let s = 0;
      if (h === sameSide) s += 2;  // same side (don't cross)
      if ((h === "leftHand") !== (lastSide === "left")) s += 1.5; // alternate
      if (current[h].y <= current[h === "leftHand" ? "rightHand" : "leftHand"].y) s += 1; // lower hand moves up
      s -= distBetween(current[h], hold); // prefer closer
      return s;
    };

    return score(sameSide) >= score(otherSide) ? sameSide : otherSide;
  };

  // ============================================================
  // MAIN CLIMBING LOOP: process hand targets one at a time.
  // For each hand target:
  //   1. Position feet for stability & reach
  //   2. Grab the hold with the appropriate hand
  // ============================================================
  let lastHandSide: "left" | "right" = "right";
  const usedFootIds = new Set<string>();

  for (const target of handTargets) {
    const hand = pickHand(target, lastHandSide);

    // --- Step 1: Move feet if needed ---
    // Ideal foot position: below the next hand hold, spread for stability
    const idealFootY = target.y - 0.7; // feet about 0.7m below where we're reaching
    const footAvgY = (current.leftFoot.y + current.rightFoot.y) / 2;
    const reachable = canHandReach(hand, target);
    const feetTooLow = (target.y - footAvgY) > 1.4;
    const needFeet = !reachable || feetTooLow;

    if (needFeet) {
      // Move the lower foot first
      const lowerFoot: Limb = current.leftFoot.y <= current.rightFoot.y ? "leftFoot" : "rightFoot";
      const higherFoot: Limb = lowerFoot === "leftFoot" ? "rightFoot" : "leftFoot";

      // Target: below the hand target, on the opposite side for balance
      const foot1X = hand === "leftHand" ? target.x + 0.15 : target.x - 0.15;
      const foot1 = findFoothold(foot1X, idealFootY, usedFootIds);
      if (canFootReach(lowerFoot, foot1)) {
        moves.push(makeMove(lowerFoot, foot1));
        usedFootIds.add(foot1.id);
      }

      // Check if we can reach now; if not, move the other foot too
      if (!canHandReach(hand, target)) {
        const foot2X = hand === "leftHand" ? target.x - 0.1 : target.x + 0.1;
        const foot2 = findFoothold(foot2X, idealFootY + 0.15, usedFootIds);
        if (canFootReach(higherFoot, foot2)) {
          moves.push(makeMove(higherFoot, foot2));
          usedFootIds.add(foot2.id);
        }
      }
    }

    // --- Step 2: Grab the hand hold ---
    lastHandSide = hand === "leftHand" ? "left" : "right";
    moves.push(makeMove(hand, target));
  }

  // --- Final foot adjustment ---
  const finalHandAvgY = (current.leftHand.y + current.rightHand.y) / 2;
  const finalFootAvgY = (current.leftFoot.y + current.rightFoot.y) / 2;
  if (finalHandAvgY - finalFootAvgY > 1.0) {
    const targetFootY = finalHandAvgY - 0.7;
    for (const foot of ["leftFoot", "rightFoot"] as Limb[]) {
      if (current[foot].y < targetFootY - 0.15) {
        const fh = findFoothold(current[foot].x, targetFootY, usedFootIds);
        moves.push(makeMove(foot, fh));
      }
    }
  }

  return moves;
}

let _holdId = 0;
export function makeHoldId(): string {
  return `hold_${++_holdId}_${Date.now()}`;
}
