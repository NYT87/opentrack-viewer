// AV-1001 feasibility probe. Runs in a browser page; the runner reads window.__result.
const out = { ua: navigator.userAgent, features: {}, encoders: {}, decoders: {}, recorder: {}, alpha: {}, perf: {}, decode: {}, errors: [] };
const logEl = document.getElementById('log');
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logEl.textContent += s + '\n'; console.log(s); };
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function safe(name, fn) { log('SECTION', name); try { return await Promise.race([fn(), sleep(/^(alphaWebCodecs|alphaMediaRecorder|drawCost|encodeThroughput|imageSequence|recorderThroughput|decodeHero8)$/.test(name) ? 600000 : 120000).then(() => { throw new Error('section timeout'); })]); } catch (e) { out.errors.push(`${name}: ${e && e.message ? e.message : e}`); log('ERR', name, String(e)); return undefined; } }
const has = (name) => name in self;

function makeCanvas(w, h, offscreen = true) {
  if (offscreen && has('OffscreenCanvas')) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// A route polyline standing in for a map inset.
const ROUTE = Array.from({ length: 2000 }, (_, i) => [Math.sin(i / 90) * 0.4 + i / 2000, Math.cos(i / 130) * 0.4 + 0.5]);

// Overlay frame: HUD text, gauge, route inset, progress bar. Transparent background.
function drawOverlay(ctx, w, h, i) {
  ctx.clearRect(0, 0, w, h);
  const s = w / 1920;
  ctx.font = `${Math.round(96 * s)}px sans-serif`; ctx.fillStyle = 'white'; ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8 * s;
  ctx.fillText(`${(32 + Math.sin(i / 10) * 5).toFixed(1)} km/h`, 60 * s, 40 * s);
  ctx.font = `${Math.round(40 * s)}px sans-serif`;
  ctx.fillText(`${(i / 30 / 60).toFixed(2)} km   ${new Date(i * 33).toISOString().slice(11, 19)}   ${(120 + (i % 40)).toFixed(0)} m`, 60 * s, 150 * s);
  ctx.shadowBlur = 0;
  // gauge
  ctx.lineWidth = 18 * s; ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath(); ctx.arc(w - 220 * s, 200 * s, 120 * s, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke();
  ctx.strokeStyle = '#ff5533';
  ctx.beginPath(); ctx.arc(w - 220 * s, 200 * s, 120 * s, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * ((i % 100) / 100))); ctx.stroke();
  // route inset
  ctx.save(); ctx.translate(60 * s, h - 420 * s); ctx.scale(360 * s, 360 * s);
  ctx.lineWidth = 3 / (360 * s); ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath(); ROUTE.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  const p = ROUTE[i % ROUTE.length]; ctx.fillStyle = '#ff5533'; ctx.beginPath(); ctx.arc(p[0], p[1], 8 / (360 * s), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // progress
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(60 * s, h - 40 * s, w - 120 * s, 10 * s);
  ctx.fillStyle = '#ff5533'; ctx.fillRect(60 * s, h - 40 * s, (w - 120 * s) * ((i % 300) / 300), 10 * s);
}

// A moving, textured background standing in for video content (keeps encoders honest).
function drawBackground(ctx, w, h, i) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(i * 2) % 360},60%,40%)`); g.addColorStop(1, `hsl(${(i * 2 + 120) % 360},60%,20%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 40; k++) {
    ctx.fillStyle = `hsla(${(k * 37 + i) % 360},70%,50%,0.6)`;
    const x = ((k * 97 + i * (3 + (k % 5))) % (w + 200)) - 100; const y = (k * 61) % h;
    ctx.fillRect(x, y, 80 + (k % 7) * 20, 60 + (k % 5) * 20);
  }
}

async function canvasBlobType(type) {
  const c = makeCanvas(8, 8); const ctx = c.getContext('2d'); ctx.fillStyle = 'rgba(255,0,0,0.5)'; ctx.fillRect(0, 0, 8, 8);
  const blob = c.convertToBlob ? await c.convertToBlob({ type }) : await new Promise((r) => c.toBlob(r, type));
  return blob ? blob.type : null;
}

