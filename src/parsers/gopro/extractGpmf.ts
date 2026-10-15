import { ActivityError } from '../../domain/errors';
import type { Mp4Buffer, Mp4File, Mp4Info, Mp4SampleInfo, Mp4TrackInfo } from 'mp4box';

/**
 * Timing the container reports alongside the payload: how long the video runs,
 * how long a frame lasts, and when each metadata sample begins.
 */
export interface GpmfTiming {
  videoDurationSeconds: number;
  /**
   * The video's frame interval, in seconds — the unit `gopro-telemetry` expects
   * for it. Once named `frameDurationMs` after a library field it passed
   * through, which lied about its unit beside `samples`, whose `cts` really is
   * in milliseconds; renamed so the struct no longer needs prose to be read.
   */
  frameIntervalSeconds: number;
  /** Wall-clock start, where the container states one. */
  start?: Date;
  /** One entry per metadata sample: `cts` is milliseconds from the first frame. */
  samples: { cts: number; duration: number }[];
}

export interface GpmfPayload {
  /** The raw GPMF bytes, still uninterpreted. `AV-904` reads them. */
  rawData: Uint8Array;
  timing: GpmfTiming;
}

export interface ExtractGpmfOptions {
  /** Fraction complete, 0 to 1, as the telemetry is read. */
  onProgress?: (fraction: number) => void;
  /** Aborts the read; the returned promise then rejects. */
  signal?: AbortSignal;
}

/**
 * The part of a `File` the extractor touches. Narrow on purpose: a test can
 * stand in a multi-gigabyte recording with an object that answers `slice` by
 * generating bytes, which is how the large-video simulation runs without a
 * large file anywhere (`AV-906`).
 */
