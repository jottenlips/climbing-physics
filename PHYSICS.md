# Climbing Physics Simulator — Physics Model Documentation

A detailed breakdown of every factor modeled in the climbing physics engine.

## Overview

The simulator computes the grip force required for a climber to hold a position on a wall, based on body geometry, wall angle, hold types, and body positioning. The core output is **grip strength % used** — if it exceeds 100%, the climber cannot hold the position (`canHold = false`).

---

## Core Force Decomposition

### Gravity
Gravity acts straight down with magnitude `bodyWeight * 9.81 N`. It is decomposed into two components relative to the wall surface:

- **Wall-parallel component** — pulls the climber down along the wall surface. This is what hands and feet resist to keep from sliding down.
- **Wall-normal component** — pulls the climber away from the wall (on overhangs) or into the wall (on slabs). On overhangs, hands must resist this outward pull.

### Wall Angle
- **Slab** (negative degrees): Wall tilts back. Gravity pushes climber into the wall. Minimal hand force needed.
- **Vertical** (0 degrees): Gravity pulls straight down along the wall. Moderate hand force.
- **Overhang** (positive degrees): Gravity pulls climber away from wall. Hands must resist both downward slide and outward pull.
- **Roof** (90 degrees): Nearly all load on hands. Maximum outward force.

---

## Body Position Factors

### Body Twist (Hip Rotation)
- **Parameter**: `bodyRotationDeg` (-90 to +90)
- **Effect**: Twisting hips into the wall moves the center of gravity closer to the wall plane, reducing the outward moment arm.
- **Reduction**: Up to 40% grip force reduction at full 90-degree twist.
- **Mechanism**: `twistFactor = sin(twistRad)` — sinusoidal, so small twists help progressively.
- **Presets**: Square, Drop Knee (R/L), Flag (R/L), Back Flag (R/L) — each sets twist + knee positions.

### Hip Distance from Wall
- **Parameter**: `hipOffset` (0 = pressed in, 1 = fully extended)
- **Terrain-dependent behavior**:
  - **Overhang**: Close hips = good. Shorter moment arm = up to 50% reduction.
  - **Slab**: Hips OUT = good. Shifts CoG over feet, more downward force through legs = up to 60% reduction.
  - **Vertical**: Close hips slightly better = up to 20% reduction.
- **Blending**: Uses `sin(wallAngle)` to smoothly blend between slab/vertical/overhang behavior.
- **Auto-adjustments**:
  - On slab, hip distance is clamped so feet always reach the wall.
  - On overhang, if hips go too far, feet automatically cut (dangle).
  - Foot Y auto-raises when legs would be out of reach.

### Torso Distance from Wall
- **Parameter**: `torsoOffset` (0 = pressed in, 1 = fully extended)
- **Effect**: Longer moment arm on upper body = more hand load. Up to 40% penalty at full extension.
- **Slab reduction**: Torso penalty is reduced on slab (gravity presses you into the wall anyway).
- **Limits**: Capped at 85% of arm reach (hands must still reach holds).
- **Independent from hips**: Allows realistic positions like hips-in-torso-out or both extended.

### Body Under Holds (Lateral Alignment)
- **Mechanism**: When CoG is directly below the hands (centered laterally and well below), gravity pulls straight through the arms — minimal lateral torque on grip.
- **Reduction**: Up to 35% when perfectly aligned under holds.
- **Penalty**: When CoG is offset sideways, hands must resist a swing force. No benefit if laterally offset.
- **Calculation**: Uses both lateral offset (CoG vs hand midpoint) and vertical alignment (CoG below hands).

---

## Arm Mechanics

### Arm Bend Efficiency
- **Straight arms** (1.0 straightness): Skeleton bears load — tendons and bones take the force, minimal muscular effort. Efficiency = 1.0.
- **Slightly bent** (~0.8 straightness): "Engaged" position with scapular depression. Lats share the load with forearms. Efficiency ~0.95 (includes engagement bump).
- **Moderately bent** (~0.5): Active muscular contraction. Efficiency ~0.78.
- **Fully locked off** (0.0): Maximum bicep/forearm effort. Efficiency = 0.55 (nearly 2x the grip cost).
- **Computed from**: Distance between hand and CoG relative to arm reach (half wingspan).

