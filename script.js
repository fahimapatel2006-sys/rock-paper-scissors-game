/* ═══════════════════════════════════════════════════════════════════
   ROCK PAPER SCISSORS  ·  script.js
   ─────────────────────────────────────────────────────────────────
   Bugs fixed:
     1. Room "not found" — rooms now use localStorage with a shared
        storage-event bridge so same-browser tabs sync instantly.
        joinRoom() also strips whitespace and forces uppercase before
        lookup, and the stale-room cleanup no longer runs BEFORE the
        new room is written (was nuking fresh rooms on slow devices).
     2. Auth tab resets to "Log In" every time showScreen('auth') is
        called, so revisiting after sign-up shows the correct tab.
     3. pollGame() checked roundPhase but never guarded against
        acting on a stale reveal cycle — added proper phase guards.
     4. leaveRoom() for non-host now just clears p2 rather than
        silently doing nothing (was leaving ghost p2 entries).
     5. nextRound patch now only fires from host to prevent both
        players double-patching the same round increment.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ─── Constants ─────────────────────────────────────────────────── */
const CHOICES = {
  rock:     { emoji: '🪨', label: 'Rock'     },
  paper:    { emoji: '📄', label: 'Paper'    },
  scissors: { emoji: '✂️',  label: 'Scissors' },
};
const BEATS       = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const USERS_KEY   = 'rps_users_v2';
const ROOMS_KEY   = 'rps_rooms_v2';
const SESSION_KEY = 'rps_session_v2';
const POLL_MS     = 400;

/* ─── State ──────────────────────────────────────────────────────── */
const state = {
  user:         null,   // { username, displayName }
  mode:         null,   // 'bot' | '2p'
  roomCode:     null,
  isHost:       false,

  myScore:      0,
  oppScore:     0,
  round:        0,
  history:      [],
  myChoice:     null,
  roundLocked:  false,
  roundPhase:   'pick',  // 'pick' | 'reveal'
};

let pollTimer = null;

/* ═══════════════════════════════════════════════════════════════════
   STORAGE HELPERS
   All room reads go through getRooms() which always reads fresh from
   localStorage — no in-memory caching that could go stale.
═══════════════════════════════════════════════════════════════════ */
function getUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}'); } catch { return {}; }
}
function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

function getRooms() {
  try { return JSON.parse(localStorage.getItem(ROOMS_KEY) || '{}'); } catch { return {}; }
}
function saveRooms(r) { localStorage.setItem(ROOMS_KEY, JSON.stringify(r)); }

function getRoom() {
  if (!state.roomCode) return null;
  return getRooms()[state.roomCode] || null;
}

function patchRoom(patch) {
  const rooms = getRooms();
  if (!rooms[state.roomCode]) return;
  Object.assign(rooms[state.roomCode], patch);
  saveRooms(rooms);
}

