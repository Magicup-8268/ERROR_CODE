/* Magicup 에러코드 서비스워커
   설계 의도
   - 앱 껍데기와 텍스트(에러코드 전량)는 설치 즉시 오프라인 동작한다. 용량이 작다.
   - 원문 이미지는 기본 설치에 포함하지 않는다.
     본 쪽만 자동 저장하고 설정에서 제품군 또는 전체 범위를 선택한다.
*/
const SHELL = 'magicup-shell-v5';
const PAGES = 'magicup-pages-v1';
const SHELL_FILES = ['./index.html', './manifest.webmanifest',
                     './icons/pwa-192.png', './icons/pwa-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => /^magicup-(shell|pages)-v\d+$/.test(k) && k !== SHELL && k !== PAGES).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const scope = new URL('./', self.location.href);
  if (!url.pathname.startsWith(scope.pathname)) return;

  /* 원문 페이지 이미지 — 캐시 우선. 한 번 본 쪽은 오프라인에서도 열린다 */
  if (url.pathname.startsWith(scope.pathname + 'pages/')) {
    e.respondWith((async () => {
      const c = await caches.open(PAGES).catch(() => null);
      const hit = c && await c.match(e.request).catch(() => null);
      if (hit) return hit;
      try {
        const res = await fetch(e.request, { signal: AbortSignal.timeout(20000) });
        if (res.ok && c) await c.put(e.request, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  /* 앱 껍데기 — 네트워크 우선, 실패하면 캐시 */
  e.respondWith((async () => {
    const c = await caches.open(SHELL).catch(() => null);
    try {
      const res = await fetch(e.request, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        if (c) await c.put(e.request, res.clone()).catch(() => {});
        return res;
      }
      if (res.status < 500) return res;
    } catch (err) {
    }
    const hit = c && await c.match(e.request).catch(() => null);
    const navigation = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
    return hit || (navigation && c && await c.match(new URL('./index.html', scope).href).catch(() => null)) || new Response('', { status: 504 });
  })());
});

/* 다운로드는 워커 전체에서 하나만 실행하고 삭제와 경합하지 않게 한다. */
let pageJob = null;
let pageState = { type: 'PRECACHE_PROGRESS', done: 0, fail: 0, total: 0, state: 'idle' };
async function sendPageState() {
  const clients = await self.clients.matchAll().catch(() => []);
  clients.forEach(client => client.postMessage(pageState));
}
self.addEventListener('message', (e) => {
  if (e.data?.type === 'PAGE_STATUS') { e.source?.postMessage(pageState); return; }
  if (e.data?.type === 'CLEAR_PAGES') {
    if (pageJob) { e.source?.postMessage(pageState); return; }
    pageState = { ...pageState, state: 'clearing' };
    pageJob = (async () => {
      await sendPageState();
      try { await caches.delete(PAGES); pageState = { ...pageState, state: 'cleared', done: 0, fail: 0 }; }
      catch (_) { pageState = { ...pageState, state: 'error' }; }
      finally { pageJob = null; await sendPageState(); }
    })();
    e.waitUntil(pageJob); return;
  }
  if (e.data?.type !== 'PRECACHE_PAGES') return;
  if (pageJob) { e.source?.postMessage(pageState); return; }
  const scope = new URL('./', self.location.href);
  const input = e.data.urls;
  if (!Array.isArray(input) || !input.length || input.length > 1500) return;
  const list = [...new Set(input)].filter(u => {
    try { const x = new URL(u); return x.origin === scope.origin && x.pathname.startsWith(scope.pathname + 'pages/') && /\/p\d{3}\.webp$/.test(x.pathname) && !x.search; }
    catch (_) { return false; }
  });
  if (!list.length || list.length !== new Set(input).size) return;
  pageState = { type: 'PRECACHE_PROGRESS', done: 0, fail: 0, total: list.length, state: 'running' };
  pageJob = (async () => {
    try {
    await sendPageState();
    const c = await caches.open(PAGES);
    let done = 0, fail = 0;
    const send = async (state) => { pageState = { type: 'PRECACHE_PROGRESS', done, fail, total: list.length, state }; await sendPageState(); };
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          if (await c.match(u)) { done += 1; }
          else {
            const r = await fetch(u, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
            if (r.ok) { await c.put(u, r.clone()); done += 1; } else fail += 1;
          }
        } catch (err) { fail += 1; }
        if ((done + fail) % 10 === 0) await send('running');
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await send('done');
    } catch (_) { pageState = { ...pageState, state: 'error' }; await sendPageState(); }
    finally { pageJob = null; }
  })();
  e.waitUntil(pageJob);
});
