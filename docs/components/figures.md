# Live figures

Section `figure` (`FigureProps`): one value at the moment shown. Speed, pace, distance, elevation, heart
rate, running and cycling cadence, power, temperature, gradient, elapsed time, moving time, climb so far,
and a camera's charted streams. The shared props are in the [README](README.md): `section`, `box`
(`x`, `y`, `width`, `height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`,
`backgroundOpacity`, `fontScale`), `videoTimeSeconds` and `activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `source` | | never | What is read: `{ kind: 'metric', metric }` or `{ kind: 'sensor', key }` (`kind` is `metric` or `sensor`; `metric` one of the metric names; `key` the camera stream's). |
| `value` | stored unit | every frame | The number, in the stored unit of `unit`: m/s, s/km, m, bpm, spm, rpm, W, °C, %, s. The trailing mean when `smoothingWindowSeconds` is present. |
| `unit` | | never | The unit of `value`. Absent for a camera stream that states none. |
| `unitSystem` | | never | `metric` or `imperial`: the component's own choice, else the reader's. |
| `label` | | never | The name as the reader sees it ("Speed", or their wording). Not upper-cased. |
| `text` | | every frame | `value` formatted in `unitSystem`, with its unit ("32.4 km/h", "4:30 /km"). Draw this. |
| `figure` | | never | The reader's styling of the label and the value: `showLabel`, `labelScale`, `valueScale`, `labelColor`, `gap`, `align`, `halo`. An absent member is the built-in look. Absent when the reader set none. |
| `smoothingWindowSeconds` | s | never | Above 0, up to 30. Present only when `value` is a mean over that window. |
| `totalDistanceMeters` | m | never | Present only for a distance written "of the total", whose `text` says both ("12.4 / 42.2 km"). |

`value` changes between the activity's points at the video's frame rate; through a stop it follows
TD-080: speed, pace, power and cadence read 0, and the rest hold the value they had.

A figure that has no value at the moment (no heart rate here, a dropout, outside the recording) is not
drawn. A gauge with no range is a figure here, because the renderer draws it without a track.

## What it must draw

The label (`label`, upper-cased if you want the built-in look, unless `figure.showLabel` is `false`) and
the value (`text`) inside `box`, in `style.textColor`, honouring `figure.align` if you draw like the
built-ins. It does not format `value`, does not draw a placeholder, and keeps inside the box.

## Example

The example is minimal: it draws the label and the value left-aligned and ignores `figure`. A component that wants the built-in look honours `figure` as well.

[`examples/figure.ts`](examples/figure.ts)

```ts
export const draw: ComponentDraw<FigureProps> = (ctx, props) => {
  const { box, fontPx, style, label, text } = props;
  const pad = 0.5 * fontPx;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = style.textColor;
  ctx.font = `600 ${0.55 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(label.toUpperCase(), box.x + pad, box.y + pad);
  ctx.globalAlpha = 1;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, box.x + pad, box.y + pad + 0.8 * fontPx);
  ctx.restore();
};
```
