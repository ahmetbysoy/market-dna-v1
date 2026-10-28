#!/usr/bin/env node
/* Futures @aggTrade ve @markPrice akışlarının tek tek doğrulanması (FAZ 1 kanıt). */
'use strict';
const DUR = Number(process.argv[2]) || 10;
const TARGETS = [
  ['aggTrade_single', 'wss://fstream.binance.com/stream?streams=btcusdt@aggTrade'],
  ['markPrice_1s_single', 'wss://fstream.binance.com/stream?streams=btcusdt@markPrice@1s'],
  ['aggTrade_raw_combined', 'wss://fstream.binance.com/ws/btcusdt@aggTrade/btcusdt@bookTicker'],
  ['aggTrade_upper', 'wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms'],
];
(async () => {
  for (const [name, url] of TARGETS) {
    await new Promise((resolve) => {
      const counts = {}; let total = 0; let first = null; const t0 = Date.now();
      const ws = new WebSocket(url);
      const to = setTimeout(() => { ws.close(); }, DUR * 1000);
      ws.onopen = () => console.log(`[${name}] connected in ${Date.now() - t0}ms`);
      ws.onmessage = (ev) => {
        if (first === null) first = Date.now() - t0;
        total++;
        try { const p = JSON.parse(ev.data); const k = p.stream || (p.data ? 'data-nostream' : 'other'); counts[k] = (counts[k] || 0) + 1; } catch (_) { counts.nonjson = (counts.nonjson || 0) + 1; }
      };
      ws.onclose = () => { clearTimeout(to); console.log(`[${name}] total=${total} first=${first}ms counts=${JSON.stringify(counts)}`); resolve(); };
      ws.onerror = (e) => console.log(`[${name}] error`);
    });
  }
  process.exit(0);
})();