async function features() {
  const v = document.createElement('video');
  const f = {
    VideoEncoder: has('VideoEncoder'), VideoDecoder: has('VideoDecoder'), VideoFrame: has('VideoFrame'),
    AudioEncoder: has('AudioEncoder'), AudioDecoder: has('AudioDecoder'),
    OffscreenCanvas: has('OffscreenCanvas'),
    offscreen2d: (() => { try { return !!new OffscreenCanvas(1, 1).getContext('2d'); } catch { return false; } })(),
    MediaRecorder: has('MediaRecorder'),
    canvasCaptureStream: 'captureStream' in HTMLCanvasElement.prototype,
    videoCaptureStream: 'captureStream' in HTMLMediaElement.prototype || 'mozCaptureStream' in HTMLMediaElement.prototype,
    requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    webgpu: !!navigator.gpu, webgl2: !!document.createElement('canvas').getContext('webgl2'),
    crossOriginIsolated: self.crossOriginIsolated, SharedArrayBuffer: has('SharedArrayBuffer'),
    showSaveFilePicker: has('showSaveFilePicker'), storageGetDirectory: !!(navigator.storage && navigator.storage.getDirectory),
    MediaStreamTrackProcessor: has('MediaStreamTrackProcessor'), MediaStreamTrackGenerator: has('MediaStreamTrackGenerator'),
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
    performanceMemory: !!performance.memory, WebAssembly: has('WebAssembly'),
    ImageDecoder: has('ImageDecoder'),
    blobWebp: await safe('webp', () => canvasBlobType('image/webp')),
    blobPng: await safe('png', () => canvasBlobType('image/png')),
    canPlay: {
      avc: v.canPlayType('video/mp4; codecs="avc1.4d402a"'), avcHigh: v.canPlayType('video/mp4; codecs="avc1.640033"'),
      hevc: v.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'), hev1: v.canPlayType('video/mp4; codecs="hev1.1.6.L153.B0"'),
      vp9webm: v.canPlayType('video/webm; codecs="vp09.00.10.08"'), vp8webm: v.canPlayType('video/webm; codecs="vp8"'),
      av1: v.canPlayType('video/mp4; codecs="av01.0.08M.08"'), aac: v.canPlayType('audio/mp4; codecs="mp4a.40.2"'), opusWebm: v.canPlayType('audio/webm; codecs="opus"'),
    },
  };
  out.features = f;
}

const ENC = [
  ['vp8-1080', { codec: 'vp8', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 }],
  ['vp9-1080', { codec: 'vp09.00.40.08', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 }],
  ['vp9-1080-alpha', { codec: 'vp09.00.40.08', width: 1920, height: 1080, bitrate: 8e6, framerate: 30, alpha: 'keep' }],
  ['vp8-1080-alpha', { codec: 'vp8', width: 1920, height: 1080, bitrate: 8e6, framerate: 30, alpha: 'keep' }],
  ['av1-1080', { codec: 'av01.0.08M.08', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 }],
  ['avc-1080', { codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30, avc: { format: 'avc' } }],
  ['hevc-1080', { codec: 'hvc1.1.6.L123.B0', width: 1920, height: 1080, bitrate: 8e6, framerate: 30, hevc: { format: 'hevc' } }],
  ['vp9-2160', { codec: 'vp09.00.51.08', width: 3840, height: 2160, bitrate: 25e6, framerate: 30 }],
  ['avc-2160', { codec: 'avc1.640033', width: 3840, height: 2160, bitrate: 25e6, framerate: 30, avc: { format: 'avc' } }],
  ['hevc-2160', { codec: 'hvc1.1.6.L153.B0', width: 3840, height: 2160, bitrate: 25e6, framerate: 30, hevc: { format: 'hevc' } }],
];
const DEC = [
  ['avc-480', { codec: 'avc1.4d402a', codedWidth: 848, codedHeight: 480 }],
  ['avc-1080', { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 }],
  ['avc-2160', { codec: 'avc1.640033', codedWidth: 3840, codedHeight: 2160 }],
  ['hevc-2160', { codec: 'hvc1.1.6.L153.B0', codedWidth: 3840, codedHeight: 2160 }],
  ['hev1-2160', { codec: 'hev1.1.6.L153.B0', codedWidth: 3840, codedHeight: 2160 }],
  ['vp9-2160', { codec: 'vp09.00.51.08', codedWidth: 3840, codedHeight: 2160 }],
  ['av1-2160', { codec: 'av01.0.12M.08', codedWidth: 3840, codedHeight: 2160 }],
];
const REC = ['video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=av1', 'video/webm;codecs=h264', 'video/webm;codecs=vp9,opus',
  'video/mp4', 'video/mp4;codecs=avc1', 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs=hvc1', 'video/mp4;codecs=vp9', 'video/mp4;codecs=av1', 'video/x-matroska;codecs=avc1'];

async function configs() {
  if (has('VideoEncoder')) {
    for (const [name, cfg] of ENC) {
      for (const hw of ['no-preference', 'prefer-hardware', 'prefer-software']) {
        const r = await safe(`enc ${name} ${hw}`, () => VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: hw }));
        if (r) out.encoders[`${name}|${hw}`] = { supported: r.supported, alpha: r.config && r.config.alpha, hw: r.config && r.config.hardwareAcceleration };
      }
    }
  }
  if (has('VideoDecoder')) {
    for (const [name, cfg] of DEC) {
      for (const hw of ['no-preference', 'prefer-hardware', 'prefer-software']) {
        const r = await safe(`dec ${name} ${hw}`, () => VideoDecoder.isConfigSupported({ ...cfg, hardwareAcceleration: hw }));
        if (r) out.decoders[`${name}|${hw}`] = r.supported;
      }
    }
  }
  if (has('AudioDecoder')) out.decoders.aac = (await safe('aac', () => AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 })))?.supported;
  if (has('AudioEncoder')) {
    out.encoders.opus = (await safe('opus', () => AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })))?.supported;
    out.encoders.aac = (await safe('aacenc', () => AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })))?.supported;
  }
  if (has('MediaRecorder')) for (const t of REC) out.recorder[t] = MediaRecorder.isTypeSupported(t);
}

