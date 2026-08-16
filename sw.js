/* Magicup 에러코드 서비스워커
   설계 의도
   - 앱 껍데기와 텍스트(에러코드 전량)는 설치 즉시 오프라인 동작한다. 용량이 작다.
   - 원문 페이지 이미지 513쪽(약 33MB)은 기본 설치에 포함하지 않는다.
     현장에서 데이터로 33MB를 받게 하면 안 되기 때문이다.
     본 사람 것만 자동으로 남기고, 관리자 화면의 '전체 내려받기'로 Wi-Fi 에서 한 번에 받는다.
*/
const SHELL = 'magicup-shell-v1';
const PAGES = 'magicup-pages-v1';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest',
                     './icons/pwa-192.png', './icons/pwa-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL && k !== PAGES).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  /* 원문 페이지 이미지 — 캐시 우선. 한 번 본 쪽은 오프라인에서도 열린다 */
  if (url.pathname.includes('/pages/')) {
    e.respondWith((async () => {
      const c = await caches.open(PAGES);
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  /* 앱 껍데기 — 네트워크 우선, 실패하면 캐시 */
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(SHELL)).put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(e.request);
      return hit || caches.match('./index.html');
    }
  })());
});

/* 관리자 화면의 '원문 전체 내려받기' */
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'PRECACHE_PAGES') return;
  const list = e.data.urls || [];
  e.waitUntil((async () => {
    const c = await caches.open(PAGES);
    let done = 0, fail = 0;
    const send = (state) => e.source?.postMessage({ type: 'PRECACHE_PROGRESS', done, fail, total: list.length, state });
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          if (await c.match(u)) { done += 1; }
          else {
            const r = await fetch(u, { cache: 'no-cache' });
            if (r.ok) { await c.put(u, r.clone()); done += 1; } else fail += 1;
          }
        } catch (err) { fail += 1; }
        if ((done + fail) % 10 === 0) send('running');
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    send('done');
  })());
});
