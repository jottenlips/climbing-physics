import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import * as THREE from "three";
import { ClimberConfig, ForceResult, computeForces } from "../physics/climbingPhysics";

const FORCE_SCALE = 0.003;
const HOLD_OFFSET = 0.02;

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

// Clamp a target position to be within maxReach of origin.
// Returns the target if in range, or the closest point at maxReach distance.
function clampToReach(origin: V3, target: V3, maxReach: number): V3 {
  const toTarget = v3sub(target, origin);
  const dist = v3len(toTarget);
  if (dist <= maxReach) return target;
  const dir = v3normalize(toTarget);
  return v3add(origin, v3scale(dir, maxReach));
}

// 2-bone IK: given origin, target, bone lengths, and a preferred bend direction,
// returns the joint (elbow/knee) position.
function solveIK2Bone(
  origin: V3,
  target: V3,
  lenUpper: number,
  lenLower: number,
  bendDir: V3, // which direction the joint should bend toward
): V3 {
  const toTarget = v3sub(target, origin);
  const dist = v3len(toTarget);
  const totalLen = lenUpper + lenLower;

  // If target is too far, straighten the limb
  if (dist >= totalLen * 0.999) {
    const dir = v3normalize(toTarget);
    return v3add(origin, v3scale(dir, lenUpper));
  }

  // If target is too close, collapse
  if (dist < Math.abs(lenUpper - lenLower) + 0.001) {
    return v3add(origin, v3scale(v3normalize(bendDir), lenUpper * 0.5));
  }

  // Law of cosines to find angle at origin
  const cosAngle = (lenUpper * lenUpper + dist * dist - lenLower * lenLower) / (2 * lenUpper * dist);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));

  // Build a coordinate frame:
  // forward = toward target
  // up = component of bendDir perpendicular to forward
  const forward = v3normalize(toTarget);
  // Remove component of bendDir along forward
  const bendAlongFwd = v3dot(bendDir, forward);
  let up = v3sub(bendDir, v3scale(forward, bendAlongFwd));
  const upLen = v3len(up);
  if (upLen < 0.001) {
    // bendDir is parallel to forward, pick an arbitrary perpendicular
    up = v3cross(forward, [1, 0, 0]);
    if (v3len(up) < 0.001) up = v3cross(forward, [0, 1, 0]);
  }
  up = v3normalize(up);

  // Joint position: rotate forward by angle toward up
  const jointDir = v3add(
    v3scale(forward, Math.cos(angle)),
    v3scale(up, Math.sin(angle))
  );
  return v3add(origin, v3scale(jointDir, lenUpper));
}