// --- Alpha: does WebCodecs keep it? Encode transparent frames, decode, inspect format.
async function alphaWebCodecs() {
  if (!has('VideoEncoder') || !has('VideoDecoder')) return;
  for (const codec of ['vp09.00.40.08', 'vp8']) {
    await safe(`alpha ${codec}`, async () => {
      const cfg = { codec, width: 640, height: 360, bitrate: 2e6, framerate: 30, alpha: 'keep' };
      const sup = await VideoEncoder.isConfigSupported(cfg);
      const rec = { configSupported: sup.supported, alphaEchoed: sup.config && sup.config.alpha };
      if (!sup.supported) { out.alpha[`webcodecs ${codec}`] = rec; return; }
      const chunks = [];
      const enc = new VideoEncoder({ output: (c, m) => chunks.push({ c, m }), error: (e) => { throw e; } });
      enc.configure(cfg);
      const canvas = makeCanvas(640, 360); const ctx = canvas.getContext('2d');
      for (let i = 0; i < 6; i++) {
        ctx.clearRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.fillRect(100 + i * 10, 100, 200, 100);
        const frame = new VideoFrame(canvas, { timestamp: i * 33333, alpha: 'keep' });
        enc.encode(frame, { keyFrame: i === 0 }); frame.close();
      }
      await enc.flush(); enc.close();
      rec.chunks = chunks.length; rec.chunkHasAlphaSideData = chunks.length ? ('alphaSideData' in (chunks[0].m || {})) : null;
      rec.inputFrameFormat = (() => { const fr = new VideoFrame(canvas, { timestamp: 0, alpha: 'keep' }); const f = fr.format; fr.close(); return f; })();
      // decode back
      const formats = [];
      const dec = new VideoDecoder({ output: (f) => { formats.push(f.format); f.close(); }, error: (e) => { throw e; } });
      const dcfg = { codec, codedWidth: 640, codedHeight: 360 };
      if (chunks[0].m && chunks[0].m.decoderConfig) Object.assign(dcfg, chunks[0].m.decoderConfig);
      dec.configure(dcfg);
      for (const { c } of chunks) dec.decode(c);
      await dec.flush(); dec.close();
      rec.decodedFormats = [...new Set(formats)];
      out.alpha[`webcodecs ${codec}`] = rec;
    });
  }
}

