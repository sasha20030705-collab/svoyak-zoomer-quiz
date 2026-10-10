/* Синтезированные звуки на WebAudio — никаких файлов, работает офлайн.
   Браузер разрешает звук только после жеста пользователя: Sfx.unlock()
   вызывается на первый клик/клавишу. */
(function () {
  'use strict';
  const MUTE_KEY = 'svoyak:muted';
  // граф: эффекты → master(громкость эффектов) → компрессор → out(mute) → динамики
  //       музыка → musicBus → out(mute)
  let ctx = null, master = null, out = null, musicBus = null;
  let sfxVolume = 0.8;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* хранилище недоступно */ }
  const listeners = new Set();

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      out = ctx.createGain();
      out.gain.value = muted ? 0 : 1;
      out.connect(ctx.destination);
      master = ctx.createGain();
      master.gain.value = 0.85 * sfxVolume;
      master.connect(comp);
      comp.connect(out);
      musicBus = ctx.createGain();
      musicBus.connect(out);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** Один тон с огибающей. f2 — куда скользит частота. */
  function tone({ f = 440, f2 = null, type = 'sine', t = 0, d = 0.2, v = 0.25, a = 0.006, lp = null, detune = 0 }) {
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + t;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    o.detune.value = detune;
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + d);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    let node = o;
    if (lp) {
      const fl = c.createBiquadFilter();
      fl.type = 'lowpass';
      fl.frequency.setValueAtTime(lp, t0);
      fl.Q.value = 2;
      o.connect(fl); node = fl;
    }
    node.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + d + 0.05);
  }

  /** Шум с полосовым фильтром (свист, шорох, щелчок). */
  function noise({ t = 0, d = 0.3, v = 0.2, f0 = 800, f1 = 4000, q = 1.5, type = 'bandpass' }) {
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + t;
    const len = Math.max(1, Math.floor(c.sampleRate * d));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const fl = c.createBiquadFilter();
    fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t0);
    fl.frequency.exponentialRampToValueAtTime(f1, t0 + d);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + d * 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    src.connect(fl); fl.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + d + 0.05);
  }

  const N = (semi) => 440 * Math.pow(2, (semi - 9) / 12); // 0 = C4

  const sounds = {
    select() {
      [0, 4, 7, 12].forEach((s, i) => tone({ f: N(s + 12), type: 'square', t: i * 0.06, d: 0.12, v: 0.12, lp: 3000 }));
      noise({ t: 0, d: 0.35, v: 0.08, f0: 400, f1: 6000 });
    },
    whoosh() { noise({ d: 0.45, v: 0.18, f0: 300, f1: 5000, q: 0.8 }); },
    correct() {
      [0, 4, 7, 12, 16].forEach((s, i) => {
        tone({ f: N(s + 12), type: 'triangle', t: i * 0.07, d: 0.5, v: 0.22 });
        tone({ f: N(s + 24), type: 'sine', t: i * 0.07, d: 0.3, v: 0.06 });
      });
      tone({ f: N(24), type: 'sawtooth', t: 0.36, d: 0.7, v: 0.1, lp: 2500 });
    },
    wrong() {
      tone({ f: 220, f2: 150, type: 'sawtooth', d: 0.35, v: 0.22, lp: 900 });
      tone({ f: 165, f2: 98, type: 'sawtooth', t: 0.3, d: 0.6, v: 0.22, lp: 700, detune: 12 });
      tone({ f: 166, f2: 99, type: 'square', t: 0.3, d: 0.6, v: 0.08, lp: 500 });
    },
    buzz() {
      tone({ f: 880, type: 'square', d: 0.45, v: 0.16, lp: 4000 });
      tone({ f: 1320, type: 'sawtooth', d: 0.45, v: 0.1, lp: 5000, detune: 8 });
      tone({ f: 440, f2: 880, type: 'triangle', d: 0.15, v: 0.2 });
      noise({ d: 0.2, v: 0.12, f0: 2000, f1: 8000 });
    },
    tick() { tone({ f: 1500, type: 'sine', d: 0.06, v: 0.2 }); noise({ d: 0.04, v: 0.08, f0: 3000, f1: 4000, q: 4 }); },
    timeUp() {
      tone({ f: 330, type: 'sawtooth', d: 0.9, v: 0.18, lp: 1200 });
      tone({ f: 247, type: 'sawtooth', d: 0.9, v: 0.18, lp: 1200, detune: 7 });
    },
    fanfare() {
      const seq = [[7, 0, 0.14], [7, 0.16, 0.14], [7, 0.32, 0.14], [12, 0.5, 0.9], [9, 1.0, 0.25], [12, 1.28, 1.2]];
      seq.forEach(([s, t, d]) => {
        tone({ f: N(s + 12), type: 'sawtooth', t, d, v: 0.16, lp: 2600 });
        tone({ f: N(s), type: 'square', t, d, v: 0.08, lp: 1400 });
        tone({ f: N(s + 19), type: 'triangle', t, d, v: 0.06 });
      });
      noise({ t: 0.5, d: 1.2, v: 0.06, f0: 6000, f1: 9000, type: 'highpass' });
    },
    meow() { // кот в мешке
      tone({ f: 600, f2: 900, type: 'sawtooth', d: 0.18, v: 0.14, lp: 2200 });
      tone({ f: 900, f2: 450, type: 'sawtooth', t: 0.17, d: 0.45, v: 0.14, lp: 1800 });
      [0, 7, 12, 19].forEach((s, i) => tone({ f: N(s + 24), type: 'triangle', t: 0.6 + i * 0.07, d: 0.25, v: 0.1 }));
    },
    cash() { // аукцион: «ка-чинг»
      noise({ d: 0.12, v: 0.2, f0: 1500, f1: 3000, q: 3 });
      [2637, 3136, 3951].forEach((f, i) => tone({ f, type: 'sine', t: 0.1 + i * 0.04, d: 0.7, v: 0.12 }));
      tone({ f: 1318, type: 'triangle', t: 0.1, d: 0.5, v: 0.1 });
    },
    pop() { tone({ f: 500, f2: 1200, type: 'sine', d: 0.09, v: 0.18 }); },
    reveal() {
      noise({ d: 0.5, v: 0.12, f0: 500, f1: 7000, q: 0.7 });
      [0, 7, 12].forEach((s, i) => tone({ f: N(s + 12), type: 'triangle', t: 0.2 + i * 0.05, d: 0.5, v: 0.12 }));
    },
  };

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (out) out.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
    listeners.forEach((fn) => fn(muted));
  }

  window.Sfx = {
    unlock() { ensure(); },
    unlocked() { return !!ctx && ctx.state === 'running'; },
    play(name) {
      if (muted || !sounds[name]) return;
      try { if (ensure()) sounds[name](); } catch (e) { console.warn('sfx', e); }
    },
    isMuted: () => muted,
    /** Общий AudioContext и шина для музыки (js/music.js). */
    context: () => ensure(),
    musicBus: () => (ensure(), musicBus),
    setSfxVolume(v) {
      sfxVolume = Math.max(0, Math.min(1, Number(v)));
      if (master) master.gain.setTargetAtTime(0.85 * sfxVolume, ctx.currentTime, 0.05);
    },
    setMuted,
    toggle() { setMuted(!muted); return muted; },
    onChange(fn) { listeners.add(fn); },
  };
})();