### Scapular Engagement (Implicit)
- Not a separate control — baked into the arm bend efficiency curve.
- At ~80% arm straightness, there is an 8% efficiency bump from lat muscle recruitment.
- Models the real climbing technique: slightly bent arms with shoulders pulled down activates the large lat muscles, transferring force from forearms to core.
- Gaussian bump: `exp(-((straightness - 0.8)^2) / 0.02) * 0.08`

---

## Hold Type & Hand Position

### Pull Direction Types
Each hold type has a base efficiency and responds to hand position relative to CoG:

| Type | Base | Best Position | Worst Position |
|------|------|---------------|----------------|
| **Down** | 0.85 | Hand above CoG (+15%) | Hand below CoG (-25%) |
| **Side** | 0.80 | Hand to correct side (+15%) | Hand directly above (-10%) |
| **Undercling** | 0.70 | Hand below CoG (+20%) | Hand high above (-30%) |
| **Gaston** | 0.60 | Hand across body (+15%) | Hand on same side (-10%) |
| **Sloper** | 0.85 | Hand above, close (+10%) | On overhang (-35%) |

### Position-Aware Efficiency
- **Down pull**: Most effective pulling down on holds above you. Penalized when the hold is at or below your center of gravity.
- **Side pull**: Best when the hand is on the correct side (left hand left, right hand right) with good lateral offset. Less effective directly above.
- **Undercling**: Best when the hold is below CoG (pulling up from underneath). Heavily penalized when high above — biomechanically impossible to undercling well there. Also degrades on overhangs.
- **Gaston**: Best when the hand crosses the body (left hand right of center). Always the weakest grip type but position matters.
- **Sloper**: Friction-dependent. Best above and close to maximize contact pressure. Degrades significantly on overhangs (gravity pulls fingers off the hold).

All efficiencies are clamped to a minimum of 0.3.

---

## Contact Points & Stability

### Limb On/Off
- Each limb can be toggled on/off. Off limbs dangle straight down.
- **No feet**: Hands bear 100% of the load (campus style).
- **No hands**: Feet bear everything (only viable on slab).
- **One foot**: That foot is 70% as effective as two feet at supporting weight.
- **One hand**: That hand bears the full hand load.
- **Feet-off restriction**: Feet can only be removed on overhangs (slab/vertical forces them on).

### Hand Load Distribution
When both hands are on, load distributes inversely by distance to CoG:
- Hand closer to CoG bears more load (shorter lever arm).
- Hand farther from CoG bears less (longer lever arm acts as better counterbalance).

### Foot Spread Stability
- **Wider lateral foot placement** = more stable base = up to 15% less hand load.
- Considers three sub-factors:
  - **Lateral spread**: Wider feet relative to optimal (shoulder width) increases stability.
  - **Vertical spread**: Feet at different heights triangulates the base.
  - **CoG centering**: CoG centered between feet laterally maximizes the benefit.
- Only active when both feet are on the wall.

### Barn Door Effect
Models the rotational instability when contact points are nearly collinear:

- **Collinearity detection**: Finds the longest axis between contact points, measures perpendicular width. When points form a near-line (width < 20% of arm reach), barn door risk increases.
- **CoG outside support polygon**: When CoG extends beyond the centroid of contact points, it creates rotational torque.
- **Penalty**: Up to 30% more hand load when points are collinear and CoG is offset.
- **3-point penalty**: 40% worse with only 3 contact points (missing the 4th stabilizer).
- **Classic example**: Right hand + right foot + left hand roughly in line → the body wants to spin around that axis unless the left foot is wide enough to counteract.

---

## Force Calculation Pipeline

