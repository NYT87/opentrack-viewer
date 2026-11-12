# Along the route

Section `route` (`RouteProps`): the route with the position on it, the progress bar and the elevation
profile. `part` says which; the members each needs are present and the others absent. The shared props
are in the [README](README.md): `section`, `box` (`x`, `y`, `width`, `height`), `frame`, `fontPx`, `style` (`textColor`, `accentColor`, `backgroundOpacity`, `fontScale`), `videoTimeSeconds` and
`activityElapsedSeconds`.

| Prop | Unit | Changes | Meaning |
| --- | --- | --- | --- |
| `part` | | never | `route`, `progress` or `elevationProfile`. |
| `progress` | 0..1 | every frame | How far along the activity: by distance where it has one, else by time. Absent where the activity has no clock to measure by. |
| `route` | box | `position` every frame, the rest never | `part: 'route'`: the route's shape. Absent when no activity is given or it has no route to fit. |
| `profile` | box | `cursor` every frame, the rest never | `part: 'elevationProfile'`: the elevation along the activity. Absent when it has no elevation along it. |

`route` holds:

| Prop | Unit | Meaning |
| --- | --- | --- |
| `segments` | 0..1 of the box | Runs of `[x, y]` points, x right and y down, fitted into the box with the route's aspect kept and a margin. A pause or a lost fix ends a run: never draw a line from one run to the next. |
| `position` | 0..1 of the box | `[x, y]`, where the activity is now. Absent where it has no position. |

`profile` holds:

| Prop | Unit | Meaning |
| --- | --- | --- |
| `runs` | 0..1 of the box | Runs of `[x, y]` points: x is the distance along the activity, y the height (the highest point near the top, y down). A stretch with no elevation ends a run. |
| `cursor` | 0..1 of the box | `[x, y]`, the line's point at `progress`. Absent in a gap. |

Geometry is in 0..1 of the box, so multiply by `box.width` and `box.height`, then add `box.x` and
`box.y`. It does not depend on the frame's size. The shape is the same in every frame; only `position`,
`cursor` and `progress` move.

A progress bar needs only `progress`. A route inset is not drawn where the activity has no position at
the moment shown, and an elevation profile not where it has no elevation.

## What it must draw

The route and a marker at `position`, or the profile and a cursor at `progress`, or a bar filled to
`progress`, inside `box`. Nothing is drawn across a gap.

## Examples

[`examples/route.ts`](examples/route.ts), the route and a dot where the activity is:

```ts
export const draw: ComponentDraw<RouteProps> = (ctx, props) => {
  const { box, style, route } = props;
  if (!route) return;
  ctx.save();
  ctx.strokeStyle = style.textColor;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 0.03 * box.height;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const segment of route.segments) {
    ctx.beginPath();
    segment.forEach(([x, y], index) => {
      const px = box.x + x * box.width;
      const py = box.y + y * box.height;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  // … the dot at route.position, in style.accentColor
  ctx.restore();
};
```

[`examples/elevation-profile.ts`](examples/elevation-profile.ts), the profile with a soft fill and a
cursor. It takes the same props and draws the `profile` runs, then a vertical bar at `progress` and a dot
at `profile.cursor`, both kept inside the box at the ends of the activity; read the file for the whole
function.
