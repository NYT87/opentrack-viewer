import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolved from the project root: under the jsdom environment `import.meta.url`
// is an http URL, so it cannot be used to locate files on disk.
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

/** Builds a File from a fixture so tests exercise the real intake path. */
export function fixtureFile(name: string, type = 'application/gpx+xml'): File {
  return new File([readFixture(name)], name, { type });
}
