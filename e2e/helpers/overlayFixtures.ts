/**
 * Shared by the overlay browser tests. The video is the real HERO8 clip, whose
 * container states a start of 2019-11-18T15:41:25Z; the activity is generated to
 * begin at that instant, so a hand-chosen GPX lines up with it at offset zero.
 */
export const HERO8_START = '2019-11-18T15:41:25Z';

export function widestGpx(): string {
  const start = Date.parse(HERO8_START);
  const points = Array.from({ length: 21 }, (_, i) => {
    const time = new Date(start + i * 1000).toISOString().replace('.000Z', 'Z');
    return `<trkpt lat="${(51.5 + i * 0.0003).toFixed(5)}" lon="${(0.001 * i).toFixed(5)}">
        <ele>${1000 + i}</ele><time>${time}</time>
        <extensions><speed>27.8</speed><gpxtpx:TrackPointExtension>
          <gpxtpx:hr>${188 + (i % 3)}</gpxtpx:hr><gpxtpx:cad>${88 + (i % 3)}</gpxtpx:cad>
          <power>${999 + (i % 2)}</power></gpxtpx:TrackPointExtension></extensions></trkpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Widest values</name><type>cycling</type><trkseg>${points.join('')}</trkseg></trk>
</gpx>`;
}
