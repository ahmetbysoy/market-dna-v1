#!/usr/bin/env node
/*
 * Market DNA V1 — FAZ 1 gerçek bağlantı testi.
 * Zero-dependency (Node >= 22 native WebSocket).
 * Her kaynağa GERÇEK bağlanır, gerçek mesajları sayar, örnekler ve kanıt dosyasına yazar.
 * Sahte veri üretmez: bağlanılamayan kaynak "FAIL" olarak raporlanır.
 *
 * Kullanım: node scripts/test-connectivity.js [saniye=12] [symbol=BTCUSDT]
 * Çıktı: audit/live/connectivity-<ts>.json ve connectivity-<ts>.md
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'audit', 'live');
const DUR = Math.max(5, Number(process.argv[2]) || 12);
const SYMBOL = (process.argv[3] || 'BTCUSDT').toUpperCase();

function log(...a) { console.log(...a); }

function nowIso() { return new Date().toISOString(); }

/** Tek bir WSS hedefini test eder. */
function testWss(name, url, subscribeMsg, classify, timeoutMs, opts) {
  return new Promise((resolve) => {
    const res = {
      name, url, ok: false, connected: false, subscribed: false,
      connectMs: null, firstMsgMs: null, durationMs: timeoutMs,
      counts: {}, total: 0, samples: {}, errors: [], pingSent: 0, pongReceived: 0,
    };
    const t0 = Date.now();
    let ws;
    let pinger = null;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      res.errors.push('constructor: ' + e.message);
      return finish();
    }
    let done = false;
    function finish() {
      if (done) return; done = true;
      if (pinger) { clearInterval(pinger); pinger = null; }
      try { ws && ws.close(); } catch (_) {}
      res.elapsedWallMs = Date.now() - t0;
      resolve(res);
    }
    const watchdog = setTimeout(finish, timeoutMs);
    ws.onopen = () => {
      res.connected = true;
      res.connectMs = Date.now() - t0;
      if (subscribeMsg) {
        try { ws.send(typeof subscribeMsg === 'string' ? subscribeMsg : JSON.stringify(subscribeMsg)); }
        catch (e) { res.errors.push('send: ' + e.message); }
      }
    };
    ws.onmessage = (ev) => {
      if (res.firstMsgMs === null) res.firstMsgMs = Date.now() - t0;
      res.total += 1;
      const data = (typeof ev.data === 'string') ? ev.data : '[binary]';
      if (data === 'pong') { res.pongReceived += 1; return; }
      let key = 'other';
      try {
        const parsed = JSON.parse(data);
        key = classify(parsed) || 'other';
        if (!res.samples[key] && res.total <= 4000) {
          res.samples[key] = JSON.stringify(parsed).slice(0, 400);
        }
      } catch (e) {
        key = 'nonjson';
        if (res.samples[key] === undefined) res.samples[key] = String(data).slice(0, 120);
      }
      res.counts[key] = (res.counts[key] || 0) + 1;
    };
    ws.onerror = (e) => { res.errors.push('error: ' + (e && e.message ? e.message : 'unknown')); };
    ws.onclose = (e) => { if (!done) { res.errors.push('closed early code=' + (e && e.code)); clearTimeout(watchdog); finish(); } };
    // OKX benzeri ping gerektiren akışlar için
    if (opts && opts.ping) {
      pinger = setInterval(() => {
        if (ws && ws.readyState === 1) {
          try { ws.send('ping'); res.pingSent += 1; } catch (_) {}
        }
      }, 15000);
    }
    setTimeout(() => {
      res.ok = res.connected && res.total > 0;
      clearTimeout(watchdog); finish();
    }, timeoutMs + 1500);
  });
}

/** REST kontrolü: durum kodu + gövde örneği. */
async function testRest(name, url) {
  const res = { name, url, ok: false, status: null, ms: null, sample: null, error: null };
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'MarketDNA/1.0' } });
    clearTimeout(to);
    res.status = r.status;
    const text = await r.text();
    res.sample = text.slice(0, 300);
    res.ok = r.ok;
  } catch (e) { res.error = e.message; }
  res.ms = Date.now() - t0;
  return res;
}

const s = SYMBOL.toLowerCase();

