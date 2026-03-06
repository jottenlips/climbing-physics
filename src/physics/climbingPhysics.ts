import * as THREE from "three";

// Pull direction affects grip efficiency:
// "down" = pulling down on a jug/edge (most natural, 100% efficient)
// "side" = side-pulling (slightly less efficient ~85%)
// "undercling" = pulling up from below (harder, ~70% on overhangs)
// "gaston" = pushing outward (least efficient ~65%)
// "sloper" = friction-dependent, less effective on steep terrain
export type PullDirection = "down" | "side" | "undercling" | "gaston" | "sloper";

export interface ClimberConfig {
  bodyWeightKg: number;
  gripStrengthKg: number;
  heightFt: number; // climber height in feet (e.g. 5.75 = 5'9")
  apeIndexIn: number; // wingspan in inches (arm tip to arm tip)
  bodyRotationDeg: number; // body twist: 0=facing out, +=right shoulder up
  wallAngleDeg: number; // 0 = vertical, positive = overhang, negative = slab
  leftHandPull: PullDirection;
  rightHandPull: PullDirection;
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
    centerOfGravity,
  } = config;

  const wallAngleRad = (wallAngleDeg * Math.PI) / 180;
  const weightN = bodyWeightKg * G;

  // Body twist: twisting hips into the wall moves CoG closer to the wall.
  // This reduces the moment arm for outward pull and shifts load to feet.
  // twistFactor: 0 at no twist, approaches 1 at full 90° twist
  const twistRad = Math.abs(bodyRotationDeg * Math.PI / 180);
  const twistFactor = Math.sin(twistRad); // 0 at 0°, 1 at 90°

  // Hip distance effect depends on wall angle:
  // OVERHANG: hips close = shorter moment arm = less hand load (close is good)
  // SLAB: hips OUT = CoG over feet = more weight on feet = less hand load (out is good)
  // VERTICAL: moderate — close is slightly better but less dramatic
  const hipDistFactor = hipOffset; // 0=close, 1=far

  // Gravity always points straight down
  const gravity = new THREE.Vector3(0, -weightN, 0);

  // Wall normal direction depends on angle
  // At 0 deg (vertical): normal points outward (+z)
  // At 90 deg (roof): normal points down (-y)
  const wallNormal = new THREE.Vector3(
    0,
    -Math.sin(wallAngleRad),
    Math.cos(wallAngleRad)
  ).normalize();

  // Component of gravity pulling climber away from wall (outward force)
  const gravityAlongNormal = gravity.dot(wallNormal);
  const normalForce = wallNormal.clone().multiplyScalar(-gravityAlongNormal);

  // Component of gravity pulling climber down along the wall surface
  const wallDown = new THREE.Vector3(
    0,
    -Math.cos(wallAngleRad),
    -Math.sin(wallAngleRad)
  ).normalize();
  const gravityAlongWall = gravity.dot(wallDown);

  // Arm bend + scapular engagement efficiency:
  // Straight arms: skeleton bears load (tendons/bones), minimal grip fatigue → 1.0
  // Slightly bent (~0.7-0.9 straight): shoulders engaged, lats share load → 0.90
  // Moderately bent (~0.4-0.7): active muscular contraction, but lats still help → 0.70
  // Fully bent (<0.3): max bicep/forearm effort, grip fatigue highest → 0.55
  //
  // Scapular engagement is implicit: when arms are slightly bent with shoulders
  // pulled down (engaged position), the large lat muscles transfer force from
  // hands to core, reducing the load on forearm grip muscles by ~10%.
  // This is baked into the efficiency curve rather than a separate control.
  const armReach = (config.apeIndexIn / 2) * 0.0254; // half wingspan in meters
  const lhDist = Math.sqrt((leftHand.x - centerOfGravity.x) ** 2 + (leftHand.y - centerOfGravity.y) ** 2);
  const rhDist = Math.sqrt((rightHand.x - centerOfGravity.x) ** 2 + (rightHand.y - centerOfGravity.y) ** 2);
  // How straight each arm is: 0 = fully bent, 1 = fully extended
  const lhStraight = Math.min(1, lhDist / (armReach * 0.85));
  const rhStraight = Math.min(1, rhDist / (armReach * 0.85));
  const avgStraightness = (lhStraight + rhStraight) / 2;
  // Efficiency curve with scapular engagement bump at slight bend:
  // 0.0 → 0.55 (fully locked off, max effort)
  // 0.3 → 0.65
  // 0.6 → 0.80 (moderate bend, lats helping)
  // 0.8 → 0.92 (slight bend, engaged shoulders, lats sharing load — sweet spot)
  // 1.0 → 1.00 (dead hang on skeleton)
  // The slight bend "engaged" position gets a ~10% boost from lat recruitment.
  const baseEfficiency = 0.55 + avgStraightness * 0.45;
  // Scapular engagement bonus: peaks around 0.75-0.85 straightness (slight bend)
  // This is where climbers naturally engage — arms not quite straight, shoulders active
  const engagementBump = Math.exp(-((avgStraightness - 0.8) ** 2) / 0.02) * 0.08;
  const armBendEfficiency = Math.min(1.0, baseEfficiency + engagementBump);

  // Distribute forces between hands and feet based on position
  // Higher hands relative to CoG = more weight on feet
  const handAvgY = (leftHand.y + rightHand.y) / 2;
  const footAvgY = (leftFoot.y + rightFoot.y) / 2;
  const span = Math.max(handAvgY - footAvgY, 0.1);

  // How far up the body the center of gravity is (0 = feet, 1 = hands)
  const cogRatio = Math.max(
    0,
    Math.min(1, (centerOfGravity.y - footAvgY) / span)
  );

  // On steeper terrain, hands bear more of the load
  const overhangFactor = Math.max(0, Math.sin(wallAngleRad));

  // Hand load fraction: closer CoG to feet = less hand load on vertical,
  // but on overhangs hands must resist the outward pull regardless.
  // Twisting hips into the wall reduces the hand load:
  // - CoG moves closer to wall plane, reducing the outward moment
  // - More weight transfers through skeleton to feet via hip contact
  // - Up to ~40% reduction at full 90° twist (real-world climbing benefit)
  // Combined reduction from twist + hip closeness.
  // Twist reduces load by pressing hips in (up to 40%).
  // Close hips reduce load by shortening the moment arm (up to 50%).
  // These compound: closer hips + twist = very efficient position.
  const twistReduction = twistFactor * 0.4;

  // Hip reduction depends on terrain:
  // On overhangs (wallAngleDeg > 0): close hips = good (shorter moment arm)
  // On slab (wallAngleDeg < 0): hips OUT = good (CoG shifts over feet, more downward force through legs)
  // On vertical (wallAngleDeg ≈ 0): close is slightly better
  const slabFactor = Math.max(0, -Math.sin(wallAngleRad)); // 0 on vertical/overhang, up to 1 on steep slab
  const overhangFactor2 = Math.max(0, Math.sin(wallAngleRad)); // 0 on vertical/slab, up to 1 on roof
  // On overhang: close hips reduce load (up to 50%)
  const hipReductionOverhang = (1 - hipDistFactor) * 0.5;
  // On slab: hips OUT reduce load (up to 60%) — pushing CoG over feet is very effective
  const hipReductionSlab = hipDistFactor * 0.6;
  // On vertical: close hips are slightly better (up to 20%)
  const hipReductionVertical = (1 - hipDistFactor) * 0.2;
  // Blend based on wall angle
  const verticalWeight = Math.max(0, 1 - slabFactor - overhangFactor2);
  const hipReduction = hipReductionOverhang * overhangFactor2
    + hipReductionSlab * slabFactor
    + hipReductionVertical * verticalWeight;

  // Torso further from wall = longer moment arm on upper body = more hand load.
  // On slab, torso out is less penalizing since gravity pulls you into the wall.
  const torsoPenalty = torsoOffset * 0.4 * (1 - slabFactor * 0.7);

  // Body directly under holds: when CoG X is centered between hands,
  // gravity pulls straight down through the arms — minimal lateral torque.
  // When CoG is offset sideways, hands must resist a swing force.
  const handMidX = (leftHand.x + rightHand.x) / 2;
  const lateralOffset = Math.abs(centerOfGravity.x - handMidX);
  const handSpanX = Math.abs(leftHand.x - rightHand.x) || 0.1;
  // Normalize by hand span: 0 = directly under, 1 = offset by full hand span
  const lateralRatio = Math.min(1, lateralOffset / Math.max(handSpanX, 0.1));
  // Also check vertical: CoG directly below hands = best (gravity straight through arms)
  const cogBelowHands = Math.max(0, handAvgY - centerOfGravity.y);
  const verticalAlignRatio = Math.min(1, cogBelowHands / Math.max(span, 0.1));
  // Directly under = up to 35% reduction. Offset = no benefit (penalty via lateralRatio).
  const underHandsReduction = verticalAlignRatio * (1 - lateralRatio) * 0.35;

  const combinedReduction = Math.max(0, 1 - (1 - twistReduction) * (1 - hipReduction) * (1 - underHandsReduction) - torsoPenalty);

  // Contact point count affects load distribution.
  // No feet on wall → hands bear ALL the load (cutting feet on overhang).
  // One hand off → other hand bears full hand load.
  const handsOn = (leftHandOn ? 1 : 0) + (rightHandOn ? 1 : 0);
  const feetOn = (leftFootOn ? 1 : 0) + (rightFootOn ? 1 : 0);

  // --- Foot spread stability ---
  // Wider foot base relative to CoG = more stable platform = better weight transfer to feet.
  // Feet close together or directly stacked = less stable, more load on hands.
  // Measured as lateral spread of feet relative to CoG position.
  let footSpreadBonus = 0;
  if (feetOn === 2) {
    const footSpreadX = Math.abs(leftFoot.x - rightFoot.x);
    const footSpreadY = Math.abs(leftFoot.y - rightFoot.y);
    // Lateral spread: wider = more stable (up to a point)
    const optimalSpread = armReach * 0.5; // roughly shoulder width
    const spreadRatio = Math.min(1, footSpreadX / optimalSpread);
    // Vertical spread also helps — triangulates the base
    const vSpreadRatio = Math.min(1, footSpreadY / (armReach * 0.6));
    // CoG centered between feet laterally = stable. Offset = less stable.
    const footMidX = (leftFoot.x + rightFoot.x) / 2;
    const cogFootOffset = Math.abs(centerOfGravity.x - footMidX);
    const cogCentered = Math.max(0, 1 - cogFootOffset / Math.max(footSpreadX * 0.5, 0.05));
    // Combined: good spread + CoG centered = up to 15% reduction in hand load
    footSpreadBonus = (spreadRatio * 0.6 + vSpreadRatio * 0.4) * cogCentered * 0.15;
  }

  // --- Barn door effect ---
  // When 3 contact points form a near-line, the body wants to rotate (barn door)
  // around that axis. The 4th point must resist, increasing load.
  // Classic example: right hand + right foot + left hand in a line → left foot must
  // counteract rotation or hands bear extra load.
  let barnDoorPenalty = 0;
  const contactPoints: { x: number; y: number }[] = [];
  if (leftHandOn) contactPoints.push(leftHand);
  if (rightHandOn) contactPoints.push(rightHand);
  if (leftFootOn) contactPoints.push(leftFoot);
  if (rightFootOn) contactPoints.push(rightFoot);

  if (contactPoints.length >= 3) {
    // Check if CoG is outside the convex hull of contact points (projected on wall plane).
    // If CoG is outside the support polygon, barn door torque increases.
    // Simplified: measure how far CoG is from the centroid of contact points
    // relative to the "width" of the contact polygon.
    const cpCentroidX = contactPoints.reduce((s, p) => s + p.x, 0) / contactPoints.length;
    const cpCentroidY = contactPoints.reduce((s, p) => s + p.y, 0) / contactPoints.length;

    // Compute the average "radius" of the contact polygon
    const avgRadius = contactPoints.reduce((s, p) =>
      s + Math.sqrt((p.x - cpCentroidX) ** 2 + (p.y - cpCentroidY) ** 2), 0
    ) / contactPoints.length;

    // How far is CoG from the centroid?
    const cogDistFromCentroid = Math.sqrt(
      (centerOfGravity.x - cpCentroidX) ** 2 + (centerOfGravity.y - cpCentroidY) ** 2
    );

    // Collinearity: if contact points are nearly in a line, barn door risk is high.
    // Measure the "width" of the contact polygon perpendicular to its longest axis.
    // Use minimum bounding: find the two most distant points, then measure
    // max perpendicular distance of remaining points from that line.
    let maxDist = 0;
    let p1Idx = 0, p2Idx = 1;
    for (let i = 0; i < contactPoints.length; i++) {
      for (let j = i + 1; j < contactPoints.length; j++) {
        const d = Math.sqrt(
          (contactPoints[i].x - contactPoints[j].x) ** 2 +
          (contactPoints[i].y - contactPoints[j].y) ** 2
        );
        if (d > maxDist) { maxDist = d; p1Idx = i; p2Idx = j; }
      }
    }

    let minPerpWidth = Infinity;
    if (maxDist > 0.01) {
      const axisX = contactPoints[p2Idx].x - contactPoints[p1Idx].x;
      const axisY = contactPoints[p2Idx].y - contactPoints[p1Idx].y;
      // Perpendicular distances of all other points from this line
      let maxPerp = 0;
      for (let i = 0; i < contactPoints.length; i++) {
        if (i === p1Idx || i === p2Idx) continue;
        const relX = contactPoints[i].x - contactPoints[p1Idx].x;
        const relY = contactPoints[i].y - contactPoints[p1Idx].y;
        const perp = Math.abs(relX * axisY - relY * axisX) / maxDist;
        maxPerp = Math.max(maxPerp, perp);
      }
      minPerpWidth = maxPerp;
    }

    // Collinearity factor: 0 = wide polygon, 1 = nearly a line
    const collinearity = Math.max(0, 1 - minPerpWidth / (armReach * 0.2));

    // CoG outside support: how far CoG extends beyond the contact polygon radius
    const cogOutside = Math.max(0, cogDistFromCentroid - avgRadius) / (armReach * 0.3);
    const cogOutsideFactor = Math.min(1, cogOutside);

    // Barn door penalty: collinear points + CoG offset = up to 30% more hand load
    // Only significant when points are near-collinear AND CoG creates torque
    barnDoorPenalty = collinearity * 0.2 + cogOutsideFactor * collinearity * 0.1;

    // With only 3 contact points, barn door is always a bigger risk
    if (contactPoints.length === 3) {
      barnDoorPenalty *= 1.4;
    }
  }

  let handLoadFraction: number;
  if (feetOn === 0) {
    // No feet: hands bear everything (campus / feet cut)
    handLoadFraction = 1.0;
  } else if (handsOn === 0) {
    // No hands: feet bear everything (only possible on slab)
    handLoadFraction = 0.0;
  } else {
    // Partial feet: fewer feet = more hand load
    const feetReduction = feetOn === 1 ? 0.7 : 1.0; // one foot = 70% as effective
    const baseLoad = (cogRatio * 0.5 + overhangFactor * 0.8) * (1 - combinedReduction) / feetReduction;
    // Foot spread reduces hand load, barn door increases it
    handLoadFraction = Math.min(
      1,
      Math.max(0, baseLoad - footSpreadBonus + barnDoorPenalty)
    );
  }
  const footLoadFraction = 1 - handLoadFraction;

  // Force along the wall that hands must resist (pulling body up)
  const handForceAlongWallN = Math.abs(gravityAlongWall) * handLoadFraction;

  // Force normal to wall that hands must resist (pulling body outward on overhangs).
  // gravityAlongNormal > 0 means gravity pulls climber AWAY from wall (overhang).
  // Closer hips = shorter moment arm = less outward torque.
  // No feet = hands must resist ALL outward pull.
  const normalReduction = feetOn > 0
    ? 1 - (1 - twistFactor * 0.35) * (1 - (1 - hipDistFactor) * 0.45)
    : 0; // no reduction when feet are cut
  const handForceNormalN = Math.max(0, gravityAlongNormal) * (feetOn === 0 ? 1.0 : 0.9) * (1 - normalReduction);

  // Total hand force magnitude
  const totalHandForceN = Math.sqrt(
    handForceAlongWallN ** 2 + handForceNormalN ** 2
  );
  const totalHandForceKg = totalHandForceN / G;
  const totalHandForceLbs = totalHandForceKg * KG_TO_LBS;

  // Distribute between left and right hand
  let leftHandRatio = 0.5;
  let rightHandRatio = 0.5;
  if (handsOn === 1) {
    // One hand bears all
    leftHandRatio = leftHandOn ? 1 : 0;
    rightHandRatio = rightHandOn ? 1 : 0;
  } else if (handsOn === 2) {
    const leftHandDist = Math.sqrt(
      (leftHand.x - centerOfGravity.x) ** 2 +
        (leftHand.y - centerOfGravity.y) ** 2
    );
    const rightHandDist = Math.sqrt(
      (rightHand.x - centerOfGravity.x) ** 2 +
        (rightHand.y - centerOfGravity.y) ** 2
    );
    const totalDist = leftHandDist + rightHandDist || 1;
    leftHandRatio = rightHandDist / totalDist;
    rightHandRatio = leftHandDist / totalDist;
  }

  // Direction of pull: from hold toward center of gravity
  const leftPullDir = leftHandOn
    ? new THREE.Vector3(centerOfGravity.x - leftHand.x, centerOfGravity.y - leftHand.y, 0).normalize()
    : new THREE.Vector3(0, 0, 0);
  const rightPullDir = rightHandOn
    ? new THREE.Vector3(centerOfGravity.x - rightHand.x, centerOfGravity.y - rightHand.y, 0).normalize()
    : new THREE.Vector3(0, 0, 0);

  const leftHandForce = leftPullDir.multiplyScalar(totalHandForceN * leftHandRatio);
  const rightHandForce = rightPullDir.multiplyScalar(totalHandForceN * rightHandRatio);

  // Foot forces
  const footForceN = Math.abs(gravityAlongWall) * footLoadFraction;
  let leftFootRatio = 0.5;
  let rightFootRatio = 0.5;
  if (feetOn === 1) {
    leftFootRatio = leftFootOn ? 1 : 0;
    rightFootRatio = rightFootOn ? 1 : 0;
  }
  const leftFootPush = new THREE.Vector3(0, 1, 0).multiplyScalar(footForceN * leftFootRatio);
  const rightFootPush = new THREE.Vector3(0, 1, 0).multiplyScalar(footForceN * rightFootRatio);

  // Friction required at feet to stay on
  const frictionRequired =
    wallAngleDeg >= 0 ? Math.abs(gravityAlongNormal) * footLoadFraction : 0;

  // Pull direction efficiency: base grip type + positional bonus/penalty.
  // Hand position relative to CoG determines how well the grip type works biomechanically.
  const pullEfficiency = (
    pull: PullDirection,
    hand: { x: number; y: number },
    isLeft: boolean
  ): number => {
    const overhang = Math.max(0, Math.sin(wallAngleRad));
    const dx = hand.x - centerOfGravity.x; // positive = hand is right of CoG
    const dy = hand.y - centerOfGravity.y; // positive = hand is above CoG

    // Normalize offsets by arm reach for consistent scaling
    const normDy = Math.min(1, Math.max(-1, dy / (armReach * 0.8)));
    const normDx = Math.min(1, Math.max(-1, dx / (armReach * 0.5)));
    const lateralDist = Math.abs(normDx); // how far to the side

    switch (pull) {
      case "down": {
        // Best when hand is above CoG (pulling down along gravity).
        // Worse when hand is at or below CoG — can't pull "down" effectively.
        const aboveBonus = normDy > 0 ? normDy * 0.15 : normDy * 0.25;
        return Math.max(0.3, 0.85 + aboveBonus);
      }
      case "side": {
        // Best when hand is out to the side of CoG (lateral pull).
        // Side pull on the correct side: left hand pulling left, right hand pulling right.
        const correctSide = isLeft ? (dx < 0) : (dx > 0);
        const sideBonus = lateralDist * (correctSide ? 0.15 : -0.1);
        // Worse when hand is directly above — no lateral vector to exploit.
        const abovePenalty = normDy > 0.5 ? (normDy - 0.5) * -0.1 : 0;
        return Math.max(0.3, 0.80 + sideBonus + abovePenalty);
      }
      case "undercling": {
        // Best when hand is below or at CoG (pulling upward from underneath).
        // Terrible when hand is high above — biomechanically impossible to undercling well.
        const belowBonus = normDy < 0 ? Math.abs(normDy) * 0.2 : -normDy * 0.3;
        return Math.max(0.3, 0.70 + belowBonus - overhang * 0.15);
      }
      case "gaston": {
        // Best when hand is across the body (left hand right of center, right hand left).
        // Pushing outward is always inefficient but position matters.
        const correctSide = isLeft ? (dx > 0) : (dx < 0); // across body
        const crossBonus = lateralDist * (correctSide ? 0.15 : -0.1);
        return Math.max(0.3, 0.60 + crossBonus);
      }
      case "sloper": {
        // Friction-dependent. Best when hand is above and close to body (max contact pressure).
        // Worse on overhangs (gravity pulls fingers off), worse when far from body.
        const aboveBonus = normDy > 0 ? normDy * 0.1 : normDy * 0.15;
        const distPenalty = lateralDist * -0.1;
        return Math.max(0.3, 0.85 + aboveBonus + distPenalty - overhang * 0.35);
      }
    }
  };
  // Average pull efficiency across both hands (weighted by load ratio)
  const avgPullEfficiency =
    pullEfficiency(leftHandPull, leftHand, true) * leftHandRatio +
    pullEfficiency(rightHandPull, rightHand, false) * rightHandRatio;

  // Effective grip = raw grip * pull efficiency * arm bend efficiency
  // Straight arms: skeleton bears load → full grip available
  // Bent arms: muscles fatigue faster → effectively less grip endurance
  const effectiveGripKg = gripStrengthKg * avgPullEfficiency * armBendEfficiency;
  const gripStrengthPercentUsed = (totalHandForceKg / effectiveGripKg) * 100;

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
