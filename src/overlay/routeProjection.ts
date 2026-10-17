import type { Activity, Coordinate } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';

/**
 * AV-1004. Fits an activity's route into a unit box for the route inset.
 *
 * Equirectangular, with longitude scaled by the cosine of the mean latitude so
 * a route is not stretched; longitudes are unwrapped from the first point so a
 * route crossing the antimeridian stays in one piece. Aspect ratio is kept and
 * the route is centred, so nothing is clipped whatever shape the box is.
 */
export interface ProjectedRoute {
  /** Segments of normalized `[x, y]` points, y down, each within the padded box. */
  segments: Point[][];
  project: (position: Coordinate) => [number, number];
}

/**
 * The finest the line is drawn: a cell of this many box heights is about a pixel
 * at 1000 px, and nothing finer than a pixel can be seen.
 */
export const MIN_POINT_STEP = 0.001;
/**
 * The coarsest a route is drawn *while it keeps its shape*: no point of the
 * route is further than this, in box heights, from the line (about 8 px on a
 * 650 px inset, under 1 px on the preview's). It is a *visible* error bound, and
 * it does not grow with the recording, so a long route cannot lose its shape.
 * A route that is long without being detailed — laps, an out-and-back — fits the
 * budget well inside it.
 */
export const MAX_POINT_STEP = 0.012;
/**
 * The most points a route is ever drawn with: this is the per-frame cost of the
 * inset, and it is a **hard** bound. The step coarsens to meet it, within
 * `MAX_POINT_STEP` if the route allows. A route that covers so many distinct
 * cells that it does not fit even there (a serpentine grid, a space-filling
 * scribble) cannot be both that faithful and that cheap, so the budget wins: the
 * step keeps growing, past the visible-error bound, until it fits, and as a last
 * resort what remains is thinned evenly.
 */
export const MAX_ROUTE_POINTS = 3000;
/** The most samples taken along any one leg when asking which squares it crosses. */
const MAX_LEG_SAMPLES = 256;
/** The coarsest cell tried before thinning evenly: a quarter of the box. */
const HARD_MAX_STEP = 0.25;

type Point = [number, number];

/**
 * Draws a route once. The picture is a grid of `cell`-sized squares (in box
 * heights), and the question asked of each *leg* — the straight run between two
 * consecutive recorded points — is whether every square it passes through has
 * already been entered by a leg that was drawn. If so, the leg is ground the
 * picture already has (the second lap of a loop, the way back along the road
 * out) and is not drawn again. If not, it is drawn, and its squares are marked.
 *
 * It is the leg that is judged, not its end: a point can sit in a square that
 * has been visited while the leg that arrives there has not been drawn — the
 * diagonal that closes a square back to its first corner, the last side of a
 * closed loop — and that leg must be kept. A sparse route, whose every leg is
 * new, is therefore drawn whole.
 *
 * Where drawing resumes after skipped ground, the new piece of line starts on
 * that ground (at the start of the first leg to be drawn) unless it is within a
 * cell and a half of the end of the last piece, in which case the two are one
 * line: that is a run of legs inside a single square, thinned away, not a
 * retrace. So the line is neither drawn twice nor bridged by a chord, and no
 * point of the route is further than a cell from it. The end of every recorded
 * segment is kept.
 */
