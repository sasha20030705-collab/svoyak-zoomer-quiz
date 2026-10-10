/* ==========================================================================
   Редактор аватара команды на телефоне: «нарисовать» и «загрузить» + кадрирование.
   AvatarEditor.draw({ color, onDone(dataUrl), onCancel })
   AvatarEditor.upload({ color, onDone(dataUrl), onCancel })  — открывает выбор файла
   Итог — квадрат 256×256, WebP/JPEG, не больше ~40 КБ.
   ========================================================================== */
(function () {
  'use strict';
  const OUT = 256;
  const MAX_BYTES = 40000;
  const COLORS = ['#0A0A0A', '#FFFFFF', '#C6FF00', '#FF2E93', '#2B4BFF', '#FF6A00', '#FFE600', '#00D1FF'];
  const BGS = ['#FFFFFF', '#C6FF00', '#FF2E93', '#2B4BFF', '#FF6A00', '#FFE600', '#0A0A0A'];
  const SIZES = [6, 16, 34];

  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  /** Сжать canvas до ≤ MAX_BYTES: WebP, если умеет браузер, иначе JPEG; качество вниз по шагам. */
  function exportSmall(canvas) {
    const bytes = (url) => Math.ceil((url.length - url.indexOf(',') - 1) * 3 / 4);
    let type = 'image/webp';
    if (canvas.toDataURL(type, 0.8).indexOf('data:image/webp') !== 0) type = 'image/jpeg';
    let q = 0.82, url = canvas.toDataURL(type, q);
    while (bytes(url) > MAX_BYTES && q > 0.3) { q -= 0.08; url = canvas.toDataURL(type, q); }
    if (bytes(url) > MAX_BYTES) { // крайний случай — уменьшаем размер
      const c = document.createElement('canvas');
      c.width = c.height = 192;
      c.getContext('2d').drawImage(canvas, 0, 0, 192, 192);
      url = c.toDataURL('image/jpeg', 0.6);
    }
    return url;
  }

  /* ------------------------------------------------------------ рисовалка */
  function draw({ color = '#C6FF00', onDone, onCancel }) {
    const N = 512; // внутреннее разрешение холста
    const ov = el(`
      <div class="av-ov">
        <div class="av-top"><button class="av-x" data-a="cancel">✕</button><b>нарисуй аватар</b><button class="btn lime av-ok" data-a="done">дальше →</button></div>
        <div class="av-stage"><canvas class="av-canvas" width="${N}" height="${N}"></canvas></div>
        <div class="av-tools">
          <div class="av-row colors">${COLORS.map((c, i) => `<button class="av-sw ${i === 0 ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="цвет"></button>`).join('')}<button class="av-tool" data-a="erase" title="ластик">🧽</button></div>
          <div class="av-row">
            ${SIZES.map((s, i) => `<button class="av-tool size ${i === 1 ? 'on' : ''}" data-s="${s}" aria-label="толщина"><i style="width:${6 + i * 7}px;height:${6 + i * 7}px"></i></button>`).join('')}
            <button class="av-tool" data-a="undo">↶</button>
            <button class="av-tool" data-a="clear">очистить</button>
          </div>
          <div class="av-row bgs"><span>фон:</span>${BGS.map((c, i) => `<button class="av-sw sm ${i === 0 ? 'on' : ''}" data-bg="${c}" style="background:${c}" aria-label="фон"></button>`).join('')}</div>
        </div>
      </div>`);
    document.body.appendChild(ov);
    document.body.classList.add('av-open');
    const cv = ov.querySelector('canvas');
    const ctx = cv.getContext('2d');
    let bg = BGS[0], cur = { color: COLORS[0], size: SIZES[1], erase: false };
    const strokes = [];
    let live = null;

    function fit() {
      const st = ov.querySelector('.av-stage');
      const s = Math.max(160, Math.min(st.clientWidth, st.clientHeight) - 8);
      cv.style.width = cv.style.height = s + 'px';
    }
    function paintStroke(st) {
      ctx.strokeStyle = st.erase ? bg : st.color;
      ctx.lineWidth = st.size;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      st.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (st.pts.length === 1) ctx.lineTo(st.pts[0][0] + 0.1, st.pts[0][1]);
      ctx.stroke();
    }
    function redraw() {
      ctx.fillStyle = bg; ctx.fillRect(0, 0, N, N);
      strokes.forEach(paintStroke);
    }
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * N / r.width, (e.clientY - r.top) * N / r.height]; };
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      live = { color: cur.color, size: cur.size, erase: cur.erase, pts: [pos(e)] };
      strokes.push(live);
      paintStroke(live);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!live) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      evs.forEach((x) => live.pts.push(pos(x)));
      redraw();
    });
    const end = () => { live = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    ov.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.c) { cur.color = b.dataset.c; cur.erase = false; mark('.colors .av-sw', b); ov.querySelector('[data-a="erase"]').classList.remove('on'); }
      else if (b.dataset.s) { cur.size = +b.dataset.s; mark('.size', b); }
      else if (b.dataset.bg) { bg = b.dataset.bg; mark('.bgs .av-sw', b); redraw(); }
      else if (b.dataset.a === 'erase') { cur.erase = !cur.erase; b.classList.toggle('on', cur.erase); }
      else if (b.dataset.a === 'undo') { strokes.pop(); redraw(); }
      else if (b.dataset.a === 'clear') { strokes.length = 0; redraw(); }
      else if (b.dataset.a === 'cancel') { close(); if (onCancel) onCancel(); }
      else if (b.dataset.a === 'done') { const url = cv.toDataURL('image/png'); close(); crop({ src: url, color, onDone, onCancel }); }
    });
    function mark(sel, b) { ov.querySelectorAll(sel).forEach((x) => x.classList.toggle('on', x === b)); }
    function close() { window.removeEventListener('resize', fit); ov.remove(); document.body.classList.remove('av-open'); }
    window.addEventListener('resize', fit);
    fit(); redraw();
  }

  /* ------------------------------------------------------------ загрузка */
  function upload({ color, onDone, onCancel }) {
    const inp = el('<input type="file" accept="image/*" hidden>');
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) { if (onCancel) onCancel(); return; }
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        // большие фото с камеры сразу уменьшаем — меньше памяти, быстрее жесты
        const k = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        crop({ src: c.toDataURL('image/jpeg', 0.9), color, onDone, onCancel });
      };
      img.onerror = () => { URL.revokeObjectURL(url); alertBox('Не получилось открыть картинку. Попробуй другую.'); if (onCancel) onCancel(); };
      img.src = url;
    });
    inp.click();
  }
  function alertBox(msg) {
    const n = el(`<div class="av-toast">${msg}</div>`);
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2600);
  }

  /* ------------------------------------------------------------ кадрирование */
  function crop({ src, color = '#C6FF00', onDone, onCancel }) {
    const ov = el(`
      <div class="av-ov crop">
        <div class="av-top"><button class="av-x" data-a="cancel">✕</button><b>двигай и масштабируй</b><button class="btn lime av-ok" data-a="done">готово ✓</button></div>
        <div class="av-stage">
          <div class="av-frame" style="--tc:${color}"><img alt="" draggable="false"></div>
        </div>
        <p class="av-cap">вот так вас увидят на экране</p>
        <div class="av-tools">
          <div class="av-row"><span>🔍</span><input class="av-zoom" type="range" min="1" max="4" step="0.01" value="1"><button class="av-tool" data-a="rot">↻ 90°</button></div>
        </div>
      </div>`);
    document.body.appendChild(ov);
    document.body.classList.add('av-open');
    const frame = ov.querySelector('.av-frame');
    const img = ov.querySelector('img');
    const zoom = ov.querySelector('.av-zoom');
    let F = 260, s = 1, x = 0, y = 0, rot = 0, iw = 1, ih = 1;

    function base() { return F / Math.min(iw, ih); } // «cover»: кадр всегда заполнен
    function apply() {
      img.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rot}deg) scale(${base() * s})`;
      zoom.value = s;
    }
    function fit() {
      const st = ov.querySelector('.av-stage');
      F = Math.max(160, Math.min(st.clientWidth - 60, st.clientHeight - 60, 320));
      frame.style.width = frame.style.height = F + 'px';
      apply();
    }
    img.onload = () => { iw = img.naturalWidth; ih = img.naturalHeight; img.style.width = iw + 'px'; img.style.height = ih + 'px'; fit(); };
    img.src = src;

    // жесты: один палец — двигать, два — щипок
    const pts = new Map();
    let last = null;
    const snapshot = () => {
      const a = [...pts.values()];
      if (a.length >= 2) return { mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
      return a.length ? { mx: a[0].x, my: a[0].y, d: 0 } : null;
    };
    frame.addEventListener('pointerdown', (e) => { e.preventDefault(); frame.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = snapshot(); });
    frame.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = snapshot();
      if (last && now) {
        x += now.mx - last.mx; y += now.my - last.my;
        if (last.d && now.d) s = Math.max(1, Math.min(4, s * now.d / last.d));
        apply();
      }
      last = now;
    });
    const up = (e) => { pts.delete(e.pointerId); last = snapshot(); };
    frame.addEventListener('pointerup', up);
    frame.addEventListener('pointercancel', up);
    zoom.addEventListener('input', () => { s = +zoom.value; apply(); });

    function render() {
      const c = document.createElement('canvas');
      c.width = c.height = OUT;
      const g = c.getContext('2d');
      const k = OUT / F;
      g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, OUT, OUT);
      g.translate(OUT / 2 + x * k, OUT / 2 + y * k);
      g.rotate(rot * Math.PI / 180);
      const sc = base() * s * k;
      g.scale(sc, sc);
      g.drawImage(img, -iw / 2, -ih / 2, iw, ih);
      return exportSmall(c);
    }
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.a === 'rot') { rot = (rot + 90) % 360; apply(); }
      else if (b.dataset.a === 'cancel') { close(); if (onCancel) onCancel(); }
      else if (b.dataset.a === 'done') { const url = render(); close(); onDone(url); }
    });
    function close() { window.removeEventListener('resize', fit); ov.remove(); document.body.classList.remove('av-open'); }
    window.addEventListener('resize', fit);
  }

  window.AvatarEditor = { draw, upload, crop, exportSmall };
})();
