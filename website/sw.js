'use strict';
const SW_VERSION = '0.1.0';
self.addEventListener('install', function (e) {
    self.skipWaiting();
});
self.addEventListener('activate', function (e) {
    e.waitUntil(self.clients.claim());
});