1. Decompose gravity into wall-parallel and wall-normal components
2. Compute arm bend efficiency (with scapular engagement bump)
3. Compute CoG position ratio between feet and hands
4. Calculate terrain-dependent reductions:
   - Body twist reduction (up to 40%)
   - Hip distance reduction (terrain-dependent, up to 50-60%)
   - Under-holds alignment reduction (up to 35%)
   - Torso distance penalty (up to 40%)
5. Apply foot spread stability bonus (up to 15%)
6. Apply barn door penalty (up to 30%)
7. Determine hand load fraction from all the above
8. Compute wall-normal hand force (outward pull on overhangs)
9. Total hand force = sqrt(along-wall^2 + normal^2)
10. Compute pull direction efficiency per hand (position-aware)
11. Effective grip = raw grip strength * pull efficiency * arm bend efficiency
12. Grip % used = total hand force / effective grip * 100
13. `canHold` = grip % used <= 100%

---

## Visual Model

### Body Proportions (Anatomically Correct)
All proportions are percentages of total height:
- **Arms**: Upper arm 42%, Forearm 33%, Hand 25% (of total arm length)
- **Legs**: Thigh 52%, Shin 40%, Foot 8% (of total leg length)
- **Head**: 6.5% of height
- **Neck**: 3.5% of height
- **Torso**: 30% of height
- **Shoulders**: 10.5% of height (width)
- **Hips**: 8.5% of height (width)

### Weight Visualization
- Torso rendered as a cylinder, tapered from chest width to waist width.
- Cylinder width scales with body weight (0.85x at 55kg to 1.25x at 100kg, baseline at 70kg).

### Joint Solving
- **IK (Inverse Kinematics)**: 2-bone IK using law of cosines for elbow and knee positions.
- **Elbow bend**: Always bends away from wall using cross product with lateral axis.
- **Knee bend**: Adaptive based on leg geometry (bunch factor, foot-below-hip detection).
- **Knee turn**: Rodrigues' rotation around hip-to-ankle axis for drop knees, flags, and back flags.
- **Wall clamping**: Knees cannot penetrate behind the wall surface.
- **Reach clamping**: Limbs capped at anatomical max reach from joint origins.
- **Dangling limbs**: Off-wall limbs hang straight down from their joint under gravity.

### Gear
- **Chalk bag**: Organic-style (sage green, orange stripe, black fleece rim) at harness level on lower back.
- **Harness**: Circular gear loop around hips with 6 quickdraws (3 per side).
- **Quickdraws**: Top carabiner → colored dogbone sling → bottom carabiner.

---

## Controls

### Climber Parameters
| Control | Range | Default | Description |
|---------|-------|---------|-------------|
| Weight (kg) | 30-120 | 70 | Body weight, affects gravity force and torso width |
| Grip (kg) | 10-100 | 45 | Max grip strength per hand |
| Height (ft) | — | 5.75 (5'9") | Determines all body proportions |
| Ape Index (in) | — | 69 | Wingspan, affects arm reach |
| Body Twist (deg) | -90 to 90 | 0 | Hip rotation on wall |
| Hip Distance | 0-1 | 0.15 | How far hips are from wall |
| Torso Distance | 0-1 | 0.65 | How far chest is from wall |
| Knee Turn (per leg) | -90 to 90 | 0 | Drop knee (-) or frog (+) |
| Pull Direction (per hand) | 5 types | down | Hold type |
| Limb Toggles | on/off | all on | Take limbs off wall |

### Wall Parameters
| Control | Range | Default | Description |
|---------|-------|---------|-------------|
| Angle (deg) | -30 to 90 | 45 | Slab (-) / Vertical (0) / Overhang (+) |

### Presets
- **Wall angle**: Slab, Vertical, 15/30/45 Overhang, Roof
- **Body position**: Square, Drop Knee (R/L), Flag (R/L), Back Flag (R/L)
- **Reset button**: Returns all parameters to defaults

---

## Units

- Internal calculations use SI units (kg, meters, Newtons)
- Display shows both kg and lbs for hand force
- Height input in feet (decimal: 5.75 = 5'9")
- Ape index in inches