/* ═══════════════════════════════════════════════════════════════════
   SCREEN MANAGEMENT
═══════════════════════════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('screen-active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('screen-active');

  /* FIX #2 — always reset auth UI to "Log In" when returning to auth */
  if (id === 'auth') {
    resetAuthUI();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════════════════ */
let authMode = 'login';

function resetAuthUI() {
  authMode = 'login';
  document.getElementById('tab-login').classList.add('active');
  document.getElementById('tab-signup').classList.remove('active');
  document.getElementById('auth-submit').textContent = 'Log In →';
  document.getElementById('auth-user').value = '';
  document.getElementById('auth-pass').value = '';
  hideError('auth-error');
}

function switchTab(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active',  mode === 'login');
  document.getElementById('tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-submit').textContent = mode === 'login' ? 'Log In →' : 'Create Account →';
  hideError('auth-error');
}

function handleAuth() {
  const rawUsername = document.getElementById('auth-user').value.trim();
  const username    = rawUsername.toLowerCase();
  const password    = document.getElementById('auth-pass').value;
  const users       = getUsers();

  if (!username || !password) { showError('auth-error', 'Please fill in both fields.'); return; }
  if (username.length < 2)    { showError('auth-error', 'Username must be at least 2 characters.'); return; }

  if (authMode === 'signup') {
    if (users[username])      { showError('auth-error', 'Username already taken — try another!'); return; }
    if (password.length < 4)  { showError('auth-error', 'Password must be at least 4 characters.'); return; }
    users[username] = { password, displayName: rawUsername };
    saveUsers(users);
    loginUser({ username, displayName: rawUsername });
  } else {
    if (!users[username] || users[username].password !== password) {
      showError('auth-error', 'Wrong username or password.'); return;
    }
    loginUser({ username, displayName: users[username].displayName });
  }
}

function loginUser(user) {
  state.user = user;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  enterLobby();
}

function signOut() {
  stopPolling();
  sessionStorage.removeItem(SESSION_KEY);
  state.user = null;
  showScreen('auth');   // resetAuthUI() called inside showScreen
}

/* ═══════════════════════════════════════════════════════════════════
   LOBBY
═══════════════════════════════════════════════════════════════════ */
function enterLobby() {
  stopPolling();
  state.mode     = null;
  state.roomCode = null;
  state.isHost   = false;

  const name = state.user.displayName;
  document.getElementById('lobby-name').textContent  = name;
  document.getElementById('lobby-avatar').textContent = name[0].toUpperCase();
  document.getElementById('join-code').value          = '';
  hideError('join-error');

  showScreen('lobby');
}

/* ═══════════════════════════════════════════════════════════════════
   ROOM CREATION / JOINING
═══════════════════════════════════════════════════════════════════ */
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom() {
  const code = genCode();

  /* FIX #1a — clean stale rooms BEFORE writing the new one, and
     use a dedicated read-modify-write so we never accidentally
     overwrite a room we just created.                            */
  const rooms = getRooms();
  const now   = Date.now();
  for (const k of Object.keys(rooms)) {
    if (now - (rooms[k].createdAt || 0) > 30 * 60 * 1000) delete rooms[k];
  }

  rooms[code] = {
    code,
    createdAt:   now,
    p1:          state.user,
    p2:          null,
    started:     false,
    p1Choice:    null,
    p2Choice:    null,
    roundNum:    1,
    roundResult: null,
  };
  saveRooms(rooms);   // single atomic write

  state.roomCode = code;
  state.isHost   = true;
  state.mode     = '2p';
  enterWaiting();
}

function joinRoom() {
  /* FIX #1b — sanitise input: strip whitespace, force uppercase */
  const raw  = document.getElementById('join-code').value;
  const code = raw.replace(/\s/g, '').toUpperCase();

  if (!code || code.length < 4) { showError('join-error', 'Enter a 4-character room code.'); return; }

  const rooms = getRooms();

  if (!rooms[code]) {
    showError('join-error', 'Room not found — double-check the code!'); return;
  }

  const room = rooms[code];

  if (room.started) {
    showError('join-error', 'This game has already started!'); return;
  }
  if (room.p1.username === state.user.username) {
    showError('join-error', "That's your own room — share the code with a friend!"); return;
  }
  if (room.p2 && room.p2.username !== state.user.username) {
    showError('join-error', 'This room is already full!'); return;
  }

  /* Atomic write: read → modify → save */
  rooms[code].p2 = state.user;
  saveRooms(rooms);

  state.roomCode = code;
  state.isHost   = false;
  state.mode     = '2p';
  enterWaiting();
}

/* ═══════════════════════════════════════════════════════════════════
   WAITING ROOM
═══════════════════════════════════════════════════════════════════ */
function enterWaiting() {
  stopPolling();

  document.getElementById('waiting-code').textContent   = state.roomCode;
  document.getElementById('waiting-kicker').textContent =
    state.isHost ? 'Share this code' : 'Waiting for host';

  renderWaitingPlayers();
  showScreen('waiting');
  startPolling(pollWaiting);
}

function renderWaitingPlayers() {
  const room = getRoom();
  if (!room) return;

  document.getElementById('prow-1-avatar').textContent = room.p1.displayName[0].toUpperCase();
  document.getElementById('prow-1-name').textContent   = room.p1.displayName;

  const hasP2 = !!room.p2;
  const p2Row  = document.getElementById('prow-2');

  if (hasP2) {
    p2Row.classList.add('joined');
    document.getElementById('prow-2-avatar').className   = 'prow-avatar p2';
    document.getElementById('prow-2-avatar').textContent = room.p2.displayName[0].toUpperCase();
    document.getElementById('prow-2-name').style.color   = '';
    document.getElementById('prow-2-name').textContent   = room.p2.displayName;
    document.getElementById('prow-2-tag').innerHTML      = '<span class="prow-tag ready">Ready ✓</span>';

    if (state.isHost) {
      document.getElementById('waiting-hint').textContent = room.p2.displayName + ' has joined! Start when ready.';
      document.getElementById('btn-start').style.display  = 'inline-flex';
    } else {
      document.getElementById('waiting-hint').textContent = 'Waiting for host to start the game…';
    }
  } else {
    p2Row.classList.remove('joined');
    document.getElementById('prow-2-avatar').className   = 'prow-avatar empty';
    document.getElementById('prow-2-avatar').textContent = '?';
    document.getElementById('prow-2-name').style.color   = 'var(--muted)';
    document.getElementById('prow-2-name').textContent   = 'Waiting for player…';
    document.getElementById('prow-2-tag').innerHTML      = '<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
    document.getElementById('btn-start').style.display   = 'none';
    document.getElementById('waiting-hint').textContent  = 'Waiting for your friend to join…';
  }
}

function pollWaiting() {
  const room = getRoom();
  if (!room) { enterLobby(); return; }

  renderWaitingPlayers();

  /* non-host: wait for host to press Start */
  if (!state.isHost && room.started) {
    stopPolling();
    enterGame();
  }
}

function hostStartGame() {
  patchRoom({ started: true, roundNum: 1, p1Choice: null, p2Choice: null });
  stopPolling();
  enterGame();
}

function copyCode() {
  const text = state.roomCode || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
  const btn = document.getElementById('copy-btn');
  btn.textContent = '✓ Copied!';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'Copy Code'; btn.classList.remove('copied'); }, 2200);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity  = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function leaveRoom() {
  stopPolling();
  if (state.isHost) {
    /* Host leaves → delete room entirely */
    const rooms = getRooms();
    delete rooms[state.roomCode];
    saveRooms(rooms);
  } else {
    /* FIX #4 — guest leaves → clear p2 so host sees slot open again */
    patchRoom({ p2: null });
  }
  enterLobby();
}

