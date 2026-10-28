'use strict';
/*
 * Market DNA V1 — HTTP API ve SSE (zero-dependency, node:http).
 * - REST: durum, coin seçimi, ayarlar, oturum sonu, hafıza, katalog, denetim dosyaları.
 * - SSE: /api/stream canlı olay akışı (dnaEvent, episode, motif, state, status, log).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function createServer(session, opts = {}) {
  const clients = new Set();   // SSE response'ları

  function broadcast(channel, data) {
    const payload = `event: ${channel}\ndata: ${JSON.stringify({ channel, data, ts: Date.now() })}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch (_) { clients.delete(res); }
    }
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ hello: 'market-dna', ts: Date.now() })}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify({ channel: 'state', data: session.publicSnapshot(), ts: Date.now() })}\n\n`);
      clients.add(res);
      session.clientConnected();
      const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch (_) {} }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); session.clientDisconnected(); });
      return;
    }

    if (req.method === 'GET') {
      if (p === '/health') return json(res, { ok: true, phase: session.phase, symbol: session.active?.symbol || session.lastSymbol || null, ts: Date.now() });
      if (p === '/api/state') return json(res, session.publicSnapshot());
      if (p === '/api/coins') return json(res, { coins: config.defaultCoins });
      if (p === '/api/settings') return json(res, { background: session.background, disconnectGraceMs: config.session.disconnectGraceMs, sessionGapMs: config.session.sessionGapMs });
      if (p.startsWith('/api/memory/')) {
        const sym = decodeURIComponent(p.split('/')[3] || '').toUpperCase();
        const mem = new (require('../memory/coin-memory').CoinMemory)(sym, config.dataDir);
        const loaded = mem.load();
        const recent = mem.loadRecentEpisodes().slice(-50);
        return json(res, { ...mem.info(), recovered: loaded.recovered, recentEpisodeCount: recent.length });
      }
      if (p === '/api/audit') {
        const dir = path.join(config.auditDir, 'live');
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.json')).map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; }); } catch (_) {}
        return json(res, { files });
      }
      // statik dosyalar
      return serveStatic(p, res);
    }

    if (req.method === 'POST') {
      readBody(req).then((body) => {
        try {
          if (p === '/api/coin') {
            const st = session.startCoin(body.symbol);
            return json(res, { ok: true, state: st });
          }
          if (p === '/api/settings') {
            const background = session.setBackground(body.background);
            return json(res, { ok: true, background });
          }
          if (p === '/api/session/end') {
            session.endSession();
            return json(res, { ok: true });
          }
          return json(res, { error: 'bilinmeyen uç nokta' }, 404);
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      });
      return;
    }
    return json(res, { error: 'method not allowed' }, 405);
  });

  function serveStatic(p, res) {
    let file = p === '/' ? '/index.html' : p;
    const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(config.server.staticDir, safe);
    if (!full.startsWith(config.server.staticDir)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  function json(res, obj, code = 200) {
    const data = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
    });
  }

  return { server, broadcast, clientCount: () => clients.size };
}

module.exports = { createServer };
