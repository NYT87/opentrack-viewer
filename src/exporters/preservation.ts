import type { Activity } from '../domain/activity';

export function hasStretchesTouchingInFit(activity: Activity): boolean {
  let previous: { second: number; segment: number } | undefined;
  for (const point of activity.points) {
    if (!(point.time instanceof Date) || !Number.isFinite(point.time.getTime())) continue;
    const second = Math.floor(point.time.getTime() / 1000);
    const segment = point.segmentIndex ?? 0;
    if (previous && segment !== previous.segment && second <= previous.second) return true;
    previous = { second, segment };
  }
  return false;
}

/** Shared by availability and serializers; a page handoff must not weaken it. */
export function exportPreservationProblem(activity: Activity, format: 'gpx' | 'fit' | 'tcx'): string | undefined {
  if (format === 'fit' && hasStretchesTouchingInFit(activity)) {
    return 'FIT keeps time to the whole second, and here one recording ends in the same second the next begins: the file could not keep those stretches apart. GPX keeps the two apart.';
  }
  if (format === 'tcx' && activity.source.parserVersion === 'merge-1' &&
      new Set(activity.points.map((point) => point.segmentIndex ?? 0)).size > 1) {
    return 'TCX is written as one lap whose time is the elapsed time, so the pause between the files would count as time spent riding.';
  }
  return undefined;
}
