// Static server for the X-ray scanner.
//   http://localhost:8080        -> testing on this Mac (localhost counts as secure, so the camera works)
//   https://<mac-ip>:8443        -> testing on the iPad (Safari needs HTTPS for the camera)
// The HTTPS cert is self-signed and generated on first run into ./certs.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Only these top-level paths are served; everything else 404s.
const allowed = ['/index.html', '/src/', '/models/', '/media/', '/recordings/', '/node_modules/@mediapipe/tasks-vision/', '/node_modules/three/build/', '/node_modules/three/examples/jsm/', '/manifest.json', '/icon.png'];

function handler(req, res) {
  let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(root, url));
  if (!file.startsWith(root) || !allowed.some((p) => url.startsWith(p))) {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    const headers = {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes',
    };
    // Safari only plays video from servers that answer byte-range requests.
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? +range[1] : 0;
      const end = range[2] ? Math.min(+range[2], data.length - 1) : data.length - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function ensureCert(ips) {
  const dir = path.join(root, 'certs');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const stamp = path.join(dir, 'ips.txt');
  const want = ips.join(',');
  if (fs.existsSync(cert) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) {
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  }
  fs.mkdirSync(dir, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', key, '-out', cert, '-subj', '/CN=xray-scanner', '-addext', `subjectAltName=${san}`,
  ], { stdio: 'ignore' });
  fs.writeFileSync(stamp, want);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const ips = lanAddresses();
http.createServer(handler).listen(HTTP_PORT, () => {
  console.log(`Mac:  http://localhost:${HTTP_PORT}`);
});
https.createServer(ensureCert(ips), handler).listen(HTTPS_PORT, () => {
  for (const ip of ips) console.log(`iPad: https://${ip}:${HTTPS_PORT}`);
});
