/* ==========================================================================
   Сетевой транспорт «пульт ↔ телефоны/экран». Ничего не знает об игре —
   только доставляет JSON-сообщения. Интерфейс (одинаковый для всех транспортов):

     const host = Net.createHost({ room, key, onMessage(clientId, msg), onLeave(clientId), onStatus(status, info) })
       host.broadcast(msg)        — всем телефонам
       host.send(clientId, msg)   — одному клиенту (телефону или экрану)
       host.close(silent)
     const client = Net.createClient({ room, key, clientId, onMessage(msg), onStatus(status, info), onKey(key), onMoved(room, key) })
       onStatus зовётся только при смене статуса; onMoved — пульт сменил комнату, клиент уже переехал сам
       client.send(msg) → true/false
       client.reconnect()          — переподключиться ко всем серверам
       client.info()               — живая диагностика
       client.close()

   status: 'connecting' (нет ни одного сервера связи) | 'no-host' (сервер есть, пульт не отвечает)
           | 'online' | 'offline' | 'id-taken' | 'unavailable' (библиотека не загрузилась)
   info:   { brokers: [{name, state, err, lastAt}], text, best, lastIn, via, waitSec }

   Транспорты (всё локально, никаких CDN):
     mqtt         — публичные MQTT-брокеры по WSS (по умолчанию на GitHub Pages).
                    И пульт, и КАЖДЫЙ клиент держат соединения со ВСЕМИ брокерами сразу:
                    общий брокер найдётся, даже если у кого-то часть из них недоступна.
                    Сообщения дублируются по брокерам и отсеиваются по id.
     local-server — node server.js в локальной сети (без интернета): SSE + POST,
                    те же топики. Включается сам, если страницу отдал server.js.
     peer         — PeerJS (WebRTC): ?net=peer (запасной).
     local        — BroadcastChannel внутри одного браузера (для тестов): ?net=local.
   Топики: svoyak/<k>/up/<clientId> (к пульту), svoyak/<k>/down (всем телефонам),
           svoyak/<k>/to/<clientId> (лично), svoyak/<k>/host (retained: пульт онлайн?),
           svoyak/lobby/<код> (retained «маяк» с k — для входа по коду без QR).
   ========================================================================== */
