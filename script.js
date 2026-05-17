const CHOICES = {
  rock:     { emoji: '🪨', beats: 'scissors' },
  paper:    { emoji: '📄', beats: 'rock' },
  scissors: { emoji: '✂️', beats: 'paper' },
};

let scores = { player: 0, cpu: 0 };
let history = [];
let busy = false;

const playerDisplay = document.getElementById('playerDisplay');
const cpuDisplay    = document.getElementById('cpuDisplay');
const resultText    = document.getElementById('resultText');
const scorePlayer   = document.getElementById('scorePlayer');
const scoreCpu      = document.getElementById('scoreCpu');
const historyDots   = document.getElementById('historyDots');
const confetti      = document.getElementById('confetti');
const btnReset      = document.getElementById('btnReset');

function setDisplay(el, choice) {
  el.className = 'choice-display reveal ' + choice;
  el.textContent = CHOICES[choice].emoji;
}

function resetDisplays() {
  playerDisplay.className = 'choice-display idle';
  playerDisplay.textContent = '❓';
  cpuDisplay.className = 'choice-display idle';
  cpuDisplay.textContent = '❓';
}

function showResult(outcome) {
  const messages = {
    win:  '🎉 You Win!',
    lose: '💀 You Lose',
    draw: '🤝 Draw',
  };
  resultText.textContent = messages[outcome];
  resultText.className = `result-text visible ${outcome}`;
}

function hideResult() {
  resultText.className = 'result-text';
}

function updateScores() {
  scorePlayer.textContent = scores.player;
  scoreCpu.textContent    = scores.cpu;
}

function updateHistory() {
  const dots = historyDots.querySelectorAll('.hdot');
  const last10 = history.slice(-10);
  dots.forEach((dot, i) => {
    dot.className = 'hdot' + (last10[i] ? ' ' + last10[i] : '');
  });
}

function triggerConfetti() {
  confetti.classList.add('active');
  setTimeout(() => confetti.classList.remove('active'), 1000);
}

function play(playerChoice) {
  if (busy) return;
  busy = true;
  hideResult();
  resetDisplays();

  // Brief delay so reset animation is visible
  setTimeout(() => {
    const cpuChoice = Object.keys(CHOICES)[Math.floor(Math.random() * 3)];

    setDisplay(playerDisplay, playerChoice);
    setDisplay(cpuDisplay, cpuChoice);

    let outcome;
    if (playerChoice === cpuChoice) {
      outcome = 'draw';
    } else if (CHOICES[playerChoice].beats === cpuChoice) {
      outcome = 'win';
      scores.player++;
    } else {
      outcome = 'lose';
      scores.cpu++;
    }

    history.push(outcome);
    updateScores();
    updateHistory();
    showResult(outcome);

    if (outcome === 'win') triggerConfetti();

    busy = false;
  }, 150);
}

// Attach click handlers to choice cards
document.querySelectorAll('.choice-card').forEach(card => {
  card.addEventListener('click', () => play(card.dataset.choice));
});

// Reset button
btnReset.addEventListener('click', () => {
  scores = { player: 0, cpu: 0 };
  history = [];
  updateScores();
  updateHistory();
  hideResult();
  resetDisplays();

console.log("JS connected !");

});