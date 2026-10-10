/* ==========================================================================
   Сетевой транспорт «пульт ↔ телефоны». Ничего не знает об игре —
   только доставляет JSON-сообщения. Интерфейс (одинаковый для всех транспортов):

     const host = Net.createHost({ room, key, onMessage(clientId, msg), onLeave(clientId), onStatus(status, info) })
       host.broadcast(msg)        — всем подключённым телефонам
       host.send(clientId, msg)   — одному телефону
       host.close()
     const client = Net.createClient({ room, key, broker, clientId, onMessage(msg), onStatus(status, info), onKey(key) })
       client.send(msg) → true/false
       client.reconnect()          — принудительно (например, после разблокировки экрана)
       client.close()

   status: 'connecting' (нет сервера связи) | 'no-host' (сервер есть, ведущего нет)
           | 'online' | 'offline' | 'id-taken' | 'unavailable' (библиотека не загрузилась)
   info:   { brokers: [{name, state}], text } — для диагностики на пульте/телефоне

   Транспорты (все библиотеки — локально в js/vendor, никаких CDN):
     mqtt  — MQTT поверх WSS через публичные брокеры, по умолчанию.
             Топики svoyak/<секрет>/…; секрет (k) — в QR-ссылке. Без k телефон
             находит его по «маяку» svoyak/lobby/<код>, который публикует пульт.
             Пульт сидит сразу на всех доступных брокерах, телефон начинает с ?b=.
     peer  — PeerJS (WebRTC) через PeerJS cloud: ?net=peer (запасной).
     local — BroadcastChannel внутри одного браузера (для тестов): ?net=local.
   ========================================================================== */
