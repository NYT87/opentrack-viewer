import type { ActivitySensorStream } from '../domain/activity';

export interface SensorStreamPanelProps {
  streams?: ActivitySensorStream[];
}

/**
 * AV-905. Names the telemetry this file carries that the charts do not show.
 *
 * A GoPro writes far more than a route: how the camera was moving, how it was
 * pointed, how it was exposing, even where it thought faces were. Charting all
 * of it would bury the ride under the camera. Dropping it silently would be
 * worse — a reader would have no way to know their file held it, and "this app
 * shows everything in your file" would quietly stop being true.
 *
 * So it is declared and left alone: name, unit, and — for the streams that were
 * actually read — how often the camera wrote it. Nothing here is exported
 * either, which the panel says rather than leaving the reader to discover.
 *
 * A stream that *would* be charted but could not be aligned to the route lands
 * here too, because the parser marks it `hidden` rather than leaving it
 * claiming a chart it cannot have. Otherwise it would fall out of both: the
 * charts skip a stream with no values, and this list skips anything charted.
 */
export function SensorStreamPanel({ streams }: SensorStreamPanelProps) {
  const hidden = (streams ?? []).filter((stream) => stream.display === 'hidden');
  if (hidden.length === 0) return null;

  return (
    <section className="sensor-streams" aria-label="Other telemetry in this file">
      <h3 className="sensor-streams__title">Also in this file</h3>
      <p className="sensor-streams__intro">
        Recorded alongside the route and not charted — most of them describe the camera rather
        than the activity, and the rest could not be lined up with it. None is written to any
        file you export.
      </p>
      <ul className="sensor-streams__list">
        {hidden.map((stream) => (
          <li key={stream.key} className="sensor-streams__item">
            <span className="sensor-streams__label">{stream.label}</span>
            <span className="sensor-streams__detail">{describe(stream)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The unit and rate, where the file establishes them — never guessed. */
function describe(stream: ActivitySensorStream): string {
  const parts: string[] = [];
  if (stream.unit) parts.push(stream.unit);
  if (stream.sampleRateHz !== undefined) parts.push(`${formatRate(stream.sampleRateHz)} Hz`);
  // Absent for a stream that was declared without being read, which is most of
  // them: counting the samples would mean parsing them (TD-034).
  if (stream.sourceSampleCount !== undefined) {
    parts.push(`${stream.sourceSampleCount.toLocaleString()} samples`);
  }
  return parts.join(' · ');
}

function formatRate(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}
