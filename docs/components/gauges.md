# Gauges

Section `gauge` (`GaugeProps`): everything a [figure](figures.md) has (`source` with its `kind`, `metric` and `key`, `value`, `unit`,
`unitSystem`, `label`, `text`, `figure`, `smoothingWindowSeconds`, `totalDistanceMeters`), with
`section` set to `'gauge'`, and the range. The shared props are in the [README](README.md): `box` (`x`, `y`, `width`, `height`), `frame`,
`fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`, `fontScale`), `videoTimeSeconds` and `activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `range` | stored unit | never | The bounds the reader set: `min` and `max`, in the stored unit of `value`. `min` is below `max`. |
| `fraction` | 0..1 | every frame | Where `value` falls in `range`: 0 at or below `min`, 1 at or above `max`. Already clamped. |

Draw the track from `fraction`; do not recompute it from `value` and `range`, which would disagree with
the built-ins where the value is smoothed or clamped. A gauge with no range is given as a
[figure](figures.md), not a gauge.

## What it must draw

The value (`text`) and a track filling to `fraction`, in `style.accentColor`, inside `box`.

## Example

[`examples/gauge.ts`](examples/gauge.ts)

```ts
export const draw: ComponentDraw<GaugeProps> = (ctx, props) => {
  const { box, fontPx, style, text, fraction } = props;
  const pad = 0.5 * fontPx;
  const trackHeight = 0.25 * fontPx;
  const trackWidth = box.width - 2 * pad;
  const trackY = box.y + box.height - pad - trackHeight;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, box.x + pad, box.y + pad);
  ctx.fillStyle = 'rgb(255 255 255 / 0.25)';
  ctx.fillRect(box.x + pad, trackY, trackWidth, trackHeight);
  ctx.fillStyle = style.accentColor;
  ctx.fillRect(box.x + pad, trackY, trackWidth * fraction, trackHeight);
  ctx.restore();
};
```