// --- Alpha: does MediaRecorder keep it? Record a transparent canvas, play it back over magenta.
async function alphaMediaRecorder() {
  if (!has('MediaRecorder') || !('captureStream' in HTMLCanvasElement.prototype)) return;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) { out.alpha.mediaRecorder = { mime: null }; return; }
  await safe('alpha recorder', async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d', { alpha: true });
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4e6 });
    const parts = []; rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(100);
    let i = 0; const t0 = now();
    while (now() - t0 < 2000) { ctx.clearRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.fillRect(100 + (i++ % 50), 100, 200, 100); await sleep(33); }
    rec.stop(); await stopped;
    const blob = new Blob(parts, { type: mime });
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; document.body.appendChild(video);
    video.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('playback failed ' + mime)); });
    await video.play(); await sleep(600); video.pause();
    const probe = document.createElement('canvas'); probe.width = 640; probe.height = 360; const pc = probe.getContext('2d');
    pc.fillStyle = '#ff00ff'; pc.fillRect(0, 0, 640, 360); pc.drawImage(video, 0, 0, 640, 360);
    const corner = Array.from(pc.getImageData(600, 330, 1, 1).data);
    const inside = Array.from(pc.getImageData(180, 150, 1, 1).data);
    out.alpha.mediaRecorder = { mime, bytes: blob.size, transparentPixel: corner, opaquePixel: inside, alphaPreserved: corner[0] > 200 && corner[1] < 60 && corner[2] > 200 };
    video.remove(); canvas.remove();
  });
}

// --- Throughput: overlay draw cost.
async function drawCost() {
  for (const [w, h, n] of [[1920, 1080, 300], [3840, 2160, 60]]) {
    await safe(`draw ${w}`, async () => {
      const c = makeCanvas(w, h); const ctx = c.getContext('2d');
      const t0 = now(); for (let i = 0; i < n; i++) drawOverlay(ctx, w, h, i);
      // force completion of the GPU queue
      ctx.getImageData(0, 0, 1, 1);
      out.perf[`drawOverlay ${w}x${h}`] = { frames: n, msPerFrame: +((now() - t0) / n).toFixed(2), offscreen: c instanceof OffscreenCanvas };
    });
  }
}

// --- Throughput: WebCodecs encode of composited frames (background + overlay).
async function encodeThroughput() {
  if (!has('VideoEncoder')) return;
  const runs = [
    ['vp9-1080', ENC[1][1], 150], ['vp8-1080', ENC[0][1], 150], ['avc-1080', ENC[5][1], 150], ['av1-1080', ENC[4][1], 90], ['hevc-1080', ENC[6][1], 150],
    ['vp9-2160', ENC[7][1], 45], ['avc-2160', ENC[8][1], 45], ['hevc-2160', ENC[9][1], 45],
  ];
  for (const [name, cfg, n] of runs) {
    for (const hw of ['prefer-hardware', 'prefer-software']) {
      await safe(`encode ${name} ${hw}`, async () => {
        const full = { ...cfg, hardwareAcceleration: hw, latencyMode: 'quality' };
        const sup = await VideoEncoder.isConfigSupported(full);
        if (!sup.supported) { out.perf[`encode ${name}|${hw}`] = { supported: false }; return; }
        const { width: w, height: h } = cfg;
        const bg = makeCanvas(w, h); const bctx = bg.getContext('2d');
        const ov = makeCanvas(w, h); const octx = ov.getContext('2d');
        let bytes = 0, chunks = 0, maxQ = 0;
        const enc = new VideoEncoder({ output: (c) => { bytes += c.byteLength; chunks++; }, error: (e) => { throw e; } });
        enc.configure(full);
        const mem0 = performance.memory ? performance.memory.usedJSHeapSize : undefined;
        const t0 = now(); let i = 0, drawMs = 0;
        for (; i < n; i++) {
          const d0 = now();
          drawBackground(bctx, w, h, i); drawOverlay(octx, w, h, i); bctx.drawImage(ov, 0, 0);
          drawMs += now() - d0;
          const frame = new VideoFrame(bg, { timestamp: Math.round(i * 1e6 / 30), duration: Math.round(1e6 / 30) });
          enc.encode(frame, { keyFrame: i % 60 === 0 }); frame.close();
          maxQ = Math.max(maxQ, enc.encodeQueueSize);
          while (enc.encodeQueueSize > 8) await sleep(1);
          if (now() - t0 > 25000) { i++; break; }
        }
        await enc.flush(); const ms = now() - t0; enc.close();
        out.perf[`encode ${name}|${hw}`] = { supported: true, frames: i, chunks, fps: +(i / (ms / 1000)).toFixed(1), msPerFrame: +(ms / i).toFixed(1), drawMsPerFrame: +(drawMs / i).toFixed(1), kbPerSecondOfVideo: Math.round(bytes / (i / 30) / 1024), maxQueue: maxQ, heapDeltaMB: performance.memory ? +((performance.memory.usedJSHeapSize - mem0) / 1048576).toFixed(1) : undefined };
      });
    }
  }
}

