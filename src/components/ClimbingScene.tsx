import { useMemo, useCallback, useRef, useEffect } from "react";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { OrbitControls, Line, Sky, Text } from "@react-three/drei";
import * as THREE from "three";
import {
  ClimberConfig,
  ForceResult,
  computeForces,
  PullDirection,
} from "../physics/climbingPhysics";
import { PlacedHold, HoldDirection, HOLD_INFO } from "../holds/holdTypes";

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
  const cosAngle =
    (lenUpper * lenUpper + dist * dist - lenLower * lenLower) /
    (2 * lenUpper * dist);
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
    v3scale(up, Math.sin(angle)),
  );
  return v3add(origin, v3scale(jointDir, lenUpper));
}

function ArrowLine({
  start,
  direction,
  color,
}: {
  start: V3;
  direction: THREE.Vector3;
  color: string;
}) {
  const length = direction.length() * FORCE_SCALE;
  if (length < 0.02) return null;
  const dir = direction.clone().normalize();
  const end: V3 = [
    start[0] + dir.x * length,
    start[1] + dir.y * length,
    start[2] + dir.z * length,
  ];
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

function Joint({
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

function Limb({
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

// Direction rotation: rotate hold on the wall plane based on direction
function directionRotationZ(dir: HoldDirection): number {
  switch (dir) {
    case "up":
      return 0;
    case "down":
      return Math.PI;
    case "left":
      return Math.PI / 2;
    case "right":
      return -Math.PI / 2;
    case "up-left":
      return Math.PI / 4;
    case "up-right":
      return -Math.PI / 4;
    case "down-left":
      return (Math.PI * 3) / 4;
    case "down-right":
      return (-Math.PI * 3) / 4;
  }
}

// Usage indicator: small colored dot showing hand/foot/both
function UsageDot({
  usage,
  wallAngleRad,
  offset,
}: {
  usage: string;
  wallAngleRad: number;
  offset: V3;
}) {
  const c =
    usage === "foot" ? "#4488ff" : usage === "hand" ? "#ff6644" : "#aaccaa";
  return (
    <mesh position={offset} rotation={[wallAngleRad, 0, 0]}>
      <sphereGeometry args={[0.012, 6, 6]} />
      <meshBasicMaterial color={c} />
    </mesh>
  );
}

// Direction arrow: small triangle indicating which way the hold faces
function DirectionArrow({
  dir,
  wallAngleRad,
  offset,
}: {
  dir: HoldDirection;
  wallAngleRad: number;
  offset: V3;
}) {
  if (dir === "up") return null; // default, no arrow needed
  const dz = directionRotationZ(dir);
  return (
    <mesh position={offset} rotation={[wallAngleRad, 0, dz]}>
      <coneGeometry args={[0.012, 0.025, 3]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.6} />
    </mesh>
  );
}

function PlacedHold3D({
  hold,
  wallAngleRad,
  toWorld,
  onClick,
  eraserMode,
}: {
  hold: PlacedHold;
  wallAngleRad: number;
  toWorld: (x: number, h: number, d: number) => V3;
  onClick?: (id: string) => void;
  eraserMode?: boolean;
}) {
  const pos = toWorld(hold.x, hold.y, 0.02);
  const info = HOLD_INFO[hold.type];
  const color = info.color;
  const dz = directionRotationZ(hold.direction);
  // Indicator positions offset slightly above the hold
  const indicatorPos = toWorld(hold.x, hold.y + 0.06, 0.03);
  const arrowPos = toWorld(hold.x, hold.y - 0.06, 0.03);

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (!onClick || !eraserMode) return;
      e.stopPropagation();
      onClick(hold.id);
    },
    [onClick, eraserMode, hold.id],
  );

  const holdColor = eraserMode ? "#ff4444" : color;

  const indicators = (
    <>
      <UsageDot
        usage={hold.usage}
        wallAngleRad={wallAngleRad}
        offset={indicatorPos}
      />
      <DirectionArrow
        dir={hold.direction}
        wallAngleRad={wallAngleRad}
        offset={arrowPos}
      />
    </>
  );

  switch (hold.type) {
    case "jug":
      return (
        <group onClick={handleClick}>
          <mesh position={pos} rotation={[wallAngleRad, 0, dz]}>
            <boxGeometry args={[0.14, 0.05, 0.06]} />
            <meshStandardMaterial color={holdColor} roughness={0.75} />
          </mesh>
          {indicators}
        </group>
      );
    case "crimp":
      return (
        <group onClick={handleClick}>
          <mesh position={pos} rotation={[wallAngleRad, 0, dz]}>
            <boxGeometry args={[0.1, 0.02, 0.035]} />
            <meshStandardMaterial color={holdColor} roughness={0.7} />
          </mesh>
          {indicators}
        </group>
      );
    case "sloper":
      return (
        <group onClick={handleClick}>
          <mesh position={pos} rotation={[wallAngleRad, 0, dz]}>
            <sphereGeometry
              args={[0.06, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]}
            />
            <meshStandardMaterial color={holdColor} roughness={0.9} />
          </mesh>
          {indicators}
        </group>
      );
    case "pinch":
      return (
        <group onClick={handleClick}>
          <group position={pos} rotation={[wallAngleRad, 0, dz]}>
            <mesh position={[-0.035, 0, 0]}>
              <boxGeometry args={[0.02, 0.07, 0.04]} />
              <meshStandardMaterial color={holdColor} roughness={0.75} />
            </mesh>
            <mesh position={[0.035, 0, 0]}>
              <boxGeometry args={[0.02, 0.07, 0.04]} />
              <meshStandardMaterial color={holdColor} roughness={0.75} />
            </mesh>
            <mesh>
              <boxGeometry args={[0.09, 0.03, 0.04]} />
              <meshStandardMaterial color={holdColor} roughness={0.75} />
            </mesh>
          </group>
          {indicators}
        </group>
      );
    case "pocket":
      return (
        <group onClick={handleClick}>
          <group position={pos} rotation={[wallAngleRad, 0, dz]}>
            <mesh>
              <cylinderGeometry args={[0.035, 0.035, 0.04, 12]} />
              <meshStandardMaterial color={holdColor} roughness={0.6} />
            </mesh>
            <mesh position={[0, 0, 0.005]}>
              <cylinderGeometry args={[0.025, 0.025, 0.04, 12]} />
              <meshStandardMaterial color="#1a1a2e" roughness={1} />
            </mesh>
          </group>
          {indicators}
        </group>
      );
    case "volume":
      return (
        <group onClick={handleClick}>
          <mesh position={pos} rotation={[wallAngleRad, Math.PI / 6, dz]}>
            <coneGeometry args={[0.1, 0.12, 3]} />
            <meshStandardMaterial color={holdColor} roughness={0.85} />
          </mesh>
          {indicators}
        </group>
      );
    case "foot-chip":
      return (
        <group onClick={handleClick}>
          <mesh position={pos} rotation={[wallAngleRad, 0, dz]}>
            <boxGeometry args={[0.04, 0.015, 0.02]} />
            <meshStandardMaterial color={holdColor} roughness={0.8} />
          </mesh>
          {indicators}
        </group>
      );
    case "foot-edge":
      return (
        <group onClick={handleClick}>
          <mesh position={pos} rotation={[wallAngleRad, 0, dz]}>
            <boxGeometry args={[0.1, 0.012, 0.025]} />
            <meshStandardMaterial color={holdColor} roughness={0.75} />
          </mesh>
          {indicators}
        </group>
      );
    case "smear-pad": {
      // Smear pad sits flush on the wall — flat textured patch, no protrusion
      const smearPos = toWorld(hold.x, hold.y, 0.003);
      return (
        <group onClick={handleClick}>
          <mesh position={smearPos} rotation={[wallAngleRad, 0, 0]}>
            <planeGeometry args={[0.14, 0.14]} />
            <meshStandardMaterial
              color={holdColor}
              roughness={1.0}
              side={THREE.DoubleSide}
              transparent
              opacity={0.7}
            />
          </mesh>
          {indicators}
        </group>
      );
    }
  }
}

interface WallSegment {
  height: number;
  angleDeg: number;
}

function Wall({
  segments,
  onWallClick,
  placingMode,
}: {
  segments: WallSegment[];
  onWallClick?: (x: number, y: number) => void;
  placingMode?: boolean;
}) {
  const wallWidth = 3;

  // Compute each segment's base position in world space
  const segmentData = useMemo(() => {
    const data: {
      baseY: number;
      baseZ: number;
      angleRad: number;
      height: number;
      cumHeight: number;
    }[] = [];
    let curY = 0,
      curZ = 0,
      cumH = 0;
    for (const seg of segments) {
      const angleRad = (seg.angleDeg * Math.PI) / 180;
      data.push({
        baseY: curY,
        baseZ: curZ,
        angleRad,
        height: seg.height,
        cumHeight: cumH,
      });
      curY += seg.height * Math.cos(angleRad);
      curZ += seg.height * Math.sin(angleRad);
      cumH += seg.height;
    }
    return data;
  }, [segments]);

  const handleClick = useCallback(
    (segIdx: number, e: ThreeEvent<MouseEvent>) => {
      if (!onWallClick || !placingMode) return;
      e.stopPropagation();
      const pt = e.point;
      const seg = segmentData[segIdx];
      const wallUp: V3 = [0, Math.cos(seg.angleRad), Math.sin(seg.angleRad)];
      // Project world point onto this segment's plane to get local height
      const localH =
        (pt.y - seg.baseY) * wallUp[1] + (pt.z - seg.baseZ) * wallUp[2];
      const wallY = seg.cumHeight + localH;
      const cx = Math.max(
        -wallWidth / 2 + 0.1,
        Math.min(wallWidth / 2 - 0.1, pt.x),
      );
      const totalH = segments.reduce((s, seg2) => s + seg2.height, 0);
      const cy = Math.max(0.1, Math.min(totalH - 0.1, wallY));
      onWallClick(cx, cy);
    },
    [onWallClick, placingMode, segmentData, segments],
  );

  return (
    <group>
      {segmentData.map((seg, i) => {
        const centerY = seg.baseY + (seg.height / 2) * Math.cos(seg.angleRad);
        const centerZ = seg.baseZ + (seg.height / 2) * Math.sin(seg.angleRad);
        const gridSegsY = Math.max(1, Math.round(seg.height / 0.5));
        return (
          <group key={i}>
            <mesh
              rotation={[seg.angleRad, 0, 0]}
              position={[0, centerY, centerZ]}
              onClick={(e) => handleClick(i, e)}
            >
              <planeGeometry args={[wallWidth, seg.height]} />
              <meshStandardMaterial
                color={placingMode ? "#9B8365" : "#8B7355"}
                side={THREE.DoubleSide}
                transparent
                opacity={placingMode ? 0.55 : 0.45}
              />
            </mesh>
            <mesh
              rotation={[seg.angleRad, 0, 0]}
              position={[0, centerY, centerZ + 0.001]}
            >
              <planeGeometry args={[wallWidth, seg.height, 6, gridSegsY]} />
              <meshBasicMaterial
                color="#6B5335"
                wireframe
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// Hand component — fingers curl differently per grip type
function Hand({
  pos,
  wrist,
  pull,
  on,
  s,
  skinColor,
  side,
}: {
  pos: V3;
  wrist: V3;
  pull: PullDirection;
  on: boolean;
  s: number;
  skinColor: string;
  side: number;
}) {
  const handSize = 0.016 * s;
  if (!on) {
    // Dangling: relaxed open hand
    return <Joint position={pos} size={handSize} color={skinColor} />;
  }

  const toWrist = v3normalize(v3sub(wrist, pos));
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3(...toWrist);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);

  const fingerLen = 0.022 * s;
  const fingerW = 0.004 * s;

  // Finger curl angle based on grip type
  let curlAngle = 0.3; // default slight curl
  let spreadAngle = 0.08;
  let thumbOut = true;
  switch (pull) {
    case "down": // crimp/jug: fingers tightly curled, thumb locked over
      curlAngle = 1.2;
      spreadAngle = 0.02;
      break;
    case "sloper": // open hand draped over
      curlAngle = 0.4;
      spreadAngle = 0.15;
      break;
    case "side": // pinch/sidepull
    case "gaston":
      curlAngle = 0.8;
      spreadAngle = 0.05;
      thumbOut = true;
      break;
    case "undercling":
      curlAngle = 1.0;
      spreadAngle = 0.03;
      break;
    default:
      curlAngle = 0.6;
      spreadAngle = 0.08;
      break;
  }

  return (
    <group position={pos} quaternion={quat}>
      {/* Palm */}
      <mesh>
        <boxGeometry args={[handSize * 1.6, handSize * 0.5, handSize * 1.2]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Four fingers */}
      {[-1.5, -0.5, 0.5, 1.5].map((offset, i) => (
        <group
          key={i}
          position={[offset * fingerW, -handSize * 0.25, 0]}
          rotation={[0, 0, offset * spreadAngle * side]}
        >
          {/* Proximal */}
          <mesh
            position={[0, -fingerLen * 0.4, 0]}
            rotation={[curlAngle * 0.5, 0, 0]}
          >
            <boxGeometry args={[fingerW, fingerLen * 0.45, fingerW]} />
            <meshStandardMaterial color={skinColor} roughness={0.7} />
            {/* Distal — curls further */}
            <mesh
              position={[0, -fingerLen * 0.35, 0]}
              rotation={[curlAngle * 0.7, 0, 0]}
            >
              <boxGeometry
                args={[fingerW * 0.85, fingerLen * 0.35, fingerW * 0.85]}
              />
              <meshStandardMaterial color={skinColor} roughness={0.7} />
            </mesh>
          </mesh>
        </group>
      ))}
      {/* Thumb */}
      {thumbOut && (
        <mesh
          position={[side * handSize * 0.9, -handSize * 0.1, 0]}
          rotation={[curlAngle * 0.3, 0, side * -0.6]}
        >
          <boxGeometry args={[fingerW * 1.2, fingerLen * 0.5, fingerW * 1.2]} />
          <meshStandardMaterial color={skinColor} roughness={0.7} />
        </mesh>
      )}
    </group>
  );
}

// Climbing foot — rotates for heel hooks, toe hooks, smears, edging
function ClimbingFoot({
  pos,
  ankle,
  pull,
  on,
  s,
  footHeight: fh,
}: {
  pos: V3;
  ankle: V3;
  pull: PullDirection;
  on: boolean;
  s: number;
  footHeight: number;
}) {
  const shoeColor = "#334455";
  const rubberColor = "#1a1a1a";
  const shoeW = 0.035 * s;
  const shoeL = 0.07 * s;

  if (!on) {
    // Dangling: shoe pointing down
    return (
      <mesh position={pos}>
        <boxGeometry args={[shoeW, fh, shoeL]} />
        <meshStandardMaterial color={shoeColor} roughness={0.8} />
      </mesh>
    );
  }

  // Compute orientation from ankle to foot
  const toAnkle = v3normalize(v3sub(ankle, pos));
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3(...toAnkle);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);

  // Foot rotation adjustments based on technique
  const isHeel = pull === "heel-hook";
  const isToe = pull === "toe-hook" || pull === "toe-cam";

  return (
    <group position={pos} quaternion={quat}>
      {/* Rotate the shoe within the group for hooks */}
      <group
        rotation={[isHeel ? Math.PI * 0.6 : isToe ? -Math.PI * 0.35 : 0, 0, 0]}
      >
        {/* Main shoe body */}
        <mesh position={[0, fh * 0.3, isHeel ? -shoeL * 0.15 : shoeL * 0.1]}>
          <boxGeometry args={[shoeW, fh * 0.7, shoeL * 0.9]} />
          <meshStandardMaterial color={shoeColor} roughness={0.8} />
        </mesh>
        {/* Rubber toe rand — pronounced for toe hooks */}
        <mesh position={[0, fh * 0.05, shoeL * 0.45]}>
          <boxGeometry args={[shoeW * 1.05, fh * 0.35, shoeL * 0.2]} />
          <meshStandardMaterial color={rubberColor} roughness={0.95} />
        </mesh>
        {/* Heel rubber — pronounced for heel hooks */}
        <mesh position={[0, fh * 0.1, -shoeL * 0.35]}>
          <boxGeometry args={[shoeW * 0.95, fh * 0.5, shoeL * 0.2]} />
          <meshStandardMaterial
            color={isHeel ? "#cc3333" : rubberColor}
            roughness={0.95}
          />
        </mesh>
      </group>
    </group>
  );
}

function Climber({
  config,
  forces,
  segments,
}: {
  config: ClimberConfig;
  forces: ForceResult;
  segments?: WallSegment[];
}) {
  const angleRad = forces.wallAngleRad;
  const s = config.heightFt / 5.75;
  const heightM = config.heightFt * 0.3048;
  const apeRatio = config.apeIndexIn / (config.heightFt * 12);

  // Wall basis vectors (fallback for single-segment)
  const wallUp: V3 = [0, Math.cos(angleRad), Math.sin(angleRad)];
  const wallNorm: V3 = [0, -Math.sin(angleRad), Math.cos(angleRad)];

  // Place a point on the wall surface (x=lateral, h=height along wall, d=offset along normal)
  // Smooth transition radius: blend angles over this distance near segment joints
  const BLEND_R = 0.25;

  const toWorld = (x: number, h: number, d: number): V3 => {
    if (!segments || segments.length <= 1) {
      return [
        x,
        h * wallUp[1] + d * wallNorm[1],
        h * wallUp[2] + d * wallNorm[2],
      ];
    }

    // Build cumulative heights for segment boundaries
    const cumH: number[] = [0];
    for (const seg of segments) cumH.push(cumH[cumH.length - 1] + seg.height);
    const totalH = cumH[cumH.length - 1];
    const clampedH = Math.max(0, Math.min(totalH, h));

    // Find which segment this height falls in
    let segIdx = 0;
    for (let i = 0; i < segments.length; i++) {
      if (clampedH <= cumH[i + 1]) {
        segIdx = i;
        break;
      }
    }

    // Check if we're near a segment boundary and should blend
    const segStart = cumH[segIdx];
    const segEnd = cumH[segIdx + 1];
    const distFromStart = clampedH - segStart;
    const distFromEnd = segEnd - clampedH;

    // Compute blended angle at this height
    let blendedAngleRad: number;
    const thisAngle = (segments[segIdx].angleDeg * Math.PI) / 180;

    if (segIdx > 0 && distFromStart < BLEND_R) {
      // Near bottom boundary: blend with previous segment
      const prevAngle = (segments[segIdx - 1].angleDeg * Math.PI) / 180;
      const t = distFromStart / BLEND_R;
      const smooth = t * t * (3 - 2 * t); // smoothstep
      blendedAngleRad = prevAngle + (thisAngle - prevAngle) * smooth;
    } else if (segIdx < segments.length - 1 && distFromEnd < BLEND_R) {
      // Near top boundary: blend with next segment
      const nextAngle = (segments[segIdx + 1].angleDeg * Math.PI) / 180;
      const t = distFromEnd / BLEND_R;
      const smooth = t * t * (3 - 2 * t); // smoothstep
      blendedAngleRad = nextAngle + (thisAngle - nextAngle) * smooth;
    } else {
      blendedAngleRad = thisAngle;
    }

    // Integrate position by walking up the wall with blended angles.
    // For efficiency, use the sharp segments up to the blend zone,
    // then the blended angle for the final portion.
    let curY = 0,
      curZ = 0,
      walked = 0;

    // Walk full segments below this height
    for (let i = 0; i < segIdx; i++) {
      const ar = (segments[i].angleDeg * Math.PI) / 180;
      curY += segments[i].height * Math.cos(ar);
      curZ += segments[i].height * Math.sin(ar);
      walked += segments[i].height;
    }

    // Walk the remaining distance in this segment up to h using blended angle
    // For the non-blended portion, use the segment's angle
    const remaining = clampedH - walked;
    const nonBlend = Math.max(
      0,
      remaining -
        (distFromStart < BLEND_R
          ? remaining
          : distFromEnd < BLEND_R
            ? distFromEnd
            : 0),
    );

    if (distFromStart < BLEND_R && segIdx > 0) {
      // Entire remaining is in blend zone, integrate with blended angle
      // Use midpoint angle approximation for smooth curve
      const prevAngle = (segments[segIdx - 1].angleDeg * Math.PI) / 180;
      const steps = 8;
      const stepH = remaining / steps;
      for (let j = 0; j < steps; j++) {
        const frac = ((j + 0.5) * stepH) / BLEND_R;
        const sm = Math.min(1, frac * frac * (3 - 2 * frac));
        const a = prevAngle + (thisAngle - prevAngle) * sm;
        curY += stepH * Math.cos(a);
        curZ += stepH * Math.sin(a);
      }
    } else if (distFromEnd < BLEND_R && segIdx < segments.length - 1) {
      // Walk non-blend portion with segment angle, then blend
      const blendDist = remaining - nonBlend;
      curY += nonBlend * Math.cos(thisAngle);
      curZ += nonBlend * Math.sin(thisAngle);
      // Integrate blend zone
      const nextAngle = (segments[segIdx + 1].angleDeg * Math.PI) / 180;
      const steps = 8;
      const stepH = blendDist / steps;
      for (let j = 0; j < steps; j++) {
        const distToEnd = blendDist - (j + 0.5) * stepH;
        const frac = distToEnd / BLEND_R;
        const sm = Math.min(1, frac * frac * (3 - 2 * frac));
        const a = nextAngle + (thisAngle - nextAngle) * sm;
        curY += stepH * Math.cos(a);
        curZ += stepH * Math.sin(a);
      }
    } else {
      curY += remaining * Math.cos(thisAngle);
      curZ += remaining * Math.sin(thisAngle);
    }

    // Handle height beyond last segment
    if (h > totalH) {
      const lastAr = (segments[segments.length - 1].angleDeg * Math.PI) / 180;
      const extra = h - totalH;
      curY += extra * Math.cos(lastAr);
      curZ += extra * Math.sin(lastAr);
    }

    // Apply normal offset using blended angle
    const sn: V3 = [0, -Math.sin(blendedAngleRad), Math.cos(blendedAngleRad)];
    return [x, curY + d * sn[1], curZ + d * sn[2]];
  };

  // Holds ON the wall
  const lh = toWorld(config.leftHand.x, config.leftHand.y, HOLD_OFFSET);
  const rh = toWorld(config.rightHand.x, config.rightHand.y, HOLD_OFFSET);
  const lf = toWorld(config.leftFoot.x, config.leftFoot.y, HOLD_OFFSET);
  const rf = toWorld(config.rightFoot.x, config.rightFoot.y, HOLD_OFFSET);

  // Anatomically correct body proportions (as fractions of height)
  // Reference: NASA anthropometric data, average adult
  const bodyOffMax = 1.0 * s; // max distance hips can be from wall
  const bodyOff = 0.04 * s + config.hipOffset * (bodyOffMax - 0.04 * s); // 0=close, 1=far
  const torsoLen = 0.3 * s; // C7 vertebra to hip joint ~30% of height
  const shoulderW = 0.115 * s * apeRatio; // biacromial half-breadth ~23% of height
  const hipW = 0.085 * s; // bi-iliac half-breadth ~17% of height
  const headRadius = 0.065 * s; // head height ~13% of height (diameter ~0.13)
  const neckLen = 0.035 * s; // neck ~3.5% of height

  // Arm segments (shoulder to fingertip = armLen)
  // Upper arm (shoulder→elbow) 42%, forearm (elbow→wrist) 33%, hand (wrist→tip) 25%
  const armLen = ((config.apeIndexIn / 2) * 0.0254 * s) / heightM;
  const upperArm = armLen * 0.42;
  const forearm = armLen * 0.33;
  const handLen = armLen * 0.25; // wrist to fingertip

  // Leg segments (hip to sole = legLen)
  // Thigh (hip→knee) 52%, shin (knee→ankle) 40%, foot height 8%
  const legLen = 0.47 * s; // legs are ~47% of height
  const thigh = legLen * 0.52;
  const shin = legLen * 0.4;
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
  const rotateInWallPlane = (
    dx: number,
    dh: number,
    cos: number,
    sin: number,
  ): [number, number] => [dx * cos - dh * sin, dx * sin + dh * cos];

  // On overhangs, hips press tight to the wall to reduce moment arm.
  // Compute the wall angle at the CoG height to adapt automatically.
  const cogAngleDeg = (() => {
    if (!segments || segments.length <= 1) return config.wallAngleDeg;
    let remaining = config.centerOfGravity.y;
    for (const seg of segments) {
      if (remaining <= seg.height) return seg.angleDeg;
      remaining -= seg.height;
    }
    return segments[segments.length - 1].angleDeg;
  })();
  const steepnessFactor = Math.max(0, Math.sin((cogAngleDeg * Math.PI) / 180)); // 0=vert, 1=roof
  const hipPushIn = 1 - steepnessFactor * 0.85; // on roof, reduce hip offset to ~15%
  const hipNormalOff = bodyOff * Math.cos(absTwist) * hipPushIn;

  // Chest/shoulders stay mostly out — only follow ~20% of the hip twist
  const partialTwist = twistRad * 0.45;
  const cosPT = Math.cos(partialTwist);
  const sinPT = Math.sin(partialTwist);
  // Torso distance from wall, independent of hips. Limited by arm reach (hands stay on wall).
  const maxChestOff = (upperArm + forearm + handLen) * 0.85;
  const chestNormalOff =
    0.04 * s + config.torsoOffset * (maxChestOff - 0.04 * s);

  // CoG / pelvis — hips close to wall when twisted
  const cogX = config.centerOfGravity.x;
  const cogH = config.centerOfGravity.y;
  const pelvis = toWorld(cogX, cogH, hipNormalOff);

  // Chest: above pelvis, only slightly affected by twist
  const [chestDx, chestDh] = rotateInWallPlane(0, torsoLen, cosPT, sinPT);
  const chest = toWorld(cogX + chestDx, cogH + chestDh, chestNormalOff);

  // Head: follows chest, sits on neck above shoulders
  const [headDx, headDh] = rotateInWallPlane(
    0,
    torsoLen + neckLen + headRadius,
    cosPT,
    sinPT,
  );
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

  // Auto-detach hands that are too far to reach
  const leftHandOn =
    config.leftHandOn && v3len(v3sub(lh, shoulderL)) < armReach * 1.5;
  const rightHandOn =
    config.rightHandOn && v3len(v3sub(rh, shoulderR)) < armReach * 1.5;

  // Smear: when a foot can't reach its hold, find the nearest wall surface
  // point within leg reach. Climbers smear (press shoe flat on wall) rather
  // than letting a foot dangle.
  const findSmearPoint = (hip: V3, footTarget: V3): V3 => {
    const dist = v3len(v3sub(footTarget, hip));
    if (dist <= legReach) return footTarget; // can reach the hold, no smear needed

    // Search for the best wall point within leg reach.
    // Sample wall heights below the hip and find the closest reachable point.
    const totalH = segments
      ? segments.reduce((sum, seg) => sum + seg.height, 0)
      : 4;
    // Try wall heights from hip level downward to ground
    const hipWallH = config.centerOfGravity.y; // approximate hip height in wall coords
    let bestPoint: V3 | null = null;
    let bestDist = Infinity;
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const h = Math.max(
        0,
        hipWallH - (i / steps) * Math.min(hipWallH, legReach * 2),
      );
      if (h > totalH) continue;
      const wallPt = toWorld(footTarget[0], h, HOLD_OFFSET);
      const d = v3len(v3sub(wallPt, hip));
      if (d <= legReach && d < bestDist) {
        bestDist = d;
        bestPoint = wallPt;
      }
    }
    // Also try the original target direction clamped to reach
    if (!bestPoint) {
      bestPoint = clampToReach(hip, footTarget, legReach);
    }
    return bestPoint;
  };

  // Feet always stay on wall (smear if needed)
  const leftFootOn = config.leftFootOn;
  const rightFootOn = config.rightFootOn;
  const lfSmeared = config.leftFootOn ? findSmearPoint(hipL, lf) : lf;
  const rfSmeared = config.rightFootOn ? findSmearPoint(hipR, rf) : rf;

  // Clamp hold targets to max reach from their joint origins.
  const lhClamped = clampToReach(shoulderL, lh, armReach);
  const rhClamped = clampToReach(shoulderR, rh, armReach);
  const lfClamped = clampToReach(hipL, lfSmeared, legReach);
  const rfClamped = clampToReach(hipR, rfSmeared, legReach);

  // Compute elbow bend direction: anatomically, elbows are hinge joints
  // that primarily point DOWN and slightly OUT (away from body midline).
  // On steep terrain, elbows also push away from the wall.
  const computeElbowBend = (
    shoulder: V3,
    wrist: V3,
    lateralSign: number,
  ): V3 => {
    // Elbows bend: primarily downward (gravity), slightly outward (lateral),
    // and away from the wall (toward viewer). Use chest position as reference
    // for "away from wall" direction instead of wall angle.
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

    let desired: V3 = v3normalize(
      v3add(
        v3add(v3scale(down, 1.0), v3scale(lateral, 0.5)),
        v3scale(outward, 0.3),
      ),
    );

    const forward = v3normalize(v3sub(wrist, shoulder));
    const alongLimb = Math.abs(v3dot(desired, forward));
    if (alongLimb > 0.95) {
      desired = v3normalize(
        v3add(v3scale(outward, 0.7), v3scale(lateral, 0.3)),
      );
    }

    return desired;
  };

  // Derive wrist/ankle from clamped targets.
  // Wrist is handLen back along the direction from shoulder to clamped hand.
  // Ankle is footHeight back along the direction from hip to clamped foot.
  const wristFromClamped = (shoulder: V3, hand: V3): V3 => {
    const toHand = v3sub(hand, shoulder);
    const dist = v3len(toHand);
    if (dist < 0.001) return hand;
    const dir = v3normalize(toHand);
    // Wrist sits handLen back from the hand along the shoulder-to-hand line
    const wristDist = Math.max(0, dist - handLen);
    return v3add(shoulder, v3scale(dir, wristDist));
  };

  const ankleFromClamped = (hip: V3, foot: V3): V3 => {
    const toFoot = v3sub(foot, hip);
    const dist = v3len(toFoot);
    if (dist < 0.001) return foot;
    const dir = v3normalize(toFoot);
    // Ankle sits footHeight back from the foot along the hip-to-foot line
    const ankleDist = Math.max(0, dist - footHeight);
    return v3add(hip, v3scale(dir, ankleDist));
  };

  const wristL = wristFromClamped(shoulderL, lhClamped);
  const wristR = wristFromClamped(shoulderR, rhClamped);
  const ankleL = ankleFromClamped(hipL, lfClamped);
  const ankleR = ankleFromClamped(hipR, rfClamped);

  // Solve IK with anatomical elbow bend directions
  const elbowBendL = computeElbowBend(shoulderL, wristL, -1);
  const elbowBendR = computeElbowBend(shoulderR, wristR, 1);
  const elbowL = solveIK2Bone(shoulderL, wristL, upperArm, forearm, elbowBendL);
  const elbowR = solveIK2Bone(shoulderR, wristR, upperArm, forearm, elbowBendR);

  // Knee bend direction: knees must always bend AWAY from the wall and outward.
  // Use the chest-to-wall direction as a reliable "away from wall" reference,
  // since the chest is always offset from the wall surface.
  const computeKneeBend = (
    hip: V3,
    ankle: V3,
    turnDeg: number,
    lateralSign: number,
  ): V3 => {
    const hipToAnkle = v3sub(ankle, hip);
    const legDist = v3len(hipToAnkle);
    const maxLeg = thigh + shin;
    const bunchFactor = Math.max(0, 1 - legDist / (maxLeg * 0.95));

    // "Away from wall" direction: use the vector from the wall contact point
    // (foot) toward the chest. This reliably points away from the wall.
    const footToChest = v3sub(chest, ankle);
    const limbAxis =
      legDist > 0.001 ? v3normalize(hipToAnkle) : ([0, -1, 0] as V3);
    const alongLimb = v3dot(footToChest, limbAxis);
    let outward = v3sub(footToChest, v3scale(limbAxis, alongLimb));
    const outLen = v3len(outward);

    if (outLen < 0.01) {
      // Fallback: chest is directly along limb line. Use pelvis offset instead.
      const hipToChest = v3sub(chest, hip);
      outward = v3normalize(v3add(hipToChest, [0, 0, 0.1]));
    } else {
      outward = v3scale(outward, 1 / outLen);
    }

    // Foot below hip? Blend more upward (natural standing knee bend forward)
    const footBelow = Math.max(
      0,
      Math.min(1, (hip[1] - ankle[1]) / (maxLeg * 0.5)),
    );

    // Blend: outward (away from wall) + lateral splay (knees apart)
    // More lateral when bunched (feet near hips), more outward always
    const outWeight = 0.7;
    const upWeight = footBelow * 0.3;
    const lateralWeight = 0.2 + bunchFactor * 0.5;

    let baseBend: V3 = v3normalize(
      v3add(v3add(v3scale(outward, outWeight), v3scale([0, 1, 0], upWeight)), [
        lateralSign * lateralWeight,
        0,
        0,
      ]),
    );

    // Apply knee turn rotation (drop knee / frog)
    if (Math.abs(turnDeg) >= 1) {
      const axis = legDist > 0.001 ? limbAxis : ([0, -1, 0] as V3);
      const turnRad = (turnDeg * Math.PI) / 180;
      const cos = Math.cos(turnRad);
      const sin = Math.sin(turnRad);
      const dot = v3dot(baseBend, axis);
      const cross = v3cross(axis, baseBend);
      baseBend = v3normalize(
        v3add(
          v3add(v3scale(baseBend, cos), v3scale(cross, sin)),
          v3scale(axis, dot * (1 - cos)),
        ),
      );
    }

    return baseBend;
  };

  const kneeBendL = computeKneeBend(hipL, ankleL, config.leftKneeTurnDeg, -1);
  const kneeBendR = computeKneeBend(hipR, ankleR, config.rightKneeTurnDeg, 1);
  let kneeL = solveIK2Bone(hipL, ankleL, thigh, shin, kneeBendL);
  let kneeR = solveIK2Bone(hipR, ankleR, thigh, shin, kneeBendR);

  // Clamp knees: ensure they stay on the climber's side of the wall
  // and never drop below the foot or ground level.
  const clampKnee = (knee: V3, hip: V3, ankle: V3): V3 => {
    let k: V3 = [...knee];

    // Never below the lower of hip/ankle minus a small margin
    const minY = Math.min(hip[1], ankle[1]) - 0.05;
    if (k[1] < minY) k[1] = minY;

    // Never below ground
    if (k[1] < 0) k[1] = 0;

    // Keep knee on the body side of the wall: knee must be at least as far
    // from the wall as the hip (Z >= hip Z). The chest is always further
    // from the wall, so use a blend of hip and chest Z as minimum.
    const bodyZ = Math.max(hip[2], ankle[2], pelvis[2]);
    if (k[2] < bodyZ) k[2] = bodyZ;

    return k;
  };
  kneeL = clampKnee(kneeL, hipL, ankleL);
  kneeR = clampKnee(kneeR, hipR, ankleR);

  // Dangling limbs: when a limb is off the wall, it hangs straight down
  // from its joint origin under gravity. Elbow/knee at upper bone length down,
  // wrist/ankle at upper+lower down, hand/foot at full length down.
  let finalElbowL = elbowL,
    finalWristL = wristL,
    finalLh = lhClamped;
  let finalElbowR = elbowR,
    finalWristR = wristR,
    finalRh = rhClamped;
  let finalKneeL = kneeL,
    finalAnkleL = ankleL,
    finalLf = lfClamped;
  let finalKneeR = kneeR,
    finalAnkleR = ankleR,
    finalRf = rfClamped;

  if (!leftHandOn) {
    finalElbowL = v3add(shoulderL, [0, -upperArm, 0]);
    finalWristL = v3add(shoulderL, [0, -(upperArm + forearm), 0]);
    finalLh = v3add(shoulderL, [0, -(upperArm + forearm + handLen), 0]);
  }
  if (!rightHandOn) {
    finalElbowR = v3add(shoulderR, [0, -upperArm, 0]);
    finalWristR = v3add(shoulderR, [0, -(upperArm + forearm), 0]);
    finalRh = v3add(shoulderR, [0, -(upperArm + forearm + handLen), 0]);
  }
  if (!leftFootOn) {
    finalKneeL = v3add(hipL, [0, -thigh, 0]);
    finalAnkleL = v3add(hipL, [0, -(thigh + shin), 0]);
    finalLf = v3add(hipL, [0, -(thigh + shin + footHeight), 0]);
  }
  if (!rightFootOn) {
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
      {/* Head */}
      <mesh position={head}>
        <sphereGeometry args={[headRadius, 16, 16]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Beanie */}
      {(() => {
        const beanieR = headRadius * 1.05;
        const beanieH = headRadius * 0.7;
        const headDir = v3normalize(v3sub(head, chest));
        const beaniePos = v3add(head, v3scale(headDir, headRadius * 0.35));
        const up = new THREE.Vector3(0, 1, 0);
        const dir = new THREE.Vector3(...headDir);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
        return (
          <group position={beaniePos} quaternion={quat}>
            {/* Main beanie dome */}
            <mesh position={[0, 0, 0]}>
              <sphereGeometry
                args={[beanieR, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]}
              />
              <meshStandardMaterial color="#1a1a1a" roughness={0.95} />
            </mesh>
            {/* Folded brim */}
            <mesh position={[0, -beanieH * 0.15, 0]}>
              <cylinderGeometry
                args={[beanieR * 1.02, beanieR * 1.04, beanieH * 0.25, 14]}
              />
              <meshStandardMaterial color="#222222" roughness={0.9} />
            </mesh>
          </group>
        );
      })()}

      {/* Neck & Torso — width scales with body weight */}
      <Limb from={head} to={chest} color={skinColor} width={3} />
      {(() => {
        // Subtle body girth scaling with weight
        const weightFactor = Math.max(
          0.85,
          Math.min(1.25, config.bodyWeightKg / 70),
        ); // 1.0 at 70kg
        const torsoMid: V3 = [
          (chest[0] + pelvis[0]) / 2,
          (chest[1] + pelvis[1]) / 2,
          (chest[2] + pelvis[2]) / 2,
        ];
        const torsoHeight = torsoLen;
        const torsoDir = v3normalize(v3sub(chest, pelvis));
        const chestWidth = shoulderW * 0.8 * weightFactor;
        const waistWidth = hipW * 1.0 * weightFactor;
        const up = new THREE.Vector3(0, 1, 0);
        const dir = new THREE.Vector3(...torsoDir);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);

        return (
          <mesh position={torsoMid} quaternion={quat}>
            <cylinderGeometry
              args={[chestWidth, waistWidth, torsoHeight * 0.95, 12]}
            />
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

      {/* Hands — grip varies by hold type */}
      <Hand
        pos={finalLh}
        wrist={finalWristL}
        pull={config.leftHandPull}
        on={leftHandOn}
        s={s}
        skinColor={skinColor}
        side={-1}
      />
      <Hand
        pos={finalRh}
        wrist={finalWristR}
        pull={config.rightHandPull}
        on={rightHandOn}
        s={s}
        skinColor={skinColor}
        side={1}
      />

      {/* Feet — climbing shoe with heel/toe hooks */}
      <ClimbingFoot
        pos={finalLf}
        ankle={finalAnkleL}
        pull={config.leftFootPull}
        on={leftFootOn}
        s={s}
        footHeight={footHeight}
      />
      <ClimbingFoot
        pos={finalRf}
        ankle={finalAnkleR}
        pull={config.rightFootPull}
        on={rightFootOn}
        s={s}
        footHeight={footHeight}
      />

      {/* Chalk bag — Organic style: sage green + orange stripe, black fleece rim */}
      {(() => {
        const bagSize = 0.038 * s;
        // Lower back: ~15% up torso, behind the climber — sits at harness level
        const lowerBack: V3 = v3add(
          v3add(pelvis, v3scale(v3sub(chest, pelvis), 0.15)),
          v3scale(wallNorm, 0.12 * s), // behind the climber (away from wall)
        );
        // Bag hangs below the belt loop attachment
        const bagPos: V3 = v3add(lowerBack, [0, -0.03 * s, 0]);
        // Drawstring end dangles below bag
        const cordEnd: V3 = v3add(bagPos, [-bagSize * 0.3, -bagSize * 1.2, 0]);
        const cordMid: V3 = v3add(bagPos, [-bagSize * 0.5, -bagSize * 0.6, 0]);
        return (
          <group>
            {/* Belt loop / strap across lower back */}
            <Limb
              from={v3add(lowerBack, [hipW * 0.7, 0.01 * s, 0])}
              to={v3add(lowerBack, [-hipW * 0.7, 0.01 * s, 0])}
              color="#555544"
              width={1.5}
            />
            {/* Short loop to bag */}
            <Limb from={lowerBack} to={bagPos} color="#555544" width={1} />

            {/* Main bag body — sage green */}
            <mesh position={bagPos}>
              <cylinderGeometry
                args={[bagSize * 0.75, bagSize * 0.9, bagSize * 1.6, 10]}
              />
              <meshStandardMaterial color="#8faa7a" roughness={0.85} />
            </mesh>
            {/* Orange racing stripe — front panel */}
            <mesh position={v3add(bagPos, v3scale(wallNorm, -bagSize * 0.01))}>
              <cylinderGeometry
                args={[
                  bagSize * 0.76,
                  bagSize * 0.91,
                  bagSize * 1.4,
                  10,
                  1,
                  false,
                  -0.4,
                  0.8,
                ]}
              />
              <meshStandardMaterial color="#e8622a" roughness={0.8} />
            </mesh>
            {/* Dark green side stripe */}
            <mesh position={v3add(bagPos, v3scale(wallNorm, -bagSize * 0.005))}>
              <cylinderGeometry
                args={[
                  bagSize * 0.77,
                  bagSize * 0.92,
                  bagSize * 1.3,
                  10,
                  1,
                  false,
                  0.6,
                  0.5,
                ]}
              />
              <meshStandardMaterial color="#2d5a2d" roughness={0.8} />
            </mesh>

            {/* Black fleece rim at top */}
            <mesh position={v3add(bagPos, [0, bagSize * 0.8, 0])}>
              <cylinderGeometry
                args={[bagSize * 0.7, bagSize * 0.78, bagSize * 0.35, 10]}
              />
              <meshStandardMaterial color="#222222" roughness={1.0} />
            </mesh>

            {/* Orange drawstring cord */}
            <Limb
              from={v3add(bagPos, [-bagSize * 0.6, bagSize * 0.6, 0])}
              to={cordMid}
              color="#e8622a"
              width={1}
            />
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
            <Limb
              key={`gl${i}`}
              from={gearPts[i]}
              to={gearPts[(i + 1) % nPts]}
              color="#555"
              width={1.5}
            />,
          );
        }

        // Quickdraw: top biner → dogbone (sling) → bottom biner
        // Place 3 on each side of harness
        const qdColors = [
          "#3388dd",
          "#dd4433",
          "#44bb44",
          "#ddaa22",
          "#aa44cc",
          "#dd7733",
        ];
        const qdPositions = [
          { idx: 2, side: 1 }, // front-left
          { idx: 3, side: 1 }, // left
          { idx: 4, side: 1 }, // back-left
          { idx: 8, side: -1 }, // front-right
          { idx: 9, side: -1 }, // right
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
                <meshStandardMaterial
                  color="#c0c0c0"
                  metalness={0.8}
                  roughness={0.2}
                />
              </mesh>
              {/* Dogbone sling */}
              <Limb from={dogTop} to={dogBot} color={slingColor} width={2.5} />
              {/* Sling ends (wider nylon) */}
              <mesh position={dogTop}>
                <boxGeometry
                  args={[binerSize * 1.8, binerSize * 0.6, binerSize * 0.3]}
                />
                <meshStandardMaterial color={slingColor} roughness={0.9} />
              </mesh>
              <mesh position={dogBot}>
                <boxGeometry
                  args={[binerSize * 1.8, binerSize * 0.6, binerSize * 0.3]}
                />
                <meshStandardMaterial color={slingColor} roughness={0.9} />
              </mesh>
              {/* Bottom carabiner */}
              <mesh position={botBiner}>
                <torusGeometry
                  args={[binerSize * 0.9, binerSize * 0.22, 5, 10]}
                />
                <meshStandardMaterial
                  color="#b0b0b0"
                  metalness={0.8}
                  roughness={0.2}
                />
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
      <ArrowLine
        start={pelvis}
        direction={forces.gravity.clone().multiplyScalar(0.1)}
        color="#ff0000"
      />
      {config.leftHandOn && (
        <ArrowLine
          start={finalLh}
          direction={forces.leftHandPull}
          color="#ffaa00"
        />
      )}
      {config.rightHandOn && (
        <ArrowLine
          start={finalRh}
          direction={forces.rightHandPull}
          color="#ffcc00"
        />
      )}
      {config.leftFootOn && (
        <ArrowLine
          start={finalLf}
          direction={forces.leftFootPush}
          color="#44cc44"
        />
      )}
      {config.rightFootOn && (
        <ArrowLine
          start={finalRf}
          direction={forces.rightFootPush}
          color="#33aa33"
        />
      )}
      {forces.normal.length() > 0.1 && (
        <ArrowLine
          start={pelvis}
          direction={forces.normal.clone().multiplyScalar(0.1)}
          color="#aa44ff"
        />
      )}
    </group>
  );
}

// === RAGDOLL ===
export interface RagdollPart {
  shape: "sphere" | "cylinder" | "box";
  color: string;
  size: [number, number, number]; // radius/width, height, depth
  position: [number, number, number];
  velocity: [number, number, number];
  rotation: [number, number, number];
  angularVel: [number, number, number];
}

function RagdollClimber({ parts: initialParts }: { parts: RagdollPart[] }) {
  const partsRef = useRef<RagdollPart[]>(initialParts.map((p) => ({ ...p })));
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const initialized = useRef(false);

  if (!initialized.current) {
    partsRef.current = initialParts.map((p) => ({
      ...p,
      position: [...p.position] as [number, number, number],
      velocity: [...p.velocity] as [number, number, number],
      rotation: [...p.rotation] as [number, number, number],
      angularVel: [...p.angularVel] as [number, number, number],
    }));
    initialized.current = true;
  }

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const GRAVITY = -9.8;
    const BOUNCE = 0.3;
    const FRICTION = 0.92;
    const FLOOR_Y = 0.02;

    partsRef.current.forEach((part, i) => {
      // Gravity
      part.velocity[1] += GRAVITY * dt;

      // Update position
      part.position[0] += part.velocity[0] * dt;
      part.position[1] += part.velocity[1] * dt;
      part.position[2] += part.velocity[2] * dt;

      // Update rotation
      part.rotation[0] += part.angularVel[0] * dt;
      part.rotation[1] += part.angularVel[1] * dt;
      part.rotation[2] += part.angularVel[2] * dt;

      // Floor collision
      const halfH = part.shape === "sphere" ? part.size[0] : part.size[1] * 0.5;
      if (part.position[1] < FLOOR_Y + halfH) {
        part.position[1] = FLOOR_Y + halfH;
        part.velocity[1] = Math.abs(part.velocity[1]) * BOUNCE;
        // Friction on ground
        part.velocity[0] *= FRICTION;
        part.velocity[2] *= FRICTION;
        // Angular damping on ground
        part.angularVel[0] *= 0.95;
        part.angularVel[1] *= 0.95;
        part.angularVel[2] *= 0.95;

        // Extra damping when nearly stopped
        if (Math.abs(part.velocity[1]) < 0.3) {
          part.velocity[1] = 0;
          part.velocity[0] *= 0.9;
          part.velocity[2] *= 0.9;
          part.angularVel[0] *= 0.9;
          part.angularVel[1] *= 0.9;
          part.angularVel[2] *= 0.9;
        }
      }

      // Update mesh
      const mesh = meshRefs.current[i];
      if (mesh) {
        mesh.position.set(part.position[0], part.position[1], part.position[2]);
        mesh.rotation.set(part.rotation[0], part.rotation[1], part.rotation[2]);
      }
    });
  });

  return (
    <group>
      {initialParts.map((part, i) => (
        <mesh
          key={i}
          ref={(el) => {
            meshRefs.current[i] = el;
          }}
          position={part.position}
          rotation={part.rotation}
        >
          {part.shape === "sphere" && (
            <sphereGeometry args={[part.size[0], 10, 10]} />
          )}
          {part.shape === "cylinder" && (
            <cylinderGeometry
              args={[part.size[0], part.size[0], part.size[1], 8]}
            />
          )}
          {part.shape === "box" && <boxGeometry args={part.size} />}
          <meshStandardMaterial color={part.color} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function SmokePuffs({ origin, scale: s }: { origin: V3; scale: number }) {
  const NUM_PUFFS = 8;
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const puffsRef = useRef(
    Array.from({ length: NUM_PUFFS }, (_, i) => ({
      age: (i / NUM_PUFFS) * 3, // stagger start times
      x: 0,
      y: 0,
      z: 0,
      vx: (Math.random() - 0.5) * 0.02,
      vz: (Math.random() - 0.5) * 0.02,
      size: 0,
    })),
  );

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    puffsRef.current.forEach((p, i) => {
      p.age += dt;
      if (p.age > 3) {
        // Reset puff
        p.age = 0;
        p.x = 0;
        p.y = 0;
        p.z = 0;
        p.vx = (Math.random() - 0.5) * 0.03;
        p.vz = (Math.random() - 0.5) * 0.03;
      }
      const t = p.age / 3; // 0..1 lifetime
      p.x += p.vx * dt;
      p.y += (0.08 + t * 0.04) * dt * s; // rise and slow
      p.z += p.vz * dt;
      p.vx += (Math.random() - 0.5) * 0.01 * dt; // drift
      p.vz += (Math.random() - 0.5) * 0.01 * dt;
      p.size = (0.008 + t * 0.025) * s; // grow
      const opacity = t < 0.1 ? t / 0.1 : Math.max(0, 1 - (t - 0.1) / 0.9); // fade in/out

      const mesh = meshRefs.current[i];
      if (mesh) {
        mesh.position.set(origin[0] + p.x, origin[1] + p.y, origin[2] + p.z);
        mesh.scale.setScalar(p.size);
        (mesh.material as THREE.MeshStandardMaterial).opacity = opacity * 0.5;
      }
    });
  });

  return (
    <group>
      {puffsRef.current.map((_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            meshRefs.current[i] = el;
          }}
        >
          <sphereGeometry args={[1, 6, 6]} />
          <meshStandardMaterial
            color="#cccccc"
            transparent
            opacity={0}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function SittingClimber({ scale }: { scale: number }) {
  const s = scale;
  const skinColor = "#ddbbaa";
  const torsoColor = "#5588aa";
  const legColor = "#445566";
  const shoeColor = "#334455";
  const headR = 0.065 * s;
  const torsoH = 0.26 * s;
  const torsoW = 0.09 * s;
  const thighL = 0.22 * s;
  const shinL = 0.18 * s;

  // Sitting on ground: butt at y ~ 0.05, legs out front
  const pelvisY = 0.08 * s;
  const chestY = pelvisY + torsoH;
  const headY = chestY + 0.08 * s + headR;

  // Arm raise animation
  const armRef = useRef<THREE.Group>(null);
  const timeRef = useRef(0);
  useFrame((_, delta) => {
    timeRef.current += delta;
    if (armRef.current) {
      // Slow breathing/puffing motion
      const t = Math.sin(timeRef.current * 0.8) * 0.5 + 0.5; // 0..1
      armRef.current.rotation.x = -0.5 - t * 0.15; // raise toward mouth
      armRef.current.rotation.z = -0.2 + t * 0.05;
    }
  });

  return (
    <group position={[0.8, 0, 1.5]}>
      {/* Head */}
      <mesh position={[0, headY, 0.02]}>
        <sphereGeometry args={[headR, 12, 12]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Beanie */}
      <mesh position={[0, headY + headR * 0.35, 0.02]}>
        <sphereGeometry
          args={[headR * 1.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]}
        />
        <meshStandardMaterial color="#1a1a1a" roughness={0.95} />
      </mesh>
      <mesh position={[0, headY + headR * 0.2, 0.02]}>
        <cylinderGeometry
          args={[headR * 1.07, headR * 1.09, headR * 0.18, 14]}
        />
        <meshStandardMaterial color="#222222" roughness={0.9} />
      </mesh>
      {/* Torso */}
      <mesh position={[0, pelvisY + torsoH * 0.5, 0.02]} rotation={[0.2, 0, 0]}>
        <cylinderGeometry args={[torsoW * 0.85, torsoW, torsoH, 10]} />
        <meshStandardMaterial color={torsoColor} roughness={0.7} />
      </mesh>
      {/* Left thigh */}
      <mesh
        position={[-0.05 * s, pelvisY, thighL * 0.4]}
        rotation={[Math.PI / 2.3, 0, 0.1]}
      >
        <cylinderGeometry args={[0.025 * s, 0.022 * s, thighL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      {/* Right thigh */}
      <mesh
        position={[0.05 * s, pelvisY, thighL * 0.4]}
        rotation={[Math.PI / 2.3, 0, -0.1]}
      >
        <cylinderGeometry args={[0.025 * s, 0.022 * s, thighL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      {/* Left shin */}
      <mesh
        position={[-0.06 * s, 0.04 * s, thighL * 0.75]}
        rotation={[0.3, 0, 0]}
      >
        <cylinderGeometry args={[0.02 * s, 0.018 * s, shinL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      {/* Right shin */}
      <mesh
        position={[0.06 * s, 0.04 * s, thighL * 0.75]}
        rotation={[0.3, 0, 0]}
      >
        <cylinderGeometry args={[0.02 * s, 0.018 * s, shinL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      {/* Left foot */}
      <mesh position={[-0.06 * s, 0.02 * s, thighL * 0.75 + shinL * 0.4]}>
        <boxGeometry args={[0.035 * s, 0.02 * s, 0.07 * s]} />
        <meshStandardMaterial color={shoeColor} roughness={0.8} />
      </mesh>
      {/* Right foot */}
      <mesh position={[0.06 * s, 0.02 * s, thighL * 0.75 + shinL * 0.4]}>
        <boxGeometry args={[0.035 * s, 0.02 * s, 0.07 * s]} />
        <meshStandardMaterial color={shoeColor} roughness={0.8} />
      </mesh>
      {/* Left arm - resting on knee */}
      <mesh
        position={[-0.1 * s, chestY * 0.6, thighL * 0.3]}
        rotation={[0.8, 0, 0.3]}
      >
        <cylinderGeometry args={[0.018 * s, 0.015 * s, 0.3 * s, 8]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Left hand on knee */}
      <mesh position={[-0.08 * s, pelvisY + 0.02, thighL * 0.55]}>
        <sphereGeometry args={[0.016 * s, 8, 8]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>

      {/* Right arm - raised, holding joint */}
      <group ref={armRef} position={[0.1 * s, chestY, 0.02]}>
        {/* Upper + forearm */}
        <mesh position={[0, -0.1 * s, 0.08 * s]} rotation={[0, 0, 0]}>
          <cylinderGeometry args={[0.018 * s, 0.015 * s, 0.28 * s, 8]} />
          <meshStandardMaterial color={skinColor} roughness={0.7} />
        </mesh>
        {/* Hand */}
        <mesh position={[0, -0.22 * s, 0.12 * s]}>
          <sphereGeometry args={[0.018 * s, 8, 8]} />
          <meshStandardMaterial color={skinColor} roughness={0.7} />
        </mesh>
        {/* Joint - white paper */}
        <mesh
          position={[0.01 * s, -0.24 * s, 0.13 * s]}
          rotation={[0.3, 0, 0.8]}
        >
          <cylinderGeometry args={[0.003 * s, 0.004 * s, 0.05 * s, 6]} />
          <meshStandardMaterial color="#f5f0e0" roughness={0.9} />
        </mesh>
        {/* Cherry / lit end */}
        <mesh position={[0.025 * s, -0.25 * s, 0.14 * s]}>
          <sphereGeometry args={[0.005 * s, 6, 6]} />
          <meshStandardMaterial
            color="#ff4400"
            emissive="#ff2200"
            emissiveIntensity={1.5}
          />
        </mesh>
        {/* Smoke */}
        <SmokePuffs origin={[0.025 * s, -0.24 * s, 0.14 * s]} scale={s} />
      </group>
    </group>
  );
}

function ToppingOutClimber({
  scale,
  wallAngleDeg,
  segments,
}: {
  scale: number;
  wallAngleDeg: number;
  segments?: WallSegment[];
}) {
  const s = scale;
  const skinColor = "#ddbbaa";
  const torsoColor = "#5588aa";
  const legColor = "#445566";
  const shoeColor = "#334455";
  const headR = 0.065 * s;
  const torsoH = 0.26 * s;
  const torsoW = 0.09 * s;
  const thighL = 0.22 * s;
  const shinL = 0.18 * s;

  // Compute top of wall from segments
  const { topY, topZ } = useMemo(() => {
    if (!segments || segments.length === 0) {
      const angleRad = (wallAngleDeg * Math.PI) / 180;
      return { topY: 4 * Math.cos(angleRad), topZ: 4 * Math.sin(angleRad) };
    }
    let curY = 0,
      curZ = 0;
    for (const seg of segments) {
      const ar = (seg.angleDeg * Math.PI) / 180;
      curY += seg.height * Math.cos(ar);
      curZ += seg.height * Math.sin(ar);
    }
    return { topY: curY, topZ: curZ };
  }, [segments, wallAngleDeg]);

  const pelvisY = topY + 0.08 * s;
  const chestY = pelvisY + torsoH;
  const headY = chestY + 0.08 * s + headR;

  // Drinking arm animation
  const armRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (armRef.current) {
      const t = Date.now() * 0.001;
      // Periodic sipping: raise to mouth, pause, lower
      const cycle = t % 4; // 4 second cycle
      let tilt: number;
      if (cycle < 1)
        tilt = cycle; // raise
      else if (cycle < 2.5)
        tilt = 1; // sip
      else if (cycle < 3.5)
        tilt = 1 - (cycle - 2.5); // lower
      else tilt = 0; // rest
      armRef.current.rotation.x = -0.3 - tilt * 0.6;
      armRef.current.rotation.z = -0.15 + tilt * 0.05;
    }
  });

  return (
    <group position={[0, 0, topZ - 0.1]}>
      {/* Head */}
      <mesh position={[0, headY, 0]}>
        <sphereGeometry args={[headR, 12, 12]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Beanie */}
      <mesh position={[0, headY + headR * 0.35, 0]}>
        <sphereGeometry
          args={[headR * 1.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]}
        />
        <meshStandardMaterial color="#1a1a1a" roughness={0.95} />
      </mesh>
      <mesh position={[0, headY + headR * 0.2, 0]}>
        <cylinderGeometry
          args={[headR * 1.07, headR * 1.09, headR * 0.18, 14]}
        />
        <meshStandardMaterial color="#222222" roughness={0.9} />
      </mesh>
      {/* Torso - leaning back slightly */}
      <mesh
        position={[0, pelvisY + torsoH * 0.5, -0.02]}
        rotation={[-0.15, 0, 0]}
      >
        <cylinderGeometry args={[torsoW * 0.85, torsoW, torsoH, 10]} />
        <meshStandardMaterial color={torsoColor} roughness={0.7} />
      </mesh>
      {/* Thighs - going forward horizontally from pelvis, slight splay */}
      <mesh
        position={[-0.05 * s, pelvisY - 0.02 * s, thighL * 0.45]}
        rotation={[Math.PI / 2 - 0.15, 0, 0.06]}
      >
        <cylinderGeometry args={[0.025 * s, 0.022 * s, thighL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      <mesh
        position={[0.05 * s, pelvisY - 0.02 * s, thighL * 0.45]}
        rotation={[Math.PI / 2 - 0.15, 0, -0.06]}
      >
        <cylinderGeometry args={[0.025 * s, 0.022 * s, thighL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      {/* Shins - hanging straight down from knees */}
      <mesh
        position={[-0.06 * s, pelvisY - 0.02 * s - shinL * 0.5, thighL * 0.85]}
        rotation={[0.1, 0, 0.03]}
      >
        <cylinderGeometry args={[0.02 * s, 0.018 * s, shinL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      <mesh
        position={[0.06 * s, pelvisY - 0.02 * s - shinL * 0.5, thighL * 0.85]}
        rotation={[0.1, 0, -0.03]}
      >
        <cylinderGeometry args={[0.02 * s, 0.018 * s, shinL, 8]} />
        <meshStandardMaterial color={legColor} roughness={0.7} />
      </mesh>
      {/* Feet - pointing forward */}
      <mesh
        position={[-0.06 * s, pelvisY - 0.02 * s - shinL * 0.95, thighL * 0.88]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <boxGeometry args={[0.035 * s, 0.07 * s, 0.02 * s]} />
        <meshStandardMaterial color={shoeColor} roughness={0.8} />
      </mesh>
      <mesh
        position={[0.06 * s, pelvisY - 0.02 * s - shinL * 0.95, thighL * 0.88]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <boxGeometry args={[0.035 * s, 0.07 * s, 0.02 * s]} />
        <meshStandardMaterial color={shoeColor} roughness={0.8} />
      </mesh>
      {/* Left arm resting on lap */}
      <mesh
        position={[-0.1 * s, (pelvisY + chestY) * 0.5, 0.04]}
        rotation={[0.5, 0, 0.3]}
      >
        <cylinderGeometry args={[0.018 * s, 0.015 * s, 0.28 * s, 8]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      <mesh position={[-0.08 * s, pelvisY + 0.03, 0.08]}>
        <sphereGeometry args={[0.016 * s, 8, 8]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>

      {/* Right arm - holding beer, animated */}
      <group
        ref={armRef}
        position={[0.1 * s, chestY, 0]}
        rotation={[-0.3, 0, -0.15]}
      >
        <mesh position={[0, -0.12 * s, 0.06 * s]}>
          <cylinderGeometry args={[0.018 * s, 0.015 * s, 0.26 * s, 8]} />
          <meshStandardMaterial color={skinColor} roughness={0.7} />
        </mesh>
        {/* Hand */}
        <mesh position={[0, -0.23 * s, 0.09 * s]}>
          <sphereGeometry args={[0.018 * s, 8, 8]} />
          <meshStandardMaterial color={skinColor} roughness={0.7} />
        </mesh>
        {/* Beer can */}
        <group position={[0, -0.26 * s, 0.1 * s]}>
          {/* Can body */}
          <mesh>
            <cylinderGeometry args={[0.018 * s, 0.018 * s, 0.06 * s, 10]} />
            <meshStandardMaterial
              color="#cc8800"
              metalness={0.6}
              roughness={0.3}
            />
          </mesh>
          {/* Label stripe */}
          <mesh position={[0, -0.005 * s, 0]}>
            <cylinderGeometry args={[0.019 * s, 0.019 * s, 0.025 * s, 10]} />
            <meshStandardMaterial
              color="#ffffff"
              metalness={0.3}
              roughness={0.4}
            />
          </mesh>
          {/* Top rim */}
          <mesh position={[0, 0.03 * s, 0]}>
            <cylinderGeometry args={[0.015 * s, 0.018 * s, 0.005 * s, 10]} />
            <meshStandardMaterial
              color="#c0c0c0"
              metalness={0.8}
              roughness={0.2}
            />
          </mesh>
        </group>
      </group>
    </group>
  );
}

function SleepingZs({ origin }: { origin: V3 }) {
  const NUM_ZS = 3;
  const meshRefs = useRef<(THREE.Group | null)[]>([]);
  const ages = useRef(Array.from({ length: NUM_ZS }, (_, i) => i * 1.2)); // stagger

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const CYCLE = 3.6; // seconds per Z lifecycle
    ages.current.forEach((_, i) => {
      ages.current[i] += dt;
      if (ages.current[i] > CYCLE) ages.current[i] -= CYCLE;
      const t = ages.current[i] / CYCLE; // 0..1
      const group = meshRefs.current[i];
      if (group) {
        // Rise up and drift right, wobble
        group.position.set(
          origin[0] + t * 0.15 + Math.sin(t * 4) * 0.02,
          origin[1] + t * 0.4,
          origin[2] + Math.cos(t * 3) * 0.02,
        );
        // Scale: small → big → fade. Size grows with each Z
        const sizeMult = 0.03 + i * 0.015;
        const scale = sizeMult * (t < 0.1 ? t / 0.1 : 1);
        group.scale.setScalar(scale);
        // Opacity: fade in then fade out
        const opacity =
          t < 0.1 ? t / 0.1 : t > 0.7 ? Math.max(0, (1 - t) / 0.3) : 1;
        const mesh = group.children[0] as THREE.Mesh;
        if (mesh?.material) {
          (mesh.material as THREE.MeshStandardMaterial).opacity = opacity * 0.8;
        }
      }
    });
  });

  return (
    <group>
      {Array.from({ length: NUM_ZS }, (_, i) => (
        <group
          key={i}
          ref={(el) => {
            meshRefs.current[i] = el;
          }}
        >
          <Text
            fontSize={1}
            color="#aaccff"
            anchorX="center"
            anchorY="middle"
            material-transparent={true}
            material-opacity={0.8}
            material-depthWrite={false}
          >
            z
          </Text>
        </group>
      ))}
    </group>
  );
}

function Bird({
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

  // V-shaped wing geometry
  const wingGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    // A single wing: narrow at body, wider at tip, slight sweep
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          0,
          0,
          0, // body attachment
          0.3,
          0,
          -0.04, // mid wing
          0.55,
          0.02,
          -0.08, // wing tip
          0,
          0,
          0.03, // body back
          0.3,
          0,
          0.01, // mid back
        ],
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

    // Soaring path with gentle drift
    const x = cx + Math.sin(angle) * radius;
    const z = cz + Math.cos(angle * 0.7) * radius * 0.6;
    const y = cy + Math.sin(angle * 1.3) * 0.8;

    groupRef.current.position.set(x, y, z);

    // Face direction of travel
    const dx = Math.cos(angle) * radius * speed;
    const dz = -Math.sin(angle * 0.7) * radius * 0.6 * speed * 0.7;
    groupRef.current.rotation.y = Math.atan2(dx, dz);

    // Slight banking on turns
    groupRef.current.rotation.z = -Math.cos(angle) * 0.15;

    // Wing flap - slow graceful flaps with glide pauses
    const flapCycle = (t * 2.5 + phase * 3) % 4; // 4 second cycle
    let flapAngle: number;
    if (flapCycle < 0.3)
      flapAngle = Math.sin((flapCycle / 0.3) * Math.PI) * 0.5; // up
    else if (flapCycle < 0.6)
      flapAngle = Math.sin(((flapCycle - 0.3) / 0.3) * Math.PI) * -0.3; // down
    else flapAngle = Math.sin((flapCycle - 0.6) * 0.3) * 0.05; // glide

    if (leftWingRef.current) leftWingRef.current.rotation.z = flapAngle;
    if (rightWingRef.current) rightWingRef.current.rotation.z = -flapAngle;
  });

  return (
    <group ref={groupRef}>
      {/* Body */}
      <mesh>
        <capsuleGeometry args={[0.015, 0.06, 4, 6]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.9} flatShading />
      </mesh>
      {/* Left wing */}
      <mesh ref={leftWingRef} geometry={wingGeo} scale={[1, 1, 1]}>
        <meshStandardMaterial
          color="#1a1a1a"
          roughness={0.8}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      {/* Right wing */}
      <mesh ref={rightWingRef} geometry={wingGeo} scale={[-1, 1, 1]}>
        <meshStandardMaterial
          color="#1a1a1a"
          roughness={0.8}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      {/* Tail */}
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

function Birds() {
  const birds = useMemo(
    () =>
      Array.from({ length: 8 }, () => ({
        cx: (Math.random() - 0.5) * 30,
        cy: 12 + Math.random() * 10,
        cz: -10 + (Math.random() - 0.5) * 30,
        radius: 3 + Math.random() * 5,
        speed: 0.12 + Math.random() * 0.1,
        phase: Math.random() * Math.PI * 2,
      })),
    [],
  );

  return (
    <group>
      {birds.map((b, i) => (
        <Bird key={i} {...b} />
      ))}
    </group>
  );
}

function CragDog({ isExploring = false }: { isExploring?: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const breathRef = useRef<THREE.Group>(null);
  const dogPosRef = useRef({ x: -2.2, z: 1.8 });
  const dogFacingRef = useRef(0.6 - Math.PI / 2);
  const walkPhaseRef = useRef(0);
  const frontLeftRef = useRef<THREE.Mesh>(null);
  const frontRightRef = useRef<THREE.Mesh>(null);
  const backLeftRef = useRef<THREE.Mesh>(null);
  const backRightRef = useRef<THREE.Mesh>(null);
  const tailRef = useRef<THREE.Mesh>(null);
  const heartRef = useRef<THREE.Mesh>(null);
  const isPettingRef = useRef(false);
  const petBounceRef = useRef(0);
  const bodyRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (isExploring) {
      // Offset rotates with explorer facing so dog stays alongside
      const f = explorerPos.facing;
      // Dog follows behind the climber, slightly to the side
      const behind = 0.8,
        side = 0.3;
      const targetX = explorerPos.x - Math.sin(f) * behind + Math.cos(f) * side;
      const targetZ = explorerPos.z - Math.cos(f) * behind - Math.sin(f) * side;
      const dx = targetX - dogPosRef.current.x;
      const dz = targetZ - dogPosRef.current.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      const petting = explorerKeys.has("p") && dist < 1.5;
      isPettingRef.current = petting;

      if (petting) {
        // Being petted! Sit still, face player, wag fast
        const toPx = explorerPos.x - dogPosRef.current.x;
        const toPz = explorerPos.z - dogPosRef.current.z;
        dogFacingRef.current = Math.atan2(toPx, toPz);

        // Happy bounce
        petBounceRef.current += delta * 10;
        const bounce = Math.abs(Math.sin(petBounceRef.current)) * 0.03;
        if (groupRef.current) {
          groupRef.current.position.set(
            dogPosRef.current.x,
            bounce,
            dogPosRef.current.z,
          );
        }

        // Reset legs
        if (frontLeftRef.current) frontLeftRef.current.rotation.x = 0;
        if (frontRightRef.current) frontRightRef.current.rotation.x = 0;
        if (backLeftRef.current) backLeftRef.current.rotation.x = 0;
        if (backRightRef.current) backRightRef.current.rotation.x = 0;

        // Body wiggles
        if (bodyRef.current) {
          bodyRef.current.rotation.y =
            Math.sin(petBounceRef.current * 1.5) * 0.15;
        }
      } else if (dist > 0.3) {
        const speed = Math.min(6, dist * 3);
        dogPosRef.current.x += (dx / dist) * speed * delta;
        dogPosRef.current.z += (dz / dist) * speed * delta;
        // Face same direction as explorer
        let diff = explorerPos.facing - dogFacingRef.current;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        dogFacingRef.current += diff * Math.min(1, delta * 6);
        walkPhaseRef.current += delta * 12;

        const swing = Math.sin(walkPhaseRef.current) * 0.5;
        if (frontLeftRef.current) frontLeftRef.current.rotation.x = swing;
        if (frontRightRef.current) frontRightRef.current.rotation.x = -swing;
        if (backLeftRef.current) backLeftRef.current.rotation.x = -swing * 0.8;
        if (backRightRef.current) backRightRef.current.rotation.x = swing * 0.8;

        if (groupRef.current) {
          groupRef.current.position.set(
            dogPosRef.current.x,
            0,
            dogPosRef.current.z,
          );
        }
      } else {
        // Smoothly rotate back to match explorer facing
        let diff = explorerPos.facing - dogFacingRef.current;
        // Normalize to [-PI, PI]
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        dogFacingRef.current += diff * Math.min(1, delta * 4);

        if (frontLeftRef.current) frontLeftRef.current.rotation.x = 0;
        if (frontRightRef.current) frontRightRef.current.rotation.x = 0;
        if (backLeftRef.current) backLeftRef.current.rotation.x = 0;
        if (backRightRef.current) backRightRef.current.rotation.x = 0;
        if (groupRef.current) {
          groupRef.current.position.set(
            dogPosRef.current.x,
            0,
            dogPosRef.current.z,
          );
        }
      }

      // Smoothly reset body wiggle when not petting
      if (bodyRef.current && !petting) {
        bodyRef.current.rotation.y *= 0.9;
      }

      // Tail wag — faster when being petted
      if (tailRef.current) {
        const wagSpeed = petting ? 0.02 : 0.008;
        const wagAmount = petting ? 0.8 : 0.5;
        tailRef.current.rotation.z =
          Math.sin(Date.now() * wagSpeed) * wagAmount;
      }

      // Heart floats up when petted
      if (heartRef.current) {
        heartRef.current.visible = petting;
        if (petting) {
          const ht = (Date.now() * 0.002) % 2;
          heartRef.current.position.y = 0.5 + ht * 0.3;
          (heartRef.current.material as THREE.MeshStandardMaterial).opacity =
            ht < 1.5 ? 1 : Math.max(0, 1 - (ht - 1.5) * 2);
        }
      }

      if (groupRef.current) {
        groupRef.current.rotation.y = dogFacingRef.current;
      }
    } else {
      // Sleeping — breathing animation
      if (breathRef.current) {
        const t = Date.now() * 0.001;
        const breath = 1 + Math.sin(t * 1.2) * 0.015;
        breathRef.current.scale.set(1, breath, 1);
      }
      if (groupRef.current) {
        groupRef.current.position.set(-2.2, 0, 1.8);
        groupRef.current.rotation.y = 0.6 - Math.PI / 2;
      }
    }
  });

  const fur = "#8B6914";
  const darkFur = "#6B4F10";
  const nose = "#222";
  const belly = "#BFA054";

  if (isExploring) {
    // Standing/trotting dog — inner group rotated -90 so +X body aligns with +Z forward
    return (
      <group ref={groupRef}>
        <group ref={bodyRef}>
          {/* Heart (petting) */}
          <mesh ref={heartRef} position={[0, 0.5, 0]} visible={false}>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial
              color="#ff3366"
              emissive="#ff1144"
              emissiveIntensity={1}
              transparent
              opacity={1}
            />
          </mesh>
          {/* Body — long axis along Z (forward) */}
          <mesh position={[0, 0.22, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <capsuleGeometry args={[0.09, 0.25, 8, 12]} />
            <meshStandardMaterial color={fur} roughness={0.95} />
          </mesh>
          {/* Belly */}
          <mesh position={[0, 0.17, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <capsuleGeometry args={[0.055, 0.18, 6, 8]} />
            <meshStandardMaterial color={belly} roughness={0.95} />
          </mesh>
          {/* Head — snout points +Z */}
          <mesh position={[0, 0.3, 0.2]}>
            <sphereGeometry args={[0.075, 10, 10]} />
            <meshStandardMaterial color={fur} roughness={0.9} />
          </mesh>
          {/* Snout */}
          <mesh position={[0, 0.28, 0.28]} rotation={[0.1, 0, 0]}>
            <capsuleGeometry args={[0.03, 0.04, 6, 8]} />
            <meshStandardMaterial color={darkFur} roughness={0.9} />
          </mesh>
          {/* Nose */}
          <mesh position={[0, 0.28, 0.32]}>
            <sphereGeometry args={[0.014, 6, 6]} />
            <meshStandardMaterial color={nose} roughness={0.5} />
          </mesh>
          {/* Ears */}
          <mesh position={[0.05, 0.37, 0.16]} rotation={[-0.3, 0, 0.3]}>
            <sphereGeometry args={[0.03, 6, 6]} />
            <meshStandardMaterial color={darkFur} roughness={0.95} />
          </mesh>
          <mesh position={[-0.05, 0.37, 0.16]} rotation={[-0.3, 0, -0.3]}>
            <sphereGeometry args={[0.03, 6, 6]} />
            <meshStandardMaterial color={darkFur} roughness={0.95} />
          </mesh>
          {/* Eyes */}
          <mesh position={[0.03, 0.33, 0.25]}>
            <sphereGeometry args={[0.012, 6, 6]} />
            <meshStandardMaterial color="#222" roughness={0.8} />
          </mesh>
          <mesh position={[-0.03, 0.33, 0.25]}>
            <sphereGeometry args={[0.012, 6, 6]} />
            <meshStandardMaterial color="#222" roughness={0.8} />
          </mesh>
          {/* Tongue (panting) */}
          <mesh position={[0.015, 0.25, 0.29]} rotation={[0.3, 0, 0]}>
            <boxGeometry args={[0.015, 0.002, 0.03]} />
            <meshStandardMaterial color="#dd6688" roughness={0.6} />
          </mesh>
          {/* Front legs — near snout (+Z side) */}
          <mesh ref={frontLeftRef} position={[0.06, 0.1, 0.1]}>
            <capsuleGeometry args={[0.02, 0.16, 6, 6]} />
            <meshStandardMaterial color={fur} roughness={0.95} />
          </mesh>
          <mesh ref={frontRightRef} position={[-0.06, 0.1, 0.1]}>
            <capsuleGeometry args={[0.02, 0.16, 6, 6]} />
            <meshStandardMaterial color={fur} roughness={0.95} />
          </mesh>
          {/* Back legs — near tail (-Z side) */}
          <mesh ref={backLeftRef} position={[0.07, 0.1, -0.12]}>
            <capsuleGeometry args={[0.025, 0.16, 6, 6]} />
            <meshStandardMaterial color={fur} roughness={0.95} />
          </mesh>
          <mesh ref={backRightRef} position={[-0.07, 0.1, -0.12]}>
            <capsuleGeometry args={[0.025, 0.16, 6, 6]} />
            <meshStandardMaterial color={fur} roughness={0.95} />
          </mesh>
          {/* Tail - up and wagging */}
          <mesh
            ref={tailRef}
            position={[0, 0.3, -0.2]}
            rotation={[0.5, 0, 0]}
          >
            <capsuleGeometry args={[0.015, 0.12, 6, 6]} />
            <meshStandardMaterial color={darkFur} roughness={0.95} />
          </mesh>
        </group>
      </group>
    );
  }

  return (
    <group
      ref={groupRef}
      position={[-2.2, 0, 1.8]}
      rotation={[0, 0.6 - Math.PI / 2, 0]}
    >
      {/* Body - oval lying on ground */}
      <group ref={breathRef}>
        <mesh position={[0, 0.12, 0]} rotation={[0, 0, Math.PI / 2]}>
          <capsuleGeometry args={[0.1, 0.28, 8, 12]} />
          <meshStandardMaterial color={fur} roughness={0.95} />
        </mesh>
        {/* Belly (lighter underside) */}
        <mesh position={[0, 0.07, 0.04]} rotation={[0.3, 0, Math.PI / 2]}>
          <capsuleGeometry args={[0.06, 0.2, 6, 8]} />
          <meshStandardMaterial color={belly} roughness={0.95} />
        </mesh>
      </group>

      {/* Head - resting on front paws */}
      <mesh position={[0.22, 0.1, 0]} rotation={[0, 0, 0.1]}>
        <sphereGeometry args={[0.08, 10, 10]} />
        <meshStandardMaterial color={fur} roughness={0.9} />
      </mesh>
      {/* Snout */}
      <mesh position={[0.3, 0.08, 0]} rotation={[0, 0, 0.2]}>
        <capsuleGeometry args={[0.035, 0.04, 6, 8]} />
        <meshStandardMaterial color={darkFur} roughness={0.9} />
      </mesh>
      {/* Nose */}
      <mesh position={[0.34, 0.09, 0]}>
        <sphereGeometry args={[0.015, 6, 6]} />
        <meshStandardMaterial color={nose} roughness={0.5} />
      </mesh>

      {/* Ears - floppy, drooped */}
      <mesh position={[0.18, 0.17, 0.06]} rotation={[0.4, 0.3, -0.5]}>
        <sphereGeometry args={[0.035, 6, 6]} />
        <meshStandardMaterial color={darkFur} roughness={0.95} />
      </mesh>
      <mesh position={[0.18, 0.17, -0.06]} rotation={[-0.4, -0.3, -0.5]}>
        <sphereGeometry args={[0.035, 6, 6]} />
        <meshStandardMaterial color={darkFur} roughness={0.95} />
      </mesh>

      {/* Eyes - closed */}
      <mesh position={[0.27, 0.13, 0.035]}>
        <sphereGeometry args={[0.01, 4, 4]} />
        <meshStandardMaterial color="#333" roughness={1} />
      </mesh>
      <mesh position={[0.27, 0.13, -0.035]}>
        <sphereGeometry args={[0.01, 4, 4]} />
        <meshStandardMaterial color="#333" roughness={1} />
      </mesh>

      {/* Front paws */}
      <mesh position={[0.24, 0.03, 0.06]} rotation={[0, 0.2, 0]}>
        <capsuleGeometry args={[0.025, 0.1, 6, 6]} />
        <meshStandardMaterial color={fur} roughness={0.95} />
      </mesh>
      <mesh position={[0.24, 0.03, -0.06]} rotation={[0, -0.2, 0]}>
        <capsuleGeometry args={[0.025, 0.1, 6, 6]} />
        <meshStandardMaterial color={fur} roughness={0.95} />
      </mesh>
      {/* Paw pads */}
      <mesh position={[0.3, 0.02, 0.06]}>
        <sphereGeometry args={[0.02, 6, 6]} />
        <meshStandardMaterial color={darkFur} roughness={0.9} />
      </mesh>
      <mesh position={[0.3, 0.02, -0.06]}>
        <sphereGeometry args={[0.02, 6, 6]} />
        <meshStandardMaterial color={darkFur} roughness={0.9} />
      </mesh>

      {/* Back legs - tucked in */}
      <mesh position={[-0.15, 0.07, 0.1]} rotation={[0.5, 0, 0.8]}>
        <capsuleGeometry args={[0.03, 0.1, 6, 6]} />
        <meshStandardMaterial color={fur} roughness={0.95} />
      </mesh>
      <mesh position={[-0.15, 0.07, -0.1]} rotation={[-0.5, 0, 0.8]}>
        <capsuleGeometry args={[0.03, 0.1, 6, 6]} />
        <meshStandardMaterial color={fur} roughness={0.95} />
      </mesh>

      {/* Tail - curled around body */}
      <mesh position={[-0.25, 0.08, 0.08]} rotation={[0.8, 0.5, 0.3]}>
        <capsuleGeometry args={[0.02, 0.12, 6, 6]} />
        <meshStandardMaterial color={darkFur} roughness={0.95} />
      </mesh>
      <mesh position={[-0.28, 0.06, 0.14]} rotation={[1.2, 0.8, 0]}>
        <capsuleGeometry args={[0.015, 0.06, 6, 6]} />
        <meshStandardMaterial color={darkFur} roughness={0.95} />
      </mesh>

      {/* Zzzzs */}
      <SleepingZs origin={[0.2, 0.25, 0]} />
    </group>
  );
}

function Mountains() {
  const mountainData = useMemo(() => {
    // Generate several mountain ranges at different depths
    const ranges: {
      peaks: number[];
      z: number;
      color: string;
      baseY: number;
      snowLine?: number;
    }[] = [
      // Near foothills behind wall
      {
        peaks: [
          -40, 2, -30, 5, -20, 3, -10, 6, 0, 4, 10, 7, 20, 5, 30, 6, 40, 3,
        ],
        z: -18,
        color: "#5a6555",
        baseY: -2,
      },
      // Mid hills behind wall
      {
        peaks: [
          -45, 5, -35, 9, -25, 6, -15, 12, -5, 8, 5, 11, 15, 7, 25, 10, 35, 6,
          45, 5,
        ],
        z: -32,
        color: "#4a5550",
        baseY: -2,
      },
      // Tall ridge behind wall
      {
        peaks: [
          -50, 8, -40, 14, -30, 10, -20, 18, -10, 12, 0, 16, 10, 11, 20, 15, 30,
          9, 40, 12, 50, 7,
        ],
        z: -48,
        color: "#3a4a52",
        baseY: -2,
        snowLine: 14,
      },
      // Front valley wall
      {
        peaks: [
          -45, 10, -35, 16, -25, 12, -15, 18, -5, 13, 5, 16, 15, 11, 25, 14, 35,
          10, 45, 12,
        ],
        z: 35,
        color: "#3a4a55",
        baseY: -2,
        snowLine: 14,
      },
      // Side hills
      {
        peaks: [-55, 3, -48, 7, -42, 5, -36, 9, -30, 5],
        z: -16,
        color: "#4d5a50",
        baseY: -2,
      },
      {
        peaks: [30, 5, 36, 9, 42, 5, 48, 7, 55, 3],
        z: -16,
        color: "#4d5a50",
        baseY: -2,
      },
    ];

    return ranges.map((range) => {
      const verts: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      const pairs = [];
      for (let i = 0; i < range.peaks.length; i += 2) {
        pairs.push({ x: range.peaks[i], y: range.peaks[i + 1] });
      }

      const baseColor = new THREE.Color(range.color);
      const snowColor = new THREE.Color("#e8e8f0");

      for (let i = 0; i < pairs.length; i++) {
        const vi = verts.length / 3;
        verts.push(pairs[i].x, pairs[i].y, range.z);
        verts.push(pairs[i].x, range.baseY, range.z);

        // Snow on peaks above snowLine
        if (range.snowLine && pairs[i].y > range.snowLine) {
          const snowBlend = Math.min(1, (pairs[i].y - range.snowLine) / 6);
          const c = baseColor.clone().lerp(snowColor, snowBlend);
          colors.push(c.r, c.g, c.b);
        } else {
          colors.push(baseColor.r, baseColor.g, baseColor.b);
        }
        colors.push(baseColor.r, baseColor.g, baseColor.b); // base always rock color

        if (i > 0) {
          indices.push(vi - 2, vi - 1, vi);
          indices.push(vi - 1, vi + 1, vi);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(verts, 3),
      );
      geometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(colors, 3),
      );
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      return {
        geometry,
        color: range.color,
        hasVertexColors: !!range.snowLine,
      };
    });
  }, []);

  return (
    <group>
      {mountainData.map((m, i) => (
        <mesh key={i} geometry={m.geometry}>
          <meshStandardMaterial
            color={m.hasVertexColors ? "#ffffff" : m.color}
            vertexColors={m.hasVertexColors}
            roughness={1}
            flatShading
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#3a4a35" roughness={1} />
      </mesh>
      {/* Distant trees (simple cones) */}
      {useMemo(() => {
        const trees: JSX.Element[] = [];
        const rng = (seed: number) => {
          let s = seed;
          return () => {
            s = (s * 16807) % 2147483647;
            return (s - 1) / 2147483646;
          };
        };
        const rand = rng(42);
        for (let i = 0; i < 300; i++) {
          const x = (rand() - 0.5) * 80;
          const z = i < 160 ? -6 - rand() * 30 : 18 + rand() * 15;
          const h = 1.5 + rand() * 3;
          const r = 0.4 + rand() * 0.6;
          trees.push(
            <group key={i} position={[x, h * 0.5, z]}>
              <mesh>
                <coneGeometry args={[r, h, 5]} />
                <meshStandardMaterial
                  color={`hsl(${140 + rand() * 30}, ${25 + rand() * 15}%, ${18 + rand() * 10}%)`}
                  roughness={1}
                  flatShading
                />
              </mesh>
              <mesh position={[0, -h * 0.35, 0]}>
                <cylinderGeometry args={[r * 0.12, r * 0.15, h * 0.3, 4]} />
                <meshStandardMaterial color="#3d2b1f" roughness={1} />
              </mesh>
            </group>,
          );
        }
        return trees;
      }, [])}
    </group>
  );
}

function River() {
  const riverPath = useMemo(() => {
    // Meandering river path points
    const points: [number, number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const x = -25 + t * 50;
      const z =
        -12 + Math.sin(t * Math.PI * 2.5) * 3 + Math.cos(t * Math.PI * 1.2) * 2;
      points.push([x, 0.01, z]);
    }
    return points;
  }, []);

  const { geometry, leftBank, rightBank } = useMemo(() => {
    const verts: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const width = 1.8;
    const lBank: [number, number, number][] = [];
    const rBank: [number, number, number][] = [];

    for (let i = 0; i < riverPath.length; i++) {
      const [x, y, z] = riverPath[i];
      // Get perpendicular direction
      let dx = 0,
        dz = 0;
      if (i < riverPath.length - 1) {
        dx = riverPath[i + 1][0] - x;
        dz = riverPath[i + 1][2] - z;
      } else {
        dx = x - riverPath[i - 1][0];
        dz = z - riverPath[i - 1][2];
      }
      const len = Math.sqrt(dx * dx + dz * dz);
      const nx = -dz / len;
      const nz = dx / len;

      const vi = verts.length / 3;
      verts.push(x + nx * width * 0.5, y, z + nz * width * 0.5);
      verts.push(x - nx * width * 0.5, y, z - nz * width * 0.5);
      uvs.push(0, i / riverPath.length);
      uvs.push(1, i / riverPath.length);
      lBank.push([x + nx * width * 0.55, 0.005, z + nz * width * 0.55]);
      rBank.push([x - nx * width * 0.55, 0.005, z - nz * width * 0.55]);

      if (i > 0) {
        indices.push(vi - 2, vi - 1, vi);
        indices.push(vi - 1, vi + 1, vi);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return { geometry: geo, leftBank: lBank, rightBank: rBank };
  }, [riverPath]);

  // Animate water shimmer
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    if (matRef.current) {
      const t = Date.now() * 0.001;
      matRef.current.emissiveIntensity = 0.08 + Math.sin(t * 2) * 0.04;
    }
  });

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          ref={matRef}
          color="#1a3a5a"
          emissive="#2a5a8a"
          emissiveIntensity={0.08}
          roughness={0.15}
          metalness={0.6}
          transparent
          opacity={0.8}
        />
      </mesh>
      {/* River banks - subtle sandy edges */}
      {[leftBank, rightBank].map((bank, bi) => (
        <line key={bi}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              array={new Float32Array(bank.flat())}
              count={bank.length}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#5a5040" linewidth={1} />
        </line>
      ))}
      {/* A few river rocks */}
      {useMemo(() => {
        const rocks: JSX.Element[] = [];
        const rng = (seed: number) => {
          let s = seed;
          return () => {
            s = (s * 16807) % 2147483647;
            return (s - 1) / 2147483646;
          };
        };
        const rand = rng(99);
        for (let i = 0; i < 12; i++) {
          const idx = Math.floor(rand() * (riverPath.length - 2)) + 1;
          const [rx, _, rz] = riverPath[idx];
          const offset = (rand() - 0.5) * 1.2;
          const sz = 0.06 + rand() * 0.12;
          rocks.push(
            <mesh
              key={i}
              position={[rx + offset * 0.3, 0.02 + sz * 0.3, rz + offset]}
            >
              <sphereGeometry args={[sz, 5, 4]} />
              <meshStandardMaterial
                color={`hsl(30, 5%, ${30 + rand() * 20}%)`}
                roughness={0.9}
                flatShading
              />
            </mesh>,
          );
        }
        return rocks;
      }, [riverPath])}
    </group>
  );
}

function Deer({
  startX,
  startZ,
  scale: s,
}: {
  startX: number;
  startZ: number;
  scale: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const legRefs = useRef<(THREE.Mesh | null)[]>([]);
  const headRef = useRef<THREE.Group>(null);
  const tailRef = useRef<THREE.Mesh>(null);

  // Each deer has its own random walk/graze cycle
  const behavior = useMemo(
    () => ({
      walkSpeed: 0.04 + Math.random() * 0.03,
      walkRadius: 1.5 + Math.random() * 2,
      grazeInterval: 3 + Math.random() * 4, // seconds between grazing
      grazeDuration: 5 + Math.random() * 8,
      phaseOffset: Math.random() * Math.PI * 2,
      dirOffset: Math.random() * Math.PI * 2,
    }),
    [],
  );

  useFrame(() => {
    if (!groupRef.current) return;
    const t = Date.now() * 0.001;
    const phase = t * 0.08 + behavior.phaseOffset;

    // Walk in a gentle loop
    const x =
      startX + Math.sin(phase + behavior.dirOffset) * behavior.walkRadius;
    const z =
      startZ +
      Math.cos(phase * 0.7 + behavior.dirOffset) * behavior.walkRadius * 0.6;
    groupRef.current.position.set(x, 0, z);

    // Face movement direction
    const dx = Math.cos(phase + behavior.dirOffset) * behavior.walkRadius * 0.3;
    const dz =
      -Math.sin(phase * 0.7 + behavior.dirOffset) *
      behavior.walkRadius *
      0.6 *
      0.7;
    groupRef.current.rotation.y = Math.atan2(dx, dz);

    // Grazing: head dips down periodically
    const grazeCycle =
      (t + behavior.phaseOffset) %
      (behavior.grazeInterval + behavior.grazeDuration);
    const isGrazing = grazeCycle > behavior.grazeInterval;
    if (headRef.current) {
      const targetRot = isGrazing ? 1.2 : 0.05;
      headRef.current.rotation.x +=
        (targetRot - headRef.current.rotation.x) * 0.05;
    }

    // Leg animation (walk cycle)
    const legSwing = isGrazing ? 0 : Math.sin(t * 1.5 + behavior.phaseOffset);
    for (let i = 0; i < 4; i++) {
      const leg = legRefs.current[i];
      if (leg) {
        const sign = i % 2 === 0 ? 1 : -1;
        const frontBack = i < 2 ? 1 : -1;
        leg.rotation.x =
          legSwing * 0.25 * sign * frontBack * (isGrazing ? 0.1 : 1);
      }
    }

    // Tail flick
    if (tailRef.current) {
      tailRef.current.rotation.x =
        -0.5 + Math.sin(t * 2 + behavior.phaseOffset * 3) * 0.3;
    }
  });

  const body = "#b5864a";
  const belly = "#d4b078";
  const legColor = "#8a6830";

  return (
    <group ref={groupRef} scale={[s, s, s]}>
      {/* Body - elongated box */}
      <mesh position={[0, 0.55, 0]} scale={[0.18, 0.16, 0.45]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={body} roughness={0.9} flatShading />
      </mesh>
      {/* Chest - slightly wider front */}
      <mesh position={[0, 0.57, 0.18]} scale={[0.16, 0.18, 0.12]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={body} roughness={0.9} flatShading />
      </mesh>
      {/* Haunches */}
      <mesh position={[0, 0.54, -0.18]} scale={[0.15, 0.17, 0.1]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={body} roughness={0.9} flatShading />
      </mesh>
      {/* Belly underside */}
      <mesh position={[0, 0.48, 0]} scale={[0.14, 0.06, 0.35]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={belly} roughness={0.9} flatShading />
      </mesh>
      {/* Legs - thin cylinders */}
      {[
        [-0.07, 0.2, 0.17],
        [0.07, 0.2, 0.17],
        [-0.07, 0.2, -0.17],
        [0.07, 0.2, -0.17],
      ].map((pos, i) => (
        <mesh
          key={i}
          ref={(el) => {
            legRefs.current[i] = el;
          }}
          position={pos as V3}
        >
          <cylinderGeometry args={[0.018, 0.022, 0.42, 4]} />
          <meshStandardMaterial color={legColor} roughness={0.9} flatShading />
        </mesh>
      ))}
      {/* Neck + Head group */}
      <group ref={headRef} position={[0, 0.65, 0.25]}>
        {/* Neck */}
        <mesh position={[0, 0.1, 0.05]} rotation={[0.3, 0, 0]}>
          <cylinderGeometry args={[0.03, 0.05, 0.22, 4]} />
          <meshStandardMaterial color={body} roughness={0.9} flatShading />
        </mesh>
        {/* Head */}
        <mesh position={[0, 0.18, 0.1]} scale={[0.7, 0.8, 1.1]}>
          <boxGeometry args={[0.1, 0.1, 0.12]} />
          <meshStandardMaterial color={body} roughness={0.9} flatShading />
        </mesh>
        {/* Snout */}
        <mesh position={[0, 0.15, 0.18]} scale={[0.6, 0.5, 1]}>
          <boxGeometry args={[0.06, 0.05, 0.06]} />
          <meshStandardMaterial color="#a07840" roughness={0.9} flatShading />
        </mesh>
        {/* Ears */}
        {[
          [-0.06, 0.24, 0.08],
          [0.06, 0.24, 0.08],
        ].map((pos, i) => (
          <mesh
            key={i}
            position={pos as V3}
            rotation={[0.3, i === 0 ? -0.3 : 0.3, 0]}
          >
            <coneGeometry args={[0.025, 0.06, 4]} />
            <meshStandardMaterial color={body} roughness={0.9} flatShading />
          </mesh>
        ))}
        {/* Antlers (small) */}
        {[
          [-0.04, 0.26, 0.06],
          [0.04, 0.26, 0.06],
        ].map((pos, i) => (
          <group key={i} position={pos as V3}>
            <mesh rotation={[0.2, 0, i === 0 ? -0.2 : 0.2]}>
              <cylinderGeometry args={[0.008, 0.012, 0.12, 4]} />
              <meshStandardMaterial color="#6b5030" roughness={1} flatShading />
            </mesh>
            <mesh
              position={[i === 0 ? -0.02 : 0.02, 0.05, 0.01]}
              rotation={[0.3, 0, i === 0 ? -0.5 : 0.5]}
            >
              <cylinderGeometry args={[0.006, 0.008, 0.06, 3]} />
              <meshStandardMaterial color="#6b5030" roughness={1} flatShading />
            </mesh>
          </group>
        ))}
      </group>
      {/* Tail */}
      <mesh ref={tailRef} position={[0, 0.6, -0.25]} rotation={[-0.5, 0, 0]}>
        <coneGeometry args={[0.03, 0.08, 4]} />
        <meshStandardMaterial color="#e8d8b8" roughness={0.9} flatShading />
      </mesh>
    </group>
  );
}

function Tent() {
  const tentGeo = useMemo(() => {
    // Triangular prism: ridge at top, base width 1.6, length 2.0, height 1.1
    const w = 0.8,
      h = 1.1,
      d = 1.0;
    // Vertices: front-left, front-right, front-top, back-left, back-right, back-top
    const fl: V3 = [-w, 0, d],
      fr: V3 = [w, 0, d],
      ft: V3 = [0, h, d];
    const bl: V3 = [-w, 0, -d],
      br: V3 = [w, 0, -d],
      bt: V3 = [0, h, -d];

    // Left slope, right slope, floor
    const leftVerts = [...bl, ...fl, ...ft, ...bl, ...ft, ...bt];
    const rightVerts = [...fr, ...br, ...bt, ...fr, ...bt, ...ft];
    const floorVerts = [...fl, ...fr, ...br, ...fl, ...br, ...bl];
    // Back wall (solid triangle)
    const backVerts = [...bl, ...br, ...bt];

    return { leftVerts, rightVerts, floorVerts, backVerts };
  }, []);

  // Front wall: two triangles with door cutout in center
  const frontGeo = useMemo(() => {
    const w = 0.8,
      h = 1.1,
      d = 1.0;
    const doorW = 0.25,
      doorH = 0.6;
    // Left portion of front: triangle from fl to door-left to top
    // Right portion: triangle from door-right to fr to top
    // Above door: small triangle from door-left to door-right to top
    const verts = [
      // Left side of door
      -w,
      0,
      d,
      -doorW,
      0,
      d,
      0,
      h,
      d,
      -w,
      0,
      d,
      -doorW,
      doorH,
      d,
      0,
      h,
      d,
      -w,
      0,
      d,
      -doorW,
      0,
      d,
      -doorW,
      doorH,
      d,
      // Right side of door
      doorW,
      0,
      d,
      w,
      0,
      d,
      0,
      h,
      d,
      doorW,
      doorH,
      d,
      w,
      0,
      d,
      0,
      h,
      d,
      doorW,
      0,
      d,
      doorW,
      doorH,
      d,
      w,
      0,
      d,
      // Above door
      -doorW,
      doorH,
      d,
      doorW,
      doorH,
      d,
      0,
      h,
      d,
    ];
    return new Float32Array(verts);
  }, []);

  return (
    <group position={[5, 0, -6]} rotation={[0, -0.4, 0]}>
      {/* Left slope */}
      <mesh>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={new Float32Array(tentGeo.leftVerts)}
            count={6}
            itemSize={3}
          />
        </bufferGeometry>
        <meshStandardMaterial
          color="#c45c2c"
          roughness={0.85}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      {/* Right slope */}
      <mesh>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={new Float32Array(tentGeo.rightVerts)}
            count={6}
            itemSize={3}
          />
        </bufferGeometry>
        <meshStandardMaterial
          color="#b84e22"
          roughness={0.85}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      {/* Back wall */}
      <mesh>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={new Float32Array(tentGeo.backVerts)}
            count={3}
            itemSize={3}
          />
        </bufferGeometry>
        <meshStandardMaterial
          color="#a84520"
          roughness={0.85}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      {/* Front wall with door cutout */}
      <mesh>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={frontGeo}
            count={frontGeo.length / 3}
            itemSize={3}
          />
        </bufferGeometry>
        <meshStandardMaterial
          color="#d4663a"
          roughness={0.85}
          side={THREE.DoubleSide}
          flatShading
        />
      </mesh>
      {/* Door opening - dark interior */}
      <mesh position={[0, 0.3, 1.001]}>
        <planeGeometry args={[0.5, 0.6]} />
        <meshStandardMaterial color="#1a0a00" roughness={1} />
      </mesh>
      {/* Floor */}
      <mesh>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={new Float32Array(tentGeo.floorVerts)}
            count={6}
            itemSize={3}
          />
        </bufferGeometry>
        <meshStandardMaterial
          color="#993d18"
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Ridge pole */}
      <mesh position={[0, 1.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.015, 0.015, 2.0, 4]} />
        <meshStandardMaterial color="#666" roughness={0.9} />
      </mesh>
    </group>
  );
}

function Rocks() {
  const rocks = useMemo(() => {
    const rng = (seed: number) => {
      let s = seed;
      return () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
      };
    };
    const rand = rng(77);
    const result: { pos: V3; scale: V3; rot: V3; color: string }[] = [];

    // Big background boulders
    const boulderSpots: [number, number][] = [
      [-8, -5],
      [-5, -7],
      [7, -6],
      [10, -4],
      [-12, -6],
      [14, -8],
      [-3, -9],
    ];
    for (const [bx, bz] of boulderSpots) {
      const sz = 0.6 + rand() * 1.0;
      result.push({
        pos: [bx + rand() * 0.5, sz * 0.4, bz + rand() * 0.5],
        scale: [
          sz * (0.8 + rand() * 0.5),
          sz * (0.6 + rand() * 0.4),
          sz * (0.7 + rand() * 0.5),
        ],
        rot: [rand() * 0.3, rand() * Math.PI, rand() * 0.2],
        color: `hsl(${20 + rand() * 20}, ${5 + rand() * 8}%, ${25 + rand() * 15}%)`,
      });
    }

    // Small rocks near the wall base
    for (let i = 0; i < 7; i++) {
      const sz = 0.05 + rand() * 0.12;
      result.push({
        pos: [(rand() - 0.5) * 4, sz * 0.4, 1.5 + rand() * 2],
        scale: [
          sz * (0.8 + rand() * 0.6),
          sz * (0.6 + rand() * 0.4),
          sz * (0.7 + rand() * 0.5),
        ],
        rot: [rand() * 0.5, rand() * Math.PI * 2, rand() * 0.3],
        color: `hsl(${25 + rand() * 15}, ${4 + rand() * 6}%, ${30 + rand() * 18}%)`,
      });
    }

    return result;
  }, []);

  return (
    <group>
      {rocks.map((r, i) => (
        <mesh key={i} position={r.pos} rotation={r.rot} scale={r.scale}>
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={r.color} roughness={0.95} flatShading />
        </mesh>
      ))}
    </group>
  );
}

function Campfire() {
  const flameRef = useRef<THREE.Group>(null);
  const sparkRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const sparkCount = 15;

  const sparks = useMemo(
    () =>
      Array.from({ length: sparkCount }, () => ({
        offset: Math.random() * 3,
        dx: (Math.random() - 0.5) * 0.4,
        dz: (Math.random() - 0.5) * 0.4,
        speed: 0.5 + Math.random() * 0.5,
      })),
    [],
  );

  useFrame(() => {
    const t = Date.now() * 0.001;
    // Flame flicker
    if (flameRef.current) {
      flameRef.current.scale.y =
        1 + Math.sin(t * 8) * 0.15 + Math.sin(t * 13) * 0.1;
      flameRef.current.scale.x = 1 + Math.sin(t * 6 + 1) * 0.08;
      flameRef.current.rotation.y = t * 0.5;
    }
    // Sparks rising
    if (sparkRef.current) {
      for (let i = 0; i < sparkCount; i++) {
        const s = sparks[i];
        const age = ((t * s.speed + s.offset) % 2) / 2;
        dummy.position.set(s.dx * age, 0.3 + age * 1.2, s.dz * age);
        const sc = 0.015 * (1 - age);
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        sparkRef.current.setMatrixAt(i, dummy.matrix);
      }
      sparkRef.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group position={[3, 0, -3.5]}>
      {/* Fire ring stones */}
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 0.35, 0.06, Math.sin(a) * 0.35]}
          >
            <boxGeometry args={[0.12, 0.1, 0.1]} />
            <meshStandardMaterial
              color={`hsl(20, 5%, ${28 + (i % 3) * 5}%)`}
              roughness={1}
              flatShading
            />
          </mesh>
        );
      })}
      {/* Logs in fire (criss-crossed) */}
      <mesh position={[0, 0.08, 0]} rotation={[0, 0.3, 0]}>
        <cylinderGeometry args={[0.04, 0.035, 0.5, 5]} />
        <meshStandardMaterial color="#3d2010" roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.1, 0]} rotation={[0, -0.8, 0]}>
        <cylinderGeometry args={[0.035, 0.04, 0.45, 5]} />
        <meshStandardMaterial color="#4a2815" roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.14, 0]} rotation={[0, 1.2, Math.PI / 2]}>
        <cylinderGeometry args={[0.03, 0.035, 0.4, 5]} />
        <meshStandardMaterial color="#352010" roughness={1} flatShading />
      </mesh>
      {/* Flames */}
      <group ref={flameRef}>
        <mesh position={[0, 0.35, 0]}>
          <coneGeometry args={[0.12, 0.4, 5]} />
          <meshStandardMaterial
            color="#ff6600"
            emissive="#ff4400"
            emissiveIntensity={2}
            transparent
            opacity={0.85}
          />
        </mesh>
        <mesh position={[0.05, 0.3, 0.03]}>
          <coneGeometry args={[0.08, 0.3, 4]} />
          <meshStandardMaterial
            color="#ffaa00"
            emissive="#ff6600"
            emissiveIntensity={2}
            transparent
            opacity={0.7}
          />
        </mesh>
        <mesh position={[-0.04, 0.28, -0.02]}>
          <coneGeometry args={[0.06, 0.25, 4]} />
          <meshStandardMaterial
            color="#ffcc33"
            emissive="#ff8800"
            emissiveIntensity={2}
            transparent
            opacity={0.6}
          />
        </mesh>
      </group>
      {/* Fire glow light */}
      <pointLight
        position={[0, 0.4, 0]}
        color="#ff6622"
        intensity={0.5}
        distance={5}
      />
      {/* Sparks */}
      <instancedMesh ref={sparkRef} args={[undefined, undefined, sparkCount]}>
        <sphereGeometry args={[1, 4, 3]} />
        <meshBasicMaterial color="#ffaa33" />
      </instancedMesh>
      {/* Sitting logs around fire */}
      {/* Sitting log 1 - front */}
      <mesh position={[0.7, 0.1, 0.3]} rotation={[Math.PI / 2, 0, 0.5]}>
        <cylinderGeometry args={[0.09, 0.1, 0.5, 6]} />
        <meshStandardMaterial color="#5a3a1a" roughness={0.95} flatShading />
      </mesh>
      {/* Sitting log 2 - left */}
      <mesh position={[-0.6, 0.1, 0.4]} rotation={[Math.PI / 2, 0, -0.6]}>
        <cylinderGeometry args={[0.1, 0.11, 0.45, 6]} />
        <meshStandardMaterial color="#4d3015" roughness={0.95} flatShading />
      </mesh>
      {/* Sitting log 3 - back right */}
      <mesh position={[0.3, 0.1, -0.7]} rotation={[Math.PI / 2, 0, 1.2]}>
        <cylinderGeometry args={[0.09, 0.095, 0.45, 6]} />
        <meshStandardMaterial color="#5e3818" roughness={0.95} flatShading />
      </mesh>
    </group>
  );
}

function DeerHerd() {
  const deerPositions = useMemo(
    () => [
      { x: -12, z: -14, scale: 1.1 },
      { x: -9, z: -16, scale: 1.2 },
      { x: -14, z: -15, scale: 1.0 },
      { x: 10, z: -13, scale: 1.15 },
    ],
    [],
  );

  return (
    <group>
      {deerPositions.map((d, i) => (
        <Deer key={i} startX={d.x} startZ={d.z} scale={d.scale} />
      ))}
    </group>
  );
}

function PlacedHoldsGroup({
  holds,
  segments,
  onHoldClick,
  eraserMode,
}: {
  holds: PlacedHold[];
  segments: WallSegment[];
  onHoldClick?: (id: string) => void;
  eraserMode?: boolean;
}) {
  const toWorldSeg = useCallback(
    (x: number, h: number, d: number): { pos: V3; angleRad: number } => {
      // Find which segment this height falls on
      let curWorldY = 0,
        curWorldZ = 0,
        remaining = h;
      for (const seg of segments) {
        const ar = (seg.angleDeg * Math.PI) / 180;
        if (remaining <= seg.height) {
          const wallUp: V3 = [0, Math.cos(ar), Math.sin(ar)];
          const wallNorm: V3 = [0, -Math.sin(ar), Math.cos(ar)];
          const wy = curWorldY + remaining * wallUp[1] + d * wallNorm[1];
          const wz = curWorldZ + remaining * wallUp[2] + d * wallNorm[2];
          return { pos: [x, wy, wz], angleRad: ar };
        }
        curWorldY += seg.height * Math.cos(ar);
        curWorldZ += seg.height * Math.sin(ar);
        remaining -= seg.height;
      }
      // Past top - use last segment
      const last = segments[segments.length - 1];
      const ar = (last.angleDeg * Math.PI) / 180;
      const wallUp: V3 = [0, Math.cos(ar), Math.sin(ar)];
      const wallNorm: V3 = [0, -Math.sin(ar), Math.cos(ar)];
      const wy = curWorldY + remaining * wallUp[1] + d * wallNorm[1];
      const wz = curWorldZ + remaining * wallUp[2] + d * wallNorm[2];
      return { pos: [x, wy, wz], angleRad: ar };
    },
    [segments],
  );

  return (
    <group>
      {holds.map((hold) => {
        const { pos: _p, angleRad } = toWorldSeg(hold.x, hold.y, 0);
        const toWorld = (x: number, h: number, d: number): V3 =>
          toWorldSeg(x, h, d).pos;
        return (
          <PlacedHold3D
            key={hold.id}
            hold={hold}
            wallAngleRad={angleRad}
            toWorld={toWorld}
            onClick={onHoldClick}
            eraserMode={eraserMode}
          />
        );
      })}
    </group>
  );
}

// === CLIMBING SHOP / HANGOUT AREA ===
function ClimbingShop() {
  // Fire flicker
  const flameRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (flameRef.current) {
      const t = Date.now() * 0.001;
      flameRef.current.scale.y =
        1 + Math.sin(t * 7) * 0.2 + Math.sin(t * 11) * 0.1;
      flameRef.current.scale.x = 1 + Math.sin(t * 5 + 2) * 0.1;
      flameRef.current.rotation.y = t * 0.4;
    }
  });

  const shopX = -45;
  const shopZ = 8;

  return (
    <group position={[shopX, 0, shopZ]}>
      {/* === SHOP BUILDING === */}
      {/* Main cabin */}
      <mesh position={[0, 1.2, 0]}>
        <boxGeometry args={[4, 2.4, 3.5]} />
        <meshStandardMaterial color="#7a5c3a" roughness={0.9} />
      </mesh>
      {/* Roof */}
      <mesh position={[0, 2.8, 0]} rotation={[0, 0, 0]}>
        <coneGeometry args={[3.2, 1.4, 4]} />
        <meshStandardMaterial color="#4a3020" roughness={0.95} />
      </mesh>
      {/* Front door */}
      <mesh position={[0, 0.7, 1.76]}>
        <boxGeometry args={[0.8, 1.4, 0.05]} />
        <meshStandardMaterial color="#3a2510" roughness={0.8} />
      </mesh>
      {/* Door frame */}
      <mesh position={[0, 0.7, 1.78]}>
        <boxGeometry args={[0.9, 1.5, 0.02]} />
        <meshStandardMaterial color="#5a4020" roughness={0.85} />
      </mesh>
      {/* Windows */}
      <mesh position={[-1.2, 1.4, 1.76]}>
        <boxGeometry args={[0.6, 0.5, 0.05]} />
        <meshStandardMaterial color="#88bbdd" roughness={0.3} metalness={0.1} />
      </mesh>
      <mesh position={[1.2, 1.4, 1.76]}>
        <boxGeometry args={[0.6, 0.5, 0.05]} />
        <meshStandardMaterial color="#88bbdd" roughness={0.3} metalness={0.1} />
      </mesh>
      {/* Sign: "CLIMBING SHOP" */}
      <mesh position={[0, 2.3, 1.78]}>
        <boxGeometry args={[2.4, 0.4, 0.05]} />
        <meshStandardMaterial color="#2a1a08" roughness={0.9} />
      </mesh>
      <Text
        position={[0, 2.3, 1.82]}
        fontSize={0.18}
        color="#e8d090"
        anchorX="center"
        anchorY="middle"
        font={undefined}
      >
        SEND IT CLIMBING SHOP
      </Text>
      {/* Porch overhang */}
      <mesh position={[0, 2.0, 2.3]}>
        <boxGeometry args={[4.2, 0.08, 1.2]} />
        <meshStandardMaterial color="#5a3820" roughness={0.9} />
      </mesh>
      {/* Porch posts */}
      {[-1.8, 1.8].map((px, i) => (
        <mesh key={i} position={[px, 1.0, 2.8]}>
          <cylinderGeometry args={[0.06, 0.06, 2.0, 8]} />
          <meshStandardMaterial color="#6a4830" roughness={0.85} />
        </mesh>
      ))}
      {/* Gear rack outside (shoes, ropes) */}
      <mesh position={[2.5, 0.8, 1.5]}>
        <boxGeometry args={[0.6, 1.6, 0.3]} />
        <meshStandardMaterial color="#555" roughness={0.8} />
      </mesh>
      {/* Climbing shoes on rack */}
      {[0.5, 0.2, -0.1, -0.4].map((y, i) => (
        <mesh
          key={i}
          position={[2.5, 0.8 + y, 1.7]}
          rotation={[0.2, i * 0.5, 0]}
        >
          <boxGeometry args={[0.12, 0.06, 0.18]} />
          <meshStandardMaterial
            color={["#cc3333", "#3366cc", "#33aa55", "#dd8800"][i]}
            roughness={0.7}
          />
        </mesh>
      ))}
      {/* Rope coils on wall */}
      {[-0.5, 0.5].map((dy, i) => (
        <mesh
          key={i}
          position={[-2.01, 1.6 + dy * 0.5, 0.5]}
          rotation={[0, 0, Math.PI / 2]}
        >
          <torusGeometry args={[0.2, 0.05, 8, 16]} />
          <meshStandardMaterial
            color={["#e8d44d", "#dd6633"][i]}
            roughness={0.7}
          />
        </mesh>
      ))}

      {/* === FIRE PIT === */}
      <group position={[3, 0, 5]}>
        {/* Stone ring */}
        {Array.from({ length: 10 }, (_, i) => {
          const a = (i / 10) * Math.PI * 2;
          return (
            <mesh
              key={i}
              position={[Math.cos(a) * 0.6, 0.08, Math.sin(a) * 0.6]}
              rotation={[0, a, 0]}
            >
              <boxGeometry args={[0.18, 0.14, 0.12]} />
              <meshStandardMaterial
                color={`hsl(20, 5%, ${25 + (i % 3) * 5}%)`}
                roughness={1}
                flatShading
              />
            </mesh>
          );
        })}
        {/* Logs */}
        <mesh position={[0, 0.1, 0]} rotation={[0, 0.4, Math.PI / 2]}>
          <cylinderGeometry args={[0.06, 0.05, 0.8, 6]} />
          <meshStandardMaterial color="#5e3818" roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.12, 0]} rotation={[0, -0.8, Math.PI / 2]}>
          <cylinderGeometry args={[0.05, 0.06, 0.7, 6]} />
          <meshStandardMaterial color="#4e2c14" roughness={0.95} />
        </mesh>
        {/* Flames */}
        <group ref={flameRef} position={[0, 0.2, 0]}>
          <mesh>
            <coneGeometry args={[0.15, 0.5, 8]} />
            <meshStandardMaterial
              color="#ff6600"
              emissive="#ff4400"
              emissiveIntensity={2}
              transparent
              opacity={0.8}
            />
          </mesh>
          <mesh position={[0.08, 0.05, 0.05]}>
            <coneGeometry args={[0.08, 0.35, 6]} />
            <meshStandardMaterial
              color="#ffaa00"
              emissive="#ff8800"
              emissiveIntensity={2}
              transparent
              opacity={0.7}
            />
          </mesh>
          <mesh position={[-0.06, -0.02, -0.04]}>
            <coneGeometry args={[0.1, 0.3, 6]} />
            <meshStandardMaterial
              color="#ff3300"
              emissive="#ff2200"
              emissiveIntensity={1.5}
              transparent
              opacity={0.6}
            />
          </mesh>
        </group>
        {/* Fire light */}
        <pointLight
          position={[0, 0.5, 0]}
          color="#ff6622"
          intensity={1.5}
          distance={8}
        />
        {/* Log seats around fire */}
        {[0, 1.2, 2.4, 3.6, 4.8].map((a, i) => (
          <mesh
            key={i}
            position={[Math.cos(a) * 1.5, 0.15, Math.sin(a) * 1.5]}
            rotation={[0, a + Math.PI / 2, Math.PI / 2]}
          >
            <cylinderGeometry args={[0.12, 0.1, 0.8, 6]} />
            <meshStandardMaterial color="#5a3a1a" roughness={0.95} />
          </mesh>
        ))}
      </group>

      {/* === TENTS === */}
      {/* Tent 1 - orange */}
      <group position={[-3, 0, 6]} rotation={[0, 0.5, 0]}>
        <mesh position={[0, 0.5, 0]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[1.2, 1.2, 1.6]} />
          <meshStandardMaterial
            color="#dd6622"
            roughness={0.85}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      {/* Tent 2 - green */}
      <group position={[6, 0, 7]} rotation={[0, -0.3, 0]}>
        <mesh position={[0, 0.5, 0]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[1.0, 1.0, 1.4]} />
          <meshStandardMaterial
            color="#338844"
            roughness={0.85}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      {/* Tent 3 - blue */}
      <group position={[-1, 0, 8]} rotation={[0, 0.8, 0]}>
        <mesh position={[0, 0.5, 0]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[1.1, 1.1, 1.5]} />
          <meshStandardMaterial
            color="#3366aa"
            roughness={0.85}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>

      {/* === CLIMBER FIGURES === */}
      {/* Standing climbers around the fire */}
      {[
        { x: 2, z: 3.8, rot: 2.5, shirt: "#cc3333", pants: "#334455" },
        { x: 4.2, z: 4.5, rot: 3.8, shirt: "#3388cc", pants: "#333" },
        { x: 3.8, z: 6.2, rot: 1.2, shirt: "#44aa55", pants: "#445" },
        { x: 1.8, z: 5.8, rot: 0.5, shirt: "#ddaa33", pants: "#444" },
      ].map((c, i) => (
        <group key={i} position={[c.x, 0, c.z]} rotation={[0, c.rot, 0]}>
          {/* Legs */}
          <mesh position={[-0.04, 0.22, 0]}>
            <cylinderGeometry args={[0.025, 0.022, 0.44, 8]} />
            <meshStandardMaterial color={c.pants} roughness={0.7} />
          </mesh>
          <mesh position={[0.04, 0.22, 0]}>
            <cylinderGeometry args={[0.025, 0.022, 0.44, 8]} />
            <meshStandardMaterial color={c.pants} roughness={0.7} />
          </mesh>
          {/* Torso */}
          <mesh position={[0, 0.57, 0]}>
            <cylinderGeometry args={[0.07, 0.08, 0.26, 10]} />
            <meshStandardMaterial color={c.shirt} roughness={0.7} />
          </mesh>
          {/* Head */}
          <mesh position={[0, 0.77, 0]}>
            <sphereGeometry args={[0.06, 10, 10]} />
            <meshStandardMaterial color="#ddbbaa" roughness={0.7} />
          </mesh>
          {/* Beanie */}
          <mesh position={[0, 0.81, 0]}>
            <sphereGeometry
              args={[0.062, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]}
            />
            <meshStandardMaterial
              color={["#1a1a1a", "#cc4422", "#225588", "#333"][i]}
              roughness={0.9}
            />
          </mesh>
          {/* Arms */}
          <mesh position={[-0.1, 0.5, 0.03]} rotation={[0.3, 0, 0.15]}>
            <cylinderGeometry args={[0.018, 0.015, 0.24, 8]} />
            <meshStandardMaterial color="#ddbbaa" roughness={0.7} />
          </mesh>
          <mesh position={[0.1, 0.5, 0.03]} rotation={[0.3, 0, -0.15]}>
            <cylinderGeometry args={[0.018, 0.015, 0.24, 8]} />
            <meshStandardMaterial color="#ddbbaa" roughness={0.7} />
          </mesh>
          {/* Shoes */}
          <mesh position={[-0.04, 0.01, 0.02]}>
            <boxGeometry args={[0.035, 0.02, 0.07]} />
            <meshStandardMaterial color="#333" roughness={0.8} />
          </mesh>
          <mesh position={[0.04, 0.01, 0.02]}>
            <boxGeometry args={[0.035, 0.02, 0.07]} />
            <meshStandardMaterial color="#333" roughness={0.8} />
          </mesh>
        </group>
      ))}

      {/* Sitting climbers on logs */}
      {[
        { x: 3.5, z: 3.5, rot: 3.5, shirt: "#aa3377", pants: "#334" },
        { x: 1.5, z: 5.0, rot: 0.8, shirt: "#5577cc", pants: "#343" },
      ].map((c, i) => (
        <group
          key={`sit${i}`}
          position={[c.x, 0.3, c.z]}
          rotation={[0, c.rot, 0]}
        >
          {/* Torso leaning back slightly */}
          <mesh position={[0, 0.2, 0]} rotation={[-0.15, 0, 0]}>
            <cylinderGeometry args={[0.065, 0.075, 0.24, 10]} />
            <meshStandardMaterial color={c.shirt} roughness={0.7} />
          </mesh>
          {/* Head */}
          <mesh position={[0, 0.38, -0.02]}>
            <sphereGeometry args={[0.055, 10, 10]} />
            <meshStandardMaterial color="#ddbbaa" roughness={0.7} />
          </mesh>
          {/* Beanie */}
          <mesh position={[0, 0.42, -0.02]}>
            <sphereGeometry
              args={[0.058, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]}
            />
            <meshStandardMaterial
              color={["#992266", "#226699"][i]}
              roughness={0.9}
            />
          </mesh>
          {/* Thighs out front */}
          <mesh
            position={[-0.04, 0.04, 0.1]}
            rotation={[Math.PI / 2.5, 0, 0.1]}
          >
            <cylinderGeometry args={[0.025, 0.022, 0.2, 8]} />
            <meshStandardMaterial color={c.pants} roughness={0.7} />
          </mesh>
          <mesh
            position={[0.04, 0.04, 0.1]}
            rotation={[Math.PI / 2.5, 0, -0.1]}
          >
            <cylinderGeometry args={[0.025, 0.022, 0.2, 8]} />
            <meshStandardMaterial color={c.pants} roughness={0.7} />
          </mesh>
        </group>
      ))}

      {/* Crash pads leaning against shop */}
      <mesh position={[-2.1, 0.4, 1.5]} rotation={[0, 0, 0.15]}>
        <boxGeometry args={[0.15, 0.8, 1.2]} />
        <meshStandardMaterial color="#2266aa" roughness={0.8} />
      </mesh>
      <mesh position={[-2.2, 0.4, 1.0]} rotation={[0, 0.2, 0.2]}>
        <boxGeometry args={[0.12, 0.7, 1.1]} />
        <meshStandardMaterial color="#aa3333" roughness={0.8} />
      </mesh>

      {/* Chalk bucket */}
      <mesh position={[2.8, 0.12, 3.5]}>
        <cylinderGeometry args={[0.1, 0.08, 0.24, 10]} />
        <meshStandardMaterial color="#ddd" roughness={0.6} />
      </mesh>
      {/* Chalk dust on top */}
      <mesh position={[2.8, 0.25, 3.5]}>
        <sphereGeometry args={[0.09, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#f0f0f0" roughness={1} />
      </mesh>

      {/* Water bottles */}
      {[
        { x: 1.6, z: 4.3 },
        { x: 4.0, z: 5.5 },
      ].map((b, i) => (
        <mesh key={i} position={[b.x, 0.12, b.z]}>
          <cylinderGeometry args={[0.03, 0.03, 0.22, 8]} />
          <meshStandardMaterial
            color={["#44aadd", "#33cc66"][i]}
            roughness={0.4}
            metalness={0.2}
          />
        </mesh>
      ))}

      {/* Guidebook on ground */}
      <mesh position={[2.2, 0.02, 5.2]} rotation={[-Math.PI / 2, 0, 0.3]}>
        <boxGeometry args={[0.2, 0.28, 0.02]} />
        <meshStandardMaterial color="#cc8833" roughness={0.8} />
      </mesh>
    </group>
  );
}

// Shared explorer position for camera and dog to read
const explorerPos = { x: 0, z: 3, facing: 0 };

// Shared key set — both keyboard and mobile touch controls write here
export const explorerKeys = new Set<string>();

// === EXPLORING CLIMBER ===
// Walking climber with backpack, controlled by arrow keys / WASD
function ExploringClimber({ scale }: { scale: number }) {
  const s = scale;
  const groupRef = useRef<THREE.Group>(null);
  const posRef = useRef({ x: 0, z: 3 });
  const facingRef = useRef(0); // radians, 0 = facing -Z (toward wall)
  const walkPhaseRef = useRef(0);
  const isMovingRef = useRef(false);

  // Limb refs for animation
  const leftArmRef = useRef<THREE.Mesh>(null);
  const rightArmRef = useRef<THREE.Group>(null);
  const leftLegRef = useRef<THREE.Group>(null);
  const rightLegRef = useRef<THREE.Group>(null);
  const smokingRef = useRef(0); // 0 = not smoking, ramps to 1
  const jointRef = useRef<THREE.Group>(null);

  // Keyboard listeners — write to shared explorerKeys
  useEffect(() => {
    const down = (e: KeyboardEvent) => explorerKeys.add(e.key.toLowerCase());
    const up = (e: KeyboardEvent) => explorerKeys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      explorerKeys.clear();
    };
  }, []);

  useFrame((_, delta) => {
    const moveSpeed = 4.5;
    const turnSpeed = 3.5;
    const keys = explorerKeys;

    // A/D or Left/Right = turn
    if (keys.has("a") || keys.has("arrowleft"))
      facingRef.current += turnSpeed * delta;
    if (keys.has("d") || keys.has("arrowright"))
      facingRef.current -= turnSpeed * delta;

    // W/Up = forward, S/Down = backward (relative to facing)
    let forward = 0;
    if (keys.has("w") || keys.has("arrowup")) forward = 1;
    if (keys.has("s") || keys.has("arrowdown")) forward = -1;

    const moving = forward !== 0;
    isMovingRef.current = moving;

    if (moving) {
      const dx = Math.sin(facingRef.current) * forward;
      const dz = Math.cos(facingRef.current) * forward;
      posRef.current.x += dx * moveSpeed * delta;
      posRef.current.z += dz * moveSpeed * delta;
      posRef.current.x = Math.max(-55, Math.min(30, posRef.current.x));
      posRef.current.z = Math.max(-15, Math.min(25, posRef.current.z));
      walkPhaseRef.current += delta * 8;
    }

    // Write to shared position
    explorerPos.x = posRef.current.x;
    explorerPos.z = posRef.current.z;
    explorerPos.facing = facingRef.current;

    if (groupRef.current) {
      groupRef.current.position.x = posRef.current.x;
      groupRef.current.position.z = posRef.current.z;
      groupRef.current.rotation.y = facingRef.current;
    }

    // Smoking
    const isSmoking = keys.has(" ");
    smokingRef.current += (isSmoking ? 3 : -3) * delta;
    smokingRef.current = Math.max(0, Math.min(1, smokingRef.current));
    const smokeT = smokingRef.current;

    // Walk animation (suppressed while smoking)
    const swing =
      moving && smokeT < 0.3 ? Math.sin(walkPhaseRef.current) * 0.6 : 0;
    if (leftArmRef.current) leftArmRef.current.rotation.x = swing;
    // Right arm: blend between walk swing and raised-to-mouth
    if (rightArmRef.current) {
      const walkRot = -swing;
      const smokeRot = -1.8; // raised to mouth
      rightArmRef.current.rotation.x = walkRot + (smokeRot - walkRot) * smokeT;
      rightArmRef.current.rotation.z = -0.3 * smokeT; // bring inward
    }
    if (jointRef.current) jointRef.current.visible = smokeT > 0.01;
    if (leftLegRef.current) leftLegRef.current.rotation.x = -swing * 0.7;
    if (rightLegRef.current) rightLegRef.current.rotation.x = swing * 0.7;
  });

  const skinColor = "#ddbbaa";
  const torsoColor = "#5588aa";
  const legColor = "#445566";
  const shoeColor = "#334455";
  const headR = 0.065 * s;
  const torsoH = 0.26 * s;
  const torsoW = 0.09 * s;
  const upperArmL = 0.14 * s;
  const forearmL = 0.12 * s;
  const thighL = 0.22 * s;
  const shinL = 0.2 * s;
  const pelvisY = thighL + shinL + 0.02 * s;
  const chestY = pelvisY + torsoH;
  const headY = chestY + 0.08 * s + headR;
  const shoulderW = torsoW * 1.2;
  const backpackColor = "#6b4226";
  const backpackAccent = "#8b5e3c";

  return (
    <group ref={groupRef} position={[0, 0, 3]}>
      {/* Head */}
      <mesh position={[0, headY, 0]}>
        <sphereGeometry args={[headR, 12, 12]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Beanie */}
      <mesh position={[0, headY + headR * 0.35, 0]}>
        <sphereGeometry
          args={[headR * 1.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]}
        />
        <meshStandardMaterial color="#cc4422" roughness={0.9} />
      </mesh>
      <mesh position={[0, headY + headR * 0.2, 0]}>
        <cylinderGeometry
          args={[headR * 1.07, headR * 1.09, headR * 0.18, 14]}
        />
        <meshStandardMaterial color="#aa3318" roughness={0.85} />
      </mesh>

      {/* Torso */}
      <mesh position={[0, pelvisY + torsoH * 0.5, 0]}>
        <cylinderGeometry args={[torsoW * 0.85, torsoW, torsoH, 10]} />
        <meshStandardMaterial color={torsoColor} roughness={0.7} />
      </mesh>

      {/* === BACKPACK === */}
      {/* Main pack body */}
      <mesh position={[0, pelvisY + torsoH * 0.55, -torsoW * 1.4]}>
        <boxGeometry args={[torsoW * 2, torsoH * 0.9, torsoW * 1.2]} />
        <meshStandardMaterial color={backpackColor} roughness={0.85} />
      </mesh>
      {/* Top flap */}
      <mesh position={[0, pelvisY + torsoH * 1.05, -torsoW * 1.3]}>
        <boxGeometry args={[torsoW * 2.1, torsoH * 0.15, torsoW * 1.4]} />
        <meshStandardMaterial color={backpackAccent} roughness={0.8} />
      </mesh>
      {/* Front pocket */}
      <mesh position={[0, pelvisY + torsoH * 0.3, -torsoW * 2.05]}>
        <boxGeometry args={[torsoW * 1.6, torsoH * 0.45, torsoW * 0.15]} />
        <meshStandardMaterial color={backpackAccent} roughness={0.85} />
      </mesh>
      {/* Straps (left) */}
      <mesh position={[-torsoW * 0.7, pelvisY + torsoH * 0.6, -torsoW * 0.4]}>
        <boxGeometry args={[torsoW * 0.2, torsoH * 0.85, torsoW * 0.15]} />
        <meshStandardMaterial color="#444" roughness={0.9} />
      </mesh>
      {/* Straps (right) */}
      <mesh position={[torsoW * 0.7, pelvisY + torsoH * 0.6, -torsoW * 0.4]}>
        <boxGeometry args={[torsoW * 0.2, torsoH * 0.85, torsoW * 0.15]} />
        <meshStandardMaterial color="#444" roughness={0.9} />
      </mesh>
      {/* Rope coil on top */}
      <mesh
        position={[0, pelvisY + torsoH * 1.2, -torsoW * 1.5]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <torusGeometry args={[torsoW * 0.5, torsoW * 0.12, 8, 16]} />
        <meshStandardMaterial color="#e8d44d" roughness={0.7} />
      </mesh>
      {/* Carabiner dangling */}
      <mesh
        position={[torsoW * 0.9, pelvisY + torsoH * 0.2, -torsoW * 1.6]}
        rotation={[0, 0, 0.3]}
      >
        <torusGeometry args={[0.015 * s, 0.003 * s, 6, 12]} />
        <meshStandardMaterial color="#c0c0c0" metalness={0.8} roughness={0.2} />
      </mesh>

      {/* Left arm */}
      <mesh ref={leftArmRef} position={[-shoulderW, chestY - 0.02 * s, 0]}>
        <cylinderGeometry
          args={[0.018 * s, 0.015 * s, upperArmL + forearmL, 8]}
        />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      {/* Right arm — pivots at shoulder for smoking */}
      <group ref={rightArmRef} position={[shoulderW, chestY - 0.02 * s, 0]}>
        {/* Arm */}
        <mesh>
          <cylinderGeometry
            args={[0.018 * s, 0.015 * s, upperArmL + forearmL, 8]}
          />
          <meshStandardMaterial color={skinColor} roughness={0.7} />
        </mesh>
        {/* Hand */}
        <mesh position={[0, -(upperArmL + forearmL) * 0.5, 0.01 * s]}>
          <sphereGeometry args={[0.018 * s, 8, 8]} />
          <meshStandardMaterial color={skinColor} roughness={0.7} />
        </mesh>
        {/* Joint + cherry + smoke — only visible when smoking */}
        <group ref={jointRef} visible={false}>
          <mesh
            position={[
              0.01 * s,
              -(upperArmL + forearmL) * 0.5 - 0.01 * s,
              0.02 * s,
            ]}
            rotation={[0.3, 0, 0.8]}
          >
            <cylinderGeometry args={[0.003 * s, 0.004 * s, 0.05 * s, 6]} />
            <meshStandardMaterial color="#f5f0e0" roughness={0.9} />
          </mesh>
          <mesh
            position={[
              0.025 * s,
              -(upperArmL + forearmL) * 0.5 - 0.02 * s,
              0.03 * s,
            ]}
          >
            <sphereGeometry args={[0.005 * s, 6, 6]} />
            <meshStandardMaterial
              color="#ff4400"
              emissive="#ff2200"
              emissiveIntensity={1.5}
            />
          </mesh>
          <SmokePuffs
            origin={[
              0.025 * s,
              -(upperArmL + forearmL) * 0.5 - 0.01 * s,
              0.03 * s,
            ]}
            scale={s}
          />
        </group>
      </group>

      {/* Left leg */}
      <group ref={leftLegRef} position={[-0.04 * s, pelvisY, 0]}>
        <mesh position={[0, -thighL * 0.5, 0]}>
          <cylinderGeometry args={[0.025 * s, 0.022 * s, thighL, 8]} />
          <meshStandardMaterial color={legColor} roughness={0.7} />
        </mesh>
        <mesh position={[0, -thighL - shinL * 0.5, 0]}>
          <cylinderGeometry args={[0.022 * s, 0.018 * s, shinL, 8]} />
          <meshStandardMaterial color={legColor} roughness={0.7} />
        </mesh>
        <mesh position={[0, -thighL - shinL, 0.02 * s]}>
          <boxGeometry args={[0.035 * s, 0.025 * s, 0.08 * s]} />
          <meshStandardMaterial color={shoeColor} roughness={0.8} />
        </mesh>
      </group>

      {/* Right leg */}
      <group ref={rightLegRef} position={[0.04 * s, pelvisY, 0]}>
        <mesh position={[0, -thighL * 0.5, 0]}>
          <cylinderGeometry args={[0.025 * s, 0.022 * s, thighL, 8]} />
          <meshStandardMaterial color={legColor} roughness={0.7} />
        </mesh>
        <mesh position={[0, -thighL - shinL * 0.5, 0]}>
          <cylinderGeometry args={[0.022 * s, 0.018 * s, shinL, 8]} />
          <meshStandardMaterial color={legColor} roughness={0.7} />
        </mesh>
        <mesh position={[0, -thighL - shinL, 0.02 * s]}>
          <boxGeometry args={[0.035 * s, 0.025 * s, 0.08 * s]} />
          <meshStandardMaterial color={shoeColor} roughness={0.8} />
        </mesh>
      </group>
    </group>
  );
}

// Camera follower for explore mode
function ExploreCamera() {
  useFrame((state) => {
    // 3rd person: camera behind the player based on facing direction
    const facing = explorerPos.facing;
    const camDist = 4;
    const camHeight = 2.2;
    // "Behind" means opposite of facing direction
    const behindX = -Math.sin(facing) * camDist;
    const behindZ = -Math.cos(facing) * camDist;
    const camTarget = new THREE.Vector3(explorerPos.x, 0.8, explorerPos.z);
    const camPos = new THREE.Vector3(
      explorerPos.x + behindX,
      camHeight,
      explorerPos.z + behindZ,
    );
    state.camera.position.lerp(camPos, 0.06);
    state.camera.lookAt(camTarget);
  });
  return null;
}

export default function ClimbingScene({
  config,
  placedHolds = [],
  wallSegments = [{ height: 4, angleDeg: 0 }],
  onWallClick,
  onHoldClick,
  placingMode = false,
  eraserMode = false,
  ragdollParts,
  sittingOnGround = false,
  toppedOut = false,
  isExploring = false,
}: {
  config: ClimberConfig;
  placedHolds?: PlacedHold[];
  wallSegments?: WallSegment[];
  onWallClick?: (x: number, y: number) => void;
  onHoldClick?: (id: string) => void;
  placingMode?: boolean;
  eraserMode?: boolean;
  ragdollParts?: RagdollPart[];
  sittingOnGround?: boolean;
  toppedOut?: boolean;
  isExploring?: boolean;
}) {
  const forces = useMemo(() => computeForces(config), [config]);
  return (
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
        camera={{ position: [4, 3, 8], fov: 50 }}
        style={{ background: "#1a1a2e" }}
      >
        <Sky
          sunPosition={[100, 60, -50]}
          turbidity={6}
          rayleigh={0.5}
          mieCoefficient={0.005}
          mieDirectionalG={0.8}
        />
        {/* Sun disc */}
        <mesh position={[100, 60, -50]}>
          <sphereGeometry args={[5, 16, 16]} />
          <meshBasicMaterial color="#fff8e0" />
        </mesh>
        <ambientLight intensity={0.6} />
        <directionalLight
          position={[100, 60, -50]}
          intensity={0.9}
          castShadow
        />
        <pointLight position={[-2, 3, 3]} intensity={0.3} />
        <fog attach="fog" args={["#7a8fa6", 20, 70]} />
        <Mountains />
        <River />
        <DeerHerd />
        <Rocks />
        <Tent />
        <Campfire />
        <CragDog isExploring={isExploring} />
        <ClimbingShop />
        <Birds />
        <Wall
          segments={wallSegments}
          onWallClick={onWallClick}
          placingMode={placingMode}
        />
        <PlacedHoldsGroup
          holds={placedHolds}
          segments={wallSegments}
          onHoldClick={onHoldClick}
          eraserMode={eraserMode}
        />
        {isExploring ? (
          <ExploringClimber scale={config.heightFt / 5.75} />
        ) : ragdollParts ? (
          <RagdollClimber parts={ragdollParts} />
        ) : sittingOnGround ? (
          <SittingClimber scale={config.heightFt / 5.75} />
        ) : toppedOut ? (
          <ToppingOutClimber
            scale={config.heightFt / 5.75}
            wallAngleDeg={config.wallAngleDeg}
            segments={wallSegments}
          />
        ) : (
          <Climber config={config} forces={forces} segments={wallSegments} />
        )}
        {isExploring ? (
          <ExploreCamera />
        ) : (
          <OrbitControls
            makeDefault
            minDistance={2}
            maxDistance={20}
            target={[0, 1.5, 0.5]}
          />
        )}
        <gridHelper args={[10, 20, "#333333", "#222222"]} />
      </Canvas>
    </div>
  );
}
