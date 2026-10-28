'use strict';
/*
 * Market DNA V1 — Coin başına kalıcı hafıza (spec §9, B+).
 * - data/memory/<SYMBOL>/ altında: state.json (atomik + checksum + .bak), episodes-<gün>.jsonl, events-<gün>.jsonl
 * - Şema sürümlendirme, bozuk kayıttan kontrollü kurtarma, oturum boşluğu bilgisi.
 * - Büyük ham arşiv tek büyüyen JSON değil: günlük JSONL rotasyonu (spec önerisi).
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson, appendJsonl, dayStamp } = require('../util');

const SCHEMA_VERSION = 1;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

class CoinMemory {
  constructor(symbol, dataDir) {
    this.symbol = symbol;
    this.dir = path.join(dataDir, 'memory', symbol);
    this.statePath = path.join(this.dir, 'state.json');
    this.bakPath = this.statePath + '.bak';
    this.recoveryLog = [];
    this.state = null;
  }

  /** Diskten yükler; bozulma durumunda .bak'a dener. */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const attempt = (p, label) => {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) {
          this.recoveryLog.push(`${label}: şema sürümü uyumsuz (${parsed && parsed.schemaVersion})`);
          return null;
        }
        const { checksum, ...rest } = parsed;
        if (checksum && fnv1a(JSON.stringify(rest)) !== checksum) {
          this.recoveryLog.push(`${label}: checksum uyuşmadı`);
          return null;
        }
        return parsed;
      } catch (e) {
        this.recoveryLog.push(`${label}: ${e.message}`);
        return null;
      }
    };
    let s = attempt(this.statePath, 'state.json');
    if (!s) {
      s = attempt(this.bakPath, 'state.json.bak');
      if (s) this.recoveryLog.push('KURTARMA: yedek kayıttan devam ediliyor');
    }
    if (!s) {
      this.recoveryLog.push('SIFIRDAN: geçerli kayıt yok, yeni hafıza oluşturuluyor');
      s = {
        schemaVersion: SCHEMA_VERSION,
        coin: this.symbol,
        createdAt: Date.now(),
        updatedAt: null,
        lastSessionEnd: null,
        sessions: 0,
        counters: { eventsTotal: 0, episodesTotal: 0, resolvedTotal: 0 },
        learnerMotifs: [],
        baseScores: {},
      };
    }
    this.state = s;
    return { state: s, recovered: this.recoveryLog.some((r) => r.startsWith('KURTARMA') || r.startsWith('SIFIRDAN')), recoveryLog: this.recoveryLog };
  }

  save() {
    if (!this.state) return;
    this.state.updatedAt = Date.now();
    const { checksum, ...rest } = this.state;
    this.state.checksum = fnv1a(JSON.stringify(rest));
    atomicWriteJson(this.statePath, this.state);
    try { fs.copyFileSync(this.statePath, this.bakPath); } catch (_) {}
  }

  sessionOpen() {
    this.state.sessions = (this.state.sessions || 0) + 1;
    this.save();
  }

  sessionClose() {
    this.state.lastSessionEnd = Date.now();
    this.save();
  }

  gapSinceLastSession(gapMs) {
    const last = this.state && this.state.lastSessionEnd;
    if (!last) return null;
    const gap = Date.now() - last;
    return gap >= gapMs ? { gapMs: gap, lastSessionEnd: last } : null;
  }

  recordEvent(ev) {
    const f = path.join(this.dir, `events-${dayStamp(Date.now())}.jsonl`);
    appendJsonl(f, {
      id: ev.id, event: ev.event, side: ev.side, venue: ev.venue, symbol: ev.symbol,
      ts: ev.ts, price: ev.price, details: ev.details,
    });
    this.state.counters.eventsTotal = (this.state.counters.eventsTotal || 0) + 1;
  }

  recordEpisode(ep) {
    const f = path.join(this.dir, `episodes-${dayStamp(Date.now())}.jsonl`);
    appendJsonl(f, {
      epId: ep.epId, motifId: ep.motifId, motifKey: ep.motifKey, coin: ep.coin,
      t0: ep.t0, refPrice: ep.refPrice, regime: ep.regime, integrity: ep.integrity,
      chain: ep.chain, horizons: ep.horizons, overlaps: ep.overlaps.length,
      invalidatorsFired: ep.invalidatorsFired, cancelled: ep.cancelled,
    });
    this.state.counters.episodesTotal = (this.state.counters.episodesTotal || 0) + 1;
    this.state.counters.resolvedTotal = (this.state.counters.resolvedTotal || 0) + 1;
  }

  /** Learner durumunu hafızaya serileştir (motifler, metrikler, iptal istatistikleri). */
  syncLearner(learnerSnapshot) {
    this.state.learnerMotifs = learnerSnapshot;
  }

  syncBaseScores(baseSnapshot) {
    this.state.baseScores = baseSnapshot;
  }

  /** Hafızadaki çözülmüş episodları baz model havuzu için geri ver (yalnız son N gün, epId tekilleştirilmiş).
   *  Boyut rotasyonuyla arşivlenen .jsonl.gz parçaları da okunur (kayıpsız geri yükleme). */
  loadRecentEpisodes(maxAgeMs = 6 * 3600 * 1000) {
    const out = [];
    const seen = new Set();
    try {
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.startsWith('episodes-') && (f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')))
        .sort();
      const cutoff = Date.now() - maxAgeMs;
      for (const f of files.slice(-4)) {   // aktif + en fazla 3 arşiv parçası
        let raw;
        if (f.endsWith('.gz')) raw = require('zlib').gunzipSync(fs.readFileSync(path.join(this.dir, f))).toString('utf8');
        else raw = fs.readFileSync(path.join(this.dir, f), 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const ep = JSON.parse(line);
            if (ep.t0 < cutoff) continue;
            if (seen.has(ep.epId)) continue;   // eski sürümlerin çift yazımlarına karşı tekilleştir
            seen.add(ep.epId);
            out.push(ep);
          } catch (_) { /* bozuk satırı atla */ }
        }
      }
    } catch (_) {}
    return out;
  }

  info() {
    const files = [];
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const st = fs.statSync(path.join(this.dir, f));
        files.push({ name: f, size: st.size, mtime: st.mtimeMs });
      }
    } catch (_) {}
    return {
      symbol: this.symbol, dir: this.dir, schemaVersion: SCHEMA_VERSION,
      state: this.state ? {
        createdAt: this.state.createdAt, updatedAt: this.state.updatedAt,
        lastSessionEnd: this.state.lastSessionEnd, sessions: this.state.sessions,
        counters: this.state.counters, motifs: (this.state.learnerMotifs || []).length,
      } : null,
      files, recoveryLog: this.recoveryLog,
    };
  }
}

module.exports = { CoinMemory, SCHEMA_VERSION, fnv1a };
