/* Свои музыкальные файлы ведущего — в IndexedDB браузера.
   Пульт кладёт, экран гостей (тот же браузер) читает. Всё в try/catch:
   без IndexedDB просто играет синтезированная музыка. */
(function () {
  'use strict';
  const DB = 'svoyak-media', STORE = 'music';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  function run(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  window.MediaDB = {
    /** key: 'board' | 'question' | 'final'; value: { name, type, data: ArrayBuffer } */
    put: (key, value) => run('readwrite', (st) => st.put(value, key)).then(() => true).catch((e) => { console.warn('MediaDB.put', e); return false; }),
    get: (key) => run('readonly', (st) => st.get(key)).catch((e) => { console.warn('MediaDB.get', e); return null; }),
    del: (key) => run('readwrite', (st) => st.delete(key)).then(() => true).catch(() => false),
  };
})();
