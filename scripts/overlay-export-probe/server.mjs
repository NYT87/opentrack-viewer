// Serves the probe page, the mp4box bundle and the HERO8 fixture. Port 8089 by
// default: WebKit refuses 4190 as a restricted port, which cost an hour to find.
// Supports Range requests, because a <video> element in WebKit will not load
// a file from a server that does not.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, '..', '..');
const port = Number(process.argv[2] ?? process.env.PROBE_PORT ?? 8089);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.mp4': 'video/mp4', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let file;
  if (url.pathname === '/') file = join(here, 'index.html');
  else if (url.pathname === '/vendor/mp4box.all.js') file = join(project, 'node_modules/mp4box/dist/mp4box.all.js');
  else if (url.pathname === '/fixtures/hero8.mp4') file = join(project, 'src/test/fixtures/hero8.mp4');
  else file = join(here, url.pathname.replace(/^\//, ''));
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    const headers = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': body.length });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`probe server on http://localhost:${port}/`));
