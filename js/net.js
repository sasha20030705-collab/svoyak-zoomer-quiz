/* ==========================================================================
   Сетевой транспорт «пульт ↔ телефоны». Ничего не знает об игре —
   только доставляет JSON-сообщения. Интерфейс (одинаковый для всех транспортов):

     const host = Net.createHost({ room, onMessage(clientId, msg), onLeave(clientId), onStatus(status, info) })
       host.broadcast(msg)        — всем подключённым телефонам
       host.send(clientId, msg)   — одному телефону
       host.close()
     const client = Net.createClient({ room, clientId, onMessage(msg), onStatus(status, info) })
       client.send(msg) → true/false
       client.reconnect()          — принудительно (например, после разблокировки экрана)
       client.close()

   status: 'connecting' | 'online' | 'offline' | 'no-host' (клиент: пульт не найден)
           | 'id-taken' (хост: peer id занят) | 'unavailable' (транспорт не загрузился)

   Транспорты:
     peer  — PeerJS (WebRTC) через публичный PeerJS cloud, по умолчанию.
     local — BroadcastChannel внутри одного браузера (для тестов): ?net=local.
   Чтобы добавить, например, MQTT (wss://broker.hivemq.com:8884/mqtt), достаточно
   написать объект с теми же createHost/createClient и зарегистрировать его в TRANSPORTS.
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

  const TRANSPORTS = { peer: peerTransport, local: localTransport };

  function pickTransport() {
    let name = 'peer';
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
    /** Ссылка для телефона: buzzer.html рядом с текущей страницей (работает и на GitHub Pages, и локально). */
    joinUrl(room) {
      const u = new URL('buzzer.html', location.href);
      u.searchParams.set('room', room);
      if (T.name !== 'peer') u.searchParams.set('net', T.name);
      return u.toString();
    },
  };

  /** QR-код (qrcodejs с cdnjs) как data URL картинки; кэшируется. Без библиотеки — null (остаются код и ссылка). */
  const qrCache = new Map();
  window.qrDataUrl = function (text, size = 256) {
    const key = text + '|' + size;
    if (qrCache.has(key)) return qrCache.get(key);
    let url = null;
    if (typeof window.QRCode === 'function') {
      try {
        const div = document.createElement('div');
        new window.QRCode(div, { text, width: size, height: size, colorDark: '#0A0A0A', colorLight: '#FFFFFF', correctLevel: window.QRCode.CorrectLevel.M });
        const c = div.querySelector('canvas');
        url = c ? c.toDataURL('image/png') : null;
      } catch (e) { url = null; }
    }
    if (url) qrCache.set(key, url);
    return url;
  };
})();
