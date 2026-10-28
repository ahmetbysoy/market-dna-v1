#!/usr/bin/env node
'use strict';
/*
 * Market DNA V1 — sunucu girişi.
 * Zero-dependency Node.js backend: canlı WebSocket kaynak yönetimi, olay kodlama,
 * motif keşfi, öğrenme ve kalıcı hafıza burada; frontend yalnız gerçek durum gösterir.
 */
const config = require('./src/config');
const { SessionManager } = require('./src/session/manager');
const { createServer } = require('./src/api/server');

const session = new SessionManager(() => {});
const { server, broadcast } = createServer(session);
// broadcast referansını oturuma bağla
session.broadcast = broadcast;

server.listen(config.server.port, config.server.host, () => {
  console.log(`[MarketDNA] sunucu açık: http://${config.server.host}:${config.server.port} (port: ${config.server.port})`);
  console.log('[MarketDNA] bağımlılık: sıfır npm paketi (Node native WebSocket + http)');
});

process.on('SIGINT', () => { console.log('\n[MarketDNA] kapatılıyor (SIGINT)'); session.shutdown(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { console.log('\n[MarketDNA] kapatılıyor (SIGTERM)'); session.shutdown(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException', (e) => {
  console.error('[MarketDNA] yakalanmayan hata:', e && e.stack || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[MarketDNA] reddedilen promise:', e);
});
