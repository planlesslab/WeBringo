import { createLocalBackend } from "./backend-local.js";
import { findDuplicates, winningCells, RULE_LABEL } from "./bingo.js";

// ---------- Game settings ----------
const COUNTDOWN_MS = 3800;     // 3, 2, 1, listen!
const HOST_GRACE_MS = 60_000;  // how long the host can be away before someone else takes over
const MAX_PHRASE = 40;         // characters per box
const SIZES = [3, 4, 5];
const RULES = ["line", "full"];

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const VIEWS = ["home", "lobby", "game", "wait", "results"];
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O

const randomCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");
const cleanCode = (s) => (s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const inviteUrl = (c) => `${location.origin}${location.pathname}?room=${c}${backend?.kind === "local" ? "&local" : ""}`;
// Glass-wall pattern: blue down one diagonal, yellow down the other, lilac elsewhere.
const tint = (i, size) => {
  const r = Math.floor(i / size), c = i % size;
  return r === c ? "b" : r + c === size - 1 ? "y" : "l";
};
const pts = (n) => `${n} pt${n === 1 ? "" : "s"}`;

function show(view) {
  const prev = document.body.dataset.view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.body.dataset.view = view;
  // Moving between screens (into the lobby, the game, the results): bring the game into view below the page intro.
  if (prev && prev !== view) {
    const top = $("play").getBoundingClientRect().top;
    if (Math.abs(top) > 4) $("play").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

// ---------- State ----------
let backend = null;
let code = null;            // current room code
let room = null;            // latest room snapshot
let unwatch = null;
let hostOfflineSince = 0;
let wakeLock = null;
let qrFor = null;
let celebratedRound = null;
let editorKey = null;       // which card size the editor inputs were built for
let draft = [];             // phrases being typed in the lobby
let play = null;            // { round, counts, undo: [], bingoSent }
let lastCount = null;
let endConfirmUntil = 0;
let selSize = Number(localStorage.getItem("webringo-size")) || 4;
let selRule = localStorage.getItem("webringo-rule") || "line";
if (!SIZES.includes(selSize)) selSize = 4;
if (!RULES.includes(selRule)) selRule = "line";

const me = () => room?.players?.[backend.uid];
const isHost = () => room?.hostId === backend.uid;
const isParticipant = () => !!room?.participants?.[backend.uid];
const roomPath = (p = "") => `rooms/${code}${p ? "/" + p : ""}`;
const myPath = (p = "") => roomPath(`players/${backend.uid}${p ? "/" + p : ""}`);
const roomSize = () => (SIZES.includes(room?.size) ? room.size : 4);
const cardOk = (p, size) => Array.isArray(p?.card) && p.card.length === size * size && p.card.every((c) => typeof c === "string" && c.trim());

// ---------- Sound ----------
let audio = null;
function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* no audio */ }
}
const NOTES = [784, 880, 988, 1175, 1319];
function ding(kind = "tap") {
  if (!audio) return;
  const seq = kind === "bingo" ? [1047, 1319, 1568, 2093] : [kind === "count" ? 660 : NOTES[Math.floor(Math.random() * NOTES.length)]];
  seq.forEach((f, k) => {
    const t = audio.currentTime + k * 0.11;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === "bingo" ? 0.2 : 0.09, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === "bingo" ? 0.6 : 0.3));
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.7);
  });
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => { wakeLock = null; });
    }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}

// ---------- Settings pickers ----------
function paintSeg(el, attr, value) {
  for (const b of el.querySelectorAll("button")) {
    const on = b.dataset[attr] === String(value);
    b.classList.toggle("selected", on);
    b.setAttribute("aria-pressed", String(on));
  }
}
function paintHomeSettings() {
  paintSeg($("home-size"), "size", selSize);
  paintSeg($("home-rule"), "rule", selRule);
}
$("home-size").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  selSize = Number(b.dataset.size); localStorage.setItem("webringo-size", selSize); paintHomeSettings();
});
$("home-rule").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  selRule = b.dataset.rule; localStorage.setItem("webringo-rule", selRule); paintHomeSettings();
});
$("lobby-size").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b || !isHost() || room.status !== "lobby") return;
  const size = Number(b.dataset.size);
  if (size === roomSize()) return;
  const updates = { size };
  for (const id of Object.keys(room.players || {})) updates[`players/${id}/ready`] = false;
  await backend.update(roomPath(), updates);
});
$("lobby-rule").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b || !isHost() || room.status !== "lobby") return;
  await backend.update(roomPath(), { rule: b.dataset.rule });
});
$("settings-btn").addEventListener("click", () => {
  const box = $("settings-edit");
  box.hidden = !box.hidden;
  $("settings-btn").textContent = box.hidden ? "Change" : "Done";
});

