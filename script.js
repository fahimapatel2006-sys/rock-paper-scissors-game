'use strict';

/* ═══════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════ */
const CHOICES = {
  rock:     { emoji: '🪨', label: 'Rock'     },
  paper:    { emoji: '📄', label: 'Paper'    },
  scissors: { emoji: '✂️',  label: 'Scissors' },
};
const BEATS     = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const KEYS      = ['rock', 'paper', 'scissors'];
const USERS_KEY = 'rps_users_v3';
const ROOMS_KEY = 'rps_rooms_v3';
const SESS_KEY  = 'rps_session_v3';
const POLL_MS   = 600;

/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
const S = {
  user:     null,   // { username, displayName }
  mode:     null,   // 'bot' | '2p'
  roomCode: null,
  isHost:   false,

  myScore:  0,
  oppScore: 0,
  round:    1,
  history:  [],

  myChoice:   null,
  locked:     false,
  processing: false,

  pollTimer: null,
};

/* ═══════════════════════════════════════════════════
   STORAGE — users & rooms live in localStorage
   so multiplayer works across tabs on same browser,
   and bot mode works offline with zero setup.
═══════════════════════════════════════════════════ */
function getUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}'); } catch { return {}; }
}
function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

function getRooms() {
  try { return JSON.parse(localStorage.getItem(ROOMS_KEY) || '{}'); } catch { return {}; }
}
function saveRooms(r) { localStorage.setItem(ROOMS_KEY, JSON.stringify(r)); }

function getRoom(code) {
  return getRooms()[code] || null;
}
function patchRoom(code, patch) {
  const rooms = getRooms();
  if (!rooms[code]) return;
  Object.assign(rooms[code], patch);
  saveRooms(rooms);
}
function deleteRoom(code) {
  const rooms = getRooms();
  delete rooms[code];
  saveRooms(rooms);
}

// Purge rooms older than 30 min
function pruneRooms() {
  const rooms = getRooms();
  const now   = Date.now();
  let changed = false;
  for (const k of Object.keys(rooms)) {
    if (now - (rooms[k].createdAt || 0) > 30 * 60 * 1000) { delete rooms[k]; changed = true; }
  }
  if (changed) saveRooms(rooms);
}

/* ═══════════════════════════════════════════════════
   SCREEN SWITCHING
═══════════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

/* ═══════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════ */
let authMode = 'login';

function switchTab(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active',  mode === 'login');
  document.getElementById('tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-submit').textContent = mode === 'login' ? 'Log In →' : 'Create Account →';
  hideError('auth-error');
}

function handleAuth() {
  const rawName  = document.getElementById('auth-user').value.trim();
  const username = rawName.toLowerCase();
  const password = document.getElementById('auth-pass').value;
  const users    = getUsers();

  if (!username || !password) { showError('auth-error', 'Please fill in both fields.'); return; }
  if (username.length < 2)    { showError('auth-error', 'Username needs at least 2 characters.'); return; }

  if (authMode === 'signup') {
    if (users[username])      { showError('auth-error', 'Username already taken!'); return; }
    if (password.length < 4)  { showError('auth-error', 'Password needs at least 4 characters.'); return; }
    users[username] = { password, displayName: rawName };
    saveUsers(users);
    loginUser({ username, displayName: rawName });
  } else {
    if (!users[username] || users[username].password !== password) {
      showError('auth-error', 'Wrong username or password.'); return;
    }
    loginUser({ username, displayName: users[username].displayName });
  }
}

function loginUser(user) {
  S.user = user;
  sessionStorage.setItem(SESS_KEY, JSON.stringify(user));
  enterLobby();
}

function signOut() {
  stopPoll();
  sessionStorage.removeItem(SESS_KEY);
  S.user = null;
  showScreen('auth');
}

/* ═══════════════════════════════════════════════════
   LOBBY
═══════════════════════════════════════════════════ */
function enterLobby() {
  stopPoll();
  S.mode = null; S.roomCode = null; S.isHost = false;
  document.getElementById('lobby-name').textContent   = S.user.displayName;
  document.getElementById('lobby-avatar').textContent = S.user.displayName[0].toUpperCase();
  document.getElementById('join-code').value          = '';
  hideError('join-error');
  showScreen('lobby');
}

