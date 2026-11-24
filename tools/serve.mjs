import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

// Fixed allowlist: only the application shell is ever served.
const allowed = new Set([
  '/index.html',
  '/styles.css',
  '/sw.js',
  '/favicon.svg',
  '/og-image.png',
  '/src/app.js',
  '/src/viz.js',
  '/src/exports.js',
  '/src/card.js',
  '/src/controls.js',
  '/src/hydrology.js',
  '/src/routing.js',
  '/src/presets.js',
  '/src/mitigation.js',
  '/src/timeline.js',
  '/src/brief.js',
  '/src/sha256.js',
  '/src/selftest.js',
  '/src/buddy.js',
]);

const BASES = ['/', '/floodline/'];

function resolvePath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  for (const base of BASES) {
    if (!pathname.startsWith(base)) continue;
    let rel = pathname.slice(base.length);
    if (base === '/' && pathname.startsWith('/floodline/')) continue;
    if (rel === '') rel = 'index.html';
    const clean = normalize(rel).replace(/^([/\\])+/, '');
    if (clean.startsWith('..') || clean.includes('\0')) return null;
    const served = '/' + clean;
    return allowed.has(served) ? served : null;
  }
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  const served = resolvePath(req.url ?? '/');
  if (served === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  try {
    const body = await readFile(join(root, served));
    res.writeHead(200, {
      'Content-Type': types.get(extname(served)) ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, host, () => {
  const actual = server.address().port;
  console.log(`FloodLine dev server at http://${host}:${actual}/`);
});