function thin(
  raw: { point: Point; segment: number }[],
  cell: number,
  boxAspect: number,
): Point[][] {
  const pieces: Point[][] = [];
  const visited = new Set<number>();
  const cellKey = (x: number, y: number) => Math.floor((x * boxAspect) / cell) * 100003 + Math.floor(y / cell);
  const near = cell * 1.5;
  const distance = (a: Point, b: Point) => Math.hypot((a[0] - b[0]) * boxAspect, a[1] - b[1]);

  /**
   * The squares the leg a → b passes through, sampled twice a square — but never
   * more than `MAX_LEG_SAMPLES` times, so that a scribble of long legs costs a
   * bounded amount per leg. A leg that long is crossing the whole picture, and
   * would have to run through a hatching of already-drawn squares, missing every
   * undrawn one in between, to be taken for covered by mistake.
   */
  const legCells = (a: Point, b: Point): number[] => {
    const length = distance(a, b);
    const steps = Math.min(MAX_LEG_SAMPLES, Math.max(1, Math.ceil(length / (cell / 2))));
    const keys: number[] = [];
    let previous = Number.NaN;
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const key = cellKey(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      if (key !== previous) keys.push(key);
      previous = key;
    }
    return keys;
  };

  let piece: Point[] = [];
  let currentSegment = raw[0]!.segment;
  const endSegment = (last: Point | undefined) => {
    // The line ends where the route does, even if its last leg was on ground already drawn.
    if (last && piece.length && piece[piece.length - 1] !== last) {
      if (distance(piece[piece.length - 1]!, last) <= near) piece.push(last);
      else {
        pieces.push(piece);
        piece = [last];
      }
    } else if (last && !piece.length) piece = [last];
    if (piece.length) pieces.push(piece);
    piece = [];
  };

  let previous: Point | undefined;
  for (const { point, segment } of raw) {
    if (segment !== currentSegment) {
      endSegment(previous);
      currentSegment = segment;
      previous = undefined;
    }
    if (!previous) {
      piece = [point];
      visited.add(cellKey(point[0], point[1]));
    } else {
      const keys = legCells(previous, point);
      if (!keys.every((key) => visited.has(key))) {
        const end = piece[piece.length - 1];
        if (!end) piece = [previous];
        else if (end !== previous && distance(end, previous) > near) {
          pieces.push(piece);
          piece = [previous];
        }
        piece.push(point);
        for (const key of keys) visited.add(key);
      }
    }
    previous = point;
  }
  endSegment(previous);
  return pieces;
}

/**
 * The last resort, which guarantees the budget whatever the route is made of.
 *
 * Every piece of line needs its two ends, so there is a limit below which the
 * points of a piece cannot be thinned: a route of two thousand two-point
 * recorded segments is four thousand points however it is drawn. When even the
 * ends do not fit, the pieces themselves are reduced, and the ones given up are
 * the ones that show least — **the shortest**, by the length of line drawn —
 * while the ones kept are cut to their ends, in the order they were recorded.
 * When the ends do fit, the points between them are thinned evenly instead, and
 * every piece keeps its first and last.
 *
 * Either way the total is within `budget`: that is what bounds the cost of a
 * frame, and the shape of a route this fragmented could not be kept in it.
 */
function thinEvenly(pieces: Point[][], budget: number): Point[][] {
  const ends = (piece: Point[]) => Math.min(2, piece.length);
  const endPoints = endsOf(pieces);

  if (endPoints > budget) {
    const lengthOf = (piece: Point[]) =>
      piece.reduce((sum, point, i) => (i === 0 ? 0 : sum + Math.hypot(point[0] - piece[i - 1]![0], point[1] - piece[i - 1]![1])), 0);
    // Longest first; the order recorded breaks ties, so the result is the same every time.
    const ranked = pieces
      .map((piece, index) => ({ piece, index, length: lengthOf(piece) }))
      .sort((a, b) => b.length - a.length || a.index - b.index);
    const kept = new Set<number>();
    let used = 0;
    for (const { piece, index } of ranked) {
      if (used + ends(piece) > budget) continue;
      kept.add(index);
      used += ends(piece);
    }
    return pieces
      .filter((_, index) => kept.has(index))
      .map((piece) => (piece.length > 2 ? [piece[0]!, piece[piece.length - 1]!] : piece));
  }

  const total = pointCount(pieces);
  const every = Math.ceil(total / Math.max(1, budget - endPoints));
  return pieces.map((piece) =>
    piece.filter((_, index) => index === 0 || index === piece.length - 1 || index % every === 0),
  );
}

/** The fewest points a set of pieces can have: two for each, one for a piece that is a point. */
const endsOf = (pieces: Point[][]) => pieces.reduce((sum, piece) => sum + Math.min(2, piece.length), 0);

