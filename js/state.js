/* ==========================================================================
   Общий стор «Своей игры».
   - Источник правды — объект state в localStorage (переживает перезагрузку).
   - Любое изменение идёт через Store.dispatch(action) → reduce() → save →
     рассылка по BroadcastChannel('quiz'). Событие `storage` — запасной канал.
   - state.rev растёт с каждым изменением: вкладка принимает только более новое.
   - state.events — короткая лента «эффектов» (верно/неверно/баззер…),
     по ней экран гостей проигрывает анимации и звуки ровно один раз.
   ========================================================================== */
(function () {
  'use strict';

  const KEY = 'svoyak:state:v1';
  const MAX_EVENTS = 20;
  const MAX_HISTORY = 60;

  const PALETTE = ['#C6FF00', '#FF2E93', '#2B4BFF', '#FF6A00', '#FFE600', '#00D1FF', '#A259FF', '#FFFFFF'];
  const DEFAULT_KEYS = ['KeyQ', 'KeyP', 'KeyZ', 'KeyM', 'KeyA', 'KeyL', 'KeyX', 'KeyN'];
  // служебные клавиши пульта — баззером их назначить нельзя («1» = таймер)
  const RESERVED_KEYS = ['Digit1', 'Numpad1', 'Space', 'Enter', 'NumpadEnter', 'Tab', 'Escape', 'KeyF', 'Backspace'];
  // код комнаты для телефонов: без путаемых символов (0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B)
  const ROOM_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';
  function makeRoom(len = 4) {
    let r = '';
    for (let i = 0; i < len; i++) r += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    return r;
  }
  const EMOJIS = ['🦄', '🔥', '👾', '🐸', '🍒', '💿', '🦋', '👽', '🌶️', '🧃', '🪩', '🛸', '🍓', '🐙', '⚡', '🎀'];
  const TEAM_NAMES = ['Кислотные', 'Розовые сопли', 'Синий экран', 'Рыжий вайб', 'Жёлтая пресса', 'Голубая волна', 'Фиолетики', 'Белые воротнички'];

  /* ---------- утилиты ---------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const now = () => Date.now();
  const uid = () => 't' + Math.random().toString(36).slice(2, 8);

  function cellKey(r, c, q) { return `${r}-${c}-${q}`; }

  /** Подпись клавиши по event.code: KeyQ → Q, Digit1 → 1. */
  function keyLabel(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    const map = { Space: 'Пробел', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`' };
    return map[code] || code;
  }

  /** Тёмный или светлый текст поверх цвета команды. */
  function textOn(hex) {
    const h = (hex || '#000').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0b0614' : '#ffffff';
  }

  /** Оставшееся время таймера в мс (с учётом бегущего отсчёта). */
  function timerRemaining(t) {
    if (!t) return 0;
    if (t.running) return Math.max(0, t.endsAt - now());
    return Math.max(0, t.remaining);
  }

  /* ---------- данные квиза ---------- */
  let QUIZ = null;
  function getQ(r, c, q) {
    const round = QUIZ && QUIZ.rounds[r];
    const cat = round && round.categories[c];
    return cat && cat.questions[q] ? { round, cat, q: cat.questions[q] } : null;
  }
  /** Номинал ячейки. value в данных уже итоговый (во 2-м раунде 200–1000),
      multiplier раунда — только для информации, на него НЕ умножаем. */
  function cellValue(r, c, q) {
    const x = getQ(r, c, q);
    return x ? Math.round(Number(x.q.value) || 0) : 0;
  }
  /** Сколько стоит текущий вопрос (у аукциона — ставка). */
  function currentValue(s) {
    const cur = s.current;
    if (!cur) return 0;
    if (cur.special === 'auction' && cur.bet > 0) return cur.bet;
    return cellValue(cur.r, cur.c, cur.q);
  }

  /* ---------- начальное состояние ---------- */
  function freshTimer(duration) {
    const d = duration || 30;
    return { duration: d, running: false, endsAt: 0, remaining: d * 1000 };
  }
  function initialState(teams) {
    return {
      v: 1,
      rev: 0,
      phase: 'setup',            // setup | board | question | final | winner
      teams: teams || [],        // {id,name,emoji,color,key,score}
      round: 0,
      used: {},                  // cellKey → {by: teamId|null}
      current: null,             // открытый вопрос
      timer: freshTimer(30),
      buzzer: { winner: null, at: 0 },
      final: { stage: 'intro', bets: {}, results: {} },
      history: [],               // снимки для undo
      events: [],
      eventSeq: 0,
      room: null,                // код комнаты для телефонов-баззеров
      music: { enabled: true, volume: 0.5, sfx: 0.8, files: {} }, // files: mode → {name, at} (сами файлы — в IndexedDB)
      net: { status: 'off', devices: 0, byTeam: {}, transport: '' }, // публикует пульт
    };
  }

  function makeTeam(s, overrides) {
    const i = s.teams.length;
    const usedColors = new Set(s.teams.map((t) => t.color));
    const usedKeys = new Set(s.teams.map((t) => t.key));
    const usedEmo = new Set(s.teams.map((t) => t.emoji));
    return {
      id: uid(),
      name: TEAM_NAMES.find((n) => !s.teams.some((t) => t.name === n)) || `Команда ${i + 1}`,
      emoji: EMOJIS.find((e) => !usedEmo.has(e)) || '⭐',
      color: PALETTE.find((c) => !usedColors.has(c)) || PALETTE[i % PALETTE.length],
      key: DEFAULT_KEYS.find((k) => !usedKeys.has(k)) || '',
      score: 0,
      device: null,      // clientId привязанного телефона (1 телефон = 1 команда)
      avatar: null,      // dataURL 256×256 (нарисовали/загрузили на телефоне) — вместо эмодзи
      avatarV: 0,        // версия аватара: телефонам рассылаем номер, а не картинку
      ...(overrides || {}),
    };
  }

  /* ---------- редьюсер ---------- */
  const team = (s, id) => s.teams.find((t) => t.id === id);

  function emit(s, ev) {
    s.eventSeq += 1;
    s.events.push(Object.assign({ id: s.eventSeq, at: now() }, ev));
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  }

  function snapshot(s, label) {
    const scores = {};
    s.teams.forEach((t) => (scores[t.id] = t.score));
    s.history.push({
      label,
      scores,
      used: clone(s.used),
      current: s.current ? clone(s.current) : null,
      final: clone(s.final),
    });
    if (s.history.length > MAX_HISTORY) s.history.shift();
  }

  function pauseTimer(s) {
    const t = s.timer;
    if (t.running) { t.remaining = Math.max(0, t.endsAt - now()); t.running = false; }
  }

  function reduce(s, a) {
    switch (a.type) {
      /* --- команды --- */
      case 'teamAdd':
        if (s.teams.length < 8) s.teams.push(makeTeam(s));
        break;
      case 'teamUpdate': {
        const t = team(s, a.id);
        if (!t) break;
        const patch = Object.assign({}, a.patch);
        if (patch.key && RESERVED_KEYS.includes(patch.key)) delete patch.key;
        Object.assign(t, patch);
        break;
      }
      case 'teamCreate': // команда зарегистрировалась с телефона
        if (s.teams.length < 8 && !team(s, a.id)) {
          if (a.device) s.teams.forEach((t) => { if (t.device === a.device) t.device = null; });
          s.teams.push(makeTeam(s, { id: a.id, name: String(a.name || '').slice(0, 28) || 'Без названия', emoji: a.emoji || '⭐', device: a.device || null, avatar: a.avatar || null, avatarV: a.avatar ? 1 : 0 }));
          emit(s, { kind: 'teamJoin', teamId: a.id });
        }
        break;
      case 'teamAvatar': { // avatar: dataURL или null (сброс к эмодзи)
        const t = team(s, a.teamId);
        if (!t) break;
        t.avatar = a.avatar || null;
        if (a.emoji) t.emoji = a.emoji;
        t.avatarV = (t.avatarV || 0) + 1;
        break;
      }
      case 'bindDevice': { // телефон занял команду (device: null — отвязать)
        const t = team(s, a.teamId);
        if (!t) break;
        if (a.device) s.teams.forEach((x) => { if (x.device === a.device) x.device = null; });
        t.device = a.device || null;
        break;
      }
      case 'teamRemove':
        s.teams = s.teams.filter((t) => t.id !== a.id);
        break;

      /* --- ход игры --- */
      case 'startGame':
        s.phase = 'board';
        s.round = 0;
        s.current = null;
        emit(s, { kind: 'start' });
        break;

      case 'gotoRound':
        s.phase = 'board';
        s.round = Math.max(0, Math.min(a.round, (QUIZ ? QUIZ.rounds.length : 1) - 1));
        s.current = null;
        s.buzzer = { winner: null, at: 0 };
        s.timer = freshTimer(s.timer.duration);
        emit(s, { kind: 'round', round: s.round });
        break;

      case 'openCell': {
        const x = getQ(a.r, a.c, a.q);
        if (!x) break;
        s.phase = 'question';
        s.round = a.r;
        const special = x.q.special || null;
        s.current = {
          r: a.r, c: a.c, q: a.q,
          key: cellKey(a.r, a.c, a.q),
          special,
          stage: special ? 'intro' : 'question',  // intro → question → answer
          owner: null,      // кому передан кот / кто выиграл аукцион
          bet: 0,
          wrong: [],        // кто уже ошибся
          winner: null,     // кто ответил верно
        };
        s.timer = freshTimer(s.timer.duration);
        s.buzzer = { winner: null, at: 0 };
        emit(s, { kind: 'select', key: s.current.key, special });
        break;
      }

      case 'setOwner':
        if (s.current) { s.current.owner = a.teamId; emit(s, { kind: 'owner', teamId: a.teamId }); }
        break;
      case 'setBet':
        if (s.current) s.current.bet = Math.max(0, Math.round(Number(a.bet) || 0));
        break;
      case 'showQuestion':
        if (s.current) { s.current.stage = 'question'; emit(s, { kind: 'showQuestion' }); }
        break;

      case 'judge': {
        const cur = s.current;
        const t = team(s, a.teamId);
        if (!cur || !t || cur.stage === 'answer') break;
        const d = currentValue(s);
        snapshot(s, `${t.emoji} ${t.name} ${a.correct ? '+' : '−'}${d}`);
        if (a.correct) {
          t.score += d;
          cur.stage = 'answer';
          cur.winner = t.id;
          s.used[cur.key] = { by: t.id };
          pauseTimer(s);
          emit(s, { kind: 'correct', teamId: t.id, delta: d });
        } else {
          t.score -= d;
          if (!cur.wrong.includes(t.id)) cur.wrong.push(t.id);
          s.buzzer = { winner: null, at: 0 };   // право ответа переходит дальше
          emit(s, { kind: 'wrong', teamId: t.id, delta: -d });
        }
        break;
      }

      case 'reveal': {
        const cur = s.current;
        if (!cur || cur.stage === 'answer') break;
        cur.stage = 'answer';
        if (!s.used[cur.key]) s.used[cur.key] = { by: null };
        pauseTimer(s);
        emit(s, { kind: 'reveal' });
        break;
      }

      case 'backToBoard':
        s.phase = 'board';
        s.current = null;
        s.buzzer = { winner: null, at: 0 };
        s.timer = freshTimer(s.timer.duration);
        emit(s, { kind: 'board' });
        break;

      case 'toggleUsed': // ручное открытие/закрытие ячейки на пульте
        if (s.used[a.key]) delete s.used[a.key]; else s.used[a.key] = { by: null };
        break;

      /* --- таймер --- */
      case 'timerStart': {
        const t = s.timer;
        if (t.running) break;
        if (t.remaining <= 0) t.remaining = t.duration * 1000;
        t.endsAt = now() + t.remaining;
        t.running = true;
        emit(s, { kind: 'timerStart' });
        break;
      }
      case 'timerPause':
        pauseTimer(s);
        break;
      case 'timerReset':
        s.timer = freshTimer(s.timer.duration);
        break;
      case 'timerDuration':
        s.timer = freshTimer(Math.max(5, Math.min(300, Number(a.seconds) || 30)));
        break;

      /* --- баззер --- */
      case 'buzz': {
        const t = team(s, a.teamId);
        if (!t) break;
        if (s.phase === 'setup') { emit(s, { kind: 'buzz', teamId: t.id, test: true }); break; }
        const cur = s.current;
        if (s.phase !== 'question' || !cur || cur.stage !== 'question' || cur.special) break;
        if (s.buzzer.winner || cur.wrong.includes(t.id)) break;
        s.buzzer = { winner: t.id, at: now() };
        pauseTimer(s); // как в «Своей игре»: нажали — время стоп
        emit(s, { kind: 'buzz', teamId: t.id });
        break;
      }
      case 'buzzReset':
        s.buzzer = { winner: null, at: 0 };
        emit(s, { kind: 'buzzReset' });
        break;

      /* --- счёт --- */
      case 'adjust': {
        const t = team(s, a.teamId);
        if (!t) break;
        snapshot(s, `${t.emoji} ${t.name} ${a.delta > 0 ? '+' : '−'}${Math.abs(a.delta)} (вручную)`);
        t.score += a.delta;
        emit(s, { kind: 'adjust', teamId: t.id, delta: a.delta });
        break;
      }
      case 'undo': {
        const h = s.history.pop();
        if (!h) break;
        const changed = [];
        s.teams.forEach((t) => {
          if (h.scores[t.id] !== undefined && h.scores[t.id] !== t.score) {
            changed.push({ teamId: t.id, delta: h.scores[t.id] - t.score });
            t.score = h.scores[t.id];
          }
        });
        s.used = h.used;
        s.final = h.final || s.final;
        // вопрос откатываем, только если всё ещё открыт тот же
        if (s.current && h.current && h.current.key === s.current.key) s.current = h.current;
        emit(s, { kind: 'undo', changed });
        break;
      }

      /* --- финал --- */
      case 'gotoFinal':
        s.phase = 'final';
        s.current = null;
        s.final = { stage: 'intro', bets: {}, results: {} };
        s.timer = freshTimer(s.timer.duration);
        s.buzzer = { winner: null, at: 0 };
        emit(s, { kind: 'final' });
        break;
      case 'finalStage':
        s.final.stage = a.stage; // intro | bets | question | answer
        if (a.stage !== 'question') pauseTimer(s);
        if (a.stage === 'question') s.timer = freshTimer(s.timer.duration);
        emit(s, { kind: 'finalStage', stage: a.stage });
        break;
      case 'finalBet':
        s.final.bets[a.teamId] = Math.max(0, Math.round(Number(a.bet) || 0));
        break;
      case 'finalJudge': {
        const t = team(s, a.teamId);
        if (!t || s.final.results[t.id] !== undefined) break;
        const bet = s.final.bets[t.id] || 0;
        snapshot(s, `Финал: ${t.emoji} ${t.name} ${a.correct ? '+' : '−'}${bet}`);
        s.final.results[t.id] = !!a.correct;
        t.score += a.correct ? bet : -bet;
        emit(s, { kind: a.correct ? 'correct' : 'wrong', teamId: t.id, delta: a.correct ? bet : -bet, final: true });
        break;
      }
      case 'setRoom':
        s.room = a.room;
        break;
      case 'musicSet':
        s.music = Object.assign({ enabled: true, volume: 0.5, sfx: 0.8, files: {} }, s.music || {}, a.patch);
        break;
      case 'netInfo':
        s.net = Object.assign({}, s.net || {}, a.net);
        break;
      case 'backToFinal':
        s.phase = 'final';
        break;
      case 'showWinner':
        s.phase = 'winner';
        pauseTimer(s);
        emit(s, { kind: 'winner' });
        break;

      case 'resetGame': {
        const teams = s.teams.map((t) => Object.assign({}, t, { score: 0 }));
        const fresh = initialState(teams);
        fresh.room = s.room;
        fresh.net = s.net;
        fresh.music = s.music || fresh.music;
        fresh.rev = s.rev;
        fresh.eventSeq = s.eventSeq;
        emit(fresh, { kind: 'reset' });
        return fresh;
      }
      default:
        console.warn('Неизвестное действие', a);
    }
    return s;
  }

  /* ---------- хранение и синхронизация ---------- */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && s.v === 1 ? s : null;
    } catch (e) { return null; }
  }

  let state = load() || initialState();
  const subs = new Set();
  let channel = null;
  try { channel = new BroadcastChannel('quiz'); } catch (e) { /* старый браузер — только storage */ }

  function notify(action) { subs.forEach((fn) => { try { fn(state, action); } catch (e) { console.error(e); } }); }

  function adopt(next) {
    if (!next || next.v !== 1 || next.rev <= state.rev) return false;
    state = next;
    notify(null);
    return true;
  }

  if (channel) channel.onmessage = (e) => { if (e.data && e.data.type === 'state') adopt(e.data.state); };
  window.addEventListener('storage', (e) => {
    if (e.key === KEY && e.newValue) { try { adopt(JSON.parse(e.newValue)); } catch (_) { /* ignore */ } }
  });

  function dispatch(action) {
    // подтягиваем самое свежее из localStorage, чтобы не затереть чужое изменение
    const disk = load();
    if (disk && disk.rev > state.rev) state = disk;
    const next = reduce(clone(state), action);
    next.rev = state.rev + 1;
    state = next;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.error('localStorage', e); }
    if (channel) { try { channel.postMessage({ type: 'state', state }); } catch (e) { /* ignore */ } }
    notify(action);
    return state;
  }

  window.Store = {
    get: () => state,
    dispatch,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setQuiz(q) { QUIZ = q; },
    quiz: () => QUIZ,
  };
  window.QuizUtil = { makeRoom, RESERVED_KEYS, cellKey, keyLabel, textOn, timerRemaining, getQ, cellValue, currentValue, PALETTE, EMOJIS, DEFAULT_KEYS };
})();