function ArrowLine({ start, direction, color }: { start: V3; direction: THREE.Vector3; color: string }) {
  const length = direction.length() * FORCE_SCALE;
  if (length < 0.02) return null;
  const dir = direction.clone().normalize();
  const end: V3 = [start[0] + dir.x * length, start[1] + dir.y * length, start[2] + dir.z * length];
  return (
    <group>
      <Line points={[start, end]} color={color} lineWidth={2} />
      <mesh position={end}>
        <sphereGeometry args={[0.02, 8, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

function Joint({ position, size = 0.025, color = "#ddccbb" }: { position: V3; size?: number; color?: string }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[size, 10, 10]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
}

function Limb({ from, to, color = "#cc9977", width = 2 }: { from: V3; to: V3; color?: string; width?: number }) {
  return <Line points={[from, to]} color={color} lineWidth={width} />;
}

function Hold({ position, color, size = 0.04, wallAngleRad }: { position: V3; color: string; size?: number; wallAngleRad: number }) {
  return (
    <mesh position={position} rotation={[wallAngleRad, 0, 0]}>
      <boxGeometry args={[size * 2.5, size, size * 0.8]} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  );
}

function Wall({ angleDeg }: { angleDeg: number }) {
  const angleRad = (angleDeg * Math.PI) / 180;
  const wallWidth = 3;
  const wallHeight = 4;
  return (
    <group>
      <mesh
        rotation={[angleRad, 0, 0]}
        position={[0, wallHeight / 2 * Math.cos(angleRad), wallHeight / 2 * Math.sin(angleRad)]}
      >
        <planeGeometry args={[wallWidth, wallHeight]} />
        <meshStandardMaterial color="#8B7355" side={THREE.DoubleSide} transparent opacity={0.45} />
      </mesh>
      <mesh
        rotation={[angleRad, 0, 0]}
        position={[0, wallHeight / 2 * Math.cos(angleRad), wallHeight / 2 * Math.sin(angleRad) + 0.001]}
      >
        <planeGeometry args={[wallWidth, wallHeight, 6, 8]} />
        <meshBasicMaterial color="#6B5335" wireframe side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function Climber({ config, forces }: { config: ClimberConfig; forces: ForceResult }) {
  const angleRad = forces.wallAngleRad;
  const s = config.heightFt / 5.75;
  const heightM = config.heightFt * 0.3048;
  const apeRatio = config.apeIndexIn / (config.heightFt * 12);

  // Wall basis vectors
  const wallUp: V3 = [0, Math.cos(angleRad), Math.sin(angleRad)];
  const wallNorm: V3 = [0, -Math.sin(angleRad), Math.cos(angleRad)];

  // Place a point on the wall surface (x=lateral, h=height along wall, d=offset along normal)
  const toWorld = (x: number, h: number, d: number): V3 => [
    x,
    h * wallUp[1] + d * wallNorm[1],
    h * wallUp[2] + d * wallNorm[2],
  ];

  // Holds ON the wall
  const lh = toWorld(config.leftHand.x, config.leftHand.y, HOLD_OFFSET);
  const rh = toWorld(config.rightHand.x, config.rightHand.y, HOLD_OFFSET);
  const lf = toWorld(config.leftFoot.x, config.leftFoot.y, HOLD_OFFSET);
  const rf = toWorld(config.rightFoot.x, config.rightFoot.y, HOLD_OFFSET);

  // Anatomically correct body proportions (as fractions of height)
  // Reference: NASA anthropometric data, average adult
  const bodyOffMax = 1.0 * s; // max distance hips can be from wall
  const bodyOff = 0.04 * s + config.hipOffset * (bodyOffMax - 0.04 * s); // 0=close, 1=far
  const torsoLen = 0.30 * s; // C7 vertebra to hip joint ~30% of height
  const shoulderW = 0.115 * s * apeRatio; // biacromial half-breadth ~23% of height
  const hipW = 0.085 * s; // bi-iliac half-breadth ~17% of height
  const headRadius = 0.065 * s; // head height ~13% of height (diameter ~0.13)
  const neckLen = 0.035 * s; // neck ~3.5% of height

  // Arm segments (shoulder to fingertip = armLen)
  // Upper arm (shoulder→elbow) 42%, forearm (elbow→wrist) 33%, hand (wrist→tip) 25%
  const armLen = (config.apeIndexIn / 2) * 0.0254 * s / heightM;
  const upperArm = armLen * 0.42;
  const forearm = armLen * 0.33;
  const handLen = armLen * 0.25; // wrist to fingertip

  // Leg segments (hip to sole = legLen)
  // Thigh (hip→knee) 52%, shin (knee→ankle) 40%, foot height 8%
  const legLen = 0.47 * s; // legs are ~47% of height
  const thigh = legLen * 0.52;
  const shin = legLen * 0.40;
  const footHeight = legLen * 0.08; // ankle height above sole

  // Hip twist: climber turns hips into the wall (drop knee, hip turn).
  // Hips rotate around the wall normal, pressing into the wall.
  // Shoulders stay mostly square to the wall — only follow partially.
  // This is how climbers gain reach: hips in, torso extends, shoulder stays out.
  const twistRad = (config.bodyRotationDeg * Math.PI) / 180;
  const absTwist = Math.abs(twistRad);
  const cosT = Math.cos(twistRad);
  const sinT = Math.sin(twistRad);

  // Rotate a lateral offset (dx) and wall-height offset (dh) by an angle
  const rotateInWallPlane = (dx: number, dh: number, cos: number, sin: number): [number, number] => [
    dx * cos - dh * sin,
    dx * sin + dh * cos,
  ];

  // Hips press into the wall as they twist
  const hipNormalOff = bodyOff * Math.cos(absTwist);

  // Chest/shoulders stay mostly out — only follow ~20% of the hip twist
  const partialTwist = twistRad * 0.45;
  const cosPT = Math.cos(partialTwist);
  const sinPT = Math.sin(partialTwist);
  // Torso distance from wall, independent of hips. Limited by arm reach (hands stay on wall).
  const maxChestOff = (upperArm + forearm + handLen) * 0.85;
  const chestNormalOff = 0.04 * s + config.torsoOffset * (maxChestOff - 0.04 * s);

  // CoG / pelvis — hips close to wall when twisted
  const cogX = config.centerOfGravity.x;
  const cogH = config.centerOfGravity.y;
  const pelvis = toWorld(cogX, cogH, hipNormalOff);

  // Chest: above pelvis, only slightly affected by twist
  const [chestDx, chestDh] = rotateInWallPlane(0, torsoLen, cosPT, sinPT);
  const chest = toWorld(cogX + chestDx, cogH + chestDh, chestNormalOff);

  // Head: follows chest, sits on neck above shoulders
  const [headDx, headDh] = rotateInWallPlane(0, torsoLen + neckLen + headRadius, cosPT, sinPT);
  const head = toWorld(cogX + headDx, cogH + headDh, chestNormalOff * 0.95);

  // Shoulders: stay square to wall (minimal twist)
  const [slDx, slDh] = rotateInWallPlane(-shoulderW, torsoLen, cosPT, sinPT);
  const [srDx, srDh] = rotateInWallPlane(shoulderW, torsoLen, cosPT, sinPT);
  const shoulderL = toWorld(cogX + slDx, cogH + slDh, chestNormalOff);
  const shoulderR = toWorld(cogX + srDx, cogH + srDh, chestNormalOff);

  // Hips: full twist rotation, pressed into wall
  const [hlDx, hlDh] = rotateInWallPlane(-hipW, 0, cosT, sinT);
  const [hrDx, hrDh] = rotateInWallPlane(hipW, 0, cosT, sinT);
  const hipL = toWorld(cogX + hlDx, cogH + hlDh, hipNormalOff);
  const hipR = toWorld(cogX + hrDx, cogH + hrDh, hipNormalOff);

  // Max reach: full limb extension from joint origin
  const armReach = upperArm + forearm + handLen;
  const legReach = thigh + shin + footHeight;

  // Clamp hold targets to max reach from their joint origins.
  // Holds render at their actual wall position, but the hand/foot
  // endpoint is clamped so the body never stretches beyond its anatomy.
  const lhClamped = clampToReach(shoulderL, lh, armReach);
  const rhClamped = clampToReach(shoulderR, rh, armReach);
  const lfClamped = clampToReach(hipL, lf, legReach);
  const rfClamped = clampToReach(hipR, rf, legReach);

  // Compute bend direction for a joint: perpendicular to the limb axis,
  // guaranteed to point away from the wall (positive wallNorm side).
  // Uses cross product with lateral axis, then flips if pointing into wall.
  const bendAwayFromWall = (origin: V3, target: V3, lateralSign: number): V3 => {
    const forward = v3normalize(v3sub(target, origin));
    const lateral: V3 = [lateralSign, 0, 0];
    let bend = v3cross(forward, lateral);
    if (v3len(bend) < 0.001) {
      // forward is parallel to lateral, fallback
      bend = v3cross(forward, [0, 1, 0]);
    }
    bend = v3normalize(bend);
    // Ensure it points away from wall (positive dot with wallNorm)
    if (v3dot(bend, wallNorm) < 0) {
      bend = v3scale(bend, -1);
    }
    return bend;
  };

  // Derive wrist/ankle from clamped targets.
  // Wrist is handLen back along the direction from shoulder to clamped hand.
  // Ankle is footHeight back along the direction from hip to clamped foot.
  const wristFromClamped = (shoulder: V3, hand: V3): V3 => {
    const toHand = v3sub(hand, shoulder);
    const dist = v3len(toHand);
    if (dist < 0.001) return hand;
    const dir = v3normalize(toHand);
    // Wrist sits handLen back from the hand, offset slightly from wall
    const wristDist = Math.max(0, dist - handLen);
    const wristOnLine = v3add(shoulder, v3scale(dir, wristDist));
    // Add a small normal offset so wrist isn't flat on wall
    return v3add(wristOnLine, v3scale(wallNorm, chestNormalOff * 0.3));
  };

  const ankleFromClamped = (hip: V3, foot: V3): V3 => {
    const toFoot = v3sub(foot, hip);
    const dist = v3len(toFoot);
    if (dist < 0.001) return foot;
    const dir = v3normalize(toFoot);
    // Ankle sits footHeight back from the foot, offset slightly from wall
    const ankleDist = Math.max(0, dist - footHeight);
    const ankleOnLine = v3add(hip, v3scale(dir, ankleDist));
    return v3add(ankleOnLine, v3scale(wallNorm, hipNormalOff * 0.2));
  };

  const wristL = wristFromClamped(shoulderL, lhClamped);
  const wristR = wristFromClamped(shoulderR, rhClamped);
  const ankleL = ankleFromClamped(hipL, lfClamped);
  const ankleR = ankleFromClamped(hipR, rfClamped);

  // Solve IK with dynamically computed bend directions
  // Elbows: bend away from wall, lateral splay outward
  const elbowBendL = bendAwayFromWall(shoulderL, wristL, -1);
  const elbowBendR = bendAwayFromWall(shoulderR, wristR, 1);
  const elbowL = solveIK2Bone(shoulderL, wristL, upperArm, forearm, elbowBendL);
  const elbowR = solveIK2Bone(shoulderR, wristR, upperArm, forearm, elbowBendR);

  // Knee bend direction with turn control for drop knees, flags, etc.
  // Adapts to hip-ankle geometry: when legs are bunched (feet high),
  // knees splay more outward. When extended, knees stay forward.
  const computeKneeBend = (hip: V3, ankle: V3, turnDeg: number, lateralSign: number): V3 => {
    const hipToAnkle = v3sub(ankle, hip);
    const legDist = v3len(hipToAnkle);
    const maxLeg = thigh + shin;
    // How bunched the leg is: 0 = fully extended, 1 = very bunched
    const bunchFactor = Math.max(0, 1 - legDist / (maxLeg * 0.95));

    // How much the foot is below vs at/above hip height (in wall coords)
    // footBelow > 0 when foot is below hip (normal standing)
    const hipH = v3dot(hip, wallUp);
    const ankleH = v3dot(ankle, wallUp);
    const footBelow = Math.max(0, Math.min(1, (hipH - ankleH) / (maxLeg * 0.5)));

    // Base bend direction adapts to leg geometry:
    // - Foot well below hip: knees forward (wallNorm) + slight up
    // - Foot near hip level (bunched): knees strongly outward (lateral + wallNorm)
    // - Always some wallNorm to keep knees off the wall
    const upWeight = 0.3 + footBelow * 0.7; // more upward when foot is below
    const lateralWeight = 0.15 + bunchFactor * 0.5; // more lateral when bunched
    const normWeight = 0.5 + bunchFactor * 0.3; // more outward when bunched

    let baseBend: V3 = v3normalize(
      v3add(
        v3add(
          v3scale([0, 1, 0], upWeight),
          v3scale(wallNorm, normWeight)
        ),
        [lateralSign * lateralWeight, 0, 0]
      )
    );

    // Apply knee turn rotation (drop knee / frog)
    if (Math.abs(turnDeg) >= 1) {
      const axis = v3normalize(hipToAnkle);
      const turnRad = (turnDeg * Math.PI) / 180;
      const cos = Math.cos(turnRad);
      const sin = Math.sin(turnRad);
      // Rodrigues' rotation
      const dot = v3dot(baseBend, axis);
      const cross = v3cross(axis, baseBend);
      baseBend = v3normalize(v3add(
        v3add(v3scale(baseBend, cos), v3scale(cross, sin)),
        v3scale(axis, dot * (1 - cos))
      ));
    }

    return baseBend;
  };

  const kneeBendL = computeKneeBend(hipL, ankleL, config.leftKneeTurnDeg, -1);
  const kneeBendR = computeKneeBend(hipR, ankleR, config.rightKneeTurnDeg, 1);
  let kneeL = solveIK2Bone(hipL, ankleL, thigh, shin, kneeBendL);
  let kneeR = solveIK2Bone(hipR, ankleR, thigh, shin, kneeBendR);

  // Clamp knees so they never go behind the wall surface.
  // Project knee onto wall normal — if negative (behind wall), push it forward.
  const clampKneeToWall = (knee: V3): V3 => {
    const kneeNormalDist = v3dot(knee, wallNorm);
    const minDist = 0.02; // small offset to keep knee visually in front
    if (kneeNormalDist < minDist) {
      // Push knee forward along wallNorm to minDist
      return v3add(knee, v3scale(wallNorm, minDist - kneeNormalDist));
    }
    return knee;
  };
  kneeL = clampKneeToWall(kneeL);
  kneeR = clampKneeToWall(kneeR);

  // Dangling limbs: when a limb is off the wall, it hangs straight down
  // from its joint origin under gravity. Elbow/knee at upper bone length down,
  // wrist/ankle at upper+lower down, hand/foot at full length down.
  let finalElbowL = elbowL, finalWristL = wristL, finalLh = lhClamped;
  let finalElbowR = elbowR, finalWristR = wristR, finalRh = rhClamped;
  let finalKneeL = kneeL, finalAnkleL = ankleL, finalLf = lfClamped;
  let finalKneeR = kneeR, finalAnkleR = ankleR, finalRf = rfClamped;

  if (!config.leftHandOn) {
    finalElbowL = v3add(shoulderL, [0, -upperArm, 0]);
    finalWristL = v3add(shoulderL, [0, -(upperArm + forearm), 0]);
    finalLh = v3add(shoulderL, [0, -(upperArm + forearm + handLen), 0]);
  }
  if (!config.rightHandOn) {
    finalElbowR = v3add(shoulderR, [0, -upperArm, 0]);
    finalWristR = v3add(shoulderR, [0, -(upperArm + forearm), 0]);
    finalRh = v3add(shoulderR, [0, -(upperArm + forearm + handLen), 0]);
  }
  if (!config.leftFootOn) {
    finalKneeL = v3add(hipL, [0, -thigh, 0]);
    finalAnkleL = v3add(hipL, [0, -(thigh + shin), 0]);
    finalLf = v3add(hipL, [0, -(thigh + shin + footHeight), 0]);
  }
  if (!config.rightFootOn) {
    finalKneeR = v3add(hipR, [0, -thigh, 0]);
    finalAnkleR = v3add(hipR, [0, -(thigh + shin), 0]);
    finalRf = v3add(hipR, [0, -(thigh + shin + footHeight), 0]);
  }

  const canHold = forces.canHold;
  const skinColor = canHold ? "#ddbbaa" : "#ff8888";
  const limbColor = canHold ? "#cc9977" : "#ee6655";
  const torsoColor = canHold ? "#5588aa" : "#aa4444";

  return (
    <group>
      {/* Holds — only show if limb is on wall */}
      {config.leftHandOn && <Hold position={lh} color="#dd5533" size={0.04} wallAngleRad={angleRad} />}
      {config.rightHandOn && <Hold position={rh} color="#dd5533" size={0.04} wallAngleRad={angleRad} />}
      {config.leftFootOn && <Hold position={lf} color="#557799" size={0.035} wallAngleRad={angleRad} />}
      {config.rightFootOn && <Hold position={rf} color="#557799" size={0.035} wallAngleRad={angleRad} />}

      {/* Head */}
      <mesh position={head}>
        <sphereGeometry args={[headRadius, 16, 16]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>

      {/* Neck & Torso — width scales with body weight */}
      <Limb from={head} to={chest} color={skinColor} width={3} />
      {(() => {
        // Subtle body girth scaling with weight
        const weightFactor = Math.max(0.85, Math.min(1.25, config.bodyWeightKg / 70)); // 1.0 at 70kg
        const torsoMid: V3 = [
          (chest[0] + pelvis[0]) / 2,
          (chest[1] + pelvis[1]) / 2,
          (chest[2] + pelvis[2]) / 2,
        ];
        const torsoHeight = v3len(v3sub(chest, pelvis));
        const torsoDir = v3normalize(v3sub(chest, pelvis));
        const chestWidth = shoulderW * 0.8 * weightFactor;
        const waistWidth = hipW * 1.0 * weightFactor;
        const up = new THREE.Vector3(0, 1, 0);
        const dir = new THREE.Vector3(...torsoDir);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);

        return (
          <mesh position={torsoMid} quaternion={quat}>
            <cylinderGeometry args={[chestWidth, waistWidth, torsoHeight * 0.95, 12]} />
            <meshStandardMaterial color={torsoColor} roughness={0.7} />
          </mesh>
        );
      })()}
      <Limb from={shoulderL} to={shoulderR} color={torsoColor} width={4} />
      <Limb from={hipL} to={hipR} color={torsoColor} width={3} />

      {/* Left arm */}
      <Limb from={shoulderL} to={finalElbowL} color={limbColor} width={3.5} />
      <Limb from={finalElbowL} to={finalWristL} color={limbColor} width={2.5} />
      <Limb from={finalWristL} to={finalLh} color={limbColor} width={1.5} />
      <Joint position={shoulderL} size={0.032 * s} color={skinColor} />
      <Joint position={finalElbowL} size={0.024 * s} color={skinColor} />
      <Joint position={finalWristL} size={0.016 * s} color={skinColor} />

      {/* Right arm */}
      <Limb from={shoulderR} to={finalElbowR} color={limbColor} width={3.5} />
      <Limb from={finalElbowR} to={finalWristR} color={limbColor} width={2.5} />
      <Limb from={finalWristR} to={finalRh} color={limbColor} width={1.5} />
      <Joint position={shoulderR} size={0.032 * s} color={skinColor} />
      <Joint position={finalElbowR} size={0.024 * s} color={skinColor} />
      <Joint position={finalWristR} size={0.016 * s} color={skinColor} />

      {/* Left leg */}
      <Limb from={hipL} to={finalKneeL} color="#445566" width={4} />
      <Limb from={finalKneeL} to={finalAnkleL} color="#445566" width={3} />
      <Limb from={finalAnkleL} to={finalLf} color="#445566" width={2} />
      <Joint position={hipL} size={0.034 * s} color={skinColor} />
      <Joint position={finalKneeL} size={0.028 * s} color={skinColor} />
      <Joint position={finalAnkleL} size={0.018 * s} color={skinColor} />

      {/* Right leg */}
      <Limb from={hipR} to={finalKneeR} color="#445566" width={4} />
      <Limb from={finalKneeR} to={finalAnkleR} color="#445566" width={3} />
      <Limb from={finalAnkleR} to={finalRf} color="#445566" width={2} />
      <Joint position={hipR} size={0.034 * s} color={skinColor} />
      <Joint position={finalKneeR} size={0.028 * s} color={skinColor} />
      <Joint position={finalAnkleR} size={0.018 * s} color={skinColor} />

      {/* Hands */}
      <Joint position={finalLh} size={0.018 * s} color={skinColor} />
      <Joint position={finalRh} size={0.018 * s} color={skinColor} />

      {/* Feet — climbing shoe shape */}
      <mesh position={finalLf} rotation={[config.leftFootOn ? angleRad : 0, 0, 0]}>
        <boxGeometry args={[0.035 * s, footHeight, 0.07 * s]} />
        <meshStandardMaterial color="#334455" roughness={0.8} />
      </mesh>
      <mesh position={finalRf} rotation={[config.rightFootOn ? angleRad : 0, 0, 0]}>
        <boxGeometry args={[0.035 * s, footHeight, 0.07 * s]} />
        <meshStandardMaterial color="#334455" roughness={0.8} />
      </mesh>

      {/* Chalk bag — Organic style: sage green + orange stripe, black fleece rim */}
      {(() => {
        const bagSize = 0.038 * s;
        // Lower back: ~15% up torso, behind the climber — sits at harness level
        const lowerBack: V3 = v3add(
          v3add(pelvis, v3scale(v3sub(chest, pelvis), 0.15)),
          v3scale(wallNorm, 0.12 * s) // behind the climber (away from wall)
        );
        // Bag hangs below the belt loop attachment
        const bagPos: V3 = v3add(lowerBack, [0, -0.03 * s, 0]);
        // Drawstring end dangles below bag
        const cordEnd: V3 = v3add(bagPos, [-bagSize * 0.3, -bagSize * 1.2, 0]);
        const cordMid: V3 = v3add(bagPos, [-bagSize * 0.5, -bagSize * 0.6, 0]);
        return (
          <group>
            {/* Belt loop / strap across lower back */}
            <Limb from={v3add(lowerBack, [hipW * 0.7, 0.01 * s, 0])} to={v3add(lowerBack, [-hipW * 0.7, 0.01 * s, 0])} color="#555544" width={1.5} />
            {/* Short loop to bag */}
            <Limb from={lowerBack} to={bagPos} color="#555544" width={1} />

            {/* Main bag body — sage green */}
            <mesh position={bagPos}>
              <cylinderGeometry args={[bagSize * 0.75, bagSize * 0.9, bagSize * 1.6, 10]} />
              <meshStandardMaterial color="#8faa7a" roughness={0.85} />
            </mesh>
            {/* Orange racing stripe — front panel */}
            <mesh position={v3add(bagPos, v3scale(wallNorm, -bagSize * 0.01))}>
              <cylinderGeometry args={[bagSize * 0.76, bagSize * 0.91, bagSize * 1.4, 10, 1, false, -0.4, 0.8]} />
              <meshStandardMaterial color="#e8622a" roughness={0.8} />
            </mesh>
            {/* Dark green side stripe */}
            <mesh position={v3add(bagPos, v3scale(wallNorm, -bagSize * 0.005))}>
              <cylinderGeometry args={[bagSize * 0.77, bagSize * 0.92, bagSize * 1.3, 10, 1, false, 0.6, 0.5]} />
              <meshStandardMaterial color="#2d5a2d" roughness={0.8} />
            </mesh>

            {/* Black fleece rim at top */}
            <mesh position={v3add(bagPos, [0, bagSize * 0.8, 0])}>
              <cylinderGeometry args={[bagSize * 0.7, bagSize * 0.78, bagSize * 0.35, 10]} />
              <meshStandardMaterial color="#222222" roughness={1.0} />
            </mesh>

            {/* Orange drawstring cord */}
            <Limb from={v3add(bagPos, [-bagSize * 0.6, bagSize * 0.6, 0])} to={cordMid} color="#e8622a" width={1} />
            <Limb from={cordMid} to={cordEnd} color="#e8622a" width={1} />
            {/* Cord knot */}
            <mesh position={cordEnd}>
              <sphereGeometry args={[bagSize * 0.08, 6, 6]} />
              <meshStandardMaterial color="#e8622a" roughness={0.7} />
            </mesh>
          </group>
        );
      })()}

      {/* Harness gear loops + quickdraws */}
      {(() => {
        const binerSize = 0.015 * s;
        const dogboneLen = 0.045 * s;

        // Harness gear loop: circular, snug around hips at pelvis height
        const loopRadius = hipW * 1.05; // circle around hips
        const loopH = 0.005 * s; // at pelvis height

        // Gear loop points going around the harness
        const gearPts: V3[] = [];
        const nPts = 12;
        for (let i = 0; i < nPts; i++) {
          const a = (i / nPts) * Math.PI * 2;
          const lx = Math.sin(a) * loopRadius;
          const lnorm = hipNormalOff + Math.cos(a) * loopRadius;
          gearPts.push(toWorld(cogX + lx, cogH - loopH, lnorm));
        }

        // Draw gear loop segments
        const loopSegments: JSX.Element[] = [];
        for (let i = 0; i < nPts; i++) {
          loopSegments.push(
            <Limb key={`gl${i}`} from={gearPts[i]} to={gearPts[(i + 1) % nPts]} color="#555" width={1.5} />
          );
        }

        // Quickdraw: top biner → dogbone (sling) → bottom biner
        // Place 3 on each side of harness
        const qdColors = ["#3388dd", "#dd4433", "#44bb44", "#ddaa22", "#aa44cc", "#dd7733"];
        const qdPositions = [
          { idx: 2, side: 1 },   // front-left
          { idx: 3, side: 1 },   // left
          { idx: 4, side: 1 },   // back-left
          { idx: 8, side: -1 },  // front-right
          { idx: 9, side: -1 },  // right
          { idx: 10, side: -1 }, // back-right
        ];

        const quickdraws = qdPositions.map((qd, qi) => {
          const attachPt = gearPts[qd.idx];
          // Top carabiner hangs from gear loop
          const topBiner: V3 = v3add(attachPt, [0, -0.01 * s, 0]);
          // Dogbone sling hangs down
          const dogTop: V3 = v3add(topBiner, [0, -binerSize * 1.5, 0]);
          const dogBot: V3 = v3add(dogTop, [0, -dogboneLen, 0]);
          // Bottom carabiner
          const botBiner: V3 = v3add(dogBot, [0, -binerSize * 1.2, 0]);
          const slingColor = qdColors[qi % qdColors.length];

          return (
            <group key={`qd${qi}`}>
              {/* Top carabiner */}
              <Limb from={attachPt} to={topBiner} color="#999" width={0.5} />
              <mesh position={topBiner}>
                <torusGeometry args={[binerSize, binerSize * 0.22, 5, 10]} />
                <meshStandardMaterial color="#c0c0c0" metalness={0.8} roughness={0.2} />
              </mesh>
              {/* Dogbone sling */}
              <Limb from={dogTop} to={dogBot} color={slingColor} width={2.5} />
              {/* Sling ends (wider nylon) */}
              <mesh position={dogTop}>
                <boxGeometry args={[binerSize * 1.8, binerSize * 0.6, binerSize * 0.3]} />
                <meshStandardMaterial color={slingColor} roughness={0.9} />
              </mesh>
              <mesh position={dogBot}>
                <boxGeometry args={[binerSize * 1.8, binerSize * 0.6, binerSize * 0.3]} />
                <meshStandardMaterial color={slingColor} roughness={0.9} />
              </mesh>
              {/* Bottom carabiner */}
              <mesh position={botBiner}>
                <torusGeometry args={[binerSize * 0.9, binerSize * 0.22, 5, 10]} />
                <meshStandardMaterial color="#b0b0b0" metalness={0.8} roughness={0.2} />
              </mesh>
            </group>
          );
        });

        return (
          <group>
            {loopSegments}
            {quickdraws}
          </group>
        );
      })()}

      {/* CoG */}
      <mesh position={pelvis}>
        <sphereGeometry args={[0.03, 12, 12]} />
        <meshStandardMaterial
          color={canHold ? "#44ff88" : "#ff2222"}
          emissive={canHold ? "#22aa44" : "#aa0000"}
          emissiveIntensity={0.6}
          transparent
          opacity={0.7}
        />
      </mesh>

      {/* Force arrows — only on active limbs */}
      <ArrowLine start={pelvis} direction={forces.gravity.clone().multiplyScalar(0.1)} color="#ff0000" />
      {config.leftHandOn && <ArrowLine start={finalLh} direction={forces.leftHandPull} color="#ffaa00" />}
      {config.rightHandOn && <ArrowLine start={finalRh} direction={forces.rightHandPull} color="#ffcc00" />}
      {config.leftFootOn && <ArrowLine start={finalLf} direction={forces.leftFootPush} color="#00aaff" />}
      {config.rightFootOn && <ArrowLine start={finalRf} direction={forces.rightFootPush} color="#0088ff" />}
      {forces.normal.length() > 0.1 && (
        <ArrowLine start={pelvis} direction={forces.normal.clone().multiplyScalar(0.1)} color="#aa44ff" />
      )}
    </group>
  );
}


export default function ClimbingScene({ config }: { config: ClimberConfig }) {
  const forces = useMemo(() => computeForces(config), [config]);
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}>
      <Canvas camera={{ position: [3, 2.5, 5], fov: 50 }} style={{ background: "#1a1a2e" }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[3, 5, 4]} intensity={0.8} />
        <pointLight position={[-2, 3, 3]} intensity={0.3} />
        <Wall angleDeg={config.wallAngleDeg} />
        <Climber config={config} forces={forces} />
        <OrbitControls makeDefault minDistance={2} maxDistance={10} target={[0, 1.5, 0.5]} />
        <gridHelper args={[10, 20, "#333333", "#222222"]} />
      </Canvas>
    </div>
  );
}
