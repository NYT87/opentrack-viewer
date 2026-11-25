# Dials

Section `dial` (`DialProps`): a gauge on an arc of ticks, with a needle or a marker. It has everything a
[gauge](gauges.md) has (`source` with its `kind`, `metric` and `key`, `value`, `unit`, `unitSystem`, `label`, `text`,
`figure`, `smoothingWindowSeconds`, `range` with its `min` and `max`, and `fraction`), with `section` set to `'dial'`, and the arc,
the ticks, the pointer and the colours. The shared props are in the [README](README.md): `section`, `box` (`x`, `y`, `width`, `height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`, `fontScale`), `videoTimeSeconds` and `activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `sweepDegrees` | degrees | never | How wide the arc is open: 180 to 300. The arc is centred at the top. |
| `angleDegrees` | degrees | every frame | Where the pointer points, clockwise from straight up: `-sweepDegrees / 2` at the range's start, 0 at its middle, `+sweepDegrees / 2` at its end. Already worked out from `fraction`, so a value beyond the range is at an end. A canvas angle is `(angleDegrees - 90) * Math.PI / 180`. |
| `ticks` | | never | The ticks, worked out for the range and the reader's step: each has a `fraction` (0..1 along the arc, ascending) and `major` (`true` for a major tick, which is drawn longer). |
| `pointer` | | never | `needle` or `marker`. |
| `trackColor` | `#rrggbb` | never | The arc's colour, and the ticks'. |
| `fillColor` | `#rrggbb` | never | The part of the arc up to the value. |
| `needleColor` | `#rrggbb` | never | The needle, or the marker. |

The range is the reader's, or the activity's own for the figure rounded outward to a step of 1, 2 or 5 times a
power of ten (never below zero for a figure that cannot go there); it is always given, and `min` is below `max`.
A value outside it sits at its end: `fraction` is 0 or 1 and so is the pointer's angle. Draw the pointer from `angleDegrees`
and the fill from `fraction`; do not work them out again from `value` and `range`, which would disagree with the
built-ins where the value is smoothed. `text` is the value ready to write, in the reader's units.

## What it must draw

The arc with its ticks, the pointer at `angleDegrees`, and the value (`text`) and its `label` in the middle, inside
`box`. The built-in dial also fills the arc up to the value in `fillColor`. A dial for a figure the activity does not
have at that moment is not drawn, so a component is not called for it.

## Example

The example draws the track, the part filled to the value, the ticks, a needle and the value. It ignores `pointer`,
`figure` and `label`; a component that wants the built-in look honours them. It draws from absolute points rather than
a rotated context, as the built-in does.

[`examples/dial.ts`](examples/dial.ts)

```ts
export const draw: ComponentDraw<DialProps> = (ctx, props) => {
  const { box, fontPx, style, text, fraction, sweepDegrees, angleDegrees, ticks, trackColor, fillColor, needleColor } = props;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) / 2 - 0.4 * fontPx;
  const arcWidth = 0.13 * radius;
  const arcRadius = radius - arcWidth / 2;
  // Degrees clockwise from the top, as a canvas angle.
  const canvasAngle = (degrees: number) => ((degrees - 90) * Math.PI) / 180;
  const at = (r: number, degrees: number) => [cx + r * Math.cos(canvasAngle(degrees)), cy + r * Math.sin(canvasAngle(degrees))] as const;
  const start = -sweepDegrees / 2;

  ctx.save();
  ctx.lineWidth = arcWidth;
  ctx.strokeStyle = trackColor;
  ctx.beginPath();
  ctx.arc(cx, cy, arcRadius, canvasAngle(start), canvasAngle(-start));
  ctx.stroke();
  if (fraction > 0) {
    ctx.strokeStyle = fillColor;
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, canvasAngle(start), canvasAngle(start + fraction * sweepDegrees));
    ctx.stroke();
  }

  // The ticks, inside the arc: the major ones longer.
  ctx.strokeStyle = trackColor;
  ctx.lineWidth = Math.max(1, 0.02 * radius);
  ctx.beginPath();
  for (const tick of ticks) {
    const degrees = start + tick.fraction * sweepDegrees;
    const [x1, y1] = at(radius - arcWidth - 0.05 * radius, degrees);
    const [x2, y2] = at(radius - arcWidth - (tick.major ? 0.18 : 0.12) * radius, degrees);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, cx, cy + 0.2 * radius, 1.5 * radius);

  const [tx, ty] = at(0.74 * radius, angleDegrees);
  ctx.strokeStyle = needleColor;
  ctx.fillStyle = needleColor;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, 0.045 * radius);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, 0.07 * radius), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};
```