// --- Throughput: image sequence (PNG, WebP) of transparent overlay frames.
async function imageSequence() {
  for (const type of ['image/png', 'image/webp']) {
    await safe(`seq ${type}`, async () => {
      const w = 1920, h = 1080, n = 30; const c = makeCanvas(w, h); const ctx = c.getContext('2d');
      let bytes = 0; const t0 = now();
      for (let i = 0; i < n; i++) {
        drawOverlay(ctx, w, h, i);
        const blob = c.convertToBlob ? await c.convertToBlob({ type }) : await new Promise((r) => c.toBlob(r, type));
        if (blob.type !== type) { out.perf[`sequence ${type}`] = { supported: false, got: blob.type }; return; }
        bytes += blob.size;
      }
      out.perf[`sequence ${type}`] = { supported: true, msPerFrame: +((now() - t0) / n).toFixed(1), kbPerFrame: Math.round(bytes / n / 1024) };
    });
  }
}

// --- Real-time path: canvas.captureStream + MediaRecorder at 1080p.
async function recorderThroughput() {
  if (!has('MediaRecorder') || !('captureStream' in HTMLCanvasElement.prototype)) return;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) return;
  await safe('recorder 1080', async () => {
    const w = 1920, h = 1080; const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d'); const ov = makeCanvas(w, h); const octx = ov.getContext('2d');
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
    const parts = []; rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(250);
    let i = 0; const t0 = now();
    await new Promise((done) => { const tick = () => { drawBackground(ctx, w, h, i); drawOverlay(octx, w, h, i); ctx.drawImage(ov, 0, 0); i++; if (now() - t0 < 5000) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
    rec.stop(); await stopped; const ms = now() - t0;
    const blob = new Blob(parts, { type: mime });
    const video = document.createElement('video'); video.muted = true; video.src = URL.createObjectURL(blob);
    const duration = await new Promise((r) => { video.onloadedmetadata = () => r(video.duration); video.onerror = () => r(null); setTimeout(() => r('timeout'), 4000); });
    out.perf[`recorder 1080|${mime}`] = { framesDrawn: i, drawFps: +(i / (ms / 1000)).toFixed(1), bytes: blob.size, kbPerSecondOfVideo: Math.round(blob.size / (ms / 1000) / 1024), reportedDuration: String(duration) };
    canvas.remove();
  });
}

// --- Decode the real HERO8 clip: WebCodecs (via mp4box demux) and the <video> element path.
function avcDescription(file, trackId, buf) {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) return new Uint8Array(buf, box.start + box.hdr_size, box.size - box.hdr_size);
  }
}
async function decodeHero8() {
  const buf = await (await fetch('/fixtures/hero8.mp4')).arrayBuffer();
  out.decode.fileBytes = buf.byteLength;
  await safe('webcodecs decode', async () => {
    if (!has('VideoDecoder')) { out.decode.webcodecs = { available: false }; return; }
    const file = MP4Box.createFile(); const samples = []; let info;
    const ready = new Promise((res, rej) => { file.onReady = (i) => { info = i; res(); }; file.onError = rej; });
    file.onSamples = (id, user, s) => samples.push(...s);
    buf.fileStart = 0; file.appendBuffer(buf); file.flush(); await ready;
    const track = info.videoTracks[0];
    file.setExtractionOptions(track.id, null, { nbSamples: 1000 }); file.start(); file.flush();
    const cfg = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description: avcDescription(file, track.id, buf) };
    const sup = await VideoDecoder.isConfigSupported(cfg);
    if (!sup.supported) { out.decode.webcodecs = { available: true, codec: track.codec, supported: false, samples: samples.length }; return; }
    let frames = 0; const t0 = now();
    const dec = new VideoDecoder({ output: (f) => { frames++; f.close(); }, error: (e) => { throw e; } });
    dec.configure(cfg);
    for (const s of samples) dec.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / s.timescale), duration: Math.round(s.duration * 1e6 / s.timescale), data: s.data }));
    await dec.flush(); const ms = now() - t0; dec.close();
    out.decode.webcodecs = { available: true, codec: track.codec, supported: true, samples: samples.length, frames, fps: +(frames / (ms / 1000)).toFixed(0), size: `${track.video.width}x${track.video.height}` };

    // Burned-in chain: decode -> composite overlay -> encode, at the clip's own size.
    for (const [name, codec, extra] of [['vp9', 'vp09.00.31.08', {}], ['avc', 'avc1.4d402a', { avc: { format: 'avc' } }]]) {
      await safe(`burn ${name}`, async () => {
        if (!has('VideoEncoder')) return;
        const ecfg = { codec, width: track.video.width, height: track.video.height, bitrate: 4e6, framerate: 30, ...extra };
        if (!(await VideoEncoder.isConfigSupported(ecfg)).supported) { out.decode[`burnedIn ${name}`] = { supported: false }; return; }
        const w = track.video.width, h = track.video.height; const c = makeCanvas(w, h); const ctx = c.getContext('2d'); const ov = makeCanvas(w, h); const octx = ov.getContext('2d');
        let outBytes = 0, outChunks = 0, n = 0; const t1 = now();
        const enc = new VideoEncoder({ output: (ch) => { outBytes += ch.byteLength; outChunks++; }, error: (e) => { throw e; } });
        enc.configure(ecfg);
        const dec2 = new VideoDecoder({ output: (f) => { ctx.drawImage(f, 0, 0); drawOverlay(octx, w, h, n); ctx.drawImage(ov, 0, 0); const vf = new VideoFrame(c, { timestamp: f.timestamp, duration: f.duration ?? undefined }); enc.encode(vf, { keyFrame: n % 60 === 0 }); vf.close(); f.close(); n++; }, error: (e) => { throw e; } });
        dec2.configure(cfg);
        for (const s of samples) { dec2.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / s.timescale), duration: Math.round(s.duration * 1e6 / s.timescale), data: s.data })); while (dec2.decodeQueueSize > 8 || enc.encodeQueueSize > 8) await sleep(1); }
        await dec2.flush(); await enc.flush(); const ms = now() - t1; dec2.close(); enc.close();
        out.decode[`burnedIn ${name}`] = { supported: true, frames: n, chunks: outChunks, fps: +(n / (ms / 1000)).toFixed(1), realtimeFactor: +((12.65 * 1000) / ms).toFixed(1), kbPerSecondOfVideo: Math.round(outBytes / (n / 30) / 1024) };
      });
    }
  });
  await safe('video element', async () => {
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; document.body.appendChild(video);
    video.src = '/fixtures/hero8.mp4';
    const ok = await new Promise((r) => { video.onloadedmetadata = () => r(true); video.onerror = () => r(false); setTimeout(() => r(false), 5000); });
    if (!ok) { out.decode.videoElement = { playable: false }; return; }
    let cs = null; try { cs = video.captureStream ? video.captureStream() : video.mozCaptureStream ? video.mozCaptureStream() : null; } catch (e) { out.errors.push('captureStream: ' + e.message); }
    const c = makeCanvas(video.videoWidth, video.videoHeight); const ctx = c.getContext('2d');
    let rvfc = 0; const t0 = now();
    if ('requestVideoFrameCallback' in video) { const cb = () => { rvfc++; ctx.drawImage(video, 0, 0); if (!video.ended) video.requestVideoFrameCallback(cb); }; video.requestVideoFrameCallback(cb); }
    await video.play(); await sleep(500); const audioTracks = cs ? cs.getAudioTracks().length : null; const videoTracks = cs ? cs.getVideoTracks().length : null; await new Promise((r) => { video.onended = r; setTimeout(r, 20000); });
    const ms = now() - t0; const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const presented = q ? q.totalVideoFrames - q.droppedVideoFrames : null;
    out.decode.videoElement = { playable: true, duration: video.duration, wallMs: Math.round(ms), rvfcFrames: rvfc, totalFrames: q && q.totalVideoFrames, dropped: q && q.droppedVideoFrames, presented, audioTracks, videoTracks, size: `${video.videoWidth}x${video.videoHeight}` };
    video.remove();
  });
}

const only = new URLSearchParams(location.search).get('only');
window.__result = out;
(async () => {
  const t0 = now();
  if (only === 'decode') { await decodeHero8(); window.__result = out; window.__done = true; log('DONE decode only'); return; }
  await safe('features', features);
  await safe('configs', configs);
  await safe('alphaWebCodecs', alphaWebCodecs);
  await safe('alphaMediaRecorder', alphaMediaRecorder);
  await safe('drawCost', drawCost);
  await safe('encodeThroughput', encodeThroughput);
  await safe('imageSequence', imageSequence);
  await safe('recorderThroughput', recorderThroughput);
  await safe('decodeHero8', decodeHero8);
  out.totalMs = Math.round(now() - t0);
  window.__result = out; window.__done = true;
  log('DONE', out.totalMs);
})();
