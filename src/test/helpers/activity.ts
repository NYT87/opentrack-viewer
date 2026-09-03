import {
  computeStreams,
  type Activity,
  type ActivityPoint,
} from '../../domain/activity';
import { withDerivedStats } from '../../domain/stats';

/** Minimal in-memory activity for tests that should not depend on the parser. */
export function makeActivity(points: Partial<ActivityPoint>[]): Activity {
  const normalized: ActivityPoint[] = points.map((point, index) => ({ index, ...point }));
  return withDerivedStats({
    id: 'test-activity',
    source: { format: 'gpx', parserVersion: 'test' },
    metadata: { name: 'Test activity' },
    points: normalized,
    streams: computeStreams(normalized),
    warnings: [],
  });
}
