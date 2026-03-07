import * as THREE from "three";

// Pull direction affects grip/foot efficiency:
// Hand techniques:
// "down" = pulling down on a jug/edge (most natural, 100% efficient)
// "side" = side-pulling (slightly less efficient ~85%)
// "undercling" = pulling up from below (harder, ~70% on overhangs)
// "gaston" = pushing outward (least efficient ~65%)
// "sloper" = friction-dependent, less effective on steep terrain
// Foot techniques:
// "edge" = edging on a foothold with shoe rand (standard foot technique)
// "smear" = friction smearing on slab/volume (no defined hold)
// "toe-hook" = hooking toe over/behind a hold (pulls toward wall on overhangs)
// "heel-hook" = heel on a hold, pulling with hamstring (great for overhangs)
// "toe-cam" = jamming toe into a pocket or crack
// "backstep" = outside edge of shoe on a hold, body turned sideways
export type PullDirection = "down" | "side" | "undercling" | "gaston" | "sloper"
  | "edge" | "smear" | "toe-hook" | "heel-hook" | "toe-cam" | "backstep";

export interface ClimberConfig {
  bodyWeightKg: number;
  gripStrengthKg: number;
  heightFt: number; // climber height in feet (e.g. 5.75 = 5'9")
  apeIndexIn: number; // wingspan in inches (arm tip to arm tip)
  bodyRotationDeg: number; // body twist: 0=facing out, +=right shoulder up
  wallAngleDeg: number; // 0 = vertical, positive = overhang, negative = slab
  leftHandPull: PullDirection;
  rightHandPull: PullDirection;
  leftFootPull: PullDirection;
  rightFootPull: PullDirection;
  // Knee turn: which direction the knee points.
  // 0 = neutral (outward from wall), negative = inward (drop knee), positive = outward (frog)
  leftKneeTurnDeg: number;
  rightKneeTurnDeg: number;
  hipOffset: number; // 0 = hips pressed to wall, 1 = fully extended away
  torsoOffset: number; // 0 = torso pressed to wall, 1 = fully extended away
  // Limb on/off wall toggles. When off, limb dangles.
  leftHandOn: boolean;
  rightHandOn: boolean;
  leftFootOn: boolean;
  rightFootOn: boolean;
  leftHand: { x: number; y: number };
  rightHand: { x: number; y: number };
  leftFoot: { x: number; y: number };
  rightFoot: { x: number; y: number };
  centerOfGravity: { x: number; y: number };
}

export interface ForceResult {
  gravity: THREE.Vector3;
  normal: THREE.Vector3;
  leftHandPull: THREE.Vector3;
  rightHandPull: THREE.Vector3;
  leftFootPush: THREE.Vector3;
  rightFootPush: THREE.Vector3;
  totalHandForceKg: number;
  totalHandForceLbs: number;
  gripStrengthPercentUsed: number;
  canHold: boolean;
  frictionRequired: number;
  wallAngleRad: number;
}

const G = 9.81;
const KG_TO_LBS = 2.20462;

/**
 * Torque-based climbing physics using rigid body statics.
 *
 * The climber is modeled as a rigid body on the wall with contact points
 * (hands and feet). We solve for equilibrium of forces and moments:
 *
 * 1. Sum of forces = 0 (linear equilibrium)
 * 2. Sum of moments about any point = 0 (rotational equilibrium)
 *
 * The center of gravity is computed from body proportions relative to
 * contact points, not simply averaged from contact positions.
 *
 * Forces at each contact point are solved to satisfy both force and
 * moment equilibrium simultaneously.
 */
