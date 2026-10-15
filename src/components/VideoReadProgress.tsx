/** How far a video read has got, for the panel below. */
export interface VideoReadProgressState {
  fileName: string;
  fraction: number;
}

/**
 * What a page shows while a video's telemetry is being read: the file's name,
 * how far along, and a way to stop. One component for the two pages that read
 * videos, so the copy and the stop button cannot drift apart.
 */
export function VideoReadProgress({
  progress,
  onCancel,
}: {
  progress: VideoReadProgressState;
  onCancel: () => void;
}) {
  return (
    <section className="prose" aria-label="Reading the video">
      <h3 className="prose__title">Reading {progress.fileName}</h3>
      <p>
        Only the telemetry track is read: the file's index says where it lies, and the picture is
        skipped over rather than loaded, however large the video is.
      </p>
      <progress
        className="video__progress"
        value={progress.fraction}
        max={1}
        aria-label="Extraction progress"
      />
      <p>
        <button type="button" className="button" onClick={onCancel}>
          Stop reading
        </button>
      </p>
    </section>
  );
}