/* ═══════════════════════════════════════════════════
   ROOM CREATE / JOIN
═══════════════════════════════════════════════════ */
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createRoom() {
  pruneRooms();
  const code  = genCode();
  const rooms = getRooms();
  rooms[code] = {
    code,
    createdAt: Date.now(),
    p1: S.user, p2: null,
    started: false,
    p1Choice: null, p2Choice: null,
    roundNum: 1,
  };
  saveRooms(rooms);
  S.roomCode = code; S.isHost = true; S.mode = '2p';
  enterWaiting();
}

function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code || code.length !== 4) { showError('join-error', 'Enter a 4-letter code.'); return; }

  const room = getRoom(code);
  if (!room)                                               { showError('join-error', 'Room not found — check the code!'); return; }
  if (room.p1.username === S.user.username)                { showError('join-error', "That's your own room!"); return; }
  if (room.p2 && room.p2.username !== S.user.username)     { showError('join-error', 'Room is already full!'); return; }
  if (room.started)                                        { showError('join-error', 'Game already in progress!'); return; }

  patchRoom(code, { p2: S.user });
  S.roomCode = code; S.isHost = false; S.mode = '2p';
  enterWaiting();
}

/* ═══════════════════════════════════════════════════
   WAITING ROOM
═══════════════════════════════════════════════════ */
function enterWaiting() {
  stopPoll();
  document.getElementById('waiting-code').textContent   = S.roomCode;
  document.getElementById('waiting-kicker').textContent = S.isHost ? 'Share this code' : 'Waiting for host';
  document.getElementById('btn-start').style.display    = 'none';
  renderWaitingPlayers();
  showScreen('waiting');
  startPoll(pollWaiting);
}

function renderWaitingPlayers() {
  const room = getRoom(S.roomCode);
  if (!room) return;

  // P1
  document.getElementById('prow-1-av').textContent   = room.p1.displayName[0].toUpperCase();
  document.getElementById('prow-1-name').textContent  = room.p1.displayName;

  // P2
  const hasP2 = !!room.p2;
  const row2  = document.getElementById('prow-2');

  if (hasP2) {
    row2.classList.add('joined');
    document.getElementById('prow-2-av').className    = 'prow-avatar p2';
    document.getElementById('prow-2-av').textContent  = room.p2.displayName[0].toUpperCase();
    document.getElementById('prow-2-name').textContent = room.p2.displayName;
    document.getElementById('prow-2-name').style.color = '';
    document.getElementById('prow-2-tag').innerHTML   = '<span class="prow-tag ready">Ready ✓</span>';

    if (S.isHost) {
      document.getElementById('waiting-hint').textContent = room.p2.displayName + ' joined! Start when ready.';
      document.getElementById('btn-start').style.display  = 'inline-flex';
    } else {
      document.getElementById('waiting-hint').textContent = 'Waiting for host to start…';
    }
  } else {
    row2.classList.remove('joined');
    document.getElementById('prow-2-av').className    = 'prow-avatar empty';
    document.getElementById('prow-2-av').textContent  = '?';
    document.getElementById('prow-2-name').textContent = 'Waiting for player…';
    document.getElementById('prow-2-name').style.color = 'var(--muted)';
    document.getElementById('prow-2-tag').innerHTML   = '<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
    document.getElementById('btn-start').style.display = 'none';
    document.getElementById('waiting-hint').textContent = 'Waiting for your friend to join…';
  }
}

function pollWaiting() {
  renderWaitingPlayers();
  const room = getRoom(S.roomCode);
  if (!room) { enterLobby(); return; }
  if (!S.isHost && room.started) {
    stopPoll();
    enterGame(room);
  }
}

function hostStartGame() {
  patchRoom(S.roomCode, { started: true, roundNum: 1, p1Choice: null, p2Choice: null });
  stopPoll();
  enterGame(getRoom(S.roomCode));
}

function copyCode() {
  navigator.clipboard.writeText(S.roomCode).catch(() => {});
  const btn = document.getElementById('copy-btn');
  btn.textContent = '✓ Copied!';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'Copy Code'; btn.classList.remove('copied'); }, 2200);
}

function leaveRoom() {
  stopPoll();
  if (S.isHost) { deleteRoom(S.roomCode); }
  else          { patchRoom(S.roomCode, { p2: null }); }
  enterLobby();
}

/* ═══════════════════════════════════════════════════
   GAME — SETUP
═══════════════════════════════════════════════════ */
function startBotGame() {
  S.mode = 'bot'; S.isHost = true;
  resetStats();
  setupGameUI(null);
  showScreen('game');
}

