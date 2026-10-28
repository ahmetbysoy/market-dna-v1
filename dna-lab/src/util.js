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

/** JSONL dosyası boyut sınırını aşarsa kayıpsız arşivle (.jsonl.gz).
 * - Günlük JSONL rotasyonuna ek boyut koruması: GitHub 100 MB blob limiti
 *   ve disk şişmesi karşı önlem (FAZ 8 dersleri).
 * - appendFileSync her yazıda aç/kapat yaptığı için rotasyon sırasındaki
 *   eşzamanlı append yeni dosyayı oluşturur — veri kaybı/bozulma YOK.
 * - Aynı milisaniyedeki ardışık rotasyonlar arşiv adı çakışmasıyla EZİLMEMELİDİR;
 *   monotonik sayaç (rotSeq) adları benzersiz yapar (birim testi bu hatayı yakaladı).
 * - Sınır ortam değişkeniyle aşılabilitir (test edilebilirlik için tembel okuma).
 */
let rotSeq = 0;
function rotateJsonlIfNeeded(filePath) {
  const fs = require('fs');
  const path = require('path');
  const zlib = require('zlib');
  const maxBytes = Number(process.env.DNA_JSONL_MAX_BYTES || 32 * 1024 * 1024);
  let st = null;
  try { st = fs.statSync(filePath); } catch { return null; }
  if (!st || st.size < maxBytes) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  rotSeq = (rotSeq + 1) % 1e9;
  const seq = ('000000' + rotSeq).slice(-7);
  const base = filePath.replace(/\.jsonl$/, '');
  const tmp = `${base}.${ts}-${seq}.part.jsonl.rotating`;
  fs.renameSync(filePath, tmp); // sonraki append'ler yeni dosyayı oluşturur
  const gzPath = `${base}.${ts}-${seq}.part.jsonl.gz`;
  const gzTmp = `${gzPath}.tmp.${process.pid}`;
  fs.writeFileSync(gzTmp, zlib.gzipSync(fs.readFileSync(tmp)));
  fs.renameSync(gzTmp, gzPath);
  fs.unlinkSync(tmp);
  return gzPath;
}

/** JSONL satırı ekleme (append) + gerekiyorsa boyut bazlı arşivleme. */
function appendJsonl(filePath, obj) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  rotateJsonlIfNeeded(filePath);
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

module.exports = { nowMs, clamp, median, mean, stdev, ewma, atomicWriteJson, appendJsonl, rotateJsonlIfNeeded, dayStamp, makeId, bpsOf, notional, sumNotional, fmtDur };
