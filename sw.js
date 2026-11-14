/* Offline-cache. Appens egna filer hämtas nätverket först (så att en ny version
   syns direkt) och faller tillbaka på cachen utan nät. Typsnitten läses cache-först. */
const CACHE = 'orka-v6';
const FONTER = 'orka-fonter';
const SKAL = ['./', './index.html', './app.js', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache:'reload' går förbi webbläsarens HTTP-cache, annars kan en gammal fil hamna i den nya cachen
    await Promise.allSettled(SKAL.map(async u => {
      const r = await fetch(new Request(u, { cache: 'reload' }));
      if (r.ok) await c.put(u, r);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k !== FONTER) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* Påminnelserna. iOS kräver att varje push visar en notis, så det görs alltid,
   även om innehållet skulle saknas. */
self.addEventListener('push', e => {
  let slot = '';
  try { slot = e.data.json().slot; } catch (err) { /* tomt eller oläsbart: visa den allmänna frågan */ }
  const text = slot === 'morgon' ? 'Hur känns höften nu på morgonen?'
    : slot === 'kvall' ? 'Hur känns höften nu på kvällen?'
    : slot === 'test' ? 'Så här ser påminnelsen ut.'
    : 'Hur känns höften?';
  e.waitUntil(self.registration.showNotification('Orka', { body: text, tag: 'orka-' + (slot || 'fraga'), icon: 'icon-192.png' }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const oppna = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // En app som redan ligger öppen kan stå på en annan dag eller vy: be den gå till i dag
    if (oppna.length) { oppna[0].postMessage({ typ: 'idag' }); return oppna[0].focus(); }
    return self.clients.openWindow('./');
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith((async () => {
      const c = await caches.open(FONTER);
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    })());
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await c.match(e.request, { ignoreSearch: true })) || (await c.match('./index.html'));
    }
  })());
});
