'use strict';
/* Binance Spot adaptörü — tek /stream birleşik bağlantı (aggTrade + depth20@100ms + bookTicker). */
const { WsEndpoint } = require('./adapter-base');
const { ewma } = require('../util');
const config = require('../config');

class BinanceSpotAdapter {
  constructor(symbol, cfg, emit) {
    this.venue = 'binance_spot';
    this.symbol = symbol;
    this.cfg = cfg;
    this.emit = emit;
    this.lagEwma = null;

    this.ep = new WsEndpoint('bspot:main', () => cfg.url(symbol), {
      staleMs: cfg.staleMs,
      backoffBase: (cfg.reconnect || config.sources.reconnect).baseMs,
      backoffMax: (cfg.reconnect || config.sources.reconnect).maxMs,
      onMessageRaw: (raw) => this._handle(raw),
    });
    this.ep.on('status', (s) => {
      this.emit({ kind: 'venueStatus', venue: this.venue, endpoint: s });
      if (s.state === 'reconnecting') this.emit({ kind: 'reset', venue: this.venue, symbol: this.symbol, recvTs: Date.now(), reason: 'reconnect' });
    });
    this.ep.on('stale', (s) => this.emit({ kind: 'venueStale', venue: this.venue, endpoint: s }));
  }

  start() { this.ep.connect(); }
  stop() { this.ep.close(); }

  _handle(raw) {
    let p;
    try { p = JSON.parse(raw); } catch (_) { return; }
    const data = p.data !== undefined && p.stream !== undefined ? p.data : p;
    if (!data || typeof data !== 'object') return;
    const recvTs = Date.now();
    const stream = p.stream || '';
    const wrap = (kind, exchTs, extra) => {
      const lag = Math.max(0, recvTs - Number(exchTs || recvTs));
      this.lagEwma = ewma(this.lagEwma, lag, 0.05);
      this.emit({ kind, venue: this.venue, symbol: this.symbol, exchTs: Number(exchTs || recvTs), recvTs, lagMs: Math.round(lag), ...extra });
    };

    if (data.e === 'aggTrade') {
      wrap('trade', data.T, {
        price: Number(data.p), qty: Number(data.q),
        side: data.m ? 'sell' : 'buy', tradeId: String(data.a ?? ''),
      });
    } else if (stream.includes('@depth') && data.lastUpdateId !== undefined) {
      // Spot partial depth: {lastUpdateId, bids, asks} — tam top-20 anlık görüntü.
      wrap('book', null, {
        bids: (data.bids || []).map((x) => [Number(x[0]), Number(x[1])]),
        asks: (data.asks || []).map((x) => [Number(x[0]), Number(x[1])]),
        depthMode: this.cfg.depthMode, seq: Number(data.lastUpdateId),
      });
    } else if (stream.includes('@bookTicker') || data.e === 'bookTicker') {
      wrap('ticker', null, {
        bid: Number(data.b), bidQty: Number(data.B), ask: Number(data.a), askQty: Number(data.A),
      });
    }
  }

  status() {
    return { venue: this.venue, symbol: this.symbol, endpoints: [this.ep.snapshot()], lagMsEwma: this.lagEwma === null ? null : Math.round(this.lagEwma) };
  }
}

module.exports = { BinanceSpotAdapter };
