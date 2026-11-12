# The whole activity

Section `wholeActivity` (`WholeActivityProps`): a text, a figure from the activity's summary or the date.
What describes the whole activity is the same in every frame, so it has no time (no `videoTimeSeconds`),
and in a video it is drawn as on the still image. The shared props are in the [README](README.md):
`section`, `box` (`x`, `y`, `width`, `height`), `frame`, `fontPx` and `style` (`textColor`, `accentColor`, `backgroundOpacity`,
`fontScale`). The `box` is the one the words take, measured as the renderer measures them, kept inside the frame; no background is painted and nothing is clipped, so keep inside it yourself. A whole-activity component takes its colour from its own style, not the template's.

| Prop | Unit | Meaning |
| --- | --- | --- |
| `kind` | | `text`, `summary` or `date`. |
| `text` | | What to write, formatted in the reader's units, or the reader's own words for `text`. May hold line breaks: draw each line. Never empty. |
| `caption` | | The small line over a summary figure ("Avg speed"), not upper-cased. Absent for a text and a date, or when the reader turned it off. |
| `align` | | `left`, `center` or `right`: the anchor in `box`. |
| `weight` | | `normal` or `bold`. |
| `summary` | | `kind: 'summary'` only: `stat`, `value` and `basis`. |
| `date` | | `kind: 'date'` only: `startTime` and `utcOffsetMinutes`. |
| `activityName` | | The activity's name where the file states one. Absent otherwise. |

`summary` holds:

| Prop | Unit | Meaning |
| --- | --- | --- |
| `stat` | | `speed`, `pace`, `distance`, `elapsed`, `moving` or `climb`. |
| `value` | stored unit | The figure: m/s (speed), s/km (pace), m (distance and climb), s (elapsed and moving). |
| `basis` | | Speed and pace only: `moving` where the activity has a moving time, else `elapsed`. |

`date` holds:

| Prop | Unit | Meaning |
| --- | --- | --- |
| `startTime` | UTC | The activity's start as ISO 8601 ("2026-09-24T08:00:00.000Z"). |
| `utcOffsetMinutes` | min | Minutes east of UTC that the file says it was recorded in. Absent where it does not say. |

`text` is already written in the zone and format the reader chose; use `date` only for what you add
yourself. A figure the activity cannot supply (no distance, no timestamps), an empty text, or a date set
to the activity's own zone when the file states none, is not drawn.

## What it must draw

`caption` (if present) small over `text`, aligned as
`align` says and weighted as `weight` says, inside `box`. `activityName` is not part of `box`: draw it only inside `box`, by setting your own text smaller, or not at all.

## Example

[`examples/whole-activity.ts`](examples/whole-activity.ts)

```ts
export const draw: ComponentDraw<WholeActivityProps> = (ctx, props) => {
  const { box, fontPx, style, text, caption, align, weight } = props;
  const x = align === 'center' ? box.x + box.width / 2 : align === 'right' ? box.x + box.width : box.x;
  let y = box.y;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  ctx.fillStyle = style.textColor;
  if (caption) {
    ctx.globalAlpha = 0.8;
    ctx.font = `600 ${0.45 * fontPx}px system-ui, sans-serif`;
    ctx.fillText(caption.toUpperCase(), x, y);
    y += 0.45 * fontPx * 1.2;
  }
  ctx.globalAlpha = 1;
  ctx.font = `${weight === 'bold' ? 700 : 400} ${fontPx}px system-ui, sans-serif`;
  for (const line of text.split('\n')) {
    ctx.fillText(line, x, y);
    y += fontPx * 1.2;
  }
  ctx.restore();
};
```
