// Local demo backend: a tiny JSON database in localStorage, synced across
// tabs on the same device with BroadcastChannel. Same API as the Firebase
// backend, so you can try the game (and develop it) without any setup.

const KEY = "webringo-localdb";

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }

function split(path) { return path.split("/").filter(Boolean); }

function getAt(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

function setAt(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = JSON.parse(JSON.stringify(value));
}

export function createLocalBackend() {
  let uid = sessionStorage.getItem("webringo-uid");
  if (!uid) {
    uid = "local-" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("webringo-uid", uid);
  }

  const channel = "BroadcastChannel" in window ? new BroadcastChannel("webringo") : null;
  const watchers = new Set();
  const notify = () => {
    const db = load();
    watchers.forEach((w) => w.cb(getAt(db, split(w.path))));
  };
  channel?.addEventListener("message", notify);
  window.addEventListener("storage", (e) => { if (e.key === KEY) notify(); });

  const commit = (mutate) => {
    const db = load();
    mutate(db);
    save(db);
    channel?.postMessage("changed");
    queueMicrotask(notify);
  };

  const disconnectWrites = new Map();
  window.addEventListener("pagehide", () => {
    if (!disconnectWrites.size) return;
    const db = load();
    disconnectWrites.forEach((v, p) => setAt(db, split(p), v));
    save(db);
    channel?.postMessage("changed");
  });

  return {
    kind: "local",
    uid,
    serverNow: () => Date.now(),
    async get(path) { return getAt(load(), split(path)); },
    async set(path, value) { commit((db) => setAt(db, split(path), value)); },
    async update(path, values) {
      commit((db) => {
        for (const [k, v] of Object.entries(values)) setAt(db, [...split(path), ...split(k)], v);
      });
    },
    async createIfAbsent(path, value) {
      if (getAt(load(), split(path)) !== null) return false;
      commit((db) => setAt(db, split(path), value));
      return true;
    },
    watch(path, cb) {
      const w = { path, cb };
      watchers.add(w);
      queueMicrotask(() => cb(getAt(load(), split(path))));
      return () => watchers.delete(w);
    },
    async onDisconnectSet(path, value) { disconnectWrites.set(path, value); },
    async cancelOnDisconnect(path) { disconnectWrites.delete(path); },
    onReconnect() {},
  };
}
