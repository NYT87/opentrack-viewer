import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolved from the project root: under the jsdom environment `import.meta.url`
// is an http URL, so it cannot be used to locate files on disk.
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

/**
 * Reads a binary fixture, such as the generated `.fit` files.
 *
 * The bytes are copied into an `ArrayBuffer` allocated here rather than handing
 * back Node's own: under jsdom the two realms have different `ArrayBuffer`
 * constructors, and code that checks `instanceof ArrayBuffer` — including the
 * FIT library — would not recognize a buffer created by `readFileSync`. A real
 * browser reading a real `File` never has this problem.
 */
export function readBinaryFixture(name: string): ArrayBuffer {
  const bytes = readFileSync(join(FIXTURE_DIR, name));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Builds a File from a binary fixture so tests exercise the real intake path. */
export function binaryFixtureFile(name: string, type = 'application/octet-stream'): File {
  return new File([readBinaryFixture(name)], name, { type });
}

/** Builds a File from a fixture so tests exercise the real intake path. */
export function fixtureFile(name: string, type = 'application/gpx+xml'): File {
  return new File([readFixture(name)], name, { type });
}
