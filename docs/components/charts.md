# Charts

Section `chart` (`ChartProps`): a figure against time or distance, with a cursor at the moment shown, whole or through a
window around now. The elevation profile of [along the route](along-the-route.md) is the same projection, of elevation
along distance. The shared props are in the [README](README.md): `section`, `box` (`x`, `y`, `width`, `height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`, `fontScale`), `videoTimeSeconds` and `activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `source` | | never | What the chart is of: a built-in metric (`kind` is `metric`, with its `metric`) or a camera stream (`kind` is `sensor`, with its `key`). |
| `label` | | never | The figure's name as the reader sees it. |
| `axis` | | never | What x is: `time` (seconds of the activity) or `distance` (metres along it). |
| `window` | s or m | never | Seconds (time axis) or metres (distance axis) either side of now, with the cursor in the middle. Absent: the whole activity, and the cursor moves along it. |
| `lineColor` | `#rrggbb` | never | The line's colour. |
| `fillColor` | `#rrggbb` | never | The fill under the line. |
| `fillOpacity` | 0..1 | never | How much of its colour the fill has. |
| `showLabels` | | never | Whether the reader asked for the axis labels; `labels` says what they say. |
| `runs` | 0..1 of the box | every frame in a window, else never | Runs of `[x, y]` points, y down, the highest value near the top. A gap in the data ends a run, so a line is never drawn across one; a recorded pause or a gap of over 10 s ends one too. In a window only the window is given, x running 0..1 across it and y fitted to its own lowest and highest value. |
| `cursor` | 0..1 of the box | every frame | `x`: where now is (its share of the activity, or 0.5 in a window). `y`: the figure's value on the line; absent where the figure has no value at this moment. |
| `value` | stored unit | every frame | The figure now, absent where the activity has no value at this moment. |
| `unit` | | never | The unit of `value` and of `yRange`. Absent for a camera stream that states none. |
| `yRange` | stored unit | in a window | `low` and `high`: the lowest and highest value drawn. Absent when a window has no data. |
| `labels` | | every frame in a window | Present only when `showLabels`: `yHigh` and `yLow` (the range's ends, written as the figure is, absent with `yRange`), and `xStart` and `xEnd` (the x window's ends: "−0:30" and "+0:30", or from 0:00 to the activity's length). Draw them as given. |
| `figure` | | never | The reader's styling of the labels (`showLabel`, `labelScale`, `valueScale`, `labelColor`, `gap`, `align`, `halo`). An absent member is the built-in look. Absent when the reader set none. |

The geometry is in 0..1 of the box, so multiply by `box.width` and `box.height`, then add `box.x` and `box.y`. A chart
whose figure the activity does not have, or on a distance axis for an activity with no distance, is not drawn, so a
component is not called for it. Where the activity does not reach the moment shown, nothing is drawn either.

## What it must draw

The line, a fill under it if you like, a cursor at `cursor.x` and a dot at `cursor.y` where there is one, inside `box`.
Nothing is drawn across a gap, and no placeholder where `value` is absent.

## Example

The example draws the runs, the fill, the cursor and its dot, and the labels it is given. It ignores `figure`.

[`examples/chart.ts`](examples/chart.ts)

```ts
export const draw: ComponentDraw<ChartProps> = (ctx, props) => {
  const { box, fontPx, style, runs, cursor, lineColor, fillColor, fillOpacity, labels, showLabels } = props;
  const pad = 0.3 * fontPx;
  const band = showLabels ? 0.7 * fontPx : 0;
  const area = { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad - band };
  const px = (x: number) => area.x + x * area.width;
  const py = (y: number) => area.y + y * area.height;

  ctx.save();
  ctx.lineJoin = 'round';
  for (const run of runs) {
    if (run.length === 0) continue;
    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.lineTo(px(run[run.length - 1]![0]), area.y + area.height);
    ctx.lineTo(px(run[0]![0]), area.y + area.height);
    ctx.closePath();
    ctx.globalAlpha = fillOpacity;
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = Math.max(1, 0.025 * area.height);
    ctx.stroke();
  }

  // The cursor, and a dot on the line where the figure has a value.
  ctx.fillStyle = style.accentColor;
  ctx.fillRect(px(cursor.x) - 1, area.y, 2, area.height);
  if (cursor.y !== undefined) {
    ctx.beginPath();
    ctx.arc(px(cursor.x), py(cursor.y), 0.05 * area.height, 0, Math.PI * 2);
    ctx.fill();
  }

  if (labels) {
    ctx.fillStyle = style.textColor;
    ctx.font = `${0.45 * fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    if (labels.yHigh) ctx.fillText(labels.yHigh, area.x, area.y, 0.4 * box.width);
    ctx.fillText(labels.xStart, area.x, area.y + area.height + 0.1 * fontPx, 0.4 * box.width);
    ctx.textAlign = 'right';
    ctx.fillText(labels.xEnd, area.x + area.width, area.y + area.height + 0.1 * fontPx, 0.4 * box.width);
  }
  ctx.restore();
};
```
