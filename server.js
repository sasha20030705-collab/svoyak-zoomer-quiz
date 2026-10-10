#!/usr/bin/env node
/* ==========================================================================
   Локальный режим «Своей игры» — без интернета и без npm install.
   node server.js  →  http://<IP-этого-мака>:8777

   1) Раздаёт статику этой папки (0.0.0.0:8777) и подставляет в html
      window.SVOYAK_SERVER = { ip, port, ips } — по нему страницы понимают,
      что работают в локальном режиме, и строят ссылки/QR от IP мака.
   2) Релей сообщений с теми же «топиками», что у MQTT:
        GET  /relay/sub?t=a,b,c[&will=…]   — Server-Sent Events (приём)
        POST /relay/pub {topic, payload, retain} — отправка
      «+» — один уровень топика, «#» — всё остальное. retained-сообщения
      отдаются новым подписчикам; will публикуется, когда подписчик отвалился.
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const PORT = Number(process.env.PORT) || 8777;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8',
};

/* ---------- адреса этого компьютера в локальных сетях ---------- */
function describe(name, addr) {
  if (/^172\.20\.10\./.test(addr)) return 'раздача с iPhone (точка доступа / USB)';
  if (/^192\.168\.43\./.test(addr)) return 'раздача с Android-телефона';
  if (/^en0$/.test(name)) return 'Wi-Fi / основная сеть';
  if (/^bridge/.test(name)) return 'раздача интернета с этого мака';
  if (/^en\d+$/.test(name)) return 'USB/Ethernet (в т.ч. телефон-модем по USB)';
  if (/^(utun|ipsec|ppp|tun|tap)/.test(name)) return 'VPN — телефонам обычно не подходит';
  if (/^172\.20\.10\./.test(addr)) return 'раздача с iPhone';
  return 'сеть ' + name;
}
function lanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => (ifs[name] || []).forEach((a) => {
    const v4 = a.family === 'IPv4' || a.family === 4;
    if (v4 && !a.internal && !/^169\.254\./.test(a.address)) out.push({ iface: name, address: a.address, label: describe(name, a.address) });
  }));
  // основной — Wi-Fi/Ethernet, VPN — в конец
  const rank = (x) => (/^en0$/.test(x.iface) ? 0 : /^172\.20\.10\./.test(x.address) ? 1 : /^en\d+$/.test(x.iface) ? 2 : /^bridge/.test(x.iface) ? 3 : /^(utun|ipsec|ppp|tun|tap)/.test(x.iface) ? 9 : 5);
  return out.sort((a, b) => rank(a) - rank(b));
}

/* ---------- релей ---------- */
const subs = new Set();          // { res, patterns, will }
const retained = new Map();      // topic → payload
function matches(pattern, topic) {
  const p = pattern.split('/'), t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] !== '+' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
function publish(topic, payload, retain) {
  if (typeof topic !== 'string' || !topic || topic.length > 300) return;
  if (retain) { if (payload == null) retained.delete(topic); else retained.set(topic, payload); }
  const line = 'data: ' + JSON.stringify({ topic, payload }) + '\n\n';
  subs.forEach((s) => { if (s.patterns.some((p) => matches(p, topic))) { try { s.res.write(line); } catch (e) { /* ignore */ } } });
}
function handleSub(req, res, q) {
  const patterns = String(q.get('t') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
  let will = null;
  try { will = q.get('will') ? JSON.parse(q.get('will')) : null; } catch (e) { will = null; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const sub = { res, patterns, will };
  subs.add(sub);
  retained.forEach((payload, topic) => { if (patterns.some((p) => matches(p, topic))) res.write('data: ' + JSON.stringify({ topic, payload }) + '\n\n'); });
  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 15000);
  req.on('close', () => {
    clearInterval(ka);
    subs.delete(sub);
    if (sub.will && sub.will.topic) publish(sub.will.topic, sub.will.payload, !!sub.will.retain); // «пульт ушёл»
  });
}
function handlePub(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let m = null;
    try { m = JSON.parse(body); } catch (e) { m = null; }
    if (m && m.topic) publish(String(m.topic), m.payload, !!m.retain);
    res.writeHead(m ? 204 : 400, { 'Cache-Control': 'no-store' });
    res.end();
  });
}

/* ---------- статика ---------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); res.end('forbidden'); return; }
  if (/(^|[\\/])(\.git|node_modules|\.playwright-mcp)([\\/]|$)/.test(path.relative(ROOT, file))) { res.writeHead(404); res.end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('не найдено'); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html') {
      fs.readFile(file, 'utf8', (e2, html) => {
        if (e2) { res.writeHead(500); res.end(); return; }
        const ips = lanIps();
        const info = { ip: (ips[0] || {}).address || 'localhost', port: PORT, ips };
        const inject = `<script>window.SVOYAK_SERVER=${JSON.stringify(info)};</script>`;
        html = html.includes('</head>') ? html.replace('</head>', inject + '\n</head>') : inject + html;
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/relay/sub' && req.method === 'GET') return handleSub(req, res, u.searchParams);
  if (u.pathname === '/relay/pub' && req.method === 'POST') return handlePub(req, res);
  if (u.pathname === '/relay/ping') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  serveStatic(req, res, u.pathname);
});
server.keepAliveTimeout = 65000;

/* ---------- QR в терминале (тот же генератор, что в браузере) ---------- */
function terminalQR(text) {
  try {
    const sandbox = { window: {}, TextEncoder, encodeURIComponent, unescape };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/qr.js'), 'utf8'), sandbox);
    const m = sandbox.window.QR.matrix(text, 'M');
    const q = 2, n = m.size + q * 2;
    const dark = (x, y) => x >= q && y >= q && x < n - q && y < n - q && m.get(x - q, y - q);
    let out = '';
    for (let y = 0; y < n; y += 2) {
      let line = '';
      for (let x = 0; x < n; x++) {
        const top = dark(x, y), bot = dark(x, y + 1);
        line += top && bot ? ' ' : top ? '▄' : bot ? '▀' : '█'; // светлый фон, тёмные модули
      }
      out += '  ' + line + '\n';
    }
    return out;
  } catch (e) { return '  (QR не получился: ' + e.message + ')\n'; }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Порт ${PORT} занят. Закрой другой сервер квиза (или запусти: PORT=8778 node server.js).\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIps();
  const main = ips[0] ? ips[0].address : 'localhost';
  console.log('\n  СВОЯК — локальный режим (без интернета)\n');
  console.log(`  Пульт на этом маке:   http://localhost:${PORT}/index.html`);
  if (!ips.length) console.log('  ⚠ Нет локальной сети. Включи Wi-Fi или раздачу с телефона — иначе телефоны не подключатся.');
  ips.forEach((x, i) => {
    console.log(`  ${i === 0 ? '→' : ' '} ${x.iface.padEnd(9)} ${x.address.padEnd(16)} ${x.label}`);
    console.log(`      экран гостей:  http://${x.address}:${PORT}/screen.html`);
  });
  console.log('\n  Все устройства (телефоны гостей, ноутбук у ТВ) должны быть в ОДНОЙ сети с этим маком —');
  console.log('  например, раздай Wi-Fi с телефона и подключи к нему всех. QR для телефонов — на экране гостей.\n');
  if (ips.length) { console.log(`  QR пульта (http://${main}:${PORT}/index.html):`); process.stdout.write(terminalQR(`http://${main}:${PORT}/index.html`)); }
  console.log('\n  Остановить: Ctrl+C\n');
});
