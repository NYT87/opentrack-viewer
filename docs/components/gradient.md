# Gradient indicator

Section `gradient` (`GradientProps`): the current slope in percent, with an up or down glyph and a colour by steepness.
The shared props are in the [README](README.md): `section`, `box` (`x`, `y`, `width`, `height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`, `fontScale`), `videoTimeSeconds` and `activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `value` | % | every frame | The grade: positive uphill. The file's own grade where it records one, otherwise the climb over the last 50 m of distance, so most files have one. The trailing mean when `smoothingWindowSeconds` is present. |
| `label` | | never | The figure's name as the reader sees it ("Grade", or their wording). |
| `text` | | every frame | `value` formatted for reading ("6.5 %"). Draw this. |
| `bands` | | never | The colour bands, lowest first, 2 to 10: each has a `from` (percent) and a `color` (`#rrggbb`). The first is the floor: anything under the second's start is in it. |
| `bandIndex` | | when `value` crosses a bound | The 0-based band `value` is in: the last whose `from` is at or under it, and 0 for a value under every band. A value exactly on a bound is in the band that starts there. |
| `color` | `#rrggbb` | when `value` crosses a bound | The colour of that band. Draw the text and the glyph in it. |
| `glyph` | | when `value` crosses 1 % | `up` from +1 % up, `down` from -1 % down, `flat` between. Absent when the reader turned the glyph off. Draw it as a path, not a font character. |
| `smoothingWindowSeconds` | s | never | Above 0, up to 30. Present only when `value` is a mean over that window. |
| `figure` | | never | The reader's styling of the label and the value: `showLabel`, `labelScale`, `valueScale`, `labelColor`, `gap`, `align`, `halo`. An absent member is the built-in look. Absent when the reader set none. |

`bandIndex` and `glyph` are already worked out; do not work them out again from `value` and `bands`, which would
disagree with the built-ins where the value is smoothed. Missing data is not drawn: a gradient indicator is not called
where the activity has no grade at the moment shown (no recorded grade, and under 50 m of distance, or no elevation).

## What it must draw

The grade (`text`) and the glyph in `color`, inside `box`.

## Example

The example draws the glyph as a path and the text in the band's colour. It ignores `label`, `bands` and `figure`.

[`examples/gradient.ts`](examples/gradient.ts)

```ts
export const draw: ComponentDraw<GradientProps> = (ctx, props) => {
  const { box, fontPx, color, text, glyph } = props;
  const pad = 0.5 * fontPx;
  const size = 0.9 * fontPx;
  const x = box.x + pad;
  const y = box.y + (box.height - size) / 2;

  ctx.save();
  ctx.fillStyle = color;
  if (glyph) {
    ctx.beginPath();
    if (glyph === 'up') {
      ctx.moveTo(x + size / 2, y);
      ctx.lineTo(x + size, y + size);
      ctx.lineTo(x, y + size);
    } else if (glyph === 'down') {
      ctx.moveTo(x, y);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x + size / 2, y + size);
    } else {
      ctx.rect(x, y + 0.38 * size, size, 0.24 * size);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  const left = glyph ? x + size + 0.35 * fontPx : x;
  ctx.fillText(text, left, box.y + box.height / 2, Math.max(1, box.x + box.width - pad - left));
  ctx.restore();
};
```
