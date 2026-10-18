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
  function makeKey(len = 20) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    let r = '';
    const a = new Uint32Array(len);
    try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < len; i++) a[i] = Math.floor(Math.random() * 1e9); }
    for (let i = 0; i < len; i++) r += abc[a[i] % abc.length];
    return r;
  }
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
  // экран на другом устройстве: часы ноутбуков расходятся, поправка приходит от пульта
  let clockSkew = 0;
  const syncedNow = () => Date.now() + clockSkew;
  function timerRemaining(t) {
    if (!t) return 0;
    if (t.running) return Math.max(0, t.endsAt - syncedNow());
    return Math.max(0, t.remaining);
  }

  /* ---------- отрывок трека (type: "audio") ----------
     current.audio = { playing, pos, at, dur, seq, status }
     pos — секунда отрывка (от media.audio.start) в момент at (часы пульта);
     at может быть в будущем: автостарт после интро-анимации экрана.
     seq растёт с каждой командой ведущего — плеер по нему делает seek. */
  const CLIP_INTRO_MS = 2300;   // ячейка «отрывается» и летит на экран ≈ 2,1 с
  function clipPos(a) {
    if (!a) return 0;
    if (!a.playing) return Math.max(0, Math.min(a.dur, a.pos));
    return Math.max(0, Math.min(a.dur, a.pos + Math.max(0, syncedNow() - a.at) / 1000));
  }
  /** wait (скоро стартует) | play | pause | done */
  function clipPhase(a) {
    if (!a) return 'none';
    const p = clipPos(a);
    if (p >= a.dur - 0.02) return 'done';
    if (!a.playing) return 'pause';
    return syncedNow() < a.at ? 'wait' : 'play';
  }
  /** Ключ своего файла для вопроса: id из данных или координаты ячейки. */
  function clipKey(r, c, q) {
    const x = getQ(r, c, q);
    return x && x.q.id ? 'id:' + x.q.id : 'cell:' + cellKey(r, c, q);
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
  /** Длительность «общего» таймера вопроса (во время отсчёта на ответ она лежит в saved). */
  function qDur(s) {
    const t = s.timer || {};
    return t.kind === 'answer' && t.saved ? t.saved.duration : (t.duration || 30);
  }
  /** Вернуть приостановленный таймер вопроса после отсчёта на ответ. */
  function restoreQuestionTimer(s) {
    const t = s.timer;
    if (t && t.kind === 'answer') {
      const sv = t.saved || { duration: 30, remaining: 30000 };
      s.timer = { duration: sv.duration, running: false, endsAt: 0, remaining: sv.remaining, kind: 'question' };
    }
  }
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
      answerSeconds: 15,         // время на ответ после баззера (таймер стартует сам)
      buzzer: { winner: null, at: 0 },
      final: { stage: 'intro', bets: {}, results: {} },
      history: [],               // снимки для undo
      events: [],
      eventSeq: 0,
      room: null,                // код комнаты для телефонов-баззеров (показывается, вводится руками)
      netKey: null,              // секрет комнаты: топики MQTT, идёт в QR-ссылку
      clips: {},                 // свои отрывки к audio-вопросам: clipKey → {name, at} (файлы — в IndexedDB)
      music: { enabled: true, volume: 0.5, sfx: 0.8, style: 'show', files: {} }, // style: phonk|show|chip; files: mode → {name, at} (сами файлы — в IndexedDB)
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

  /** Финал уже начали: есть ставки или оценки, или ушли дальше заставки. */
  function finalStarted(f) {
    return !!(f && (Object.keys(f.bets || {}).length || Object.keys(f.results || {}).length || (f.stage && f.stage !== 'intro')));
  }

  /** Максимальная ставка финала: от 0 до счёта (при счёте ≤ 0 — только 0). */
  function finalMaxBet(t) { return Math.max(0, (t && t.score) || 0); }

  /** Ставка аукциона: от номинала до max(счёт владельца, номинал). withMin — поднять до номинала. */
  function clampAuctionBet(s, bet, withMin) {
    const cur = s.current;
    const nominal = cellValue(cur.r, cur.c, cur.q);
    let b = Math.max(0, Math.round(Number(bet) || 0));
    const owner = cur.owner && team(s, cur.owner);
    if (owner) b = Math.min(b, Math.max(owner.score, nominal));
    if (withMin && b < nominal) b = nominal;
    return b;
  }

  function pauseTimer(s) {
    const t = s.timer;
    if (t.running) { t.remaining = Math.max(0, t.endsAt - now()); t.running = false; }
  }

  /** Отрывок — на паузу (баззер, ответ). */
  function clipStop(s) {
    const a = s.current && s.current.audio;
    if (!a || !a.playing) return;
    a.pos = clipPos(a);
    a.playing = false;
    a.at = now();
    a.seq += 1;
  }
  function clipStart(a, pos, delay) {
    a.pos = Math.max(0, pos);
    a.playing = true;
    a.at = now() + (delay || 0);
    a.seq += 1;
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
        s.timer = freshTimer(qDur(s));
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
        if (x.q.type === 'audio') {
          const au = (x.q.media && x.q.media.audio) || {};
          s.current.audio = { playing: false, pos: 0, at: now(), dur: Math.max(1, Number(au.dur) || 15), seq: 0, status: '' };
          // обычный вопрос — отрывок стартует сам, когда ячейка долетит до экрана
          if (!special) clipStart(s.current.audio, 0, CLIP_INTRO_MS);
        }
        s.timer = freshTimer(qDur(s));
        s.buzzer = { winner: null, at: 0 };
        emit(s, { kind: 'select', key: s.current.key, special });
        break;
      }

      case 'setOwner':
        if (s.current) {
          s.current.owner = a.teamId;
          if (s.current.special === 'auction' && s.current.bet) s.current.bet = clampAuctionBet(s, s.current.bet, false);
          emit(s, { kind: 'owner', teamId: a.teamId });
        }
        break;
      case 'setBet': // пока печатают — режем только сверху; минимум (номинал) — при показе вопроса
        if (s.current) s.current.bet = s.current.special === 'auction' ? clampAuctionBet(s, a.bet, false) : Math.max(0, Math.round(Number(a.bet) || 0));
        break;
      case 'showQuestion':
        if (s.current) {
          if (s.current.special === 'auction') s.current.bet = clampAuctionBet(s, s.current.bet, true);
          s.current.stage = 'question';
          if (s.current.audio && !s.current.audio.seq) clipStart(s.current.audio, 0, 700); // заставка кота/аукциона уезжает
          emit(s, { kind: 'showQuestion' });
        }
        break;

      case 'judge': {
        const cur = s.current;
        const t = team(s, a.teamId);
        if (!cur || !t || cur.stage === 'answer') break;
        // повторный ✗ той же команде (двойной клик) — не списываем второй раз
        if (!a.correct && cur.wrong.includes(t.id)) break;
        const d = currentValue(s);
        snapshot(s, `${t.emoji} ${t.name} ${a.correct ? '+' : '−'}${d}`);
        if (a.correct) {
          t.score += d;
          cur.stage = 'answer';
          cur.winner = t.id;
          s.used[cur.key] = { by: t.id };
          pauseTimer(s);
          clipStop(s);
          emit(s, { kind: 'correct', teamId: t.id, delta: d });
        } else {
          t.score -= d;
          if (!cur.wrong.includes(t.id)) cur.wrong.push(t.id);
          s.buzzer = { winner: null, at: 0 };   // право ответа переходит дальше
          restoreQuestionTimer(s);              // отсчёт на ответ стоп; следующий нажавший получит новый
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
        clipStop(s);
        emit(s, { kind: 'reveal' });
        break;
      }

      case 'backToBoard':
        s.phase = 'board';
        s.current = null;
        s.buzzer = { winner: null, at: 0 };
        s.timer = freshTimer(qDur(s));
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
        s.timer = freshTimer(qDur(s));
        break;
      case 'timerDuration':
        s.timer = freshTimer(Math.max(5, Math.min(300, Number(a.seconds) || 30)));
        break;
      case 'answerSeconds':
        s.answerSeconds = Math.max(5, Math.min(120, Number(a.seconds) || 15));
        break;

      /* --- отрывок трека --- */
      case 'audioPlay': {
        const au = s.current && s.current.audio;
        if (!au) break;
        const p = clipPos(au);
        clipStart(au, p >= au.dur - 0.05 || au.status === 'ended' ? 0 : p);
        if (au.status === 'ended') au.status = '';
        break;
      }
      case 'audioPause': clipStop(s); break;
      case 'audioRestart': {
        const au = s.current && s.current.audio;
        if (!au) break;
        clipStart(au, 0);
        if (au.status === 'ended') au.status = '';
        break;
      }
      case 'audioExtend': { // «+5 с»: отрывок длиннее; если уже доиграл — продолжаем с места остановки
        const au = s.current && s.current.audio;
        if (!au) break;
        const p = clipPos(au);
        const done = p >= au.dur - 0.05;
        au.dur = Math.min(600, au.dur + (Number(a.sec) || 5));
        if (au.status === 'ended') break; // файл кончился раньше — длиннее не станет
        if (done || au.playing) clipStart(au, p); else au.seq += 1;
        break;
      }
      case 'audioStatus': { // отчёт плеера: ok | blocked | error | ended
        const cur = s.current;
        const au = cur && cur.audio;
        if (!au || (a.key && a.key !== cur.key)) break;
        if (a.status === 'ended') { if (au.playing) clipStop(s); au.status = 'ended'; break; }
        au.status = String(a.status || '');
        break;
      }
      case 'clipFile': // свой отрывок загружен/удалён (file: {name, at} | null)
        s.clips = Object.assign({}, s.clips || {});
        if (a.file) s.clips[a.key] = a.file; else delete s.clips[a.key];
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
        clipStop(s); // отрывок замирает, пока команда отвечает
        // таймер вопроса — на паузу (запоминаем остаток), и сразу стартует отсчёт на ответ этой команды
        pauseTimer(s);
        const sec = s.answerSeconds || 15;
        s.timer = {
          duration: sec, running: true, endsAt: now() + sec * 1000, remaining: sec * 1000,
          kind: 'answer', teamId: t.id,
          saved: { duration: qDur(s), remaining: s.timer.kind === 'answer' ? (s.timer.saved || {}).remaining : s.timer.remaining },
        };
        emit(s, { kind: 'buzz', teamId: t.id });
        break;
      }
      case 'buzzReset':
        s.buzzer = { winner: null, at: 0 };
        restoreQuestionTimer(s);
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
        // финал уже начат (есть ставки/оценки) — возвращаемся в него, а не пересоздаём:
        // иначе команды можно оценить второй раз и очки начислятся повторно
        if (!finalStarted(s.final)) s.final = { stage: 'intro', bets: {}, results: {} };
        s.timer = freshTimer(qDur(s));
        s.buzzer = { winner: null, at: 0 };
        emit(s, { kind: 'final' });
        break;
      case 'finalStage':
        s.final.stage = a.stage; // intro | bets | question | answer
        if (a.stage !== 'question') pauseTimer(s);
        if (a.stage === 'question') s.timer = freshTimer(qDur(s));
        emit(s, { kind: 'finalStage', stage: a.stage });
        break;
      case 'finalBet': { // от 0 до счёта команды; пустое поле — ставки нет (считается как 0)
        const t = team(s, a.teamId);
        if (!t || s.final.results[t.id] !== undefined) break;
        if (a.bet === '' || a.bet === null || a.bet === undefined) { delete s.final.bets[t.id]; break; }
        s.final.bets[t.id] = Math.min(Math.max(0, t.score), Math.max(0, Math.round(Number(a.bet) || 0)));
        break;
      }
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
        if (a.key) s.netKey = a.key;
        break;
      case 'musicSet':
        s.music = Object.assign({ enabled: true, volume: 0.5, sfx: 0.8, style: 'show', files: {} }, s.music || {}, a.patch);
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
        fresh.netKey = s.netKey;
        fresh.answerSeconds = s.answerSeconds || 15;
        fresh.timer = freshTimer(qDur(s));
        fresh.net = s.net;
        fresh.music = s.music || fresh.music;
        fresh.clips = s.clips || {};
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

  let remoteSend = null; // режим «экран по сети»: состояние приходит от пульта, действия уходят ему
  function adopt(next) {
    if (remoteSend) return false;
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
    if (remoteSend) { try { remoteSend(action); } catch (e) { /* ignore */ } return state; }
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
    /** Экран на другом устройстве: локальные изменения отключаются, действия (баззер) — в sendFn. */
    useRemote(sendFn) { remoteSend = sendFn; },
    isRemote: () => !!remoteSend,
    /** Принять состояние от пульта (без записи в localStorage этого устройства). */
    applyRemote(next) { if (!next) return; state = next; notify(null); },
    setClockSkew(ms) { clockSkew = Number(ms) || 0; },
  };
  /** Места с учётом ничьих (плотная нумерация: 1, 1, 2, 3…). Возвращает [{place, teams:[…], score}]. */
  function placesOf(teams) {
    const sorted = (teams || []).slice().sort((a, b) => b.score - a.score);
    const groups = [];
    sorted.forEach((t) => {
      const g = groups[groups.length - 1];
      if (g && g.score === t.score) g.teams.push(t);
      else groups.push({ place: groups.length + 1, score: t.score, teams: [t] });
    });
    return groups;
  }
  /** Счёт с настоящим минусом: −400, а не -400. */
  function fmtScore(n) { const v = Math.round(Number(n) || 0); return v < 0 ? '\u2212' + Math.abs(v) : String(v); }

  window.QuizUtil = { clipPos, clipPhase, clipKey, now: syncedNow, placesOf, fmtScore, finalMaxBet, finalStarted, makeRoom, makeKey, RESERVED_KEYS, cellKey, keyLabel, textOn, timerRemaining, getQ, cellValue, currentValue, PALETTE, EMOJIS, DEFAULT_KEYS };
})();
