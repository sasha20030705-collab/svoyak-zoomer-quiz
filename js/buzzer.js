/* ==========================================================================
   Баззер на телефоне гостя (buzzer.html?room=XXXX).
   Телефон ничего не решает сам: шлёт пульту join/buzz и рисует то,
   что пульт прислал в компактном состоянии. Локально — только «РАНО!»
   (чтобы не гонять сеть зря) и мгновенный отклик на нажатие.
   ========================================================================== */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EMOJIS = ['🦄', '🔥', '👾', '🐸', '🍒', '💿', '🦋', '👽', '🪩', '🛸', '🐙', '⚡', '🎀', '🐱', '🦖', '👑'];

  function textOn(hex) {
    const n = parseInt(String(hex || '#000').replace('#', ''), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? '#0A0A0A' : '#FFFFFF';
  }
  const vibrate = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } };

  /* ---------- комната и память телефона ---------- */
  const params = new URLSearchParams(location.search);
  let room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const keyFor = (r) => 'svoyak:buzzer:' + r + (params.get('dev') ? ':' + params.get('dev').slice(0, 12) : '');
  let KEY = keyFor(room);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  // постоянный id телефона: по нему пульт узнаёт «свою» команду после перезагрузки/обрыва.
  // Нет хранилища — живём в памяти (после перезагрузки команду можно восстановить).
  // ?dev=имя — несколько «телефонов» в одном браузере (для теста): у каждого свой id
  const CID_KEY = 'svoyak:clientId' + (params.get('dev') ? ':' + params.get('dev').slice(0, 12) : '');
  let clientId = null;
  try { clientId = localStorage.getItem(CID_KEY); } catch (e) { /* ignore */ }
  if (!clientId) {
    clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem(CID_KEY, clientId); } catch (e) { /* ignore */ }
  }
  let myTeam = saved.teamId || null;
  // заявка «создать» тоже переживает перезагрузку телефона (пока пульт её не подтвердил)
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ teamId: myTeam, pending: myTeam ? null : pendingCreate })); } catch (e) { /* ignore */ } }

  let state = null;            // последнее состояние от пульта
  let netStatus = 'connecting';
  let pickedEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  let flash = null;            // { kind, until } — короткие локальные надписи
  let pressedQid = null;       // на какой вопрос этот телефон уже нажал (ждём ответа пульта)
  let triedQid = null;         // на какой вопрос жали вообще (для «НЕ УСПЕЛИ», даже если ответ пульта запоздал)
  let wonQid = null;           // чтобы праздновать один раз
  let joining = false;
  let pendingAvatar = null;    // аватар для новой команды (dataURL) или null = эмодзи
  let myAvatar = null;         // свой аватар, присланный пультом
  let myAvatarK = null;        // его «версия:команда» — в hello, чтобы пульт не слал ту же картинку заново
  let notice = '';             // сообщение на экране входа
  const ERR_TEXT = {
    name: 'Впиши название команды.',
    'name-taken': 'Такое название уже занято другой командой — придумай своё.',
    'name-free': 'Команда с таким названием уже есть и ждёт телефон — восстанови её ниже.',
    full: 'Команд уже 8 — больше не влезет. Если твоя команда без телефона — восстанови её ниже.',
    taken: 'Эту команду уже занял другой телефон. Одна команда — один телефон.',
    already: 'Этот телефон уже играет за другую команду.',
    'not-yours': 'Это не твоя команда: телефон может жать только за свою.',
    'not-bound': 'Телефон не привязан к команде — создай или восстанови.',
    'no-team': 'Такой команды больше нет.',
  };

  $('room-code').textContent = room || '—';
  // секрет комнаты (k) и брокер (b) приходят в QR-ссылке; без k телефон найдёт его по коду через «маяк» пульта
  let roomKey = params.get('k') || '';
  if (!roomKey) { try { roomKey = localStorage.getItem('svoyak:k:' + room) || ''; } catch (e) { /* ignore */ } }
  const brokerHint = params.has('b') ? parseInt(params.get('b'), 10) : 0;
  let netInfo = null;          // диагностика от транспорта
  let pendingCreate = saved.pending && saved.pending.t === 'create' && !saved.teamId ? saved.pending : null; // переотправляем, пока пульт не ответит joined
  let optimistic = pendingCreate ? { name: pendingCreate.name, emoji: pendingCreate.emoji, avatar: pendingCreate.avatar } : null; // команда, показанная сразу (до ответа пульта)
  let queuedBuzz = null;       // одно нажатие, сделанное до подтверждения
  let lastCreateSent = 0;
  let noHostSince = Date.now();
  let joiningAt = 0;
  let joinedRev = -1;
  let lastHello = 0;
  let createdAt = pendingCreate ? Date.now() : 0; // когда отправили заявку (для предупреждения «пульт не получил»)
  const BUZZ_WAIT_MS = 2000;   // нет ответа пульта на нажатие столько — кнопка снова активна
  let buzzWait = 0;            // таймер ожидания ответа на нажатие
  let skew = null;             // оценка «часы пульта − часы телефона», мс (по pong)
  let skewRtt = Infinity, skewAt = 0;
  const dbg = [];               // последние сообщения (для отладки: window.__buzzer)
  window.__buzzer = { dbg, get state() { return state; }, get myTeam() { return myTeam; }, get net() { return netStatus; } };

  /* ---------- экран не гаснет ---------- */
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* не поддерживается или запрещено — не страшно */ }
  }

  /* ---------- сеть ---------- */
  let client = null;
  function startNet() {
    if (!room) return;
    client = window.Net.createClient({
    room, clientId, key: roomKey, broker: brokerHint,
    onKey(k) { roomKey = k; try { localStorage.setItem('svoyak:k:' + room, k); } catch (e) { /* ignore */ } },
    // ведущий нажал «новая комната» — сеть уже переехала, обновляем код и адрес (QR со старым кодом тоже приведёт сюда)
    onMoved(r, k) {
      room = r; KEY = keyFor(room); save();
      $('room-code').textContent = room;
      try { const u = new URL(location.href); u.searchParams.set('room', room); u.searchParams.set('k', k); history.replaceState(null, '', u.toString()); } catch (e) { /* ignore */ }
    },
    onStatus(st, info) { // зовётся только при смене статуса
      netStatus = st;
      netInfo = info || null;
      if (st === 'online') {
        client.send({ t: 'hello', teamId: myTeam, avk: myAvatarK || undefined });
        if (pendingCreate && !myTeam) sendCreate();
      }
      render();
    },
    onMessage(m) {
      if (m.t === 'pong') { onPong(m); return; }
      if (dbg.length < 200) dbg.push([Date.now() % 100000, m.t, m.rev, m.teamId || '']);
      if (m.t === 'state') {
        if (state && typeof m.rev === 'number' && typeof state.rev === 'number' && m.rev < state.rev) return; // устаревший снимок
        if (!state || state.qid !== m.qid) $('big').classList.remove('down');
        // баззер снова открыт (кто-то ошибся или ведущий сбросил) — можно жать ещё раз
        if (state && state.winner && !m.winner) { pressedQid = null; triedQid = null; $('big').classList.remove('down'); }
        state = m;
        // команду удалили на пульте (только если снимок новее, чем наш «joined»)
        if (myTeam && !m.teams.some((t) => t.id === myTeam) && (typeof m.rev !== 'number' || m.rev > joinedRev)) { myTeam = null; save(); }
        const me = myTeam && m.qid && m.winner === myTeam;
        if (me && wonQid !== m.qid) celebrate(m.qid);
      } else if (m.t === 'joined') {
        if (typeof m.rev === 'number' && m.rev < joinedRev) return; // ответ на старый запрос
        joinedRev = typeof m.rev === 'number' ? m.rev : joinedRev;
        joining = false;
        if (m.teamId) {
          myTeam = m.teamId; save(); keepAwake(); notice = '';
          optimistic = null; pendingCreate = null;
          // нажали до подтверждения — отправляем, только если вопрос всё ещё открыт
          if (queuedBuzz && state && state.armed && state.qid === queuedBuzz.qid && !(state.wrong || []).includes(myTeam)) {
            sendBuzz(state.qid, queuedBuzz.at, false); // нажатие до подтверждения — без отсева по возрасту
          } else $('big').classList.remove('down');
          queuedBuzz = null;
        } else if (optimistic) {
          // пульт ещё не обработал нашу заявку (ответ на hello) — ждём, заявка переотправится
        } else {
          if (myTeam && m.reason === 'unbound') notice = 'Ведущий отвязал этот телефон от команды. Создай новую или восстанови свою.';
          myTeam = null; myAvatar = null; save();
        }
      } else if (m.t === 'myAvatar') {
        if (m.teamId === myTeam || !myTeam) { myAvatar = m.data || null; myAvatarK = (m.data ? (m.v || 1) : 0) + ':' + m.teamId; }
        avatarSig = '';
      } else if (m.t === 'err') {
        joining = false;
        if (ERR_TEXT[m.code]) notice = ERR_TEXT[m.code];
        if (optimistic && ['name', 'name-taken', 'name-free', 'full'].includes(m.code)) {
          optimistic = null; pendingCreate = null; queuedBuzz = null; save(); // назад на форму
        }
      } else if (m.t === 'buzzResult') {
        // ответ на нажатие по прошлому вопросу (пришёл поздно) — не трогаем текущую кнопку
        if (m.qid != null && state && m.qid !== state.qid) { render(); return; }
        clearTimeout(buzzWait);
        if (m.result === 'won') { if (state && wonQid !== state.qid) celebrate(state.qid); }
        else if (m.result === 'early') setFlash('early', 1300);
        else if (m.result === 'test') { setFlash('test', 1500); vibrate(60); window.Sfx.play('pop'); }
        else if (m.result === 'late') { vibrate([40, 40, 40]); }
        else if (m.result === 'stale') { if (pressedQid === m.qid || m.qid == null) pressedQid = null; } // нажатие застряло в сети — можно жать снова
        $('big').classList.remove('down');
      }
      render();
    },
  });
  }

  function celebrate(qid) {
    wonQid = qid;
    vibrate([220, 80, 220]);
    window.Sfx.play('buzz');
    document.body.classList.remove('flash-won'); void document.body.offsetWidth; document.body.classList.add('flash-won');
  }
  function setFlash(kind, ms) { flash = { kind, until: Date.now() + ms }; }

  /** Разница часов с пультом: берём замер с самым коротким путём туда-обратно (свежие важнее). */
  function onPong(m) {
    if (typeof m.now !== 'number' || typeof m.ts !== 'number') return;
    const rtt = Date.now() - m.ts;
    if (rtt < 0 || rtt > 3000) return;
    // старый замер забываем через 30 с: часы телефона могли подвести
    if (rtt <= skewRtt || Date.now() - skewAt > 30000) { skew = m.now - (m.ts + rtt / 2); skewRtt = rtt; skewAt = Date.now(); }
  }

  /** Отправить нажатие. Нет ответа пульта BUZZ_WAIT_MS — кнопка снова активна (пульт сам отсечёт дубль). */
  function sendBuzz(qid, at, withAge) {
    const btn = $('big');
    pressedQid = qid; triedQid = qid;
    btn.classList.add('down');
    const msg = { t: 'buzz', teamId: myTeam, qid, clientTs: at };
    if (withAge && skew != null) msg.hostTs = Math.round(at + skew); // пульт не засчитает нажатие, застрявшее в сети
    client.send(msg);
    clearTimeout(buzzWait);
    buzzWait = setTimeout(() => {
      if (pressedQid === qid && btn.classList.contains('down')) { pressedQid = null; btn.classList.remove('down'); render(); }
    }, BUZZ_WAIT_MS);
  }
  let shakeT = 0;
  function shake() {
    const btn = $('big');
    btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
    clearTimeout(shakeT);
    shakeT = setTimeout(() => btn.classList.remove('shake'), 600); // иначе shake перебивал pulse/won до конца игры
  }
  $('big').addEventListener('animationend', (e) => { if (e.animationName === 'shake') $('big').classList.remove('shake'); });

  /* ---------- нажатие ---------- */
  function press(e) {
    if (e) e.preventDefault();
    window.Sfx.unlock();
    keepAwake();
    const btn = $('big');
    if (!myTeam && optimistic) {
      // ещё синхронизируемся: копим максимум одно нажатие
      if (state && state.armed && !queuedBuzz) { queuedBuzz = { qid: state.qid, at: Date.now() }; btn.classList.add('down'); vibrate(30); return; }
      if (state && state.phase === 'question' && state.stage === 'question') return;
      setFlash('early', 1300); vibrate(120); render(); return;
    }
    // сервер связи есть, а пульт «моргнул» (no-host) — всё равно шлём: пульт, скорее всего, жив
    const linked = netStatus === 'online' || netStatus === 'no-host';
    if (!state || !linked || !myTeam) { shake(); return; }
    const s = state;
    if (s.phase === 'setup') { client.send({ t: 'buzz', teamId: myTeam, qid: null, clientTs: Date.now() }); return; }
    const open = s.phase === 'question' && s.stage === 'question';
    if (s.armed && !s.wrong.includes(myTeam)) {
      if (pressedQid === s.qid && btn.classList.contains('down')) return; // уже нажали, ждём ответа пульта
      vibrate(30);
      sendBuzz(s.qid, Date.now(), true);
      return;
    }
    if (!open || (!s.winner && !s.wrong.includes(myTeam))) {
      setFlash('early', 1300); vibrate(120);
    }
    shake();
    render();
  }
  $('big').addEventListener('pointerdown', press);
  $('big').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') press(e); });

  /* ---------- вход ---------- */
  $('emojis').innerHTML = EMOJIS.map((e) => `<button type="button" data-e="${e}" class="${e === pickedEmoji ? 'on' : ''}">${e}</button>`).join('');
  $('emojis').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-e]');
    if (!b) return;
    pickedEmoji = b.dataset.e;
    pendingAvatar = null;
    document.querySelectorAll('#emojis button').forEach((x) => x.classList.toggle('on', x === b));
    renderPreview();
  });

  /* ---------- аватар: эмодзи / нарисовать / загрузить ---------- */
  const avHtml = (url, emoji) => (url ? `<img src="${url}" alt="">` : esc(emoji || '⭐'));
  function renderPreview() { $('av-preview').innerHTML = avHtml(pendingAvatar, pickedEmoji); }
  const myColor = () => { const t = state && myTeam && state.teams.find((x) => x.id === myTeam); return t ? t.color : '#C6FF00'; };
  function editAvatar(mode, done) {
    const opts = { color: myColor(), onDone: done, onCancel: () => {} };
    if (mode === 'draw') window.AvatarEditor.draw(opts); else window.AvatarEditor.upload(opts);
  }
  document.querySelector('.av-modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    editAvatar(b.dataset.mode, (url) => { pendingAvatar = url; renderPreview(); });
  });
  renderPreview();

  // меню команды (тап по плашке): сменить аватар
  $('menu-emojis').innerHTML = EMOJIS.map((e) => `<button type="button" data-e="${e}">${e}</button>`).join('');
  let avatarSig = '';
  function renderMenu() {
    const t = state && myTeam && state.teams.find((x) => x.id === myTeam);
    // пока синхронизируемся — показываем то, что выбрали при создании (а не пустой квадрат)
    if (!t && !optimistic) return;
    $('menu-preview').style.setProperty('--tc', t ? t.color : '#C6FF00');
    $('menu-preview').innerHTML = t ? avHtml(t.av ? myAvatar : null, t.emoji) : avHtml(optimistic.avatar, optimistic.emoji);
  }
  $('me-chip').addEventListener('click', () => { $('menu').hidden = false; renderMenu(); });
  $('menu').addEventListener('click', (e) => {
    if (e.target === $('menu')) { $('menu').hidden = true; return; }
    const em = e.target.closest('#menu-emojis [data-e]');
    if (em) { client && client.send({ t: 'avatar', avatar: null, emoji: em.dataset.e }); return; }
    const b = e.target.closest('[data-menu]');
    if (!b) return;
    if (b.dataset.menu === 'close') $('menu').hidden = true;
    else editAvatar(b.dataset.menu, (url) => { client && client.send({ t: 'avatar', avatar: url }); myAvatar = url; avatarSig = ''; renderMenu(); });
  });
  function createTeam() {
    window.Sfx.unlock();
    const name = $('team-name').value.trim();
    if (!name) { $('team-name').focus(); setFlash('name', 2000); render(); return; }
    // подтверждения ведущего не ждём: сразу показываем свою кнопку, заявка уходит в фоне
    pendingCreate = { t: 'create', name, emoji: pickedEmoji, avatar: pendingAvatar };
    optimistic = { name, emoji: pickedEmoji, avatar: pendingAvatar };
    createdAt = Date.now();
    notice = '';
    save();
    keepAwake();
    sendCreate();
    render();
  }
  /** Отправить (или повторить) заявку. Пульт узнаёт повтор по clientId и просто отвечает joined. */
  function sendCreate() {
    if (!pendingCreate || !client) return;
    lastCreateSent = Date.now();
    client.send(pendingCreate);
  }
  $('team-name').addEventListener('input', () => render());
  $('create').addEventListener('click', createTeam);
  $('team-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createTeam(); });
  $('teams').addEventListener('click', (e) => {
    const b = e.target.closest('[data-team]');
    if (!b) return;
    window.Sfx.unlock();
    if (client && client.send({ t: 'claim', teamId: b.dataset.team })) { joining = true; render(); }
  });

  /* ---------- отрисовка ---------- */
  const NET_TEXT = { connecting: 'ищем сервер связи…', online: 'на связи', offline: 'нет сети', 'no-host': 'ведущий не найден', unavailable: 'библиотека связи не загрузилась' };
  let diagSig = '';
  const HOST_HINT = $('host-hint').textContent;
  let hintOpened = false, roomFormHint = false;
  function renderDiag() {
    const inf = (client && client.info) ? client.info() : (netInfo || {});
    const server = netStatus === 'online' || netStatus === 'no-host';
    const hostOk = netStatus === 'online';
    const bro = (inf.brokers || []).map((b) => (b.state === 'ok' ? '🟢' : b.state === 'connecting' ? '🟡' : '🔴') + b.name).join(' ');
    const html = `<span>${server ? '✅' : '⏳'} сервер связи: ${server ? 'подключено' + (inf.broker ? ' (' + inf.broker + ')' : '') : 'нет'}</span>`
      + `<span>${hostOk ? '✅' : '⏳'} ведущий: ${hostOk ? 'найден' + (inf.via ? ' через ' + inf.via : '') : 'не найден' + (server && inf.waitSec ? ' · ждём ' + inf.waitSec + ' с' : '')}</span>`
      + (hostOk ? '' : `<span class="diag-more">${bro}${inf.key ? ' · ключ ' + inf.key : ''} <button type="button" id="net-retry">🔄 переподключиться</button></span>`);
    if (html !== diagSig) { diagSig = html; $('diag').innerHTML = html; }
    $('diag').classList.toggle('ok', hostOk);
    const longNoHost = !hostOk && noHostSince && Date.now() - noHostSince > 20000;
    $('host-hint').hidden = !longNoHost;
    // пульта нет 30+ с при живом сервере связи — может, ведущий сменил комнату: подсказываем пересканировать QR
    const veryLong = longNoHost && server && Date.now() - noHostSince > 30000;
    const hint = veryLong
      ? 'Пульт не отвечает уже ' + Math.round((Date.now() - noHostSince) / 1000) + ' с. Если ведущий сменил комнату — отсканируй QR на экране гостей заново' + ($('join').hidden ? '.' : ' или введи код комнаты выше.') + ' Команда и баллы не пропадут.'
      : HOST_HINT;
    if ($('host-hint').textContent !== hint) $('host-hint').textContent = hint;
    if (veryLong && !hintOpened) { hintOpened = true; $('netbox').open = true; }
    if (hostOk) hintOpened = false;
    roomFormHint = veryLong;
    const sum = $('netbox').querySelector('summary');
    const want = hostOk ? 'ⓘ связь' : longNoHost ? 'ⓘ связь — пульт не отвечает' : 'ⓘ связь — подключаемся';
    if (sum.textContent !== want) sum.textContent = want;
  }
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'net-retry' && client) { (client.reconnectAll || client.reconnect)(); diagSig = ''; }
  });
  let teamsSig = '';

  function render() {
    const net = $('net');
    // в шапке — только комната и точка: зелёная (на связи) / жёлтая (подключаемся)
    net.className = 'net ' + (netStatus === 'online' ? 'online' : '');
    net.title = NET_TEXT[netStatus] || netStatus;
    if (netStatus === 'online') noHostSince = 0; else if (!noHostSince) noHostSince = Date.now();
    if (pendingCreate && !myTeam && netStatus === 'online' && Date.now() - lastCreateSent > 3000) sendCreate();
    if (flash && Date.now() > flash.until) flash = null;
    // ведущий не ответил на заявку — не оставляем кнопку висеть
    if (joining && !joiningAt) joiningAt = Date.now();
    if (!joining) joiningAt = 0;
    if (joining && Date.now() - joiningAt > 9000) {
      joining = false; joiningAt = 0; notice = 'Пульт пока не ответил — попробуй ещё раз.';
      if (client) client.send({ t: 'hello' }); // вдруг команда уже создана, а ответ потерялся — пульт напомнит
    }
    // на экране входа периодически «здороваемся»: пульт вернёт нашу команду, если она есть
    if (!myTeam && netStatus === 'online' && client && Date.now() - lastHello > 6000) { lastHello = Date.now(); client.send({ t: 'hello' }); }
    renderDiag();
    $('no-room').hidden = !!room && !roomFormHint;

    let team = state && myTeam && state.teams.find((t) => t.id === myTeam);
    if (!team && optimistic) {
      // до ответа пульта — локальная «заглушка»: своё название, эмодзи/аватар, цвет по умолчанию
      team = { id: null, name: optimistic.name, emoji: optimistic.emoji, color: '#C6FF00', score: 0, av: optimistic.avatar ? 1 : 0, optimistic: true };
    }
    $('sync').hidden = !(team && team.optimistic);
    const showJoin = !team;
    $('join').hidden = !showJoin;
    $('buzz').hidden = showJoin;
    if (showJoin) renderJoin(); else renderBuzz(team);
  }

  function renderJoin() {
    // «восстановить команду» — только если у пульта есть команды без телефона
    const free = state ? state.teams.filter((t) => t.free) : [];
    $('restore-card').hidden = !free.length;
    const sig = JSON.stringify(free.map((t) => [t.id, t.name, t.emoji, t.color, t.score]));
    if (sig !== teamsSig) {
      teamsSig = sig;
      $('teams').innerHTML = free.map((t) => `<button class="btn team-btn" data-team="${t.id}" style="--tc:${t.color};--tx:${textOn(t.color)}"><span class="e">${esc(t.emoji)}</span><span class="n">${esc(t.name)}</span><span class="s">${t.score}</span></button>`).join('');
    }
    const msg = !room ? 'Нет кода комнаты — отсканируй QR на экране ещё раз.' : notice;
    $('join-msg').hidden = !msg;
    $('join-msg').textContent = msg;
    const c = $('create');
    c.disabled = joining || !$('team-name').value.trim();
    c.textContent = joining ? 'ПОДКЛЮЧАЕМ…'
      : flash && flash.kind === 'name' ? 'ВПИШИ НАЗВАНИЕ'
        : flash && flash.kind === 'offline' ? 'НЕТ СВЯЗИ С ВЕДУЩИМ'
          : 'СОЗДАТЬ И ИГРАТЬ →';
  }

  function renderBuzz(team) {
    // состояния от пульта ещё нет (только что создали команду) — рисуем спокойное «ждём»
    const s = state || { phase: 'setup', teams: [], wrong: [], armed: false };
    const btn = $('big');
    btn.style.setProperty('--tc', team.color);
    btn.style.setProperty('--tx', textOn(team.color));
    const sig = [team.id, team.emoji, team.name, team.av, myAvatar ? myAvatar.length : 0].join('|');
    if (sig !== avatarSig) {
      avatarSig = sig;
      $('me-chip').innerHTML = `<span class="av" style="background:${team.color}">${avHtml(team.av ? (team.optimistic ? optimistic.avatar : myAvatar) : null, team.emoji)}</span><span class="n">${esc(team.name)}</span><span>⚙︎</span>`;
      if (!$('menu').hidden) renderMenu();
    }
    $('score').textContent = team.score;

    const tName = (id) => { const t = s.teams.find((x) => x.id === id); return t ? t.name : '…'; };
    let lbl = 'ЖДЁМ', sub = '', cls = 'idle', status = '';
    const q = s.phase === 'question';
    // заявка на команду без ответа пульта 12+ с — честно говорим, что ведущий её не получил (N9)
    const unconfirmed = team.optimistic && createdAt && Date.now() - createdAt > 12000;
    if (unconfirmed) {
      lbl = 'ЖДЁМ ПУЛЬТ'; cls = 'idle';
      sub = netStatus === 'online' ? 'ведущий пока не подтвердил команду' : 'пульт не отвечает — команда ещё не создана';
      status = 'проверь связь внизу ↓';
    }
    else if (!state) { lbl = 'ГОТОВО'; sub = team.optimistic ? 'отправили команду ведущему…' : 'команда создана — ждём начала игры'; cls = ''; status = 'вы в игре'; }
    else if (flash && flash.kind === 'early') { lbl = 'РАНО!'; sub = 'вопрос ещё не открыт'; cls = 'blocked'; }
    else if (flash && flash.kind === 'test') { lbl = 'НА СВЯЗИ'; sub = 'кнопка работает ✓'; cls = ''; }
    else if (s.phase === 'setup') { lbl = 'ТЕСТ'; sub = 'жми — проверим связь'; cls = ''; status = 'игра скоро начнётся'; }
    else if (q && s.stage === 'question' && s.special) {
      lbl = 'ЖДЁМ'; cls = 'idle';
      sub = s.owner === myTeam ? 'этот вопрос ваш — отвечайте!' : 'вопрос для одной команды';
      status = s.special === 'cat' ? 'кот в мешке' : 'аукцион';
    }
    else if (q && s.stage === 'question') {
      if (s.winner === myTeam) { lbl = 'ПЕРВЫЕ!'; sub = 'отвечайте!'; cls = 'won'; status = 'ваш ответ'; }
      else if (s.wrong.includes(myTeam)) { lbl = 'МИМО'; sub = 'вы уже ошиблись на этом вопросе'; cls = 'blocked'; status = 'ждём других'; }
      else if (s.winner) { lbl = pressedQid === s.qid || triedQid === s.qid ? 'НЕ УСПЕЛИ' : 'СТОП'; sub = 'отвечает ' + tName(s.winner); cls = 'blocked'; }
      else if (pressedQid === s.qid && btn.classList.contains('down')) { lbl = '…'; sub = 'ловим'; cls = ''; }
      else { lbl = 'ЖМИ!'; sub = 'если знаешь'; cls = 'armed'; status = 'вопрос открыт'; }
    }
    else if (q && s.stage === 'intro') { lbl = 'ЖДЁМ'; sub = s.special === 'cat' ? 'кот в мешке!' : 'аукцион!'; }
    else if (q && s.stage === 'answer') { lbl = 'ЖДЁМ'; sub = 'ответ на экране'; }
    else if (s.phase === 'board') { lbl = 'ЖДЁМ ВОПРОС'; sub = 'выбирают ячейку'; }
    else if (s.phase === 'final') { lbl = 'ФИНАЛ'; sub = 'пишите ответ на бумажке'; }
    else if (s.phase === 'winner') {
      // место = 1 + сколько команд набрали строго больше (при равенстве — общее место)
      const me = s.teams.find((t) => t.id === myTeam);
      const place = me ? 1 + s.teams.filter((t) => t.score > me.score).length : s.teams.length;
      const tie = me && s.teams.some((t) => t.id !== me.id && t.score === me.score);
      lbl = place === 1 ? (tie ? 'НИЧЬЯ!' : 'ПОБЕДА!') : `#${place}`;
      sub = place === 1 ? (tie ? 'делите корону' : 'корона ваша') : 'gg, было мощно';
      cls = place === 1 ? 'won' : 'idle';
    }
    if (!status) status = `${s.teams.length} ${s.teams.length === 1 ? 'команда' : 'команд'} в игре`;

    $('lbl').textContent = lbl;
    $('sub').textContent = sub;
    btn.classList.remove('idle', 'armed', 'won', 'blocked');
    if (cls) btn.classList.add(cls);
    $('status').textContent = status;
  }

  // ручной ввод кода комнаты (если открыли buzzer.html без QR)
  $('room-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('room-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!code) return;
    const u = new URL(location.href);
    u.searchParams.set('room', code);
    u.searchParams.delete('k');
    location.href = u.toString();
  });

  setInterval(render, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); if (client) client.reconnect(); }
  });
  window.addEventListener('pagehide', (e) => { if (!e.persisted && client) client.send({ t: 'leave' }); });
  render();
  startNet();
})();