(function () {
  'use strict';

  const PREFIX = 'svoyak-';
  const CLIENT_PING_MS = 4000;     // клиент пингует хоста
  const CLIENT_WATCHDOG_MS = 20000; // нет вестей от хоста столько — переподключаемся
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

  /* ------------------------------------------------------------ MQTT */
  const BROKERS = [
    { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
    { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
  ];
  const TOPIC = 'svoyak/';
  const rnd = (n) => Math.random().toString(36).slice(2, 2 + n);
  const parse = (payload) => { try { return JSON.parse(String(payload)); } catch (e) { return null; } };

  const mqttTransport = {
    name: 'mqtt',
    available: () => !!(window.mqtt && typeof window.mqtt.connect === 'function'),

    createHost({ room, key, onMessage = noop, onStatus = noop }) {
      const base = TOPIC + key + '/';
      let closed = false;
      const where = new Map(); // clientId → брокер, откуда пишет телефон
      // пульт держит соединение со ВСЕМИ брокерами: телефон найдёт его на любом доступном
      const links = BROKERS.map((b, idx) => ({ ...b, idx, client: null, state: 'connecting', err: '' }));

      function report() {
        const ok = links.filter((l) => l.state === 'ok');
        const text = ok.length
          ? 'подключено к ' + ok.map((l) => l.name).join(', ') + (ok.length < links.length ? ' · не отвечают: ' + links.filter((l) => l.state !== 'ok').map((l) => l.name).join(', ') : '')
          : 'брокеры не отвечают: ' + links.map((l) => l.name + (l.err ? ' (' + l.err + ')' : '')).join(', ');
        onStatus(ok.length ? 'online' : (links.every((l) => l.state === 'fail') ? 'offline' : 'connecting'),
          { brokers: links.map((l) => ({ name: l.name, state: l.state })), text, best: ok.length ? ok[0].idx : -1 });
      }
      const pub = (l, topic, msg, opts) => { if (l.state === 'ok') try { l.client.publish(topic, JSON.stringify(msg), opts || { qos: 0 }); } catch (e) { /* ignore */ } };
      function presence(l) {
        pub(l, base + 'host', { online: true, at: Date.now() }, { qos: 1, retain: true });
        pub(l, TOPIC + 'lobby/' + room, { k: key, at: Date.now() }, { qos: 0, retain: true }); // маяк для ручного ввода кода
      }

      links.forEach((l) => {
        let firstTry = true;
        const timeout = setTimeout(() => { if (l.state === 'connecting') { l.state = 'fail'; l.err = 'таймаут'; report(); } }, 4500);
        l.client = window.mqtt.connect(l.url, {
          clientId: 'svoyak-h-' + rnd(10), keepalive: 20, reconnectPeriod: 4000, connectTimeout: 4000, clean: true,
          will: { topic: base + 'host', payload: JSON.stringify({ online: false }), qos: 1, retain: true },
        });
        l.client.on('connect', () => {
          clearTimeout(timeout); firstTry = false;
          l.state = 'ok'; l.err = '';
          l.client.subscribe(base + 'up/+', { qos: 1 });
          presence(l);
          report();
        });
        l.client.on('message', (topic, payload) => {
          const msg = parse(payload);
          if (!msg || topic.indexOf(base + 'up/') !== 0) return;
          const cid = topic.slice(base.length + 3);
          where.set(cid, l.idx);
          onMessage(cid, msg);
        });
        const down = (err) => {
          if (err && err.message) l.err = err.message.slice(0, 40);
          if (l.state === 'ok' || firstTry) { l.state = firstTry ? 'connecting' : 'fail'; report(); }
        };
        l.client.on('error', down);
        l.client.on('offline', () => down());
        l.client.on('close', () => { if (l.state === 'ok') { l.state = 'fail'; report(); } });
      });
      report();
      // маяк и «я на месте» — раз в пару секунд (retained, чтобы новые телефоны сразу видели)
      const beat = setInterval(() => { if (!closed) links.forEach(presence); }, 2500);

      return {
        broadcast(msg) { links.forEach((l) => pub(l, base + 'down', msg)); },
        // личное сообщение — через все живые брокеры: телефон мог только что переехать на другой
        send(clientId, msg) { links.forEach((x) => pub(x, base + 'to/' + clientId, msg, { qos: 1 })); },
        close(silent) {
          closed = true; clearInterval(beat);
          // silent — сеть переезжает в другую вкладку пульта: не сообщаем телефонам «ведущий ушёл»
          links.forEach((l) => { if (!silent) pub(l, base + 'host', { online: false }, { qos: 1, retain: true }); try { l.client.end(silent); } catch (e) { /* ignore */ } });
        },
      };
    },

    createClient({ room, key, broker, clientId, onMessage = noop, onStatus = noop, onKey = noop }) {
      let k = key || '';
      let idx = Number.isInteger(broker) && BROKERS[broker] ? broker : 0;
      let cl = null, closed = false, serverOk = false, hostAlive = false, lastHeard = 0, tried = 0;
      let retryT = 0, noHostT = 0, status = '';
      const set = (st) => {
        const info = { broker: BROKERS[idx].name, server: serverOk, host: hostAlive, text: '' };
        info.text = serverOk ? 'сервер связи: ' + BROKERS[idx].name + (hostAlive ? ' · ведущий найден' : ' · ищем ведущего') : 'сервер связи: пробуем ' + BROKERS[idx].name;
        status = st; onStatus(st, info);
      };
      const base = () => TOPIC + k + '/';

      function subscribeMain() {
        cl.subscribe([base() + 'down', base() + 'to/' + clientId, base() + 'host'], { qos: 1 });
      }
      function connect() {
        if (closed) return;
        clearTimeout(retryT); clearTimeout(noHostT);
        try { if (cl) cl.end(true); } catch (e) { /* ignore */ }
        serverOk = false; hostAlive = false;
        set('connecting');
        const my = window.mqtt.connect(BROKERS[idx].url, { clientId: 'svoyak-c-' + rnd(10), keepalive: 20, reconnectPeriod: 0, connectTimeout: 4000, clean: true });
        cl = my;
        const giveUp = setTimeout(() => { if (cl === my && !serverOk) nextBroker(); }, 4500);
        my.on('connect', () => {
          if (cl !== my) return;
          clearTimeout(giveUp);
          serverOk = true; tried = 0;
          if (k) { subscribeMain(); setTimeout(probe, 300); } else my.subscribe(TOPIC + 'lobby/' + room, { qos: 0 });
          set('no-host');
          // ведущий так и не нашёлся на этом брокере — пробуем следующий
          noHostT = setTimeout(() => { if (cl === my && !hostAlive) nextBroker(); }, 12000);
        });
        my.on('message', (topic, payload) => {
          if (cl !== my) return;
          const msg = parse(payload);
          if (!msg) return;
          if (topic === TOPIC + 'lobby/' + room) {
            if (!k && msg.k) { k = String(msg.k); onKey(k); my.unsubscribe(topic); subscribeMain(); setTimeout(probe, 300); }
            return;
          }
          if (topic === base() + 'host') {
            // retained-флаг может быть устаревшим: «найден» только после настоящего ответа пульта (pong)
            if (msg.online === false) { if (hostAlive) { hostAlive = false; set('no-host'); } }
            else probe();
            return;
          }
          lastHeard = Date.now();
          if (!hostAlive) { hostAlive = true; set('online'); }
          onMessage(msg);
        });
        const drop = () => {
          if (cl !== my || closed) return;
          clearTimeout(giveUp);
          if (serverOk) { serverOk = false; hostAlive = false; set('connecting'); retryT = setTimeout(connect, 1500); }
          else nextBroker();
        };
        my.on('error', drop);
        my.on('close', drop);
        my.on('offline', drop);
      }
      function nextBroker() {
        if (closed) return;
        tried++;
        idx = (idx + 1) % BROKERS.length;
        // обошли все брокеры, а ведущего нет — возможно, секрет в ссылке устарел: ищем по маяку кода
        if (tried >= BROKERS.length && k && room) { k = ''; tried = 0; }
        retryT = setTimeout(connect, tried % BROKERS.length === 0 ? 3000 : 200);
      }

      // пинг + сторож: пульт отвечает pong; молчит долго — считаем, что ведущего нет
      function probe() { if (cl && serverOk && k) try { cl.publish(base() + 'up/' + clientId, JSON.stringify({ t: 'ping' }), { qos: 0 }); } catch (e) { /* ignore */ } }
      const pingT = setInterval(() => {
        if (closed || !serverOk || !k) return;
        probe();
        if (hostAlive && Date.now() - lastHeard > CLIENT_WATCHDOG_MS) { hostAlive = false; set('no-host'); }
      }, CLIENT_PING_MS);

      connect();
      return {
        send(msg) {
          if (!cl || !serverOk || !k) return false;
          try { cl.publish(base() + 'up/' + clientId, JSON.stringify(msg), { qos: 1 }); return true; } catch (e) { return false; }
        },
        reconnect() { if (!closed && (!cl || !serverOk)) connect(); },
        close() { closed = true; clearTimeout(retryT); clearTimeout(noHostT); clearInterval(pingT); try { if (cl) cl.end(true); } catch (e) { /* ignore */ } },
      };
    },
  };

  const TRANSPORTS = { mqtt: mqttTransport, peer: peerTransport, local: localTransport };

  function pickTransport() {
    let name = 'mqtt';
    try { const q = new URLSearchParams(location.search).get('net'); if (q && TRANSPORTS[q]) name = q; } catch (e) { /* ignore */ }
    return TRANSPORTS[name];
  }

  const T = pickTransport();
  function unavailableStub(onStatus) {
    setTimeout(() => onStatus && onStatus('unavailable'), 0);
    return { broadcast: noop, send: () => false, reconnect: noop, close: noop };
  }

  window.Net = {
    transport: T.name,
    available: () => T.available(),
    createHost(opts) { return T.available() ? T.createHost(opts) : unavailableStub(opts.onStatus); },
    createClient(opts) { return T.available() ? T.createClient(opts) : unavailableStub(opts.onStatus); },
    brokers: BROKERS.map((b) => b.name),
    /** Ссылка для телефона: buzzer.html рядом с текущей страницей (работает и на GitHub Pages, и локально).
        k — секрет комнаты (топики MQTT), b — индекс брокера, с которого телефону начать. */
    joinUrl(room, key, broker) {
      const u = new URL('buzzer.html', location.href);
      u.search = '';
      u.hash = '';
      u.searchParams.set('room', room);
      if (key && T.name === 'mqtt') u.searchParams.set('k', key);
      if (T.name === 'mqtt' && broker >= 0) u.searchParams.set('b', String(broker));
      if (T.name !== 'mqtt') u.searchParams.set('net', T.name);
      return u.toString();
    },
  };

  /** QR-код как картинка (свой генератор js/qr.js, без внешних библиотек). null — если не вышло. */
  const qrCache = new Map();
  window.qrDataUrl = function (text) {
    if (qrCache.has(text)) return qrCache.get(text);
    let url = null;
    try { if (window.QR) url = window.QR.dataUrl(text, { ecl: 'M', quiet: 2 }); } catch (e) { console.warn('QR', e); url = null; }
    if (url) qrCache.set(text, url);
    return url;
  };
})();
