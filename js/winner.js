/* ==========================================================================
   Шоу победителя: хореография аватаров на пьедестале под трек
   BIA & A$AP Ferg — «WE ON GO II» (превью Apple, 30 с).
   Только Web Animations API (translate/rotate/scale/opacity — без layout),
   поэтому любую точку шоу можно «перемотать»: currentTime всех анимаций =
   прошедшее время от winnerShow.at (часы пульта) — удалённый экран и
   перезагрузка встают туда же, где играет трек.

   Тайминги — секунды от начала превью. Разметка трека (ffmpeg, RMS по окнам
   и onset-огибающая баса < 110 Гц, ~86 bpm):
     0…1.04 — без баса (пьедестал строится), 1.04 — входит бас;
     сильные кики: 1.96 3.33 4.71 5.63 7.01 7.70 8.38;
     8.8…10.6 — бас пропадает (пауза-«вдох»), 10.68 — бас возвращается: «дроп»;
     дальше кики 12.05 12.97.
   Свой файл ведущего играет с 0 — тайминги те же.
   ========================================================================== */
(function () {
  'use strict';

  const T = {
    others0: 1.96, others1: 4.71,          // приземления остальных (последние места — первыми)
    hops: [5.63, 7.01, 7.70, 8.38],        // победитель: касания «голов» на кики
    power: 9.85, powerLand: 10.15,         // после вдоха — резкий прыжок на 1-е место
    superUp: 10.25, drop: 10.68, superLand: 11.3, // финальный прыжок: апекс с переворотом — на дроп
    crown: 12.05, title: 12.05, settle: 13.2, end: 13.4,
  };
  const TR = { title: 2.4, settle: 2.6, end: 2.6 }; // prefers-reduced-motion: коротко, без прыжков

  const fmt = (n) => Math.round(n * 100) / 100;

  /** Ключевые кадры трека элемента: точки во времени {t, x, y, r, sx, sy}. */
  function Track(el, home) {
    const f = [];
    let rOff = 0; // накопленные полные обороты (−360 ≡ 0): дальше считаем от них, чтобы не «докручивать» назад
    const api = {
      el, home, f,
      last() { return f[f.length - 1]; },
      at(t, x, y, o) {
        o = o || {};
        const p = { t, x, y, r: o.rAbs != null ? o.rAbs : (o.r || 0) + rOff, sx: o.sx || 1, sy: o.sy || 1, e: o.e };
        const L = f[f.length - 1];
        if (L && t <= L.t) p.t = L.t + 0.001;
        f.push(p);
        return api;
      },
      hold(t, o) { const L = api.last(); return api.at(t, L.x, L.y, Object.assign({ rAbs: L.r }, o || {})); },
      /** Парабола от текущей точки до (x1,y1) к моменту t1; h — высота над верхней из точек. */
      arc(t1, x1, y1, h, o) {
        o = o || {};
        const L = api.last();
        const t0 = L.t, dur = Math.max(0.05, t1 - t0);
        const n = Math.max(8, Math.round(dur * 32));
        const top = Math.min(L.y, y1) - h;
        // y(u) = квадратичная через (0,y0), (u*,top), (1,y1): вершина там, где нужно по высотам
        const a0 = Math.sqrt(Math.max(1, L.y - top)), a1 = Math.sqrt(Math.max(1, y1 - top));
        const us = a0 / (a0 + a1);
        // поворот: от текущего к r1 (+ spin полных оборотов) и наклон lean в полёте
        const spin = o.spin || 0, lean = o.lean || 0, r0 = L.r, r1 = (o.r1 != null ? o.r1 : 0) + rOff + spin;
        for (let k = 1; k <= n; k++) {
          const u = k / n;
          const x = L.x + (x1 - L.x) * u;
          const y = u <= us ? top + (L.y - top) * Math.pow((us - u) / us, 2) : top + (y1 - top) * Math.pow((u - us) / (1 - us), 2);
          // вытягивание по скорости: сильнее у земли, у вершины — круглый
          const v = u <= us ? (us - u) / us : (u - us) / (1 - us);
          const st = (o.stretch != null ? o.stretch : 0.16) * v;
          const sc = o.scaleTop ? 1 + (o.scaleTop - 1) * (1 - v) : 1;
          const pr = u < 0.06 ? 0 : u > 0.94 ? 1 : (u - 0.06) / 0.88;
          const r = r0 + (r1 - r0) * (pr * pr * (3 - 2 * pr)) + lean * Math.sin(Math.PI * u);
          api.at(t0 + dur * u, x, y, { rAbs: r, sx: sc * (1 - st * 0.6), sy: sc * (1 + st) });
        }
        rOff += spin;
        return api;
      },
      /** Приземление: сплющивание и отскок формы (точка не двигается). */
      squash(a, dur) {
        const L = api.last();
        const t = L.t;
        api.at(t + dur * 0.28, L.x, L.y, { r: 0, sx: 1 + a, sy: 1 - a });
        api.at(t + dur * 0.62, L.x, L.y, { r: 0, sx: 1 - a * 0.35, sy: 1 + a * 0.35 });
        api.at(t + dur, L.x, L.y, { r: 0 });
        return api;
      },
      /** Готовим анимацию: возвращает Animation (или null). */
      build(extraOpts) {
        if (f.length < 2) return null;
        const t0 = f[0].t, t1 = f[f.length - 1].t, dur = (t1 - t0) * 1000;
        const h = home.h;
        const kf = f.map((p) => {
          // сплющивание — от «ног»: низ остаётся на месте
          const dy = (h * (1 - p.sy)) / 2;
          const k = {
            offset: Math.min(1, Math.max(0, ((p.t - t0) * 1000) / dur)),
            translate: `${fmt(p.x)}px ${fmt(p.y + dy)}px`,
            rotate: `${fmt(p.r)}deg`,
            scale: `${fmt(p.sx)} ${fmt(p.sy)}`,
          };
          if (p.e) k.easing = p.e;
          return k;
        });
        return el.animate(kf, Object.assign({ duration: dur, delay: t0 * 1000, fill: 'backwards', easing: 'linear' }, extraOpts || {}));
      },
    };
    return api;
  }

  /**
   * create(view, {places, reduced, confetti, origin, onDrop})
   *   places — U.placesOf(teams); origin() — {x,y} вида в координатах сцены (для конфетти).
   * → { start(elapsedMs), cancel(), titleAt }
   */
  function create(view, o) {
    const reduced = !!o.reduced;
    let anims = [], timers = [], fx = [];
    const champsG = o.places[0] ? o.places[0].teams : [];
    const tie = champsG.length > 1;

    function cancel() {
      anims.forEach((a) => { try { a.cancel(); } catch (e) { /* ignore */ } });
      timers.forEach(clearTimeout);
      fx.forEach((n) => n.remove());
      anims = []; timers = []; fx = [];
      view.classList.remove('settled');
    }

    function measure() {
      const vr = view.getBoundingClientRect();
      const k = vr.width / (view.offsetWidth || 1) || 1;
      return {
        W: view.offsetWidth, H: view.offsetHeight, k,
        box(el) {
          const r = el.getBoundingClientRect();
          return { cx: (r.left + r.width / 2 - vr.left) / k, cy: (r.top + r.height / 2 - vr.top) / k, w: el.offsetWidth, h: el.offsetHeight };
        },
      };
    }

    const avaOf = (id) => view.querySelector(`.pcol .ava[data-tid="${id}"]`);
    const chipOf = (id) => view.querySelector(`.others .chip[data-tid="${id}"]`);
    const nmOf = (id) => view.querySelector(`.pcol .nm[data-tid="${id}"]`);
    const layer = (cls) => { const d = document.createElement('div'); d.className = cls; view.appendChild(d); fx.push(d); return d; };

    function puffs(fxL, t, x, y, n, big) {
      for (let i = 0; i < n; i++) {
        const p = document.createElement('i');
        p.className = 'wpuff';
        const sz = (big ? 46 : 30) + ((i * 37) % 17);
        p.style.cssText = `left:${fmt(x - sz / 2)}px;top:${fmt(y - sz / 2)}px;width:${sz}px;height:${sz}px`;
        fxL.appendChild(p);
        const side = i % 2 ? 1 : -1;
        const dx = side * ((big ? 70 : 40) + ((i * 53) % (big ? 90 : 50)));
        const dy = -((i * 29) % (big ? 50 : 26)) - 6;
        anims.push(p.animate([
          { opacity: 0, translate: '0 0', scale: '.3' },
          { opacity: 1, translate: `${fmt(dx * 0.3)}px ${fmt(dy * 0.3)}px`, scale: '.9', offset: 0.15 },
          { opacity: 0, translate: `${dx}px ${dy}px`, scale: big ? '1.5' : '1.2' },
        ], { duration: big ? 750 : 520, delay: t * 1000, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'none' }));
      }
    }

    /** Голова пружинит под прыгающим. */
    function boing(el, t, a) {
      const h = el.offsetHeight;
      const k = a || 0.2;
      anims.push(el.animate([
        { translate: '0 0', scale: '1 1' },
        { translate: `0 ${fmt(h * k * 0.5 + 6)}px`, scale: `${1 + k * 0.6} ${1 - k}`, offset: 0.3 },
        { translate: '0 -6px', scale: `${1 - k * 0.2} ${1 + k * 0.25}`, offset: 0.65 },
        { translate: '0 0', scale: '1 1' },
      ], { duration: 420, delay: t * 1000, easing: 'ease-out', fill: 'none' }));
    }
    function popIn(el, t, d) {
      if (!el) return;
      anims.push(el.animate([
        { opacity: 0, scale: '.2' },
        { opacity: 1, scale: '1.15', offset: 0.6 },
        { opacity: 1, scale: '1' },
      ], { duration: d || 380, delay: t * 1000, easing: 'cubic-bezier(.3,1.4,.5,1)', fill: 'backwards' }));
    }
    function at(t, fn, elapsed, always) {
      const ms = t * 1000 - elapsed;
      if (ms < -250 && !always) return;
      timers.push(setTimeout(() => { if (view.isConnected) fn(); }, Math.max(0, ms)));
    }

    function buildReduced(elapsed) {
      const others = o.places.slice(1).reverse().flatMap((g) => g.teams.slice().reverse());
      const fade = (el, t) => el && anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, delay: t * 1000, fill: 'backwards' }));
      others.forEach((t, i) => { const at0 = 0.3 + i * (1.1 / Math.max(1, others.length)); fade(avaOf(t.id) || chipOf(t.id), at0); fade(nmOf(t.id), at0); });
      champsG.forEach((t) => { fade(avaOf(t.id), 1.6); fade(nmOf(t.id), 1.6); });
      const crown = view.querySelector('.pcol.p1 .crown');
      fade(crown, 2.0);
      at(2.0, () => { if (o.onDrop) o.onDrop(); }, elapsed);
      at(TR.settle, () => view.classList.add('settled'), elapsed, true);
    }

    function buildFull(elapsed) {
      const M = measure();
      const back = layer('wback'), fxL = layer('wfx');
      const homes = {};
      const home = (el) => homes[el.dataset.tid + el.className] || (homes[el.dataset.tid + el.className] = M.box(el));
      const cx = M.W / 2;

      /* --- остальные: снизу вверх по рейтингу --- */
      const others = o.places.slice(1).reverse().flatMap((g) => g.teams.slice().reverse().map((t) => ({ t, place: g.place })));
      const n = others.length;
      others.forEach((x, i) => {
        const el = avaOf(x.t.id) || chipOf(x.t.id);
        if (!el) return;
        const hm = home(el);
        const tl = n === 1 ? (T.others0 + T.others1) / 2 : T.others0 + ((T.others1 - T.others0) * i) / (n - 1);
        const fromRight = !!chipOf(x.t.id) || hm.cx >= cx;
        const sx = fromRight ? M.W + hm.w + 60 - hm.cx : -hm.w - 60 - hm.cx; // из-за края экрана
        const tr = Track(el, hm);
        const dur = 0.86;
        tr.at(tl - dur, sx, 260 + (i % 3) * 40, { r: fromRight ? 50 : -50 });
        tr.arc(tl, 0, 0, 230 + ((i * 47) % 90), { spin: fromRight ? -360 : 360, r1: 0, stretch: 0.14 });
        tr.squash(0.26, 0.34);
        const a = tr.build();
        if (a) anims.push(a);
        puffs(fxL, tl, hm.cx, hm.cy + hm.h / 2, 5, false);
        popIn(nmOf(x.t.id), tl + 0.05);
      });

      /* --- победитель(и) --- */
      const champs = champsG.map((t) => avaOf(t.id)).filter(Boolean);
      // «головы» — справа налево: верхний из колонки остальных, 3-е, 2-е место
      const heads = [];
      if (!tie && champs.length) {
        const g3 = o.places[2], g2 = o.places[1];
        const restTop = o.places[3] && chipOf(o.places[3].teams[0].id);
        if (restTop) heads.push(restTop);
        const byX = (g) => g ? g.teams.map((t) => avaOf(t.id)).filter(Boolean).sort((a, b) => home(b).cx - home(a).cx).slice(0, 2) : [];
        heads.push(...byX(g3), ...byX(g2));
      }
      let path = heads.length >= 4 ? heads.slice(-4) : heads.length === 3 ? [heads[0], heads[1], heads[2], heads[2]]
        : heads.length === 2 ? [heads[0], heads[1], heads[0], heads[1]] : heads.length === 1 ? [heads[0], heads[0], heads[0], heads[0]] : [];
      const apexes = [];
      champs.forEach((el, ci) => {
        const hm = home(el);
        const tr = Track(el, hm);
        // стоять на голове: низ победителя — на макушке головы
        const onHead = (hEl) => { const b = home(hEl); return { x: b.cx - hm.cx, y: (b.cy - b.h / 2) - (hm.cy + hm.h / 2) }; };
        // до суперпрыжка имени под ногами ещё нет — стоим прямо на блоке 1-го места (низ блока не двигается при rise)
        const blk = el.closest('.pcol') && el.closest('.pcol').querySelector('.block');
        const gY = blk ? Math.max(0, M.box(blk).cy + blk.getBoundingClientRect().height / (2 * M.k) - blk.offsetHeight - (hm.cy + hm.h / 2)) : 0;
        const first = path.length ? onHead(path[0]) : { x: 0, y: gY };
        const firstX = path.length ? home(path[0]).cx : hm.cx;
        const fromRight = path.length ? firstX >= cx : ci % 2 === 1;
        const sx = fromRight ? M.W + hm.w + 80 - hm.cx : -hm.w - 80 - hm.cx;
        tr.at(T.hops[0] - 0.85, sx, first.y + 300, { r: fromRight ? 40 : -40 });
        tr.arc(T.hops[0], first.x, first.y, 300, { spin: fromRight ? -360 : 360, stretch: 0.16 });
        if (path.length) {
          boing(path[0], T.hops[0], 0.24);
          puffs(fxL, T.hops[0], hm.cx + first.x, hm.cy + hm.h / 2 + first.y, 3, false);
          for (let k = 1; k < path.length; k++) {
            tr.squash(0.22, 0.16);
            const p = onHead(path[k]);
            const same = path[k] === path[k - 1];
            tr.arc(T.hops[k], p.x, p.y, same ? 150 : 210, { stretch: 0.15, lean: same ? 0 : (p.x < tr.last().x ? -18 : 18) });
            boing(path[k], T.hops[k], 0.24);
          }
        } else {
          tr.squash(0.24, 0.2);
          puffs(fxL, T.hops[0], hm.cx, hm.cy + hm.h / 2 + gY, 5, false);
          for (let k = 1; k < T.hops.length; k++) {
            tr.arc(T.hops[k], 0, gY, 80 + k * 18, { stretch: 0.12 });
            tr.squash(0.2, 0.16);
          }
        }
        // пауза-«вдох»: медленно приседает, дрожит
        const L = tr.last();
        tr.squash(0.18, 0.22);
        const crouchFrom = tr.last().t;
        const crouchTo = path.length ? T.power : T.superUp - 0.02;
        tr.at(crouchFrom + (crouchTo - crouchFrom) * 0.55, L.x, L.y, { sx: 1.12, sy: 0.86, e: 'ease-in-out' });
        for (let tt = crouchFrom + (crouchTo - crouchFrom) * 0.6, j = 0; tt < crouchTo - 0.06; tt += 0.06, j++) {
          tr.at(tt, L.x + (j % 2 ? 3 : -3), L.y, { sx: 1.17, sy: 0.8 });
        }
        tr.at(crouchTo, L.x, L.y, { sx: 1.2, sy: 0.76 });
        if (path.length) {
          // резкий мощный прыжок на 1-е место
          tr.arc(T.powerLand, 0, gY, 110, { stretch: 0.26 });
          tr.at(T.powerLand + 0.05, 0, gY, { sx: 1.28, sy: 0.7 });
          tr.at(T.superUp - 0.02, 0, gY, { sx: 1.18, sy: 0.8 });
          puffs(fxL, T.powerLand, hm.cx, hm.cy + hm.h / 2 + gY, 4, false);
        }
        // финальный суперпрыжок: вверх к дропу, переворот, приземление
        const apex = Math.max(220, Math.min(620, hm.cy - hm.h / 2 - 50));
        tr.at(T.superUp, 0, gY, { sx: 0.8, sy: 1.3 });
        const nUp = 10;
        for (let k = 1; k <= nUp; k++) {
          const u = k / nUp, e = 1 - Math.pow(1 - u, 2.2);
          tr.at(T.superUp + (T.drop - T.superUp) * u, 0, gY + (-apex - gY) * e, { r: -200 * u * u, sx: 1 + 0.35 * e - 0.15 * (1 - e), sy: 1 + 0.35 * e + 0.2 * (1 - e) });
        }
        const nDn = 14;
        for (let k = 1; k <= nDn; k++) {
          const u = k / nDn, e = u * u;
          const sc = 1.35 - 0.35 * u;
          tr.at(T.drop + (T.superLand - T.drop) * u, 0, -apex * (1 - e), { r: -200 - 160 * Math.min(1, u * 1.5), sx: sc * (1 - 0.1 * u), sy: sc * (1 + 0.16 * u) });
        }
        tr.at(T.superLand + 0.001, 0, 0, { r: -360 });
        tr.at(T.superLand + 0.1, 0, 0, { r: -360, sx: 1.4, sy: 0.62 });
        tr.at(T.superLand + 0.26, 0, 0, { r: -360, sx: 0.9, sy: 1.12 });
        tr.at(T.superLand + 0.42, 0, 0, { r: -360 });
        const a = tr.build();
        if (a) anims.push(a);
        apexes.push({ x: hm.cx, y: hm.cy - apex, fx: hm.cx, fy: hm.cy + hm.h / 2 });
        puffs(fxL, T.superLand, hm.cx, hm.cy + hm.h / 2, 8, true);
        popIn(nmOf(champsG[ci].id), T.drop + 0.1, 450); // имя выскакивает на дроп — приземляемся уже на него
        // корона приземлилась — голова чуть приседает
        boing(el, T.crown, 0.14);
      });

      /* --- корона падает на голову --- */
      const crown = view.querySelector('.pcol.p1 .crown');
      if (crown) {
        anims.push(crown.animate([
          { translate: '0 -1150px', rotate: '-35deg', opacity: 1, easing: 'cubic-bezier(.55,0,1,.6)' },
          { translate: '0 0', rotate: '8deg', offset: 0.72, easing: 'ease-out' },
          { translate: '0 -46px', rotate: '-4deg', offset: 0.86, easing: 'ease-in' },
          { translate: '0 0', rotate: '0deg' },
        ], { duration: 900, delay: (T.crown - 0.65) * 1000, fill: 'backwards' }));
      }

      /* --- вспышка и лучи на дроп --- */
      const mid = apexes.length ? apexes.reduce((s, p) => ({ x: s.x + p.x / apexes.length, y: s.y + p.y / apexes.length, fy: s.fy + p.fy / apexes.length }), { x: 0, y: 0, fy: 0 }) : { x: cx, y: M.H / 2, fy: M.H };
      const rays = document.createElement('div');
      rays.className = 'wrays';
      rays.style.left = fmt(mid.x) + 'px';
      rays.style.top = fmt(mid.fy - 150) + 'px';
      rays.innerHTML = '<i></i>';
      back.appendChild(rays);
      anims.push(rays.animate([
        { opacity: 0, scale: '.15' },
        { opacity: 1, scale: '1.25', offset: 0.35 },
        { opacity: 0.45, scale: '1' },
      ], { duration: 1500, delay: T.drop * 1000, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'both' }));
      const flash = document.createElement('div');
      flash.className = 'wflash';
      fxL.appendChild(flash);
      anims.push(flash.animate([{ opacity: 0 }, { opacity: 0.92, offset: 0.1 }, { opacity: 0 }], { duration: 650, delay: T.drop * 1000, easing: 'ease-out', fill: 'none' }));

      /* --- конфетти и звук: по таймерам (перемотке не подлежат — прошедшие пропускаем) --- */
      const org = o.origin ? o.origin() : { x: 0, y: 0 };
      const colors = o.colors;
      if (o.confetti) {
        at(T.drop, () => {
          apexes.forEach((p) => o.confetti.burst(org.x + p.x, org.y + p.y, { count: Math.round(240 / apexes.length) + 30, spread: 360, speed: 30, colors }));
          o.confetti.cannons({ count: 150, colors });
        }, elapsed);
        at(T.superLand, () => apexes.forEach((p) => o.confetti.burst(org.x + p.fx, org.y + p.fy, { count: 50, angle: -90, spread: 120, speed: 20, colors })), elapsed);
        at(T.crown, () => o.confetti.rain(6500, { colors }), elapsed);
      }
      at(T.drop, () => { if (o.onDrop) o.onDrop(); }, elapsed);
      at(T.settle, () => view.classList.add('settled'), elapsed, true);
    }

    return {
      titleAt: reduced ? TR.title : T.title,
      endAt: reduced ? TR.end : T.end,
      /** Построить и перемотать на elapsed мс от старта шоу. */
      start(elapsed) {
        cancel();
        view.classList.add('choreo');
        if (reduced) view.classList.add('calm');
        const endAt = (reduced ? TR.end : T.end) * 1000;
        if (elapsed >= endAt + 500) { view.classList.add('settled'); return; } // шоу давно прошло — сразу финальный кадр
        try { if (reduced) buildReduced(elapsed); else buildFull(elapsed); } catch (e) { console.warn('winner show', e); cancel(); view.classList.add('settled'); return; }
        anims.forEach((a) => { try { a.currentTime = Math.max(0, elapsed); } catch (e) { /* ignore */ } });
      },
      cancel,
      get anims() { return anims; },
    };
  }

  window.WinnerShow = { create, T, TR };
})();