export interface ReadableVideo {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** The longest box header: 32-bit size, type, and a 64-bit size after it. */
const BOX_HEADER_BYTES = 16;

/** A `moov` is tens of kilobytes to a few megabytes. Past this it is not one. */
const MAX_MOOV_BYTES = 256 * 1024 * 1024;

/**
 * A box that is neither `mdat` nor `moov` — `free`, `wide`, `skip`, `uuid` — is
 * padding or vendor data, normally a few bytes. mp4box needs it whole to step
 * past it, so one this large is refused rather than read into memory.
 */
const MAX_OTHER_BOX_BYTES = 16 * 1024 * 1024;

/** More than this is not a video but a file pretending to be one. */
const MAX_TOP_LEVEL_BOXES = 4096;

/**
 * The telemetry of a recording grows at roughly 16 MB an hour. Past this the
 * sample table is wrong, and honouring it would be the memory problem this
 * extractor exists to avoid.
 */
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

/** Limit each telemetry read so Stop is checked even within a contiguous run. */
const MAX_SAMPLE_READ_BYTES = 32 * 1024;

/**
 * AV-903 / AV-906. Pulls the raw GPMF payload out of a GoPro MP4/MOV, in the
 * browser, reading only the bytes that hold it.
 *
 * Everything happens on this device. Nothing is uploaded — not the video, not
 * the payload, not the file's name (plan §5).
 *
 * **Memory is bounded by the telemetry, not the video.** A camera writes the
 * `moov` — the index that says where every sample lives — at the *end* of the
 * file. A reader that streams from the front therefore has to keep every byte
 * until the index arrives, and `mp4box` does exactly that: the large-video
 * simulation measured it holding the whole file, two gigabytes for a
 * two-gigabyte recording (TD-038). So this does not stream. It walks the box
 * headers — sixteen bytes each, skipping the `mdat` by its stated size — hands
 * `mp4box` the index and any later fragments, asks it where the `gpmd` samples are, and reads
 * those ranges and nothing else. An hour of video is a few hundred reads of a
 * few kilobytes each, and the picture is never loaded.
 *
 * The library is loaded on demand: a reader who never opens a video should not
 * download an MP4 demuxer.
 */
export async function extractGpmf(
  file: ReadableVideo,
  options: ExtractGpmfOptions = {},
): Promise<GpmfPayload> {
  const { onProgress, signal } = options;
  // Typed from the first line: a stop pressed while the demuxer is still
  // loading must read as a stop, not as a failure to extract.
  throwIfAborted(signal);

  const boxes = await scanTopLevelBoxes(file, signal);
  const moov = boxes.find((entry) => entry.type === 'moov');
  if (!moov) {
    // Its own code, not `no_telemetry_track`: a container with no index cannot
    // be played either, and a caller that keeps a telemetry-less video as a
    // video (AV-1002) must be able to tell the two apart without reading prose.
    throw new ActivityError(
      'no_video_index',
      'This video has no index of its tracks, so nothing can be read from it. The recording may never have been finished.',
    );
  }
  if (moov.size > MAX_MOOV_BYTES) {
    throw new ActivityError(
      'gopro_extract_failed',
      'The index of this video is implausibly large, so it was not read.',
    );
  }

  const { createFile } = await import('mp4box');
  const info = await describeTracks(createFile(), file, boxes, signal);

  const track = info.tracks.find((entry) => entry.codec === 'gpmd');
  if (!track) {
    throw new ActivityError(
      'no_telemetry_track',
      'This video has no GoPro telemetry track, so there is no activity to read from it.',
    );
  }

  const samples = info.file.getTrackSamplesInfo(track.id) ?? [];
  const video = info.tracks.find((entry) => entry.type === 'video');
  const videoSamples = video ? (info.file.getTrackSamplesInfo(video.id) ?? []) : [];
  const rawData = await readSamples(file, samples, { onProgress, signal });

  return { rawData, timing: toTiming(videoSamples, track, samples) };
}

interface TopLevelBox {
  type: string;
  /** Offset of the box's first byte. */
  start: number;
  /** The whole box, header included. */
  size: number;
  headerSize: number;
}

/**
 * Walks the file's top-level boxes by their headers alone. The `mdat` is
 * skipped by its declared size, which is what makes this cheap: a sixteen-byte
 * read per box, however large the box.
 */
async function scanTopLevelBoxes(
  file: ReadableVideo,
  signal: AbortSignal | undefined,
): Promise<TopLevelBox[]> {
  const boxes: TopLevelBox[] = [];
  let at = 0;

  while (at + 8 <= file.size) {
    throwIfAborted(signal);
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) throw notAContainer();

    const header = new DataView(
      await file.slice(at, Math.min(at + BOX_HEADER_BYTES, file.size)).arrayBuffer(),
    );
    let size = header.getUint32(0);
    const type = fourCC(header, 4);
    let headerSize = 8;

    if (!isBoxType(type)) throw notAContainer();
    if (size === 1) {
      // The 64-bit form, which a recording past 4 GB needs for its `mdat`.
      if (header.byteLength < 16) throw notAContainer();
      size = Number(header.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      // "To the end of the file", permitted for the last box only.
      size = file.size - at;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || at + size > file.size) {
      throw notAContainer();
    }

    boxes.push({ type, start: at, size, headerSize });
    at += size;
  }

  if (boxes.length === 0 || boxes[0]!.type !== 'ftyp') throw notAContainer();
  return boxes;
}

/**
 * Gives `mp4box` every box except the `mdat` payload, which it steps over.
 * Fragments after the `moov` can add samples to its track table.
 */
async function describeTracks(
  mp4: Mp4File,
  file: ReadableVideo,
  boxes: TopLevelBox[],
  signal: AbortSignal | undefined,
): Promise<Mp4Info & { file: Mp4File }> {
  let ready: Mp4Info | undefined;
  let failure: string | undefined;
  mp4.onReady = (info) => {
    ready = info;
  };
  mp4.onError = (error) => {
    failure = error;
  };

  for (const box of boxes) {
    throwIfAborted(signal);
    const isMdat = box.type === 'mdat';
    if (!isMdat && box.type !== 'moov' && box.size > MAX_OTHER_BOX_BYTES) {
      throw new ActivityError(
        'gopro_extract_failed',
        'This video holds an implausibly large box, so it was not read.',
      );
    }
    const end = isMdat ? box.start + box.headerSize : box.start + box.size;
    const buffer = (await file.slice(box.start, end).arrayBuffer()) as Mp4Buffer;
    buffer.fileStart = box.start;
    try {
      mp4.appendBuffer(buffer);
    } catch (error) {
      throw new ActivityError(
        'gopro_extract_failed',
        'The index of this video could not be read.',
        { cause: error },
      );
    }
    if (failure) break;
  }

  if (failure !== undefined || !ready) {
    // Not `no_video_index`: a `moov` was found before this was called, so an
    // index that never becomes ready is one that could not be read, not one
    // that is missing.
    throw new ActivityError(
      'gopro_extract_failed',
      'The index of this video could not be read.',
      failure !== undefined ? { cause: failure } : undefined,
    );
  }
  return { ...ready, file: mp4 };
}

/**
 * Reads the telemetry samples, and only them. Adjacent samples share a run,
 * read in bounded chunks; the gaps between them — the picture — are never
 * touched. Progress is by bytes of telemetry, and Stop is checked per chunk.
 */
async function readSamples(
  file: ReadableVideo,
  samples: Mp4SampleInfo[],
  { onProgress, signal }: ExtractGpmfOptions,
): Promise<Uint8Array> {
  const total = samples.reduce((sum, sample) => sum + sample.size, 0);
  if (total > MAX_PAYLOAD_BYTES) {
    throw new ActivityError(
      'gopro_extract_failed',
      'The telemetry track of this video is implausibly large, so it was not read.',
    );
  }
  for (const sample of samples) {
    if (sample.offset < 0 || sample.offset + sample.size > file.size) {
      throw new ActivityError(
        'gopro_extract_failed',
        'The index of this video points outside the file, so its telemetry could not be read.',
      );
    }
  }

  const rawData = new Uint8Array(total);
  let written = 0;
  onProgress?.(0);

  for (const run of coalesce(samples)) {
    for (let at = run.start; at < run.end; at += MAX_SAMPLE_READ_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(at + MAX_SAMPLE_READ_BYTES, run.end);
      const bytes = new Uint8Array(await file.slice(at, end).arrayBuffer());
      rawData.set(bytes, written);
      written += bytes.length;
      onProgress?.(total === 0 ? 1 : written / total);
    }
  }

  if (written !== total) {
    throw new ActivityError(
      'gopro_extract_failed',
      'The video ended before its telemetry did, so the track could not be read in full.',
    );
  }
  // A stop during the last read arrives after the loop has nothing left to
  // check, and a reader who pressed Stop should not be handed a result.
  throwIfAborted(signal);
  return rawData;
}

/** Contiguous samples become one run before reads are split into bounded chunks. */
function coalesce(samples: Mp4SampleInfo[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  for (const sample of samples) {
    const last = runs.at(-1);
    if (last && last.end === sample.offset) last.end += sample.size;
    else runs.push({ start: sample.offset, end: sample.offset + sample.size });
  }
  return runs;
}

/**
 * The figures `gopro-telemetry` reads beside the payload, in the shape and
 * units the previous extractor handed it, so interpretation is unchanged.
 */
function toTiming(
  videoSamples: Mp4SampleInfo[],
  track: Mp4TrackInfo,
  samples: Mp4SampleInfo[],
): GpmfTiming {
  const videoDurationSeconds = videoSamples.reduce(
    (end, sample) =>
      sample.timescale > 0 ? Math.max(end, (sample.dts + sample.duration) / sample.timescale) : end,
    0,
  );
  const frameIntervalSeconds =
    videoSamples.length > 0 ? videoDurationSeconds / videoSamples.length : 0;

  return {
    videoDurationSeconds,
    frameIntervalSeconds,
    // The track's creation time, as the container states it. The previous
    // extractor shifted it by the *viewer's* time zone, which made the same
    // file read differently in different places.
    ...(track.created instanceof Date && !Number.isNaN(track.created.getTime())
      ? { start: track.created }
      : {}),
    samples: samples.map((sample) => ({
      cts: toMilliseconds(sample.cts, sample.timescale),
      duration: toMilliseconds(sample.duration, sample.timescale),
    })),
  };
}

function toMilliseconds(value: number, timescale: number): number {
  return timescale > 0 ? (value * 1000) / timescale : value;
}

function fourCC(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

/** A box type is four printable ASCII characters; anything else is not MP4. */
function isBoxType(type: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(type);
}

function notAContainer(): ActivityError {
  return new ActivityError(
    'gopro_extract_failed',
    'This file is not an MP4 or MOV container, so no telemetry track could be looked for.',
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ActivityError('extraction_cancelled', 'Reading the video was stopped.');
  }
}