function enterGame(room) {
  resetStats();
  S.round = room?.roundNum || 1;
  setupGameUI(room);
  showScreen('game');
  if (S.mode === '2p') {
    S.processing = false;
    startPoll(pollGame);
  }
}

function resetStats() {
  S.myScore = 0; S.oppScore = 0; S.round = 1;
  S.history = []; S.myChoice = null; S.locked = false; S.processing = false;
}

function setupGameUI(room) {
  const isBot   = S.mode === 'bot';
  const oppName = isBot ? 'AXIOM 🤖'
    : (S.isHost ? room?.p2?.displayName : room?.p1?.displayName) || 'Opponent';

  document.getElementById('score-p1-lbl').textContent = S.user.displayName;
  document.getElementById('score-p2-lbl').textContent = oppName;
  document.getElementById('arena-p2-lbl').textContent = oppName + "'s Pick";
  document.getElementById('mode-badge').textContent   = isBot ? 'vs AXIOM 🤖' : '2 Player ⚔️';
  document.getElementById('mode-badge').className     = 'badge ' + (isBot ? 'badge-gold' : 'badge-teal');
  document.getElementById('score-p1').textContent     = '0';
  document.getElementById('score-p2').textContent     = '0';

  resetArena();
  clearResult();
  enableChoices(true);
  updateRoundTag();
  renderHistory();
}

/* ═══════════════════════════════════════════════════
   GAME — PICKING
═══════════════════════════════════════════════════ */
function makeChoice(choice) {
  if (S.locked) return;
  S.locked   = true;
  S.myChoice = choice;

  // Highlight selected button
  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.c === choice);
    btn.disabled = true;
  });

  if (S.mode === 'bot') {
    playBot(choice);
  } else {
    play2P(choice);
  }
}

/* ═══════════════════════════════════════════════════
   BOT MODE
═══════════════════════════════════════════════════ */
function playBot(myChoice) {
  setBox('arena-p1', myChoice, false);
  showStatus('AXIOM is thinking…');

  const thinkMs = 500 + Math.random() * 600;
  setTimeout(() => {
    const cpu = KEYS[Math.floor(Math.random() * 3)];
    setBox('arena-p2', cpu, false);
    hideStatus();
    resolveResult(getResult(myChoice, cpu), myChoice, cpu);

    // Auto-reset for next round
    setTimeout(() => {
      S.round++;
      S.myChoice = null;
      S.locked   = false;
      resetArena();
      clearResult();
      enableChoices(true);
      updateRoundTag();
    }, 2000);
  }, thinkMs);
}

/* ═══════════════════════════════════════════════════
   2-PLAYER MODE
═══════════════════════════════════════════════════ */
function play2P(myChoice) {
  setBox('arena-p1', null, true); // show lock
  showStatus('Waiting for opponent…');
  const myKey = S.isHost ? 'p1Choice' : 'p2Choice';
  patchRoom(S.roomCode, { [myKey]: myChoice });
}

function pollGame() {
  if (S.processing) return;

  const room = getRoom(S.roomCode);
  if (!room) { leaveGame(); return; }

  const myC  = S.isHost ? room.p1Choice : room.p2Choice;
  const oppC = S.isHost ? room.p2Choice : room.p1Choice;

  // Show opponent locked in (but don't reveal their pick yet)
  if (oppC && !myC) {
    setBox('arena-p2', null, true);
  }

  // Both players have picked — resolve!
  if (myC && oppC && !S.processing) {
    S.processing = true;
    stopPoll();

    // Reveal my pick properly (in case we only showed lock)
    setBox('arena-p1', myC, false);

    setTimeout(() => {
      setBox('arena-p2', oppC, false);
      hideStatus();
      resolveResult(getResult(myC, oppC), myC, oppC);

      setTimeout(() => {
        // Advance to next round
        const newRound = (room.roundNum || S.round) + 1;
        patchRoom(S.roomCode, { p1Choice: null, p2Choice: null, roundNum: newRound });
        S.round      = newRound;
        S.myChoice   = null;
        S.locked     = false;
        S.processing = false;

        resetArena();
        clearResult();
        enableChoices(true);
        updateRoundTag();

        startPoll(pollGame);
      }, 2300);
    }, 350);
  }
}

/* ═══════════════════════════════════════════════════
   RESULT LOGIC
═══════════════════════════════════════════════════ */
function getResult(mine, opp) {
  if (mine === opp)        return 'draw';
  return BEATS[mine] === opp ? 'win' : 'lose';
}

