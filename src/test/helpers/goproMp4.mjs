/**
 * `AV-906`. Builds a minimal but *real* MP4 around a GPMF payload: an `ftyp`,
 * an `mdat` holding the payload (and, optionally, filler standing in for the
 * picture), and a `moov` at the end — where a camera writes it — declaring a
 * video track and a `gpmd` metadata track whose samples are the payload's
 * `DEVC` chunks.
 *
 * Two things use it. `make-video-fixtures.mjs` writes `hero7-synthetic.mp4`,
 * so a browser test can open a video with a real satellite fix through the
 * telemetry page — GoPro ships no outdoor sample small enough to commit. And
 * the large-video simulation streams one of these with gigabytes of filler
 * that is generated as it is read and never held, so the extractor's memory
 * can be measured against a file that does not exist on disk.
 *
 * Plain JS so the fixture generator can run it under Node directly, like the
 * FIT one; vitest imports it the same way. It is hand-written, not borrowed
 * from `mp4box`, for the same reason the FIT encoder is: a fixture built by the
 * library that reads it would agree with that library's bugs.
 */

const encoder = new TextEncoder();
const ascii = (text) => encoder.encode(text);

/** One ISO base media box: 32-bit size, four-character type, payload. */
export function box(type, ...payloads) {
  const payload = concat(payloads);
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(ascii(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

/** A full box: version and flags before the payload. */
function fullBox(type, version, flags, ...payloads) {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >> 16) & 0xff;
  head[2] = (flags >> 8) & 0xff;
  head[3] = flags & 0xff;
  return box(type, head, ...payloads);
}

export function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u32 = (...values) => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
};
const u16 = (...values) => {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value));
  return bytes;
};
const zeros = (count) => new Uint8Array(count);

/**
 * Splits a GPMF payload into its `DEVC` chunks: each is one metadata sample,
 * which is how a camera stores them in the track.
 */
export function splitDevcChunks(payload) {
  const chunks = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let at = 0;
  while (at + 8 <= payload.length) {
    const key = String.fromCharCode(...payload.subarray(at, at + 4));
    if (key !== 'DEVC') throw new Error(`Expected DEVC at ${at}, found ${key}`);
    const size = payload[at + 5];
    const repeat = view.getUint16(at + 6);
    const length = 8 + ((size * repeat + 3) & ~3);
    chunks.push(payload.subarray(at, at + length));
    at += length;
  }
  return chunks;
}

/** Seconds between the MP4 epoch (1904) and the Unix one. */
const MP4_EPOCH_OFFSET = 2_082_844_800;

/**
 * Lays out the file: `[ftyp][mdat: samples, filler][moov]`.
 *
 * Returns the parts separately so a caller can stream the filler rather than
 * allocate it: `head` is everything before the filler, `tail` the `moov`, and
 * `fillerBytes` how many zero bytes belong between them.
 */
