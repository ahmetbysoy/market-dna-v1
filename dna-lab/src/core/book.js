'use strict';
/* Market DNA V1 — L2 kitap durumu. Partial snapshot kanallarıyla çalışır (her mesaj tam top-N). */

class L2Book {
  constructor(venue, symbol) {
    this.venue = venue;
    this.symbol = symbol;
    this.bids = [];   // [[price, qty]] fiyat azalan
    this.asks = [];   // [[price, qty]] fiyat artan
    this.depthMode = 'top20';
    this.lastUpdateTs = 0;
    this.seq = null;
    this.stale = false;
  }

  /** levels zaten normalize ([[Number,Number]]); doğrudan snapshot uygular. */
  applySnapshot(bids, asks, depthMode, ts, seq) {
    this.bids = (bids || []).filter((x) => x[1] > 0).sort((a, b) => b[0] - a[0]);
    this.asks = (asks || []).filter((x) => x[1] > 0).sort((a, b) => a[0] - b[0]);
    if (depthMode) this.depthMode = depthMode;
    this.lastUpdateTs = ts;
    this.seq = seq !== undefined ? seq : this.seq;
  }

  hasBook() { return this.bids.length > 0 && this.asks.length > 0; }

  bestBid() { return this.bids.length ? this.bids[0][0] : null; }
  bestAsk() { return this.asks.length ? this.asks[0][0] : null; }

  mid() {
    const b = this.bestBid(), a = this.bestAsk();
    return b !== null && a !== null ? (b + a) / 2 : null;
  }

  spreadBps() {
    const b = this.bestBid(), a = this.bestAsk();
    if (b === null || a === null || b <= 0) return null;
    return ((a - b) / ((a + b) / 2)) * 10_000;
  }

  /** top-n seviye dengesizliği: (B - A) / (B + A), notional bazında. */
  imbalanceTop(n) {
    let b = 0, a = 0;
    for (let i = 0; i < Math.min(n, this.bids.length); i++) b += this.bids[i][0] * this.bids[i][1];
    for (let i = 0; i < Math.min(n, this.asks.length); i++) a += this.asks[i][0] * this.asks[i][1];
    const tot = b + a;
    return tot > 0 ? (b - a) / tot : 0;
  }

  sideNotional(side, n) {
    const arr = side === 'bid' ? this.bids : this.asks;
    let s = 0;
    for (let i = 0; i < Math.min(n ?? arr.length, arr.length); i++) s += arr[i][0] * arr[i][1];
    return s;
  }

  /** Bir taraftaki top-n seviye notional medyanı (duvar eşiği taban çizgisi). */
  medianLevelNotional(side, n) {
    const arr = side === 'bid' ? this.bids : this.asks;
    const vals = [];
    for (let i = 0; i < Math.min(n ?? arr.length, arr.length); i++) vals.push(arr[i][0] * arr[i][1]);
    vals.sort((x, y) => x - y);
    if (!vals.length) return 0;
    const m = vals.length >> 1;
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }

  /** Belirli bir fiyat seviyesindeki notional (yoksa 0). */
  levelNotional(side, price) {
    const arr = side === 'bid' ? this.bids : this.asks;
    for (const [p, q] of arr) { if (p === price) return p * q; }
    return 0;
  }

  snapshot() {
    return { venue: this.venue, bids: this.bids.length, asks: this.asks.length, mid: this.mid(), spreadBps: this.spreadBps(), depthMode: this.depthMode, ts: this.lastUpdateTs };
  }
}

module.exports = { L2Book };
