import { readFileSync, readdirSync } from 'node:fs';
for (const f of readdirSync(new URL('./results/', import.meta.url)).filter((n) => n.endsWith('.json'))) {
  const r = Object.assign({ features: {}, encoders: {}, decoders: {}, recorder: {}, alpha: {}, perf: {}, decode: {}, errors: [] }, JSON.parse(readFileSync(new URL(`./results/${f}`, import.meta.url), 'utf8')));
  console.log(`\n##### ${r.engine} ${r.browserVersion} (${Math.round(r.wallMs/1000)}s) ua=${r.ua}`);
  console.log('features', JSON.stringify(r.features));
  const enc = Object.entries(r.encoders).filter(([, v]) => typeof v !== 'object' || v.supported).map(([k, v]) => typeof v === 'object' ? `${k}` : `${k}=${v}`);
  console.log('encoders supported:', enc.join(', '));
  console.log('decoders:', JSON.stringify(r.decoders));
  console.log('recorder:', Object.entries(r.recorder).filter(([, v]) => v).map(([k]) => k).join(' | '));
  console.log('alpha:', JSON.stringify(r.alpha));
  for (const [k, v] of Object.entries(r.perf)) console.log('perf', k, JSON.stringify(v));
  console.log('decode:', JSON.stringify(r.decode));
  console.log('errors:', JSON.stringify(r.errors));
}
