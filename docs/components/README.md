# Overlay components

What an overlay component is, what it is given, what it must and must not do, and what is built. The
contract is TypeScript in [`src/overlay/contract.ts`](../../src/overlay/contract.ts); these pages
document it, and a test keeps the two in step. The decision behind it is TD-085 in
[`docs/planning/06-decisions-and-open-questions.md`](../planning/06-decisions-and-open-questions.md);
the request is [issue #19](https://github.com/NYT87/opentrack-viewer/issues/19). The dial, the chart, the gradient indicator and the compass (TD-087, [issue #21](https://github.com/NYT87/opentrack-viewer/issues/21)) are sections too.

## Status: documented, not loaded

**Loading a component you wrote is not built.** Today the contract describes the data the built-in
components draw from, and the examples here are real files that are type-checked and run by the test
suite. Nothing in the app loads a file of yours and runs it.

Why not yet: a component is code, and code someone else wrote would run on your activity (positions,
heart rate). It has to run where it cannot reach the network, storage or the page, and the page's
Content Security Policy deliberately blocks `blob:` scripts, so how a component is loaded is a security
decision, left to the maintainer on the issue. Remotion, which the issue proposed as the component
model, is not used (TD-085).

## What a component is

A function `(ctx, props) => void` (`ComponentDraw`). `ctx` is a 2D canvas context (`ContractContext2D`,
below); `props` is plain data for one moment. It draws that moment inside its box, on a transparent
frame, and returns.

```ts
import type { ComponentDraw, FigureProps } from '../../src/overlay/contract';

export const draw: ComponentDraw<FigureProps> = (ctx, props) => {
  ctx.fillStyle = props.style.textColor;
  ctx.font = `700 ${props.fontPx}px system-ui, sans-serif`;
  ctx.fillText(props.text, props.box.x, props.box.y);
};
```

There is one kind of component per **section**, each with its own props:

| Section | Props | Page | Reads |
| --- | --- | --- | --- |
| `figure` | `FigureProps` | [figures.md](figures.md) | One value now: speed, pace, distance, heart rate, power, cadence, elevation, temperature, gradient, heading, a time, a camera stream |
| `gauge` | `GaugeProps` | [gauges.md](gauges.md) | A figure, plus its range and where the value falls in it |
| `route` | `RouteProps` | [along-the-route.md](along-the-route.md) | The route and the position, the progress bar, the elevation profile |
| `wholeActivity` | `WholeActivityProps` | [whole-activity.md](whole-activity.md) | A text, a figure from the summary, the date, the activity's name |
| `zones` | `ZoneProps` | [zones.md](zones.md) | The heart rate or power zone now, the zones' bounds, and the time in each zone so far |
| `dial` | `DialProps` | [dials.md](dials.md) | A figure on an arc of ticks: its range, where the needle points, and the ticks |
| `chart` | `ChartProps` | [charts.md](charts.md) | A figure against time or distance, whole or through a window, with a cursor |
| `gradient` | `GradientProps` | [gradient.md](gradient.md) | The slope in percent, its colour band and its glyph |
| `compass` | `HeadingProps` | [compass.md](compass.md) | The heading in degrees, and where the rose and the needle point |

## The rules

A component must:

- **Draw inside `props.box` only**, in the frame's pixels (origin top-left, y down). For a figure, gauge or route the host fills the
  box's background first and clips to it; a whole-activity component has neither, so the rule is yours alone: what is outside is not yours to touch.
- **Draw the same picture for the same props.** No random numbers, no clock (`Date.now`,
  `performance.now`), no state kept between calls. The preview and every export call it, at any frame
  rate and in any order, and must get the same picture.
- **Draw `text` as given.** It is formatted in the reader's units. Do not format `value` again.
- **Draw nothing for data it does not have.** A member that is absent is missing data: do not write a
  `0`, a dash or a placeholder in its place.

A component must not use the network or storage, read the frame, or reach the page. The context makes
the last two impossible: it has no `canvas` member (no way back to the canvas, the page or other
components), no `getImageData`, `putImageData`, `createImageData` or `drawImage` (a component must not
read the frame, which may hold the reader's video, and is given no image), and no `clearRect`,
`setTransform`, `resetTransform` or `globalCompositeOperation` (they could undo the clip or paint over
other components). `fetch`, `localStorage` and the rest are not in its reach in a sandbox, which is the
part not built yet.

## What every component is given

Every component's props hold these, besides its section's (the tables below say so on each page):

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `section` | | never | Which section's props these are. |
| `box` | px | never | `x`, `y`, `width`, `height`: where the component is, in the frame's pixels. |
| `frame` | px | never | `width` and `height` of the whole picture. |
| `fontPx` | px | never | The base type size: 2.2 % of the frame's width times `style.fontScale` (smaller only for a whole-activity text that would not fit the frame). |
| `style` | | never | The look chosen. `textColor` and `accentColor` are `#rrggbb`; `backgroundOpacity` is 0 to 1 and the host paints it behind a figure, gauge or route (not a whole-activity component); `fontScale` is a multiplier, already in `fontPx`. |

A component that reads a moment (`figure`, `gauge`, `route`, `zones`, `dial`, `chart`, `gradient`, `compass`) also has:

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `videoTimeSeconds` | s | every frame | The video's time. |
| `activityElapsedSeconds` | s | every frame | Seconds since the activity's first timed point, at that moment. |

A component for the whole activity has no time: it is the same in every frame.

## Missing data

Missing data is **absent**, never a placeholder. A component whose required data is missing (a heart-rate
figure on an activity without heart rate, a route without positions) is **not drawn**: it is not called,
as the built-in renderer does not draw it. Optional members are absent when they do not apply: there is no
`smoothingWindowSeconds` on a figure that is not smoothed, and no `activityName` where the file states no
name. Props contain no `undefined`, `NaN`, `Infinity` or `Date`: they survive `structuredClone` and
`JSON.stringify` unchanged.

## The context

`ContractContext2D` is `Pick<CanvasRenderingContext2D, …>` of: `save`, `restore`, `beginPath`,
`closePath`, `moveTo`, `lineTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect`, `quadraticCurveTo`,
`bezierCurveTo`, `fill`, `stroke`, `clip`, `fillRect`, `strokeRect`, `fillText`, `strokeText`,
`measureText`, `setLineDash`, `translate`, `rotate`, `scale`, and the properties `fillStyle`,
`strokeStyle`, `lineWidth`, `lineCap`, `lineJoin`, `globalAlpha`, `font`, `textAlign`, `textBaseline`,
`shadowColor`, `shadowBlur`, `shadowOffsetX` and `shadowOffsetY`. Type is drawn in the system font, as
the app draws it; no font is fetched.

## Units

Numbers that carry a quantity are in **stored units**, whatever the reader's unit system, so a component
can compare and scale them: speed m/s, pace s/km (0 is standing still, TD-080), distance and elevation
and climb m, heart rate bpm, running cadence spm, cycling cadence rpm, power W, temperature °C,
gradient %, heading degrees (clockwise from north), times s. The reader's unit system is in `unitSystem`, and `text` is already in it. Geometry
in `route` and `profile` is in 0..1 of the box.

## Examples

Each section's page has a minimal draw function that is a real file under
[`examples/`](examples), type-checked with the app and run by a test against a recording context that
checks it drew inside its box and used only what the contract gives. Run them with `npm test`.

## How the props are built

`contractProps`, `wholeActivityProps` and `contractPropsFor` in `src/overlay/contract.ts` build each
section's props from what the renderer already resolves (`resolveOverlayComponent`, the route and the
profile projections, the summary's values). The built-in components do not draw through them: the
renderer draws as it did. They are the seam a loader would use, and a test maps every built-in
component, in every state the renderer draws, to valid props of its section.
