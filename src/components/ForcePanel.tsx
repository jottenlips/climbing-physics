import { ForceResult } from "../physics/climbingPhysics";

function ForceBar({ label, value, max, color, unit }: {
  label: string; value: number; max: number; color: string; unit: string;
}) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
        <span style={{ color: "#ccc" }}>{label}</span>
        <span style={{ fontWeight: 600 }}>{value.toFixed(1)} {unit}</span>
      </div>
      <div style={{ height: 10, background: "#1a1a22", borderRadius: 5, overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: color,
          borderRadius: 5, transition: "width 0.3s",
        }} />
      </div>
    </div>
  );
}

export default function ForcePanel({ forces }: { forces: ForceResult }) {
  return (
    <div style={{ color: "#eee", fontFamily: "system-ui, sans-serif" }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>Force Analysis</h3>

      <ForceBar label="Hand Force" value={forces.totalHandForceKg} max={100} color="#ffaa00" unit="kg" />
      <ForceBar label="Hand Force" value={forces.totalHandForceLbs} max={220} color="#ffcc00" unit="lbs" />
      <ForceBar label="Grip Used" value={forces.gripStrengthPercentUsed} max={100}
        color={forces.gripStrengthPercentUsed > 100 ? "#ff2222" : forces.gripStrengthPercentUsed > 75 ? "#ffaa00" : "#44cc66"} unit="%" />

      <div style={{
        marginTop: 12, padding: 10, borderRadius: 8,
        background: forces.canHold ? "rgba(0,180,80,0.15)" : "rgba(255,0,0,0.15)",
        border: `1px solid ${forces.canHold ? "#0b4" : "#f00"}`,
        textAlign: "center", fontWeight: 700, fontSize: 14,
      }}>
        {forces.canHold ? "CAN HOLD" : "WILL FALL"}
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: "#777", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span>Gravity: {forces.gravity.length().toFixed(1)}N</span>
        <span>Normal: {forces.normal.length().toFixed(1)}N</span>
        <span>Friction: {forces.frictionRequired.toFixed(1)}N</span>
      </div>
    </div>
  );
}
