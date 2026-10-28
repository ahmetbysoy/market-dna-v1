'use strict';
/*
 * Binance USDT-M Futures adaptörü.
 * 2026-03-06 URL ayrımına göre İKİ bağlantı:
 *   - /public/stream : @bookTicker + @depth20@100ms (yüksek frekans)
 *   - /market/stream : @aggTrade + @markPrice@1s + @forceOrder
 * Eski tek /stream yolunun aggTrade/markPrice yaymadığı bu ortamda gerçek testle kanıtlandı
 * (audit/live/connectivity-*.md ve scripts/debug-futures-streams.js çıktıları).
 */
const { WsEndpoint } = require('./adapter-base');
const { ewma } = require('../util');
const config = require('../config');

class BinanceFuturesAdapter {
  constructor(symbol, cfg, emit) {
    this.venue = 'binance_futures';
    this.symbol = symbol;
    this.cfg = cfg;
    this.emit = emit; // (normalizedMsg) => void
    this.lagEwma = null;
    this._lastDepthU = null;

    const mk = (name, urlFn) => new WsEndpoint(name, () => urlFn(symbol), {
      staleMs: cfg.staleMs,
      backoffBase: (cfg.reconnect || config.sources.reconnect).baseMs,
      backoffMax: (cfg.reconnect || config.sources.reconnect).maxMs,
      onMessageRaw: (raw) => this._handle(raw),
    });

    this.epPublic = mk('bfut:public', cfg.publicUrl);
    this.epMarket = mk('bfut:market', cfg.marketUrl);
    for (const ep of [this.epPublic, this.epMarket]) {
      ep.on('status', (s) => this.emit({ kind: 'venueStatus', venue: this.venue, endpoint: s }));
      ep.on('stale', (s) => this.emit({ kind: 'venueStale', venue: this.venue, endpoint: s }));
    }
    // Yeniden bağlanma = derinlik sürekliliği bozulur → RESET
    for (const ep of [this.epPublic, this.epMarket]) {
      ep.on('status', (s) => {
        if (s.state === 'reconnecting') this._lastDepthU = null;
      });
    }
  }

  start() { this.epPublic.connect(); this.epMarket.connect(); }
  stop() { this.epPublic.close(); this.epMarket.close(); }

  _handle(raw) {
    let p;
    try { p = JSON.parse(raw); } catch (_) { return; }
    // combined stream: {stream, data}; ham yol: payload doğrudan
    const data = p.data !== undefined && p.stream !== undefined ? p.data : p;
    if (!data || typeof data !== 'object') return;
    const recvTs = Date.now();
    const e = data.e || '';
    const wrap = (kind, exchTs, extra) => {
      const lag = Math.max(0, recvTs - Number(exchTs || recvTs));
      this.lagEwma = ewma(this.lagEwma, lag, 0.05);
      this.emit({ kind, venue: this.venue, symbol: this.symbol, exchTs: Number(exchTs || recvTs), recvTs, lagMs: Math.round(lag), ...extra });
    };

    if (e === 'bookTicker') {
      wrap('ticker', data.E || data.T, {
        bid: Number(data.b), bidQty: Number(data.B), ask: Number(data.a), askQty: Number(data.A),
      });
    } else if (e === 'depthUpdate') {
      // Futures partial depth: her mesaj top-20 TAM anlık görüntü; U/u/pu süreklilik denetimi.
      const u = Number(data.u), pu = data.pu !== undefined ? Number(data.pu) : null;
      let reset = false;
      if (this._lastDepthU !== null && pu !== null && pu !== this._lastDepthU) reset = true;
      this._lastDepthU = u;
      if (reset) this.emit({ kind: 'reset', venue: this.venue, symbol: this.symbol, recvTs, reason: 'depth_seq_gap' });
      wrap('book', data.E || data.T, {
        bids: (data.b || []).map((x) => [Number(x[0]), Number(x[1])]),
        asks: (data.a || []).map((x) => [Number(x[0]), Number(x[1])]),
        depthMode: this.cfg.depthMode, seq: u,
      });
    } else if (e === 'aggTrade') {
      wrap('trade', data.T, {
        price: Number(data.p), qty: Number(data.q),
        side: data.m ? 'sell' : 'buy',      // m = buyer is maker → agresif taraf satıcı
        tradeId: String(data.a ?? ''),
      });
    } else if (e === 'markPriceUpdate') {
      wrap('mark', data.T || data.E, {
        markPrice: Number(data.p), indexPrice: data.i !== undefined ? Number(data.i) : null,
        fundingRate: data.r !== undefined ? Number(data.r) : null,
      });
    } else if (e === 'forceOrder') {
      const o = data.o || {};
      wrap('liquidation', o.T || data.E, {
        side: o.S === 'SELL' ? 'sell' : 'buy',   // likide edilen pozisyon yönü
        price: Number(o.ap || o.p), qty: Number(o.z || o.q),
      });
    }
  }

  status() {
    return {
      venue: this.venue, symbol: this.symbol,
      endpoints: [this.epPublic.snapshot(), this.epMarket.snapshot()],
      lagMsEwma: this.lagEwma === null ? null : Math.round(this.lagEwma),
    };
  }
}

module.exports = { BinanceFuturesAdapter };
