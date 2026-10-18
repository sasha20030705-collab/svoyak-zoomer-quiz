/* ==========================================================================
   Отрывок трека для вопросов type: "audio". Общий плеер экрана и пульта.
   Состояние воспроизведения живёт в Store (current.audio): плеер только
   догоняет его — seek по смене seq, play/pause по фазе, стоп на start+dur.
   Источник — внешний URL превью (CORS → AnalyserNode для эквалайзера; без
   CORS — повторная загрузка без crossOrigin и синтетическая анимация) или
   blob: своего файла из IndexedDB.
   ========================================================================== */
(function () {
  'use strict';
  const U = window.QuizUtil;

  /**
   * ClipPlayer({ context, muted, onStatus })
   *   context(): AudioContext в состоянии running или null — для анализатора;
   *   muted(): глушить ли звук (кнопка «звук на экране» на пульте);
   *   onStatus(st): ok | blocked | error | ended.
   */
  function ClipPlayer(opts) {
    opts = opts || {};
    let el = null, src = '', cors = false, triedPlain = false;
    let graph = null, lastSeq = -1, startSec = 0, pendingSeek = null;
    let status = '', playReq = null, blockedAt = 0, silentFrames = 0, target = null, fixes = 0;

    function report(st) {
      if (st === status) return;
      status = st;
      if (opts.onStatus) try { opts.onStatus(st); } catch (e) { console.warn(e); }
    }
    function destroy() {
      if (!el) return;
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { /* ignore */ }
      el.remove();
      el = null; graph = null;
    }
    function make(withCors) {
      destroy();
      el = document.createElement('audio');
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      if (withCors) el.crossOrigin = 'anonymous';
      el.className = 'clip-audio';
      el.style.display = 'none';
      document.body.appendChild(el);
      const me = el;
      el.addEventListener('error', () => { if (me === el) onError(); });
      el.addEventListener('ended', () => { if (me === el) report('ended'); });
      el.addEventListener('playing', () => { if (me === el) report('ok'); });
      el.addEventListener('loadedmetadata', () => { if (me === el && pendingSeek !== null) seek(pendingSeek); });
      // WebKit: seek сразу перед play() иногда «приземляется» на старую позицию — переставляем
      el.addEventListener('seeked', () => {
        if (me !== el || target === null) return;
        if (Math.abs(el.currentTime - target) > 0.4 && fixes < 3) { fixes++; try { el.currentTime = target; } catch (e) { /* ignore */ } } else target = null;
      });
      lastSeq = -1;
    }
    function onError() {
      // CORS-заголовков нет — грузим ещё раз «как есть» (без анализатора)
      if (cors && !triedPlain && /^https?:/.test(src)) {
        triedPlain = true; cors = false;
        make(false);
        el.src = src; el.load();
        return;
      }
      report('error');
    }
    function seek(t) {
      if (!el) return;
      if (el.readyState >= 1) {
        target = Math.max(0, t); fixes = 0;
        try { el.currentTime = target; pendingSeek = null; } catch (e) { pendingSeek = t; }
      } else pendingSeek = t;
    }
    function ensureGraph() {
      if (graph || !el || !opts.context) return;
      if (!(cors || /^blob:/.test(src))) return;
      const ctx = opts.context();
      if (!ctx || ctx.state !== 'running') return; // в спящем контексте элемент онемеет
      try {
        const node = ctx.createMediaElementSource(el);
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        an.smoothingTimeConstant = 0.72;
        node.connect(an); an.connect(ctx.destination);
        graph = { an, data: new Uint8Array(an.frequencyBinCount) };
      } catch (e) { console.warn('clip analyser', e); graph = { an: null }; }
    }
    function tryPlay(gesture) {
      // play() — после seeked (следующий sync); в жесте клика — сразу, иначе Safari не пустит звук
      if (!el || playReq || (el.seeking && !gesture)) return;
      ensureGraph();
      let p;
      try { p = el.play(); } catch (e) { p = Promise.reject(e); }
      if (!p || !p.then) return;
      playReq = p;
      p.then(() => { playReq = null; blockedAt = 0; }, (err) => {
        playReq = null;
        if (err && err.name === 'NotAllowedError') { blockedAt = Date.now(); report('blocked'); }
        else if (err && err.name !== 'AbortError') console.warn('clip play', err);
      });
    }

    return {
      /** Новый источник: грузится сразу (preload=auto). */
      load(newSrc, o) {
        if (newSrc === src && el) return;
        src = newSrc || '';
        cors = !!(o && o.cors) && /^https?:/.test(src);
        triedPlain = false; status = ''; pendingSeek = null; silentFrames = 0;
        if (!src) { destroy(); return; }
        make(cors);
        el.src = src;
        try { el.load(); } catch (e) { /* ignore */ }
      },
      /** Догнать состояние Store. a — current.audio, start — секунда начала отрывка в файле. */
      sync(a, start, active) {
        if (!el) return;
        const mute = !!(opts.muted && opts.muted());
        if (el.muted !== mute) el.muted = mute;
        if (!active || !a) { if (!el.paused) el.pause(); return; }
        startSec = start || 0;
        const pos = U.clipPos(a);
        // новая команда ведущего — встаём на заданную точку (без учёта задержки сети: «↺» на удалённом экране — с самого начала)
        if (a.seq !== lastSeq) { lastSeq = a.seq; seek(startSec + Math.max(0, Math.min(a.dur, a.pos))); if (status === 'ended') status = ''; }
        const end = startSec + a.dur;
        // фаза из Store + своё время элемента: старт мог запоздать на загрузку — доигрываем до конца отрывка
        const live = a.playing && U.now() >= a.at && pos < a.dur + 4;
        const want = live && status !== 'ended' && el.currentTime < end - 0.03;
        if (want && el.paused) {
          // заблокировано автоплеем — не долбим play() каждый кадр, ждём клика (kick) или 2 с
          if (!blockedAt || Date.now() - blockedAt > 2000) tryPlay();
        } else if (!want && !el.paused) el.pause();
      },
      /** play() внутри жеста пользователя (разблокировать автоплей). */
      kick() { blockedAt = 0; if (el && el.paused) tryPlay(true); },
      stop() { if (el && !el.paused) el.pause(); },
      unload() { src = ''; destroy(); },
      /** n полос 0..1 из анализатора или null (нет CORS/контекста — рисуем синтетику). */
      levels(n) {
        if (!graph || !graph.an || !el || el.paused) return null;
        const d = graph.data;
        graph.an.getByteFrequencyData(d);
        const out = new Array(n);
        let sum = 0;
        const bins = d.length * 0.72; // верх спектра у AAC-превью пустой
        for (let i = 0; i < n; i++) {
          const a0 = Math.floor(Math.pow(i / n, 1.6) * bins), a1 = Math.max(a0 + 1, Math.floor(Math.pow((i + 1) / n, 1.6) * bins));
          let m = 0;
          for (let k = a0; k < a1; k++) m = Math.max(m, d[k]);
          out[i] = m / 255;
          sum += m;
        }
        // тишина при играющем треке дольше секунды — значит, данные закрыты (taint): синтетика
        silentFrames = sum ? 0 : silentFrames + 1;
        return silentFrames > 60 ? null : out;
      },
      get el() { return el; },
      get src() { return src; },
      get status() { return status; },
      get analyser() { return !!(graph && graph.an); },
      get paused() { return !el || el.paused; },
      /** секунда внутри отрывка по самому элементу */
      get time() { return el ? Math.max(0, el.currentTime - startSec) : 0; },
    };
  }

  /** Ленивая предзагрузка всех превью: по одному, preload=auto, с тем же режимом CORS. */
  function ClipPreload(urls) {
    const queue = Array.from(new Set((urls || []).filter((u) => /^https?:/.test(u || ''))));
    const keep = [];
    const next = () => {
      const u = queue.shift();
      if (!u) return;
      const a = new Audio();
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(t); setTimeout(next, 150); };
      const t = setTimeout(fin, 15000);
      a.addEventListener('canplaythrough', fin, { once: true });
      a.addEventListener('error', fin, { once: true });
      a.src = u;
      try { a.load(); } catch (e) { fin(); }
      keep.push(a);
    };
    next();
    return keep;
  }

  window.ClipPlayer = ClipPlayer;
  window.ClipPreload = ClipPreload;
})();