// ---------- Rooms ----------
function playerRecord(name) {
  return { name, online: true, ready: false, joinedAt: backend.serverNow() };
}

async function createRoom() {
  const name = readName();
  if (!name) return;
  unlockAudio();
  setBusy(true);
  try {
    for (let i = 0; i < 8; i++) {
      const c = randomCode();
      const ok = await backend.createIfAbsent(`rooms/${c}`, {
        hostId: backend.uid,
        status: "lobby",
        round: 0,
        size: selSize,
        rule: selRule,
        createdAt: backend.serverNow(),
        players: { [backend.uid]: playerRecord(name) },
      });
      if (ok) return enterRoom(c);
    }
    homeError("Couldn't create a room. Try again.");
  } catch (err) {
    console.error(err);
    homeError("Couldn't create a room. Check your connection.");
  } finally {
    setBusy(false);
  }
}

async function joinRoom(c) {
  const name = readName();
  if (!name) return;
  unlockAudio();
  c = cleanCode(c);
  if (c.length !== 4) return homeError("Room codes are 4 letters.");
  setBusy(true);
  try {
    const host = await backend.get(`rooms/${c}/hostId`);
    if (!host) {
      setInviteMode(null); // let them create their own room instead
      return homeError(`Room ${c} doesn't exist any more. Create a new one, or check the code.`);
    }
    const existing = await backend.get(`rooms/${c}/players/${backend.uid}`);
    await backend.update(`rooms/${c}/players/${backend.uid}`, existing ? { name, online: true } : playerRecord(name));
    enterRoom(c);
  } catch (err) {
    console.error(err);
    homeError("Couldn't join that room. Check your connection.");
  } finally {
    setBusy(false);
  }
}

function enterRoom(c) {
  code = c;
  editorKey = null;
  play = null;
  history.replaceState(null, "", `?room=${c}${backend.kind === "local" ? "&local" : ""}`);
  backend.onDisconnectSet(myPath("online"), false);
  unwatch?.();
  unwatch = backend.watch(roomPath(), (r) => { room = r; render(); });
}

async function leaveRoom() {
  if (!code) return;
  const c = code;
  unwatch?.();
  unwatch = null;
  await backend.cancelOnDisconnect(myPath("online"));
  await backend.set(`rooms/${c}/players/${backend.uid}`, null);
  code = null;
  room = null;
  play = null;
  editorKey = null;
  keepAwake(false);
  history.replaceState(null, "", location.pathname + (backend.kind === "local" && params.has("local") ? "?local" : ""));
  setInviteMode(null);
  show("home");
}