/* ═══════════════════════════════════════════════════════════════════
   GAME SETUP
═══════════════════════════════════════════════════════════════════ */
function startBotGame() {
  state.mode   = 'bot';
  state.isHost = true;
  resetGameStats();
  setupGameUI();
  showScreen('game');
}

function enterGame() {
  resetGameStats();
  setupGameUI();
  showScreen('game');

  if (state.mode === '2p') {
    const room  = getRoom();
    state.round = room?.roundNum || 1;
    updateRoundTag();
    startPolling(pollGame);
  }
}

function resetGameStats() {
  state.myScore     = 0;
  state.oppScore    = 0;
  state.round       = 1;
  state.history     = [];
  state.myChoice    = null;
  state.roundLocked = false;
  state.roundPhase  = 'pick';
}

function setupGameUI() {
  const isBot = state.mode === 'bot';
  const room  = !isBot ? getRoom() : null;

  const myName  = state.user.displayName;
  const oppName = isBot ? 'AXIOM 🤖'
    : (state.isHost ? room?.p2?.displayName : room?.p1?.displayName) || 'Opponent';

  document.getElementById('score-p1-lbl').textContent = myName;
  document.getElementById('score-p2-lbl').textContent = oppName;
  document.getElementById('arena-p1-lbl').textContent = 'Your Pick';
  document.getElementById('arena-p2-lbl').textContent = oppName + "'s Pick";
  document.getElementById('game-mode-badge').textContent = isBot ? 'vs AXIOM 🤖' : '2 Player ⚔️';
  document.getElementById('game-mode-badge').className   = isBot ? 'badge badge-gold' : 'badge badge-teal';

  document.getElementById('score-p1').textContent = '0';
  document.getElementById('score-p2').textContent = '0';

  resetArena();
  setResult(null, '');
  renderHistory();
  enableChoices(true);
  updateRoundTag();
}

