// Firebase Realtime Database backend.
// Paths look like "rooms/ABCD/players/<uid>".

const V = "10.12.2";

export async function createFirebaseBackend(config) {
  const [{ initializeApp }, auth, db] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-database.js`),
  ]);

  const app = initializeApp(config);
  const a = auth.getAuth(app);
  const cred = await auth.signInAnonymously(a);
  const uid = cred.user.uid;
  const database = db.getDatabase(app);
  const r = (path) => db.ref(database, path);

  let offset = 0;
  db.onValue(r(".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });

  const reconnectHandlers = [];
  let wasConnected = false;
  db.onValue(r(".info/connected"), (s) => {
    const connected = s.val() === true;
    if (connected && wasConnected === false) reconnectHandlers.forEach((fn) => fn());
    wasConnected = connected;
  });

  return {
    kind: "firebase",
    uid,
    serverNow: () => Date.now() + offset,

    async get(path) {
      return (await db.get(r(path))).val();
    },
    set: (path, value) => db.set(r(path), value),
    update: (path, values) => db.update(r(path), values),

    /** Create `path` with `value` only if nothing is there yet. */
    async createIfAbsent(path, value) {
      const res = await db.runTransaction(r(path), (cur) => (cur === null ? value : undefined));
      return res.committed;
    },

    watch(path, cb) {
      return db.onValue(r(path), (s) => cb(s.val()));
    },

    /** Write `value` at `path` automatically if this client disconnects. */
    onDisconnectSet: (path, value) => db.onDisconnect(r(path)).set(value),
    cancelOnDisconnect: (path) => db.onDisconnect(r(path)).cancel(),

    /** Run fn every time the connection comes back (to re-mark ourselves online). */
    onReconnect(fn) { reconnectHandlers.push(fn); },
  };
}