function onlinePlayers() {
  return Object.entries(room.players || {})
    .filter(([, p]) => p.online)
    .sort(([, a], [, b]) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

async function startGame() {
  if (!isHost() || room.status !== "lobby") return;
  const size = roomSize();
  const players = onlinePlayers();
  if (!players.length || !players.every(([, p]) => p.ready && cardOk(p, size))) return;
  const updates = {
    status: "playing",
    round: (room.round || 0) + 1,
    startAt: backend.serverNow() + COUNTDOWN_MS,
    winnerId: null,
    winLine: null,
    endReason: null,
    participants: Object.fromEntries(players.map(([id, p]) => [id, p.name])),
  };
  for (const id of Object.keys(room.players)) {
    updates[`players/${id}/counts`] = null;
    updates[`players/${id}/score`] = null;
    updates[`players/${id}/bingoAt`] = null;
    updates[`players/${id}/winLine`] = null;
  }
  await backend.update(roomPath(), updates);
}

async function endGameNow(reason, winnerId = null, winLine = null) {
  if (!isHost() || room.status !== "playing") return;
  await backend.update(roomPath(), { status: "results", endReason: reason, winnerId, winLine, endedAt: backend.serverNow() });
}

async function playAgain() {
  if (!isHost()) return;
  const updates = { status: "lobby", participants: null, startAt: null, winnerId: null, winLine: null, endReason: null };
  for (const id of Object.keys(room.players || {})) {
    updates[`players/${id}/ready`] = false; // everyone can tweak their card, then tap ready again
    updates[`players/${id}/counts`] = null;
    updates[`players/${id}/score`] = null;
    updates[`players/${id}/bingoAt`] = null;
    updates[`players/${id}/winLine`] = null;
  }
  await backend.update(roomPath(), updates);
}

// ---------- Card editor (lobby) ----------
// In local demo mode every tab is a different player, so keep their drafts apart.
const draftKey = (size) => `webringo-draft-${size}${backend.kind === "local" ? "-" + backend.uid : ""}`;

function buildEditor() {
  const size = roomSize();
  const key = `${code}:${size}`;
  if (editorKey === key) return;
  editorKey = key;
  const n = size * size;
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(draftKey(size))) || []; } catch { /* ignore */ }
  // Prefer the card already stored on the server (e.g. after a reload).
  const server = me()?.card;
  const source = Array.isArray(server) && server.length === n ? server : saved;
  draft = Array.from({ length: n }, (_, i) => (typeof source[i] === "string" ? source[i] : "").slice(0, MAX_PHRASE));

  const grid = $("editor");
  grid.innerHTML = "";
  grid.dataset.size = size;
  grid.style.setProperty("--n", size);
  draft.forEach((text, i) => {
    const cell = document.createElement("div");
    cell.className = `cell tile t-${tint(i, size)}`;
    const ta = document.createElement("textarea");
    ta.maxLength = MAX_PHRASE;
    ta.rows = 3;
    ta.value = text;
    ta.placeholder = String(i + 1);
    ta.setAttribute("aria-label", `Box ${i + 1}`);
    ta.spellcheck = false;
    ta.addEventListener("input", () => {
      ta.value = ta.value.replace(/\n/g, " ");
      draft[i] = ta.value;
      saveDraft();
      validateEditor();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { // jump to the next box instead of a new line
        e.preventDefault();
        grid.querySelectorAll("textarea")[i + 1]?.focus();
      }
    });
    cell.appendChild(ta);
    grid.appendChild(cell);
  });
  validateEditor();
}

function saveDraft() {
  try { localStorage.setItem(draftKey(roomSize()), JSON.stringify(draft)); } catch { /* full */ }
}

/** Returns true when every box is filled and nothing is repeated. */
function validateEditor() {
  const dups = findDuplicates(draft);
  const empty = draft.filter((t) => !t.trim()).length;
  const cells = $("editor").children;
  for (let i = 0; i < cells.length; i++) cells[i].classList.toggle("dup", dups.has(i));
  const ready = !!me()?.ready;
  let msg = "";
  if (dups.size) msg = "Each phrase can only be used once. Change the highlighted boxes.";
  else if (empty) msg = `${empty} box${empty === 1 ? "" : "es"} left to fill.`;
  $("editor-msg").textContent = ready ? "" : msg;
  $("editor-msg").classList.toggle("ok", !dups.size);
  const valid = !dups.size && !empty;
  $("ready-btn").disabled = !ready && !valid;
  return valid;
}

function paintEditorLock() {
  const ready = !!me()?.ready;
  for (const ta of $("editor").querySelectorAll("textarea")) ta.disabled = ready;
  $("editor-card").classList.toggle("locked", ready);
  $("shuffle-btn").hidden = ready;
  $("ready-btn").textContent = ready ? "✓ Ready · edit my card" : "I'm ready";
  $("ready-btn").classList.toggle("primary", !ready);
  validateEditor();
}

$("ready-btn").addEventListener("click", async () => {
  unlockAudio();
  if (me()?.ready) {
    await backend.update(myPath(), { ready: false });
    return;
  }
  if (!validateEditor()) return;
  const card = draft.map((t) => t.trim().replace(/\s+/g, " "));
  await backend.update(myPath(), { card, ready: true });
});

