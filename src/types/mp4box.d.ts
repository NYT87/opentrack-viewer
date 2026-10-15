/**
 * The slice of `mp4box` this app calls. The package ships no types, and the
 * whole of its surface is far larger than the three calls below.
 */
declare module 'mp4box' {
  export interface Mp4TrackInfo {
    id: number;
    /** The sample entry type, e.g. `avc1.4d402a`, `mp4a.40.2`, `gpmd`. */
    codec: string;
    type: 'video' | 'audio' | 'metadata' | 'subtitles' | string;
    name?: string;
    nb_samples: number;
    movie_duration: number;
    movie_timescale: number;
    duration: number;
    timescale: number;
    created: Date;
    track_width?: number;
    track_height?: number;
  }

  export interface Mp4Info {
    duration: number;
    timescale: number;
    tracks: Mp4TrackInfo[];
  }

  /** What the sample table says about one sample, before any data is read. */
  export interface Mp4SampleInfo {
    number: number;
    offset: number;
    size: number;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
  }

  /** An `ArrayBuffer` tagged with where in the file its bytes came from. */
  export type Mp4Buffer = ArrayBuffer & { fileStart: number };

  export interface Mp4File {
    onReady?: (info: Mp4Info) => void;
    onError?: (error: string) => void;
    appendBuffer(buffer: Mp4Buffer): number;
    getTrackSamplesInfo(trackId: number): Mp4SampleInfo[] | undefined;
    flush(): void;
  }

  export function createFile(): Mp4File;
}
