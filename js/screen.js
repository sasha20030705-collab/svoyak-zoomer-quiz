/* ==========================================================================
   Экран гостей. Только отображает состояние стора (и ловит баззеры).
   Каждое «представление» (заставка, табло, вопрос, финал, победитель) —
   объект {key, type, el, update(s), tick(s)}. Когда ключ меняется —
   переход (шторки или «оторванная» ячейка); иначе — точечное обновление.
   ========================================================================== */
(function () {
  'use strict';
  const U = window.QuizUtil;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const stageEl = $('#stage'), viewsEl = $('#views'), scorebar = $('#scorebar');
  const buzzEl = $('#buzz'), flashEl = $('#flash'), shell = $('#shell'), bgEl = $('#bg');
  const confetti = window.Confetti($('#confetti'));

  let quiz = null;
  let view = null;
  let busy = false, pending = false;
  let lastEvent = 0;
  let scale = 1;
  let SW = 1920, SH = 1080; // размер сцены в «дизайн-пикселях»

  /* ---------- сцена: всегда ровно во весь вьюпорт, без полос ----------
     Масштаб берём по меньшей стороне относительно 1920×1080, а сцену растягиваем
     до пропорций окна: при 16:10 она выше (1920×1200), при 21:9 — шире.
     Бегущие строки прижаты к краям экрана, плашки команд — к нижней строке,
     а вопрос/табло адаптивно занимают всё, что между ними. */
  function fit() {
    const vw = window.innerWidth, vh = window.innerHeight;
    scale = Math.min(vw / 1920, vh / 1080);
    SW = vw / scale; SH = vh / scale;
    stageEl.style.width = SW + 'px';
    stageEl.style.height = SH + 'px';
    stageEl.style.setProperty('--s', scale);
    const cv = $('#confetti');
    cv.width = Math.round(SW); cv.height = Math.round(SH);
    cv.style.width = SW + 'px'; cv.style.height = SH + 'px';
  }
  window.addEventListener('resize', fit);
  fit();

  /** Прямоугольник элемента в координатах сцены. */
  function rectInStage(el) {
    const r = el.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
    return { x: (r.left - sr.left) / scale, y: (r.top - sr.top) / scale, w: r.width / scale, h: r.height / scale };
  }

  const teamVars = (t) => `--tc:${t.color};--tx:${U.textOn(t.color)}`;
  const teamById = (s, id) => s.teams.find((t) => t.id === id);
  /** Аватар команды (нарисованный/загруженный) или эмодзи. */
  const avaInner = (t) => (t.avatar ? `<img class="av-img" src="${t.avatar}" alt="">` : esc(t.emoji));
  const chip = (t, extra = '', tail = '') =>
    `<span class="chip ${extra}" style="${teamVars(t)}"><span class="e emoji-font">${avaInner(t)}</span>${esc(t.name)}${tail}</span>`;

  /** Разбивка строки на графемы (🧛‍♂️ — один символ). */
  function graphemes(str) {
    if (window.Intl && Intl.Segmenter) return Array.from(new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(str), (x) => x.segment);
    return Array.from(str);
  }

  /** Текст, который «вылетает» по буквам. Переносится по словам. */
  function letters(text, d0 = 0, cls = '') {
    let i = 0;
    const words = String(text).split(/\s+/).filter(Boolean).map((w) =>
      `<span class="w">${graphemes(w).map((c) => `<span class="ch" style="--i:${i++}">${esc(c)}</span>`).join('')}</span>`);
    return `<span class="letters ${cls}" style="--d0:${d0}ms">${words.join(' ')}</span>`;
  }

  /** Размер мега-заголовка под длину текста (сцена 1920 px). */
  function megaSize(text, max = 300, lines = 2) {
    const words = String(text).split(/\s+/);
    const longest = Math.max(...words.map((w) => graphemes(w).length));
    const total = graphemes(String(text)).length;
    return Math.round(Math.min(max, 1700 / (longest * 0.86), (1700 * lines) / (total * 0.86)));
  }

  /** Картинка с заглушкой-стикером, если файла нет (картинки могут докачиваться позже). */
  function guardImages(root) {
    $$('img', root).forEach((img) => {
      const fail = () => {
        if (img.dataset.failed) return;
        img.dataset.failed = '1';
        img.style.visibility = 'hidden';
        // в слиянии три слоя-копии: заглушку ставим один раз на всю рамку
        const layer = img.closest('.fuse-layer');
        const host = layer ? layer.parentElement : img.parentElement;
        if (layer && host.querySelector(':scope > .img-missing')) return;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        if (host.classList.contains('img-card')) host.classList.add('broken');
        host.appendChild(h(`<div class="img-missing"><div><b>упс</b>картинка ещё не доехала<small>${esc(img.getAttribute('src'))}</small></div></div>`));
      };
      if (!img.getAttribute('src')) fail();
      else img.addEventListener('error', fail, { once: true });
    });
  }

  /* ---------- тема фона под экран ---------- */
  const THEMES = {
    splash: ['var(--blue)', 'var(--pink)', 'var(--lime)', 'var(--orange)'],
    board: ['var(--blue)', 'var(--orange)', 'var(--pink)', 'var(--lime)'],
    question: ['var(--pink)', 'var(--blue)', 'var(--lime)', 'var(--orange)'],
    finalintro: ['var(--orange)', 'var(--blue)', 'var(--pink)', 'var(--lime)'],
    finalq: ['var(--orange)', 'var(--blue)', 'var(--pink)', 'var(--lime)'],
    winner: ['var(--black)', 'var(--pink)', 'var(--blue)', 'var(--orange)'],
  };
  function setTheme(type) {
    const t = THEMES[type] || THEMES.splash;
    bgEl.style.setProperty('--bgc', t[0]);
    bgEl.style.setProperty('--sh1', t[1]);
    bgEl.style.setProperty('--sh2', t[2]);
    bgEl.style.setProperty('--sh3', t[3]);
  }

  /* ---------- бегущие строки ---------- */
  const TICKERS = {
    splash: ['кто тут самый умный', 'не кринж, а квиз', 'др 21.10', 'без гугла', 'сканируй qr — жми с телефона'],
    board: ['ваш ход, ребята', 'выбирайте, не тяните', 'дорого — значит сложно', 'аура на кону'],
    question: ['жми, если знаешь', 'думаем', 'тик-так', 'без гугла', 'шёпотом не подсказываем'],
    finalintro: ['финалочка', 'ставки сделаны?', 'всё или ничего'],
    finalq: ['финалочка', 'пишите ответ', 'без подглядываний'],
    winner: ['корона достаётся', 'gg', 'аура +1000', 'с днём рождения'],
  };
  let tickerType = '';
  function setTickers(type) {
    if (type === tickerType) return;
    tickerType = type;
    const title = (quiz && quiz.title) || 'Своя игра';
    const build = (list) => { const one = list.map((x) => `${esc(x)}<i>✦</i>`).join(''); const block = one.repeat(4); return block + block; };
    $('#ticker-top .track').innerHTML = build([title, ...(TICKERS[type] || TICKERS.splash)]);
    $('#ticker-bottom .track').innerHTML = build(['с днём рождения', '21.10.2026', ...(TICKERS[type] || TICKERS.splash).slice().reverse()]);
  }

  /** Большой штамп поверх экрана: «МИМО», «ВСЁ, ВРЕМЯ»… */
  function bigStamp(text, cls = '') {
    const el = h(`<div class="big-stamp mega ${cls}">${esc(text)}</div>`);
    shell.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  /* ======================================================================
     ПРЕДСТАВЛЕНИЯ
     ====================================================================== */

  function titleParts() {
    const t = (quiz && quiz.title) || 'Своя игра';
    const i = t.indexOf(':');
    return i > 0 ? { main: t.slice(0, i).trim(), sub: t.slice(i + 1).trim() } : { main: t, sub: '' };
  }

  /** Номинал в круглом бейдже: кегль от числа знаков, с запасом ≥12% до пунктира. */
  function fitBadge(span) {
    if (!span) return;
    const text = span.textContent.trim();
    const n = Math.max(1, text.length);
    const digits = /^\d+$/.test(text);
    // внутренний диаметр до пунктира ≈ 120 px, рабочая ширина строки ≈ 90 px
    const size = Math.min(46, Math.floor(90 / (n * (digits ? 0.82 : 0.98))));
    span.style.fontSize = size + 'px';
  }

  /** Блок «залетай с телефона»: QR, код комнаты, число подключённых телефонов. */
  function updateJoin(root, s) {
    const card = $('.join-card', root);
    if (!card) return false;
    const st = s.net && s.net.status;
    const show = !!(s.room && window.Net && st && st !== 'off' && st !== 'unavailable');
    card.hidden = !show;
    if (!show) return false;
    // код комнаты — всегда, первым делом (его можно ввести и руками)
    $('.jc-code', card).textContent = s.room;
    const n = (s.net && s.net.devices) || 0;
    $('.jc-dev', card).textContent = st === 'online' ? `📱 ${n} на связи` : st === 'other-tab' ? 'пульт открыт в другой вкладке' : 'ведущий подключается…';
    let url = '';
    try { url = window.Net.joinUrl(s.room, s.netKey, s.net && typeof s.net.best === 'number' ? s.net.best : -1); } catch (e) { url = ''; }
    const img = $('.jc-qr', card);
    const data = url && window.qrDataUrl ? window.qrDataUrl(url) : null;
    if (data && img.getAttribute('src') !== data) img.src = data;
    img.hidden = !data;
    card.classList.toggle('no-qr', !data); // QR не вышел — крупно ссылка и код
    const u = $('.jc-url', card);
    if (u) {
      const short = url.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
      u.textContent = data ? short + ' · код ' + s.room : (short || 'buzzer.html') + '  →  код ' + s.room;
    }
    return true;
  }

  function SplashView() {
    const { main, sub } = titleParts();
    const el = h(`
      <div class="view full splash">
        <div class="stamp r-side" style="right:190px;top:120px">21<br>.10</div>
        <div class="float-stk tag black" style="left:110px;top:120px;transform:rotate(-6deg);--fr:-9deg">кто тут самый умный?</div>
        <div class="float-stk tag pink r-side" style="right:150px;bottom:150px;transform:rotate(5deg);animation-delay:-2s">без гугла</div>
        <div class="float-stk tag white" style="left:70px;bottom:60px;transform:rotate(4deg);animation-delay:-3s;--fr:-2deg">гугл не поможет</div>
        <div class="float-stk emoji-font r-side" style="left:70px;top:380px;font-size:120px;filter:drop-shadow(8px 8px 0 #0A0A0A);animation-delay:-1s">🎂</div>
        <div class="float-stk emoji-font r-side" style="right:60px;top:560px;font-size:110px;filter:drop-shadow(8px 8px 0 #0A0A0A);animation-delay:-2.5s">💿</div>
        <div class="center">
          <span class="tag white" style="transform:rotate(-3deg)">квиз на днюху</span>
          <h1 class="mega wiggle" style="--mega:${megaSize(main, 320)}px">${letters(main, 200)}</h1>
          ${sub ? `<div class="sub-row"><span class="tag lime" style="transform:rotate(2deg);font-size:40px">${esc(sub)}</span></div>` : ''}
          <div class="join"></div>
          <div class="hint"></div>
        </div>
        <div class="join-card" hidden>
          <span class="tag black jc-head">залетай с телефона</span>
          <img class="jc-qr" alt="QR-код">
          <div class="jc-code"></div>
          <div class="jc-url"></div>
          <span class="tag lime jc-dev"></span>
        </div>
      </div>`);
    let sig = '';
    return {
      type: 'splash', el,
      update(s) {
        const nsig = JSON.stringify(s.teams.map((t) => [t.id, t.name, t.emoji, t.color, t.key, t.avatarV || 0]));
        if (nsig !== sig) {
          sig = nsig;
          $('.join', el).innerHTML = s.teams.length
            ? `<span class="label">в игре:</span>` + s.teams.map((t) => chip(t, '', ` <kbd>${esc(U.keyLabel(t.key))}</kbd>`)).join('')
            : '';
        }
        const phones = updateJoin(el, s);
        el.classList.toggle('with-qr', phones);
        $('.hint', el).textContent = s.teams.length
          ? (phones ? 'жмите кнопку на телефоне или свою клавишу — проверим связь' : 'жмите свою кнопку — проверим, кто на связи')
          : (phones ? 'сканируйте QR и создавайте команды' : 'ждём команды… не стесняемся');
      },
    };
  }

  // цвета ячеек по колонкам: сталкиваем палитру
  const CELL_COLORS = [['var(--lime)', 'var(--black)'], ['var(--white)', 'var(--black)'], ['var(--orange)', 'var(--black)'], ['var(--pink)', 'var(--white)'], ['var(--black)', 'var(--lime)']];

  function BoardView(s) {
    const r = s.round;
    const R = quiz.rounds[r] || { name: 'Раунд', categories: [] };
    const cols = Math.max(1, ...R.categories.map((c) => c.questions.length));
    let cells = '';
    R.categories.forEach((c, ci) => {
      cells += `<div class="theme" style="--d:${ci * 0.06}s;--r:${ci % 2 ? 0.8 : -0.8}deg"><span class="n">${esc(c.name)}</span></div>`;
      for (let qi = 0; qi < cols; qi++) {
        if (!c.questions[qi]) { cells += '<div></div>'; continue; }
        const [cc, cx] = CELL_COLORS[qi % CELL_COLORS.length];
        const rot = (((ci * 7 + qi * 3) % 5) - 2) * 0.7;
        cells += `<div class="cell" data-key="${U.cellKey(r, ci, qi)}" style="--cc:${cc};--cx:${cx};--r:${rot}deg;--d:${(ci + qi) * 0.05 + 0.15}s">${U.cellValue(r, ci, qi)}</div>`;
      }
    });
    const el = h(`
      <div class="view board">
        <div class="board-head">
          <span class="tag black round">${esc(R.name)}</span>
          <span class="tag white vibe">${esc(pick(['ваш ход, ребята', 'выбирайте, не тяните', 'ну что, кто смелый?', 'дорого = больно']))}</span>
          <div class="logo" style="font-size:${Math.min(64, Math.round(1500 / Math.max(6, titleParts().main.length)))}px">${esc(titleParts().main)}</div>
          <div class="join-card mini" hidden><img class="jc-qr" alt="QR-код"><div><div class="jc-code"></div><span class="jc-dev"></span></div></div>
        </div>
        <div class="board-grid" style="--cols:${cols}">${cells}</div>
      </div>`);
    return {
      type: 'board', el, round: r,
      update(st) {
        el.classList.toggle('with-qr', updateJoin(el, st));
        $$('.cell', el).forEach((cell) => {
          const u = st.used[cell.dataset.key];
          cell.classList.toggle('used', !!u);
          const old = $('.dot', cell);
          const t = u && u.by ? teamById(st, u.by) : null;
          if (t && !old) cell.appendChild(h(`<span class="dot emoji-font" style="${teamVars(t)}">${esc(t.emoji)}</span>`));
          if (!t && old) old.remove();
        });
      },
    };
  }

  /* ---------- медиа по типу вопроса ---------- */
  function buildMedia(q) {
    const m = q.media || {};
    const imgs = m.images || [];
    switch (q.type) {
      case 'emoji': {
        const list = graphemes(m.emoji || '').filter((g) => g.trim());
        const n = list.length;
        const size = n <= 2 ? 300 : n <= 3 ? 260 : n <= 4 ? 220 : n <= 6 ? 170 : 130;
        return { el: h(`<div class="emoji-row emoji-font" style="--es:${size}px">${list.map((g, i) => `<span class="emo" style="--i:${i}">${esc(g)}</span>`).join('')}</div>`) };
      }
      case 'zoom':
      case 'blur': {
        const el = h(`
          <div class="lens">
            <img src="${esc(imgs[0] || '')}" alt="">
            <div class="scan"></div>
            <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
            <div class="readout"></div><div class="rec">REC</div>
          </div>`);
        const img = $('img', el), readout = $('.readout', el);
        const z = Object.assign({ x: 0.5, y: 0.5, scale: 5 }, m.zoom || {});
        return {
          el,
          /** p — прогресс таймера 0..1, done — ответ показан. */
          progress(p, done) {
            if (done) {
              if (!el.classList.contains('done')) {
                el.classList.add('done');
                img.style.transform = 'none';
                img.style.filter = 'none';
                readout.textContent = q.type === 'zoom' ? 'ZOOM ×1.0' : 'BLUR 0';
              }
              return;
            }
            el.classList.remove('done');
            if (q.type === 'zoom') {
              const W = el.clientWidth, H = el.clientHeight;
              const S = Math.max(1, Number(z.scale) || 1);
              const sc = Math.pow(S, 1 - p); // экспонента — отдаление ощущается равномерным
              const px = z.x * W, py = z.y * H;
              // точка фокуса плывёт из центра кадра на своё место; кадр всегда заполнен
              let tx = (W / 2 + (px - W / 2) * p) - sc * px;
              let ty = (H / 2 + (py - H / 2) * p) - sc * py;
              tx = Math.min(0, Math.max(W - sc * W, tx));
              ty = Math.min(0, Math.max(H - sc * H, ty));
              img.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${sc.toFixed(4)})`;
              readout.textContent = `ZOOM ×${sc.toFixed(1)}`;
            } else {
              const b = 48 * Math.pow(1 - p, 1.25);
              img.style.transformOrigin = '50% 50%';
              img.style.transform = 'scale(1.08)';
              img.style.filter = `blur(${b.toFixed(1)}px) saturate(1.3)`;
              readout.textContent = `BLUR ${Math.round(b)}`;
            }
          },
        };
      }
      case 'fusion': {
        const [a, b] = imgs;
        const caps = m.captions || (q.answer || '').split(/\s*\+\s*|\s*&\s*|\s+и\s+/).filter(Boolean);
        const comp = m.fused
          ? `<img class="f" src="${esc(m.fused)}" alt="">`
          : `<img class="a" src="${esc(a || '')}" alt=""><img class="b" src="${esc(b || a || '')}" alt="">`;
        const fig = (src, side, cap) => `
          <figure class="fuse-orig ${side}"><div class="ph"><img src="${esc(src || '')}" alt=""></div>
          ${cap ? `<figcaption class="tag ${side === 'left' ? 'black' : 'pink'}">${esc(cap)}</figcaption>` : ''}</figure>`;
        const el = h(`
          <div class="fusion">
            ${fig(a, 'left', caps.length === 2 ? caps[0] : '')}
            ${fig(b, 'right', caps.length === 2 ? caps[1] : '')}
            <div class="fuse-frame">
              <div class="fuse-layer ch-r">${comp}</div>
              <div class="fuse-layer ch-c">${comp}</div>
              <div class="fuse-layer slice">${comp}</div>
              <div class="scan"></div>
            </div>
            <span class="tag lime fuse-tag">нейросеть намутила</span>
          </div>`);
        return { el };
      }
      case 'image':
        if (!imgs.length) return null;
        return { el: h(`<div class="img-grid">${imgs.map((src, i) => `<div class="img-card" style="--d:${i * 0.15}s;--r:${i % 2 ? 2.5 : -2.5}deg"><img src="${esc(src)}" alt=""></div>`).join('')}</div>`) };
      default:
        return null;
    }
  }

  /**
   * Экран вопроса. opts: {key, cat, valueText, q, special, final}
   * Динамика (этап, владелец, ставка, баззер…) приходит через getInfo(s).
   */
  function QuestionView(opts, getInfo) {
    const q = opts.q;
    const media = buildMedia(q);
    const plen = (q.prompt || '').length;
    const el = h(`
      <div class="view question t-${media ? q.type : 'text'}">
        <div class="tbar" style="opacity:0"></div>
        <div class="q-head">
          <span class="tag black q-cat">${esc(opts.cat)}</span>
          <span class="slot-badge"></span>
          <span class="slot-buzz"></span>
          <div class="grow"></div>
          <div class="q-value ${opts.final ? 'final' : ''}"><span class="qv">${esc(opts.valueText)}</span></div>
          <div class="timer idle"><div class="num"></div></div>
        </div>
        <div class="q-prompt-wrap"><div class="pbox">
          <div class="q-prompt stk ${plen > 150 ? 'xlong' : plen > 90 ? 'long' : ''}">${esc(q.prompt)}</div>
          <span class="tag black press-hint" style="display:none"></span>
        </div></div>
        <div class="q-media"></div>
        <div class="q-answer-wrap"><div>
          <div class="q-answer">
            <div class="lbl">ОТВЕТ</div>
            <div class="body"><div class="txt">${esc(q.answer)}</div>${q.note ? `<div class="note">${esc(q.note)}</div>` : ''}</div>
            <div class="by"></div>
          </div>
        </div></div>
      </div>`);
    if (media) $('.q-media', el).appendChild(media.el);
    guardImages(el);
    fitBadge($('.qv', el));

    const timerEl = $('.timer', el), numEl = $('.num', el), tbar = $('.tbar', el), hintEl = $('.press-hint', el);
    let special = null;
    let lastStage = null;
    let sigBadge = '', sigBuzz = '', sigBy = '', sigHint = '';

    function buildSpecial(kind) {
      const cat = kind === 'cat';
      const sp = h(`
        <div class="special ${kind}">
          <div class="stripes"></div>
          ${cat ? '' : Array.from({ length: 16 }, (_, i) => `<span class="money emoji-font" style="left:${(i * 6.3 + 2) % 100}%;animation-duration:${2.6 + (i % 5) * 0.5}s;animation-delay:${-(i * 0.37)}s">${['💸', '💰', '🪙', '💵'][i % 4]}</span>`).join('')}
          <div class="inner">
            <div class="big-emo emoji-font">${cat ? '🐱' : '💸'}</div>
            <h2 class="mega ${cat ? '' : 'lime'}">${letters(cat ? 'Кот в мешке' : 'Аукцион', 250)}</h2>
            <span class="tag ${cat ? 'white' : 'black'} sub">${cat ? 'вопрос улетает другой команде' : 'ставки, господа. кто больше?'}</span>
            <div class="owner-slot"></div>
          </div>
        </div>`);
      el.appendChild(sp);
      setTimeout(() => window.Sfx.play(cat ? 'meow' : 'cash'), 300);
      return sp;
    }

    return {
      type: opts.final ? 'finalq' : 'question', el, key: opts.key,
      update(s) {
        const info = getInfo(s);
        if (!info) return;
        // заставка спец-вопроса
        if (opts.special && info.stage === 'intro' && !special) special = buildSpecial(opts.special);
        if (special && info.stage !== 'intro' && !special.classList.contains('out')) {
          const sp = special;
          sp.classList.add('out');
          setTimeout(() => sp.remove(), 600);
        }
        if (special && info.stage === 'intro') {
          const t = info.owner && teamById(s, info.owner);
          const slot = $('.owner-slot', special);
          const want = t ? `${t.id}|${info.bet}` : '';
          if (slot.dataset.sig !== want) {
            slot.dataset.sig = want;
            slot.innerHTML = t ? chip(t, '', opts.special === 'auction' && info.bet ? ` · ${info.bet}` : ' — ваш выход') : '';
          }
        }
        // бейдж спец-вопроса
        let badge = '';
        if (opts.special) {
          const t = info.owner && teamById(s, info.owner);
          const word = opts.special === 'cat' ? 'кот в мешке' : 'аукцион';
          badge = t
            ? `<span class="tag team q-badge" style="${teamVars(t)}">${word} → ${esc(t.name)}</span>`
            : `<span class="tag pink q-badge">${word}</span>`;
        }
        if (badge !== sigBadge) { sigBadge = badge; $('.slot-badge', el).innerHTML = badge; }
        if (opts.special === 'auction' && info.bet && $('.qv', el).textContent !== String(info.bet)) { $('.qv', el).textContent = info.bet; fitBadge($('.qv', el)); }
        // кто нажал баззер
        const bt = info.buzz && teamById(s, info.buzz);
        const buzz = bt ? `<span class="tag team q-buzz" style="${teamVars(bt)}"><span class="emoji-font">${esc(bt.emoji)}</span>${esc(bt.name)} отвечает</span>` : '';
        if (buzz !== sigBuzz) { sigBuzz = buzz; $('.slot-buzz', el).innerHTML = buzz; }
        // подсказка над вопросом
        const hint = info.stage === 'question' ? (opts.final ? 'пишите ответ на бумажке' : (!bt && !opts.special ? 'жми, если знаешь' : '')) : '';
        if (hint !== sigHint) { sigHint = hint; hintEl.textContent = hint; hintEl.style.display = hint ? '' : 'none'; }
        // ответ
        el.classList.toggle('revealed', info.stage === 'answer');
        const by = info.byHtml || '';
        if (by !== sigBy) { sigBy = by; $('.by', el).innerHTML = by; }
        lastStage = info.stage;
      },
      tick(s) {
        const t = s.timer;
        const rem = U.timerRemaining(t);
        const total = t.duration * 1000;
        const started = t.running || rem < total;
        const frac = total ? rem / total : 0;
        timerEl.style.setProperty('--p', frac.toFixed(4));
        const sec = String(Math.ceil(rem / 1000));
        if (numEl.textContent !== sec) numEl.textContent = sec;
        timerEl.classList.toggle('idle', !started);
        timerEl.classList.toggle('low', started && rem > 0 && rem <= 5000);
        tbar.style.transform = `scaleX(${frac})`;
        tbar.style.opacity = started && lastStage === 'question' ? 1 : 0;
        tbar.classList.toggle('low', rem <= 5000);
        if (media && media.progress) media.progress(started ? 1 - frac : 0, lastStage === 'answer');
      },
      onTimeUp() {
        timerEl.classList.remove('zero'); void timerEl.offsetWidth; timerEl.classList.add('zero');
        bigStamp('ВСЁ, ВРЕМЯ');
      },
    };
  }

  function questionViewFor(s) {
    const cur = s.current;
    const x = U.getQ(cur.r, cur.c, cur.q);
    if (!x) return null;
    return QuestionView({
      key: 'q-' + cur.key,
      cat: x.cat.name,
      valueText: U.cellValue(cur.r, cur.c, cur.q),
      q: x.q, special: cur.special,
    }, (st) => {
      const c = st.current;
      if (!c) return null;
      const w = c.winner && teamById(st, c.winner);
      let byHtml = '';
      if (w) byHtml = chip(w, '', ` +${U.currentValue(st)}`);
      else if (c.stage === 'answer') byHtml = '<span class="tag pink shame">никто не знает? позор</span>';
      return { stage: c.stage, owner: c.owner, bet: c.bet, buzz: st.buzzer.winner, byHtml };
    });
  }

  function finalQuestionView() {
    const f = quiz.final;
    return QuestionView({ key: 'final-q', final: true, cat: f.category, valueText: 'ФИНАЛ', q: f }, (st) => {
      const res = st.final.results;
      const chips = st.teams.filter((t) => res[t.id] !== undefined).map((t) => {
        const bet = st.final.bets[t.id] || 0;
        return chip(t, res[t.id] ? '' : 'wait', ` ${res[t.id] ? '+' : '−'}${bet}`);
      }).join('');
      return { stage: st.final.stage === 'answer' ? 'answer' : 'question', byHtml: chips };
    });
  }

  function FinalIntroView() {
    const f = quiz.final || { category: 'Финал' };
    const el = h(`
      <div class="view final-intro">
        <div class="inner">
          <h1 class="mega wiggle" style="--mega:210px">${letters('Финалочка', 100)}</h1>
          <span class="tag white cat">тема: ${esc(f.category)}</span>
          <span class="tag black hint"></span>
          <div class="bets"></div>
        </div>
      </div>`);
    let sig = '';
    return {
      type: 'finalintro', el,
      update(s) {
        const bets = s.final.stage === 'bets';
        $('.hint', el).textContent = bets ? 'ставки сделаны? пишем сумму и отдаём ведущему' : 'один вопрос. всё или ничего';
        const nsig = bets ? JSON.stringify(s.teams.map((t) => [t.id, s.final.bets[t.id] !== undefined])) : '';
        if (nsig !== sig) {
          sig = nsig;
          $('.bets', el).innerHTML = bets
            ? s.teams.map((t) => { const ok = s.final.bets[t.id] !== undefined; return chip(t, ok ? '' : 'wait', ok ? ' · есть' : ' · думают…'); }).join('')
            : '';
        }
      },
    };
  }

  function WinnerView(s) {
    const sorted = s.teams.slice().sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, 3);
    const order = [top[1], top[0], top[2]];
    const cols = order.map((t) => {
      if (!t) return '';
      const place = t === top[0] ? 1 : t === top[1] ? 2 : 3;
      const d = place === 1 ? 1.1 : place === 2 ? 0.6 : 0.2;
      return `
        <div class="pcol p${place}" style="${teamVars(t)};--d:${d}s">
          <div class="who">
            <div class="ava emoji-font">${place === 1 ? '<span class="crown">👑</span>' : ''}${avaInner(t)}</div>
            <span class="tag white nm">${esc(t.name)}</span>
          </div>
          <div class="block">${place}<small>${t.score}</small></div>
        </div>`;
    }).join('');
    const rest = sorted.slice(3).map((t) => chip(t, '', ` · ${t.score}`)).join('');
    const champ = top[0];
    const el = h(`
      <div class="view full winner">
        <span class="tag lime kicker">корона достаётся…</span>
        <h1 class="mega lime wiggle" style="--mega:${champ ? megaSize(champ.name, 150, 1) : 150}px">${letters(champ ? champ.name : 'никому', 500)}</h1>
        <div class="podium">${cols}</div>
        ${rest ? `<div class="others">${rest}</div>` : ''}
      </div>`);
    return {
      type: 'winner', el,
      mounted() {
        window.Sfx.play('fanfare');
        const colors = champ ? [champ.color, '#FFFFFF', '#C6FF00', '#FF2E93', '#2B4BFF', '#FF6A00'] : undefined;
        setTimeout(() => confetti.cannons({ count: 160, colors }), 900);
        setTimeout(() => confetti.rain(6000, { colors }), 1400);
      },
    };
  }

  /* ======================================================================
     ПЕРЕХОДЫ
     ====================================================================== */
  function viewKeyOf(s) {
    switch (s.phase) {
      case 'board': return 'board-' + s.round;
      case 'question': return s.current ? 'q-' + s.current.key : 'board-' + s.round;
      case 'final': return (s.final.stage === 'intro' || s.final.stage === 'bets') ? 'final-intro' : 'final-q';
      case 'winner': return 'winner';
      default: return 'splash';
    }
  }

  function createView(key, s) {
    let v = null;
    if (key === 'splash') v = SplashView(s);
    else if (key.startsWith('board-')) v = BoardView(s);
    else if (key.startsWith('q-')) v = questionViewFor(s);
    else if (key === 'final-intro') v = FinalIntroView(s);
    else if (key === 'final-q') v = quiz.final ? finalQuestionView(s) : FinalIntroView(s);
    else if (key === 'winner') v = WinnerView(s);
    if (!v) v = SplashView(s);
    v.key = key;
    return v;
  }

  function mount(v, s) {
    viewsEl.appendChild(v.el);
    if (v.update) v.update(s);
    view = v;
    setTheme(v.type);
    setTickers(v.type);
    if (v.mounted) v.mounted();
    scorebar.classList.toggle('hidden', v.type === 'splash' || v.type === 'winner' || !s.teams.length);
  }

  /** Резкая смена экрана: цветные полосы-шторки накрывают и уезжают. */
  async function wipe(swap) {
    const colors = ['var(--lime)', 'var(--pink)', 'var(--white)', 'var(--orange)', 'var(--black)'];
    const w = h(`<div class="wipe">${colors.map((c, i) => `<i style="left:${i * 22 - 8}%;width:30%;background:${c}"></i>`).join('')}</div>`);
    stageEl.appendChild(w);
    const bars = Array.from(w.children);
    const ease = 'cubic-bezier(.7, 0, .3, 1)';
    window.Sfx.play('whoosh');
    await Promise.all(bars.map((b, i) => b.animate(
      [{ transform: 'translateY(-125%) skewX(-10deg)' }, { transform: 'translateY(0) skewX(-10deg)' }],
      { duration: 320, delay: i * 45, easing: ease, fill: 'forwards' }).finished));
    swap();
    await sleep(60);
    await Promise.all(bars.map((b, i) => b.animate(
      [{ transform: 'translateY(0) skewX(-10deg)' }, { transform: 'translateY(125%) skewX(-10deg)' }],
      { duration: 360, delay: i * 45, easing: ease, fill: 'forwards' }).finished));
    w.remove();
  }

  /** Ячейка мигает, «отрывается» и летит на весь экран (FLIP), потом уезжает вверх как наклейка. */
  async function flipFromCell(board, cellKey, next) {
    const cell = board.el.querySelector(`[data-key="${cellKey}"]`);
    if (!cell) { await wipe(() => { board.el.remove(); mount(next, Store.get()); }); return; }
    cell.classList.add('picked');
    await sleep(950);
    const r = rectInStage(cell);
    const ghost = h(`<div class="flip-ghost" style="width:${SW}px;height:${SH}px"><span>${esc(cell.textContent)}</span></div>`);
    stageEl.appendChild(ghost);
    cell.style.visibility = 'hidden';
    window.Sfx.play('whoosh');
    await ghost.animate([
      { transform: `translate(${r.x}px, ${r.y}px) rotate(-6deg) scale(${r.w / SW}, ${r.h / SH})` },
      { transform: `translate(${r.x * 0.4}px, ${r.y * 0.4 - 60}px) rotate(4deg) scale(${0.5 + r.w / (2 * SW)}, ${0.5 + r.h / (2 * SH)})`, offset: 0.55 },
      { transform: 'translate(0, 0) rotate(0) scale(1, 1)' },
    ], { duration: 650, easing: 'cubic-bezier(.6, 0, .25, 1)', fill: 'forwards' }).finished;
    board.el.remove();
    mount(next, Store.get());
    await ghost.animate([
      { transform: 'translate(0, 0) rotate(0)' },
      { transform: 'translate(0, -115%) rotate(-5deg)' },
    ], { duration: 520, easing: 'cubic-bezier(.7, 0, .3, 1)', fill: 'forwards' }).finished;
    ghost.remove();
  }

  function showRoundTitle(text) {
    const o = h(`<div class="round-title"><div class="mega wiggle">${letters(text)}</div></div>`);
    shell.appendChild(o);
    setTimeout(() => o.remove(), 2100);
  }

  async function transition(old, key, s) {
    const next = createView(key, s);
    if (!old) { mount(next, s); return; }
    if (old.type === 'board' && next.type === 'question' && s.current) {
      await flipFromCell(old, s.current.key, next);
      return;
    }
    await wipe(() => { old.el.remove(); mount(next, Store.get()); });
    if (next.type === 'board' && old.type !== 'question') {
      const R = quiz.rounds[s.round];
      showRoundTitle(R ? R.name : 'Раунд');
    }
  }

  async function render() {
    if (busy) { pending = true; return; }
    const s = Store.get();
    updateScorebar(s);
    const key = viewKeyOf(s);
    if (view && view.key === key) { if (view.update) view.update(s); return; }
    busy = true;
    try { await transition(view, key, s); } catch (e) { console.error(e); }
    busy = false;
    if (pending) { pending = false; render(); }
  }

  /* ======================================================================
     СЧЁТ КОМАНД
     ====================================================================== */
  const shown = {};      // отображаемое (анимируемое) значение счёта
  const counters = {};
  let teamSig = '';

  function updateScorebar(s) {
    const sig = JSON.stringify(s.teams.map((t) => [t.id, t.name, t.emoji, t.color, t.key, t.avatarV || 0]));
    if (sig !== teamSig) {
      teamSig = sig;
      scorebar.innerHTML = s.teams.map((t) => `
        <div class="team" data-id="${t.id}" style="${teamVars(t)}">
          <span class="crown emoji-font">👑</span>
          <div class="ava emoji-font">${avaInner(t)}</div>
          <div class="meta"><div class="nm">${esc(t.name)}</div><div class="sc">0</div></div>
          <kbd>${esc(U.keyLabel(t.key))}</kbd>
        </div>`).join('');
      s.teams.forEach((t) => { if (shown[t.id] === undefined) shown[t.id] = t.score; setScoreText(t.id, shown[t.id]); });
    }
    const max = Math.max(...s.teams.map((t) => t.score));
    const leaders = s.teams.filter((t) => t.score === max);
    const cur = s.phase === 'question' ? s.current : null;
    s.teams.forEach((t) => {
      const card = scorebar.querySelector(`[data-id="${t.id}"]`);
      if (!card) return;
      card.classList.toggle('lead', max > 0 && leaders.length === 1 && leaders[0].id === t.id);
      card.classList.toggle('buzzed', s.buzzer.winner === t.id && s.phase === 'question');
      card.classList.toggle('out', !!(cur && cur.stage !== 'answer' && cur.wrong.includes(t.id)));
      card.classList.toggle('owner', !!(cur && cur.owner === t.id && cur.stage !== 'answer'));
      if (shown[t.id] !== t.score) countTo(t.id, t.score);
    });
    if (view) scorebar.classList.toggle('hidden', view.type === 'splash' || view.type === 'winner' || !s.teams.length);
  }

  function setScoreText(id, v) {
    const el = scorebar.querySelector(`[data-id="${id}"] .sc`);
    if (!el) return;
    el.textContent = Math.round(v);
    el.classList.toggle('neg', v < 0);
  }

  /** Анимированный count-up от текущего отображаемого значения. */
  function countTo(id, target) {
    if (counters[id] && counters[id].target === target) return;
    const from = shown[id] === undefined ? target : shown[id];
    const t0 = performance.now();
    const c = { target };
    counters[id] = c;
    const step = (now) => {
      if (counters[id] !== c) return;
      const k = Math.min(1, (now - t0) / 1100);
      shown[id] = from + (target - from) * (1 - Math.pow(1 - k, 3));
      setScoreText(id, shown[id]);
      if (k < 1) requestAnimationFrame(step);
      else { shown[id] = target; delete counters[id]; }
    };
    requestAnimationFrame(step);
  }

  function popup(teamId, delta) {
    const card = scorebar.querySelector(`[data-id="${teamId}"]`);
    if (!card || !delta) return;
    const n = Math.abs(delta);
    const p = h(delta > 0
      ? `<div class="pop plus">+${n} АУРЫ</div>`
      : `<div class="pop minus"><small>МИНУС ВАЙБ</small>−${n}</div>`);
    card.appendChild(p);
    setTimeout(() => p.remove(), 2300);
  }

  function retrigger(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

  /* ======================================================================
     ЭФФЕКТЫ ПО СОБЫТИЯМ
     ====================================================================== */
  let buzzTimer = 0;
  function showBuzz(t, test) {
    clearTimeout(buzzTimer);
    buzzEl.className = '';
    buzzEl.style.cssText = teamVars(t);
    buzzEl.innerHTML = `
      <div class="stripes"></div>
      <div class="inner">
        <div class="e emoji-font ${t.avatar ? 'has-av' : ''}">${avaInner(t)}</div>
        <span class="tag ${U.textOn(t.color) === '#ffffff' ? 'white' : 'black'} n">${esc(t.name)}</span>
        <div class="mega">${letters(test ? 'на связи!' : 'ПЕРВЫЕ!', 80)}</div>
      </div>`;
    void buzzEl.offsetWidth;
    buzzEl.classList.add('on');
    if (test) buzzEl.classList.add('test');
    buzzTimer = setTimeout(hideBuzz, test ? 1500 : 2300);
  }
  function hideBuzz() {
    if (!buzzEl.classList.contains('on')) return;
    buzzEl.classList.remove('on');
    buzzEl.classList.add('off');
    setTimeout(() => { if (buzzEl.classList.contains('off')) buzzEl.className = ''; }, 420);
  }

  function handleEvent(ev, s) {
    const t = ev.teamId && teamById(s, ev.teamId);
    const card = t && scorebar.querySelector(`[data-id="${t.id}"]`);
    switch (ev.kind) {
      case 'select': window.Sfx.play('select'); break;
      case 'correct': {
        window.Sfx.play('correct');
        window.Music.stinger('correct');
        popup(ev.teamId, ev.delta);
        if (card) {
          retrigger(card, 'hit');
          const r = rectInStage(card);
          confetti.burst(r.x + r.w / 2, r.y, { count: 140, colors: [t.color, '#FFFFFF', '#C6FF00', '#FF2E93', '#2B4BFF', '#FF6A00'], speed: 26 });
        }
        confetti.cannons({ count: 90 });
        break;
      }
      case 'wrong':
        window.Sfx.play('wrong');
        window.Music.stinger('wrong');
        popup(ev.teamId, ev.delta);
        if (card) retrigger(card, 'miss');
        retrigger(shell, 'shake');
        retrigger(flashEl, 'on');
        bigStamp('МИМО');
        break;
      case 'adjust': window.Sfx.play('pop'); popup(ev.teamId, ev.delta); break;
      case 'undo': window.Sfx.play('pop'); (ev.changed || []).forEach((c) => popup(c.teamId, c.delta)); break;
      case 'buzz': if (t) { window.Sfx.play('buzz'); showBuzz(t, ev.test); } break;
      case 'buzzReset': hideBuzz(); break;
      case 'reveal': window.Sfx.play('reveal'); break;
      case 'owner': window.Sfx.play('pop'); break;
      default: break;
    }
  }

  function processEvents(s) {
    s.events.filter((e) => e.id > lastEvent).forEach((ev) => {
      lastEvent = ev.id;
      if (Date.now() - ev.at < 8000) handleEvent(ev, s); // старое не проигрываем
    });
    lastEvent = Math.max(lastEvent, s.eventSeq || 0);
  }

  /* ======================================================================
     ТАЙМЕР: тик в последние 5 секунд, «время вышло»
     ====================================================================== */
  let prevRem = null, prevSec = null;
  function timerSounds(s) {
    const active = (s.phase === 'question' && s.current && s.current.stage === 'question') || (s.phase === 'final' && s.final.stage === 'question');
    if (!active) { prevRem = null; prevSec = null; return; }
    const t = s.timer;
    const rem = U.timerRemaining(t);
    if (t.running) {
      const sec = Math.ceil(rem / 1000);
      if (prevSec !== null && sec !== prevSec && sec <= 5 && sec > 0) window.Sfx.play('tick');
      if (prevRem !== null && prevRem > 0 && rem === 0) {
        window.Sfx.play('timeUp');
        if (view && view.onTimeUp) view.onTimeUp();
      }
      prevSec = sec;
    } else prevSec = null;
    prevRem = rem;
  }

  /* ---------- большой отсчёт 5-4-3-2-1 по центру ---------- */
  const cdEl = $('#countdown');
  let cdShown = 0;
  function countdown(s) {
    const t = s.timer;
    const active = ((s.phase === 'question' && s.current && s.current.stage === 'question') || (s.phase === 'final' && s.final.stage === 'question'))
      && t.running && view && (view.type === 'question' || view.type === 'finalq') && !busy;
    const rem = active ? U.timerRemaining(t) : 0;
    const n = active && rem > 0 && rem <= 5000 ? Math.ceil(rem / 1000) : 0;
    if (n === cdShown) return;
    cdShown = n;
    if (!n) { cdEl.className = ''; cdEl.innerHTML = ''; return; } // пауза/ответ/ноль — сразу убираем
    cdEl.className = 'on';
    cdEl.innerHTML = `<div class="cd-num mega" style="--mega:560px">${n}</div>`;
  }

  /* ---------- фоновая музыка ---------- */
  const musicLoaded = {}; // mode → at загруженного своего файла
  let musicSyncAt = 0;
  function musicSettings(s) {
    const m = Object.assign({ enabled: true, volume: 0.5, sfx: 0.8, files: {} }, s.music || {});
    window.Music.configure({ enabled: m.enabled, volume: m.volume });
    window.Sfx.setSfxVolume(m.sfx);
    return m;
  }
  /** Свои файлы ведущего из IndexedDB (после первого клика, когда звук разрешён). */
  function syncMusicFiles(s) {
    if (!window.Sfx.unlocked() || !window.MediaDB) return;
    const files = (s.music && s.music.files) || {};
    ['board', 'question', 'final'].forEach((k) => {
      const want = files[k] ? files[k].at : 0;
      if ((musicLoaded[k] || 0) === want) return;
      musicLoaded[k] = want;
      if (!want) { window.Music.setCustom(k, null); return; }
      window.MediaDB.get(k).then((rec) => { if (rec && rec.data && musicLoaded[k] === want) window.Music.setCustom(k, rec.data); });
    });
  }
  function musicTick(s) {
    let mode = 'board', inten = 0, duck = false;
    const t = s.timer, rem = U.timerRemaining(t), total = t.duration * 1000;
    const started = t.running || rem < total;
    if (s.phase === 'question' && s.current) {
      mode = s.current.stage === 'answer' ? 'board' : 'question'; // ответ показан — обратно к «табло»
      duck = !!s.buzzer.winner;                                   // «ПЕРВЫЕ!» — музыка проваливается
      if (s.current.stage === 'question' && started) inten = 1 - rem / total;
    } else if (s.phase === 'final') {
      mode = 'final';
      if (s.final.stage === 'question' && started) inten = 1 - rem / total;
    }
    window.Music.update({ mode, intensity: inten, duck });
    const now = performance.now();
    if (now - musicSyncAt > 1000) { musicSyncAt = now; syncMusicFiles(s); }
  }

  function frame() {
    const s = Store.get();
    countdown(s);
    musicTick(s);
    if (view && view.tick && view.el.isConnected) view.tick(s);
    timerSounds(s);
    requestAnimationFrame(frame);
  }

  /* ======================================================================
     ВВОД: баззеры, F — полный экран, звук
     ====================================================================== */
  const hint = $('#sound-hint');
  function unlockAudio() { window.Sfx.unlock(); hint.classList.add('gone'); }
  function toggleFS() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', (e) => {
    unlockAudio();
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const s = Store.get();
    const t = s.teams.find((x) => x.key && x.key === e.code);
    if (t) { e.preventDefault(); Store.dispatch({ type: 'buzz', teamId: t.id }); return; }
    if (e.code === 'KeyF') toggleFS();
  });
  $('#btn-fs').addEventListener('click', toggleFS);
  const muteBtn = $('#btn-mute');
  const syncMute = () => { muteBtn.textContent = window.Sfx.isMuted() ? '🔇' : '🔊'; };
  muteBtn.addEventListener('click', () => { window.Sfx.toggle(); syncMute(); });
  syncMute();

  let idleT = 0;
  window.addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => document.body.classList.add('idle'), 2500);
  });

  /* ---------- старт ---------- */
  window.loadQuiz().then(({ quiz: q }) => {
    quiz = q;
    window.Store.setQuiz(q);
    lastEvent = Store.get().eventSeq || 0; // старые события не проигрываем
    render();
    musicSettings(Store.get());
    Store.subscribe((s) => { processEvents(s); render(); musicSettings(s); });
    requestAnimationFrame(frame);
  });

  window.__screen = { get view() { return view; }, confetti };
})();