const WSS_TESTS = [
  {
    // Binance 2026-03-06 URL ayrımı: yüksek frekans public → /public, diğer piyasa verisi → /market.
    // Eski /stream yolu aggTrade+markPrice'ı artık yaymıyor (bkz. audit/live/debug kanıtları).
    name: 'binance_futures_public(bookTicker+depth20)',
    url: `wss://fstream.binance.com/public/stream?streams=${s}@bookTicker/${s}@depth20@100ms`,
    subscribeMsg: null,
    classify: (p) => p.stream ? String(p.stream).replace(s, '<sym>') : (p.error ? 'error' : 'other'),
  },
  {
    name: 'binance_futures_market(aggTrade+markPrice+forceOrder)',
    url: `wss://fstream.binance.com/market/stream?streams=${s}@aggTrade/${s}@markPrice@1s/${s}@forceOrder`,
    subscribeMsg: null,
    classify: (p) => p.stream ? String(p.stream).replace(s, '<sym>') : (p.error ? 'error' : 'other'),
  },
  {
    name: 'binance_spot_combined',
    url: `wss://stream.binance.com:9443/stream?streams=${s}@aggTrade/${s}@depth20@100ms/${s}@bookTicker`,
    subscribeMsg: null,
    classify: (p) => p.stream ? String(p.stream).replace(s, '<sym>') : (p.error ? 'error' : 'other'),
  },
  {
    name: 'okx_swap_public',
    url: 'wss://ws.okx.com:8443/ws/v5/public',
    subscribeMsg: JSON.stringify({ op: 'subscribe', args: [
      { channel: 'books', instId: SYMBOL === 'BTCUSDT' ? 'BTC-USDT-SWAP' : SYMBOL.replace('USDT', '-USDT-SWAP') },
      { channel: 'trades', instId: SYMBOL === 'BTCUSDT' ? 'BTC-USDT-SWAP' : SYMBOL.replace('USDT', '-USDT-SWAP') },
    ] }),
    classify: (p) => {
      if (p && p.arg && p.arg.channel) return 'ch:' + p.arg.channel;
      if (p && p.event) return 'event:' + p.event;
      return 'other';
    },
  },
];

const REST_TESTS = [
  { name: 'binance_futures_ping', url: 'https://fapi.binance.com/fapi/v1/ping' },
  { name: 'binance_futures_depth', url: `https://fapi.binance.com/fapi/v1/depth?symbol=${SYMBOL}&limit=20` },
  { name: 'binance_spot_mirror_depth', url: `https://data-api.binance.vision/api/v3/depth?symbol=${SYMBOL}&limit=20` },
  { name: 'okx_books', url: `https://www.okx.com/api/v5/market/books?instId=${SYMBOL === 'BTCUSDT' ? 'BTC-USDT-SWAP' : SYMBOL.replace('USDT', '-USDT-SWAP')}&sz=50` },
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`[${nowIso()}] Market DNA bağlantı testi başlıyor — süre ${DUR}s, sembol ${SYMBOL}`);
  const wss = [];
  for (const t of WSS_TESTS) {
    log(`\n== WSS ${t.name}`);
    const r = await testWss(t.name, t.url, t.subscribeMsg, t.classify, DUR * 1000, { ping: t.name.startsWith('okx') });
    log(`   connected=${r.connected} msgs=${r.total} counts=${JSON.stringify(r.counts)} err=${r.errors.slice(0,2).join('; ')}`);
    wss.push(r);
  }
  const rest = [];
  for (const t of REST_TESTS) {
    const r = await testRest(t.name, t.url);
    log(`\n== REST ${t.name}: status=${r.status} ms=${r.ms} ok=${r.ok} ${r.error ? 'err=' + r.error : ''}`);
    rest.push(r);
  }

  const report = { ts: nowIso(), symbol: SYMBOL, durationPerWssSec: DUR, wss, rest };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `connectivity-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `connectivity-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const lines = [];
  lines.push(`# Bağlantı Testi — ${nowIso()} — ${SYMBOL}`);
  lines.push('');
  lines.push('| Kaynak | Bağlandı | Mesaj | Tipler | İlk mesaj (ms) | Sonuç |');
  lines.push('|---|---|---|---|---|---|');
  for (const w of wss) {
    lines.push(`| ${w.name} | ${w.connected} | ${w.total} | ${JSON.stringify(w.counts)} | ${w.firstMsgMs ?? '—'} | ${w.ok ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('| REST | status | ms | Sonuç |');
  lines.push('|---|---|---|---|');
  for (const r of rest) lines.push(`| ${r.name} | ${r.status ?? 'ERR'} | ${r.ms} | ${r.ok ? 'PASS' : 'FAIL'} |`);
  lines.push('');
  lines.push('Örnek mesajlar (kısaltılmış):');
  for (const w of wss) for (const [k, v] of Object.entries(w.samples)) lines.push(`- ${w.name} · ${k}: \`${v}\``);
  fs.writeFileSync(mdPath, lines.join('\n') + '\n');
  log(`\nKanıt yazıldı:\n  ${jsonPath}\n  ${mdPath}`);
  const anyOk = wss.some(w => w.ok);
  process.exit(anyOk ? 0 : 2);
})();
