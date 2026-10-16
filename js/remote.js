/* ==========================================================================
   Телефоны-баззеры, сторона пульта. Пульт — единственный источник правды:
   - принимает join/buzz от телефонов и превращает их в действия Store;
   - рассылает телефонам компактное состояние при каждом изменении;
   - публикует в Store статус сети и число подключённых устройств (для экрана).
   Сеть поднимает только одна вкладка пульта: замок в localStorage с heartbeat
   (2 с) и TTL (5 с) — замок закрытой вкладки протухает сам. Есть «забрать сеть сюда».
   ========================================================================== */
(function () {
  'use strict';
  const S = window.Store;
  const U = window.QuizUtil;

  const LOCK_KEY = 'svoyak:host-lock';
  const TAB_ID = Math.random().toString(36).slice(2);
  const DEVICE_TTL = 15000;      // телефон молчит дольше — считаем отключённым
  const KEEPALIVE_MS = 5000;
  const LOCK_BEAT_MS = 2000;     // вкладка-владелец обновляет замок
  const LOCK_TTL_MS = 5000;      // замок без обновлений дольше — считается брошенным
  const ID_RETRIES = 8;          // сколько раз ждём освобождения peer id перед сменой комнаты
  const BUZZ_MAX_AGE_MS = 5000;  // нажатие, застрявшее в сети дольше (по часам пульта), не засчитываем

  let host = null, room = null, roomKey = null, status = 'off', statusInfo = '', best = -1;
  let diag = {}, lastIn = null;  // диагностика для пульта
  let idTaken = 0;
  let lastSent = '';
  const devices = new Map();     // clientId → { teamId, lastSeen }
  const listeners = new Set();

  /* ---------- замок «сеть ведёт эта вкладка» ---------- */
  function readLock() { try { return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch (e) { return null; } }
  function writeLock() { try { localStorage.setItem(LOCK_KEY, JSON.stringify({ tab: TAB_ID, at: Date.now() })); } catch (e) { /* ignore */ } }
  function haveLock() {
    const l = readLock();
    if (!l || l.tab === TAB_ID || Date.now() - l.at > LOCK_TTL_MS) { writeLock(); return true; }
    return false;
  }
  // вкладку закрыли — сразу говорим телефонам «ведущий ушёл» (не ждём таймаута брокера)
  window.addEventListener('pagehide', () => { if (host) try { host.close(); } catch (e) { /* ignore */ } });
  window.addEventListener('pagehide', () => { const l = readLock(); if (l && l.tab === TAB_ID) try { localStorage.removeItem(LOCK_KEY); } catch (e) { /* ignore */ } });

  /* ---------- компактное состояние для телефонов ---------- */
  function compact(s) {
    const cur = s.phase === 'question' ? s.current : null;
    return {
      t: 'state',
      rev: s.rev,          // телефон отбрасывает устаревшие снимки (сообщения могут прийти не по порядку)
      room: s.room,
      title: (S.quiz() && S.quiz().title) || 'Своя игра',
      phase: s.phase,
      qid: cur ? cur.key : (s.phase === 'final' ? 'final' : null),
      stage: cur ? cur.stage : (s.phase === 'final' ? s.final.stage : null),
      special: cur ? cur.special : null,
      owner: cur ? cur.owner : null,
      armed: !!(cur && cur.stage === 'question' && !cur.special && !s.buzzer.winner),
      winner: s.phase === 'question' ? s.buzzer.winner : null,
      wrong: cur ? cur.wrong : [],
      // free — у команды нет телефона: её можно «восстановить» с нового устройства
      // аватары не таскаем в каждой рассылке: только номер версии (av), саму картинку — отдельно своему телефону
      teams: s.teams.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, color: t.color, score: t.score, free: !t.device, av: t.avatar ? (t.avatarV || 1) : 0 })),
    };
  }

  /** Свой аватар — только своему телефону и только когда версия поменялась. */
  const sentAvatar = new Map(); // clientId → версия
  function pushAvatars(force) {
    if (!host) return;
    S.get().teams.forEach((t) => {
      if (!t.device) return;
      const v = (t.avatar ? t.avatarV || 1 : 0) + ':' + t.id;
      if (!force && sentAvatar.get(t.device) === v) return;
      sentAvatar.set(t.device, v);
      host.send(t.device, { t: 'myAvatar', teamId: t.id, v: t.avatarV || 0, data: t.avatar || null });
    });
  }
  const validAvatar = (a) => typeof a === 'string' && /^data:image\/(webp|jpeg|png);base64,/.test(a) && a.length <= 60000;

  function pushState(force) {
    if (!host) return;
    pushAvatars(false);
    const msg = compact(S.get());
    const str = JSON.stringify(msg);
    if (!force && str === lastSent) return;
    lastSent = str;
    host.broadcast(msg);
  }

  /* ---------- учёт устройств ---------- */
  const boundTeam = (clientId) => S.get().teams.find((t) => t.device === clientId);

  function publishNet() {
    const s = S.get();
    const online = [];
    let unbound = 0;
    devices.forEach((d, id) => { const t = boundTeam(id); if (t) online.push(t.id); else unbound++; });
    online.sort();
    const net = { status, devices: devices.size, online, unbound, transport: window.Net ? window.Net.transport : '', info: statusInfo, best };
    const cur = s.net || {};
    const pick = (o) => JSON.stringify([o.status, o.devices, o.online, o.unbound, o.transport, o.info, o.best]);
    if (pick(net) !== pick(cur)) S.dispatch({ type: 'netInfo', net });
    listeners.forEach((fn) => fn());
  }
  function prune() {
    const now = Date.now();
    let changed = false;
    screens.forEach((sc, id) => { if (now - sc.lastSeen > DEVICE_TTL) { screens.delete(id); listeners.forEach((fn) => fn()); } });
    devices.forEach((d, id) => { if (now - d.lastSeen > DEVICE_TTL) { devices.delete(id); changed = true; } });
    if (changed) publishNet();
  }
  function touch(clientId) {
    const d = devices.get(clientId);
    if (d) { d.lastSeen = Date.now(); return d; }
    const nd = { lastSeen: Date.now() };
    devices.set(clientId, nd);
    publishNet();
    return nd;
  }

  /* ---------- сообщения от телефонов ---------- */
  // Правило: 1 телефон = 1 команда. Команда привязана к clientId телефона (team.device в Store).
  const team = (id) => S.get().teams.find((t) => t.id === id);
  const reply = (clientId, msg) => host && host.send(clientId, msg);
  const joined = (clientId, t) => reply(clientId, { t: 'joined', teamId: t ? t.id : null, rev: S.get().rev });

  /* ---------- экраны гостей на других устройствах ---------- */
  const screens = new Map();     // clientId → { lastSeen, avatars: Map(teamId → версия) }
  /** Полное состояние для экрана: без истории undo и без картинок аватаров (они отдельно). */
  function fullState(s) {
    const c = Object.assign({}, s);
    c.history = [];
    c.teams = s.teams.map((t) => Object.assign({}, t, { avatar: null, device: t.device ? 1 : null }));
    return { t: 'full', now: Date.now(), s: c };
  }
  let lastFull = '';
  function pushScreens(force) {
    if (!host || !screens.size) return;
    const msg = fullState(S.get());
    const sig = JSON.stringify(msg.s);
    if (!force && sig === lastFull) return;
    lastFull = sig;
    screens.forEach((sc, cid) => { host.send(cid, msg); pushScreenAvatars(cid, sc, false); });
  }
  function pushScreenAvatars(cid, sc, force) {
    S.get().teams.forEach((t) => {
      const v = t.avatar ? (t.avatarV || 1) : 0;
      if (!force && sc.avatars.get(t.id) === v) return;
      sc.avatars.set(t.id, v);
      host.send(cid, { t: 'avatar', teamId: t.id, v, data: t.avatar || null });
    });
  }
  /** Нажатие относится к открытому сейчас вопросу? (qid есть только у новых телефонов/экранов) */
  function buzzLive(s, qid) {
    if (s.phase === 'setup') return qid == null;
    const cur = s.current;
    return s.phase === 'question' && !!cur && cur.key === qid && cur.stage === 'question';
  }
  function onScreen(cid, msg) {
    let sc = screens.get(cid);
    if (!sc) { sc = { lastSeen: Date.now(), avatars: new Map() }; screens.set(cid, sc); listeners.forEach((fn) => fn()); }
    sc.lastSeen = Date.now();
    if (msg.t === 'hello') {
      host.send(cid, fullState(S.get()));
      // экран может сказать, какие аватары у него уже есть ({teamId: версия}) — шлём только недостающие
      if (msg.avs && typeof msg.avs === 'object') {
        sc.avatars = new Map(Object.keys(msg.avs).map((id) => [id, Number(msg.avs[id]) || 0]));
        pushScreenAvatars(cid, sc, false);
      } else pushScreenAvatars(cid, sc, true);
    }
    else if (msg.t === 'kbBuzz') { // клавиатурный баззер удалённого экрана
      // qid — ключ вопроса на экране в момент нажатия; без qid — старый экран, принимаем как раньше
      if ('qid' in msg && !buzzLive(S.get(), msg.qid)) return;
      S.dispatch({ type: 'buzz', teamId: msg.teamId });
    }
    else if (msg.t === 'ping') host.send(cid, { t: 'pong', now: Date.now(), ts: msg.ts });
    else if (msg.t === 'leave') { screens.delete(cid); listeners.forEach((fn) => fn()); }
  }

  function onMessage(clientId, msg) {
    lastIn = { t: msg.t, cid: clientId, at: Date.now(), role: msg.role || (screens.has(clientId) ? 'screen' : 'phone') };
    // экраны гостей шлют clientId с префиксом scr — их не считаем телефонами
    if (msg.role === 'screen' || screens.has(clientId) || /^scr/.test(clientId)) {
      if (devices.delete(clientId)) publishNet();
      onScreen(clientId, msg);
      return;
    }
    touch(clientId);
    switch (msg.t) {
      case 'hello': { // телефон (пере)подключился — возвращаем его в свою команду
        reply(clientId, compact(S.get()));
        joined(clientId, boundTeam(clientId));
        // avk — какой аватар у телефона уже есть («версия:команда»): не гоняем 50 КБ зря
        if (typeof msg.avk === 'string') sentAvatar.set(clientId, msg.avk); else sentAvatar.delete(clientId);
        pushAvatars(false);
        publishNet();
        break;
      }
      case 'create': {
        const mine = boundTeam(clientId);
        if (mine) { joined(clientId, mine); return; }
        const name = String(msg.name || '').trim().slice(0, 28);
        if (!name) { reply(clientId, { t: 'err', code: 'name' }); return; }
        const same = S.get().teams.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
        if (same) { reply(clientId, { t: 'err', code: same.device ? 'name-taken' : 'name-free', teamId: same.id }); return; }
        if (S.get().teams.length >= 8) { reply(clientId, { t: 'err', code: 'full' }); return; }
        const id = 't' + Math.random().toString(36).slice(2, 8);
        S.dispatch({ type: 'teamCreate', id, name, emoji: String(msg.emoji || '⭐').slice(0, 8), device: clientId, avatar: validAvatar(msg.avatar) ? msg.avatar : null });
        pushState(true);
        joined(clientId, team(id));
        publishNet();
        break;
      }
      case 'claim': { // «восстановить команду»: занять команду без телефона
        const mine = boundTeam(clientId);
        if (mine) { reply(clientId, { t: 'err', code: mine.id === msg.teamId ? 'ok' : 'already' }); joined(clientId, mine); return; }
        const t = team(msg.teamId);
        if (!t) { reply(clientId, { t: 'err', code: 'no-team' }); return; }
        if (t.device && t.device !== clientId) { reply(clientId, { t: 'err', code: 'taken' }); return; }
        S.dispatch({ type: 'bindDevice', teamId: t.id, device: clientId });
        pushState(true);
        joined(clientId, team(t.id));
        publishNet();
        break;
      }
      case 'avatar': { // смена аватара из меню команды
        const t = boundTeam(clientId);
        if (!t) { reply(clientId, { t: 'err', code: 'not-bound' }); return; }
        if (msg.avatar && !validAvatar(msg.avatar)) { reply(clientId, { t: 'err', code: 'avatar' }); return; }
        S.dispatch({ type: 'teamAvatar', teamId: t.id, avatar: msg.avatar || null, emoji: msg.emoji ? String(msg.emoji).slice(0, 8) : null });
        pushState(true);
        break;
      }
      case 'buzz': {
        const t = boundTeam(clientId);
        if (!t) { reply(clientId, { t: 'err', code: 'not-bound' }); joined(clientId, null); return; }
        if (msg.teamId && msg.teamId !== t.id) { reply(clientId, { t: 'err', code: 'not-yours' }); joined(clientId, t); return; }
        // устаревшее нажатие: вопрос уже другой/закрыт или оно застряло в сети (QoS1 дослал после обрыва).
        // qid/hostTs шлют только новые телефоны; без них — как раньше
        const s0 = S.get();
        const age = typeof msg.hostTs === 'number' ? Date.now() - msg.hostTs : 0;
        if (('qid' in msg && !buzzLive(s0, msg.qid)) || age > BUZZ_MAX_AGE_MS) {
          reply(clientId, { t: 'buzzResult', result: 'stale', teamId: t.id, qid: msg.qid, winner: s0.phase === 'question' ? s0.buzzer.winner : null, clientTs: msg.clientTs });
          return;
        }
        // то же действие, что и у клавиатурного баззера: первый пришедший на пульт выигрывает
        S.dispatch({ type: 'buzz', teamId: t.id });
        const s = S.get();
        const cur = s.current;
        let result = 'early';
        if (s.phase === 'setup') result = 'test';
        else if (s.phase === 'question' && s.buzzer.winner === t.id) result = 'won';
        else if (cur && s.phase === 'question' && cur.wrong.includes(t.id)) result = 'wrong';
        else if (s.phase === 'question' && s.buzzer.winner) result = 'late';
        reply(clientId, { t: 'buzzResult', result, teamId: t.id, qid: msg.qid, winner: s.buzzer.winner, clientTs: msg.clientTs });
        break;
      }
      case 'leave':
        devices.delete(clientId);
        publishNet();
        break;
      case 'ping': // отвечаем сразу: не зависим от таймеров фоновой вкладки пульта
        // now/ts — телефон оценивает разницу часов с пультом (для отсева застрявших нажатий)
        reply(clientId, { t: 'pong', now: Date.now(), ts: msg.ts });
        break;
      default: break;
    }
  }

  /** Пульт отвязал телефон от команды: команда с баллами остаётся, телефон уходит на экран входа. */
  function unbind(teamId) {
    const t = team(teamId);
    if (!t || !t.device) return;
    const dev = t.device;
    S.dispatch({ type: 'bindDevice', teamId, device: null });
    reply(dev, { t: 'joined', teamId: null, reason: 'unbound', rev: S.get().rev });
    pushState(true);
    publishNet();
  }

  /* ---------- запуск ---------- */
  function ensureRoom() {
    let r = S.get().room;
    if (!r || !S.get().netKey) { r = r || U.makeRoom(4); S.dispatch({ type: 'setRoom', room: r, key: S.get().netKey || U.makeKey(20) }); }
    return r;
  }

  function setStatus(st, info) {
    const prevSt = status, prevText = statusInfo;
    status = st;
    statusInfo = typeof info === 'string' ? info : (info && info.text) || '';
    diag = info && typeof info === 'object' ? info : { text: statusInfo };
    // на каждый «пульс» сети не перерисовываем пульт — только если что-то поменялось
    if (prevSt === st && prevText === statusInfo && st !== 'id-taken') { if (info && 'best' in info) best = info.best; return; }
    if (info && typeof info === 'object' && 'best' in info) best = info.best;
    if (st === 'online') idTaken = 0;
    if (st === 'id-taken') {
      idTaken++;
      // id так и не освободился — переезжаем в новую комнату
      if (idTaken >= ID_RETRIES) { idTaken = 0; newRoom(); return; }
    }
    publishNet();
    if (st === 'online') pushState(true);
  }

  function connect() {
    // комнату сменили («новая комната» или в другой вкладке) — новый пульт скажет старым телефонам, куда переехали
    const prev = room && roomKey ? { room, key: roomKey } : null;
    const old = host;
    host = null;                 // до ensureRoom: его setRoom не должен снова звать connect() из подписки
    if (old) old.close(!!prev);
    devices.clear();
    screens.clear();
    room = ensureRoom();
    roomKey = S.get().netKey;
    const movedFrom = prev && (prev.room !== room || prev.key !== roomKey) ? prev : null;
    if (!window.Net) { setStatus('unavailable', 'js/net.js не загрузился'); return; }
    if (!window.Net.available()) { setStatus('unavailable', 'библиотека связи (' + window.Net.transport + ') не загрузилась'); return; }
    host = window.Net.createHost({
      room,
      key: roomKey,
      movedFrom,
      onMessage,
      onLeave: (clientId) => { devices.delete(clientId); publishNet(); },
      onStatus: setStatus,
    });
  }

  function newRoom() {
    S.dispatch({ type: 'setRoom', room: U.makeRoom(4), key: U.makeKey(20) });
    // при живой сети переподключит подписка на Store (комната сменилась); второй connect()
    // создавал лишний экземпляр, и тот публиковал «пульт ушёл» уже в новую комнату
    if (!host) connect();
  }

  /** Сеть держит другая вкладка пульта: отдаём ей, сами молчим. */
  function release() {
    if (host) { host.close(true); host = null; }
    room = null; roomKey = null; // «переехали» — забота той вкладки, что забрала сеть
    devices.clear();
    status = 'other-tab'; statusInfo = 'сеть держит другая вкладка пульта';
    listeners.forEach((fn) => fn());
  }
  function tryLock() {
    const l = readLock();
    if (l && l.tab !== TAB_ID && Date.now() - l.at <= LOCK_TTL_MS) { if (host || status !== 'other-tab') release(); return; }
    writeLock();
    if (!host) connect();
  }
  /** Кнопка «забрать сеть сюда». Другая вкладка увидит чужой свежий замок и отпустит. */
  function takeOver() { writeLock(); if (!host) connect(); listeners.forEach((fn) => fn()); }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    tryLock();
    setInterval(tryLock, LOCK_BEAT_MS); // heartbeat замка
    setInterval(() => { if (host) { prune(); pushState(true); pushScreens(true); } }, KEEPALIVE_MS);
    S.subscribe((s) => {
      if (!host) return;
      // комнату (или её секрет) сменили — «новая комната» здесь или в другой вкладке
      if ((s.room && s.room !== room) || (s.netKey && roomKey && s.netKey !== roomKey)) connect();
      else { pushState(false); pushScreens(false); }
    });
  }

  window.Remote = {
    start,
    newRoom,
    unbind,
    takeOver,
    get holder() { return !!host; },
    get best() { return best; },
    isOnline: (teamId) => { const t = team(teamId); return !!(t && t.device && devices.has(t.device)); },
    get status() { return status; },
    get info() { return statusInfo; },
    /** Живая диагностика: брокеры, последнее входящее сообщение. */
    get diag() { return Object.assign({}, diag, { lastIn: lastIn && Object.assign({}, diag.lastIn && diag.lastIn.cid === lastIn.cid ? diag.lastIn : {}, lastIn) }); },
    get screens() { return screens.size; },
    get room() { return room || S.get().room; },
    devices: () => Array.from(devices.entries()).map(([id, d]) => ({ id, teamId: (boundTeam(id) || {}).id || null, lastSeen: d.lastSeen })),
    onChange(fn) { listeners.add(fn); },
  };
})();