$("shuffle-btn").addEventListener("click", () => {
  for (let i = draft.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [draft[i], draft[j]] = [draft[j], draft[i]];
  }
  saveDraft();
  const tas = $("editor").querySelectorAll("textarea");
  tas.forEach((ta, i) => { ta.value = draft[i]; });
  validateEditor();
});

// ---------- Playing ----------
function ensurePlay() {
  if (play && play.round === room.round) return;
  const size = roomSize();
  const n = size * size;
  const saved = me()?.counts;
  play = {
    round: room.round,
    counts: Array.from({ length: n }, (_, i) => Number(saved?.[i]) || 0),
    undo: [],
    bingoSent: !!me()?.bingoAt,
  };
  lastCount = null;
  const card = me().card || [];
  const grid = $("play-grid");
  grid.innerHTML = "";
  grid.style.setProperty("--n", size);
  grid.dataset.size = size;
  for (let i = 0; i < n; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cell tile t-${tint(i, size)}`;
    const t = document.createElement("span");
    t.className = "phrase";
    t.textContent = card[i] || "";
    const badge = document.createElement("span");
    badge.className = "count";
    b.append(t, badge);
    b.addEventListener("click", () => tapCell(i));
    grid.appendChild(b);
  }
  paintPlayGrid();
  $("hud-rule").textContent = room.rule === "full" ? "Full card bingo" : "Line bingo";
  keepAwake(true);
}

function paintPlayGrid(pulse = -1) {
  const cells = $("play-grid").children;
  const win = winningCells(play.counts, roomSize(), room.rule);
  const winSet = new Set(win || []);
  for (let i = 0; i < cells.length; i++) {
    const c = play.counts[i];
    cells[i].classList.toggle("marked", c > 0);
    cells[i].classList.toggle("win", winSet.has(i));
    cells[i].querySelector(".count").textContent = c > 0 ? (c > 1 ? `×${c}` : "✓") : "";
    cells[i].setAttribute("aria-label", `${cells[i].querySelector(".phrase").textContent}: heard ${c} time${c === 1 ? "" : "s"}`);
    if (i === pulse) { cells[i].classList.remove("pop"); void cells[i].offsetWidth; cells[i].classList.add("pop"); }
  }
  const score = play.counts.reduce((a, b) => a + b, 0);
  $("hud-score").textContent = score;
  $("undo-btn").disabled = !play.undo.length || room.status !== "playing";
}

function canTap() {
  return room?.status === "playing" && isParticipant() && backend.serverNow() >= room.startAt;
}

function tapCell(i) {
  unlockAudio();
  if (!play || !canTap()) return;
  play.counts[i] += 1;
  play.undo.push(i);
  const score = play.counts.reduce((a, b) => a + b, 0);
  const win = winningCells(play.counts, roomSize(), room.rule);
  const updates = { counts: play.counts, score };
  if (win && !play.bingoSent) {
    play.bingoSent = true;
    updates.bingoAt = backend.serverNow();
    updates.winLine = win;
    flashBingo();
    ding("bingo");
    navigator.vibrate?.([60, 40, 160]);
  } else {
    ding(play.counts[i] > 1 ? "count" : "tap");
    navigator.vibrate?.(15);
  }
  backend.update(myPath(), updates);
  paintPlayGrid(i);
}

$("undo-btn").addEventListener("click", () => {
  if (!play?.undo.length || room?.status !== "playing") return;
  const i = play.undo.pop();
  play.counts[i] = Math.max(0, play.counts[i] - 1);
  const score = play.counts.reduce((a, b) => a + b, 0);
  backend.update(myPath(), { counts: play.counts, score });
  paintPlayGrid();
});

function flashBingo() {
  const el = $("bingo-flash");
  el.hidden = false;
  el.classList.remove("go"); void el.offsetWidth; el.classList.add("go");
  setTimeout(() => (el.hidden = true), 1800);
}

$("end-btn").addEventListener("click", () => {
  if (!isHost()) return;
  const now = Date.now();
  if (now < endConfirmUntil) {
    endConfirmUntil = 0;
    endGameNow("host");
    return;
  }
  endConfirmUntil = now + 3000;
  $("end-btn").textContent = "Tap again to end the game";
  $("end-btn").classList.add("confirm");
  setTimeout(() => {
    if (Date.now() >= endConfirmUntil) {
      $("end-btn").textContent = "End game";
      $("end-btn").classList.remove("confirm");
    }
  }, 3100);
});

function renderLiveScores() {
  const list = $("live-scores");
  list.innerHTML = "";
  const rows = Object.keys(room.participants || {}).map((id) => {
    const p = room.players?.[id] || {};
    const score = id === backend.uid ? play.counts.reduce((a, b) => a + b, 0) : p.score || 0;
    return { id, name: p.name || room.participants[id], score, online: p.online !== false };
  }).sort((a, b) => b.score - a.score);
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "glass" + (r.id === backend.uid ? " me" : "") + (r.online ? "" : " away");
    const n = document.createElement("span");
    n.textContent = (r.id === room.hostId ? "👑 " : "") + r.name;
    const s = document.createElement("b");
    s.textContent = r.score;
    li.append(n, s);
    list.appendChild(li);
  }
}

// ---------- Rendering ----------
function render() {
  if (!code) return show("home");
  if (!room) {
    const c = code;
    code = null;
    unwatch?.();
    show("home");
    homeError(`Room ${c} has closed.`);
    return;
  }
  if (!me()) return; // our join write hasn't landed yet

  maybeTakeOverHost();

  if (room.status === "lobby") {
    play = null;
    keepAwake(false);
    return renderLobby();
  }
  if (room.status === "results") return renderResults();

  // playing
  if (!isParticipant()) {
    $("wait-title").textContent = "Game in progress";
    $("wait-sub").textContent = "You'll join in the next game. Listen in for now!";
    show("wait");
    return;
  }
  ensurePlay();
  show("game");
  $("end-btn").hidden = !isHost();
  renderLiveScores();
  paintPlayGrid();
}

function renderLobby() {
  show("lobby");
  $("room-code").textContent = code;
  renderQr();

  const size = roomSize();
  const host = isHost();
  $("chip-size").textContent = `${size}×${size} card`;
  $("chip-rule").textContent = room.rule === "full" ? "Full card bingo" : "Line bingo";
  $("rule-text").textContent = RULE_LABEL[room.rule === "full" ? "full" : "line"] + ". Every mention scores +1, and the game ends at the first bingo.";
  $("settings-btn").hidden = !host;
  if (!host) $("settings-edit").hidden = true;
  paintSeg($("lobby-size"), "size", size);
  paintSeg($("lobby-rule"), "rule", room.rule === "full" ? "full" : "line");

  // A size change means the card we submitted no longer fits.
  if (me().ready && !cardOk(me(), size)) backend.update(myPath(), { ready: false });

  buildEditor();
  paintEditorLock();

  const players = onlinePlayers();
  const readyN = players.filter(([, p]) => p.ready && cardOk(p, size)).length;
  $("ready-count").textContent = `· ${readyN} of ${players.length} ready`;
  const list = $("player-list");
  list.innerHTML = "";
  for (const [id, p] of players) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = (id === room.hostId ? "👑 " : "") + p.name;
    if (id === backend.uid) { name.classList.add("me"); name.textContent += " (you)"; }
    const ok = p.ready && cardOk(p, size);
    const tag = document.createElement("span");
    tag.className = "tag" + (ok ? " ok" : "");
    tag.textContent = ok ? "✓ ready" : "filling card…";
    li.append(name, tag);
    list.appendChild(li);
  }

  const allReady = players.length > 0 && readyN === players.length;
  $("start-btn").hidden = !host;
  $("start-btn").disabled = !allReady;
  $("start-btn").textContent = `Start game · ${players.length} player${players.length === 1 ? "" : "s"}`;
  const waiting = players.length - readyN;
  $("lobby-wait").textContent = host
    ? (allReady ? "Everyone's ready. Start when you like!" : `Waiting for ${waiting} player${waiting === 1 ? "" : "s"} to finish their card…`)
    : (me().ready ? "You're ready! Waiting for the host to start…" : "Fill your card and tap I'm ready.");
}

function renderQr() {
  if (qrFor === code) return;
  const box = $("qr");
  if (!window.qrcode) {
    box.innerHTML = "";
    window.addEventListener("load", () => { qrFor = null; if (room?.status === "lobby") renderQr(); }, { once: true });
    return;
  }
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(inviteUrl(code));
    qr.make();
    box.innerHTML = qr.createImgTag(4, 0, "QR code to join");
    qrFor = code;
  } catch { box.innerHTML = ""; }
}

function standings() {
  const rows = Object.keys(room.participants || {}).map((id) => {
    const p = room.players?.[id] || {};
    const savedName = typeof room.participants[id] === "string" ? room.participants[id] : "Someone";
    const counts = Array.isArray(p.counts) ? p.counts : Object.values(p.counts || {});
    return { id, name: p.name || savedName, score: p.score || 0, heard: counts.filter((c) => c > 0).length, bingo: id === room.winnerId };
  });
  // Highest score first; on a tie the bingo winner goes ahead, then whoever ticked more boxes.
  rows.sort((a, b) => b.score - a.score || (b.bingo - a.bingo) || b.heard - a.heard || a.name.localeCompare(b.name));
  // Equal scores share a rank.
  rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].score === r.score && !r.bingo && !rows[i - 1].bingo ? rows[i - 1].rank : i + 1; });
  return rows;
}

function renderResults() {
  if (document.body.dataset.view !== "results") {
    // Avoid accidental taps while people are still tapping boxes.
    for (const id of ["again-btn", "leave-btn-2"]) {
      $(id).disabled = true;
      setTimeout(() => ($(id).disabled = false), 1500);
    }
  }
  show("results");
  keepAwake(false);
  const rows = standings();
  const winner = room.players?.[room.winnerId];
  const winnerName = winner?.name || room.participants?.[room.winnerId];

  if (room.endReason === "bingo" && winnerName) {
    $("result-reason").textContent = room.rule === "full" ? "Full card!" : "Line complete!";
    $("result-title").textContent = room.winnerId === backend.uid ? "You called BINGO! 🎉" : `${winnerName} called BINGO! 🎉`;
  } else {
    $("result-reason").textContent = "The host ended the game";
    $("result-title").textContent = "Final scores";
  }

  const podium = $("podium");
  podium.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  for (let i = 0; i < 3; i++) {
    const r = rows[i];
    const step = document.createElement("div");
    step.className = `step p${i + 1}` + (r ? "" : " empty");
    if (r) {
      const crown = document.createElement("div");
      crown.className = "crown";
      crown.textContent = medals[r.rank - 1] || "🏅";
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = r.name + (r.id === backend.uid ? " (you)" : "");
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = pts(r.score);
      step.append(crown, who, t);
      if (r.bingo) {
        const tag = document.createElement("div");
        tag.className = "bingo-tag";
        tag.textContent = "BINGO";
        step.appendChild(tag);
      }
    }
    const block = document.createElement("div");
    block.className = `block tile t-${["b", "l", "y"][i]}`;
    block.textContent = r ? r.rank : "";
    step.appendChild(block);
    podium.appendChild(step);
  }

  const rest = $("rest-list");
  rest.innerHTML = "";
  rows.slice(3).forEach((r) => {
    const li = document.createElement("li");
    li.className = r.id === backend.uid ? "me" : "";
    const n = document.createElement("span");
    n.textContent = `${r.rank}.  ${r.name}${r.bingo ? "  · BINGO" : ""}`;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = pts(r.score);
    li.append(n, t);
    rest.appendChild(li);
  });

  // Show the winning card with its bingo highlighted.
  const box = $("winner-card-box");
  const card = winner?.card;
  if (room.endReason === "bingo" && Array.isArray(card)) {
    box.hidden = false;
    $("winner-card-title").textContent = room.winnerId === backend.uid ? "Your winning card" : `${winnerName}'s winning card`;
    const size = Math.round(Math.sqrt(card.length));
    const counts = Array.isArray(winner.counts) ? winner.counts : [];
    const line = new Set(room.winLine || winner.winLine || []);
    const grid = $("winner-grid");
    grid.innerHTML = "";
    grid.style.setProperty("--n", size);
    grid.dataset.size = size;
    card.forEach((text, i) => {
      const c = document.createElement("div");
      c.className = `cell tile t-${tint(i, size)}` + ((counts[i] || 0) > 0 ? " marked" : "") + (line.has(i) ? " win" : "");
      const p = document.createElement("span");
      p.className = "phrase";
      p.textContent = text;
      const b = document.createElement("span");
      b.className = "count";
      b.textContent = counts[i] > 1 ? `×${counts[i]}` : counts[i] ? "✓" : "";
      c.append(p, b);
      grid.appendChild(c);
    });
  } else {
    box.hidden = true;
  }

  $("again-btn").hidden = !isHost();
  $("again-wait").hidden = isHost();

  if (celebratedRound !== room.round) {
    celebratedRound = room.round;
    if (room.winnerId === backend.uid || rows[0]?.id === backend.uid) { confetti(); ding("bingo"); }
  }
}

