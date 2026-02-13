// === Posterdle Game Engine ===
(function() {
  'use strict';

  // --- Constants ---
  const MAX_GUESSES = 6;
  const TMDB_IMG = 'https://image.tmdb.org/t/p/';
  const POSTER_SIZE = 'w500';
  const EPOCH = new Date('2025-01-01T00:00:00Z');
  const STORAGE_KEY = 'posterdle_state';
  const STATS_KEY = 'posterdle_stats';

  // Pixelation levels per guess stage (lower = more pixelated)
  // Stage 0 (start): very pixelated, Stage 5 (guess 6): nearly clear
  const PIXEL_STAGES = [8, 14, 24, 40, 64, 100];

  // Clues revealed at each stage (after wrong guess / skip)
  // Index = number of guesses made so far
  const CLUE_STAGES = [
    null,           // Stage 0: no clue, just pixelated poster
    'year',         // After 1st wrong: reveal year
    'genre',        // After 2nd wrong: reveal genre
    'director',     // After 3rd wrong: reveal director
    'actor',        // After 4th wrong: reveal lead actor
    'tagline',      // After 5th wrong: reveal tagline
  ];

  // --- State ---
  let todayMovie = null;
  let puzzleNumber = 0;
  let guesses = [];
  let gameOver = false;
  let won = false;
  let selectedMovie = null;
  let acIndex = -1;
  let posterImage = null;
  let posterLoaded = false;

  // --- DOM refs ---
  const canvas = document.getElementById('poster-canvas');
  const ctx = canvas.getContext('2d');
  const loadingEl = document.getElementById('poster-loading');
  const cluesEl = document.getElementById('clue-pills');
  const guessListEl = document.getElementById('guess-list');
  const inputEl = document.getElementById('guess-input');
  const dropdownEl = document.getElementById('autocomplete-dropdown');
  const submitBtn = document.getElementById('btn-submit');
  const skipBtn = document.getElementById('btn-skip');
  const gameOverEl = document.getElementById('game-over');
  const puzzleNumEl = document.getElementById('puzzle-number');

  // --- Initialization ---
  function init() {
    puzzleNumber = getPuzzleNumber();
    todayMovie = getMovieForPuzzle(puzzleNumber);
    puzzleNumEl.textContent = `Posterdle #${puzzleNumber}`;

    loadState();
    setupEventListeners();
    loadPoster();
    renderClues();
    renderGuesses();

    if (gameOver) {
      disableInput();
      // Show game over after a short delay so player can see the board
      setTimeout(() => showGameOver(), 500);
    }

    // Show help on first visit
    if (!localStorage.getItem('posterdle_visited')) {
      localStorage.setItem('posterdle_visited', 'true');
      showModal('help-modal');
    }
  }

  // --- Puzzle Selection ---
  function getPuzzleNumber() {
    const now = new Date();
    const diff = now.getTime() - EPOCH.getTime();
    return Math.floor(diff / (24 * 60 * 60 * 1000));
  }

  function getMovieForPuzzle(num) {
    // Use a seeded shuffle based on puzzle number
    const seed = hashCode('posterdle' + num);
    const index = Math.abs(seed) % MOVIES.length;
    return MOVIES[index];
  }

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash | 0;
    }
    return hash;
  }

  // --- Poster Loading & Rendering ---
  function loadPoster() {
    loadingEl.classList.add('visible');
    posterImage = new Image();
    posterImage.crossOrigin = 'anonymous';

    posterImage.onload = function() {
      posterLoaded = true;
      loadingEl.classList.remove('visible');
      renderPoster();
    };

    posterImage.onerror = function() {
      // Retry without crossOrigin (uses CSS blur fallback)
      if (posterImage.crossOrigin) {
        posterImage.crossOrigin = null;
        posterImage.src = '';
        posterImage.src = TMDB_IMG + POSTER_SIZE + todayMovie.p;
        return;
      }
      loadingEl.textContent = 'Could not load poster';
      loadingEl.classList.add('visible');
    };

    posterImage.src = TMDB_IMG + POSTER_SIZE + todayMovie.p;
  }

  function renderPoster() {
    if (!posterLoaded) return;

    const stage = Math.min(guesses.length, PIXEL_STAGES.length - 1);
    const pixelLevel = PIXEL_STAGES[stage];
    const showFull = won;

    const container = canvas.parentElement;
    const displayWidth = container.clientWidth;
    const displayHeight = container.clientHeight;

    canvas.width = displayWidth;
    canvas.height = displayHeight;

    try {
      if (showFull) {
        canvas.style.filter = 'none';
        drawFitted(ctx, posterImage, displayWidth, displayHeight);
        return;
      }

      // Pixelation: draw small then scale up
      const pixW = pixelLevel;
      const pixH = Math.round(pixelLevel * 1.5);

      const offscreen = document.createElement('canvas');
      offscreen.width = pixW;
      offscreen.height = pixH;
      const offCtx = offscreen.getContext('2d');

      offCtx.imageSmoothingEnabled = true;
      drawFitted(offCtx, posterImage, pixW, pixH);

      // Test for tainted canvas
      offCtx.getImageData(0, 0, 1, 1);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreen, 0, 0, pixW, pixH, 0, 0, displayWidth, displayHeight);
      ctx.imageSmoothingEnabled = true;
      canvas.style.filter = 'none';
    } catch (e) {
      // CORS tainted canvas - fall back to CSS blur
      drawFitted(ctx, posterImage, displayWidth, displayHeight);
      const CSS_BLUR = [40, 28, 18, 10, 5, 2];
      const blurAmount = showFull ? 0 : CSS_BLUR[stage] || 0;
      canvas.style.filter = blurAmount ? `blur(${blurAmount}px)` : 'none';
    }
  }

  function drawFitted(context, img, w, h) {
    const imgRatio = img.width / img.height;
    const canvasRatio = w / h;

    let drawW, drawH, drawX, drawY;

    if (imgRatio > canvasRatio) {
      drawH = h;
      drawW = h * imgRatio;
      drawX = (w - drawW) / 2;
      drawY = 0;
    } else {
      drawW = w;
      drawH = w / imgRatio;
      drawX = 0;
      drawY = (h - drawH) / 2;
    }

    context.drawImage(img, drawX, drawY, drawW, drawH);
  }

  // --- Clues ---
  function renderClues() {
    cluesEl.innerHTML = '';

    const clueData = [
      { key: 'year', label: 'Year', value: todayMovie.y },
      { key: 'genre', label: 'Genre', value: todayMovie.g.join(', ') },
      { key: 'director', label: 'Director', value: todayMovie.d },
      { key: 'actor', label: 'Lead', value: todayMovie.c[0] },
      { key: 'tagline', label: 'Tagline', value: todayMovie.tg || 'No tagline' },
    ];

    clueData.forEach((clue, i) => {
      const revealedAt = CLUE_STAGES.indexOf(clue.key); // which guess # reveals this
      const isRevealed = guesses.length >= revealedAt && revealedAt > 0;
      const isGameOverReveal = gameOver;

      const pill = document.createElement('div');
      pill.className = 'clue-pill';

      if (isRevealed || isGameOverReveal) {
        pill.classList.add('revealed');
        pill.innerHTML = `<span class="clue-label">${clue.label}</span><span class="clue-value">${escapeHtml(clue.value)}</span>`;
      } else {
        pill.classList.add('locked');
        pill.innerHTML = `<span class="clue-label">${clue.label}</span><span class="clue-value">??????</span>`;
      }

      cluesEl.appendChild(pill);
    });
  }

  // --- Guesses ---
  function makeGuess(movieTitle) {
    if (gameOver || guesses.length >= MAX_GUESSES) return;

    const isCorrect = normalizeTitle(movieTitle) === normalizeTitle(todayMovie.t);

    guesses.push({
      title: movieTitle,
      correct: isCorrect,
      skipped: false,
    });

    if (isCorrect) {
      won = true;
      gameOver = true;
    } else if (guesses.length >= MAX_GUESSES) {
      gameOver = true;
    }

    saveState();
    renderGuesses();
    renderClues();
    renderPoster();
    clearInput();

    if (gameOver) {
      disableInput();
      setTimeout(() => showGameOver(), 1200);
      if (won) {
        canvas.classList.add('poster-reveal');
      }
    }
  }

  function skipGuess() {
    if (gameOver || guesses.length >= MAX_GUESSES) return;

    guesses.push({
      title: '',
      correct: false,
      skipped: true,
    });

    if (guesses.length >= MAX_GUESSES) {
      gameOver = true;
    }

    saveState();
    renderGuesses();
    renderClues();
    renderPoster();
    clearInput();

    if (gameOver) {
      disableInput();
      setTimeout(() => showGameOver(), 1200);
    }
  }

  function renderGuesses() {
    guessListEl.innerHTML = '';

    for (let i = 0; i < guesses.length; i++) {
      const g = guesses[i];
      const row = document.createElement('div');
      row.className = `guess-row ${g.correct ? 'correct' : g.skipped ? 'skipped' : 'wrong'}`;

      row.innerHTML = `
        <span class="guess-num">${i + 1}</span>
        <span class="guess-text">${g.skipped ? 'Skipped' : escapeHtml(g.title)}</span>
        <span class="guess-icon"></span>
      `;

      guessListEl.appendChild(row);
    }
  }

  // --- Autocomplete ---
  function updateAutocomplete(query) {
    if (!query || query.length < 2) {
      hideDropdown();
      return;
    }

    const q = query.toLowerCase();
    const matches = MOVIES
      .filter(m => m.t.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prioritize starts-with matches
        const aStarts = a.t.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.t.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return b.r - a.r; // Then by rating
      })
      .slice(0, 8);

    if (matches.length === 0) {
      hideDropdown();
      return;
    }

    dropdownEl.innerHTML = '';
    matches.forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'ac-item';
      if (i === acIndex) item.classList.add('selected');
      item.innerHTML = `<span class="ac-title">${escapeHtml(m.t)}</span><span class="ac-year">(${m.y})</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectAutocomplete(m);
      });
      dropdownEl.appendChild(item);
    });

    dropdownEl.classList.add('visible');
  }

  function selectAutocomplete(movie) {
    selectedMovie = movie;
    inputEl.value = movie.t;
    hideDropdown();
    submitBtn.disabled = false;
  }

  function hideDropdown() {
    dropdownEl.classList.remove('visible');
    dropdownEl.innerHTML = '';
    acIndex = -1;
  }

  function clearInput() {
    inputEl.value = '';
    selectedMovie = null;
    submitBtn.disabled = true;
    hideDropdown();
  }

  function disableInput() {
    inputEl.disabled = true;
    submitBtn.disabled = true;
    skipBtn.disabled = true;
  }

  // --- Game Over ---
  function showGameOver() {
    gameOverEl.classList.remove('hidden');

    const iconEl = document.getElementById('result-icon');
    const titleEl = document.getElementById('result-title');
    const movieEl = document.getElementById('result-movie');
    const posterEl = document.getElementById('result-poster');
    const detailsEl = document.getElementById('result-details');

    if (won) {
      const guessNum = guesses.length;
      iconEl.textContent = guessNum <= 1 ? '🤯' : guessNum <= 3 ? '🎬' : '😅';
      titleEl.textContent = guessNum <= 1 ? 'Incredible!' : guessNum <= 3 ? 'Well done!' : 'Got it!';
    } else {
      iconEl.textContent = '😔';
      titleEl.textContent = 'Better luck tomorrow!';
    }

    movieEl.textContent = `${todayMovie.t} (${todayMovie.y})`;
    posterEl.src = TMDB_IMG + 'w342' + todayMovie.p;

    const details = [];
    if (todayMovie.d) details.push(`Directed by ${todayMovie.d}`);
    if (todayMovie.g.length) details.push(todayMovie.g.join(' / '));
    if (todayMovie.c.length) details.push(`Starring ${todayMovie.c.join(', ')}`);
    detailsEl.innerHTML = details.join('<br>');

    updateStats();
    startCountdown();
  }

  // --- Share ---
  function generateShareText() {
    const emojis = guesses.map(g => {
      if (g.correct) return '🟩';
      if (g.skipped) return '⬛';
      return '🟥';
    });

    // Pad remaining guesses
    while (emojis.length < MAX_GUESSES) {
      emojis.push('⬜');
    }

    const result = won ? `${guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;

    return `Posterdle #${puzzleNumber} ${result}\n${emojis.join('')}\nhttps://posterdle.game`;
  }

  // --- Stats ---
  function getStats() {
    try {
      return JSON.parse(localStorage.getItem(STATS_KEY)) || defaultStats();
    } catch {
      return defaultStats();
    }
  }

  function defaultStats() {
    return {
      played: 0,
      won: 0,
      streak: 0,
      maxStreak: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      lastPuzzle: -1,
    };
  }

  function updateStats() {
    const stats = getStats();

    if (stats.lastPuzzle === puzzleNumber) return; // Already recorded

    stats.played++;
    if (won) {
      stats.won++;
      stats.streak++;
      stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
      stats.distribution[guesses.length] = (stats.distribution[guesses.length] || 0) + 1;
    } else {
      stats.streak = 0;
    }

    stats.lastPuzzle = puzzleNumber;
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  }

  function renderStats() {
    const stats = getStats();

    document.getElementById('stat-played').textContent = stats.played;
    document.getElementById('stat-win-pct').textContent = stats.played ? Math.round(100 * stats.won / stats.played) : 0;
    document.getElementById('stat-streak').textContent = stats.streak;
    document.getElementById('stat-max-streak').textContent = stats.maxStreak;

    const distEl = document.getElementById('guess-distribution');
    distEl.innerHTML = '';

    const maxVal = Math.max(1, ...Object.values(stats.distribution));

    for (let i = 1; i <= MAX_GUESSES; i++) {
      const count = stats.distribution[i] || 0;
      const pct = Math.max(8, (count / maxVal) * 100);
      const isLast = won && guesses.length === i;

      const row = document.createElement('div');
      row.className = 'dist-row';
      row.innerHTML = `
        <span class="dist-num">${i}</span>
        <div class="dist-bar ${isLast ? 'highlight' : ''}" style="width:${pct}%">${count}</div>
      `;
      distEl.appendChild(row);
    }
  }

  // --- Countdown ---
  function startCountdown() {
    function update() {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCHours(24, 0, 0, 0);
      const diff = tomorrow.getTime() - now.getTime();

      if (diff <= 0) {
        document.getElementById('countdown').textContent = 'Now!';
        return;
      }

      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);

      document.getElementById('countdown').textContent =
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    update();
    setInterval(update, 1000);
  }

  // --- Persistence ---
  function saveState() {
    const state = {
      puzzle: puzzleNumber,
      guesses: guesses,
      gameOver: gameOver,
      won: won,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadState() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (state && state.puzzle === puzzleNumber) {
        guesses = state.guesses || [];
        gameOver = state.gameOver || false;
        won = state.won || false;
      }
    } catch {
      // Fresh state
    }
  }

  // --- Modals ---
  function showModal(id) {
    document.getElementById(id).classList.remove('hidden');
    if (id === 'stats-modal') renderStats();
  }

  function hideModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  // --- Event Listeners ---
  function setupEventListeners() {
    // Input
    inputEl.addEventListener('input', () => {
      selectedMovie = null;
      submitBtn.disabled = true;
      acIndex = -1;
      updateAutocomplete(inputEl.value.trim());
    });

    inputEl.addEventListener('keydown', (e) => {
      const items = dropdownEl.querySelectorAll('.ac-item');

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acIndex = Math.min(acIndex + 1, items.length - 1);
        highlightAcItem(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acIndex = Math.max(acIndex - 1, 0);
        highlightAcItem(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (acIndex >= 0 && items.length > 0) {
          items[acIndex].dispatchEvent(new MouseEvent('mousedown'));
        } else if (selectedMovie) {
          makeGuess(selectedMovie.t);
        }
      } else if (e.key === 'Escape') {
        hideDropdown();
      }
    });

    inputEl.addEventListener('blur', () => {
      // Small delay to allow mousedown on dropdown
      setTimeout(hideDropdown, 200);
    });

    // Buttons
    submitBtn.addEventListener('click', () => {
      if (selectedMovie) makeGuess(selectedMovie.t);
    });

    skipBtn.addEventListener('click', skipGuess);

    // Help
    document.getElementById('btn-help').addEventListener('click', () => showModal('help-modal'));

    // Stats
    document.getElementById('btn-stats').addEventListener('click', () => showModal('stats-modal'));

    // Share
    document.getElementById('btn-share').addEventListener('click', () => {
      const text = generateShareText();
      navigator.clipboard.writeText(text).then(() => {
        const toast = document.getElementById('share-toast');
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 2000);
      }).catch(() => {
        // Fallback
        prompt('Copy your result:', text);
      });
    });

    // Close modals
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal').classList.add('hidden');
      });
    });

    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    // Close game over overlay on background click
    gameOverEl.addEventListener('click', (e) => {
      if (e.target === gameOverEl) gameOverEl.classList.add('hidden');
    });

    // Resize
    window.addEventListener('resize', () => {
      if (posterLoaded) renderPoster();
    });
  }

  function highlightAcItem(items) {
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === acIndex);
    });
    // Also grab the movie data for quick enter
    if (acIndex >= 0) {
      const q = inputEl.value.trim().toLowerCase();
      const matches = MOVIES
        .filter(m => m.t.toLowerCase().includes(q))
        .sort((a, b) => {
          const aStarts = a.t.toLowerCase().startsWith(q) ? 0 : 1;
          const bStarts = b.t.toLowerCase().startsWith(q) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
          return b.r - a.r;
        })
        .slice(0, 8);
      if (matches[acIndex]) {
        selectedMovie = matches[acIndex];
        submitBtn.disabled = false;
      }
    }
  }

  // --- Utils ---
  function normalizeTitle(title) {
    return title.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Start ---
  init();

})();
