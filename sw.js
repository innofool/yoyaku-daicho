'use strict';
// 電波がない時でも台帳を開けるように、画面のファイル（プログラムだけ）を端末にしまっておく。
// お客様の情報はここでは扱わない（台帳の中身はIndexedDBに暗号化して保存されている）。
const CACHE = 'yoyaku-app-v9';
const FILES = ['./', './index.html', './style.css', './core.js', './config.js', './vault.js', './account.js', './app.js', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// つながる時は新しい画面を取りに行き（ブラウザの一時保存も確かめ直す）、つながらない時はしまっておいた画面を使う
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
});
