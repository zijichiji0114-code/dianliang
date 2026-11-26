/* 点亮山河 · 云端同步（GitHub 私密 Gist + 客户端加密）
 * - token 和加密密钥只存在本机 IndexedDB（dianliang-sync），不会上传到任何地方，也不在代码里。
 * - Gist 里只存 AES-GCM 密文；密钥由「同步口令」经 PBKDF2-SHA256 派生，GitHub 看不到明文。
 * - 本地优先：所有改动先存本机，记录修改时间；联网后合并：每条足迹取最近一次修改，删除记为墓碑，不会被别的设备“复活”。
 */
(function () {
  'use strict';
  if (window.__dlSync) return;
  var DATA_KEY = 'dianliang-shanhe-v1';
  var META_KEY = 'dianliang-sync-meta-v1';
  var MAIN_FILE = 'dianliang-sync.json';
  var API = 'https://api.github.com';
  var ITER = 310000;
  var POLL_MS = 30000;
  var origSetItem = Storage.prototype.setItem;

  /* ---------------- 小工具 ---------------- */
  function now() { return Date.now(); }
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function hash(s) { // cyrb53
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }
  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) { var s = atob(str), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function isIOSStandalone() { return window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches && /iP(hone|ad|od)/.test(navigator.userAgent)); }
  function fmtTime(t) { if (!t) return '还没有'; var d = (now() - t) / 1000; if (d < 60) return '刚刚'; if (d < 3600) return Math.floor(d / 60) + ' 分钟前'; if (d < 86400) return Math.floor(d / 3600) + ' 小时前'; return new Date(t).toLocaleString('zh-CN', { hour12: false }); }

  /* ---------------- 本机存储 ---------------- */
  function openDB(name, stores) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(name, 1);
      r.onupgradeneeded = function () { stores.forEach(function (s) { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); }); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function idb(name, stores, store, mode, fn) {
    return openDB(name, stores).then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(store, mode), os = tx.objectStore(store), out;
        var r = fn(os); if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { db.close(); res(out); }; tx.onerror = function () { db.close(); rej(tx.error); };
      });
    });
  }
  var SDB = ['dianliang-sync', ['kv', 'backups']];
  function kvGet(k) { return idb(SDB[0], SDB[1], 'kv', 'readonly', function (os) { return os.get(k); }); }
  function kvSet(k, v) { return idb(SDB[0], SDB[1], 'kv', 'readwrite', function (os) { os.put(v, k); }); }
  function kvDel(k) { return idb(SDB[0], SDB[1], 'kv', 'readwrite', function (os) { os.delete(k); }); }
  var PDB = ['dianliang-shanhe', ['photos']];
  function photoGet(id) { return idb(PDB[0], PDB[1], 'photos', 'readonly', function (os) { return os.get(id); }); }
  function photoPut(id, v) { return idb(PDB[0], PDB[1], 'photos', 'readwrite', function (os) { os.put(v, id); }); }
  function photoDel(id) { return idb(PDB[0], PDB[1], 'photos', 'readwrite', function (os) { os.delete(id); }); }
  function photoKeys() { return idb(PDB[0], PDB[1], 'photos', 'readonly', function (os) { return os.getAllKeys(); }); }

  function readLocal() {
    try {
      var s = JSON.parse(localStorage.getItem(DATA_KEY) || 'null');
      if (s && s.version === 1 && Array.isArray(s.footprints)) return { version: 1, displayName: typeof s.displayName === 'string' ? s.displayName : '', footprints: s.footprints };
    } catch (e) {}
    return { version: 1, displayName: '', footprints: [] };
  }
  function readMeta() {
    try { var m = JSON.parse(localStorage.getItem(META_KEY) || 'null'); if (m && m.known) return m; } catch (e) {}
    return { known: {}, tomb: {}, name: null, pending: 0, lastSync: 0 };
  }
  function writeMeta(m) { try { origSetItem.call(localStorage, META_KEY, JSON.stringify(m)); } catch (e) {} }

  /* 把本机的变化记成带时间的修改：新增/修改 => 记录时间；消失 => 墓碑 */
  function track() {
    var s = readLocal(), m = readMeta(), t = now(), changed = 0, seen = {};
    s.footprints.forEach(function (f) {
      if (!f || typeof f.id !== 'string') return;
      seen[f.id] = 1;
      var h = hash(stable(f)), k = m.known[f.id];
      if (!k || k.h !== h) { m.known[f.id] = { h: h, t: Math.max(t, (m.tomb[f.id] || 0) + 1) }; delete m.tomb[f.id]; changed++; }
    });
    Object.keys(m.known).forEach(function (id) { if (!seen[id]) { m.tomb[id] = t; delete m.known[id]; changed++; } });
    if (!m.name || m.name.v !== s.displayName) { if (m.name || s.displayName) changed++; m.name = { v: s.displayName, t: m.name ? t : 0 }; }
    if (changed) { m.pending = (m.pending || 0) + changed; writeMeta(m); }
    return { state: s, meta: m };
  }

  /* ---------------- 加密 ---------------- */
  function deriveKey(pass, saltB64) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  function encrypt(key, text) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(text)).then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }
  function decrypt(key, obj) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, key, unb64(obj.ct)).then(function (pt) { return new TextDecoder().decode(pt); });
  }

  /* ---------------- GitHub API ---------------- */
  function SyncError(msg, code) { var e = new Error(msg); e.code = code; return e; }
  function gh(token, method, path, body) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 25000);
    return fetch(path.indexOf('http') === 0 ? path : API + path, {
      method: method, cache: 'no-store', signal: ctl.signal,
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      clearTimeout(timer);
      if (r.status === 401) throw SyncError('GitHub token 无效或已过期，请重新生成后填写。', 'auth');
      if (r.status === 403 || r.status === 429) {
        return r.text().then(function (t) {
          if (/rate limit/i.test(t)) throw SyncError('GitHub 请求太频繁，稍后自动重试。', 'net');
          throw SyncError('这个 token 没有 Gist 权限，请按说明重新生成（要勾选 Gists 读写）。', 'auth');
        });
      }
      if (r.status === 404) throw SyncError('云端存档不存在。', 'notfound');
      if (!r.ok) throw SyncError('GitHub 返回错误 ' + r.status + '，稍后自动重试。', 'net');
      return r.status === 204 ? null : r.json();
    }, function () { clearTimeout(timer); throw SyncError('连不上 GitHub（网络不通或超时），改动已存在本机，联网后自动同步。', 'net'); });
  }
  function fileContent(token, f) {
    if (!f) return Promise.resolve(null);
    if (!f.truncated && typeof f.content === 'string') return Promise.resolve(f.content);
    return fetch(f.raw_url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw SyncError('读取云端文件失败', 'net'); return r.text(); });
  }
  function findMainGist(token) {
    function page(n) {
      return gh(token, 'GET', '/gists?per_page=100&page=' + n).then(function (list) {
        for (var i = 0; i < list.length; i++) if (list[i].files && list[i].files[MAIN_FILE]) return list[i].id;
        return list.length === 100 && n < 10 ? page(n + 1) : null;
      });
    }
    return page(1);
  }

  /* ---------------- 同步核心 ---------------- */
  var cfg = null, busy = null, again = false, status = { state: 'off', msg: '' }, lastErr = null;

  function emptyDoc() { return { app: 'dianliang-sync', v: 1, recs: {}, tomb: {}, name: { v: '', t: 0 }, photos: [], photosGist: null }; }
  function pickWinner(a, b) { // a,b: {t, del?, d?, h?}
    if (!a) return b; if (!b) return a;
    if (a.t !== b.t) return a.t > b.t ? a : b;
    if (!!a.del !== !!b.del) return a.del ? a : b;
    return (a.h || '') >= (b.h || '') ? a : b;
  }
  function localDoc(state, meta) {
    var d = emptyDoc();
    state.footprints.forEach(function (f) { var k = meta.known[f.id]; if (k) d.recs[f.id] = { t: k.t, d: f }; });
    Object.keys(meta.tomb).forEach(function (id) { d.tomb[id] = meta.tomb[id]; });
    d.name = meta.name || { v: state.displayName, t: 0 };
    return d;
  }
  function merge(L, R) {
    var out = emptyDoc(), ids = {};
    [L.recs, L.tomb, R.recs, R.tomb].forEach(function (o) { Object.keys(o || {}).forEach(function (id) { ids[id] = 1; }); });
    Object.keys(ids).forEach(function (id) {
      var c = [];
      if (L.recs[id]) c.push({ t: L.recs[id].t, d: L.recs[id].d, h: hash(stable(L.recs[id].d)) });
      if (R.recs && R.recs[id]) c.push({ t: R.recs[id].t, d: R.recs[id].d, h: hash(stable(R.recs[id].d)) });
      if (L.tomb[id]) c.push({ t: L.tomb[id], del: true });
      if (R.tomb && R.tomb[id]) c.push({ t: R.tomb[id], del: true });
      var w = c.reduce(function (a, b) { return pickWinner(a, b); }, null);
      if (w.del) out.tomb[id] = w.t; else out.recs[id] = { t: w.t, d: w.d };
    });
    out.name = (R.name && R.name.t > (L.name ? L.name.t : -1)) ? R.name : L.name;
    out.photos = (R.photos || []).slice(); out.photosGist = R.photosGist || null;
    return out;
  }
  function docSig(d) { return stable({ r: d.recs, t: d.tomb, n: d.name, p: (d.photos || []).slice().sort(), g: d.photosGist }); }

  function applyLocal(merged, state, meta) {
    var fps = Object.keys(merged.recs).map(function (id) { return merged.recs[id].d; });
    fps.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    var newState = { version: 1, displayName: merged.name ? merged.name.v : state.displayName, footprints: fps };
    var curSig = stable(state.footprints.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; })) + '|' + state.displayName;
    var newSig = stable(fps.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; })) + '|' + newState.displayName;
    meta.known = {}; Object.keys(merged.recs).forEach(function (id) { meta.known[id] = { h: hash(stable(merged.recs[id].d)), t: merged.recs[id].t }; });
    meta.tomb = Object.assign({}, merged.tomb); meta.name = merged.name;
    writeMeta(meta);
    if (curSig === newSig) return false;
    origSetItem.call(localStorage, DATA_KEY, JSON.stringify(newState));
    return true;
  }
  function notifyApp() {
    if (window.__dlSyncHook) { window.dispatchEvent(new Event('dianliang-sync-applied')); toast('已从云端同步最新足迹'); }
    else { toast('已同步，正在刷新…'); setTimeout(function () { location.reload(); }, 800); }
  }

  function loadRemote(c) {
    return gh(c.token, 'GET', '/gists/' + c.gistId).then(function (g) {
      return fileContent(c.token, g.files[MAIN_FILE]).then(function (txt) {
        if (!txt) throw SyncError('云端存档损坏。', 'notfound');
        var env = JSON.parse(txt);
        if (env.salt !== c.salt) throw SyncError('云端存档换了同步口令，请在本机关闭同步后用新口令重新开启。', 'auth');
        return decrypt(c.key, env).then(JSON.parse, function () { throw SyncError('同步口令对不上云端存档，请关闭同步后重新开启。', 'auth'); });
      });
    });
  }
  function saveRemote(c, doc) {
    doc.updatedAt = now(); doc.by = c.deviceId;
    return encrypt(c.key, JSON.stringify(doc)).then(function (e) {
      var env = { format: 'dianliang-sync-enc', v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: c.salt, iv: e.iv, ct: e.ct, note: '点亮山河加密同步数据，请勿手动修改' };
      var files = {}; files[MAIN_FILE] = { content: JSON.stringify(env) };
      return gh(c.token, 'PATCH', '/gists/' + c.gistId, { files: files });
    });
  }
  function createMain(token, key, salt, deviceId) {
    var c = { token: token, key: key, salt: salt, deviceId: deviceId };
    return encrypt(key, JSON.stringify(emptyDoc())).then(function (e) {
      var files = {}; files[MAIN_FILE] = { content: JSON.stringify({ format: 'dianliang-sync-enc', v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: salt, iv: e.iv, ct: e.ct, note: '点亮山河加密同步数据，请勿手动修改' }) };
      return gh(token, 'POST', '/gists', { description: '点亮山河 · 加密同步数据（请勿手动修改）', public: false, files: files });
    }).then(function (g) { c.gistId = g.id; return g.id; });
  }

  /* 照片：单独放一个私密 Gist，平时不拉取，只在缺照片时下载 */
  function photoFile(id) { return 'p-' + id + '.enc'; }
  function downloadPhotos(c, doc, need) {
    if (!need.length || !doc.photosGist) return Promise.resolve();
    return gh(c.token, 'GET', '/gists/' + doc.photosGist).then(function (g) {
      return need.reduce(function (p, id) {
        return p.then(function () {
          var f = g.files[photoFile(id)]; if (!f) return;
          return fileContent(c.token, f).then(function (txt) { return decrypt(c.key, JSON.parse(txt)); }).then(function (dataUrl) { return photoPut(id, dataUrl); }).catch(function () {});
        });
      }, Promise.resolve());
    }).catch(function (e) { if (e.code !== 'notfound') throw e; });
  }
  function uploadPhotos(c, doc) {
    var referenced = {};
    Object.keys(doc.recs).forEach(function (id) { var p = doc.recs[id].d.photoId; if (p) referenced[p] = 1; });
    var have = {}; (doc.photos || []).forEach(function (p) { have[p] = 1; });
    var missing = Object.keys(referenced).filter(function (p) { return !have[p]; });
    var orphans = (doc.photos || []).filter(function (p) { return !referenced[p]; });
    if (!missing.length && !orphans.length) return Promise.resolve(false);
    var ensureGist = doc.photosGist ? Promise.resolve(doc.photosGist) : gh(c.token, 'POST', '/gists', { description: '点亮山河 · 加密照片（请勿手动修改）', public: false, files: { 'README.txt': { content: '点亮山河加密照片，内容已加密，请勿手动修改。' } } }).then(function (g) { doc.photosGist = g.id; return g.id; });
    return ensureGist.then(function (gid) {
      var batches = [], cur = {}, size = 0, uploaded = [];
      return missing.reduce(function (p, id) {
        return p.then(function () { return photoGet(id); }).then(function (dataUrl) {
          if (!dataUrl) return;
          return encrypt(c.key, dataUrl).then(function (e) {
            var s = JSON.stringify(e); cur[photoFile(id)] = { content: s }; size += s.length; uploaded.push(id);
            if (size > 4e6) { batches.push(cur); cur = {}; size = 0; }
          });
        });
      }, Promise.resolve()).then(function () {
        orphans.forEach(function (id) { cur[photoFile(id)] = null; });
        if (Object.keys(cur).length) batches.push(cur);
        return batches.reduce(function (p, files) { return p.then(function () { return gh(c.token, 'PATCH', '/gists/' + gid, { files: files }).catch(function (e) { if (e.code === 'notfound') return null; throw e; }); }); }, Promise.resolve());
      }).then(function () {
        var set = {}; (doc.photos || []).forEach(function (p) { if (referenced[p]) set[p] = 1; }); uploaded.forEach(function (p) { set[p] = 1; });
        doc.photos = Object.keys(set); return true;
      });
    });
  }

  function syncOnce() {
    var c = cfg; if (!c) return Promise.resolve();
    if (!navigator.onLine) { var m0 = track().meta; setStatus('offline', '离线中，' + (m0.pending ? m0.pending + ' 处改动已存在本机，' : '') + '联网后自动同步'); return Promise.resolve(); }
    setStatus('syncing', '正在同步…');
    var remote;
    return loadRemote(c).catch(function (e) {
      if (e.code !== 'notfound') throw e;
      // 云端存档被删了：用同一把钥匙重建，本机数据会完整推上去
      return findMainGist(c.token).then(function (id) {
        if (id) { c.gistId = id; return kvSet('gistId', id).then(function () { return loadRemote(c); }); }
        return createMain(c.token, c.key, c.salt, c.deviceId).then(function (id2) { c.gistId = id2; return kvSet('gistId', id2).then(emptyDoc); });
      });
    }).then(function (r) {
      remote = r;
      // 先把缺的照片下载到本机（多下不碍事），再同步地合并、写入，避免和页面操作交错
      return photoKeys().then(function (keys) {
        var have = {}; keys.forEach(function (k) { have[k] = 1; });
        var need = [];
        Object.keys(remote.recs || {}).forEach(function (id) { var p = remote.recs[id].d.photoId; if (p && !have[p]) need.push(p); });
        return downloadPhotos(c, remote, need);
      });
    }).then(function () {
      var tr = track();
      var L = localDoc(tr.state, tr.meta);
      var merged = merge(L, remote);
      var changed = applyLocal(merged, tr.state, tr.meta);
      if (changed) notifyApp();
      // 本机删掉的照片文件
      var refd = {}; Object.keys(merged.recs).forEach(function (id) { var p = merged.recs[id].d.photoId; if (p) refd[p] = 1; });
      var cleanup = changed ? photoKeys().then(function (keys) {
        var cur = {}; readLocal().footprints.forEach(function (f) { if (f.photoId) cur[f.photoId] = 1; });
        return Promise.all(keys.filter(function (k) { return !refd[k] && !cur[k]; }).map(photoDel));
      }).catch(function () {}) : Promise.resolve();
      return cleanup.then(function () { return uploadPhotos(c, merged); }).then(function () {
        if (docSig(merged) !== docSig(remote)) return saveRemote(c, merged);
      }).then(function () {
        var m = readMeta(); m.pending = 0; m.lastSync = now(); writeMeta(m);
        lastErr = null; setStatus('ok', '已同步');
      });
    }).catch(function (e) {
      lastErr = e; var m = readMeta();
      if (e.code === 'auth') setStatus('error', e.message);
      else setStatus(e.code === 'net' ? 'offline' : 'error', (e.message || String(e)) + (m.pending ? '（待同步 ' + m.pending + ' 处改动）' : ''));
    });
  }
  function sync() {
    if (busy) { again = true; return busy; }
    busy = syncOnce().then(function () { busy = null; if (again) { again = false; return sync(); } });
    return busy;
  }
  var debounce = null;
  function onLocalChange() {
    if (!cfg) return;
    track();
    var m = readMeta(); if (m.pending) setStatus('pending', m.pending + ' 处改动待同步');
    clearTimeout(debounce); debounce = setTimeout(sync, 2000);
  }
  Storage.prototype.setItem = function (k, v) {
    origSetItem.call(this, k, v);
    try { if (this === window.localStorage && k === DATA_KEY) onLocalChange(); } catch (e) {}
  };

  /* ---------------- 备份 ---------------- */
  function buildBackup() {
    var s = readLocal();
    return Promise.all(s.footprints.map(function (f) { return f.photoId ? photoGet(f.photoId).catch(function () { return null; }) : null; })).then(function (photos) {
      return { app: '点亮山河', version: 1, exportedAt: new Date().toISOString(), displayName: s.displayName,
        footprints: s.footprints.map(function (f, i) { var o = Object.assign({}, f); if (photos[i]) o.photo = photos[i]; return o; }) };
    });
  }
  function saveBackup(reason) {
    return buildBackup().then(function (b) {
      return idb(SDB[0], SDB[1], 'backups', 'readwrite', function (os) { os.put({ at: now(), reason: reason, data: b }, 'latest'); }).then(function () { return b; });
    });
  }
  function downloadBackup(b) {
    var name = '点亮山河-同步前备份-' + new Date().toISOString().slice(0, 10) + '.json';
    var blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
    if (isIOSStandalone() || /iP(hone|ad|od)/.test(navigator.userAgent)) {
      var file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file], title: name }).catch(function () {});
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return Promise.resolve();
  }
  function restoreBackup() {
    return idb(SDB[0], SDB[1], 'backups', 'readonly', function (os) { return os.get('latest'); }).then(function (rec) {
      if (!rec) { toast('本机没有同步前备份'); return; }
      if (!confirm('把足迹恢复到 ' + new Date(rec.at).toLocaleString('zh-CN', { hour12: false }) + ' 的备份？\n备份里有的足迹会加回来（会同步到其他设备），现在多出来的不会删除。')) return;
      var s = readLocal(), map = {};
      s.footprints.forEach(function (f) { map[f.id] = f; });
      return rec.data.footprints.reduce(function (p, f) {
        return p.then(function () {
          var o = Object.assign({}, f); delete o.photo;
          var w = f.photo && f.photoId ? photoPut(f.photoId, f.photo) : Promise.resolve();
          return w.then(function () { map[o.id] = o; });
        });
      }, Promise.resolve()).then(function () {
        var fps = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        localStorage.setItem(DATA_KEY, JSON.stringify({ version: 1, displayName: s.displayName || rec.data.displayName || '', footprints: fps }));
        notifyApp();
      });
    });
  }

  /* ---------------- 开启 / 关闭 ---------------- */
  function enable(token, pass, pass2) {
    token = (token || '').trim();
    if (!/^(ghp_|github_pat_|gho_)[A-Za-z0-9_]{20,}$/.test(token)) return Promise.reject(SyncError('token 格式不对：应以 ghp_ 或 github_pat_ 开头。', 'input'));
    if ((pass || '').length < 6) return Promise.reject(SyncError('同步口令至少 6 位。', 'input'));
    var deviceId, login;
    return gh(token, 'GET', '/user').then(function (u) { login = u.login; return findMainGist(token); }).then(function (gid) {
      deviceId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
      if (gid) {
        return gh(token, 'GET', '/gists/' + gid).then(function (g) { return fileContent(token, g.files[MAIN_FILE]); }).then(function (txt) {
          var env = JSON.parse(txt);
          return deriveKey(pass, env.salt).then(function (key) {
            return decrypt(key, env).then(function () { return { gistId: gid, key: key, salt: env.salt, fresh: false }; }, function () { throw SyncError('同步口令不对：要和第一台设备设置的口令一模一样。', 'input'); });
          });
        });
      }
      if (pass2 === null) return { needConfirm: true };
      if (pass !== pass2) throw SyncError('两次输入的同步口令不一致。', 'input');
      var salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      return deriveKey(pass, salt).then(function (key) { return createMain(token, key, salt, deviceId).then(function (id) { return { gistId: id, key: key, salt: salt, fresh: true }; }); });
    }).then(function (r) {
      if (r.needConfirm) return r;
      var hadData = readLocal().footprints.length > 0;
      return saveBackup('first-sync').then(function (b) {
        if (hadData && !isIOSStandalone()) downloadBackup(b).catch(function () {});
        return Promise.all([kvSet('token', token), kvSet('key', r.key), kvSet('salt', r.salt), kvSet('gistId', r.gistId), kvSet('deviceId', deviceId), kvSet('login', login), kvSet('enabledAt', now())]);
      }).then(function () {
        var m = readMeta(); writeMeta(m); track();
        cfg = { token: token, key: r.key, salt: r.salt, gistId: r.gistId, deviceId: deviceId, login: login };
        return sync().then(function () { return { fresh: r.fresh, hadData: hadData }; });
      });
    });
  }
  function disable() {
    cfg = null;
    try { localStorage.removeItem(META_KEY); } catch (e) {}
    return Promise.all(['token', 'key', 'salt', 'gistId', 'login', 'enabledAt'].map(kvDel)).then(function () { setStatus('off', ''); });
  }
  function loadCfg() {
    return Promise.all(['token', 'key', 'salt', 'gistId', 'deviceId', 'login'].map(kvGet)).then(function (v) {
      if (v[0] && v[1] && v[3]) cfg = { token: v[0], key: v[1], salt: v[2], gistId: v[3], deviceId: v[4], login: v[5] };
    }).catch(function () {});
  }

  /* ---------------- 界面 ---------------- */
  var css = '' +
    '#dl-sync-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 11px;margin-left:6px;border-radius:999px;border:1px solid rgba(228,196,138,.35);background:rgba(7,8,13,.6);color:#f6f1e6;font-size:13px;cursor:pointer;position:relative;flex-shrink:0;-webkit-tap-highlight-color:transparent}' +
    '#dl-sync-btn svg{width:17px;height:17px}#dl-sync-btn .dot{width:7px;height:7px;border-radius:50%;background:#6b6458;position:absolute;top:3px;right:4px;box-shadow:0 0 0 2px #07080d}' +
    '#dl-sync-btn[data-s=ok] .dot{background:#4cc38a}#dl-sync-btn[data-s=pending] .dot,#dl-sync-btn[data-s=offline] .dot,#dl-sync-btn[data-s=syncing] .dot{background:#e8a33a}#dl-sync-btn[data-s=error] .dot{background:#e23b2f}' +
    '#dl-sync-btn[data-s=syncing] svg{animation:dlspin 1.2s linear infinite}@keyframes dlspin{to{transform:rotate(360deg)}}' +
    '#dl-sync-mask{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}' +
    '#dl-sync-panel{width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;-webkit-overflow-scrolling:touch;background:#0d0f16;color:#f6f1e6;border:1px solid rgba(228,196,138,.25);border-radius:20px;padding:20px 20px 18px;box-shadow:0 20px 60px rgba(0,0,0,.6);font-size:14px;line-height:1.55}' +
    '@media (max-width:767px){#dl-sync-mask{align-items:flex-end}#dl-sync-panel{width:100vw;border-radius:20px 20px 0 0;max-height:calc(100dvh - env(safe-area-inset-top) - 24px);padding-bottom:calc(18px + env(safe-area-inset-bottom))}}' +
    '#dl-sync-panel h2{font-size:19px;margin:0 0 4px;font-family:serif}#dl-sync-panel .sub{color:#b7ad9c;font-size:12.5px;margin:0 0 14px}' +
    '#dl-sync-panel label{display:block;font-size:12.5px;color:#b7ad9c;margin:12px 0 5px}' +
    '#dl-sync-panel input{width:100%;box-sizing:border-box;height:44px;border-radius:12px;border:1px solid rgba(228,196,138,.3);background:#07080d;color:#f6f1e6;padding:0 12px;font-size:16px;outline:none}' +
    '#dl-sync-panel input:focus{border-color:#e4c48a}' +
    '#dl-sync-panel .btn{display:flex;width:100%;align-items:center;justify-content:center;height:46px;border-radius:12px;border:0;background:#e23b2f;color:#fff;font-size:15px;margin-top:14px;cursor:pointer}' +
    '#dl-sync-panel .btn.ghost{background:transparent;border:1px solid rgba(228,196,138,.3);color:#f6f1e6;height:42px;margin-top:10px}' +
    '#dl-sync-panel .btn:disabled{opacity:.6}#dl-sync-panel .row{display:flex;gap:10px}#dl-sync-panel .row .btn{flex:1}' +
    '#dl-sync-panel .err{color:#ff8a7f;font-size:13px;margin-top:10px;min-height:1em}#dl-sync-panel .st{padding:12px;border-radius:12px;background:#07080d;border:1px solid rgba(228,196,138,.15);font-size:13.5px}' +
    '#dl-sync-panel a{color:#e4c48a}#dl-sync-panel .x{float:right;background:none;border:0;color:#b7ad9c;font-size:22px;line-height:1;cursor:pointer;padding:0 0 0 10px}' +
    '#dl-sync-panel ol{padding-left:18px;margin:8px 0 0;color:#b7ad9c;font-size:12.5px}' +
    '#dl-sync-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom));z-index:1001;background:#14161f;color:#f6f1e6;border:1px solid rgba(228,196,138,.3);padding:9px 14px;border-radius:999px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none}';
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5H7z"/><path d="M9.5 13.5l2 2 3.5-3.5"/></svg>';
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function toast(msg) {
    var t = document.getElementById('dl-sync-toast'); if (t) t.remove();
    t = el('<div id="dl-sync-toast"></div>'); t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function setStatus(s, msg) {
    status = { state: s, msg: msg };
    var b = document.getElementById('dl-sync-btn'); if (b) { b.dataset.s = s; b.title = msg || '云同步'; }
    var st = document.getElementById('dl-sync-st'); if (st) st.innerHTML = statusHTML();
  }
  function statusHTML() {
    var m = readMeta();
    var label = { ok: '✅ 已同步', syncing: '🔄 正在同步…', pending: '🟠 有改动待同步', offline: '🟠 暂时连不上', error: '⚠️ 同步出错', off: '未开启' }[status.state] || '';
    return '<b>' + label + '</b>' + (status.msg && status.state !== 'ok' && status.state !== 'syncing' ? '<br>' + escapeHTML(status.msg) : '') +
      '<br><span style="color:#b7ad9c">上次成功：' + fmtTime(m.lastSync) + (cfg && cfg.login ? ' · 账号 ' + escapeHTML(cfg.login) : '') + '</span>';
  }
  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function closePanel() { var m = document.getElementById('dl-sync-mask'); if (m) m.remove(); }
  function openPanel() {
    closePanel();
    var mask = el('<div id="dl-sync-mask"><div id="dl-sync-panel" role="dialog" aria-label="云同步"></div></div>');
    mask.addEventListener('click', function (e) { if (e.target === mask) closePanel(); });
    document.body.appendChild(mask);
    renderPanel(mask.firstElementChild, false);
  }
  var TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=dianliang-sync';
  function renderPanel(p, confirmMode) {
    if (cfg) {
      p.innerHTML = '<button class="x" aria-label="关闭">×</button><h2>云同步</h2><p class="sub">足迹加密后存在你自己 GitHub 的私密 Gist 里，手机和电脑自动合并。</p>' +
        '<div class="st" id="dl-sync-st">' + statusHTML() + '</div>' +
        '<button class="btn" data-a="now">立即同步</button>' +
        '<div class="row"><button class="btn ghost" data-a="export">导出备份文件</button><button class="btn ghost" data-a="restore">恢复同步前备份</button></div>' +
        '<button class="btn ghost" data-a="off">在这台设备上关闭同步</button>' +
        '<p class="sub" style="margin-top:12px">在另一台设备上：打开同一个网址 → 点「同步」→ 填同一个 token 和同一个同步口令。</p>';
    } else {
      p.innerHTML = '<button class="x" aria-label="关闭">×</button><h2>开启云同步</h2>' +
        '<p class="sub">数据用你的同步口令在本机加密后，存进你自己 GitHub 的私密 Gist。token 和口令只保存在这台设备上。</p>' +
        '<label>GitHub token（只勾 gist 权限）· <a href="' + TOKEN_URL + '" target="_blank" rel="noopener">去生成</a></label>' +
        '<input id="dl-tk" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ghp_… 或 github_pat_…">' +
        '<label>同步口令（所有设备填同一个，至少 6 位）</label><input id="dl-pw" type="password" autocomplete="new-password" placeholder="自己记住，忘了就解不开云端数据">' +
        (confirmMode ? '<label>第一次开启，请再输一遍同步口令</label><input id="dl-pw2" type="password" autocomplete="new-password">' : '') +
        '<div class="err" id="dl-err"></div><button class="btn" data-a="on">' + (confirmMode ? '创建云端存档并同步' : '开启同步') + '</button>' +
        '<ol><li>第一次开启前会自动备份本机现有足迹。</li><li>第二台设备填同样的 token 和口令，会自动找到云端存档并合并，不会覆盖本机数据。</li></ol>';
      if (confirmMode) { p.querySelector('#dl-tk').value = confirmMode.token; p.querySelector('#dl-pw').value = confirmMode.pass; }
    }
    p.querySelector('.x').onclick = closePanel;
    p.querySelectorAll('[data-a]').forEach(function (b) {
      b.onclick = function () {
        var a = b.dataset.a;
        if (a === 'now') { sync().then(function () { toast(status.state === 'ok' ? '已同步' : status.msg); }); }
        else if (a === 'export') buildBackup().then(downloadBackup);
        else if (a === 'restore') restoreBackup();
        else if (a === 'off') { if (confirm('在这台设备上关闭同步？本机足迹会保留，云端存档也不会删除。')) disable().then(function () { renderPanel(p, false); toast('已关闭同步'); }); }
        else if (a === 'on') {
          var tk = p.querySelector('#dl-tk').value, pw = p.querySelector('#dl-pw').value, pw2El = p.querySelector('#dl-pw2'), err = p.querySelector('#dl-err');
          b.disabled = true; b.textContent = '正在连接 GitHub…'; err.textContent = '';
          enable(tk, pw, pw2El ? pw2El.value : null).then(function (r) {
            if (r && r.needConfirm) { renderPanel(p, { token: tk, pass: pw }); p.querySelector('#dl-err').textContent = '云端还没有存档，这是第一台设备。'; return; }
            renderPanel(p, false); toast(r.fresh ? '云端存档已创建，同步已开启' : '已连接云端存档，同步已开启');
          }, function (e) { b.disabled = false; b.textContent = pw2El ? '创建云端存档并同步' : '开启同步'; err.textContent = e.message || String(e); });
        }
      };
    });
  }
  function mountButton() {
    if (document.getElementById('dl-sync-btn')) return;
    var h1 = document.querySelector('header h1'); if (!h1) return;
    var host = h1.parentElement && h1.parentElement.parentElement; if (!host) return;
    var b = el('<button type="button" id="dl-sync-btn" aria-label="云同步">' + ICON + '<span>同步</span><i class="dot"></i></button>');
    b.dataset.s = status.state; b.onclick = openPanel;
    host.appendChild(b);
  }

  function start() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var tries = 0, iv = setInterval(function () { mountButton(); if (++tries > 40 || document.getElementById('dl-sync-btn')) clearInterval(iv); }, 500);
    new MutationObserver(function () { if (!document.getElementById('dl-sync-btn')) mountButton(); }).observe(document.body, { childList: true, subtree: true });
    loadCfg().then(function () {
      if (!cfg) { setStatus('off', ''); return; }
      track(); setStatus('pending', '准备同步');
      setTimeout(sync, 1200);
    });
    setInterval(function () { if (cfg && document.visibilityState === 'visible') sync(); }, POLL_MS);
    window.addEventListener('online', function () { if (cfg) sync(); });
    window.addEventListener('offline', function () { if (cfg) { var m = readMeta(); setStatus('offline', '离线中，改动已存在本机，联网后自动同步'); } });
    document.addEventListener('visibilitychange', function () { if (cfg && document.visibilityState === 'visible') sync(); });
  }
  window.__dlSync = { sync: sync, status: function () { return status; }, enabled: function () { return !!cfg; }, _merge: merge };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
