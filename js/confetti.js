/* Самописное конфетти на canvas. Координаты — в пикселях холста
   (на экране гостей холст 1920×1080 внутри масштабируемой сцены). */
(function () {
  'use strict';
  const DEFAULT_COLORS = ['#C6FF00', '#FF2BD6', '#00E5FF', '#FFE600', '#8B5CFF', '#ffffff', '#FF7A00'];

  function Confetti(canvas) {
    const ctx = canvas.getContext('2d');
    let parts = [];
    let raf = 0;
    let last = 0;

    function spawn(x, y, o) {
      const angle = (o.angle != null ? o.angle : -90) * Math.PI / 180;
      const spread = (o.spread != null ? o.spread : 70) * Math.PI / 180;
      const a = angle + (Math.random() - 0.5) * spread;
      const sp = (o.speed || 22) * (0.45 + Math.random() * 0.75);
      const colors = o.colors || DEFAULT_COLORS;
      const r = Math.random();
      parts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        w: 10 + Math.random() * 14,
        h: 6 + Math.random() * 10,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.4,
        wob: Math.random() * Math.PI * 2,
        vw: 0.08 + Math.random() * 0.12,
        color: colors[(Math.random() * colors.length) | 0],
        shape: r < 0.55 ? 'rect' : r < 0.8 ? 'circle' : r < 0.93 ? 'star' : 'ribbon',
        life: 0,
        ttl: (o.ttl || 3.2) * (0.7 + Math.random() * 0.6),
        gravity: o.gravity != null ? o.gravity : 0.5,
      });
    }

    function star(c, r) {
      c.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? r * 0.45 : r;
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      c.closePath(); c.fill();
    }

    function frame(ts) {
      const dt = Math.min(0.05, (ts - (last || ts)) / 1000) || 0.016;
      last = ts;
      const k = dt * 60; // шаг физики в «кадрах по 60 fps»
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parts = parts.filter((p) => p.life < p.ttl && p.y < canvas.height + 60);
      for (const p of parts) {
        p.life += dt;
        p.vx *= Math.pow(0.985, k);
        p.vy = p.vy * Math.pow(0.985, k) + p.gravity * k;
        p.x += (p.vx + Math.sin(p.wob) * 1.2) * k;
        p.y += p.vy * k;
        p.rot += p.vr * k;
        p.wob += p.vw * k;
        const fade = Math.min(1, (p.ttl - p.life) / 0.6);
        ctx.save();
        ctx.globalAlpha = Math.max(0, fade);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.wob)); // «переворот» листочка
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        else if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.h * 0.7, 0, Math.PI * 2); ctx.fill(); }
        else if (p.shape === 'star') star(ctx, p.w * 0.7);
        else ctx.fillRect(-p.w, -2, p.w * 2.2, 4);
        ctx.restore();
      }
      if (parts.length) raf = requestAnimationFrame(frame);
      else { raf = 0; last = 0; }
    }

    function kick() { if (!raf) raf = requestAnimationFrame(frame); }

    return {
      /** Взрыв из точки. */
      burst(x, y, o = {}) {
        const n = o.count || 120;
        for (let i = 0; i < n; i++) spawn(x, y, o);
        kick();
      },
      /** Две «пушки» из нижних углов. */
      cannons(o = {}) {
        const n = o.count || 140;
        for (let i = 0; i < n; i++) {
          spawn(0, canvas.height, Object.assign({ angle: -60, spread: 40, speed: 34 }, o));
          spawn(canvas.width, canvas.height, Object.assign({ angle: -120, spread: 40, speed: 34 }, o));
        }
        kick();
      },
      /** Дождь сверху в течение ms. */
      rain(ms = 4000, o = {}) {
        const end = performance.now() + ms;
        const tick = () => {
          for (let i = 0; i < (o.density || 6); i++) {
            spawn(Math.random() * canvas.width, -20, Object.assign({ angle: 90, spread: 30, speed: 6, gravity: 0.18, ttl: 6 }, o));
          }
          kick();
          if (performance.now() < end) setTimeout(tick, 50);
        };
        tick();
      },
      clear() { parts = []; },
    };
  }

  window.Confetti = Confetti;
})();
