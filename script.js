/* ═══════════════════════════════════════════════════════════════════
   ROCK PAPER SCISSORS  ·  script.js
   ─────────────────────────────────────────────────────────────────
   Architecture:
     • Auth  — localStorage user store (username → {password, display})
     • Rooms — localStorage room store, polled every 500ms
     • Screens: auth → lobby → waiting → game
     • Two modes: bot (single player) | 2p (room-based multiplayer)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ─── Constants ─────────────────────────────────────────────────── */
const CHOICES = {
  rock:     { emoji: '🪨', label: 'Rock'     },
  paper:    { emoji: '📄', label: 'Paper'    },
  scissors: { emoji: '✂️',  label: 'Scissors' },
};
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const USERS_KEY   = 'rps_users_v2';
const ROOMS_KEY   = 'rps_rooms_v2';
const SESSION_KEY = 'rps_session_v2';
const POLL_MS     = 500;

/* ─── State ──────────────────────────────────────────────────────── */
const state = {
  user:        null,   // { username, displayName }
  mode:        null,   // 'bot' | '2p'
  roomCode:    null,
  isHost:      false,

  // game stats (reset per match)
  myScore:     0,
  oppScore:    0,
  round:       0,
  history:     [],     // array of 'win'|'lose'|'draw'
  myChoice:    null,
  roundLocked: false,  // true while waiting for result
  roundPhase:  'pick', // 'pick' | 'reveal' | 'next'
};

let pollTimer = null;

/* ═══════════════════════════════════════════════════════════════════
   STORAGE HELPERS
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
  const rooms = getRooms();
  return rooms[state.roomCode] || null;
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
}

/* ═══════════════════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════════════════ */
let authMode = 'login';

function switchTab(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active',  mode === 'login');
  document.getElementById('tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-submit').textContent = mode === 'login' ? 'Log In →' : 'Create Account →';
  hideError('auth-error');
}

function handleAuth() {
  const username = document.getElementById('auth-user').value.trim().toLowerCase();
  const password = document.getElementById('auth-pass').value;
  const users    = getUsers();

  if (!username || !password) { showError('auth-error', 'Please fill in both fields.'); return; }
  if (username.length < 2)    { showError('auth-error', 'Username must be at least 2 characters.'); return; }

  if (authMode === 'signup') {
    if (users[username]) { showError('auth-error', 'Username already taken — try another!'); return; }
    if (password.length < 4) { showError('auth-error', 'Password must be at least 4 characters.'); return; }
    const displayName = document.getElementById('auth-user').value.trim();
    users[username] = { password, displayName };
    saveUsers(users);
    loginUser({ username, displayName });
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
  showScreen('auth');
}

/* ═══════════════════════════════════════════════════════════════════
   LOBBY
═══════════════════════════════════════════════════════════════════ */
function enterLobby() {
  stopPolling();
  state.mode = null;
  state.roomCode = null;
  state.isHost = false;

  // update UI
  const name = state.user.displayName;
  document.getElementById('lobby-name').textContent   = name;
  document.getElementById('lobby-avatar').textContent  = name[0].toUpperCase();
  document.getElementById('join-code').value           = '';
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
  const code  = genCode();
  const rooms = getRooms();

  // clean up stale rooms (older than 30 min)
  const now = Date.now();
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
    roundNum:    0,
    roundResult: null, // set after both pick: { p1Result, p2Result, p1Choice, p2Choice }
  };
  saveRooms(rooms);

  state.roomCode = code;
  state.isHost   = true;
  state.mode     = '2p';
  enterWaiting();
}

function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) { showError('join-error', 'Enter a room code.'); return; }

  const rooms = getRooms();
  if (!rooms[code]) { showError('join-error', 'Room not found — double-check the code!'); return; }
  const room = rooms[code];
  if (room.p2 && room.p2.username !== state.user.username) {
    showError('join-error', 'This room is already full!'); return;
  }
  if (room.p1.username === state.user.username) {
    showError('join-error', "That's your own room — share the code with a friend!"); return;
  }

  // join as p2
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

  // show code
  document.getElementById('waiting-code').textContent = state.roomCode;

  // host vs guest labels
  document.getElementById('waiting-kicker').textContent =
    state.isHost ? 'Share this code' : 'Waiting for host';

  renderWaitingPlayers();
  showScreen('waiting');
  startPolling(pollWaiting);
}

