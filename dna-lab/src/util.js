'use strict';
/* Market DNA V1 — yardımcı fonksiyonlar (saf, bağımlılıksız). */

function nowMs() { return Date.now(); }

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/** Üstel hareketli ortalama. */
function ewma(prev, value, alpha) {
  if (prev === null || prev === undefined || !Number.isFinite(prev)) return value;
  return prev + alpha * (value - prev);
}

/** Atomik JSON yazımı: tmp dosyasına yaz, fsync, rename. */
function atomicWriteJson(filePath, obj) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/** JSONL satırı ekleme (append). */
function appendJsonl(filePath, obj) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function dayStamp(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

/** Basit deterministik id. */
let idCounter = 0;
function makeId(prefix) {
  idCounter = (idCounter + 1) % 1e9;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function bpsOf(price, refPrice) {
  if (!refPrice) return 0;
  return ((price - refPrice) / refPrice) * 10_000;
}

/** Notional = fiyat × miktar (USDT). */
function notional(level) { return Number(level[0]) * Number(level[1]); }

/** levels: [[p,q],...] → notional toplamı */
function sumNotional(levels, n) {
  let s = 0;
  const lim = Math.min(levels.length, n ?? levels.length);
  for (let i = 0; i < lim; i++) s += notional(levels[i]);
  return s;
}

function fmtDur(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

module.exports = { nowMs, clamp, median, mean, stdev, ewma, atomicWriteJson, appendJsonl, dayStamp, makeId, bpsOf, notional, sumNotional, fmtDur };