function confetti() {
  const layer = document.createElement("div");
  layer.className = "confetti";
  document.body.appendChild(layer);
  const colours = ["#5b7cfa", "#d6b4f0", "#f3d57e", "#ffffff", "#9fb4ff"];
  for (let i = 0; i < 70; i++) {
    const d = document.createElement("div");
    const size = 6 + Math.random() * 8;
    Object.assign(d.style, {
      position: "absolute", left: Math.random() * 100 + "vw", top: "-20px",
      width: size + "px", height: size * (Math.random() < 0.5 ? 1 : 0.5) + "px",
      background: colours[i % colours.length], borderRadius: Math.random() < 0.4 ? "50%" : "3px",
      boxShadow: "0 0 6px rgba(255,255,255,.8)",
    });
    layer.appendChild(d);
    d.animate(
      [
        { transform: "translate(0,0) rotate(0)" },
        { transform: `translate(${(Math.random() - 0.5) * 200}px, 110vh) rotate(${Math.random() * 900}deg)` },
      ],
      { duration: 2200 + Math.random() * 1800, delay: Math.random() * 600, easing: "cubic-bezier(.3,.6,.6,1)", fill: "forwards" }
    );
  }
  setTimeout(() => layer.remove(), 5000);
}

// ---------- Clock tick: countdown, host duties ----------
setInterval(() => {
  if (!room || !code || !backend) return;
  const now = backend.serverNow();

  if (room.status === "playing" && play && isParticipant()) {
    const cd = $("countdown");
    if (now < room.startAt) {
      const n = Math.ceil((room.startAt - now) / 1000);
      const label = n > 3 ? "" : String(n);
      cd.hidden = !label;
      if (label && label !== lastCount) {
        cd.textContent = label;
        cd.classList.remove("pop"); void cd.offsetWidth; cd.classList.add("pop");
        ding("count");
      }
      lastCount = label;
    } else if (lastCount !== "go") {
      lastCount = "go";
      cd.textContent = "Listen!";
      cd.hidden = false;
      cd.classList.remove("pop"); void cd.offsetWidth; cd.classList.add("pop");
      setTimeout(() => { if (lastCount === "go") cd.hidden = true; }, 800);
    }
  }

  // Host ends the game at the first bingo (earliest one wins if two land together).
  if (isHost() && room.status === "playing") {
    const bingos = Object.keys(room.participants || {})
      .map((id) => ({ id, at: room.players?.[id]?.bingoAt, line: room.players?.[id]?.winLine }))
      .filter((b) => b.at)
      .sort((a, b) => a.at - b.at);
    if (bingos.length) endGameNow("bingo", bingos[0].id, bingos[0].line || null);
  }

  maybeTakeOverHost();
}, 200);

