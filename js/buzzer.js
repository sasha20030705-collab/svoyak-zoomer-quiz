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
  const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const KEY = 'svoyak:buzzer:' + room + (params.get('dev') ? ':' + params.get('dev').slice(0, 12) : '');
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
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ teamId: myTeam })); } catch (e) { /* ignore */ } }
  save();

  let state = null;            // последнее состояние от пульта
  let netStatus = 'connecting';
  let pickedEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  let flash = null;            // { kind, until } — короткие локальные надписи
  let pressedQid = null;       // на какой вопрос этот телефон уже нажал
  let wonQid = null;           // чтобы праздновать один раз
  let joining = false;
  let pendingAvatar = null;    // аватар для новой команды (dataURL) или null = эмодзи
  let myAvatar = null;         // свой аватар, присланный пультом
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
    room, clientId,
    onStatus(st) {
      netStatus = st;
      if (st === 'online') client.send({ t: 'hello', teamId: myTeam });
      render();
    },
    onMessage(m) {
      if (m.t === 'state') {
        if (!state || state.qid !== m.qid) $('big').classList.remove('down');
        // баззер снова открыт (кто-то ошибся или ведущий сбросил) — можно жать ещё раз
        if (state && state.winner && !m.winner) { pressedQid = null; $('big').classList.remove('down'); }
        state = m;
        if (myTeam && !m.teams.some((t) => t.id === myTeam)) { myTeam = null; save(); } // команду удалили
        const me = myTeam && m.qid && m.winner === myTeam;
        if (me && wonQid !== m.qid) celebrate(m.qid);
      } else if (m.t === 'joined') {
        joining = false;
        if (m.teamId) { myTeam = m.teamId; save(); keepAwake(); notice = ''; }
        else {
          if (myTeam && m.reason === 'unbound') notice = 'Ведущий отвязал этот телефон от команды. Создай новую или восстанови свою.';
          myTeam = null; myAvatar = null; save();
        }
      } else if (m.t === 'myAvatar') {
        if (m.teamId === myTeam || !myTeam) myAvatar = m.data || null;
        avatarSig = '';
      } else if (m.t === 'err') {
        joining = false;
        if (ERR_TEXT[m.code]) notice = ERR_TEXT[m.code];
      } else if (m.t === 'buzzResult') {
        if (m.result === 'won') { if (state && wonQid !== state.qid) celebrate(state.qid); }
        else if (m.result === 'early') setFlash('early', 1300);
        else if (m.result === 'test') { setFlash('test', 1500); vibrate(60); window.Sfx.play('pop'); }
        else if (m.result === 'late') { vibrate([40, 40, 40]); }
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

  /* ---------- нажатие ---------- */
  function press(e) {
    if (e) e.preventDefault();
    window.Sfx.unlock();
    keepAwake();
    const btn = $('big');
    if (!state || netStatus !== 'online' || !myTeam) { btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake'); return; }
    const s = state;
    if (s.phase === 'setup') { client.send({ t: 'buzz', teamId: myTeam, clientTs: Date.now() }); return; }
    const open = s.phase === 'question' && s.stage === 'question';
    if (s.armed && !s.wrong.includes(myTeam)) {
      if (pressedQid === s.qid) return; // уже нажали, ждём ответа пульта
      pressedQid = s.qid;
      btn.classList.add('down');
      vibrate(30);
      client.send({ t: 'buzz', teamId: myTeam, clientTs: Date.now() });
      return;
    }
    if (!open || (!s.winner && !s.wrong.includes(myTeam))) {
      setFlash('early', 1300); vibrate(120);
    }
    btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
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
    if (!t) return;
    $('menu-preview').style.setProperty('--tc', t.color);
    $('menu-preview').innerHTML = avHtml(t.av ? myAvatar : null, t.emoji);
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
    if (!client || !client.send({ t: 'create', name, emoji: pickedEmoji, avatar: pendingAvatar })) { setFlash('offline', 2000); render(); return; }
    joining = true;
    render();
  }
  $('create').addEventListener('click', createTeam);
  $('team-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createTeam(); });
  $('teams').addEventListener('click', (e) => {
    const b = e.target.closest('[data-team]');
    if (!b) return;
    window.Sfx.unlock();
    if (client && client.send({ t: 'claim', teamId: b.dataset.team })) { joining = true; render(); }
  });

  /* ---------- отрисовка ---------- */
  const NET_TEXT = { connecting: 'подключаемся…', online: 'на связи', offline: 'нет сети', 'no-host': 'ищем ведущего…', unavailable: 'сеть недоступна' };
  let teamsSig = '';

  function render() {
    const net = $('net');
    net.className = 'net ' + (netStatus === 'online' ? 'online' : (netStatus === 'connecting' ? '' : 'bad'));
    net.querySelector('span').textContent = NET_TEXT[netStatus] || netStatus;
    if (flash && Date.now() > flash.until) flash = null;

    const team = state && myTeam && state.teams.find((t) => t.id === myTeam);
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
    c.disabled = joining || netStatus !== 'online';
    c.textContent = joining ? 'ПОДКЛЮЧАЕМ…'
      : flash && flash.kind === 'name' ? 'ВПИШИ НАЗВАНИЕ'
        : flash && flash.kind === 'offline' ? 'НЕТ СВЯЗИ С ВЕДУЩИМ'
          : 'СОЗДАТЬ И ИГРАТЬ →';
  }

  function renderBuzz(team) {
    const s = state;
    const btn = $('big');
    btn.style.setProperty('--tc', team.color);
    btn.style.setProperty('--tx', textOn(team.color));
    const sig = [team.id, team.emoji, team.name, team.av, myAvatar ? myAvatar.length : 0].join('|');
    if (sig !== avatarSig) {
      avatarSig = sig;
      $('me-chip').innerHTML = `<span class="av" style="background:${team.color}">${avHtml(team.av ? myAvatar : null, team.emoji)}</span><span class="n">${esc(team.name)}</span><span>⚙︎</span>`;
      if (!$('menu').hidden) renderMenu();
    }
    $('score').textContent = team.score;

    const tName = (id) => { const t = s.teams.find((x) => x.id === id); return t ? t.name : '…'; };
    let lbl = 'ЖДЁМ', sub = '', cls = 'idle', status = '';
    const q = s.phase === 'question';
    if (netStatus !== 'online') { lbl = 'НЕТ СВЯЗИ'; sub = 'переподключаемся…'; cls = 'blocked'; }
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
      else if (s.winner) { lbl = pressedQid === s.qid ? 'НЕ УСПЕЛИ' : 'СТОП'; sub = 'отвечает ' + tName(s.winner); cls = 'blocked'; }
      else if (pressedQid === s.qid && btn.classList.contains('down')) { lbl = '…'; sub = 'ловим'; cls = ''; }
      else { lbl = 'ЖМИ!'; sub = 'если знаешь'; cls = 'armed'; status = 'вопрос открыт'; }
    }
    else if (q && s.stage === 'intro') { lbl = 'ЖДЁМ'; sub = s.special === 'cat' ? 'кот в мешке!' : 'аукцион!'; }
    else if (q && s.stage === 'answer') { lbl = 'ЖДЁМ'; sub = 'ответ на экране'; }
    else if (s.phase === 'board') { lbl = 'ЖДЁМ ВОПРОС'; sub = 'выбирают ячейку'; }
    else if (s.phase === 'final') { lbl = 'ФИНАЛ'; sub = 'пишите ответ на бумажке'; }
    else if (s.phase === 'winner') {
      const place = s.teams.slice().sort((a, b) => b.score - a.score).findIndex((t) => t.id === myTeam) + 1;
      lbl = place === 1 ? 'ПОБЕДА!' : `#${place}`; sub = place === 1 ? 'корона ваша' : 'gg, было мощно';
    }
    if (!status) status = `${s.teams.length} ${s.teams.length === 1 ? 'команда' : 'команд'} в игре`;

    $('lbl').textContent = lbl;
    $('sub').textContent = sub;
    btn.classList.remove('idle', 'armed', 'won', 'blocked');
    if (cls) btn.classList.add(cls);
    $('status').textContent = status;
  }

  setInterval(render, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); if (client) client.reconnect(); }
  });
  window.addEventListener('pagehide', (e) => { if (!e.persisted && client) client.send({ t: 'leave' }); });
  render();
  startNet();
})();
