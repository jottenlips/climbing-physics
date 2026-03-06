import { useMemo, useState, useCallback } from "react";
import ClimbingScene from "./components/ClimbingScene";
import ForcePanel from "./components/ForcePanel";
import { ClimberConfig, PullDirection, computeForces } from "./physics/climbingPhysics";

interface ClimberState {
  bodyWeightKg: number;
  gripStrengthKg: number;
  heightFt: number;
  apeIndexIn: number; // wingspan in inches, typically equal to height
  bodyRotationDeg: number; // body twist on wall: 0=facing out, +=right shoulder up, -=left shoulder up
  wallAngleDeg: number;
  leftHandPull: PullDirection;
  rightHandPull: PullDirection;
  leftKneeTurnDeg: number; // -90 (drop knee inward) to +90 (frog outward)
  rightKneeTurnDeg: number;
  hipOffset: number; // 0 = hips pressed to wall, 1 = fully extended
  torsoOffset: number; // 0 = torso pressed to wall, 1 = fully extended
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

// Compute comfortable default limb positions for a given wall angle.
// Arms default to STRAIGHT (hands high, full extension) — this is
// the most efficient climbing position, minimizing grip fatigue.
function comfortablePose(angleDeg: number) {
  const t = Math.max(0, angleDeg) / 90; // 0 = vertical, 1 = roof
  const slab = Math.max(0, -angleDeg) / 30; // 0 = vertical, 1 = max slab

  // Hands: high up for straight arms. On steeper walls, slightly closer together.
  const handSpreadX = 0.18 + t * 0.08;
  const handY = 2.6 - t * 0.2 + slab * 0.1; // high = straight arms

  // Feet: hip-width apart, lower on wall for full arm extension.
  // On steeper walls, feet come up higher (bunched for toe hooks).
  const footSpreadX = 0.12 + t * 0.06;
  const footY = 1.0 + t * 0.4 - slab * 0.15;

  return {
    lhX: -handSpreadX,
    lhY: handY,
    rhX: handSpreadX,
    rhY: handY + 0.05,
    lfX: -footSpreadX,
    lfY: footY,
    rfX: footSpreadX,
    rfY: footY - 0.05,
  };
}

type PresetAngles = Record<string, number>;
const PRESET_ANGLES: PresetAngles = {
  "Slab": -15,
  "Vertical": 0,
  "15 Overhang": 15,
  "30 Overhang": 30,
  "45 Steep": 45,
  "Roof": 80,
};

// Twist presets include body rotation + knee positions for realistic technique
const TWIST_PRESETS: Record<string, { twist: number; lKnee: number; rKnee: number }> = {
  "Square":       { twist: 0,   lKnee: 0,   rKnee: 0 },
  "R Drop Knee":  { twist: 40,  lKnee: 0,   rKnee: -70 }, // right knee turns inward
  "L Drop Knee":  { twist: -40, lKnee: -70, rKnee: 0 },   // left knee turns inward
  "R Flag":       { twist: 25,  lKnee: 0,   rKnee: 50 },  // right leg extends out
  "L Flag":       { twist: -25, lKnee: 50,  rKnee: 0 },
  "R Back Flag":  { twist: 30,  lKnee: 0,   rKnee: -90 }, // right leg crosses behind
  "L Back Flag":  { twist: -30, lKnee: -90, rKnee: 0 },
};

const PULL_OPTIONS: PullDirection[] = ["down", "side", "undercling", "gaston", "sloper"];

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
      <label style={{ width: 90, fontSize: 10, color: "#aaa", flexShrink: 0 }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: "#4488ff", height: 20, touchAction: "manipulation" }}
      />
      <span style={{ width: 45, fontSize: 10, textAlign: "right", color: "#ccc", flexShrink: 0 }}>
        {value.toFixed(step < 1 ? 2 : 0)}{suffix ?? ""}
      </span>
    </div>
  );
}

const DEFAULT_STATE: ClimberState = {
  bodyWeightKg: 70,
  gripStrengthKg: 45,
  heightFt: 5.75, // 5'9"
  apeIndexIn: 69, // 5'9" = 69 inches (neutral ape index)
  bodyRotationDeg: 0,
  wallAngleDeg: 45,
  leftHandPull: "down",
  rightHandPull: "down",
  leftKneeTurnDeg: 0,
  rightKneeTurnDeg: 0,
  hipOffset: 0.15,
  torsoOffset: 0.65,
  leftHandOn: true,
  rightHandOn: true,
  leftFootOn: true,
  rightFootOn: true,
  ...comfortablePose(45),
};

