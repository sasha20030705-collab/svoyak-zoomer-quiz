/* ==========================================================================
   Фоновая музыка экрана гостей. Всё синтезировано на WebAudio (никаких чужих
   треков и сэмплов), либо — если ведущий загрузил свои файлы — играют они.

   Три встроенных стиля для «табло» и «вопроса» (финал — общий):
     phonk — фонк: 808 со скольжением, ковбелл-мелодия, хэты триолями
     show  — шоу: «телевизионная» брасс-тема / музыка размышлений с часами
     chip  — 8-бит: пульс-волны, треугольный бас, шумовые ударные / «бомба»

   Music.update({ mode, intensity, duck, remain })  — вызывать часто (каждый кадр):
       mode: 'board' | 'question' | 'final' | 'off'
       intensity: 0..1 — прогресс таймера (нагнетание в «вопросе»)
       remain: секунд до конца таймера (Infinity — таймер не идёт): дробь на 5…1
       duck: true — баззер «ПЕРВЫЕ!», музыка проваливается до ~15%
   Music.stinger('correct' | 'wrong')
   Music.configure({ enabled, volume, style })
   Music.setCustom(mode, ArrayBuffer | null)  — свой файл вместо синтеза (приоритет)
   Music.preview({ style, mode, seconds, volume }) / Music.stopPreview()
       — прослушка на пульте (свой AudioContext прямо в динамики пульта)
   Music.render({ style, mode, seconds, sampleRate }) → Promise<{buffer, seams}>
       — офлайн-рендер (OfflineAudioContext) для проверки уровней

   Внутри — планировщик с «заглядыванием вперёд» (25 мс тик, 120 мс горизонт):
   ноты ставятся точно по часам AudioContext, сетка 12 тиков на долю
   (шестнадцатые = 3 тика, триоли восьмыми = 4, триоли шестнадцатыми = 2).
   Цепочка: треки → дакинг → компрессор → лимитер → мягкий клиппер (≤ −1.2 dBFS) → громкость.
   ========================================================================== */