const pointCount = (pieces: Point[][]) => pieces.reduce((sum, piece) => sum + piece.length, 0);

export function projectRoute(
  activity: Activity,
  boxAspect: number,
  padding = 0.08,
): ProjectedRoute | undefined {
  // A run is an unbroken stretch of valid fixes. A recorded segment boundary
  // or an invalid fix ends one: drawing across either would suggest a route
  // through a gap the recording does not contain.
  const raw: { lat: number; lon: number; segment: number }[] = [];
  let run = 0;
  let lastSegment: number | undefined;
  let lastValid = true;
  for (const point of activity.points) {
    const place = toValidCoordinate(point.lat, point.lon);
    const segment = point.segmentIndex ?? 0;
    if (!place) {
      lastValid = false;
      continue;
    }
    if (!lastValid || (lastSegment !== undefined && segment !== lastSegment)) run += 1;
    lastValid = true;
    lastSegment = segment;
    raw.push({ ...place, segment: run });
  }
  const first = raw[0];
  if (!first || !(boxAspect > 0)) return undefined;

  const unwrap = (lon: number) => {
    let delta = lon - first.lon;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    return first.lon + delta;
  };

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let latSum = 0;
  for (const { lat, lon } of raw) {
    const u = unwrap(lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, u);
    maxLon = Math.max(maxLon, u);
    latSum += lat;
  }
  const lonScale = Math.cos(((latSum / raw.length) * Math.PI) / 180);
  const width = (maxLon - minLon) * lonScale;
  const height = maxLat - minLat;

  // Work in a box of `boxAspect` x 1, then normalize x by the aspect.
  const innerW = boxAspect * (1 - 2 * padding);
  const innerH = 1 - 2 * padding;
  const scale =
    width > 0 && height > 0
      ? Math.min(innerW / width, innerH / height)
      : width > 0
        ? innerW / width
        : height > 0
          ? innerH / height
          : 0; // a single place: centred
  const offsetX = (boxAspect - width * scale) / 2;
  const offsetY = (1 - height * scale) / 2;

  const project = ({ lat, lon }: Coordinate): [number, number] => [
    (offsetX + (unwrap(lon) - minLon) * lonScale * scale) / boxAspect,
    offsetY + (maxLat - lat) * scale,
  ];

  // Every point, projected once; the line is then drawn from the finest cell
  // upwards until it fits the point budget. A line is about one point per cell,
  // so the next cell is guessed from how far over it was. Up to `MAX_POINT_STEP`
  // that costs the route nothing visible; beyond it the budget is kept at the
  // price of detail, because the budget is what bounds the cost of a frame.
  const projected = raw.map((place) => ({ point: project(place), segment: place.segment }));
  let cell = MIN_POINT_STEP;
  let segments = thin(projected, cell, boxAspect);
  // The fewest points the route could possibly be drawn with: two for each
  // *recorded* segment (one for a segment that is a single point), since no cell
  // is coarse enough to bridge a gap in the recording. Not the pieces the line has
  // been split into: a hub with a thousand spokes ridden out and back in one
  // recorded run is a thousand two-point pieces at a fine cell, and a coarser
  // cell merges them — it is the recorded runs that set the floor, and only
  // reaching *that* means a coarser cell has nothing left to merge.
  const recordedFloor = (() => {
    const lengths = new Map<number, number>();
    for (const { segment } of projected) lengths.set(segment, (lengths.get(segment) ?? 0) + 1);
    return [...lengths.values()].reduce((sum, length) => sum + Math.min(2, length), 0);
  })();
  for (
    let count = pointCount(segments);
    count > MAX_ROUTE_POINTS && cell < HARD_MAX_STEP && count > recordedFloor;
  ) {
    cell = Math.min(HARD_MAX_STEP, cell * Math.max(1.25, count / MAX_ROUTE_POINTS));
    segments = thin(projected, cell, boxAspect);
    count = pointCount(segments);
  }
  if (pointCount(segments) > MAX_ROUTE_POINTS) segments = thinEvenly(segments, MAX_ROUTE_POINTS);

  return { segments, project };
}