function App() {
  const [state, setState] = useState<ClimberState>(DEFAULT_STATE);
  const [activePreset, setActivePreset] = useState("45 Steep");
  const [activeTwist, setActiveTwist] = useState("Square");
  const [showControls, setShowControls] = useState(true);
  const [showForces, setShowForces] = useState(true);
  const [showPresets, setShowPresets] = useState(true);
  const [showInfo, setShowInfo] = useState(true);

  const set = useCallback(
    (key: keyof ClimberState, value: number | string) => {
      setState((s) => {
        const next = { ...s, [key]: value };

        // When hip distance changes, auto-raise feet if they'd be out of leg reach.
        // Leg reach is in 3D: hip joint is hipOffset distance from wall, feet are on wall plane.
        if (key === "hipOffset" || key === "torsoOffset") {
          const heightM = next.heightFt * 0.3048;
          const sc = heightM; // body scale
          const legReach = (0.52 + 0.40 + 0.08) * sc * 0.95; // thigh+shin+foot, slight margin
          const bodyOffMax = 1.0 * sc;
          const hipOff = 0.04 * sc + next.hipOffset * (bodyOffMax - 0.04 * sc);
          // For each foot: check if 3D distance from hip to foot exceeds leg reach
          const hipW = 0.085 * sc;
          // Approximate CoG Y from limb positions
          const cogYActual = (next.lhY + next.rhY) / 2 * 0.3 + (next.lfY + next.rfY) / 2 * 0.7;
          const hipY = cogYActual; // pelvis height

          const isOverhang = next.wallAngleDeg > 0;
          const isSlab = next.wallAngleDeg <= 0;

          // On slab: clamp hip offset so feet can always reach the wall
          if (isSlab) {
            const maxHipOff = legReach * 0.9; // leave margin for vertical span
            const maxHipOffset = Math.max(0, (maxHipOff - 0.04 * sc) / (bodyOffMax - 0.04 * sc));
            if (next.hipOffset > maxHipOffset) {
              next.hipOffset = maxHipOffset;
            }
            // Recalculate after clamping
            const clampedHipOff = 0.04 * sc + next.hipOffset * (bodyOffMax - 0.04 * sc);

            // Still raise feet if needed
            for (const foot of ["lf", "rf"] as const) {
              const fx = foot === "lf" ? next.lfX : next.rfX;
              const fy = foot === "lf" ? next.lfY : next.rfY;
              const hx = foot === "lf" ? -hipW : hipW;
              const dx = fx - hx;
              const dy = fy - hipY;
              const dist = Math.sqrt(dx * dx + dy * dy + clampedHipOff * clampedHipOff);
              if (dist > legReach) {
                const maxDySq = legReach * legReach - dx * dx - clampedHipOff * clampedHipOff;
                const maxDy = maxDySq > 0 ? Math.sqrt(maxDySq) : 0;
                const newFy = hipY - maxDy;
                if (foot === "lf") next.lfY = Math.max(newFy, fy);
                else next.rfY = Math.max(newFy, fy);
              }
            }
          } else {
            // Overhang / vertical
            for (const foot of ["lf", "rf"] as const) {
              const fx = foot === "lf" ? next.lfX : next.rfX;
              const fy = foot === "lf" ? next.lfY : next.rfY;
              const hx = foot === "lf" ? -hipW : hipW;
              const dx = fx - hx;
              const dy = fy - hipY;
              const dist = Math.sqrt(dx * dx + dy * dy + hipOff * hipOff);
              if (dist > legReach) {
                const minDist = Math.sqrt(dx * dx + hipOff * hipOff);
                if (minDist > legReach && isOverhang) {
                  if (foot === "lf") next.leftFootOn = false;
                  else next.rightFootOn = false;
                } else {
                  const maxDySq = legReach * legReach - dx * dx - hipOff * hipOff;
                  const maxDy = maxDySq > 0 ? Math.sqrt(maxDySq) : 0;
                  const newFy = hipY - maxDy;
                  if (foot === "lf") next.lfY = Math.max(newFy, fy);
                  else next.rfY = Math.max(newFy, fy);
                }
              }
            }
          }
        }

        return next;
      });
      setActivePreset("");
      if (key === "bodyRotationDeg") setActiveTwist("");
    },
    []
  );

  const applyPreset = useCallback((name: string) => {
    const angleDeg = PRESET_ANGLES[name];
    setState((prev) => ({
      ...prev,
      wallAngleDeg: angleDeg,
      ...comfortablePose(angleDeg),
      // Force feet back on when switching to slab/vertical
      ...(angleDeg <= 0 ? { leftFootOn: true, rightFootOn: true } : {}),
    }));
    setActivePreset(name);
  }, []);

  const applyTwist = useCallback((name: string) => {
    const p = TWIST_PRESETS[name];
    setState((prev) => ({
      ...prev,
      bodyRotationDeg: p.twist,
      leftKneeTurnDeg: p.lKnee,
      rightKneeTurnDeg: p.rKnee,
    }));
    setActiveTwist(name);
  }, []);

  const config: ClimberConfig = useMemo(
    () => ({
      bodyWeightKg: state.bodyWeightKg,
      gripStrengthKg: state.gripStrengthKg,
      heightFt: state.heightFt,
      apeIndexIn: state.apeIndexIn,
      bodyRotationDeg: state.bodyRotationDeg,
      wallAngleDeg: state.wallAngleDeg,
      leftHandPull: state.leftHandPull,
      rightHandPull: state.rightHandPull,
      leftKneeTurnDeg: state.leftKneeTurnDeg,
      rightKneeTurnDeg: state.rightKneeTurnDeg,
      hipOffset: state.hipOffset,
      torsoOffset: state.torsoOffset,
      leftHandOn: state.leftHandOn,
      rightHandOn: state.rightHandOn,
      leftFootOn: state.leftFootOn,
      rightFootOn: state.rightFootOn,
      leftHand: { x: state.lhX, y: state.lhY },
      rightHand: { x: state.rhX, y: state.rhY },
      leftFoot: { x: state.lfX, y: state.lfY },
      rightFoot: { x: state.rfX, y: state.rfY },
      centerOfGravity: {
        x: (state.lhX + state.rhX + state.lfX + state.rfX) / 4,
        y: (state.lhY + state.rhY + state.lfY + state.rfY) / 4 - 0.1,
      },
    }),
    [state]
  );

  const forces = useMemo(() => computeForces(config), [config]);

  const heightCm = (state.heightFt * 30.48).toFixed(0);

  const toggleAll = useCallback(() => {
    const allHidden = !showControls && !showForces && !showPresets && !showInfo;
    setShowControls(allHidden);
    setShowForces(allHidden);
    setShowPresets(allHidden);
    setShowInfo(allHidden);
  }, [showControls, showForces, showPresets, showInfo]);

  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 8px",
    background: active ? "rgba(68,136,255,0.8)" : "rgba(50,50,50,0.8)",
    color: "#fff",
    border: "1px solid #555",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "monospace",
    touchAction: "manipulation",
  });

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>
      {/* Toggle bar — always visible */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 20,
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        <button style={toggleBtnStyle(showPresets)} onClick={() => setShowPresets(!showPresets)}>Presets</button>
        <button style={toggleBtnStyle(showControls)} onClick={() => setShowControls(!showControls)}>Controls</button>
        <button style={toggleBtnStyle(showForces)} onClick={() => setShowForces(!showForces)}>Forces</button>
        <button style={toggleBtnStyle(showInfo)} onClick={() => setShowInfo(!showInfo)}>Info</button>
        <button style={{ ...toggleBtnStyle(false), background: "rgba(80,40,40,0.8)" }} onClick={toggleAll}>
          {(!showControls && !showForces && !showPresets && !showInfo) ? "Show All" : "Hide All"}
        </button>
      </div>

      {/* Preset buttons */}
      {showPresets && (
        <div
          style={{
            position: "absolute",
            top: 40,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: "calc(100vw - 24px)",
          }}
        >
          {Object.keys(PRESET_ANGLES).map((name) => (
            <button
              key={name}
              onClick={() => applyPreset(name)}
              style={{
                padding: "5px 10px",
                background: activePreset === name ? "#4488ff" : "rgba(50,50,50,0.9)",
                color: "#fff",
                border: "1px solid #555",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 11,
                fontFamily: "monospace",
                touchAction: "manipulation",
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Controls panel */}
      {showControls && (
        <div
          style={{
            position: "absolute",
            top: showPresets ? 80 : 40,
            left: 8,
            background: "rgba(0,0,0,0.88)",
            color: "#eee",
            padding: "10px 12px",
            borderRadius: 8,
            width: "min(280px, calc(100vw - 16px))",
            fontFamily: "monospace",
            fontSize: 11,
            zIndex: 10,
            maxHeight: "calc(100vh - 100px)",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <h4 style={{ margin: 0, color: "#4488ff", fontSize: 13 }}>Climber</h4>
            <button
              onClick={() => { setState(DEFAULT_STATE); setActivePreset("45 Steep"); setActiveTwist("Square"); }}
              style={{ padding: "3px 10px", fontSize: 10, background: "#333", color: "#ccc", border: "1px solid #555", borderRadius: 4, cursor: "pointer", touchAction: "manipulation" }}
            >
              Reset
            </button>
          </div>
          <Slider label="Weight (kg)" value={state.bodyWeightKg} min={30} max={120} step={1} onChange={(v) => set("bodyWeightKg", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {(state.bodyWeightKg * 2.20462).toFixed(0)} lbs
          </div>
          <Slider label="Grip (kg)" value={state.gripStrengthKg} min={10} max={100} step={1} onChange={(v) => set("gripStrengthKg", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {(state.gripStrengthKg * 2.20462).toFixed(0)} lbs
          </div>
          <Slider label="Height (ft)" value={state.heightFt} min={4.5} max={7} step={0.08333} onChange={(v) => set("heightFt", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {feetToFtIn(state.heightFt)} / {heightCm}cm
          </div>
          <Slider label="Ape Index (in)" value={state.apeIndexIn} min={54} max={84} step={0.5} onChange={(v) => set("apeIndexIn", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {feetToFtIn(state.apeIndexIn / 12)} span | {state.apeIndexIn > state.heightFt * 12 ? "+" : ""}{(state.apeIndexIn - state.heightFt * 12).toFixed(1)}" vs height
          </div>

          <Slider label="Body Twist" value={state.bodyRotationDeg} min={-90} max={90} step={1} onChange={(v) => set("bodyRotationDeg", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {state.bodyRotationDeg === 0 ? "facing out" : state.bodyRotationDeg > 0 ? `R drop knee ${state.bodyRotationDeg}°` : `L drop knee ${Math.abs(state.bodyRotationDeg)}°`}
          </div>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 6 }}>
            {Object.keys(TWIST_PRESETS).map((name) => (
              <button
                key={name}
                onClick={() => applyTwist(name)}
                style={{
                  padding: "3px 6px",
                  background: activeTwist === name ? "#4488ff" : "rgba(60,60,60,0.9)",
                  color: "#fff",
                  border: "1px solid #555",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontSize: 9,
                  fontFamily: "monospace",
                  touchAction: "manipulation",
                }}
              >
                {name}
              </button>
            ))}
          </div>

          <Slider label="Hip Distance" value={state.hipOffset} min={0} max={1} step={0.05} onChange={(v) => set("hipOffset", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {state.hipOffset < 0.2 ? "pressed in" : state.hipOffset < 0.5 ? "close" : state.hipOffset < 0.8 ? "normal" : "extended"}
          </div>
          <Slider label="Torso Distance" value={state.torsoOffset} min={0} max={1} step={0.05} onChange={(v) => set("torsoOffset", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {state.torsoOffset < 0.2 ? "pressed in" : state.torsoOffset < 0.5 ? "close" : state.torsoOffset < 0.8 ? "normal" : "extended"}
          </div>

          <h4 style={{ margin: "8px 0 6px", color: "#4488ff", fontSize: 12 }}>Wall</h4>
          <Slider label="Angle (deg)" value={state.wallAngleDeg} min={-30} max={90} step={1} onChange={(v) => set("wallAngleDeg", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {state.wallAngleDeg > 0 ? "overhang" : state.wallAngleDeg < 0 ? "slab" : "vertical"}
          </div>

          <h4 style={{ margin: "8px 0 6px", color: "#ff6644", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            Left Hand
            <button
              onClick={() => setState((s) => ({ ...s, leftHandOn: !s.leftHandOn }))}
              style={{ padding: "2px 8px", background: state.leftHandOn ? "#44aa44" : "#aa4444", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "monospace", touchAction: "manipulation" }}
            >{state.leftHandOn ? "ON" : "OFF"}</button>
          </h4>
          {state.leftHandOn && <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <label style={{ width: 90, fontSize: 10, color: "#aaa" }}>Pull Dir</label>
              <select
                value={state.leftHandPull}
                onChange={(e) => set("leftHandPull", e.target.value)}
                style={{ flex: 1, background: "#333", color: "#eee", border: "1px solid #555", borderRadius: 3, padding: "2px 4px", fontSize: 11, fontFamily: "monospace" }}
              >
                {PULL_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <Slider label="X" value={state.lhX} min={-1} max={1} step={0.05} onChange={(v) => set("lhX", v)} />
            <Slider label="Y" value={state.lhY} min={0} max={3} step={0.05} onChange={(v) => set("lhY", v)} />
          </>}

          <h4 style={{ margin: "8px 0 6px", color: "#ff6644", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            Right Hand
            <button
              onClick={() => setState((s) => ({ ...s, rightHandOn: !s.rightHandOn }))}
              style={{ padding: "2px 8px", background: state.rightHandOn ? "#44aa44" : "#aa4444", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "monospace", touchAction: "manipulation" }}
            >{state.rightHandOn ? "ON" : "OFF"}</button>
          </h4>
          {state.rightHandOn && <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <label style={{ width: 90, fontSize: 10, color: "#aaa" }}>Pull Dir</label>
              <select
                value={state.rightHandPull}
                onChange={(e) => set("rightHandPull", e.target.value)}
                style={{ flex: 1, background: "#333", color: "#eee", border: "1px solid #555", borderRadius: 3, padding: "2px 4px", fontSize: 11, fontFamily: "monospace" }}
              >
                {PULL_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <Slider label="X" value={state.rhX} min={-1} max={1} step={0.05} onChange={(v) => set("rhX", v)} />
            <Slider label="Y" value={state.rhY} min={0} max={3} step={0.05} onChange={(v) => set("rhY", v)} />
          </>}

          <h4 style={{ margin: "8px 0 6px", color: "#4488ff", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            Left Leg
            {state.wallAngleDeg > 0 && <button
              onClick={() => setState((s) => ({ ...s, leftFootOn: !s.leftFootOn }))}
              style={{ padding: "2px 8px", background: state.leftFootOn ? "#44aa44" : "#aa4444", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "monospace", touchAction: "manipulation" }}
            >{state.leftFootOn ? "ON" : "CUT"}</button>}
          </h4>
          {state.leftFootOn && <>
            <Slider label="Foot X" value={state.lfX} min={-1} max={1} step={0.05} onChange={(v) => set("lfX", v)} />
            <Slider label="Foot Y" value={state.lfY} min={0} max={2} step={0.05} onChange={(v) => set("lfY", v)} />
          </>}
          <Slider label="Knee Turn" value={state.leftKneeTurnDeg} min={-90} max={90} step={1} onChange={(v) => set("leftKneeTurnDeg", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {state.leftKneeTurnDeg === 0 ? "neutral" : state.leftKneeTurnDeg < 0 ? `drop knee ${Math.abs(state.leftKneeTurnDeg)}°` : `frog ${state.leftKneeTurnDeg}°`}
          </div>

          <h4 style={{ margin: "8px 0 6px", color: "#4488ff", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            Right Leg
            {state.wallAngleDeg > 0 && <button
              onClick={() => setState((s) => ({ ...s, rightFootOn: !s.rightFootOn }))}
              style={{ padding: "2px 8px", background: state.rightFootOn ? "#44aa44" : "#aa4444", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "monospace", touchAction: "manipulation" }}
            >{state.rightFootOn ? "ON" : "CUT"}</button>}
          </h4>
          {state.rightFootOn && <>
            <Slider label="Foot X" value={state.rfX} min={-1} max={1} step={0.05} onChange={(v) => set("rfX", v)} />
            <Slider label="Foot Y" value={state.rfY} min={0} max={2} step={0.05} onChange={(v) => set("rfY", v)} />
          </>}
          <Slider label="Knee Turn" value={state.rightKneeTurnDeg} min={-90} max={90} step={1} onChange={(v) => set("rightKneeTurnDeg", v)} />
          <div style={{ fontSize: 10, color: "#888", marginBottom: 3, paddingLeft: 90 }}>
            {state.rightKneeTurnDeg === 0 ? "neutral" : state.rightKneeTurnDeg < 0 ? `drop knee ${Math.abs(state.rightKneeTurnDeg)}°` : `frog ${state.rightKneeTurnDeg}°`}
          </div>
        </div>
      )}

      {/* Info bar */}
      {showInfo && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            right: 8,
            background: "rgba(0,0,0,0.85)",
            color: "#ccc",
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 10,
            fontFamily: "monospace",
            zIndex: 10,
            textAlign: "center",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {feetToFtIn(state.heightFt)} ({heightCm}cm) | Ape: {state.apeIndexIn}" |
          {" "}{state.bodyWeightKg}kg ({(state.bodyWeightKg * 2.20462).toFixed(0)}lbs) |
          Grip: {state.gripStrengthKg}kg |
          Wall: {state.wallAngleDeg > 0 ? `${state.wallAngleDeg} OH` : state.wallAngleDeg < 0 ? `${Math.abs(state.wallAngleDeg)} slab` : "vert"} |
          Twist: {state.bodyRotationDeg === 0 ? "0" : `${state.bodyRotationDeg}°`}
        </div>
      )}

      {/* 3D Scene */}
      <ClimbingScene config={config} />

      {/* Force panel overlay */}
      {showForces && <ForcePanel forces={forces} />}
    </div>
  );
}

export default App;
