// The Scrutineering site's offline copy, in this browser's IndexedDB: what a
// scrutineer downloads for an event (its cars and tech sheets, the stickers
// valid there, copies of their photos), what they change while offline
// (waiting to sync) and their reserved sticker codes. account.js decides what
// goes in; this is only the store.
//   OfflineStore.get(store, key) / put(store, key, value) / del(store, key)
//   OfflineStore.all(store) -> [{ key, value }] in key order; keys(store); clear(store)
// Stores: "kv" (the session snapshot, each event's copy, reserved codes),
// "photos" (SHA-256 -> Blob), "queue" (changes waiting to sync, in order).
(function () {
  const DB = "scrutineering-offline", VERSION = 1, STORES = ["kv", "photos", "queue"];
  let opening = null;
  function db() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("this browser can't keep an offline copy"));
        const req = indexedDB.open(DB, VERSION);
        req.onupgradeneeded = () => STORES.forEach((s) => { if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { opening = null; reject(req.error); };
      });
    }
    return opening;
  }
  // Runs fn(objectStore) in a transaction; resolves with its request's result once committed.
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("the offline copy couldn't be saved (is the device full?)"));
    });
  }
  const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const put = (store, key, value) => tx(store, "readwrite", (s) => s.put(value, key));
  const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
  const keys = (store) => tx(store, "readonly", (s) => s.getAllKeys());
  const clear = (store) => tx(store, "readwrite", (s) => s.clear());
  async function all(store) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = d.transaction(store, "readonly");
      t.objectStore(store).openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push({ key: c.key, value: c.value }); c.continue(); }
      };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  }
  window.OfflineStore = { get, put, del, all, keys, clear };
})();
