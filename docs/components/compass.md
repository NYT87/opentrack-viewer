# Compass

Section `compass` (`HeadingProps`): the direction of travel, as a rose that turns so the heading is up, or a needle on a
fixed rose. The heading is the bearing from the point about 20 m back along the route to the position now, smoothed with a
circular mean (never a plain average across 0 and 360 degrees), held through a stop (TD-080), and absent until the activity
has moved 20 m. The shared props are in the [README](README.md): `section`, `box` (`x`, `y`, `width`, `height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`, `fontScale`), `videoTimeSeconds` and `activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `value` | degrees | every frame | The heading, 0 (north) up to just under 360, 90 east. The circular mean when `smoothingWindowSeconds` is present. |
| `label` | | never | The figure's name as the reader sees it ("Heading", or their wording). |
| `text` | | every frame | `value` formatted for reading, in degrees and the 8-point letter ("123° SE"). Draw this. |
| `cardinal` | | every frame | The 8-point letter for `value`: `N`, `NE`, `E`, `SE`, `S`, `SW`, `W` or `NW`. |
| `compassStyle` | | never | `rose`: the rose turns so the heading is up, under a fixed marker. `needle`: a fixed north-up rose with a needle along the heading. |
| `showLabels` | | never | Whether the reader asked for the cardinal points to be labelled. |
| `roseColor` | `#rrggbb` | never | The ring, the ticks and the labels. |
| `needleColor` | `#rrggbb` | never | The needle or the marker, and the N. |
| `northAngleDegrees` | degrees | every frame | Where north is drawn on the ring, clockwise from straight up: `360 - value` (mod 360) for `rose`, 0 for `needle`. East, south and west follow 90 degrees apart. |
| `needleAngleDegrees` | degrees | every frame | Where the needle points, clockwise from straight up: `value` for `needle`; 0 for `rose`, where the marker is fixed at the top. |
| `smoothingWindowSeconds` | s | never | Above 0, up to 30. Present only when `value` is a circular mean over that window. |
| `figure` | | never | The reader's styling of the label and the value: `showLabel`, `labelScale`, `valueScale`, `labelColor`, `gap`, `align`, `halo`. An absent member is the built-in look. Absent when the reader set none. |

Both angles are already worked out and taken modulo a turn, so a heading going from 359 to 1 moves them by two degrees,
not a swing round. Do not work them out again from `value`. A compass is not drawn where the activity has no heading at
the moment shown (no positions, or under 20 m moved).

## What it must draw

The ring with its north at `northAngleDegrees`, the needle or marker at `needleAngleDegrees`, and the heading (`text`),
inside `box`; the cardinal points if `showLabels`.

## Example

The example draws the ring, the four letters, the needle and the heading. It ignores `compassStyle`, `label` and `figure`.

[`examples/compass.ts`](examples/compass.ts)

```ts
export const draw: ComponentDraw<HeadingProps> = (ctx, props) => {
  const { box, fontPx, style, text, northAngleDegrees, needleAngleDegrees, roseColor, needleColor, showLabels } = props;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) / 2 - 0.3 * fontPx;
  const at = (r: number, degrees: number) => [cx + r * Math.sin((degrees * Math.PI) / 180), cy - r * Math.cos((degrees * Math.PI) / 180)] as const;

  ctx.save();
  ctx.strokeStyle = roseColor;
  ctx.lineWidth = Math.max(1.5, 0.035 * radius);
  ctx.beginPath();
  ctx.arc(cx, cy, 0.86 * radius, 0, Math.PI * 2);
  ctx.stroke();

  if (showLabels) {
    ctx.font = `700 ${0.2 * radius}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ['N', 'E', 'S', 'W'].forEach((letter, i) => {
      const [x, y] = at(0.6 * radius, northAngleDegrees + 90 * i);
      ctx.fillStyle = letter === 'N' ? needleColor : roseColor;
      ctx.fillText(letter, x, y, 0.5 * radius);
    });
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, cx, cy + 0.14 * radius, 1.3 * radius);

  const [tx, ty] = at(0.8 * radius, needleAngleDegrees);
  const [lx, ly] = at(0.08 * radius, needleAngleDegrees + 90);
  const [rx, ry] = at(0.08 * radius, needleAngleDegrees - 90);
  ctx.fillStyle = needleColor;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(lx, ly);
  ctx.lineTo(rx, ry);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};
```
