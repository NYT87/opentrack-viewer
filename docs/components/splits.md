# Splits

Section `splits` (`SplitsProps`): the split under way, the last one that finished and the last few, from the
file's laps or every kilometre or mile. The shared props are in the [README](README.md): `section`, `box`
(`x`, `y`, `width`, `height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`,
`fontScale`), `videoTimeSeconds` and `activityElapsedSeconds`. The decision behind it is TD-090.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `source` | | never | Where the splits come from here: `laps` (the file's) or `distance`. A component set to `laps` on a file with no usable laps reads `distance`. |
| `time` | | never | Which clock times a split: `moving` (holds through a stop) or `elapsed` (runs through it). |
| `everyMeters` | m | never | `distance` only: how far each split is. A kilometre or a mile unless the reader set a distance. |
| `unitSystem` | | never | `metric` or `imperial`: the units `rateText` is written in, and the kilometre or the mile a distance split is. |
| `rate` | | never | What `rateText` is: `pace`, `speed` (the average speed) or `none`. A run reads `pace` unless the reader chose, anything else `speed`. |
| `label` | | never | The component's name as the reader sees it ("Split", or their wording). |
| `current` | | every frame | The split under way: a row (below). `seconds` is the time so far; once the last split has ended it is that split, with its whole time. |
| `last` | | when a split ends | The last split that finished, a row. Absent when the reader turned it off, and before the first split has finished. |
| `list` | | when a split ends | The last finished splits, newest first, rows: as many as the reader asked for (0 to 10) and have finished. Empty by default. |
| `fasterColor` | | never | `#rrggbb`: the colour of a split that went faster. |
| `slowerColor` | | never | `#rrggbb`: the colour of a split that went slower. A split that was the same is in `style.textColor`. |
| `figure` | | never | The reader's styling of the label: `showLabel`, `labelScale`, `valueScale`, `labelColor`, `gap`, `align`, `halo`. An absent member is the built-in look. Absent when the reader set none. |

A row (`current`, `last` and each of `list`) has:

| Prop | Unit | Meaning |
| --- | --- | --- |
| `number` | | The split's number, from 1 at the start of the activity. |
| `seconds` | s | The time the split took (or has taken so far), by the clock `time` names. |
| `text` | | `seconds` written as a clock ("5:21", "1:02:03"). Draw this. |
| `distanceMeters` | m | The split's length (so far, for the current one). Absent where the activity has no distance for it. |
| `rateText` | | The pace or the average speed in `unitSystem` ("5:21 /km", "11.2 km/h"). Absent when `rate` is `none`, and where the split has no distance worth one. |
| `verdict` | | A finished split against the one before it: `faster`, `slower` or `same`. Absent on `current` and on the first split. |

## Where the splits are

With **laps**, a split starts at its lap's start time, and a lap ends where the next begins (the last, where the
activity ends). With **distance**, a split is each `everyMeters` along the activity; the last may be shorter. A
boundary is where the distance along the whole activity (or the lap's start) falls, interpolated between two
points, and the splits are numbered from 1 at the start of the activity, whatever a trim of the video shows.
The splits are found once for the activity, so `current` is the only row that changes between two frames inside
a split.

A step across a break in the recording (a pause the recorder cut) adds no distance, so a split with a break in it
ends at its distance. Through a stop the current split's time holds with `moving` and runs with `elapsed` (TD-080).

## Faster, slower, the same

Splits are compared by **pace**, so splits of different lengths compare fairly, and the verdict is already worked out. A
split is `faster` when its pace is lower than the one before it by half a second per kilometre or mile or more,
`slower` when it is higher by that much, and `same` otherwise. A split with no distance is compared by its time.
Do not work it out again from `seconds`, which would disagree where the lengths differ. Colour is not all there is:
write the word too (the built-in component says "faster" or "slower" on the last split's label).

## Missing data

A component is **not drawn**, and so not called, where the activity has no time, or where its splits would come from a
distance and the activity has none. A row has no `rateText` where it has no rate to give: write nothing there.

## Example

[`examples/splits.ts`](examples/splits.ts) is a draw function you can copy: the current split, the last in its
colour with the word, and the list.
