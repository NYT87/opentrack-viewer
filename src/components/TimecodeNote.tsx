import { timecodeLine, type SourceTimecode, type TimecodeExport } from '../overlay/timecode';

/**
 * AV-1026 (TD-095). What timecode the export starts at: the source's, with the
 * cut's start added, and what the file can and cannot hold. Plain text, not a
 * live region, so the panel's own status messages stay the ones announced; the semicolon of a drop-frame label is said in words beside it.
 */
export function TimecodeNote({ timecode, kind }: { timecode: SourceTimecode | undefined; kind: TimecodeExport }) {
  return (
    <p className="overlay-controls__hint" data-testid="timecode-note">
      {timecodeLine(timecode, kind)}
    </p>
  );
}