function maybeTakeOverHost() {
  if (!room || isHost() || !me()?.online) return;
  const host = room.players?.[room.hostId];
  if (host?.online) { hostOfflineSince = 0; return; }
  if (!hostOfflineSince) hostOfflineSince = Date.now();
  if (Date.now() - hostOfflineSince < HOST_GRACE_MS) return;
  const next = onlinePlayers()[0];
  if (next?.[0] === backend.uid) {
    hostOfflineSince = 0;
    backend.set(roomPath("hostId"), backend.uid).catch(() => {});
  }
}

// ---------- Home screen ----------
function readName() {
  const name = $("name-input").value.trim().slice(0, 16);
  if (!name) {
    homeError("Enter your name first.");
    $("name-input").focus();
    return null;
  }
  localStorage.setItem("webringo-name", name);
  return name;
}
function homeError(msg) { $("home-error").textContent = msg; }

/** Opened from an invite link: only show name + join. */
function setInviteMode(c) {
  const on = !!c;
  $("invite-head").hidden = !on;
  $("invite-code").textContent = c || "";
  $("invite-join-btn").hidden = !on;
  $("create-btn").hidden = on;
  $("create-settings").hidden = on;
  $("join-divider").hidden = on;
  $("join-row").hidden = on;
}
function setBusy(b) { for (const id of ["create-btn", "join-btn", "invite-join-btn"]) $(id).disabled = b; }

