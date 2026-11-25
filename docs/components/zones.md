# Zones

Section `zones` (`ZoneProps`): the heart rate or power zone the activity is in at the moment shown, and the
zones' bounds. The shared props are in the [README](README.md): `section`, `box` (`x`, `y`, `width`,
`height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`, `fontScale`),
`videoTimeSeconds` and `activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `source` | | never | What the zones are measured on: `heartRate` or `power`. |
| `value` | bpm or W | every frame | The reading, in the stored unit of `unit`. The trailing mean when `smoothingWindowSeconds` is present. |
| `unit` | | never | `bpm` for heart rate, `W` for power. |
| `label` | | never | The figure's name as the reader sees it ("Heart rate", or their wording). |
| `text` | | every frame | `value` formatted for reading, with its unit ("152 bpm"). Draw this. |
| `zoneIndex` | | when `value` crosses a bound | The 0-based position of the zone the value is in. The zone's number is `zoneIndex + 1`. |
| `fractionInZone` | 0..1 | every frame | Where `value` falls in its zone: 0 at its lower bound, 1 at the next one's. The last zone is as wide as the one before it. Already clamped. |
| `zones` | | never | The zones, lowest first, 2 to 10 of them: each has a `name` (a short line, possibly empty), a `color` (`#rrggbb`) and a `lowerBound` in `unit`. The bounds are always absolute and ascending, whatever the reader measured them in. |
| `shape` | | never | How the reader asked for it to be drawn: `horizontal`, `vertical`, `arc` or `figure`. |
| `show` | | never | What the reader asked to see: `number`, `name`, `value` and `timeInZone`, each `true` or `false`. |
| `timeInZoneSeconds` | s | every frame | Seconds spent **moving** in each zone so far, one number per zone, from the unsmoothed values. Present only when `show.timeInZone` is `true` and the activity can say. |
| `smoothingWindowSeconds` | s | never | Above 0, up to 30. Present only when `value` is a mean over that window. |
| `figure` | | never | The reader's styling of the label and the value: `showLabel`, `labelScale`, `valueScale`, `labelColor`, `gap`, `align`, `halo`. An absent member is the built-in look. Absent when the reader set none. |

## Which zone

A value is in the last zone whose `lowerBound` is at or under it, and in the first zone when it is under
every bound: the first zone is a floor, and anything below it counts in it. A value above the last bound is in
the last zone. A value exactly on a bound is in the zone that starts there. `zoneIndex` is already worked
out; do not work it out again from `value` and the bounds, which would disagree with the built-ins where the
value is smoothed.

Through a stop the zone holds as a figure does (TD-080): power reads 0 and so is in the first zone, heart
rate holds the value it had.

## The reader's own figures

A reader measures zones in a percentage of their maximum heart rate or FTP, which are personal. They are
held in memory for the session only, never stored and never sent, and are not in the props: `zones` carries
the bounds already in bpm or W, `lowerBound` each. Zones measured in a percentage of a figure the reader has not
entered are **not drawn**, so a component is not called for them.

## Time in each zone

`timeInZoneSeconds[i]` is the seconds spent moving with the (unsmoothed) value in zone `i`, up to now. A step
between two points counts as moving as the activity's moving time does (TD-058): a recording gap is never
moving, and a standstill counts for nothing. The numbers add up to the moving time so far, less any time at
which the value is missing. Write it as `m:ss` (or `h:mm:ss` from an hour).

## What it must draw

The current zone, marked (bright, the others dimmed, or a marker at `fractionInZone`), inside `box`, in the
zones' own `color`s. If you show the zone's number and name or the value, honour `show`; `text` is the value
ready to write. It draws nothing outside the box, and no placeholder where a member is absent.

## Example

The example is minimal: a horizontal bar of the zones, the current one bright and the others dimmed, a marker
at the value's place in its zone, and the name and value above it. It ignores `shape`, `show` and `figure`; a
component that wants the built-in look honours them.

[`examples/zones.ts`](examples/zones.ts)

```ts
export const draw: ComponentDraw<ZoneProps> = (ctx, props) => {
  const { box, fontPx, style, zones, zoneIndex, fractionInZone, text } = props;
  const pad = 0.5 * fontPx;
  const gap = 0.1 * fontPx;
  const barHeight = 0.8 * fontPx;
  const width = box.width - 2 * pad;
  const segment = (width - gap * (zones.length - 1)) / zones.length;
  const barY = box.y + box.height - pad - barHeight;

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  const current = zones[zoneIndex]!;
  ctx.fillText(`${current.name} ${text}`, box.x + pad, box.y + pad, width);

  zones.forEach((zone, i) => {
    ctx.globalAlpha = i === zoneIndex ? 1 : 0.35;
    ctx.fillStyle = zone.color;
    ctx.fillRect(box.x + pad + i * (segment + gap), barY, segment, barHeight);
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.textColor;
  ctx.fillRect(box.x + pad + zoneIndex * (segment + gap) + fractionInZone * segment - 1, barY, 2, barHeight);
  ctx.restore();
};
```