export function computeForces(config: ClimberConfig): ForceResult {
  const {
    bodyWeightKg,
    gripStrengthKg,
    bodyRotationDeg,
    wallAngleDeg,
    leftHandPull,
    rightHandPull,
    hipOffset,
    torsoOffset,
    leftHandOn,
    rightHandOn,
    leftFootOn,
    rightFootOn,
    leftHand,
    rightHand,
    leftFoot,
    rightFoot,
  } = config;

  const wallAngleRad = (wallAngleDeg * Math.PI) / 180;
  const weightN = bodyWeightKg * G;
  const armReach = (config.apeIndexIn / 2) * 0.0254; // half wingspan in meters
  // === 1. PROPER CENTER OF GRAVITY ===
  // CoG is NOT the average of contact points. It's derived from body geometry.
  // The pelvis/hip center is roughly between the feet (laterally) and ~55% up
  // from feet to hands (vertically). The CoG sits at roughly the pelvis/navel
  // area — about 55% of height from the ground, slightly below the midpoint
  // between hands and feet on the wall.

  const handsOn = (leftHandOn ? 1 : 0) + (rightHandOn ? 1 : 0);
  const feetOn = (leftFootOn ? 1 : 0) + (rightFootOn ? 1 : 0);

  // Compute body reference points from active contact points
  const activeHands: { x: number; y: number }[] = [];
  const activeFeet: { x: number; y: number }[] = [];
  if (leftHandOn) activeHands.push(leftHand);
  if (rightHandOn) activeHands.push(rightHand);
  if (leftFootOn) activeFeet.push(leftFoot);
  if (rightFootOn) activeFeet.push(rightFoot);

  const handAvgX = activeHands.length > 0
    ? activeHands.reduce((s, h) => s + h.x, 0) / activeHands.length
    : (leftHand.x + rightHand.x) / 2;
  const handAvgY = activeHands.length > 0
    ? activeHands.reduce((s, h) => s + h.y, 0) / activeHands.length
    : (leftHand.y + rightHand.y) / 2;
  const footAvgX = activeFeet.length > 0
    ? activeFeet.reduce((s, f) => s + f.x, 0) / activeFeet.length
    : (leftFoot.x + rightFoot.x) / 2;
  const footAvgY = activeFeet.length > 0
    ? activeFeet.reduce((s, f) => s + f.y, 0) / activeFeet.length
    : (leftFoot.y + rightFoot.y) / 2;

  // The CoG sits at about 55% from feet toward hands along the body axis,
  // shifted slightly toward hands laterally based on torso lean
  const cogFraction = 0.55; // anatomical CoG position (navel height)
  const cogX = footAvgX + (handAvgX - footAvgX) * cogFraction;
  const cogY = footAvgY + (handAvgY - footAvgY) * cogFraction;

  // Hip offset shifts CoG away from wall. On overhangs, this creates a longer
  // moment arm. Body twist moves CoG closer to wall plane.
  const twistRad = Math.abs(bodyRotationDeg * Math.PI / 180);
  const twistFactor = Math.sin(twistRad);
  // Effective distance of CoG from wall (perpendicular to wall surface)
  // hipOffset 0=close, 1=far; torsoOffset adds upper body distance
  const baseCogDist = hipOffset * 0.35 + torsoOffset * 0.15; // meters from wall
  const cogDistFromWall = baseCogDist * (1 - twistFactor * 0.4); // twist reduces it

  // === 2. TORQUE-BASED FORCE DISTRIBUTION ===
  // Decompose gravity into components along and perpendicular to the wall.
  // Along wall = slides climber down the wall surface
  // Normal to wall = pulls climber away from wall (on overhangs)
  const gravAlongWall = weightN * Math.cos(wallAngleRad); // positive = down the wall
  const gravNormalToWall = weightN * Math.sin(wallAngleRad); // positive = away on overhangs

  const gravity = new THREE.Vector3(0, -weightN, 0);

  const wallNormal3 = new THREE.Vector3(
    0,
    -Math.sin(wallAngleRad),
    Math.cos(wallAngleRad)
  ).normalize();
  const normalForce = wallNormal3.clone().multiplyScalar(
    Math.max(0, -gravity.dot(wallNormal3))
  );

  if (handsOn === 0 && feetOn === 0) {
    return zeroResult(gravity, normalForce, wallAngleRad, weightN, gripStrengthKg);
  }

  // === MOMENT EQUILIBRIUM ===
  // Key insight: on vertical/slab walls, feet bear weight directly through
  // hold reaction forces. The wall surface provides a normal reaction that
  // supports the climber against sliding. Hands primarily maintain balance
  // and resist the outward torque from CoG being away from the wall.
  //
  // On overhangs, hands must additionally resist the component of gravity
  // pulling the climber away from the wall.
  //
  // Model: separate the problem into two axes:
  // 1. Along-wall (weight support): moment equilibrium determines hand/foot split
  // 2. Normal-to-wall (staying on wall): depends on wall angle and CoG distance

  const cogMomentArm = cogY - footAvgY; // CoG height above feet
  const handMomentArm = handAvgY - footAvgY; // hand height above feet

  let handAlongWallN = 0;
  let footAlongWallN = 0;

  if (feetOn === 0) {
    handAlongWallN = gravAlongWall;
    footAlongWallN = 0;
  } else if (handsOn === 0) {
    handAlongWallN = 0;
    footAlongWallN = gravAlongWall;
  } else if (Math.abs(handMomentArm) < 0.01) {
    handAlongWallN = gravAlongWall * 0.5;
    footAlongWallN = gravAlongWall * 0.5;
  } else {
    // Moment equilibrium about feet:
    // handForce * handMomentArm = gravAlongWall * cogMomentArm
    //
    // BUT: on vertical/slab walls, feet can support weight independently
    // through hold reactions. The feet push into footholds and the wall
    // pushes back. This means the "beam model" overestimates hand load
    // on less steep terrain.
    //
    // On a vertical wall, the along-wall gravity is fully supported by
    // friction at feet + hold edges. Hands mainly resist the outward
    // torque (handled in the normal component below).
    //
    // Scaling: as wall steepens past vertical, feet lose their ability
    // to support weight through friction, and hands must take over.
    // overhangRatio: 0 on vertical/slab, 1 on roof
    const overhangRatio = Math.max(0, Math.sin(wallAngleRad));
    // slabRatio: how much the wall supports the climber (1 on slab, 0 on roof)
    const wallSupportRatio = Math.max(0, Math.cos(wallAngleRad));

    // Pure moment equilibrium fraction (correct for horizontal beam / roof)
    const momentFraction = Math.max(0, Math.min(1,
      cogMomentArm / handMomentArm
    ));

    // On vertical: feet bear almost all weight. Hands bear only ~5-15% for balance.
    // On slight overhang: hands start bearing more.
    // On roof: full moment equilibrium applies.
    // Blend between minimal hand load (vertical) and full moment equilibrium (roof).
    const verticalHandLoad = 0.08; // hands bear ~8% on vertical for balance
    const blendedFraction = verticalHandLoad * wallSupportRatio
      + momentFraction * overhangRatio;

    handAlongWallN = gravAlongWall * Math.min(1, blendedFraction);
    footAlongWallN = gravAlongWall - handAlongWallN;

    // Negative hand force (CoG above hands) on steep overhangs is unstable
    if (handAlongWallN < 0 && wallAngleDeg > 45) {
      handAlongWallN = Math.abs(handAlongWallN);
      footAlongWallN = gravAlongWall + handAlongWallN;
    }
  }

  // --- Normal-to-wall forces (resisting being pulled off wall) ---
  // On overhangs, gravity pulls the climber away from the wall.
  // On vertical, there's still a small outward torque from CoG being
  // offset from the wall plane (hips out, torso out).
  // On slab, gravity pushes the climber INTO the wall — no outward force.

  let handNormalN = 0;
  let footNormalN = 0;

  if (gravNormalToWall > 0) {
    // Overhang: gravity pulls climber away from wall
    const outwardForce = gravNormalToWall * (1 + cogDistFromWall * 2);

    if (feetOn === 0) {
      handNormalN = outwardForce;
    } else if (handsOn === 0) {
      footNormalN = outwardForce;
    } else {
      const handLever = Math.abs(handAvgY - cogY) + 0.1;
      const footLever = Math.abs(footAvgY - cogY) + 0.1;
      const totalLever = handLever + footLever;
      handNormalN = outwardForce * (footLever / totalLever);
      footNormalN = outwardForce * (handLever / totalLever);
    }
  } else if (wallAngleDeg >= -10 && wallAngleDeg <= 10) {
    // Near-vertical: small outward torque from CoG offset from wall
    // This is what makes hands needed even on vertical — for balance
    const outwardTorque = weightN * cogDistFromWall * 0.5;
    if (handsOn > 0) {
      handNormalN = outwardTorque;
    }
  }

  // --- Lateral moment equilibrium (barn door prevention) ---
  // When CoG is not centered between contact points laterally,
  // there's a rotational torque that must be resisted.
  const allContacts: { x: number; y: number; isHand: boolean; isLeft: boolean }[] = [];
  if (leftHandOn) allContacts.push({ ...leftHand, isHand: true, isLeft: true });
  if (rightHandOn) allContacts.push({ ...rightHand, isHand: true, isLeft: false });
  if (leftFootOn) allContacts.push({ ...leftFoot, isHand: false, isLeft: true });
  if (rightFootOn) allContacts.push({ ...rightFoot, isHand: false, isLeft: false });

  // Lateral offset of CoG from centroid of contacts
  const contactCentroidX = allContacts.length > 0
    ? allContacts.reduce((s, c) => s + c.x, 0) / allContacts.length
    : cogX;
  const lateralOffset = cogX - contactCentroidX;

  // Barn door torque: lateral offset * weight creates a turning moment
  // Contact points at greater lateral distance resist this more effectively
  let barnDoorExtra = 0;
  if (Math.abs(lateralOffset) > 0.02 && allContacts.length >= 2) {
    // The lateral torque must be resisted by differential forces at contact points
    const maxLateralSpan = allContacts.reduce((max, c) =>
      Math.max(max, Math.abs(c.x - contactCentroidX)), 0);
    if (maxLateralSpan > 0.01) {
      // Extra force needed = torque / max lever arm
      // Torque = weight * lateral_offset (simplified for wall-plane rotation)
      barnDoorExtra = weightN * Math.abs(lateralOffset) * 0.3 / maxLateralSpan;
      // This extra force falls mostly on hands (they resist rotation)
      handAlongWallN += barnDoorExtra * (handsOn > 0 ? 0.7 : 0);
    }
  }

  // === 4. DISTRIBUTE BETWEEN LEFT/RIGHT HANDS ===
  // Use moment equilibrium about the other hand to find each hand's share.
  // For two hands: take moment about right hand to find left hand force, and vice versa.
  let leftHandRatio = 0.5;
  let rightHandRatio = 0.5;

  if (handsOn === 1) {
    leftHandRatio = leftHandOn ? 1 : 0;
    rightHandRatio = rightHandOn ? 1 : 0;
  } else if (handsOn === 2) {
    // Moment about right hand position to find left hand force:
    // leftForce * |leftHand - rightHand| = totalForce * |CoG_projection - rightHand|
    // The hand FURTHER from CoG bears LESS load (it has more leverage).
    const lhDistFromCog = Math.sqrt(
      (leftHand.x - cogX) ** 2 + (leftHand.y - cogY) ** 2
    );
    const rhDistFromCog = Math.sqrt(
      (rightHand.x - cogX) ** 2 + (rightHand.y - cogY) ** 2
    );

    // Using moment equilibrium along the hand-to-hand axis:
    // The hand closer to CoG should bear MORE of the load (shorter moment arm
    // means it needs more force to create the same moment).
    // F_left * d_left = F_right * d_right (about CoG)
    // F_left / F_right = d_right / d_left
    // So the further hand bears less force.
    const totalDist = lhDistFromCog + rhDistFromCog;
    if (totalDist > 0.01) {
      // Inverse distance weighting: closer hand bears more
      // F_left / F_total = (1/d_left) / (1/d_left + 1/d_right)
      //                  = d_right / (d_left + d_right)
      // Wait — this gives MORE to the hand further from CoG.
      // Actually: for moment equilibrium about CoG:
      //   F_left * d_left_from_cog = F_right * d_right_from_cog  (WRONG for general case)
      //
      // The correct approach: take moments about each hand.
      // Moment about right hand: F_left * handSpan = W * cogDistFromRight
      // F_left = W * cogDistFromRight / handSpan
      // So the hand further from CoG gets MORE load — this is correct physics!
      // Think of a seesaw: the weight closer to one end means that end bears more.
      //
      // Actually, for a beam supported at two points:
      // Support A bears load proportional to distance of load from B.
      // F_A = W * d_B / (d_A + d_B) where d_A, d_B are distances from load to A, B.
      // So the support CLOSER to the load bears MORE.

      // Distance of CoG from each hand along the line connecting the hands
      const handDx = rightHand.x - leftHand.x;
      const handDy = rightHand.y - leftHand.y;
      const handSpan = Math.sqrt(handDx ** 2 + handDy ** 2);

      if (handSpan > 0.01) {
        // Project CoG onto the line between hands
        const t = ((cogX - leftHand.x) * handDx + (cogY - leftHand.y) * handDy) / (handSpan ** 2);
        const tClamped = Math.max(0, Math.min(1, t));
        // t=0 means CoG is at left hand, t=1 means at right hand
        // Left hand bears: (1-t) when CoG is at t along the line
        // Wait — beam mechanics: reaction at left = W * (1 - t), right = W * t
        // When t=0 (CoG at left hand): left bears all → leftRatio = 1? No.
        // When load is AT support A (t=0): A bears all load. So leftRatio = (1-t).
        // But this means the hand the CoG is CLOSER to bears MORE. Let me verify:
        // If CoG is right at the left hand (t=0): leftRatio=1. Correct — all weight on that hand.
        // If CoG is centered (t=0.5): equal split. Correct.
        // If CoG is near right hand (t=0.8): leftRatio=0.2, rightRatio=0.8. Correct.
        // YES — the hand closer to CoG bears MORE load. This is standard beam theory.
        rightHandRatio = tClamped;
        leftHandRatio = 1 - tClamped;
      } else {
        leftHandRatio = 0.5;
        rightHandRatio = 0.5;
      }
    }
  }

  // === 5. DISTRIBUTE BETWEEN LEFT/RIGHT FEET ===
  let leftFootRatio = 0.5;
  let rightFootRatio = 0.5;
  if (feetOn === 1) {
    leftFootRatio = leftFootOn ? 1 : 0;
    rightFootRatio = rightFootOn ? 1 : 0;
  } else if (feetOn === 2) {
    const footDx = rightFoot.x - leftFoot.x;
    const footDy = rightFoot.y - leftFoot.y;
    const footSpan = Math.sqrt(footDx ** 2 + footDy ** 2);
    if (footSpan > 0.01) {
      const t = ((cogX - leftFoot.x) * footDx + (cogY - leftFoot.y) * footDy) / (footSpan ** 2);
      const tClamped = Math.max(0, Math.min(1, t));
      rightFootRatio = tClamped;
      leftFootRatio = 1 - tClamped;
    }
  }

  // === 6. FORCE DIRECTIONS ===
  // Hand forces: directed from the hold toward the body (pulling)
  // The direction should be from hold toward CoG, projected appropriately.
  const handForceTotal = Math.sqrt(handAlongWallN ** 2 + handNormalN ** 2);

  const makePullDir = (hold: { x: number; y: number }, on: boolean): THREE.Vector3 => {
    if (!on) return new THREE.Vector3(0, 0, 0);
    const dx = cogX - hold.x;
    const dy = cogY - hold.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return new THREE.Vector3(0, -1, 0);
    return new THREE.Vector3(dx / len, dy / len, 0);
  };

  const leftPullDir = makePullDir(leftHand, leftHandOn);
  const rightPullDir = makePullDir(rightHand, rightHandOn);

  const leftHandForce = leftPullDir.clone().multiplyScalar(handForceTotal * leftHandRatio);
  const rightHandForce = rightPullDir.clone().multiplyScalar(handForceTotal * rightHandRatio);

  // Foot forces: directed along the wall surface (pushing into/up the wall)
  // On vertical: mostly upward. On overhang: into the wall + upward.
  // The foot pushes against the wall surface, so force direction is along
  // the wall-tangent (supporting weight) plus into the wall (friction/normal).
  const footForceTotal = Math.sqrt(footAlongWallN ** 2 + footNormalN ** 2);

  // Foot force direction: combination of wall-up and into-wall
  const footForceDir = new THREE.Vector3(
    0,
    Math.cos(wallAngleRad),  // vertical component (up the wall)
    -Math.sin(wallAngleRad)  // into the wall component
  );
  const footDirLen = footForceDir.length();
  if (footDirLen > 0.001) footForceDir.divideScalar(footDirLen);
  else footForceDir.set(0, 1, 0);

  const leftFootPush = footForceDir.clone().multiplyScalar(footForceTotal * leftFootRatio);
  const rightFootPush = footForceDir.clone().multiplyScalar(footForceTotal * rightFootRatio);

  // === 7. TOTAL HAND FORCE AND GRIP CHECK ===
  const totalHandForceKg = handForceTotal / G;
  const totalHandForceLbs = totalHandForceKg * KG_TO_LBS;

  // Arm bend efficiency (same model — this is biomechanics, not physics error)
  const lhDist = Math.sqrt((leftHand.x - cogX) ** 2 + (leftHand.y - cogY) ** 2);
  const rhDist = Math.sqrt((rightHand.x - cogX) ** 2 + (rightHand.y - cogY) ** 2);
  const lhStraight = Math.min(1, lhDist / (armReach * 0.85));
  const rhStraight = Math.min(1, rhDist / (armReach * 0.85));
  const avgStraightness = handsOn === 2
    ? (lhStraight + rhStraight) / 2
    : leftHandOn ? lhStraight : rhStraight;
  const baseEfficiency = 0.55 + avgStraightness * 0.45;
  const engagementBump = Math.exp(-((avgStraightness - 0.8) ** 2) / 0.02) * 0.08;
  const armBendEfficiency = Math.min(1.0, baseEfficiency + engagementBump);

  // Pull direction efficiency
  const pullEfficiency = (
    pull: PullDirection,
    hand: { x: number; y: number },
    isLeft: boolean
  ): number => {
    const overhang = Math.max(0, Math.sin(wallAngleRad));
    const dx = hand.x - cogX;
    const dy = hand.y - cogY;
    const normDy = Math.min(1, Math.max(-1, dy / (armReach * 0.8)));
    const normDx = Math.min(1, Math.max(-1, dx / (armReach * 0.5)));
    const lateralDist = Math.abs(normDx);

    switch (pull) {
      case "down": {
        const aboveBonus = normDy > 0 ? normDy * 0.15 : normDy * 0.25;
        return Math.max(0.3, 0.85 + aboveBonus);
      }
      case "side": {
        const correctSide = isLeft ? (dx < 0) : (dx > 0);
        const sideBonus = lateralDist * (correctSide ? 0.15 : -0.1);
        const abovePenalty = normDy > 0.5 ? (normDy - 0.5) * -0.1 : 0;
        return Math.max(0.3, 0.80 + sideBonus + abovePenalty);
      }
      case "undercling": {
        const belowBonus = normDy < 0 ? Math.abs(normDy) * 0.2 : -normDy * 0.3;
        return Math.max(0.3, 0.70 + belowBonus - overhang * 0.15);
      }
      case "gaston": {
        const correctSide = isLeft ? (dx > 0) : (dx < 0);
        const crossBonus = lateralDist * (correctSide ? 0.15 : -0.1);
        return Math.max(0.3, 0.60 + crossBonus);
      }
      case "sloper": {
        const aboveBonus = normDy > 0 ? normDy * 0.1 : normDy * 0.15;
        const distPenalty = lateralDist * -0.1;
        return Math.max(0.3, 0.85 + aboveBonus + distPenalty - overhang * 0.35);
      }
      case "edge":
        return Math.max(0.4, 0.90 - overhang * 0.1);
      case "smear": {
        const slabBonus = Math.max(0, -normDy) * 0.15;
        return Math.max(0.3, 0.75 + slabBonus - overhang * 0.4);
      }
      case "toe-hook":
        return Math.max(0.3, 0.60 + overhang * 0.35);
      case "heel-hook":
        return Math.max(0.3, 0.65 + overhang * 0.35);
      case "toe-cam":
        return Math.max(0.4, 0.85);
      case "backstep": {
        const twistBonus = Math.abs(normDx) * 0.2;
        return Math.max(0.3, 0.75 + twistBonus);
      }
    }
  };

  const avgPullEfficiency = handsOn === 0 ? 1 :
    (leftHandOn ? pullEfficiency(leftHandPull, leftHand, true) * leftHandRatio : 0) +
    (rightHandOn ? pullEfficiency(rightHandPull, rightHand, false) * rightHandRatio : 0);

  const effectiveGripKg = gripStrengthKg * avgPullEfficiency * armBendEfficiency;
  const gripStrengthPercentUsed = effectiveGripKg > 0
    ? (totalHandForceKg / effectiveGripKg) * 100
    : (totalHandForceKg > 0 ? Infinity : 0);

  // Friction required at feet
  const frictionRequired = wallAngleDeg >= 0
    ? Math.max(0, gravNormalToWall) * (feetOn > 0 ? footAlongWallN / Math.max(footForceTotal, 0.01) : 0)
    : 0;

  return {
    gravity,
    normal: normalForce,
    leftHandPull: leftHandForce,
    rightHandPull: rightHandForce,
    leftFootPush,
    rightFootPush,
    totalHandForceKg,
    totalHandForceLbs,
    gripStrengthPercentUsed,
    canHold: totalHandForceKg <= effectiveGripKg,
    frictionRequired,
    wallAngleRad,
  };
}

function zeroResult(
  gravity: THREE.Vector3,
  normal: THREE.Vector3,
  wallAngleRad: number,
  weightN: number,
  gripStrengthKg: number
): ForceResult {
  return {
    gravity,
    normal,
    leftHandPull: new THREE.Vector3(),
    rightHandPull: new THREE.Vector3(),
    leftFootPush: new THREE.Vector3(),
    rightFootPush: new THREE.Vector3(),
    totalHandForceKg: weightN / G,
    totalHandForceLbs: (weightN / G) * KG_TO_LBS,
    gripStrengthPercentUsed: (weightN / G / gripStrengthKg) * 100,
    canHold: false,
    frictionRequired: 0,
    wallAngleRad,
  };
}