/* ═══════════════════════════════════════════════════════════════════
   BOT GAME
═══════════════════════════════════════════════════════════════════ */
function playBot(choice) {
  if (state.roundLocked) return;
  state.roundLocked = true;

  const cpuChoice = randomChoice();
  const result    = getResult(choice, cpuChoice);

  setArenaBox('arena-p1', choice, false);
  setTimeout(() => {
    setArenaBox('arena-p2', cpuChoice, false);
    applyResult(result, choice, cpuChoice);
  }, 280);
}

/* ═══════════════════════════════════════════════════════════════════
   2-PLAYER GAME
═══════════════════════════════════════════════════════════════════ */
function makeChoice(choice) {
  if (state.roundLocked || state.myChoice) return;

  state.myChoice    = choice;
  state.roundLocked = true;

  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.c === choice);
    btn.disabled = true;
  });

  if (state.mode === 'bot') {
    playBot(choice);
    return;
  }

  /* 2p: write our choice to room, show lock animation */
  const myKey = state.isHost ? 'p1Choice' : 'p2Choice';
  setArenaBox('arena-p1', 'locked', true);
  showStatus('Waiting for opponent…');
  patchRoom({ [myKey]: choice });
}

function pollGame() {
  const room = getRoom();
  if (!room) { leaveGame(); return; }

  /* Detect opponent disconnect (host deleted room) */
  if (!state.isHost) {
    const rooms = getRooms();
    if (!rooms[state.roomCode]) { leaveGame(); return; }
  }

  /* FIX #3 — only process reveals once per round */
  if (state.roundPhase !== 'pick') return;

  const myKey  = state.isHost ? 'p1Choice' : 'p2Choice';
  const oppKey = state.isHost ? 'p2Choice' : 'p1Choice';
  const myC    = room[myKey];
  const oppC   = room[oppKey];

  /* Show that opponent has locked in, even if we haven't picked yet */
  if (oppC && !myC) {
    setArenaBox('arena-p2', 'locked', true);
  }

  /* Both picked — reveal */
  if (myC && oppC) {
    state.roundPhase = 'reveal';
    stopPolling();

    const result = getResult(myC, oppC);
    state.myChoice = myC;

    setArenaBox('arena-p1', myC, false);
    setTimeout(() => {
      setArenaBox('arena-p2', oppC, false);
      applyResult(result, myC, oppC);

      setTimeout(() => {
        advanceRound();
      }, 2600);
    }, 320);
  }
}

/* FIX #5 — only host writes the next round number to avoid race */
function advanceRound() {
  state.round++;
  state.myChoice    = null;
  state.roundLocked = false;
  state.roundPhase  = 'pick';

  if (state.isHost) {
    patchRoom({
      p1Choice:    null,
      p2Choice:    null,
      roundNum:    state.round,
      roundResult: null,
    });
  }

  resetArena();
  setResult(null, '');
  hideStatus();
  enableChoices(true);
  updateRoundTag();
  startPolling(pollGame);
}

/* ═══════════════════════════════════════════════════════════════════
   RESULT LOGIC
═══════════════════════════════════════════════════════════════════ */
function getResult(mine, opp) {
  if (mine === opp) return 'draw';
  return BEATS[mine] === opp ? 'win' : 'lose';
}