export function layoutGoproMp4({
  payload,
  fillerBytes = 0,
  /**
   * Zero bytes before each sample, standing in for the second of picture a
   * camera writes between one telemetry sample and the next. With a gap the
   * samples are separate reads, as they are in a real recording.
   */
  gapBytes = 0,
  sampleDurationMs = 1001,
  videoFrames = 0,
  createdAt = new Date('2024-06-01T10:00:00Z'),
}) {
  const samples = splitDevcChunks(payload);
  const sampleData = concat(samples.flatMap((sample) => [zeros(gapBytes), sample]));
  const ftyp = box('ftyp', ascii('mp41'), u32(0), ascii('mp41'));
  const mdatSize = 8 + sampleData.length + fillerBytes;
  const mdatHeader =
    mdatSize <= 0xffffffff
      ? concat([u32(mdatSize), ascii('mdat')])
      : // A large mdat uses the 64-bit size form: size 1, then the real size.
        concat([u32(1), ascii('mdat'), u64(mdatSize + 8)]);
  const dataOffset = ftyp.length + mdatHeader.length;

  const timescale = 1000;
  const durationMs = samples.length * sampleDurationMs;
  const created = Math.floor(createdAt.getTime() / 1000) + MP4_EPOCH_OFFSET;

  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(created, created, timescale, durationMs),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    zeros(10),
    u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000), // unity matrix
    zeros(24), // pre-defined
    u32(3), // next track id
  );

  const trackHeader = (id, duration, width, height) =>
    fullBox(
      'tkhd',
      0,
      0x000007,
      u32(created, created, id, 0, duration),
      zeros(8),
      u16(0, 0, 0, 0), // layer, alternate group, volume, reserved
      u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000),
      u32(width << 16, height << 16),
    );

  const mediaHeader = (scale, duration) =>
    fullBox('mdhd', 0, 0, u32(created, created, scale, duration), u16(0x55c4, 0)); // 'und'

  const handler = (kind, name) =>
    fullBox('hdlr', 0, 0, u32(0), ascii(kind), zeros(12), ascii(`${name}\0`));

  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

  // One chunk per sample when they are spread out, one chunk for all of them
  // when they are not; either way the offsets say exactly where each lives.
  const sampleTable = (entry, sizes, delta, offsets) =>
    box(
      'stbl',
      fullBox('stsd', 0, 0, u32(1), entry),
      fullBox('stts', 0, 0, u32(1), u32(sizes.length, delta)),
      offsets.length === 1
        ? fullBox('stsc', 0, 0, u32(1), u32(1, sizes.length, 1))
        : fullBox('stsc', 0, 0, u32(1), u32(1, 1, 1)),
      fullBox('stsz', 0, 0, u32(0, sizes.length), u32(...sizes)),
      fullBox('stco', 0, 0, u32(offsets.length), u32(...offsets)),
    );

  // Where each telemetry sample starts: after its gap, after the one before.
  const sampleOffsets = [];
  let cursor = dataOffset;
  for (const sample of samples) {
    cursor += gapBytes;
    sampleOffsets.push(cursor);
    cursor += sample.length;
  }

  // The metadata track, exactly as mp4box reports a camera's: handler
  // `meta`, sample entry type `gpmd`, which is what makes `codec == 'gpmd'`.
  const gpmdEntry = box('gpmd', zeros(6), u16(1));
  const metaTrack = box(
    'trak',
    trackHeader(1, durationMs, 0, 0),
    box(
      'mdia',
      mediaHeader(timescale, durationMs),
      handler('meta', 'GoPro MET'),
      box(
        'minf',
        box('gmhd', fullBox('gmin', 0, 0, u16(0x40, 0x8000, 0x8000, 0x8000, 0))),
        dinf,
        sampleTable(
          gpmdEntry,
          samples.map((sample) => sample.length),
          sampleDurationMs,
          gapBytes > 0 ? sampleOffsets : [dataOffset],
        ),
      ),
    ),
  );

  // A video track with no picture data: zero-sized frames, enough for the
  // extractor to derive a duration and a frame rate.
  const frames = Math.max(videoFrames, samples.length);
  const videoScale = 30_000;
  const frameDuration = Math.round((durationMs / frames) * (videoScale / 1000));
  const avcC = box('avcC', new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe0, 0]));
  const avc1 = box(
    'avc1',
    zeros(6),
    u16(1), // data reference index
    zeros(16),
    u16(1920, 1080),
    u32(0x00480000, 0x00480000), // 72 dpi
    u32(0),
    u16(1), // frame count
    zeros(32), // compressor name
    u16(0x0018, 0xffff),
    avcC,
  );
  const videoTrack = box(
    'trak',
    trackHeader(2, durationMs, 1920, 1080),
    box(
      'mdia',
      mediaHeader(videoScale, frames * frameDuration),
      handler('vide', 'GoPro AVC'),
      box(
        'minf',
        fullBox('vmhd', 0, 1, zeros(8)),
        dinf,
        sampleTable(avc1, new Array(frames).fill(0), frameDuration, [dataOffset]),
      ),
    ),
  );

  const moov = box('moov', mvhd, videoTrack, metaTrack, box('udta', box('FIRM', ascii('HD7.01.01.90.00'))));

  return {
    head: concat([ftyp, mdatHeader, sampleData]),
    fillerBytes,
    tail: moov,
    sampleCount: samples.length,
  };
}

function u64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

/** The whole file in memory, for fixtures small enough to commit. */
export function buildGoproMp4(options) {
  const { head, fillerBytes, tail } = layoutGoproMp4(options);
  return concat([head, zeros(fillerBytes), tail]);
}
