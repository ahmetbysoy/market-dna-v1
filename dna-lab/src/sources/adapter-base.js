'use strict';
/*
 * Market DNA V1 — borsa adaptörü tabanı (zero-dependency, Node >= 22 native WebSocket).
 * Sorumluluklar: bağlantı kurma, yeniden bağlanma (üstel backoff), canlılık izleme (staleness),
 * mesaj sayacı ve durum bildirimi. Mesaj ayrıştırma alt sınıfta yapılır.
 */
const { EventEmitter } = require('events');

const STATE = { IDLE: 'idle', CONNECTING: 'connecting', LIVE: 'live', RECONNECTING: 'reconnecting', STALE: 'stale', CLOSED: 'closed' };

class WsEndpoint extends EventEmitter {
  /**
   * @param {string} name  endpoint adı (log/durum için)
   * @param {Function} urlProvider () => string (her bağlantıda taze URL üretir)
   * @param {object} opts { staleMs, pingMs, onMessage(raw), onOpen }
   */
  constructor(name, urlProvider, opts = {}) {
    super();
    this.name = name;
    this.urlProvider = urlProvider;
    this.staleMs = opts.staleMs || 10_000;
    this.pingMs = opts.pingMs || 0;
    this.onMessageRaw = opts.onMessageRaw || opts.onMessage || (() => {});
    this.onOpen = opts.onOpen || null;

    this.state = STATE.IDLE;
    this.msgCount = 0;
    this.reconnects = 0;
    this.lastMsgAt = 0;
    this.lastError = null;
    this.connectedAt = 0;

    this._ws = null;
    this._closedByUs = false;
    this._backoff = opts.backoffBase || 1_000;
    this._backoffMax = opts.backoffMax || 30_000;
    this._staleTimer = null;
    this._pingTimer = null;
    this._connectTimer = null;
  }

  connect() {
    if (this._closedByUs) return;
    this._setState(STATE.CONNECTING);
    let ws;
    try {
      ws = new WebSocket(this.urlProvider());
    } catch (e) {
      this.lastError = 'constructor: ' + e.message;
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      this.connectedAt = Date.now();
      this._backoff = 1_000; // başarılı bağlantıda sıfırla
      this._setState(STATE.LIVE);
      this.lastMsgAt = Date.now();
      this._armStaleWatch();
      if (this.pingMs > 0) {
        this._pingTimer = setInterval(() => {
          if (ws.readyState === 1) { try { ws.send('ping'); } catch (_) {} }
        }, this.pingMs);
      }
      if (this.onOpen) { try { this.onOpen(ws); } catch (e) { this.lastError = 'onOpen: ' + e.message; } }
    };
    ws.onmessage = (ev) => {
      this.msgCount += 1;
      this.lastMsgAt = Date.now();
      if (this.state === STATE.STALE) this._setState(STATE.LIVE);
      try { this.onMessageRaw(ev.data); } catch (e) { this.lastError = 'parse: ' + e.message; }
    };
    ws.onerror = () => { this.lastError = 'socket error'; };
    ws.onclose = (e) => {
      this.lastError = this.lastError || ('close code=' + (e && e.code));
      if (this._closedByUs) { this._setState(STATE.CLOSED); return; }
      this._scheduleReconnect();
    };
  }

  send(str) {
    if (this._ws && this._ws.readyState === 1) { try { this._ws.send(str); return true; } catch (_) {} }
    return false;
  }

  close() {
    this._closedByUs = true;
    this._clearTimers();
    try { this._ws && this._ws.close(); } catch (_) {}
    this._setState(STATE.CLOSED);
  }

  _scheduleReconnect() {
    this._clearTimers();
    this._setState(STATE.RECONNECTING);
    this.reconnects += 1;
    const delay = this._backoff;
    this._backoff = Math.min(this._backoffMax, this._backoff * 2);
    this._connectTimer = setTimeout(() => this.connect(), delay);
  }

  _armStaleWatch() {
    if (this._staleTimer) clearInterval(this._staleTimer);
    this._staleTimer = setInterval(() => {
      if (this.state === STATE.LIVE && Date.now() - this.lastMsgAt > this.staleMs) {
        this._setState(STATE.STALE);
        this.emit('stale', { name: this.name, silentMs: Date.now() - this.lastMsgAt });
      }
    }, 1_000);
  }

  _clearTimers() {
    if (this._staleTimer) { clearInterval(this._staleTimer); this._staleTimer = null; }
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('status', { name: this.name, state: s, msgCount: this.msgCount, reconnects: this.reconnects, lastError: this.lastError });
  }

  snapshot() {
    return {
      name: this.name, state: this.state, msgCount: this.msgCount,
      reconnects: this.reconnects, lastMsgAt: this.lastMsgAt, lastError: this.lastError,
      silentMs: this.lastMsgAt ? Date.now() - this.lastMsgAt : null,
    };
  }
}

module.exports = { WsEndpoint, STATE };