(function () {
  'use strict';

  const PREFIX = 'svoyak-';
  const CLIENT_PING_MS = 4000;     // клиент пингует хоста
  const CLIENT_WATCHDOG_MS = 12000; // нет вестей от хоста столько — «ведущий не найден» (пинг каждые 4 с)
  const HOST_FRESH_MS = 10000;     // пульт отвечал недавно — will «offline» одного брокера не считаем уходом пульта
  const WAKE_QUIET_MS = 6000;      // вернулись на вкладку, а пульт молчит дольше — переподключаем всё
  const MOVED_REPEAT_MS = 120000;  // сколько пульт повторяет «переехали» в старую комнату
  const noop = () => {};

  /* ---------------------------------------------------------------- PeerJS */
  const peerTransport = {
    name: 'peer',
    available: () => typeof window.Peer === 'function',

    createHost({ room, onMessage = noop, onLeave = noop, onStatus = noop }) {
      let peer = null, closed = false, retryT = 0;
      const conns = new Map(); // conn.connectionId → { conn, clientId }

      function start() {
        if (closed) return;
        onStatus('connecting');
        peer = new window.Peer(PREFIX + room, { debug: 1 });
        peer.on('open', () => onStatus('online'));
        peer.on('connection', (conn) => {
          const clientId = (conn.metadata && conn.metadata.clientId) || conn.peer;
          conn.on('open', () => conns.set(conn.connectionId, { conn, clientId }));
          conn.on('data', (data) => { if (data && typeof data === 'object') onMessage(clientId, data); });
          const drop = () => {
            if (!conns.has(conn.connectionId)) return;
            conns.delete(conn.connectionId);
            // телефон мог уже переподключиться другим соединением
            if (![...conns.values()].some((c) => c.clientId === clientId)) onLeave(clientId);
          };
          conn.on('close', drop);
          conn.on('error', drop);
        });
        // потеряли сигнальный сервер — уже открытые соединения живут, просто переподключаемся
        peer.on('disconnected', () => { if (!closed && peer && !peer.destroyed) { onStatus('connecting'); try { peer.reconnect(); } catch (e) { restart(3000); } } });
        peer.on('error', (err) => {
          const type = err && err.type;
          if (type === 'unavailable-id') { onStatus('id-taken'); restart(3000); return; }
          if (type === 'peer-unavailable') return; // не про нас
          onStatus('offline', type || String(err));
          if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(type)) restart(4000);
        });
      }
      function restart(ms) {
        clearTimeout(retryT);
        try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
        conns.clear();
        if (!closed) retryT = setTimeout(start, ms);
      }
      start();

      return {
        broadcast(msg) { conns.forEach(({ conn }) => { if (conn.open) try { conn.send(msg); } catch (e) { /* ignore */ } }); },
        send(clientId, msg) { conns.forEach((c) => { if (c.clientId === clientId && c.conn.open) try { c.conn.send(msg); } catch (e) { /* ignore */ } }); },
        close() { closed = true; clearTimeout(retryT); try { if (peer) peer.destroy(); } catch (e) { /* ignore */ } },
      };
    },

    createClient({ room, clientId, onMessage = noop, onStatus = noop }) {
      let peer = null, conn = null, closed = false;
      let retryT = 0, pingT = 0, lastHeard = 0;

      function setupPeer() {
        if (closed) return;
        onStatus('connecting');
        try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
        peer = new window.Peer({ debug: 1 });
        peer.on('open', connect);
        peer.on('disconnected', () => { if (!closed && !peer.destroyed) try { peer.reconnect(); } catch (e) { later(setupPeer, 3000); } });
        peer.on('error', (err) => {
          const type = err && err.type;
          if (type === 'peer-unavailable') { onStatus('no-host'); later(connect, 3000); return; }
          onStatus('offline', type || String(err));
          later(setupPeer, 3000);
        });
      }
      function connect() {
        if (closed || !peer || peer.destroyed) return;
        if (peer.disconnected) { try { peer.reconnect(); } catch (e) { later(setupPeer, 2000); return; } }
        try { if (conn) conn.close(); } catch (e) { /* ignore */ }
        conn = peer.connect(PREFIX + room, { reliable: true, metadata: { clientId } });
        const c = conn;
        c.on('open', () => { if (c !== conn) return; lastHeard = Date.now(); onStatus('online'); });
        c.on('data', (data) => { if (c !== conn) return; lastHeard = Date.now(); if (data && typeof data === 'object') onMessage(data); });
        c.on('close', () => { if (c === conn && !closed) { onStatus('connecting'); later(connect, 1500); } });
        c.on('error', () => { if (c === conn && !closed) later(connect, 2000); });
      }
      function later(fn, ms) { clearTimeout(retryT); retryT = setTimeout(fn, ms); }

      // пинг + сторож: если хост замолчал (сон телефона, обрыв) — пересоединяемся
      pingT = setInterval(() => {
        if (closed) return;
        if (conn && conn.open) {
          try { conn.send({ t: 'ping' }); } catch (e) { /* ignore */ }
          if (lastHeard && Date.now() - lastHeard > CLIENT_WATCHDOG_MS) { onStatus('connecting'); connect(); }
        }
      }, CLIENT_PING_MS);

      setupPeer();
      return {
        send(msg) { if (conn && conn.open) { try { conn.send(msg); return true; } catch (e) { return false; } } return false; },
        reconnect() { if (closed) return; if (!peer || peer.destroyed) setupPeer(); else if (!conn || !conn.open) connect(); },
        close() { closed = true; clearTimeout(retryT); clearInterval(pingT); try { if (peer) peer.destroy(); } catch (e) { /* ignore */ } },
      };
    },
  };

  /* -------------------------------------------- local (BroadcastChannel) */
  const localTransport = {
    name: 'local',
    available: () => typeof window.BroadcastChannel === 'function',

    createHost({ room, onMessage = noop, onStatus = noop }) {
      const ch = new BroadcastChannel(PREFIX + 'net-' + room);
      ch.onmessage = (e) => { const m = e.data; if (m && m.to === 'host' && m.data) onMessage(m.from, m.data); };
      setTimeout(() => onStatus('online'), 0);
      return {
        broadcast(msg) { ch.postMessage({ from: 'host', to: '*', data: msg }); },
        send(clientId, msg) { ch.postMessage({ from: 'host', to: clientId, data: msg }); },
        close() { ch.close(); },
      };
    },

    createClient({ room, clientId, onMessage = noop, onStatus = noop }) {
      const ch = new BroadcastChannel(PREFIX + 'net-' + room);
      let lastHeard = 0, status = '';
      const set = (st) => { if (st !== status) { status = st; onStatus(st); } };
      ch.onmessage = (e) => {
        const m = e.data;
        if (!m || m.from !== 'host' || (m.to !== '*' && m.to !== clientId)) return;
        lastHeard = Date.now();
        set('online');
        onMessage(m.data);
      };
      const post = (msg) => ch.postMessage({ from: clientId, to: 'host', data: msg });
      const t = setInterval(() => {
        post({ t: 'ping' });
        if (status === 'online' && Date.now() - lastHeard > CLIENT_WATCHDOG_MS) set('no-host');
      }, CLIENT_PING_MS);
      // «соединение» в локальном режиме мгновенное; хост ответит на hello состоянием
      setTimeout(() => set('online'), 0);
      return {
        send(msg) { post(msg); return true; },
        reconnect() { post({ t: 'ping' }); },
        close() { clearInterval(t); ch.close(); },
      };
    },
  };


  /* ===================================================== публикация-подписка */
  const BROKERS = [
    { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
    { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
    // порт 443 — на случай, если оператор режет «нестандартные» порты
    { name: 'shiftr', url: 'wss://public.cloud.shiftr.io:443', auth: { username: 'public', password: 'public' } },
  ];
  const TOPIC = 'svoyak/';
  const rnd = (n) => Math.random().toString(36).slice(2, 2 + n) + Math.random().toString(36).slice(2, 2 + n);
  const parse = (p) => { try { return JSON.parse(typeof p === 'string' ? p : String(p)); } catch (e) { return null; } };

  /** Отсев дублей (одно сообщение приходит через несколько брокеров). */
  function Dedupe(max = 400) {
    const set = new Set(), q = [];
    return { seen(id) { if (!id) return false; if (set.has(id)) return true; set.add(id); q.push(id); if (q.length > max) set.delete(q.shift()); return false; } };
  }

  // переподключение к брокеру: сами, с нарастающей паузой (mqtt.js с фиксированным интервалом
  // и коротким connectTimeout мог так и не дождаться медленного брокера)
  const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];
  const LINK_DEAD_MS = 8000;       // отправили QoS1 и ни одного пакета в ответ столько — соединение мёртвое
  const LINK_CHECK_MS = 2000;

  /** Линк к одному MQTT-брокеру. */
  function mqttLink(def, { will, onMessage, onState }) {
    const L = { name: def.name, state: 'connecting', err: '', lastAt: 0, topics: [], onconnect: noop };
    let cl = null, t0 = 0, retryT = 0, tries = 0, dead = false;
    let waitSince = 0;             // с какого момента ждём хоть какой-то ответ брокера (PUBACK и т.п.)
    function retry(why) {
      if (dead || retryT) return;
      const ms = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)];
      tries++;
      L.err = (why || L.err || 'нет связи').replace(/ · повтор.*$/, '').slice(0, 60) + ' · повтор через ' + Math.round(ms / 1000) + ' с';
      retryT = setTimeout(() => { retryT = 0; if (!dead) L.open(); }, ms);
    }
    L.open = () => {
      dead = false;
      clearTimeout(t0); clearTimeout(retryT); retryT = 0;
      waitSince = 0;
      L.err = L.err.replace(/ · повтор.*$/, '');
      try { if (cl) cl.end(true); } catch (e) { /* ignore */ }
      L.state = 'connecting'; onState();
      const opts = Object.assign({ clientId: 'svoyak-' + rnd(6), keepalive: 15, reconnectPeriod: 0, connectTimeout: 12000, clean: true }, def.auth || {});
      if (will) opts.will = { topic: will.topic, payload: JSON.stringify({ d: will.payload }), qos: 1, retain: !!will.retain };
      let my;
      try { my = window.mqtt.connect(def.url, opts); } catch (e) { cl = null; L.state = 'fail'; retry(String(e && e.message || e)); onState(); return; }
      cl = my;
      // 5 с — только для индикатора; само соединение ждём до connectTimeout (медленный брокер всё равно подключится)
      t0 = setTimeout(() => { if (cl === my && L.state === 'connecting') { L.state = 'fail'; L.err = L.err || 'нет ответа 5 с'; onState(); } }, 5000);
      my.on('connect', () => {
        if (cl !== my) return;
        clearTimeout(t0);
        tries = 0; waitSince = 0;
        L.state = 'ok'; L.err = ''; L.lastAt = Date.now();
        if (L.topics.length) my.subscribe(L.topics, { qos: 1 });
        onState(); L.onconnect();
      });
      my.on('packetreceive', () => { if (cl === my) waitSince = 0; });
      my.on('message', (topic, payload) => { if (cl !== my) return; L.lastAt = Date.now(); const m = parse(payload); if (m) onMessage(L, topic, m); });
      const down = (e) => {
        if (cl !== my) return;
        if (e && e.message) L.err = e.message.slice(0, 60);
        retry();
        if (L.state !== 'fail') { L.state = 'fail'; onState(); }
      };
      my.on('error', down); my.on('offline', () => down()); my.on('close', () => down());
    };
    // «полуоткрытое» соединение (Wi-Fi→LTE, сон телефона): TCP жив, но ничего не ходит.
    // keepalive mqtt.js тут не поможет — мы сами всё время что-то шлём, и он не пингует.
    const watch = setInterval(() => {
      if (dead || !cl || L.state !== 'ok' || !waitSince || Date.now() - waitSince < LINK_DEAD_MS) return;
      L.err = 'соединение зависло — переподключаемся';
      L.open();
    }, LINK_CHECK_MS);
    L.setTopics = (topics) => {
      const old = L.topics; L.topics = topics;
      if (cl && L.state === 'ok') {
        const rm = old.filter((x) => !topics.includes(x));
        if (rm.length) cl.unsubscribe(rm);
        cl.subscribe(topics, { qos: 1 });
      }
    };
    L.publish = (topic, obj, o = {}) => {
      if (!cl || L.state !== 'ok') return false;
      const qos = o.qos == null ? 0 : o.qos;
      try { cl.publish(topic, JSON.stringify(obj), { qos, retain: !!o.retain }); } catch (e) { return false; }
      if (qos > 0 && !waitSince) waitSince = Date.now();
      return true;
    };
    L.close = () => { dead = true; clearTimeout(t0); clearTimeout(retryT); retryT = 0; clearInterval(watch); try { if (cl) cl.end(true); } catch (e) { /* ignore */ } cl = null; };
    return L;
  }

  /** Линк к локальному server.js: SSE (приём) + POST (отправка). */
  function sseLink(def, { will, onMessage, onState }) {
    const L = { name: def.name, state: 'connecting', err: '', lastAt: 0, topics: [], onconnect: noop };
    let es = null, lastRx = 0, pings = false;
    function reopen() {
      try { if (es) es.close(); } catch (e) { /* ignore */ }
      es = null;
      if (!L.topics.length) return;
      const q = new URLSearchParams({ t: L.topics.join(',') });
      if (will) q.set('will', JSON.stringify({ topic: will.topic, payload: { d: will.payload }, retain: !!will.retain }));
      const my = new EventSource(def.base + '/relay/sub?' + q.toString());
      es = my;
      lastRx = Date.now();
      my.onopen = () => { if (es !== my) return; lastRx = Date.now(); L.state = 'ok'; L.err = ''; L.lastAt = Date.now(); onState(); L.onconnect(); };
      my.onmessage = (e) => {
        if (es !== my) return;
        lastRx = Date.now();
        const m = parse(e.data);
        if (m && m.topic === '$ping') { pings = true; return; } // пульс server.js — только для сторожа
        L.lastAt = Date.now();
        if (m && m.topic) onMessage(L, m.topic, m.payload);
      };
      my.onerror = () => { if (es !== my) return; if (L.state === 'ok') { L.state = 'connecting'; L.err = 'обрыв, переподключаемся'; onState(); } };
    }
    // server.js шлёт пульс каждые 5 с: тишина дольше — соединение зависло (сон телефона, смена сети)
    const watch = setInterval(() => { if (pings && es && Date.now() - lastRx > 12000) { L.err = 'соединение зависло — переподключаемся'; L.state = 'connecting'; onState(); reopen(); } }, LINK_CHECK_MS);
    L.open = () => { L.state = 'connecting'; onState(); reopen(); };
    L.setTopics = (t) => { L.topics = t; if (L.state === 'ok' || es) reopen(); };
    L.publish = (topic, obj, o = {}) => {
      if (L.state !== 'ok') return false;
      try {
        // keepalive — только для прощальных сообщений: у Chrome лимит 64 КБ на все такие запросы разом,
        // и аватары (≈50 КБ) с keepalive просто не уходили
        fetch(def.base + '/relay/pub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, payload: obj, retain: !!o.retain }), keepalive: !!o.urgent })
          .catch(() => { L.err = 'не отправилось'; });
        return true;
      } catch (e) { return false; }
    };
    L.close = () => { clearInterval(watch); try { if (es) es.close(); } catch (e) { /* ignore */ } es = null; };
    return L;
  }

  function linkInfo(links) { return links.map((l) => ({ name: l.name, state: l.state, err: l.err, lastAt: l.lastAt })); }

  /** Пульт поверх набора линков. */
  function pubsubHost(defs, makeLink, { room, key, movedFrom, onMessage = noop, onStatus = noop }) {
    const base = TOPIC + key + '/';
    const hid = 'h' + rnd(5);
    const t0 = Date.now();
    let seq = 0, closed = false, lastIn = null;
    const wrap = (d) => ({ i: hid + ':' + (++seq), d });
    const dd = Dedupe();
    const will = { topic: base + 'host', payload: { online: false }, retain: true };
    const links = defs.map((def) => makeLink(def, { will, onMessage: recv, onState: report }));

    function recv(l, topic, m) {
      if (topic.indexOf(base + 'up/') !== 0 || !m || !m.d) return;
      if (dd.seen(m.i)) return;
      const cid = topic.slice(base.length + 3);
      lastIn = { t: m.d.t, cid, broker: l.name, at: Date.now() };
      onMessage(cid, m.d);
    }
    function presence(l) {
      l.publish(base + 'host', { d: { online: true, at: Date.now() } }, { qos: 1, retain: true });
      l.publish(TOPIC + 'lobby/' + room, { d: { k: key, at: Date.now() } }, { retain: true }); // маяк для входа по коду
      // «Новая комната»: в старые топики (retained) — «переехали сюда». Телефоны со старым QR
      // и уже открытые переходят сами. Повторяем первые 2 минуты: will старого соединения
      // мог затереть retained уже после нашей первой публикации.
      if (movedFrom && movedFrom.key && Date.now() - t0 < MOVED_REPEAT_MS) {
        const mv = { online: false, moved: room, k: key, at: Date.now() };
        l.publish(TOPIC + movedFrom.key + '/host', { d: mv }, { qos: 1, retain: true });
        if (movedFrom.room) l.publish(TOPIC + 'lobby/' + movedFrom.room, { d: mv }, { retain: true });
      }
    }
    function report() {
      if (closed) return;
      const ok = links.filter((l) => l.state === 'ok');
      const bad = links.filter((l) => l.state !== 'ok');
      const text = ok.length
        ? 'подключено к ' + ok.map((l) => l.name).join(', ') + (bad.length ? ' · не отвечают: ' + bad.map((l) => l.name + (l.err ? ' (' + l.err + ')' : '')).join(', ') : '')
        : 'серверы связи не отвечают: ' + links.map((l) => l.name + (l.err ? ' (' + l.err + ')' : '')).join(', ');
      onStatus(ok.length ? 'online' : (links.every((l) => l.state === 'fail') ? 'offline' : 'connecting'),
        { brokers: linkInfo(links), text, best: ok.length ? links.indexOf(ok[0]) : -1, lastIn });
    }
    links.forEach((l) => { l.topics = [base + 'up/+']; l.onconnect = () => presence(l); l.open(); });
    report();
    const beat = setInterval(() => { if (!closed) { links.forEach((l) => { if (l.state === 'ok') presence(l); }); report(); } }, 2500);

    return {
      broadcast(msg) { const w = wrap(msg); links.forEach((l) => l.publish(base + 'down', w)); },
      // личное — через все живые брокеры: клиент слушает на всех доступных ему
      send(clientId, msg) { const w = wrap(msg); links.forEach((l) => l.publish(base + 'to/' + clientId, w, { qos: 1 })); },
      close(silent) {
        closed = true; clearInterval(beat);
        // bye — пульт ушёл сам (в отличие от will одного брокера, которому телефоны не верят сразу)
        links.forEach((l) => { if (!silent) l.publish(base + 'host', { d: { online: false, bye: true } }, { qos: 1, retain: true, urgent: true }); setTimeout(() => l.close(), 150); });
      },
    };
  }

  /** Телефон/экран поверх набора линков: подписан на ВСЕХ доступных серверах сразу. */
  function pubsubClient(defs, makeLink, { room, key, clientId, onMessage = noop, onStatus = noop, onKey = noop, onMoved = noop }) {
    let k = key || '';
    const fromUrl = !!key;
    const cw = 'c' + rnd(5);
    let seq = 0, closed = false, hostAlive = false, lastHeard = 0, waitFrom = Date.now(), via = '';
    const wrap = (d) => ({ i: cw + ':' + (++seq), d });
    const dd = Dedupe();
    const base = () => TOPIC + k + '/';
    const topics = () => (k ? [base() + 'down', base() + 'to/' + clientId, base() + 'host'] : [TOPIC + 'lobby/' + room]);
    const links = defs.map((def) => makeLink(def, { onMessage: recv, onState: report }));

    /** Пульт сменил комнату («новая комната»): переезжаем вслед за ним. */
    function moveTo(newRoom, newKey) {
      const r = String(newRoom || '').toUpperCase();
      const nk = String(newKey || '');
      if (!/^[A-Z0-9]{3,6}$/.test(r) || !/^[A-Za-z0-9]{6,64}$/.test(nk) || nk === k) return;
      room = r; k = nk;
      if (hostAlive) { hostAlive = false; report(); } // новый пульт ответит — снова «online» (и hello)
      waitFrom = Date.now();
      try { onMoved(room, k); } catch (e) { /* ignore */ }
      onKey(k);
      links.forEach((x) => x.setTopics(topics()));
      setTimeout(probe, 300);
    }
    function recv(l, topic, m) {
      const d = m && m.d;
      if (!d) return;
      if (topic === TOPIC + 'lobby/' + room) {
        if (d.moved) moveTo(d.moved, d.k);
        else if (d.k && d.k !== k) { k = String(d.k); onKey(k); links.forEach((x) => x.setTopics(topics())); setTimeout(probe, 300); }
        return;
      }
      if (!k || topic.indexOf(base()) !== 0) return;
      if (topic === base() + 'host') {
        if (d.moved && d.k) { moveTo(d.moved, d.k); return; }
        // retained-флаг может быть устаревшим: «найден» — только после настоящего ответа пульта.
        // online:false без bye — это will одного брокера (у пульта моргнула связь с ним);
        // если пульт недавно отвечал (по любому брокеру) — не верим, иначе телефоны зря «теряют ведущего»
        if (d.online === false) {
          if (hostAlive && (d.bye || Date.now() - lastHeard > HOST_FRESH_MS)) { hostAlive = false; waitFrom = Date.now(); report(); }
        } else probe();
        return;
      }
      if (dd.seen(m.i)) return;
      lastHeard = Date.now(); via = l.name;
      if (!hostAlive) { hostAlive = true; report(); }
      onMessage(d);
    }
    function send(msg) {
      if (!k) return false;
      const w = wrap(msg);
      const o = { qos: 1, urgent: !!(msg && msg.t === 'leave') };
      let ok = false;
      links.forEach((l) => { if (l.publish(base() + 'up/' + clientId, w, o)) ok = true; });
      return ok;
    }
    // ts — пульт вернёт его в pong вместе со своим временем (телефон оценит разницу часов)
    function probe() { if (!closed) send({ t: 'ping', ts: Date.now() }); }
    function info() {
      const ok = links.filter((l) => l.state === 'ok');
      return {
        brokers: linkInfo(links), server: ok.length > 0, host: hostAlive, via,
        broker: ok.map((l) => l.name).join(', '),
        waitSec: hostAlive ? 0 : Math.round((Date.now() - waitFrom) / 1000),
        key: k ? k.slice(0, 4) + '…' : '(ищем по коду)',
        text: ok.length ? 'серверы: ' + ok.map((l) => l.name).join(', ') + (hostAlive ? ' · пульт отвечает через ' + via : ' · пульт молчит') : 'нет ни одного сервера связи',
      };
    }
    // onStatus — только при СМЕНЕ статуса: раньше он звался на каждое моргание любого брокера,
    // а телефон/экран на каждый вызов слали hello, и пульт заново рассылал им аватары (шторм)
    let lastSt = '';
    function report() {
      if (closed) return;
      const server = links.some((l) => l.state === 'ok');
      const st = !server ? 'connecting' : hostAlive ? 'online' : 'no-host';
      if (st === lastSt) return;
      lastSt = st;
      onStatus(st, info());
    }
    links.forEach((l) => { l.topics = topics(); l.onconnect = () => setTimeout(probe, 200); l.open(); });

    const tick = setInterval(() => {
      if (closed) return;
      probe();
      if (hostAlive && Date.now() - lastHeard > CLIENT_WATCHDOG_MS) { hostAlive = false; waitFrom = Date.now(); report(); }
      // секрет из ссылки не работает 30 с при живых серверах — пробуем найти пульт по коду (маяк)
      if (fromUrl && !hostAlive && k && room && Date.now() - waitFrom > 30000 && links.some((l) => l.state === 'ok')) {
        k = ''; waitFrom = Date.now(); links.forEach((x) => x.setTopics(topics()));
      }
    }, CLIENT_PING_MS);

    return {
      send,
      info,
      // вернулись на вкладку: пульт молчит дольше WAKE_QUIET_MS — соединения могли умереть во сне, открываем заново
      reconnect() {
        if (closed) return;
        const quiet = !lastHeard || Date.now() - lastHeard > WAKE_QUIET_MS;
        if (!hostAlive) waitFrom = Date.now();
        links.forEach((l) => { if (l.state !== 'ok' || quiet) l.open(); });
        probe(); setTimeout(probe, 500);
      },
      reconnectAll() { if (closed) return; waitFrom = Date.now(); links.forEach((l) => l.open()); },
      close() { closed = true; clearInterval(tick); links.forEach((l) => l.close()); },
    };
  }

  /* ------------------------------------------------------------ транспорты */
  const SERVER = window.SVOYAK_SERVER || null; // его подставляет server.js в html

  const mqttTransport = {
    name: 'mqtt',
    available: () => !!(window.mqtt && typeof window.mqtt.connect === 'function'),
    createHost: (o) => pubsubHost(BROKERS, mqttLink, o),
    createClient: (o) => pubsubClient(BROKERS, mqttLink, o),
  };
  const serverTransport = {
    name: 'local-server',
    available: () => typeof window.EventSource === 'function' && typeof window.fetch === 'function',
    createHost: (o) => pubsubHost([{ name: 'этот компьютер', base: location.origin }], sseLink, o),
    createClient: (o) => pubsubClient([{ name: 'ноутбук ведущего', base: location.origin }], sseLink, o),
  };

  const TRANSPORTS = { mqtt: mqttTransport, 'local-server': serverTransport, peer: peerTransport, local: localTransport };

  function pickTransport() {
    let name = SERVER ? 'local-server' : 'mqtt';
    try { const q = new URLSearchParams(location.search).get('net'); if (q && TRANSPORTS[q]) name = q; } catch (e) { /* ignore */ }
    return TRANSPORTS[name];
  }
  const T = pickTransport();
  const DEFAULT = SERVER ? 'local-server' : 'mqtt';

  function unavailableStub(onStatus) {
    setTimeout(() => onStatus && onStatus('unavailable'), 0);
    return { broadcast: noop, send: () => false, reconnect: noop, reconnectAll: noop, info: () => ({}), close: noop };
  }

  /** IP мака в локальной сети (для ссылок/QR в локальном режиме). Ведущий может выбрать другой. */
  function lanIp() {
    if (!SERVER) return '';
    let ip = '';
    try { ip = localStorage.getItem('svoyak:lanip') || ''; } catch (e) { /* ignore */ }
    const list = (SERVER.ips || []).map((x) => x.address);
    return list.includes(ip) ? ip : (SERVER.ip || list[0] || location.hostname);
  }
  function pageUrl(page, room, key, broker) {
    let u;
    if (SERVER && T.name === 'local-server') u = new URL('http://' + lanIp() + ':' + (SERVER.port || location.port) + '/' + page);
    else { u = new URL(page, location.href); u.search = ''; u.hash = ''; }
    u.searchParams.set('room', room);
    if (key && (T.name === 'mqtt' || T.name === 'local-server')) u.searchParams.set('k', key);
    if (T.name === 'mqtt' && broker >= 0) u.searchParams.set('b', String(broker));
    if (T.name !== DEFAULT) u.searchParams.set('net', T.name);
    return u.toString();
  }

  window.Net = {
    transport: T.name,
    server: SERVER,
    available: () => T.available(),
    brokers: T.name === 'mqtt' ? BROKERS.map((b) => b.name) : [],
    createHost(opts) { return T.available() ? T.createHost(opts) : unavailableStub(opts.onStatus); },
    createClient(opts) { return T.available() ? T.createClient(opts) : unavailableStub(opts.onStatus); },
    lanIp,
    setLanIp(ip) { try { localStorage.setItem('svoyak:lanip', ip); } catch (e) { /* ignore */ } },
    /** Ссылка для телефона (k — секрет комнаты, b — подсказка брокера). */
    joinUrl: (room, key, broker) => pageUrl('buzzer.html', room, key, broker),
    /** Ссылка на экран гостей для ДРУГОГО устройства. */
    screenUrl: (room, key, broker) => pageUrl('screen.html', room, key, broker),
  };

  /** QR-код как картинка (свой генератор js/qr.js). null — если не вышло. */
  const qrCache = new Map();
  window.qrDataUrl = function (text) {
    if (qrCache.has(text)) return qrCache.get(text);
    let url = null;
    try { if (window.QR) url = window.QR.dataUrl(text, { ecl: 'M', quiet: 2 }); } catch (e) { console.warn('QR', e); url = null; }
    if (url) qrCache.set(text, url);
    return url;
  };
})();