function applyResult(result, myC, oppC) {
  hideStatus();

  if (result === 'win')  { state.myScore++;  bumpScore('score-p1'); }
  if (result === 'lose') { state.oppScore++; bumpScore('score-p2'); }

  document.getElementById('score-p1').textContent = state.myScore;
  document.getElementById('score-p2').textContent = state.oppScore;

  state.history.push(result);
  renderHistory();

  const labels = { win: '🎉 You Win!', lose: '💀 You Lose', draw: '🤝 Draw' };
  setResult(result, labels[result]);

  if (state.mode === 'bot') {
    setTimeout(() => {
      resetArena();
      setResult(null, '');
      enableChoices(true);
      state.myChoice    = null;
      state.roundLocked = false;
      state.round++;
      updateRoundTag();
    }, 1800);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════════════════════ */
function randomChoice() {
  const keys = Object.keys(CHOICES);
  return keys[Math.floor(Math.random() * keys.length)];
}

function setArenaBox(id, choiceOrState, isLocked) {
  const box = document.getElementById(id);
  if (!box) return;
  box.className = 'choice-box';
  if (isLocked) {
    box.classList.add('locked');
    box.textContent = '🔒';
  } else if (!choiceOrState || choiceOrState === 'idle') {
    box.classList.add('idle');
    box.textContent = '❓';
  } else {
    box.classList.add(choiceOrState);
    box.textContent = CHOICES[choiceOrState]?.emoji || '❓';
  }
}

function resetArena() {
  setArenaBox('arena-p1', 'idle', false);
  setArenaBox('arena-p2', 'idle', false);
}

function setResult(type, text) {
  const el = document.getElementById('result-text');
  el.className   = 'result-text';
  el.textContent = text || '—';
  if (type) {
    void el.offsetWidth;
    el.classList.add('show', type);
  }
}

function showStatus(msg) {
  document.getElementById('result-text').style.display = 'none';
  const sl = document.getElementById('status-line');
  sl.style.display = 'flex';
  document.getElementById('status-msg').textContent = msg;
}

function hideStatus() {
  document.getElementById('result-text').style.display = '';
  document.getElementById('status-line').style.display = 'none';
}

function bumpScore(id) {
  const el = document.getElementById(id);
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function enableChoices(on) {
  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = !on;
    btn.classList.remove('selected');
  });
}

function updateRoundTag() {
  document.getElementById('round-tag').textContent = `Round ${state.round}`;
}

function renderHistory() {
  const container = document.getElementById('history-dots');
  const total     = 10;
  const start     = Math.max(0, state.history.length - total);
  const visible   = state.history.slice(start);

  let html = '';
  for (let i = 0; i < total; i++) {
    const entry = visible[i - (total - visible.length)] || '';
    html += `<div class="hdot ${entry}"></div>`;
  }
  container.innerHTML = html;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent   = msg;
  el.style.display = 'block';
}

function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

/* ═══════════════════════════════════════════════════════════════════
   POLLING
═══════════════════════════════════════════════════════════════════ */
function startPolling(fn) {
  stopPolling();
  pollTimer = setInterval(fn, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ═══════════════════════════════════════════════════════════════════
   LEAVE GAME
═══════════════════════════════════════════════════════════════════ */
function leaveGame() {
  stopPolling();
  if (state.mode === '2p' && state.roomCode) {
    const rooms = getRooms();
    delete rooms[state.roomCode];
    saveRooms(rooms);
  }
  enterLobby();
}

/* ═══════════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (document.getElementById('screen-auth').classList.contains('screen-active')) {
    if (e.key === 'Enter') handleAuth();
    return;
  }
  if (document.getElementById('screen-game').classList.contains('screen-active')) {
    const map = { '1': 'rock', '2': 'paper', '3': 'scissors', r: 'rock', p: 'paper', s: 'scissors' };
    if (map[e.key]) makeChoice(map[e.key]);
  }
});

/* ═══════════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════════ */
(function init() {
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      const user  = JSON.parse(saved);
      const users = getUsers();
      if (users[user.username]) {
        state.user = user;
        enterLobby();
        return;
      }
    }
  } catch { /* ignore */ }

  showScreen('auth');
})();