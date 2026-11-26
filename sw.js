/* 点亮山河 service worker. VERSION 变化 => 重新预缓存并清理旧缓存。
   足迹数据存在 localStorage / IndexedDB，本文件只缓存静态文件，不会触碰它们。 */
const VERSION = 'd6bf24a4c2';
const CACHE = 'dianliang-' + VERSION;
const PRECACHE = [
 "./",
 "./__next.__PAGE__.txt",
 "./__next._full.txt",
 "./__next._tree.txt",
 "./apple-touch-icon.png",
 "./favicon.ico",
 "./icon-192.png",
 "./icon-512.png",
 "./icon-maskable-512.png",
 "./icon.svg",
 "./index.html",
 "./index.txt",
 "./manifest.webmanifest",
 "./sync.js",
 "./_next/static/VUYi3bUwhO5BUuHXXcpyo/_buildManifest.js",
 "./_next/static/VUYi3bUwhO5BUuHXXcpyo/_clientMiddlewareManifest.js",
 "./_next/static/VUYi3bUwhO5BUuHXXcpyo/_ssgManifest.js",
 "./_next/static/chunks/08nusuk3wm1q7.js",
 "./_next/static/chunks/0cz1d0mv5g_q7.js",
 "./_next/static/chunks/0ku7vrfqvqwoa.js",
 "./_next/static/chunks/0wfurka9errm3.js",
 "./_next/static/chunks/0yz0oxanetv6p.js",
 "./_next/static/chunks/10ocx490lu2ni.js",
 "./_next/static/chunks/17xuiox88rmtp.css",
 "./_next/static/chunks/39_j1bdzreq0m.js",
 "./_next/static/chunks/3qfy96eoyh-ek.js",
 "./_next/static/chunks/3tmxczhmx_5qh.js",
 "./_next/static/chunks/turbopack-0hvx9v9vijn-c.js",
 "./_next/static/media/favicon.117ezoe8m31dk.ico",
 "./_next/static/media/icon.06da-jh_1j6-o.svg",
 "./data/cycling-spots.json",
 "./fonts/fraunces-500.woff2",
 "./fonts/fraunces-560.woff2",
 "./fonts/noto-sans-sc-400.woff2",
 "./fonts/noto-sans-sc-700.woff2",
 "./fonts/noto-sans-sc-latin-400.woff2",
 "./fonts/noto-sans-sc-latin-700.woff2",
 "./fonts/noto-serif-sc-700.woff2",
 "./fonts/noto-serif-sc-latin-700.woff2",
 "./geo/cities.json",
 "./geo/provinces.json",
 "./geo/terrain.bin",
 "./geo/terrain.json"
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' 绕过 HTTP 缓存，保证拿到这一版的文件
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch (e) { /* 单个文件失败不阻断安装，运行时会再补 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dianliang-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function matchCache(cache, req) {
  return (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  // 页面导航：网络优先（3 秒超时），离线时回退到缓存的首页
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const net = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ]);
        if (net.ok && url.pathname.endsWith('/')) cache.put('./', net.clone());
        return net;
      } catch (e) {
        return (await matchCache(cache, req)) || (await cache.match('./')) || (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // 其他同源资源：stale-while-revalidate，先用缓存，后台更新，下次打开就是新数据
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await matchCache(cache, req);
    const update = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(update); return cached; }
    return (await update) || Response.error();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
