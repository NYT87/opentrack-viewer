/**
 * Generates the MP4 fixtures beside this script (`AV-902`).
 *
 * Detection reads boxes, not pictures, so these carry no video at all: an
 * `ftyp` box to identify the container, and enough of a tail to stand in for
 * the `moov` a camera writes at the end. That is the whole surface detection
 * touches, and a real multi-gigabyte recording could not live in a repository.
 *
 * Run `node src/test/fixtures/make-video-fixtures.mjs` after changing this.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** One ISO base media box: a 32-bit length, a four-character type, a payload. */
function box(type, payload = new Uint8Array(0)) {
  const bytes = new Uint8Array(8 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

const ascii = (text) => new TextEncoder().encode(text);

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// major brand, minor version, one compatible brand — what a camera writes.
const ftyp = box('ftyp', concat([ascii('mp41'), new Uint8Array(4), ascii('mp41')]));

/**
 * Padding, so the GoPro markers land in the file's tail rather than its head —
 * which is where a camera actually puts them, and the case detection has to
 * handle by reading from the end.
 */
const filler = box('free', new Uint8Array(2048));

const FIXTURES = {
  // A metadata track whose handler and codec are `gpmd`: the GoPro marker.
  'gopro-with-telemetry.mp4': concat([
    ftyp,
    filler,
    box('moov', concat([ascii('hdlrgpmd'), ascii('GoPro AVC encoder')])),
  ]),
  // The same container with no telemetry track at all.
  'plain-video.mp4': concat([ftyp, filler, box('moov', ascii('hdlrvide'))]),
};

for (const [name, bytes] of Object.entries(FIXTURES)) {
  writeFileSync(join(HERE, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