function renderWaitingPlayers() {
  const room = getRoom();
  if (!room) return;

  // p1
  document.getElementById('prow-1-avatar').textContent = room.p1.displayName[0].toUpperCase();
  document.getElementById('prow-1-name').textContent   = room.p1.displayName;

  // p2
  const hasP2 = !!room.p2;
  const p2Row  = document.getElementById('prow-2');

  if (hasP2) {
    p2Row.classList.add('joined');
    document.getElementById('prow-2-avatar').className = 'prow-avatar p2';
    document.getElementById('prow-2-avatar').textContent = room.p2.displayName[0].toUpperCase();
    document.getElementById('prow-2-name').style.color = '';
    document.getElementById('prow-2-name').textContent  = room.p2.displayName;
    document.getElementById('prow-2-tag').innerHTML     = '<span class="prow-tag ready">Ready ✓</span>';

    if (state.isHost) {
      document.getElementById('waiting-hint').textContent = room.p2.displayName + ' has joined! Start when ready.';
      document.getElementById('btn-start').style.display  = 'inline-flex';
    } else {
      document.getElementById('waiting-hint').textContent = 'Waiting for host to start the game…';
    }
  } else {
    p2Row.classList.remove('joined');
    document.getElementById('prow-2-avatar').className = 'prow-avatar empty';
    document.getElementById('prow-2-avatar').textContent = '?';
    document.getElementById('prow-2-name').style.color  = 'var(--muted)';
    document.getElementById('prow-2-name').textContent   = 'Waiting for player…';
    document.getElementById('prow-2-tag').innerHTML      = '<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
    document.getElementById('btn-start').style.display   = 'none';
    document.getElementById('waiting-hint').textContent  = 'Waiting for your friend to join…';
  }
}

function pollWaiting() {
  renderWaitingPlayers();
  const room = getRoom();
  if (!room) { enterLobby(); return; }
  // non-host checks for started flag
  if (!state.isHost && room.started) {
    stopPolling();
    enterGame();
  }
}

function hostStartGame() {
  patchRoom({ started: true, roundNum: 1 });
  stopPolling();
  enterGame();
}

function copyCode() {
  navigator.clipboard.writeText(state.roomCode).catch(() => {});
  const btn = document.getElementById('copy-btn');
  btn.textContent = '✓ Copied!';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'Copy Code'; btn.classList.remove('copied'); }, 2200);
}

function leaveRoom() {
  stopPolling();
  // if host, delete room
  if (state.isHost) {
    const rooms = getRooms();
    delete rooms[state.roomCode];
    saveRooms(rooms);
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
    // sync round number
    const room = getRoom();
    state.round = room?.roundNum || 1;
    updateRoundTag();
    startPolling(pollGame);
  }
}

function resetGameStats() {
  state.myScore    = 0;
  state.oppScore   = 0;
  state.round      = 1;
  state.history    = [];
  state.myChoice   = null;
  state.roundLocked = false;
  state.roundPhase  = 'pick';
}

function setupGameUI() {
  const isBot = state.mode === 'bot';
  const room  = !isBot ? getRoom() : null;

  // labels
  const myName  = state.user.displayName;
  const oppName = isBot ? 'AXIOM 🤖'
    : (state.isHost ? room?.p2?.displayName : room?.p1?.displayName) || 'Opponent';

  document.getElementById('score-p1-lbl').textContent = myName;
  document.getElementById('score-p2-lbl').textContent = oppName;
  document.getElementById('arena-p1-lbl').textContent = 'Your Pick';
  document.getElementById('arena-p2-lbl').textContent = oppName + "'s Pick";
  document.getElementById('game-mode-badge').textContent = isBot ? 'vs AXIOM 🤖' : '2 Player ⚔️';
  document.getElementById('game-mode-badge').className   = isBot ? 'badge badge-gold' : 'badge badge-teal';

  // scores
  document.getElementById('score-p1').textContent = '0';
  document.getElementById('score-p2').textContent = '0';

  // arena reset
  resetArena();

  // result
  setResult(null, '');

  // history
  renderHistory();

  // choices enabled
  enableChoices(true);

  updateRoundTag();
}