$("create-btn").addEventListener("click", () => { homeError(""); createRoom(); });
$("join-btn").addEventListener("click", () => { homeError(""); joinRoom($("code-input").value); });
$("invite-join-btn").addEventListener("click", () => { homeError(""); joinRoom($("invite-code").textContent); });
$("name-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!$("invite-join-btn").hidden) $("invite-join-btn").click();
});
$("code-input").addEventListener("input", (e) => { e.target.value = cleanCode(e.target.value); });
$("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
$("start-btn").addEventListener("click", () => { unlockAudio(); startGame(); });
$("again-btn").addEventListener("click", playAgain);
for (const id of ["leave-btn", "leave-btn-2", "leave-btn-3"]) $(id).addEventListener("click", leaveRoom);
$("share-btn").addEventListener("click", async () => {
  const url = inviteUrl(code);
  try {
    if (navigator.share) {
      await navigator.share({ title: "WeBringo", text: `Join my WeBringo room: ${code}`, url });
    } else {
      await navigator.clipboard.writeText(url);
      $("share-note").textContent = "Link copied!";
      setTimeout(() => ($("share-note").textContent = ""), 2500);
    }
  } catch { /* share cancelled */ }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && room?.status === "playing") keepAwake(true);
});

// ---------- Boot ----------
async function boot() {
  show("home");
  paintHomeSettings();
  $("name-input").value = localStorage.getItem("webringo-name") || "";
  const roomParam = cleanCode(params.get("room"));
  if (roomParam) { $("code-input").value = roomParam; setInviteMode(roomParam); }

  const banner = $("mode-banner");
  setBusy(true);

  // Load the config separately, so a mistake in it shows a clear message
  // instead of a page where nothing works.
  let firebaseConfig = null;
  let configError = "";
  try {
    ({ firebaseConfig } = await import("./firebase-config.js"));
    if (!firebaseConfig) configError = "js/firebase-config.js must start with: export const firebaseConfig = {  (the word export is missing).";
  } catch (err) {
    console.error(err);
    configError = "js/firebase-config.js has a typo, so it can't be read. Compare it with the example in the README.";
  }
  const configured = firebaseConfig?.apiKey && !firebaseConfig.apiKey.startsWith("YOUR");
  if (!configError && configured && !/^https:\/\//.test(firebaseConfig.databaseURL || "") && !params.has("local")) {
    configError = "js/firebase-config.js is missing databaseURL. Copy it from Firebase → Realtime Database (the address at the top of the Data tab).";
  }
  if (configError) {
    banner.hidden = false;
    banner.classList.add("bad");
    banner.textContent = "Setup problem: " + configError;
    return;
  }

  try {
    if (configured && !params.has("local")) {
      const { createFirebaseBackend } = await import("./backend-firebase.js");
      backend = await createFirebaseBackend(firebaseConfig);
      backend.onReconnect(() => {
        if (!code) return;
        backend.update(myPath(), { online: true });
        backend.onDisconnectSet(myPath("online"), false);
      });
    } else {
      backend = createLocalBackend();
      banner.hidden = false;
      banner.textContent = configured
        ? "Local demo mode: open more tabs on this device to add players."
        : "Local demo mode: add your Firebase config to play across phones. Open more tabs to add players.";
    }
  } catch (err) {
    console.error(err);
    banner.hidden = false;
    banner.textContent = "Couldn't connect to the game server. Check your connection and reload.";
    return;
  }
  setBusy(false);
}

boot();
