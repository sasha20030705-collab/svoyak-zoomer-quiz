/* ==========================================================================
   Фоновая музыка экрана гостей. Всё синтезировано на WebAudio (никаких чужих
   треков), либо — если ведущий загрузил свои файлы — играют они.

   Music.update({ mode, intensity, duck })  — вызывать часто (каждый кадр):
       mode: 'board' | 'question' | 'final' | 'off'
       intensity: 0..1 — прогресс таймера (нагнетание в «вопросе»)
       duck: true — баззер «ПЕРВЫЕ!», музыка проваливается до ~15%
   Music.stinger('correct' | 'wrong')
   Music.configure({ enabled, volume })
   Music.setCustom(mode, ArrayBuffer | null)  — свой файл вместо синтеза

   Внутри — классический планировщик с «заглядыванием вперёд» (25 мс тик,
   120 мс горизонт): ноты ставятся точно по часам AudioContext, без щелчков.
   ========================================================================== */
(function () {
  'use strict';
  const LOOKAHEAD = 0.12;
  const FADE = 1.4;            // кроссфейд лупов, сек
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  let ctx = null, out = null, duckG = null, fx = null;
  let noiseBuf = null;
  let enabled = true, volume = 0.5;
  let mode = 'off', intensity = 0, ducked = false;
  const tracks = {};           // mode → трек
  const custom = {};           // mode → AudioBuffer
  let timer = 0;

  /* ---------- инфраструктура: шина, дакинг, реверб и дилей ---------- */
  function init() {
    if (ctx) return true;
    if (!window.Sfx || !window.Sfx.context) return false;
    ctx = window.Sfx.context();
    if (!ctx) return false;
    out = ctx.createGain();
    out.gain.value = enabled ? volume * 0.6 : 0;
    duckG = ctx.createGain();
    duckG.connect(out);
    out.connect(window.Sfx.musicBus());

    // реверб: импульс из затухающего шума
    const len = Math.floor(ctx.sampleRate * 2.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const rev = ctx.createConvolver(); rev.buffer = ir;
    const revG = ctx.createGain(); revG.gain.value = 0.35;
    rev.connect(revG); revG.connect(duckG);
    // дилей 3/16 с фильтрованной обратной связью
    const dl = ctx.createDelay(1.5); dl.delayTime.value = 0.34;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const dlf = ctx.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 2400;
    const dlG = ctx.createGain(); dlG.gain.value = 0.28;
    dl.connect(dlf); dlf.connect(fb); fb.connect(dl); dlf.connect(dlG); dlG.connect(duckG);
    fx = { rev, dl };

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    tracks.board = makeTrack(boardPattern);
    tracks.question = makeTrack(tensePattern);
    tracks.final = makeTrack(finalPattern);
    timer = setInterval(schedule, 25);
    return true;
  }

  /* ---------- инструменты ---------- */
  function env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function noiseSrc(t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.start(t, Math.random() * 0.5, dur + 0.05);
    return s;
  }
  function kick(dest, t, v = 0.9) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    env(g, t, 0.004, v, 0.38);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + 0.45);
  }
  function snare(dest, t, v = 0.5, send = 0.4) {
    const n = noiseSrc(t, 0.25), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
    env(g, t, 0.002, v, 0.2);
    n.connect(f); f.connect(g); g.connect(dest);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    env(og, t, 0.002, v * 0.6, 0.1);
    o.connect(og); og.connect(dest); o.start(t); o.stop(t + 0.15);
    if (send) { const sg = ctx.createGain(); sg.gain.value = send; g.connect(sg); sg.connect(fx.rev); }
  }
  function hat(dest, t, v = 0.18, open = false) {
    const n = noiseSrc(t, open ? 0.3 : 0.06), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'highpass'; f.frequency.value = 7500;
    env(g, t, 0.001, v, open ? 0.26 : 0.045);
    n.connect(f); f.connect(g); g.connect(dest);
  }
  function bass(dest, t, note, dur, cutoff = 520, v = 0.42) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.Q.value = 7;
    f.frequency.setValueAtTime(cutoff * 2.2, t);
    f.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(0.25, dur));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.008);
    g.gain.setValueAtTime(v, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o1.frequency.value = midi(note);
    o2.type = 'sine'; o2.frequency.value = midi(note - 12);
    const sub = ctx.createGain(); sub.gain.value = 0.9;
    o1.connect(f); o2.connect(sub); sub.connect(g); f.connect(g); g.connect(dest);
    o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  function stab(dest, t, notes, dur, cutoff = 1800, v = 0.07, send = 0.5, delay = 0.35) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.setValueAtTime(cutoff, t); f.frequency.exponentialRampToValueAtTime(cutoff * 0.4, t + dur); f.Q.value = 2;
    env(g, t, 0.006, v, dur);
    notes.forEach((n) => [-7, 7].forEach((det) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.1);
    }));
    f.connect(g); g.connect(dest);
    if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(fx.rev); }
    if (delay) { const s = ctx.createGain(); s.gain.value = delay; g.connect(s); s.connect(fx.dl); }
  }
  function pad(dest, t, notes, dur, cutoff = 900, v = 0.035) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.6, dur / 3));
    g.gain.setValueAtTime(v, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    notes.forEach((n, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sawtooth'; o.frequency.value = midi(n); o.detune.value = (i - 1.5) * 6;
      o.connect(f); o.start(t); o.stop(t + dur + 0.4);
    });
    f.connect(g); g.connect(dest);
    const s = ctx.createGain(); s.gain.value = 0.6; g.connect(s); s.connect(fx.rev);
  }
  function pluck(dest, t, note, v = 0.06, delay = 0.5, type = 'square') {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = type; o.frequency.value = midi(note);
    f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.18);
    env(g, t, 0.003, v, 0.22);
    o.connect(f); f.connect(g); g.connect(dest);
    o.start(t); o.stop(t + 0.3);
    if (delay) { const s = ctx.createGain(); s.gain.value = delay; g.connect(s); s.connect(fx.dl); }
  }
  function riser(dest, t, dur, v = 0.1) {
    const n = noiseSrc(t, dur), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(7000, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + dur * 0.95); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(dest);
  }

  /* ---------- паттерны (16 шагов в такте) ---------- */
  // «Табло»: расслабленный, но качающий луп в ля миноре, 8 тактов
  const BOARD_CHORDS = [
    { b: 45, c: [60, 64, 67, 71] }, { b: 45, c: [60, 64, 67, 71] },   // Am9
    { b: 41, c: [57, 60, 64, 67] }, { b: 41, c: [57, 60, 64, 67] },   // Fmaj7
    { b: 48, c: [55, 59, 64, 67] }, { b: 48, c: [55, 59, 64, 67] },   // Cmaj7
    { b: 43, c: [59, 62, 64, 67] }, { b: 43, c: [59, 62, 66, 69] },   // G6 → D/G
  ];
  function boardPattern(d, step, t, spb) {
    const bar = Math.floor(step / 16) % 8, s = step % 16, ch = BOARD_CHORDS[bar];
    if (s === 0 || s === 7 || s === 10 || (s === 15 && bar % 2)) kick(d, t, s === 0 ? 0.85 : 0.6);
    if (s === 4 || s === 12) snare(d, t, 0.32, 0.45);
    if (s % 2 === 0) hat(d, t, s % 4 === 2 ? 0.16 : 0.08, s === 14 && bar % 2 === 1);
    if (s === 0) bass(d, t, ch.b, spb * 3, 480);
    if (s === 7) bass(d, t, ch.b, spb * 2, 520, 0.36);
    if (s === 10) bass(d, t, ch.b + 12, spb * 2, 560, 0.3);
    if (s === 14) bass(d, t, ch.b + 7, spb, 520, 0.28);
    if (s === 2 || s === 6 || s === 10 || s === 14) stab(d, t, ch.c, spb * 1.2, 2000, 0.05);
    if (s === 0 && bar % 2 === 0) pad(d, t, ch.c.map((n) => n - 12), spb * 32, 800, 0.03);
    if (bar % 4 === 3 && (s === 0 || s === 3 || s === 6 || s === 8)) pluck(d, t, ch.c[[0, 2, 3, 1][s % 4]] + 12, 0.045);
  }

  // «Вопрос»: напряжённый луп в ми миноре; intensity = прогресс таймера
  const TENSE_BASS = [40, 40, 36, 35];
  const TENSE_PAD = [[52, 55, 59], [52, 55, 59], [48, 52, 55], [47, 51, 54]];
  function tensePattern(d, step, t, spb, i) {
    const bar = Math.floor(step / 16) % 4, s = step % 16;
    const root = TENSE_BASS[bar];
    if (s % 4 === 0) kick(d, t, 0.45 + i * 0.4);
    if (i > 0.55 && (s === 14 || s === 15) && bar === 3) kick(d, t, 0.5);
    hat(d, t, (s % 4 === 0 ? 0.13 : 0.06) + i * 0.06);
    if (s % 2 === 0) bass(d, t, s % 4 === 2 ? root + 12 : root, spb * 1.6, 260 + 2200 * i * i, 0.34);
    if (i > 0.3 && (s === 4 || s === 12)) snare(d, t, 0.22 + i * 0.25, 0.3);
    if (i > 0.4) {
      const arp = TENSE_PAD[bar].concat(TENSE_PAD[bar].map((n) => n + 12));
      pluck(d, t, arp[(step * 3) % arp.length] + 12, 0.02 + (i - 0.4) * 0.07, 0.4);
    }
    if (s === 0) pad(d, t, TENSE_PAD[bar], spb * 16, 500 + 1500 * i, 0.03 + i * 0.02);
    // последние секунды: дробь малого и шумовой подъём к большому отсчёту
    if (i > 0.83) {
      snare(d, t, 0.12 + (i - 0.83) * 1.8, 0.2);
      if (s === 0) riser(d, t, spb * 16, 0.08 + (i - 0.83) * 0.5);
    }
  }

  // «Финал»: торжественный половинный ритм в ре миноре
  const FINAL_CHORDS = [{ b: 38, c: [62, 65, 69] }, { b: 34, c: [62, 65, 70] }, { b: 41, c: [60, 65, 69] }, { b: 36, c: [60, 64, 67] }];
  function finalPattern(d, step, t, spb, i) {
    const bar = Math.floor(step / 32) % 4, s = step % 16, ch = FINAL_CHORDS[bar];
    if (s === 0 || s === 10) kick(d, t, 0.8);
    if (s === 8) snare(d, t, 0.4, 0.8);
    if (s % 4 === 2) hat(d, t, 0.06 + i * 0.08);
    if (s === 0 && step % 32 === 0) { bass(d, t, ch.b, spb * 30, 380, 0.38); pad(d, t, ch.c.concat(ch.c[0] + 12), spb * 32, 1100 + i * 1400, 0.045); }
    if (s % 4 === 0 && i > 0.2) pluck(d, t, ch.c[(step / 4) % 3 | 0] + 12, 0.03 + i * 0.03, 0.5, 'triangle');
    if (i > 0.83 && s === 0 && step % 32 === 0) riser(d, t, spb * 32, 0.12);
  }

  /* ---------- треки и планировщик ---------- */
  function makeTrack(pattern) {
    return { pattern, gain: null, active: false, next: 0, step: 0, src: null, stopAt: 0 };
  }
  const BPM = { board: () => 96, question: (i) => 112 + 30 * i, final: (i) => 76 + 10 * i };

  function startTrack(name) {
    const tr = tracks[name];
    if (!tr) return;
    const now = ctx.currentTime;
    if (!tr.gain || tr.stopAt) {
      if (tr.gain) try { tr.gain.disconnect(); } catch (e) { /* ignore */ }
      tr.gain = ctx.createGain();
      tr.gain.gain.value = 0.0001;
      tr.gain.connect(duckG);
    }
    tr.gain.gain.cancelScheduledValues(now);
    tr.gain.gain.setValueAtTime(Math.max(0.0001, tr.gain.gain.value), now);
    tr.gain.gain.exponentialRampToValueAtTime(1, now + FADE);
    tr.stopAt = 0;
    if (!tr.active) {
      tr.active = true; tr.next = now + 0.05; tr.step = 0;
      if (custom[name]) { // свой файл: просто зацикленный буфер через тот же гейн (дакинг работает)
        tr.src = ctx.createBufferSource();
        tr.src.buffer = custom[name]; tr.src.loop = true;
        tr.src.connect(tr.gain); tr.src.start(now + 0.05);
      }
    }
  }
  function stopTrack(name) {
    const tr = tracks[name];
    if (!tr || !tr.active || tr.stopAt) return;
    const now = ctx.currentTime;
    tr.gain.gain.cancelScheduledValues(now);
    tr.gain.gain.setValueAtTime(Math.max(0.0001, tr.gain.gain.value), now);
    tr.gain.gain.exponentialRampToValueAtTime(0.0001, now + FADE);
    tr.stopAt = now + FADE + 0.1;
  }

  function schedule() {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    Object.keys(tracks).forEach((name) => {
      const tr = tracks[name];
      if (!tr.active) return;
      if (tr.stopAt && now > tr.stopAt) {
        tr.active = false;
        if (tr.src) { try { tr.src.stop(); } catch (e) { /* ignore */ } tr.src = null; }
        try { tr.gain.disconnect(); } catch (e) { /* ignore */ }
        tr.gain = null; tr.stopAt = 0;
        return;
      }
      if (tr.src) return; // свой файл играет сам
      const i = name === mode ? intensity : 0;
      const spb = 60 / BPM[name](i) / 4; // длительность шестнадцатой
      if (tr.next < now - 0.2) tr.next = now + 0.02; // вкладка спала — не догоняем
      while (tr.next < now + LOOKAHEAD) {
        try { tr.pattern(tr.gain, tr.step, tr.next, spb, i); } catch (e) { console.warn('music', e); }
        // лёгкий свинг на чётных шестнадцатых у «табло»
        tr.next += spb * (name === 'board' ? (tr.step % 2 ? 0.88 : 1.12) : 1);
        tr.step++;
      }
    });
  }

  /* ---------- публичный интерфейс ---------- */
  function update(o) {
    // до первого клика по экрану звук запрещён браузером — ничего не создаём
    if (!ctx && !(window.Sfx && window.Sfx.unlocked())) return;
    if (!init()) return;
    if (typeof o.intensity === 'number') intensity = Math.max(0, Math.min(1, o.intensity));
    const want = enabled ? (o.mode || 'off') : 'off';
    if (want !== mode) {
      mode = want;
      Object.keys(tracks).forEach((n) => { if (n !== mode) stopTrack(n); });
      if (mode !== 'off') startTrack(mode);
    }
    const d = !!o.duck;
    if (d !== ducked) {
      ducked = d;
      const now = ctx.currentTime;
      duckG.gain.cancelScheduledValues(now);
      duckG.gain.setTargetAtTime(d ? 0.15 : 1, now, d ? 0.03 : 0.35);
    }
  }

  function stinger(kind) {
    if (!init() || !enabled || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.02;
    const g = ctx.createGain(); g.gain.value = 1.4; g.connect(out);
    if (kind === 'correct') {
      stab(g, t, [72, 76, 79, 84], 0.9, 4200, 0.07, 0.8, 0.5);
      stab(g, t + 0.14, [79, 84, 88], 0.8, 5000, 0.05, 0.8, 0.4);
      kick(g, t, 0.7);
    } else {
      stab(g, t, [40, 46, 51], 0.7, 900, 0.09, 0.6, 0);
      kick(g, t, 0.8);
    }
    setTimeout(() => { try { g.disconnect(); } catch (e) { /* ignore */ } }, 3000);
  }

  function configure(o) {
    if (typeof o.volume === 'number') volume = Math.max(0, Math.min(1, o.volume));
    if (typeof o.enabled === 'boolean') enabled = o.enabled;
    if (out) out.gain.setTargetAtTime(enabled ? volume * 0.6 : 0, ctx.currentTime, 0.2);
    if (!enabled && ctx) update({ mode: 'off' });
  }

  /** Свой файл для режима (ArrayBuffer) или null — вернуться к синтезу. */
  async function setCustom(name, arrayBuf) {
    if (!init()) return false;
    if (!arrayBuf) { delete custom[name]; }
    else {
      try { custom[name] = await ctx.decodeAudioData(arrayBuf.slice(0)); } catch (e) { console.warn('music decode', e); delete custom[name]; return false; }
    }
    // перезапускаем трек, если он сейчас играет
    const tr = tracks[name];
    if (tr && tr.active) {
      if (tr.src) { try { tr.src.stop(); } catch (e) { /* ignore */ } tr.src = null; }
      tr.active = false;
      if (tr.gain) try { tr.gain.disconnect(); } catch (e) { /* ignore */ }
      tr.gain = null;
      if (mode === name) startTrack(name);
    }
    return true;
  }

  window.Music = { update, stinger, configure, setCustom, get mode() { return mode; } };
})();