/* ═══════════════════════════════════════════════════════════════════
   BOT GAME LOGIC
═══════════════════════════════════════════════════════════════════ */
function playBot(choice) {
  if (state.roundLocked) return;
  state.roundLocked = true;

  const cpuChoice = randomChoice();
  const result    = getResult(choice, cpuChoice);

  // show player instantly, cpu after tiny delay
  setArenaBox('arena-p1', choice, false);
  setTimeout(() => {
    setArenaBox('arena-p2', cpuChoice, false);
    applyResult(result, choice, cpuChoice);
  }, 280);
}

/* ═══════════════════════════════════════════════════════════════════
   2-PLAYER GAME LOGIC
═══════════════════════════════════════════════════════════════════ */
function makeChoice(choice) {
  if (state.roundLocked || state.myChoice) return;

  state.myChoice   = choice;
  state.roundLocked = true;

  // mark selected card
  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.c === choice);
    btn.disabled = true;
  });

  if (state.mode === 'bot') {
    playBot(choice);
    return;
  }

  // 2p: write choice to room
  const myKey = state.isHost ? 'p1Choice' : 'p2Choice';
  setArenaBox('arena-p1', 'locked', true);  // show lock
  showStatus('Waiting for opponent…');

  patchRoom({ [myKey]: choice });
}

function pollGame() {
  const room = getRoom();
  if (!room) { leaveGame(); return; }

  // if room deleted / opponent left
  if (state.isHost && !room.p2)  { leaveGame(); return; }

  const myKey  = state.isHost ? 'p1Choice' : 'p2Choice';
  const oppKey = state.isHost ? 'p2Choice' : 'p1Choice';

  const myC   = room[myKey];
  const oppC  = room[oppKey];

  // opponent has locked in
  if (myC && oppC && state.roundPhase === 'pick') {
    state.roundPhase = 'reveal';
    stopPolling();

    const result = getResult(myC, oppC);
    state.myChoice = myC;

    // reveal both
    setArenaBox('arena-p1', myC, false);
    setTimeout(() => {
      setArenaBox('arena-p2', oppC, false);
      applyResult(result, myC, oppC);

      // after 2.6s, reset round
      setTimeout(() => {
        nextRound(room);
      }, 2600);
    }, 320);
  } else if (oppC && !myC) {
    // opponent picked, we haven't yet — show they locked
    setArenaBox('arena-p2', 'locked', true);
  }
}

function nextRound(room) {
  // clear room choices for next round
  const newRound = (room.roundNum || state.round) + 1;
  patchRoom({ p1Choice: null, p2Choice: null, roundNum: newRound, roundResult: null });

  state.round      = newRound;
  state.myChoice   = null;
  state.roundLocked = false;
  state.roundPhase  = 'pick';

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
    // auto-reset after delay
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

function setArenaBox(id, state, isLocked) {
  const box = document.getElementById(id);
  if (!box) return;
  box.className = 'choice-box';
  if (isLocked) {
    box.classList.add('locked');
    box.textContent = '🔒';
  } else if (state === 'idle' || !state) {
    box.classList.add('idle');
    box.textContent = '❓';
  } else {
    box.classList.add(state);
    box.textContent = CHOICES[state]?.emoji || '❓';
  }
}

function resetArena() {
  setArenaBox('arena-p1', 'idle');
  setArenaBox('arena-p2', 'idle');
}

function setResult(type, text) {
  const el = document.getElementById('result-text');
  el.className = 'result-text';
  el.textContent = text || '—';
  if (type) {
    // force reflow for re-animation
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
  const dots = Array.from({ length: 10 }, (_, i) => {
    const entry = state.history[state.history.length - 10 + i];
    return `<div class="hdot ${entry || ''}"></div>`;
  });
  container.innerHTML = dots.join('');
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
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
  // Enter on auth fields
  if (document.getElementById('screen-auth').classList.contains('screen-active')) {
    if (e.key === 'Enter') handleAuth();
  }
  // In game: 1=rock 2=paper 3=scissors
  if (document.getElementById('screen-game').classList.contains('screen-active')) {
    const map = { '1': 'rock', '2': 'paper', '3': 'scissors', 'r': 'rock', 'p': 'paper', 's': 'scissors' };
    if (map[e.key]) makeChoice(map[e.key]);
  }
});

/* ═══════════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════════ */
(function init() {
  // restore session
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      const user = JSON.parse(saved);
      // verify user still exists
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