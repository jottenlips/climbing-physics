import { ForceResult } from "../physics/climbingPhysics";

function ForceBar({
  label,
  value,
  max,
  color,
  unit,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  unit: string;
}) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span>{label}</span>
        <span>
          {value.toFixed(1)} {unit}
        </span>
      </div>
      <div
        style={{
          height: 8,
          background: "#333",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: color,
            borderRadius: 4,
            transition: "width 0.3s",
          }}
        />
      </div>
    </div>
  );
}

export default function ForcePanel({ forces }: { forces: ForceResult }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 40,
        right: 8,
        background: "rgba(0,0,0,0.85)",
        color: "#eee",
        padding: "10px 12px",
        borderRadius: 8,
        width: "min(250px, calc(100vw - 16px))",
        fontFamily: "monospace",
        fontSize: 11,
        zIndex: 10,
      }}
    >
      <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>Force Analysis</h3>

      <ForceBar
        label="Hand Force"
        value={forces.totalHandForceKg}
        max={100}
        color="#ffaa00"
        unit="kg"
      />
      <ForceBar
        label="Hand Force"
        value={forces.totalHandForceLbs}
        max={220}
        color="#ffcc00"
        unit="lbs"
      />
      <ForceBar
        label="Grip Strength Used"
        value={forces.gripStrengthPercentUsed}
        max={100}
        color={forces.gripStrengthPercentUsed > 100 ? "#ff2222" : forces.gripStrengthPercentUsed > 75 ? "#ffaa00" : "#44cc66"}
        unit="%"
      />

      <div
        style={{
          marginTop: 12,
          padding: 8,
          borderRadius: 4,
          background: forces.canHold ? "rgba(0,180,80,0.2)" : "rgba(255,0,0,0.2)",
          border: `1px solid ${forces.canHold ? "#0b4" : "#f00"}`,
          textAlign: "center",
          fontWeight: "bold",
        }}
      >
        {forces.canHold ? "CAN HOLD" : "WILL FALL - Grip exceeded!"}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: "#999" }}>
        <div>Gravity: {forces.gravity.length().toFixed(1)} N</div>
        <div>Normal force: {forces.normal.length().toFixed(1)} N</div>
        <div>Friction req: {forces.frictionRequired.toFixed(1)} N</div>
      </div>
    </div>
  );
}
