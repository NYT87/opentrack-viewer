import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface Mp4TrackSummary {
  type: 'video' | 'audio' | string;
  codec: string;
  width?: number;
  height?: number;
  durationSeconds: number;
  sampleCount: number;
}

export interface Mp4Summary {
  durationSeconds: number;
  tracks: Mp4TrackSummary[];
}

/** Reads an MP4's tracks the way the app's own telemetry reader does: with mp4box. */
export function readMp4(bytes: Buffer): Promise<Mp4Summary> {
  const MP4Box = require('mp4box') as {
    createFile(): {
      onReady: (info: {
        duration: number;
        timescale: number;
        tracks: {
          type?: string;
          codec: string;
          video?: { width: number; height: number };
          duration: number;
          timescale: number;
          nb_samples: number;
          id: number;
        }[];
      }) => void;
      onError: (error: unknown) => void;
      appendBuffer(buffer: ArrayBuffer & { fileStart?: number }): number;
      flush(): void;
    };
  };
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    file.onError = reject;
    file.onReady = (info) =>
      resolve({
        durationSeconds: info.duration / info.timescale,
        tracks: info.tracks.map((track) => ({
          type: track.type ?? (track.video ? 'video' : 'audio'),
          codec: track.codec,
          width: track.video?.width,
          height: track.video?.height,
          durationSeconds: track.duration / track.timescale,
          sampleCount: track.nb_samples,
        })),
      });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer & {
      fileStart?: number;
    };
    buffer.fileStart = 0;
    file.appendBuffer(buffer);
    file.flush();
  });
}
