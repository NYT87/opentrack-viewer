// Prints one line per run from results/*.json, and whether runs that should
// draw the same frames did: every frame's pixel hash compared with the
// reference run's.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
const SAME_AS = { '2d-lag': '2d', '2d-lag-fade': '2d', '2d-redraw': '2d', '3d-again': '3d', '3d-lag': '3d', 'live-2d-again': 'live-2d' };

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const { engine, browserVersion, runs } = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  console.log(`\n${file}: ${engine} ${browserVersion}`);
  for (const [name, r] of Object.entries(runs)) {
    if (name === 'caps') { console.log('  caps', JSON.stringify(r.features), JSON.stringify(r.encode)); continue; }
    if (r.error || !r.cfg) { console.log(`  ${name}: ERROR ${(r.error ?? 'no result').split('\n')[0]}`); continue; }
    const t = r.times;
    let same = '';
    const ref = runs[SAME_AS[name]];
    if (ref?.hashes?.length && r.hashes?.length) {
      const diff = r.hashes.filter((h, i) => h !== ref.hashes[i]).length;
      same = ` | vs ${SAME_AS[name]}: ${diff}/${r.hashes.length} frames differ`;
    }
    console.log(`  ${name}: ${r.cfg.w}x${r.cfg.h} ${r.frames}f ${(r.totalMs / 1000).toFixed(1)}s ${r.fpsRendered} fps (${r.realtimeFactor}x rt)` +
      ` settle p50/p95/max ${t.settle.p50}/${t.settle.p95}/${t.settle.max} capture p50 ${t.capture.p50} encode p50 ${t.encode.p50}` +
      ` | req ${r.requests.total} (${r.requests.unique} unique) ${JSON.stringify(r.requests.byType)} ${(r.transfer.bodyBytes / 1048576).toFixed(1)} MB` +
      ` | out ${(r.outputBytes / 1048576).toFixed(1)} MB | peak RSS ${r.peakRssMB} MB heap ${Math.max(0, ...r.heapMB)} MB${same}` +
      (r.recheck ? ` | recheck [pixels, max delta] ${JSON.stringify(Object.values(r.recheck).map((v) => [v.pixels, v.maxDelta]))}` : ''));
  }
}