function resolveResult(result, myC, oppC) {
  if (result === 'win')  { S.myScore++;  bumpScore('score-p1'); }
  if (result === 'lose') { S.oppScore++; bumpScore('score-p2'); }

  document.getElementById('score-p1').textContent = S.myScore;
  document.getElementById('score-p2').textContent = S.oppScore;

  S.history.push(result);
  renderHistory();

  const labels = { win: '🎉 You Win!', lose: '💀 You Lose', draw: '🤝 Draw!' };
  const subs   = {
    win:  CHOICES[myC].label + ' beats ' + CHOICES[oppC].label,
    lose: CHOICES[oppC].label + ' beats ' + CHOICES[myC].label,
    draw: 'Both picked ' + CHOICES[myC].label,
  };
  showResult(result, labels[result], subs[result]);
}

/* ═══════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════ */
function setBox(id, choice, locked) {
  const box = document.getElementById(id);
  if (!box) return;
  box.className = 'choice-box';

  if (locked) {
    box.classList.add('locked');
    box.textContent = '🔒';
  } else if (!choice) {
    box.classList.add('idle');
    box.textContent = '❓';
  } else {
    box.classList.add(choice);
    box.textContent = CHOICES[choice].emoji;
  }
}

function resetArena() {
  setBox('arena-p1', null, false);
  setBox('arena-p2', null, false);
}

function showResult(type, text, sub) {
  const main = document.getElementById('result-main');
  const subEl = document.getElementById('result-sub');
  const idle  = document.getElementById('idle-prompt');

  idle.style.display  = 'none';
  main.className      = 'result-main show ' + type;
  main.textContent    = text;
  subEl.className     = 'result-sub show';
  subEl.textContent   = sub;
}

function clearResult() {
  document.getElementById('result-main').className  = 'result-main';
  document.getElementById('result-sub').className   = 'result-sub';
  document.getElementById('idle-prompt').style.display = '';
}

function showStatus(msg) {
  document.getElementById('status-line').classList.add('show');
  document.getElementById('status-msg').textContent = msg;
  document.getElementById('idle-prompt').style.display = 'none';
}

function hideStatus() {
  document.getElementById('status-line').classList.remove('show');
  document.getElementById('idle-prompt').style.display = '';
}

function bumpScore(id) {
  const el = document.getElementById(id);
  el.classList.remove('bump');
  void el.offsetWidth; // force reflow
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 500);
}

function enableChoices(on) {
  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = !on;
    btn.classList.remove('selected');
  });
}

function updateRoundTag() {
  document.getElementById('round-tag').textContent = 'Round ' + S.round;
}

function renderHistory() {
  const container = document.getElementById('history-dots');
  const last10    = S.history.slice(-10);
  let html = '';
  for (let i = 0; i < 10; i++) {
    const idx   = i - (10 - last10.length);
    const entry = idx >= 0 ? last10[idx] : '';
    html += `<div class="hdot ${entry}"></div>`;
  }
  container.innerHTML = html;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent    = msg;
  el.style.display  = 'block';
}

function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

/* ═══════════════════════════════════════════════════
   POLLING
═══════════════════════════════════════════════════ */
function startPoll(fn) {
  stopPoll();
  S.pollTimer = setInterval(fn, POLL_MS);
}
function stopPoll() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

/* ═══════════════════════════════════════════════════
   LEAVE GAME
═══════════════════════════════════════════════════ */
function leaveGame() {
  stopPoll();
  if (S.mode === '2p' && S.roomCode) deleteRoom(S.roomCode);
  enterLobby();
}

/* ═══════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  const gameActive = document.getElementById('screen-game').classList.contains('active');
  const authActive = document.getElementById('screen-auth').classList.contains('active');

  if (authActive && e.key === 'Enter') { handleAuth(); return; }

  if (gameActive) {
    const map = { '1':'rock','2':'paper','3':'scissors','r':'rock','p':'paper','s':'scissors' };
    if (map[e.key]) makeChoice(map[e.key]);
  }
});

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
(function init() {
  try {
    const saved = sessionStorage.getItem(SESS_KEY);
    if (saved) {
      const user  = JSON.parse(saved);
      const users = getUsers();
      if (users[user.username]) {
        S.user = user;
        enterLobby();
        return;
      }
    }
  } catch { /* ignore */ }
  showScreen('auth');
})();