(function () {
  'use strict';
  const LOOKAHEAD = 0.12;
  const FADE = 1.4;            // кроссфейд лупов, сек
  const OUT_SCALE = 0.6;       // громкость ползунка × это = выход
  const STYLES = ['phonk', 'show', 'chip'];
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  const engines = new Set();   // живые движки (экран, превью) — общий таймер
  let ticker = 0;
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => engines.forEach((E) => { try { E.tick(); } catch (e) { console.warn('music', e); } }), 25);
  }

  /* ======================================================================
     ДВИЖОК: граф + инструменты + паттерны на конкретном AudioContext
     ====================================================================== */
  function createEngine(ctx, dest, outGain) {
    const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

    /* ---------- мастер: дакинг → компрессор → лимитер → клиппер → громкость ---------- */
    const mix = ctx.createGain();
    const duckG = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
    const makeup = ctx.createGain(); makeup.gain.value = 1;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    const clip = ctx.createWaveShaper();
    {
      const n = 2049, c = new Float32Array(n), A = 0.87; // y = A·tanh(x/A): линейно в тишине, потолок ≈ −1.2 dBFS
      for (let k = 0; k < n; k++) { const x = (k / (n - 1)) * 2 - 1; c[k] = A * Math.tanh(x / A); }
      clip.curve = c; clip.oversample = '2x';
    }
    const out = ctx.createGain(); out.gain.value = outGain;
    mix.connect(duckG); duckG.connect(comp); comp.connect(makeup); makeup.connect(lim); lim.connect(clip); clip.connect(out); out.connect(dest);
    const post = ctx.createGain(); post.connect(comp); // стингеры: мимо дакинга

    // реверб: импульс из затухающего шума
    const len = Math.floor(ctx.sampleRate * 2.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let k = 0; k < len; k++) d[k] = (Math.random() * 2 - 1) * Math.pow(1 - k / len, 3);
    }
    const rev = ctx.createConvolver(); rev.buffer = ir;
    const revG = ctx.createGain(); revG.gain.value = 0.35;
    rev.connect(revG); revG.connect(mix);
    // дилей 3/16 с фильтрованной обратной связью
    const dl = ctx.createDelay(1.5); dl.delayTime.value = 0.32;
    const fb = ctx.createGain(); fb.gain.value = 0.3;
    const dlf = ctx.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 2400;
    const dlG = ctx.createGain(); dlG.gain.value = 0.28;
    dl.connect(dlf); dlf.connect(fb); fb.connect(dl); dlf.connect(dlG); dlG.connect(mix);

    // шум: обычный и «чиповый» (sample&hold — хрустит как NES)
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const chipBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    {
      const a = noiseBuf.getChannelData(0), b = chipBuf.getChannelData(0);
      let h = 0;
      for (let k = 0; k < a.length; k++) { a[k] = Math.random() * 2 - 1; if (k % 5 === 0) h = Math.random() < 0.5 ? -0.8 : 0.8; b[k] = h; }
    }
    // кривая насыщения для 808
    const satCurve = new Float32Array(1025);
    for (let k = 0; k < 1025; k++) { const x = (k / 1024) * 2 - 1; satCurve[k] = Math.tanh(x * 3.2) / Math.tanh(3.2); }
    const waves = {};
    function pulseWave(duty) {
      if (waves[duty]) return waves[duty];
      const N = 40, re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
      return (waves[duty] = ctx.createPeriodicWave(re, im));
    }

    /* ---------- примитивы ---------- */
    // по умолчанию 0.0001: огибающая начинается с тишины даже на субсэмпловом старте источника (иначе — щелчок)
    const G = (v = 0.0001) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const O = (type, f) => { const o = ctx.createOscillator(); if (type) o.type = type; if (f) o.frequency.value = f; return o; };
    const F = (type, f, q) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; if (q != null) x.Q.value = q; return x; };
    function env(p, t, a, peak, d) {
      p.setValueAtTime(0.0001, t);
      p.exponentialRampToValueAtTime(peak, t + a);
      p.exponentialRampToValueAtTime(0.0001, t + a + d);
    }
    /** атака → спад к sus·peak → держим до t+dur → релиз. Возвращает время конца. */
    function adsr(p, t, a, peak, dec, sus, dur, rel) {
      const s = Math.max(0.0001, peak * sus);
      const t1 = t + a, t2 = Math.max(t1 + 0.001, Math.min(t + dur, t1 + dec)), t3 = Math.max(t2 + 0.001, t + dur);
      p.setValueAtTime(0.0001, t);
      p.exponentialRampToValueAtTime(peak, t1);
      p.exponentialRampToValueAtTime(s, t2);
      p.setValueAtTime(s, t3);
      p.exponentialRampToValueAtTime(0.0001, t3 + rel);
      return t3 + rel;
    }
    function send(D, g, r, d) {
      if (r && D.rev) { const s = G(r); g.connect(s); s.connect(D.rev); }
      if (d && D.dl) { const s = G(d); g.connect(s); s.connect(D.dl); }
    }
    function noiseSrc(t, dur, buf) {
      const s = ctx.createBufferSource();
      s.buffer = buf || noiseBuf; s.loop = true;
      s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
      return s;
    }

    /* ---------- ударные ---------- */
    function kick(D, t, v = 0.9, f0 = 150, f1 = 45, dec = 0.32) {
      const o = O('sine'), g = G();
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
      env(g.gain, t, 0.003, v, dec);
      o.connect(g); g.connect(D.o); o.start(t); o.stop(t + dec + 0.05);
    }
    function snare(D, t, v = 0.5, rv = 0.4, tone = 1900, dec = 0.2) {
      const n = noiseSrc(t, dec + 0.05), f = F('bandpass', tone, 0.8), g = G();
      env(g.gain, t, 0.002, v, dec);
      n.connect(f); f.connect(g); g.connect(D.o);
      const o = O('triangle'), og = G();
      o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
      env(og.gain, t, 0.002, v * 0.6, 0.1);
      o.connect(og); og.connect(D.o); o.start(t); o.stop(t + 0.15);
      send(D, g, rv, 0);
    }
    function clap(D, t, v = 0.5, rv = 0.4) {
      const n = noiseSrc(t, 0.3), f = F('bandpass', 1150, 1.1), g = G(), p = g.gain;
      p.setValueAtTime(0.0001, t);
      [0, 0.011, 0.022].forEach((o) => { p.exponentialRampToValueAtTime(v, t + o + 0.001); p.exponentialRampToValueAtTime(v * 0.25, t + o + 0.01); });
      p.exponentialRampToValueAtTime(v * 0.8, t + 0.034);
      p.exponentialRampToValueAtTime(0.0001, t + 0.24);
      n.connect(f); f.connect(g); g.connect(D.o);
      send(D, g, rv, 0);
    }
    function hat(D, t, v = 0.18, dec = 0.045, hp = 7500) {
      const n = noiseSrc(t, dec + 0.02), f = F('highpass', hp), g = G();
      env(g.gain, t, 0.001, v, dec);
      n.connect(f); f.connect(g); g.connect(D.o);
    }
    function crash(D, t, v = 0.2, dec = 1.5) {
      const n = noiseSrc(t, dec + 0.1), f = F('highpass', 4800), g = G();
      env(g.gain, t, 0.002, v, dec);
      n.connect(f); f.connect(g); g.connect(D.o);
      // металл: шесть квадратов с негармоничными частотами
      const mf = F('highpass', 6500), mg = G();
      env(mg.gain, t, 0.002, v * 0.35, dec * 0.7);
      [205.3, 304.4, 369.6, 522.7, 540, 800].forEach((fr) => { const o = O('square', fr * 2); o.connect(mf); o.start(t); o.stop(t + dec); });
      mf.connect(mg); mg.connect(D.o);
      send(D, g, 0.3, 0);
    }
    function riser(D, t, dur, v = 0.1) {
      const n = noiseSrc(t, dur), f = F('bandpass', 400, 3), g = G();
      f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(7000, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + dur * 0.95); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(f); f.connect(g); g.connect(D.o);
    }

    /* ---------- фонк ---------- */
    /** 808: синус с «костяшкой» в атаке, скольжением и насыщением. */
    function b808(D, t, note, dur, v = 0.8, slideTo = null, slideAt = 0) {
      const o = O('sine'), g = G(), ws = ctx.createWaveShaper(), lp = F('lowpass', 1600, 0.7), pg = G(0.42);
      ws.curve = satCurve;
      const f = midi(note);
      o.frequency.setValueAtTime(f * 2.2, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
      if (slideTo != null) {
        const sa = Math.max(t + 0.04, slideAt);
        o.frequency.setValueAtTime(f, sa);
        o.frequency.exponentialRampToValueAtTime(midi(slideTo), sa + 0.08);
      }
      const p = g.gain;
      p.setValueAtTime(0.0001, t);
      p.exponentialRampToValueAtTime(v, t + 0.004);
      p.exponentialRampToValueAtTime(v * 0.45, t + Math.max(0.01, dur));
      p.exponentialRampToValueAtTime(0.0001, t + Math.max(0.01, dur) + 0.06);
      o.connect(g); g.connect(ws); ws.connect(lp); lp.connect(pg); pg.connect(D.o);
      o.start(t); o.stop(t + dur + 0.1);
    }
    /** Ковбелл drift-phonk: два детюненых квадрата (≈540/800 Гц → по высоте ноты) через полосовой фильтр. */
    function cowbell(D, t, note, v = 0.22, dec = 0.28) {
      const f1 = midi(note), f2 = f1 * 1.4815;
      const o1 = O('square', f1), o2 = O('square', f2);
      o1.detune.value = -7; o2.detune.value = 6;
      const bp = F('bandpass', f1 * 1.9, 1.3), g = G(), p = g.gain;
      p.setValueAtTime(0.0001, t);
      p.exponentialRampToValueAtTime(v, t + 0.0015);
      p.exponentialRampToValueAtTime(v * 0.3, t + 0.03);
      p.exponentialRampToValueAtTime(0.0001, t + dec);
      o1.connect(bp); o2.connect(bp); bp.connect(g); g.connect(D.o);
      o1.start(t); o2.start(t); o1.stop(t + dec + 0.02); o2.stop(t + dec + 0.02);
      send(D, g, 0.22, 0.2);
    }
    function pad(D, t, notes, dur, cutoff = 900, v = 0.035) {
      const f = F('lowpass', cutoff), g = G();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.6, dur / 3));
      g.gain.setValueAtTime(v, t + dur * 0.75);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
      notes.forEach((n, k) => {
        const o = O(k % 2 ? 'triangle' : 'sawtooth', midi(n)); o.detune.value = (k - 1.5) * 6;
        o.connect(f); o.start(t); o.stop(t + dur + 0.4);
      });
      f.connect(g); g.connect(D.o);
      send(D, g, 0.6, 0);
    }

    /* ---------- шоу ---------- */
    function brass(D, t, notes, dur, v = 0.05, bright = 1) {
      const f = F('lowpass', 350, 1.4), g = G();
      f.frequency.setValueAtTime(350, t);
      f.frequency.exponentialRampToValueAtTime(2800 * bright, t + 0.05);
      f.frequency.exponentialRampToValueAtTime(1300 * bright, t + 0.25);
      const end = adsr(g.gain, t, 0.022, v, 0.15, 0.72, dur, 0.09);
      notes.forEach((n) => [-8, 8].forEach((det) => { const o = O('sawtooth', midi(n)); o.detune.value = det; o.connect(f); o.start(t); o.stop(end + 0.02); }));
      f.connect(g); g.connect(D.o);
      send(D, g, 0.35, 0);
    }
    function trumpet(D, t, note, dur, v = 0.07) {
      const o = O('sawtooth', midi(note)), o2 = O('square', midi(note)), g2 = G(0.3);
      const f = F('lowpass', 600, 1.2), g = G();
      f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(3400, t + 0.04); f.frequency.exponentialRampToValueAtTime(2100, t + 0.2);
      const end = adsr(g.gain, t, 0.018, v, 0.1, 0.8, dur, 0.06);
      if (dur > 0.3) { // вибрато на длинных нотах
        const lfo = O('sine', 5.5), lg = G(0);
        lg.gain.setValueAtTime(0, t + 0.15); lg.gain.linearRampToValueAtTime(14, t + Math.min(dur, 0.5));
        lfo.connect(lg); lg.connect(o.detune); lg.connect(o2.detune); lfo.start(t); lfo.stop(end);
      }
      o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(D.o);
      o.start(t); o2.start(t); o.stop(end + 0.02); o2.stop(end + 0.02);
      send(D, g, 0.3, 0.12);
    }
    function tuba(D, t, note, dur, v = 0.3) {
      const o = O('sawtooth', midi(note)), s = O('sine', midi(note)), f = F('lowpass', 480, 2), g = G(), sg = G(0.7);
      const end = adsr(g.gain, t, 0.012, v, 0.08, 0.7, dur, 0.05);
      o.connect(f); s.connect(sg); sg.connect(g); f.connect(g); g.connect(D.o);
      o.start(t); s.start(t); o.stop(end + 0.02); s.stop(end + 0.02);
    }
    function woodblock(D, t, v = 0.2, fr = 2400) {
      const o = O('sine', fr), g = G();
      env(g.gain, t, 0.001, v, 0.045);
      o.connect(g); g.connect(D.o); o.start(t); o.stop(t + 0.08);
      const n = noiseSrc(t, 0.03), bf = F('bandpass', fr * 1.6, 6), ng = G();
      env(ng.gain, t, 0.001, v * 0.6, 0.02);
      n.connect(bf); bf.connect(ng); ng.connect(D.o);
    }
    function clarinet(D, t, note, dur, v = 0.06) {
      const o = O('square', midi(note)), f = F('lowpass', 1500, 0.7), g = G();
      const end = adsr(g.gain, t, 0.02, v, 0.1, 0.8, dur, 0.07);
      o.connect(f); f.connect(g); g.connect(D.o); o.start(t); o.stop(end + 0.02);
      send(D, g, 0.25, 0.18);
    }
    function pizz(D, t, note, v = 0.2, dec = 0.3) {
      const o = O('triangle', midi(note)), o2 = O('sine', midi(note + 12)), f = F('lowpass', 1400), g = G(), g2 = G(0.25);
      env(g.gain, t, 0.002, v, dec);
      o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(D.o);
      o.start(t); o2.start(t); o.stop(t + dec + 0.05); o2.stop(t + dec + 0.05);
    }

    /* ---------- 8-бит ---------- */
    function pulse(D, t, note, dur, v = 0.06, duty = 0.25, arp = null, step = 0.03, slide = 0) {
      const o = O(); o.setPeriodicWave(pulseWave(duty));
      if (arp) {
        const n = Math.max(1, Math.ceil(dur / step));
        for (let k = 0; k < n; k++) o.frequency.setValueAtTime(midi(note + arp[k % arp.length]), t + k * step);
      } else {
        o.frequency.setValueAtTime(midi(note), t);
        if (slide) o.frequency.exponentialRampToValueAtTime(midi(note + slide), t + dur);
      }
      const g = G(), end = adsr(g.gain, t, 0.002, v, 0.07, 0.65, dur, 0.025);
      o.connect(g); g.connect(D.o); o.start(t); o.stop(end + 0.02);
      return g;
    }
    function tri(D, t, note, dur, v = 0.3) {
      const o = O('triangle', midi(note)), g = G();
      const end = adsr(g.gain, t, 0.003, v, 0.05, 0.85, dur, 0.02);
      o.connect(g); g.connect(D.o); o.start(t); o.stop(end + 0.02);
    }
    function cNoise(D, t, v = 0.2, dec = 0.1, hp = 1000) {
      const n = noiseSrc(t, dec + 0.02, chipBuf), f = F('highpass', hp), g = G();
      env(g.gain, t, 0.001, v, dec);
      n.connect(f); f.connect(g); g.connect(D.o);
    }
    function cKick(D, t, v = 0.5) {
      const o = O('triangle'), g = G();
      o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.09);
      env(g.gain, t, 0.002, v, 0.14);
      o.connect(g); g.connect(D.o); o.start(t); o.stop(t + 0.2);
      cNoise(D, t, v * 0.25, 0.02, 200);
    }
    function beep(D, t, v = 0.1, fr = 1760, dur = 0.05) {
      const o = O(); o.setPeriodicWave(pulseWave(0.5)); o.frequency.value = fr;
      const g = G(), end = adsr(g.gain, t, 0.002, v, 0.01, 0.9, dur, 0.012);
      o.connect(g); g.connect(D.o); o.start(t); o.stop(end + 0.02);
    }

    /* ---------- старые инструменты (финал) ---------- */
    function bass(D, t, note, dur, cutoff = 520, v = 0.42) {
      const f = F('lowpass', cutoff, 7), g = G();
      f.frequency.setValueAtTime(cutoff * 2.2, t);
      f.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(0.25, dur));
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.008);
      g.gain.setValueAtTime(v, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const o1 = O('sawtooth', midi(note)), o2 = O('sine', midi(note - 12)), sub = G(0.9);
      o1.connect(f); o2.connect(sub); sub.connect(g); f.connect(g); g.connect(D.o);
      o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    }
    function pluck(D, t, note, v = 0.06, dly = 0.5, type = 'square') {
      const o = O(type, midi(note)), f = F('lowpass', 3200), g = G();
      f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.18);
      env(g.gain, t, 0.003, v, 0.22);
      o.connect(f); f.connect(g); g.connect(D.o);
      o.start(t); o.stop(t + 0.3);
      send(D, g, 0, dly);
    }

    /* ======================================================================
       ПАТТЕРНЫ. fn(D, k, t, td, i, rem, st): k — тик (12 на долю, 48 на такт),
       t — время, td — длительность тика, i — нагнетание 0..1,
       rem — секунд до конца таймера, st — память трека
       ====================================================================== */
    const bp = (k) => [Math.floor(k / 48), k % 48]; // [такт, тик в такте]

    /** Последние 5 секунд: дробь-подъём (учащается к нулю) + шумовой подъём. */
    function lastFive(D, k, t, rem, st, kind) {
      if (!(rem <= 5.05)) { st.rise = false; return; }
      if (rem < 0.05) return;
      if (!st.rise) { st.rise = true; riser(D, t, Math.max(0.4, rem), 0.11); }
      const iv = rem > 3.5 ? 6 : rem > 2 ? 3 : rem > 1 ? 2 : 1;
      if (k % iv) return;
      const v = 0.08 + (1 - rem / 5) * 0.2;
      if (kind === 'chip') cNoise(D, t, v * 0.9, 0.05, 1500);
      else snare(D, t, v, 0.15, kind === 'show' ? 2400 : 1900, 0.09);
    }

    // ---------- ФОНК: табло (G минор, 140 BPM halftime, 8 тактов) ----------
    const PH_ROOT = [31, 31, 34, 34, 36, 36, 38, 38];
    const PH_PAD = [[55, 58, 62], 0, [53, 58, 62], 0, [55, 60, 63], 0, [54, 57, 62], 0];
    const PH_BELL = [
      [79, 74, 77, 75, 74, 70], [79, 74, 77, 79, 82, 79],
      [77, 74, 70, 72, 74, 77], [77, 74, 79, 77, 74, 72],
      [75, 72, 79, 75, 72, 70], [75, 72, 79, 82, 79, 75],
      [78, 74, 81, 78, 74, 69], [78, 81, 78, 74, 72, 70],
    ];
    const BELL_POS = [0, 3, 6, 8, 11, 14]; // шестнадцатые: 3+3+2+3+3+2
    function phonkBoard(D, k, t, td) {
      let [bar, s] = bp(k); bar %= 8;
      const r = PH_ROOT[bar], odd = bar % 2;
      if (s === 0) b808(D, t, r, td * 17, 0.85);
      if (s === 18) b808(D, t, r, td * 11, 0.7);
      if (s === 30) b808(D, t, r + 12, td * (odd ? 11 : 17), 0.66, r, t + td * 5);
      if (s === 42 && odd) b808(D, t, r + 7, td * 5, 0.55);
      if (s === 0) kick(D, t, 0.7, 165, 50, 0.2);
      if (s === 18) kick(D, t, 0.5, 165, 50, 0.16);
      if (s === 33 && odd) kick(D, t, 0.4, 165, 50, 0.14);
      if (s === 24) { clap(D, t, 0.42, 0.35); snare(D, t, 0.16, 0.2, 2200, 0.12); }
      if (s === 45 && bar % 4 === 3) snare(D, t, 0.12, 0.1, 2200, 0.08);
      // хэты триолями восьмыми; на 4-й доле нечётных тактов — триоли шестнадцатыми
      if (s % 4 === 0) hat(D, t, s % 12 === 0 ? 0.12 : 0.065, 0.04);
      else if (s % 2 === 0 && ((odd && s >= 36) || (bar === 7 && s >= 24))) hat(D, t, 0.045 + (s - 24) / 24 * 0.04, 0.03);
      if (s % 3 === 0) { const idx = BELL_POS.indexOf(s / 3); if (idx >= 0) cowbell(D, t, PH_BELL[bar][idx], idx === 0 ? 0.24 : 0.19, idx === 5 ? 0.38 : 0.26); }
      if (s === 0 && PH_PAD[bar]) pad(D, t, PH_PAD[bar], td * 96, 650, 0.026);
    }
    // ---------- ФОНК: вопрос (минимализм, растут темп/плотность/фильтр) ----------
    const PQ_ROOT = [31, 31, 32, 32, 31, 31, 30, 30];
    const PQ_BELL = [79, 74, 80, 79, 74, 73];
    function phonkQuestion(D, k, t, td, i, rem, st) {
      let [bar, s] = bp(k); bar %= 8;
      if (s === 0) st.dense = i > 0.5; // плотность меняем только с начала такта — без дыр в басе
      const r = PQ_ROOT[bar], dense = !!st.dense;
      if (s === 0) b808(D, t, r, td * (dense ? 17 : 34), 0.82);
      if (!dense && s === 36) b808(D, t, r, td * 11, 0.6);
      if (dense && s === 18) b808(D, t, r, td * 11, 0.66);
      if (dense && s === 30) b808(D, t, r + 12, td * 17, 0.6, r, t + td * 4);
      if (s === 0) kick(D, t, 0.65, 165, 50, 0.2);
      if (i > 0.4 && s === 18) kick(D, t, 0.45, 165, 50, 0.15);
      if (s === 24) clap(D, t, 0.22 + 0.25 * i, 0.4);
      const h = i < 0.25 ? 12 : i < 0.5 ? 8 : i < 0.78 ? 4 : 2;
      if (s % h === 0) hat(D, t, (s % 12 === 0 ? 0.1 : 0.055) + 0.04 * i, 0.035);
      if (s === 0) cowbell(D, t, 79, 0.2, 0.3);
      if (s === 18 && bar % 2) cowbell(D, t, 80, 0.17, 0.3);
      if (i > 0.35 && (s === 9 || s === 33)) cowbell(D, t, s === 9 ? 74 : 73, 0.15, 0.22);
      if (i > 0.65 && s % 3 === 0) { const idx = BELL_POS.indexOf(s / 3); if (idx > 0) cowbell(D, t, PQ_BELL[idx], 0.16, 0.22); }
      if (s === 0 && bar % 2 === 0) pad(D, t, [55, 56, 62], td * 96, 500 + 900 * i, 0.024 + 0.012 * i);
      lastFive(D, k, t, rem, st, 'phonk');
    }

    // ---------- ШОУ: табло (F мажор, 118 BPM, марш, брасс, тарелки) ----------
    const SH_CH = [
      { b: 41, c: [65, 69, 72] }, { b: 46, c: [65, 70, 74] }, { b: 41, c: [65, 69, 72] }, { b: 48, c: [64, 67, 72] },
      { b: 38, c: [65, 69, 74] }, { b: 46, c: [65, 70, 74] }, { b: 43, c: [65, 70, 74] }, { b: 48, c: [64, 67, 70, 72] },
    ];
    const SH_MEL = [ // [восьмая, нота, длительность в восьмых]
      [[0, 72, 1], [2, 77, 1], [4, 81, 3]],
      [[0, 79, 1], [1, 77, 1], [2, 74, 2], [4, 77, 3]],
      [[0, 72, 1], [2, 77, 1], [4, 81, 1], [5, 84, 3]],
      [[0, 79, 4], [5, 76, 1], [6, 79, 2]],
      [[0, 81, 1], [1, 81, 1], [2, 77, 1], [3, 74, 1], [4, 81, 2], [6, 79, 2]],
      [[0, 77, 1], [1, 74, 1], [2, 70, 2], [4, 74, 2], [6, 77, 2]],
      [[0, 79, 1], [1, 77, 1], [2, 74, 1], [3, 70, 1], [4, 76, 2], [6, 79, 2]],
      [[0, 77, 5], [6, 72, 1], [7, 76, 1]],
    ];
    function showBoard(D, k, t, td) {
      let [bar, s] = bp(k); bar %= 8;
      const ch = SH_CH[bar];
      // марш: туба «ум» на 1 и 3 (тоника/квинта), брасс «па» на 2 и 4
      if (s === 0) tuba(D, t, ch.b, td * 10, 0.32);
      if (s === 24) tuba(D, t, ch.b + 7, td * 10, 0.28);
      if (s === 18 && bar % 2) tuba(D, t, ch.b + 4, td * 5, 0.2);
      if (s === 42) tuba(D, t, ch.b + (bar % 2 ? 2 : 12), td * 5, 0.2);
      if (bar % 4 === 3) { if (s === 0) brass(D, t, ch.c, td * 44, 0.034, 1.1); }
      else if (s === 12 || s === 36 || (s === 42 && bar % 2)) brass(D, t, ch.c, td * 4, 0.04, 1);
      SH_MEL[bar].forEach(([p, n, d]) => { if (s === p * 6) trumpet(D, t, n, td * (d * 6 - 1), 0.06); });
      if (s === 0 || s === 24) kick(D, t, 0.62, 120, 48, 0.25);
      if (s === 12 || s === 36) { snare(D, t, 0.08, 0, 2400, 0.04); snare(D, t + 0.016, 0.3, 0.3, 2400, 0.16); } // флэм
      if ((bar === 3 || bar === 7) && s >= 36 && s % 3 === 0) snare(D, t, 0.12 + (s - 36) / 12 * 0.12, 0.2, 2400, 0.1); // марш-дробь
      if (s % 6 === 0 && s % 12 !== 0) hat(D, t, 0.06, 0.06, 8000);
      if (s === 0 && bar % 4 === 0) crash(D, t, 0.16, 1.6);
      if (s === 0 && bar % 2 === 0) pad(D, t, ch.c.map((n) => n - 12), td * 96, 1400, 0.018); // «струнная» подложка
    }
    // ---------- ШОУ: вопрос — «музыка размышлений» (C мажор, своя мелодия) ----------
    const TH_CH = [
      { b: 48, c: [64, 67, 72] }, { b: 45, c: [61, 64, 67] }, { b: 50, c: [62, 65, 69] }, { b: 43, c: [59, 65, 67] },
      { b: 48, c: [64, 67, 72] }, { b: 40, c: [59, 62, 68] }, { b: 41, c: [60, 65, 69] }, { b: 43, c: [59, 62, 65] },
    ];
    const TH_MEL = [
      [[0, 76, 1], [1, 79, 1], [2, 84, 2], [4, 83, 1], [5, 81, 1], [6, 79, 2]],
      [[0, 79, 1], [1, 76, 1], [2, 73, 2], [4, 76, 2], [6, 81, 2]],
      [[0, 77, 2], [2, 74, 1], [3, 77, 1], [4, 81, 2], [6, 77, 2]],
      [[0, 79, 3], [3, 77, 1], [4, 74, 2], [6, 71, 2]],
      [[0, 72, 1], [1, 76, 1], [2, 79, 1], [3, 84, 1], [4, 83, 2], [6, 79, 2]],
      [[0, 80, 2], [2, 76, 1], [3, 80, 1], [4, 83, 2], [6, 80, 2]],
      [[0, 81, 1], [1, 77, 1], [2, 72, 2], [4, 74, 1], [5, 76, 1], [6, 77, 2]],
      [[0, 79, 2], [2, 74, 2], [4, 71, 2], [6, 74, 1], [7, 77, 1]],
    ];
    function showQuestion(D, k, t, td, i, rem, st) {
      let [bar, s] = bp(k); bar %= 8;
      const ch = TH_CH[bar];
      // шагающий бас-пиццикато четвертями
      if (s % 12 === 0) pizz(D, t, ch.b + [0, 7, 12, 7][s / 12], 0.26, 0.32);
      TH_MEL[bar].forEach(([p, n, d]) => { if (s === p * 6) clarinet(D, t, n, td * (d * 6 - 1), 0.05 + 0.02 * i); });
      if (s === 6 || s === 30) pizz(D, t, ch.c[0] + 12, 0.07, 0.15);
      if (s === 18 || s === 42) pizz(D, t, ch.c[2] + 12, 0.07, 0.15);
      // часы: тик-так на каждую долю → восьмые → шестнадцатые
      const clk = rem <= 5.05 ? 3 : i > 0.5 ? 6 : 12;
      if (s % clk === 0) woodblock(D, t, (s % 12 === 0 ? 0.13 : 0.08) + 0.08 * i, (k / clk) % 2 ? 1900 : 2500);
      if (i > 0.3 && (s === 0 || s === 24)) kick(D, t, 0.3 + 0.25 * i, 110, 48, 0.2);
      if (i > 0.55 && s % 6 === 0 && s % 12) hat(D, t, 0.04 + 0.04 * i, 0.04);
      if (s === 0 && bar % 2 === 0) pad(D, t, ch.c, td * 96, 600 + 1600 * i, 0.016 + 0.02 * i);
      lastFive(D, k, t, rem, st, 'show');
    }

    // ---------- 8-БИТ: табло (C мажор, 150 BPM) ----------
    const CH8 = [
      { b: 36, c: [0, 4, 7] }, { b: 43, c: [0, 4, 7] }, { b: 45, c: [0, 3, 7] }, { b: 41, c: [0, 4, 7] },
      { b: 36, c: [0, 4, 7] }, { b: 43, c: [0, 4, 7] }, { b: 41, c: [0, 4, 7] }, { b: 43, c: [0, 5, 7] },
    ];
    const MEL8 = [
      [[0, 72, 1], [1, 76, 1], [2, 79, 1], [3, 84, 1], [4, 83, 1], [5, 79, 1], [6, 76, 2]],
      [[0, 74, 1], [1, 79, 1], [2, 83, 2], [4, 81, 1], [5, 79, 1], [6, 74, 2]],
      [[0, 76, 1], [1, 72, 1], [2, 76, 1], [3, 81, 1], [4, 79, 2], [6, 76, 1], [7, 74, 1]],
      [[0, 72, 2], [2, 77, 1], [3, 81, 1], [4, 84, 3], [7, 83, 1]],
      [[0, 84, 1], [1, 79, 1], [2, 76, 1], [3, 79, 1], [4, 84, 1], [5, 88, 1], [6, 86, 2]],
      [[0, 83, 1], [1, 79, 1], [2, 74, 1], [3, 79, 1], [4, 83, 2], [6, 86, 2]],
      [[0, 84, 1], [1, 81, 1], [2, 77, 1], [3, 81, 1], [4, 84, 1], [5, 81, 1], [6, 77, 1], [7, 76, 1]],
      [[0, 74, 2], [2, 79, 1], [3, 77, 1], [4, 74, 1], [5, 71, 1], [6, 67, 1], [7, 71, 1]],
    ];
    function chipBoard(D, k, t, td) {
      let [bar, s] = bp(k); bar %= 8;
      const ch = CH8[bar];
      if (s % 6 === 0) tri(D, t, ch.b + ((s / 6) % 2 ? 12 : 0), td * 5, 0.3);
      MEL8[bar].forEach(([p, n, d]) => { if (s === p * 6) pulse(D, t, n, td * (d * 6 - 1), 0.055, 0.25); });
      if (s % 12 === 0) pulse(D, t, ch.b + 24, td * 11, 0.022, 0.125, ch.c.concat(ch.c[0] + 12), td);
      if (s === 0 || s === 24 || (s === 30 && bar % 2)) cKick(D, t, 0.5);
      if (s === 12 || s === 36) cNoise(D, t, 0.18, 0.11, 900);
      if (s % 6 === 0 && s % 12) cNoise(D, t, 0.07, 0.03, 6000);
      if (bar === 7 && s >= 36 && s % 3 === 0) cNoise(D, t, 0.1 + (s - 36) / 12 * 0.08, 0.06, 1200);
    }
    // ---------- 8-БИТ: вопрос (A минор, «бомба»: бип учащается к нулю) ----------
    const CQ8 = [{ b: 45, c: [0, 3, 7] }, { b: 45, c: [0, 3, 7] }, { b: 41, c: [0, 4, 7] }, { b: 40, c: [0, 4, 7] },
      { b: 45, c: [0, 3, 7] }, { b: 45, c: [0, 3, 6] }, { b: 38, c: [0, 3, 7] }, { b: 40, c: [0, 4, 7] }];
    const LQ8 = [76, 77, 76, 75, 76, 77, 79, 76];
    function chipQuestion(D, k, t, td, i, rem, st) {
      let [bar, s] = bp(k); bar %= 8;
      const ch = CQ8[bar];
      if (s % 6 === 0) tri(D, t, ch.b + ((s / 6) % 4 === 3 ? 12 : 0), td * 4, 0.3);
      if (i > 0.15 && s % 12 === 0) pulse(D, t, ch.b + 24, td * 11, 0.016 + 0.014 * i, 0.125, ch.c.concat(ch.c[0] + 12), td);
      if (i > 0.3 && s % 12 === 0) pulse(D, t, LQ8[(k / 12) % 8], td * 5, 0.035 + 0.02 * i, 0.25);
      if (s === 0 || s === 24 || (i > 0.6 && s % 12 === 0)) cKick(D, t, 0.42 + 0.1 * i);
      if (i > 0.4 && (s === 12 || s === 36)) cNoise(D, t, 0.12 + 0.06 * i, 0.1, 900);
      if (i > 0.5 && s % 3 === 0 && s % 6) cNoise(D, t, 0.05, 0.025, 6000);
      // таймер-бомба
      const iv = rem <= 5.05 ? (rem > 3 ? 3 : rem > 1.5 ? 2 : 1) : i < 0.33 ? 12 : i < 0.66 ? 6 : 3;
      if (s % iv === 0) beep(D, t, 0.05 + 0.04 * i, s % 12 === 0 ? 1760 : 1568, Math.min(0.05, td * iv * 0.55));
      lastFive(D, k, t, rem, st, 'chip');
    }

    // ---------- ФИНАЛ (как было): торжественный половинный ритм в ре миноре, 16 шагов/такт ----------
    const FINAL_CHORDS = [{ b: 38, c: [62, 65, 69] }, { b: 34, c: [62, 65, 70] }, { b: 41, c: [60, 65, 69] }, { b: 36, c: [60, 64, 67] }];
    function finalPattern(D, step, t, spb, i) {
      const bar = Math.floor(step / 32) % 4, s = step % 16, ch = FINAL_CHORDS[bar];
      if (s === 0 || s === 10) kick(D, t, 0.8, 140, 42, 0.38);
      if (s === 8) snare(D, t, 0.4, 0.8);
      if (s % 4 === 2) hat(D, t, 0.06 + i * 0.08);
      if (s === 0 && step % 32 === 0) { bass(D, t, ch.b, spb * 30, 380, 0.38); pad(D, t, ch.c.concat(ch.c[0] + 12), spb * 32, 1100 + i * 1400, 0.045); }
      if (s % 4 === 0 && i > 0.2) pluck(D, t, ch.c[(step / 4) % 3 | 0] + 12, 0.03 + i * 0.03, 0.5, 'triangle');
      if (i > 0.83 && s === 0 && step % 32 === 0) riser(D, t, spb * 32, 0.12);
    }

    // trim — выравнивание громкости стилей (офлайн-замер: RMS ≈ −15 dBFS ±0.5 у всех шести)
    const PATTERNS = {
      'phonk:board': { tpb: 12, bars: 8, bpm: () => 140, fn: phonkBoard, trim: 0.22 },
      'phonk:question': { tpb: 12, bars: 8, bpm: (i) => 130 + 22 * i, fn: phonkQuestion, cutoff: (i) => 1400 * Math.pow(12, i), trim: 0.22 },
      'show:board': { tpb: 12, bars: 8, bpm: () => 118, fn: showBoard, trim: 0.45 },
      'show:question': { tpb: 12, bars: 8, bpm: (i) => 104 + 28 * i, fn: showQuestion, cutoff: (i) => 2200 * Math.pow(8, i), trim: 1.2 },
      'chip:board': { tpb: 12, bars: 8, bpm: () => 150, fn: chipBoard, trim: 0.48 },
      'chip:question': { tpb: 12, bars: 8, bpm: (i) => 140 + 40 * i, fn: chipQuestion, cutoff: (i) => 2400 * Math.pow(7, i), trim: 0.54 },
      final: { tpb: 4, bars: 8, bpm: (i) => 76 + 10 * i, fn: finalPattern, trim: 0.4 },
    };

    /* ---------- стингеры по стилю ---------- */
    // стингер чуть громче музыки (офлайн-замер: самые громкие 400 мс ≈ −11…−12 dBFS)
    const STING_TRIM = { 'phonk-correct': 0.3, 'phonk-wrong': 0.3, 'show-correct': 1.1, 'show-wrong': 1.8, 'chip-correct': 2.6, 'chip-wrong': 1.6 };
    function stingerAt(style, kind, t) {
      const sg = G(STING_TRIM[style + '-' + kind] || 0.5); sg.connect(post);
      const rg = G(STING_TRIM[style + '-' + kind] || 0.5); rg.connect(rev);
      setTimeout(() => { try { sg.disconnect(); rg.disconnect(); } catch (e) { /* ignore */ } }, offline ? 1e9 : 4000);
      const D = { o: sg, rev: rg, dl: null };
      if (style === 'chip') {
        if (kind === 'correct') { [72, 76, 79, 84, 88].forEach((n, k) => pulse(D, t + k * 0.06, n, 0.09, 0.08, 0.25)); pulse(D, t + 0.3, 91, 0.35, 0.07, 0.125); }
        else { [64, 63, 62].forEach((n, k) => pulse(D, t + k * 0.16, n, 0.14, 0.09, 0.5)); pulse(D, t + 0.48, 61, 0.45, 0.09, 0.5, null, 0, -6); cNoise(D, t, 0.2, 0.2, 400); }
      } else if (style === 'show') {
        if (kind === 'correct') { brass(D, t, [65, 69, 72, 77], 0.12, 0.06, 1.3); brass(D, t + 0.16, [65, 69, 72, 77], 0.12, 0.06, 1.3); brass(D, t + 0.32, [70, 74, 77, 82], 0.8, 0.07, 1.4); crash(D, t + 0.32, 0.2, 1.4); }
        else { [[58, 62], [57, 61], [56, 60], [55, 59]].forEach((c, k) => brass(D, t + k * 0.28, c, k === 3 ? 0.7 : 0.24, 0.06, 0.7)); }
      } else { // phonk
        if (kind === 'correct') { [79, 82, 86, 91].forEach((n, k) => cowbell(D, t + k * 0.07, n, 0.3, 0.35)); b808(D, t, 43, 0.6, 0.9); clap(D, t + 0.21, 0.5, 0.5); }
        else { b808(D, t, 43, 0.9, 0.95, 31, t + 0.15); cowbell(D, t, 73, 0.3, 0.4); cowbell(D, t + 0.15, 72, 0.3, 0.5); kick(D, t, 0.8); }
      }
    }

    /* ---------- треки ---------- */
    const tracks = {}; // key → трек
    function makeTrack(key) {
      const custom = key.startsWith('custom:');
      const P = custom ? null : PATTERNS[key];
      const gain = G(0.0001), lp = F('lowpass', 20000, 0.7), revIn = G(1), dlIn = G(1);
      lp.connect(gain); gain.connect(mix); revIn.connect(rev); dlIn.connect(dl);
      return { key, P, gain, lp, revIn, dlIn, D: { o: lp, rev: revIn, dl: dlIn }, active: false, next: 0, k: 0, st: {}, src: null, stopAt: 0, i: 0, seams: null };
    }
    function fadeTo(tr, target, dur, now) {
      [tr.gain.gain, tr.revIn.gain, tr.dlIn.gain].forEach((p) => {
        p.cancelScheduledValues(now);
        p.setValueAtTime(Math.max(0.0001, p.value), now);
        p.exponentialRampToValueAtTime(Math.max(0.0001, target), now + dur);
      });
    }
    function dropTrack(tr) {
      if (tr.src) { try { tr.src.stop(); } catch (e) { /* ignore */ } tr.src = null; }
      [tr.gain, tr.lp, tr.revIn, tr.dlIn].forEach((n) => { try { n.disconnect(); } catch (e) { /* ignore */ } });
      delete tracks[tr.key];
    }
    function startTrack(key, o = {}) {
      let tr = tracks[key];
      if (tr && tr.stopAt) { dropTrack(tr); tr = null; } // уходящий трек — начинаем заново с такта 1
      const now = ctx.currentTime;
      if (!tr) {
        tr = tracks[key] = makeTrack(key);
        tr.active = true; tr.next = now + 0.05; tr.k = 0;
        if (tr.key.startsWith('custom:')) {
          tr.src = ctx.createBufferSource();
          tr.src.buffer = customBufs[key.slice(7)]; tr.src.loop = true;
          tr.src.connect(tr.gain); tr.src.start(now + 0.05);
        }
      }
      const trim = tr.P ? tr.P.trim : 1;
      if (o.instant) [tr.gain.gain, tr.revIn.gain, tr.dlIn.gain].forEach((p) => p.setValueAtTime(trim, now));
      else fadeTo(tr, trim, FADE, now);
      tr.stopAt = 0;
      return tr;
    }
    function stopTrack(tr, dur = FADE) {
      if (!tr || tr.stopAt) return;
      const now = ctx.currentTime;
      fadeTo(tr, 0.0001, dur, now);
      tr.stopAt = now + dur + 0.1;
    }

    /** Ставит ноты трека до horizon. tl(t) → {i, rem} — откуда брать нагнетание. */
    function runTrack(tr, horizon, tl) {
      const P = tr.P, barTicks = P.tpb * 4, loopTicks = barTicks * P.bars;
      while (tr.next < horizon) {
        const tt = tr.next;
        const x = tl(tt);
        const td = 60 / P.bpm(x.i) / P.tpb;
        if (P.cutoff && tr.k % P.tpb === 0) tr.lp.frequency.setTargetAtTime(Math.min(18000, P.cutoff(x.i)), tt, 0.08);
        if (tr.seams && tr.k > 0 && tr.k % loopTicks === 0) tr.seams.push(tt);
        try { P.fn(tr.D, tr.k, tt, td, x.i, x.rem, tr.st); } catch (e) { console.warn('music', e); }
        tr.next += td;
        tr.k++;
      }
    }

    /* ---------- состояние движка ---------- */
    let style = 'phonk', mode = 'off', curKey = null, intensity = 0, remain = Infinity, ducked = false;
    const customBufs = {};
    const keyFor = (m) => (customBufs[m] ? 'custom:' + m : m === 'final' ? 'final' : style + ':' + m);
    function retarget(want) {
      if (want === curKey) return;
      curKey = want;
      Object.keys(tracks).forEach((k) => { if (k !== want) stopTrack(tracks[k]); });
      if (want) startTrack(want);
    }

    const E = {
      ctx, out, offline,
      tick() {
        if (ctx.state !== 'running') return;
        const now = ctx.currentTime;
        Object.keys(tracks).forEach((key) => {
          const tr = tracks[key];
          if (tr.stopAt && now > tr.stopAt) { dropTrack(tr); return; }
          if (tr.src) return; // свой файл играет сам
          if (key === curKey) tr.i = intensity;
          const live = key === curKey ? { i: intensity, rem: remain } : { i: tr.i, rem: Infinity };
          if (tr.next < now - 0.2) tr.next = now + 0.02; // вкладка спала — не догоняем
          runTrack(tr, now + LOOKAHEAD, () => live);
        });
      },
      setMode(m, i, rem) {
        if (typeof i === 'number') intensity = Math.max(0, Math.min(1, i));
        remain = typeof rem === 'number' && rem >= 0 ? rem : Infinity;
        mode = m || 'off';
        retarget(mode === 'off' ? null : keyFor(mode));
      },
      setStyle(s) {
        if (STYLES.indexOf(s) < 0) s = 'phonk';
        if (s === style) return;
        style = s;
        if (mode !== 'off') retarget(keyFor(mode));
      },
      get style() { return style; },
      get mode() { return mode; },
      setDuck(d) {
        if (d === ducked) return;
        ducked = d;
        const now = ctx.currentTime;
        duckG.gain.cancelScheduledValues(now);
        duckG.gain.setTargetAtTime(d ? 0.15 : 1, now, d ? 0.03 : 0.35);
      },
      setOut(v) { out.gain.setTargetAtTime(v, ctx.currentTime, 0.2); },
      stinger(kind) { stingerAt(style, kind, ctx.currentTime + 0.02); },
      stingerAt(kind, t) { stingerAt(style, kind, t); },
      async setCustom(m, arrayBuf) {
        if (!arrayBuf) delete customBufs[m];
        else {
          try { customBufs[m] = await ctx.decodeAudioData(arrayBuf.slice(0)); } catch (e) { console.warn('music decode', e); delete customBufs[m]; return false; }
        }
        // перезапуск: если этот режим играет — сразу на свой файл (или обратно на синтез)
        Object.keys(tracks).forEach((k) => { if (k === 'custom:' + m) dropTrack(tracks[k]); });
        if (mode === m) { if (curKey && tracks[curKey] && curKey.startsWith('custom:')) dropTrack(tracks[curKey]); curKey = null; retarget(keyFor(m)); }
        return true;
      },
      // для офлайн-рендера / превью
      startTrack, stopTrack, runTrack, tracks,
      keyFor: (s, m) => (m === 'final' ? 'final' : s + ':' + m),
      stopAll(dur) { Object.keys(tracks).forEach((k) => stopTrack(tracks[k], dur)); curKey = null; mode = 'off'; },
    };
    return E;
  }

  /* ======================================================================
     ЭКРАН: один движок на общем контексте Sfx (через шину музыки и mute)
     ====================================================================== */
  let main = null;
  let enabled = true, volume = 0.5, style = 'phonk';
  function init() {
    if (main) return true;
    if (!window.Sfx || !window.Sfx.context) return false;
    const ctx = window.Sfx.context();
    if (!ctx) return false;
    main = createEngine(ctx, window.Sfx.musicBus(), enabled ? volume * OUT_SCALE : 0);
    main.setStyle(style);
    engines.add(main); ensureTicker();
    return true;
  }

  function update(o) {
    // до первого клика по экрану звук запрещён браузером — ничего не создаём
    if (!main && !(window.Sfx && window.Sfx.unlocked())) return;
    if (!init()) return;
    const want = enabled ? (o.mode || 'off') : 'off';
    main.setMode(want, o.intensity, o.remain);
    main.setDuck(!!o.duck);
  }
  function stinger(kind) {
    if (!init() || !enabled || main.ctx.state !== 'running') return;
    main.stinger(kind);
  }
  function configure(o) {
    if (typeof o.volume === 'number') volume = Math.max(0, Math.min(1, o.volume));
    if (typeof o.enabled === 'boolean') enabled = o.enabled;
    if (typeof o.style === 'string') style = STYLES.indexOf(o.style) >= 0 ? o.style : 'phonk';
    if (!main) return;
    main.setOut(enabled ? volume * OUT_SCALE : 0);
    main.setStyle(style);
    if (!enabled) main.setMode('off');
  }
  /** Свой файл для режима (ArrayBuffer) или null — вернуться к синтезу. */
  async function setCustom(name, arrayBuf) {
    if (!init()) return false;
    return main.setCustom(name, arrayBuf);
  }

  /* ======================================================================
     ПРЕВЬЮ НА ПУЛЬТЕ: свой AudioContext, 8 секунд выбранного стиля/режима.
     «Вопрос» в превью — последние 8 секунд 20-секундного таймера
     (видно и нагнетание, и дробь на 5…1).
     ====================================================================== */
  let pv = null; // { ctx, E, t0, dur, timer, onEnd }
  function stopPreview(silent) {
    if (!pv) return;
    const p = pv; pv = null;
    clearTimeout(p.timer);
    p.E.stopAll(0.25);
    setTimeout(() => { engines.delete(p.E); try { p.E.out.disconnect(); } catch (e) { /* ignore */ } }, 600);
    if (!silent && p.onEnd) p.onEnd();
  }
  let pvCtx = null;
  function preview(o = {}) {
    stopPreview(true);
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!pvCtx) pvCtx = new AC();
    if (pvCtx.state === 'suspended') pvCtx.resume();
    const dur = o.seconds || 8;
    const vol = typeof o.volume === 'number' ? Math.max(0.15, o.volume) : 0.6;
    const E = createEngine(pvCtx, pvCtx.destination, vol * OUT_SCALE * 1.4);
    E.setStyle(o.style);
    const m = o.mode === 'question' ? 'question' : o.mode === 'final' ? 'final' : 'board';
    const key = E.keyFor(E.style, m);
    const tr = E.startTrack(key, { instant: false });
    [tr.gain.gain, tr.revIn.gain, tr.dlIn.gain].forEach((p) => { p.cancelScheduledValues(pvCtx.currentTime); p.setValueAtTime(0.0001, pvCtx.currentTime); p.exponentialRampToValueAtTime(tr.P.trim, pvCtx.currentTime + 0.15); });
    const t0 = pvCtx.currentTime + 0.05;
    const TOTAL = 20; // имитация таймера
    const tl = m === 'board' ? () => ({ i: 0, rem: Infinity })
      : (t) => { const el = TOTAL - dur + Math.max(0, t - t0); return { i: Math.min(1, el / TOTAL), rem: Math.max(0, TOTAL - el) }; };
    const P = { ctx: pvCtx, E, onEnd: o.onEnd, timer: 0 };
    E.tick = function () {
      if (pvCtx.state !== 'running') return;
      const now = pvCtx.currentTime;
      Object.keys(E.tracks).forEach((k) => {
        const t = E.tracks[k];
        if (t.next < now - 0.2) t.next = now + 0.02;
        if (!t.stopAt) E.runTrack(t, Math.min(now + LOOKAHEAD, t0 + dur), tl);
      });
    };
    engines.add(E); ensureTicker();
    P.timer = setTimeout(() => { if (pv === P) stopPreview(false); }, dur * 1000 + 100);
    pv = P;
    return true;
  }

  /* ======================================================================
     ОФЛАЙН-РЕНДЕР (проверка уровней/стыков). «Вопрос» = таймер на seconds.
     ====================================================================== */
  function render(o = {}) {
    const sr = o.sampleRate || 44100, sec = o.seconds || 20;
    const octx = new OfflineAudioContext(2, Math.ceil(sr * sec), sr);
    const E = createEngine(octx, octx.destination, o.gain || 1);
    if (o.stinger) { // замер стингера отдельно
      E.setStyle(o.style || 'phonk');
      E.stingerAt(o.stinger, 0.05);
      return octx.startRendering().then((buffer) => ({ buffer, seams: [], loopSec: 0 }));
    }
    const m = o.mode || 'board';
    const tr = E.startTrack(E.keyFor(o.style || 'phonk', m), { instant: true });
    if (typeof o.trim === 'number') [tr.gain.gain, tr.revIn.gain, tr.dlIn.gain].forEach((p) => p.setValueAtTime(o.trim, 0));
    tr.next = 0; tr.seams = [];
    const tl = m === 'board' ? () => ({ i: 0, rem: Infinity }) : (t) => ({ i: Math.min(1, t / sec), rem: Math.max(0, sec - t) });
    E.runTrack(tr, sec, tl);
    const P = tr.P, loopSec = (60 / P.bpm(0)) * 4 * P.bars;
    return octx.startRendering().then((buffer) => ({ buffer, seams: tr.seams, loopSec }));
  }

  window.Music = {
    update, stinger, configure, setCustom, preview, stopPreview, render,
    STYLES,
    get previewing() { return !!pv; },
    get mode() { return main ? main.mode : 'off'; },
    get style() { return style; },
    /** для отладки: какие треки сейчас звучат на экране */
    tracks: () => (main ? Object.keys(main.tracks) : []),
  };
})();
