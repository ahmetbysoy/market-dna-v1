'use strict';
/* OKX USDT Perpetual Swap adaptörü — books (400 seviye tam anlık görüntü) + trades, ping/pong. */
const { WsEndpoint } = require('./adapter-base');
const { ewma } = require('../util');
const config = require('../config');

class OkxSwapAdapter {
  constructor(symbol, cfg, emit, symbolFormat) {
    this.venue = 'okx_swap';
    this.symbol = symbol;
    this.instId = symbolFormat(symbol);   // BTCUSDT -> BTC-USDT-SWAP
    this.cfg = cfg;
    this.emit = emit;
    this.lagEwma = null;

    this.ep = new WsEndpoint('okx:public', () => cfg.url, {
      staleMs: cfg.staleMs,
      pingMs: cfg.pingMs,
      backoffBase: (cfg.reconnect || config.sources.reconnect).baseMs,
      backoffMax: (cfg.reconnect || config.sources.reconnect).maxMs,
      onMessageRaw: (raw) => this._handle(raw),
      onOpen: (ws) => {
        // Bağlantı açılınca abonelik gönder (OKX mesaj tabanlı abonelik)
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: [
            { channel: 'books', instId: this.instId },
            { channel: 'trades', instId: this.instId },
          ],
        }));
      },
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
    if (raw === 'pong') return;
    let p;
    try { p = JSON.parse(raw); } catch (_) { return; }
    if (!p || !p.arg || !Array.isArray(p.data)) return;   // abonelik/event cevapları
    const recvTs = Date.now();
    const ch = p.arg.channel;

    if (ch === 'books') {
      // OKX books: her push TAM anlık görüntü (400 seviyeye kadar).
      const d = p.data[0];
      if (!d) return;
      const lag = Math.max(0, recvTs - Number(d.ts || recvTs));
      this.lagEwma = ewma(this.lagEwma, lag, 0.05);
      this.emit({
        kind: 'book', venue: this.venue, symbol: this.symbol,
        exchTs: Number(d.ts || recvTs), recvTs, lagMs: Math.round(lag),
        bids: (d.bids || []).map((x) => [Number(x[0]), Number(x[1])]),
        asks: (d.asks || []).map((x) => [Number(x[0]), Number(x[1])]),
        depthMode: this.cfg.depthMode, seq: d.checksum !== undefined ? Number(d.checksum) : null,
      });
    } else if (ch === 'trades') {
      for (const d of p.data) {
        const lag = Math.max(0, recvTs - Number(d.ts || recvTs));
        this.lagEwma = ewma(this.lagEwma, lag, 0.05);
        this.emit({
          kind: 'trade', venue: this.venue, symbol: this.symbol,
          exchTs: Number(d.ts || recvTs), recvTs, lagMs: Math.round(lag),
          price: Number(d.px), qty: Number(d.sz),
          side: d.side === 'buy' ? 'buy' : 'sell',   // OKX side = agresif taraf
          tradeId: String(d.tradeId ?? ''),
        });
      }
    }
  }

  status() {
    return { venue: this.venue, symbol: this.symbol, endpoints: [this.ep.snapshot()], lagMsEwma: this.lagEwma === null ? null : Math.round(this.lagEwma) };
  }
}

module.exports = { OkxSwapAdapter };
