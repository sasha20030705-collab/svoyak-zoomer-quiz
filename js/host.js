/* ==========================================================================
   Пульт ведущего. Рендерит панели по состоянию стора и шлёт действия.
   Все клики — через data-act (делегирование), поля ввода — через data-input.
   После каждой перерисовки возвращаем фокус в поле, где печатали.
   ========================================================================== */
(function () {
  'use strict';
  const U = window.QuizUtil;
  const S = window.Store;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tv = (t) => `--tc:${t.color};--tx:${U.textOn(t.color)}`;

  const mainEl = $('#main'), sideEl = $('#side'), bannersEl = $('#banners'), toastEl = $('#toast');
  const EMO_PICKS = ['🦄', '🔥', '👾', '🐸', '🍒', '💿', '🦋', '👽', '🪩', '🛸', '🐙', '⚡', '🎀', '🐱', '🦖', '👑'];
  // «1» — старт/пауза таймера (верхний ряд и цифровой блок, на любой раскладке)
  const TIMER_KEYS = ['Digit1', 'Numpad1'];
  // эти клавиши нельзя назначить баззером команды
  const RESERVED_KEYS = ['Digit1', 'Numpad1', 'Space', 'Enter', 'NumpadEnter', 'Tab', 'Escape', 'KeyF', 'Backspace'];
  const TYPE_NAMES = { text: 'текст', image: 'картинка', fusion: 'слияние', zoom: 'зум', blur: 'размытие', emoji: 'эмодзи' };

  let quiz = null, source = '';
  let capture = null;            // id команды, для которой ловим клавишу
  let armedKey = null, armedTimer = 0; // двойное нажатие для опасных действий
  let popupBlocked = false;
  let lastEvent = 0;

  /* ---------- утилиты ---------- */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }
  /** Подтверждение вторым нажатием (confirm() в песочнице может быть запрещён). */
  function confirmTwice(key, msg) {
    if (armedKey === key) { armedKey = null; clearTimeout(armedTimer); return true; }
    armedKey = key;
    toast(msg);
    clearTimeout(armedTimer);
    armedTimer = setTimeout(() => { armedKey = null; render(); }, 3500);
    render();
    return false;
  }
  const teamById = (s, id) => s.teams.find((t) => t.id === id);
  const av = (t) => `<span class="av emoji-font" style="${tv(t)}">${t.avatar ? `<img src="${t.avatar}" alt="">` : esc(t.emoji)}</span>`;

  /* ======================================================================
     ПАНЕЛИ
     ====================================================================== */
  function renderSetup(s) {
    const teams = s.teams.map((t) => `
      <div class="team-edit" style="${tv(t)}">
        <input class="emo emoji-font" type="text" id="emo-${t.id}" data-input="teamEmoji" data-id="${t.id}" value="${esc(t.emoji)}" maxlength="8" aria-label="эмодзи команды">
        <input type="text" id="name-${t.id}" data-input="teamName" data-id="${t.id}" value="${esc(t.name)}" maxlength="28" aria-label="название команды">
        <button class="btn sm" data-act="teamRemove" data-id="${t.id}" aria-label="удалить команду">✕</button>
        <div class="swatches">${U.PALETTE.map((c) => `<button class="sw ${c === t.color ? 'on' : ''}" style="background:${c}" data-act="teamColor" data-id="${t.id}" data-color="${c}" aria-label="цвет ${c}"></button>`).join('')}</div>
        <div class="keyrow">
          <span class="small muted">баззер:</span>
          <button class="btn sm ${capture === t.id ? 'capturing' : ''}" data-act="captureKey" data-id="${t.id}">
            ${capture === t.id ? 'жми клавишу…' : `клавиша <span class="kbd">${esc(U.keyLabel(t.key))}</span>`}
          </button>
        </div>
        <div class="emoji-picks" style="grid-column:1/-1">${EMO_PICKS.map((e) => `<button class="emoji-font" data-act="teamEmojiPick" data-id="${t.id}" data-emoji="${e}">${e}</button>`).join('')}</div>
      </div>`).join('');
    return `
      <section class="card">
        <h2>Команды <span class="sp muted small">${s.teams.length}/8</span></h2>
        ${teams || '<p class="muted">Пока пусто. Добавь хотя бы две команды.</p>'}
        <button class="btn" data-act="teamAdd" ${s.teams.length >= 8 ? 'disabled' : ''}>+ команда</button>
      </section>
      <section class="card">
        <h2>Поехали</h2>
        <p class="muted">1. Открой экран для гостей, перетащи окно на ТВ и нажми там <span class="kbd">F</span>.<br>
        2. Команды жмут свои клавиши на клавиатуре компа с экраном — там загорится «на связи».<br>
        3. Жми «Начать».</p>
        <div class="row">
          <button class="btn big lime" data-act="openScreen">📺 Открыть экран для гостей</button>
          <button class="btn big pink" data-act="startGame" ${s.teams.length ? '' : 'disabled'}>Начать игру →</button>
        </div>
      </section>`;
  }

  function renderBoard(s) {
    const r = s.round;
    const R = quiz.rounds[r];
    if (!R) return '<section class="card"><h2>Нет вопросов</h2><p class="muted">Проверь data/questions.js</p></section>';
    const cols = Math.max(1, ...R.categories.map((c) => c.questions.length));
    let used = 0, total = 0;
    const rows = R.categories.map((c, ci) => {
      const cells = c.questions.map((q, qi) => {
        const key = U.cellKey(r, ci, qi);
        const u = s.used[key];
        total++; if (u) used++;
        const by = u && u.by && teamById(s, u.by);
        const sp = q.special === 'cat' ? '🐱' : q.special === 'auction' ? '💸' : '';
        const armed = armedKey === 'open-' + key;
        return `<button class="mcell ${u ? 'used' : ''} ${armed ? 'armed' : ''} ${s.current && s.current.key === key ? 'current' : ''}" data-act="open" data-r="${r}" data-c="${ci}" data-q="${qi}" title="${esc(c.name)} · ${U.cellValue(r, ci, qi)}">
          ${armed ? 'ещё раз' : U.cellValue(r, ci, qi)}${sp ? `<span class="sp emoji-font">${sp}</span>` : ''}${by ? `<span class="dot" style="${tv(by)}"></span>` : ''}</button>`;
      }).join('');
      return `<div class="mrow" style="--cols:${cols}"><div class="mname">${esc(c.name)}</div>${cells}</div>`;
    }).join('');
    const last = r >= quiz.rounds.length - 1;
    return `
      <section class="card">
        <h2>${esc(R.name)} <span class="pill">${used}/${total} сыграно</span>
          ${R.multiplier > 1 ? `<span class="pill black">×${R.multiplier}</span>` : ''}</h2>
        <p class="muted small">Тапни ячейку — вопрос откроется у гостей. 🐱 кот в мешке, 💸 аукцион. Сыгранную можно открыть снова двойным нажатием.</p>
        <div class="mboard">${rows}</div>
        <div class="row" style="margin-top:14px">
          ${last
            ? `<button class="btn orange" data-act="gotoFinal" ${quiz.final ? '' : 'disabled'}>Финал →</button>`
            : `<button class="btn orange" data-act="gotoRound" data-round="${r + 1}">${esc(quiz.rounds[r + 1].name)} →</button>`}
        </div>
      </section>`;
  }

  function mediaPreview(q) {
    const m = q.media || {};
    if (q.type === 'emoji' && m.emoji) return `<div class="emoji-big emoji-font">${esc(m.emoji)}</div>`;
    const imgs = (m.fused ? [m.fused] : []).concat(m.images || []);
    if (!imgs.length) return '';
    return `<div class="thumbs">${imgs.map((src) => `<img src="${esc(src)}" alt="" data-src="${esc(src)}">`).join('')}</div>`;
  }

  function questionCard({ catName, valueLabel, q, special, extraPills = '' }) {
    return `
      <section class="card">
        <div class="qmeta">
          <span class="pill black">${esc(catName)}</span>
          <span class="pill lime">${esc(valueLabel)}</span>
          <span class="pill">${TYPE_NAMES[q.type] || q.type}</span>
          ${special === 'cat' ? '<span class="pill pink">🐱 кот в мешке</span>' : ''}
          ${special === 'auction' ? '<span class="pill pink">💸 аукцион</span>' : ''}
          ${extraPills}
        </div>
        <div class="prompt">${esc(q.prompt)}</div>
        ${mediaPreview(q)}
        <div class="answer"><div class="lbl">ПРАВИЛЬНЫЙ ОТВЕТ</div><div class="txt">${esc(q.answer)}</div></div>
        ${q.note ? `<div class="note">${esc(q.note)}</div>` : ''}
      </section>`;
  }

  function renderQuestion(s) {
    const cur = s.current;
    const x = cur && U.getQ(cur.r, cur.c, cur.q);
    if (!x) return renderBoard(s);
    const val = U.currentValue(s);
    let html = questionCard({
      catName: x.cat.name,
      valueLabel: cur.special === 'auction' && cur.bet ? `ставка ${cur.bet}` : String(U.cellValue(cur.r, cur.c, cur.q)),
      q: x.q, special: cur.special,
    });

    // кот в мешке / аукцион: сначала выбираем команду
    if (cur.special && cur.stage === 'intro') {
      const isCat = cur.special === 'cat';
      const nominal = U.cellValue(cur.r, cur.c, cur.q);
      const owner = cur.owner && teamById(s, cur.owner);
      html += `
        <section class="card">
          <h2>${isCat ? '🐱 Кому отдаём кота?' : '💸 Кто выиграл торги?'}</h2>
          <div class="row">${s.teams.map((t) => `<button class="btn ${cur.owner === t.id ? 'pink' : ''}" data-act="owner" data-id="${t.id}">${esc(t.emoji)} ${esc(t.name)}</button>`).join('')}</div>
          ${isCat ? '' : `
            <h3>Ставка</h3>
            <div class="row">
              <div class="grow" style="min-width:120px"><input type="number" id="bet-input" data-input="bet" min="0" step="100" value="${cur.bet || ''}" placeholder="${nominal}" inputmode="numeric"></div>
              ${[nominal, nominal * 2, owner ? Math.max(owner.score, nominal) : null].filter((v, i, a) => v && a.indexOf(v) === i)
                .map((v) => `<button class="btn sm" data-act="betQuick" data-bet="${v}">${v}</button>`).join('')}
            </div>`}
          <div class="row" style="margin-top:12px">
            <button class="btn big lime" data-act="showQuestion" ${cur.owner ? '' : 'disabled'}>Показать вопрос →</button>
          </div>
        </section>`;
    }

    if (cur.stage === 'question') {
      const bz = s.buzzer.winner && teamById(s, s.buzzer.winner);
      const order = s.teams.slice().sort((a, b) => (b.id === s.buzzer.winner) - (a.id === s.buzzer.winner) || (b.id === cur.owner) - (a.id === cur.owner));
      html += `
        <section class="card">
          <h2>Кто ответил? ${bz ? `<span class="pill" style="background:${bz.color};color:${U.textOn(bz.color)}">первые: ${esc(bz.name)}</span>` : ''}</h2>
          <div class="judge">${order.map((t) => {
            const out = cur.wrong.includes(t.id);
            return `<div class="jrow ${s.buzzer.winner === t.id ? 'buzzed' : ''} ${cur.owner === t.id ? 'owner' : ''} ${out ? 'out' : ''}" style="${tv(t)}">
              <div class="jname">${av(t)}<span>${esc(t.name)}${out ? ' · мимо' : ''}</span></div>
              <button class="btn lime" data-act="judge" data-id="${t.id}" data-ok="1">✓ +${val}</button>
              <button class="btn pink" data-act="judge" data-id="${t.id}" data-ok="0">✗ −${val}</button>
            </div>`;
          }).join('')}</div>
          <div class="row" style="margin-top:12px">
            <button class="btn orange" data-act="reveal">Никто — показать ответ</button>
            <button class="btn" data-act="board">← К табло</button>
          </div>
        </section>`;
    }
    if (cur.stage === 'answer') {
      const w = cur.winner && teamById(s, cur.winner);
      html += `
        <section class="card">
          <h2>Ответ на экране ${w ? `<span class="pill lime">${esc(w.name)} +${val}</span>` : '<span class="pill">никто</span>'}</h2>
          <button class="btn big lime wide" data-act="board">← К табло</button>
        </section>`;
    }
    if (cur.stage === 'intro') {
      html += `<section class="card"><div class="row"><button class="btn" data-act="board">← К табло (не играть)</button></div></section>`;
    }
    return html;
  }

  function renderFinal(s) {
    const f = quiz.final;
    if (!f) return '<section class="card"><h2>Финала нет</h2><p class="muted">В data/questions.js нет блока final.</p><button class="btn lime" data-act="showWinner">🏆 Победитель</button></section>';
    const st = s.final.stage;
    let html = questionCard({ catName: 'Финал · ' + f.category, valueLabel: 'ставки', q: f });
    const steps = `
      <div class="row" style="margin-bottom:12px">
        ${[['intro', '1. Тема'], ['bets', '2. Ставки'], ['question', '3. Вопрос'], ['answer', '4. Ответ']]
          .map(([k, l]) => `<button class="btn sm ${st === k ? 'black' : ''}" data-act="finalStage" data-stage="${k}">${l}</button>`).join('')}
      </div>`;
    let body = '';
    if (st === 'intro') {
      body = `<p class="muted">На экране «Финалочка» и тема. Дальше — ставки.</p>
        <button class="btn big lime" data-act="finalStage" data-stage="bets">Собрать ставки →</button>`;
    } else if (st === 'bets') {
      body = `<p class="muted small">Ставка от 0 до текущего счёта команды (по правилам). Гостям видно только, кто уже поставил.</p>
        ${s.teams.map((t) => `
          <div class="final-bet"><div class="jname">${av(t)}<span>${esc(t.name)} <span class="muted small">(${t.score})</span></span></div>
          <input type="number" id="fbet-${t.id}" data-input="finalBet" data-id="${t.id}" min="0" step="100" inputmode="numeric" value="${s.final.bets[t.id] !== undefined ? s.final.bets[t.id] : ''}" placeholder="0"></div>`).join('')}
        <button class="btn big lime" data-act="finalStage" data-stage="question">Показать вопрос →</button>`;
    } else {
      body = `<div class="judge">${s.teams.map((t) => {
          const bet = s.final.bets[t.id] || 0;
          const res = s.final.results[t.id];
          return `<div class="jrow" style="${tv(t)}">
            <div class="jname">${av(t)}<span>${esc(t.name)} · ставка ${bet}</span></div>
            ${res === undefined
              ? `<button class="btn lime" data-act="finalJudge" data-id="${t.id}" data-ok="1">✓ +${bet}</button>
                 <button class="btn pink" data-act="finalJudge" data-id="${t.id}" data-ok="0">✗ −${bet}</button>`
              : `<span class="${res ? 'res-ok' : 'res-bad'}" style="grid-column:span 2">${res ? '✓ верно' : '✗ мимо'}</span>`}
          </div>`;
        }).join('')}</div>
        <div class="row" style="margin-top:12px">
          ${st === 'question' ? '<button class="btn orange" data-act="finalStage" data-stage="answer">Показать ответ</button>' : ''}
          <button class="btn big lime" data-act="showWinner">🏆 Показать победителя</button>
        </div>`;
    }
    html += `<section class="card"><h2>Финал</h2>${steps}${body}</section>`;
    return html;
  }

  function renderWinner(s) {
    const sorted = s.teams.slice().sort((a, b) => b.score - a.score);
    return `
      <section class="card">
        <h2>🏆 Победитель на экране</h2>
        <div class="stack">${sorted.map((t, i) => `<div class="jname">${i + 1}. ${av(t)}<span>${esc(t.name)} — ${t.score}</span></div>`).join('')}</div>
        <div class="row" style="margin-top:14px">
          <button class="btn" data-act="backToFinal">← Назад к финалу</button>
        </div>
      </section>`;
  }

  function renderSide(s) {
    let html = '';
    const playing = s.phase !== 'setup';
    if (s.phase === 'question' || s.phase === 'final') {
      const t = s.timer;
      html += `
        <section class="card">
          <h2>Таймер</h2>
          <div class="row">
            <div class="timer-big" id="timer-num">${Math.ceil(U.timerRemaining(t) / 1000)}</div>
            <div class="grow"></div>
            <select data-input="duration" id="dur" aria-label="длительность">${[10, 15, 20, 30, 45, 60, 90].map((d) => `<option value="${d}" ${d === t.duration ? 'selected' : ''}>${d} с</option>`).join('')}</select>
          </div>
          <div class="row" style="margin-top:10px">
            <button class="btn ${t.running ? 'pink' : 'lime'} grow" data-act="timerToggle">${t.running ? '⏸ Пауза' : '▶ Старт'}</button>
            <button class="btn" data-act="timerReset">↺ Сброс</button>
          </div>
        </section>`;
    }
    if (s.phase === 'question') {
      const bz = s.buzzer.winner && teamById(s, s.buzzer.winner);
      html += `
        <section class="card">
          <h2>Баззер</h2>
          <div class="buzzbox ${bz ? 'hit' : ''}" ${bz ? `style="${tv(bz)}"` : ''}>${bz ? `${esc(bz.emoji)} ${esc(bz.name)} — первые!` : 'ждём нажатия…'}</div>
          <button class="btn wide" style="margin-top:10px" data-act="buzzReset">Сбросить баззер</button>
        </section>`;
    }
    if (playing && s.teams.length) {
      const last = s.history[s.history.length - 1];
      html += `
        <section class="card">
          <h2>Счёт <span class="sp muted small">± по 100</span></h2>
          ${s.teams.map((t) => `
            <div class="score-row">
              <div class="jname">${av(t)}<span>${esc(t.name)}</span></div>
              <span class="val ${t.score < 0 ? 'neg' : ''}">${t.score}</span>
              <button class="btn sm" data-act="adjust" data-id="${t.id}" data-delta="-100" aria-label="минус 100" title="−100">−</button>
              <button class="btn sm" data-act="adjust" data-id="${t.id}" data-delta="100" aria-label="плюс 100" title="+100">+</button>
            </div>`).join('')}
          <button class="btn wide" style="margin-top:10px" data-act="undo" ${last ? '' : 'disabled'}>↶ Отменить последнее</button>
          <div class="undo-label">${last ? 'последнее: ' + esc(last.label) : ''}</div>
        </section>`;
    }
    if (playing) {
      html += `
        <section class="card">
          <h2>Игра</h2>
          <div class="row">
            ${quiz.rounds.map((R, i) => `<button class="btn sm ${s.phase !== 'final' && s.phase !== 'winner' && s.round === i ? 'black' : ''}" data-act="gotoRound" data-round="${i}">${esc(R.name)}</button>`).join('')}
            <button class="btn sm ${s.phase === 'final' ? 'black' : ''}" data-act="gotoFinal" ${quiz.final ? '' : 'disabled'}>Финал</button>
            <button class="btn sm ${s.phase === 'winner' ? 'black' : ''}" data-act="showWinner">🏆 Победитель</button>
          </div>
          <p class="hotkeys" style="margin:12px 0 0">Клавиши: <span class="kbd">1</span> таймер · <span class="kbd">Esc</span> к табло · <span class="kbd">Ctrl+Z</span> undo · клавиши команд = баззер</p>
        </section>`;
    }
    html += renderPhones(s);
    html += renderMusic(s);
    html += `
      <section class="card">
        <h2>Экран гостей</h2>
        <div class="row">
          <button class="btn lime" data-act="openScreen">📺 Открыть</button>
          <a class="btn" href="screen.html" target="_blank" rel="noopener">ссылка ↗</a>
        </div>
        <p class="muted small" style="margin:10px 0 0">Открывай в этом же браузере — вкладки синхронизируются сами.</p>
        <button class="btn ${armedKey === 'reset' ? 'danger' : ''} wide" style="margin-top:12px" data-act="reset">${armedKey === 'reset' ? 'Точно сбросить? Жми ещё раз' : '⟲ Сбросить игру'}</button>
      </section>`;
    return html;
  }

  /* ---------- телефоны-баззеры ---------- */
  const NET_LABEL = {
    off: ['выкл', ''], connecting: ['подключаемся…', 'orange'], online: ['онлайн', 'lime'],
    offline: ['нет связи', 'pink'], 'id-taken': ['код занят, ждём…', 'orange'],
    unavailable: ['недоступно', 'pink'], 'other-tab': ['в другой вкладке', ''],
  };
  function renderPhones(s) {
    const room = s.room;
    const st = (window.Remote && window.Remote.status) || 'off';
    const [label, cls] = NET_LABEL[st] || [st, ''];
    const url = room && window.Net ? window.Net.joinUrl(room) : '';
    const qr = url && window.qrDataUrl ? window.qrDataUrl(url, 220) : null;
    const online = new Set((s.net && s.net.online) || []);
    const total = (s.net && s.net.devices) || 0;
    const unbound = (s.net && s.net.unbound) || 0;
    // у каждой команды: свой телефон на связи / не на связи, либо клавиатура
    const rows = s.teams.map((t) => {
      const state = t.device
        ? (online.has(t.id) ? '<span class="dev-n">🟢 на связи</span>' : '<span class="dev-n muted">⚪ не на связи</span>')
        : `<span class="dev-n muted">⌨️ клавиша <span class="kbd">${esc(U.keyLabel(t.key))}</span></span>`;
      const btn = t.device
        ? `<button class="btn sm ${armedKey === 'unbind-' + t.id ? 'danger' : ''}" data-act="unbind" data-id="${t.id}">${armedKey === 'unbind-' + t.id ? 'точно?' : 'отвязать'}</button>`
        : '';
      const avBtn = t.avatar ? `<button class="btn sm" data-act="avatarReset" data-id="${t.id}" title="вернуть эмодзи">✕ аватар</button>` : '';
      return `<div class="dev-row"><div class="jname">${av(t)}<span>${esc(t.name)}</span></div><div class="row" style="gap:6px;justify-content:flex-end">${state}${btn}${avBtn}</div></div>`;
    }).join('');
    const warn = st === 'unavailable' || st === 'offline'
      ? `<div class="banner sample" style="margin:10px 0 0">Сеть для телефонов недоступна${s.net && s.net.info ? ' (' + esc(s.net.info) + ')' : ''}. Играем с клавиатурными баззерами — всё остальное работает.</div>`
      : st === 'other-tab' ? '<p class="muted small">Сеть для телефонов уже держит другая открытая вкладка пульта.</p>' : '';
    return `
      <section class="card">
        <h2>Телефоны <span class="pill ${cls}">${label}</span><span class="sp muted small">${total} 📱</span></h2>
        <div class="room-row">
          <div>
            <div class="small muted">код комнаты</div>
            <div class="room-code">${esc(room || '—')}</div>
            ${url ? `<a class="small join-link" href="${esc(url)}" target="_blank" rel="noopener">ссылка для телефона ↗</a>` : ''}
          </div>
          ${qr ? `<img class="qr" src="${qr}" alt="QR-код для телефона" width="110" height="110">` : ''}
        </div>
        ${warn}
        <div class="devs">${rows}${unbound ? `<div class="dev-row"><span class="muted">телефонов без команды</span><span class="dev-n">📱×${unbound}</span></div>` : ''}</div>
        <p class="muted small" style="margin:8px 0 0">1 телефон = 1 команда. «Отвязать» — если телефон сел или потерялся: баллы останутся, команду можно восстановить с другого телефона.</p>
        <button class="btn sm ${armedKey === 'newRoom' ? 'danger' : ''}" style="margin-top:10px" data-act="newRoom">${armedKey === 'newRoom' ? 'Точно? Телефоны отвалятся' : 'новая комната'}</button>
      </section>`;
  }

  /* ---------- музыка ---------- */
  const MUSIC_SLOTS = [['board', 'Табло'], ['question', 'Вопрос'], ['final', 'Финал']];
  function renderMusic(s) {
    const m = Object.assign({ enabled: true, volume: 0.5, sfx: 0.8, files: {} }, s.music || {});
    const slots = MUSIC_SLOTS.map(([k, label]) => {
      const f = m.files[k];
      return `<div class="mus-row">
        <div class="mus-name"><b>${label}</b><span class="muted small">${f ? '🎧 ' + esc(f.name) : 'встроенная (синтез)'}</span></div>
        <label class="btn sm">свой файл<input type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg" data-music-file="${k}" hidden></label>
        ${f ? `<button class="btn sm" data-act="musicDel" data-key="${k}">✕</button>` : ''}
      </div>`;
    }).join('');
    return `
      <section class="card">
        <h2>Музыка <span class="sp"></span><button class="btn sm ${m.enabled ? 'lime' : ''}" data-act="musicToggle">${m.enabled ? '🎵 вкл' : '🔇 выкл'}</button></h2>
        <div class="mus-vol"><span>музыка</span><input type="range" min="0" max="100" value="${Math.round(m.volume * 100)}" data-music-range="volume" aria-label="громкость музыки"></div>
        <div class="mus-vol"><span>эффекты</span><input type="range" min="0" max="100" value="${Math.round(m.sfx * 100)}" data-music-range="sfx" aria-label="громкость эффектов"></div>
        ${slots}
        <p class="muted small" style="margin:8px 0 0">Свои mp3/m4a хранятся в этом браузере и играют на экране гостей (открой его здесь же). Звук пойдёт после первого клика по экрану гостей.</p>
      </section>`;
  }

  function renderBanners() {
    let html = '';
    if (popupBlocked) html += `<div class="banner">Браузер заблокировал новое окно. Открой экран по ссылке: <a href="screen.html" target="_blank" rel="noopener">screen.html ↗</a></div>`;
    if (source === 'sample') html += `<div class="banner sample">Нет data/questions.js — играем на тестовых вопросах.</div>`;
    if (source === 'none') html += `<div class="banner sample">Вопросы не загрузились: проверь data/questions.js.</div>`;
    bannersEl.innerHTML = html;
  }

  /* ---------- рендер с сохранением фокуса ---------- */
  function render() {
    if (!quiz) return;
    const s = S.get();
    const act = document.activeElement;
    const focusId = act && act.id;
    let selStart = null, selEnd = null;
    try { selStart = act.selectionStart; selEnd = act.selectionEnd; } catch (e) { /* number input */ }

    let main = '';
    switch (s.phase) {
      case 'setup': main = renderSetup(s); break;
      case 'board': main = renderBoard(s); break;
      case 'question': main = renderQuestion(s); break;
      case 'final': main = renderFinal(s); break;
      case 'winner': main = renderWinner(s); break;
      default: main = renderSetup(s);
    }
    mainEl.innerHTML = main;
    sideEl.innerHTML = renderSide(s);
    renderBanners();
    $('#undo-top').disabled = !s.history.length;

    // картинки-превью, которых ещё нет
    mainEl.querySelectorAll('.thumbs img').forEach((img) => {
      img.addEventListener('error', () => { img.outerHTML = `<div class="broken">нет файла: ${esc(img.dataset.src)}</div>`; }, { once: true });
    });

    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        try { if (selStart !== null) el.setSelectionRange(selStart, selEnd); } catch (e) { /* ignore */ }
      }
    }
  }

  function tickTimer() {
    const el = document.getElementById('timer-num');
    if (!el) return;
    const rem = U.timerRemaining(S.get().timer);
    el.textContent = Math.ceil(rem / 1000);
    el.classList.toggle('low', rem <= 5000);
  }
  setInterval(tickTimer, 100);

  /* ======================================================================
     ДЕЙСТВИЯ
     ====================================================================== */
  function openScreen() {
    let w = null;
    try { w = window.open('screen.html', 'svoyak-screen'); } catch (e) { w = null; }
    popupBlocked = !w;
    renderBanners();
    if (popupBlocked) toast('Окно заблокировано — открой по ссылке сверху');
  }

  const d = (a) => S.dispatch(a);

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const a = b.dataset.act, id = b.dataset.id;
    const s = S.get();
    switch (a) {
      case 'openScreen': openScreen(); break;
      case 'undo': d({ type: 'undo' }); break;
      case 'teamAdd': d({ type: 'teamAdd' }); break;
      case 'teamRemove': d({ type: 'teamRemove', id }); break;
      case 'teamColor': d({ type: 'teamUpdate', id, patch: { color: b.dataset.color } }); break;
      case 'teamEmojiPick': d({ type: 'teamUpdate', id, patch: { emoji: b.dataset.emoji } }); break;
      case 'captureKey': capture = capture === id ? null : id; render(); break;
      case 'startGame': d({ type: 'startGame' }); break;
      case 'open': {
        const r = +b.dataset.r, c = +b.dataset.c, q = +b.dataset.q;
        const key = U.cellKey(r, c, q);
        if (s.used[key] && !confirmTwice('open-' + key, 'Уже сыграно. Нажми ещё раз, чтобы открыть снова')) return;
        if (s.used[key]) d({ type: 'toggleUsed', key });
        d({ type: 'openCell', r, c, q });
        window.scrollTo({ top: 0 });
        break;
      }
      case 'owner': d({ type: 'setOwner', teamId: id }); break;
      case 'betQuick': d({ type: 'setBet', bet: +b.dataset.bet }); break;
      case 'showQuestion':
        if (s.current && s.current.special === 'auction' && !s.current.bet) d({ type: 'setBet', bet: U.cellValue(s.current.r, s.current.c, s.current.q) });
        d({ type: 'showQuestion' });
        break;
      case 'judge': d({ type: 'judge', teamId: id, correct: b.dataset.ok === '1' }); break;
      case 'reveal': d({ type: 'reveal' }); break;
      case 'board': d({ type: 'backToBoard' }); break;
      case 'timerToggle': d({ type: s.timer.running ? 'timerPause' : 'timerStart' }); break;
      case 'timerReset': d({ type: 'timerReset' }); break;
      case 'buzzReset': d({ type: 'buzzReset' }); break;
      case 'adjust': d({ type: 'adjust', teamId: id, delta: +b.dataset.delta }); break;
      case 'gotoRound': d({ type: 'gotoRound', round: +b.dataset.round }); break;
      case 'gotoFinal':
        if (s.phase === 'final') return;
        d({ type: 'gotoFinal' });
        break;
      case 'finalStage': d({ type: 'finalStage', stage: b.dataset.stage }); break;
      case 'finalJudge': d({ type: 'finalJudge', teamId: id, correct: b.dataset.ok === '1' }); break;
      case 'showWinner': d({ type: 'showWinner' }); break;
      case 'backToFinal': d({ type: 'backToFinal' }); break;
      case 'musicToggle': d({ type: 'musicSet', patch: { enabled: !(s.music && s.music.enabled === false ? false : true) } }); break;
      case 'musicDel': {
        const key = b.dataset.key;
        window.MediaDB.del(key).then(() => {
          const files = Object.assign({}, (S.get().music || {}).files || {});
          delete files[key];
          d({ type: 'musicSet', patch: { files } });
        });
        break;
      }
      case 'avatarReset': d({ type: 'teamAvatar', teamId: id, avatar: null }); toast('Аватар сброшен — снова эмодзи'); break;
      case 'unbind':
        if (confirmTwice('unbind-' + id, 'Отвязать телефон? Баллы команды останутся. Жми ещё раз')) window.Remote.unbind(id);
        break;
      case 'newRoom':
        if (confirmTwice('newRoom', 'Новый код комнаты — телефонам придётся сканировать заново. Жми ещё раз')) window.Remote.newRoom();
        break;
      case 'reset':
        if (confirmTwice('reset', 'Сброс счёта и табло. Команды останутся. Жми ещё раз')) { capture = null; d({ type: 'resetGame' }); toast('Игра сброшена'); }
        break;
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    const kind = el.dataset && el.dataset.input;
    if (!kind) return;
    const id = el.dataset.id;
    if (kind === 'teamName') d({ type: 'teamUpdate', id, patch: { name: el.value } });
    else if (kind === 'teamEmoji') d({ type: 'teamUpdate', id, patch: { emoji: el.value.trim() || '⭐' } });
    else if (kind === 'bet') d({ type: 'setBet', bet: el.value });
    else if (kind === 'finalBet') { if (el.value !== '') d({ type: 'finalBet', teamId: id, bet: el.value }); }
    else if (kind === 'duration') d({ type: 'timerDuration', seconds: +el.value });
  });

  // громкость — по отпусканию ползунка (иначе перерисовка сорвёт перетаскивание)
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.musicRange) {
      d({ type: 'musicSet', patch: { [el.dataset.musicRange]: Math.max(0, Math.min(1, +el.value / 100)) } });
    } else if (el.dataset && el.dataset.musicFile) {
      const key = el.dataset.musicFile;
      const f = el.files && el.files[0];
      if (!f) return;
      if (f.size > 40 * 1024 * 1024) { toast('Файл больше 40 МБ — возьми покороче'); return; }
      toast('Сохраняем «' + f.name + '»…');
      f.arrayBuffer().then((data) => window.MediaDB.put(key, { name: f.name, type: f.type, data })).then((ok) => {
        if (!ok) { toast('Не получилось сохранить файл (IndexedDB недоступна)'); return; }
        const files = Object.assign({}, (S.get().music || {}).files || {}, { [key]: { name: f.name, at: Date.now() } });
        d({ type: 'musicSet', patch: { files } });
        toast('Готово: «' + f.name + '» играет на экране гостей');
      });
    }
  });

  /* ---------- клавиатура ---------- */
  document.addEventListener('keydown', (e) => {
    const s = S.get();
    // захват клавиши баззера
    if (capture) {
      e.preventDefault();
      if (e.code === 'Escape') { capture = null; render(); return; }
      if (RESERVED_KEYS.includes(e.code)) { toast('Эта клавиша занята (служебная), выбери другую'); return; }
      const other = s.teams.find((t) => t.key === e.code && t.id !== capture);
      if (other) { toast(`Клавиша уже у «${other.name}»`); return; }
      const id = capture;
      capture = null;
      d({ type: 'teamUpdate', id, patch: { key: e.code } });
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !typing) { e.preventDefault(); d({ type: 'undo' }); return; }
    if (typing || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    // если клавиатура одна на всех — команды могут жать и здесь
    const t = s.teams.find((x) => x.key && x.key === e.code);
    if (t) { e.preventDefault(); d({ type: 'buzz', teamId: t.id }); return; }
    if (TIMER_KEYS.includes(e.code) && (s.phase === 'question' || s.phase === 'final')) { e.preventDefault(); d({ type: s.timer.running ? 'timerPause' : 'timerStart' }); }
    else if (e.code === 'Escape' && s.phase === 'question') d({ type: 'backToBoard' });
  });

  /* ---------- уведомления о событиях (баззер-тест, первые) ---------- */
  function onEvents(s) {
    s.events.filter((ev) => ev.id > lastEvent).forEach((ev) => {
      if (Date.now() - ev.at > 8000) return;
      const t = ev.teamId && teamById(s, ev.teamId);
      if (ev.kind === 'buzz' && t) {
        toast(ev.test ? `${t.emoji} ${t.name} на связи ✓` : `🔔 ${t.emoji} ${t.name} — первые!`);
        try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) { /* ignore */ }
      }
    });
    lastEvent = Math.max(lastEvent, s.eventSeq || 0);
  }

  /* ---------- старт ---------- */
  window.loadQuiz().then((res) => {
    quiz = res.quiz;
    source = res.source;
    S.setQuiz(quiz);
    lastEvent = S.get().eventSeq || 0;
    S.subscribe((s) => { onEvents(s); render(); });
    if (window.Remote) { window.Remote.onChange(render); window.Remote.start(); }
    render();
  });
})();
