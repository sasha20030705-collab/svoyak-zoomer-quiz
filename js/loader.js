/* Загрузка вопросов: сначала data/questions.js, при его отсутствии или ошибке —
   data/sample-questions.js. Возвращает Promise<{quiz, source}>. */
(function () {
  'use strict';

  function inject(src) {
    return new Promise((resolve) => {
      delete window.QUIZ;
      const s = document.createElement('script');
      s.src = src + '?t=' + Date.now(); // без кэша: вопросы могут обновляться
      s.onload = () => resolve(!!window.QUIZ);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  /** Приводим данные к ожидаемой форме, чтобы рендер не падал на пропусках. */
  function normalize(q) {
    const quiz = Object.assign({ title: 'Своя игра', rounds: [], final: null }, q);
    quiz.rounds = (quiz.rounds || []).map((r, ri) => ({
      name: r.name || `Раунд ${ri + 1}`,
      multiplier: Number(r.multiplier) || 1,
      categories: (r.categories || []).map((c) => ({
        name: c.name || 'Тема',
        emoji: c.emoji || '',
        description: c.description || '',
        questions: (c.questions || []).map((x) => normQ(x)),
      })),
    }));
    if (quiz.final) {
      quiz.final = Object.assign(normQ(quiz.final), { category: quiz.final.category || 'Финал' });
    }
    return quiz;
  }
  function normQ(x) {
    const media = Object.assign({}, x.media || {});
    if (media.images && !Array.isArray(media.images)) media.images = [media.images];
    let type = x.type || 'text';
    if (type === 'text' && media.images && media.images.length) type = 'image';
    if (type === 'text' && media.emoji) type = 'emoji';
    return {
      id: x.id || null,
      value: Number(x.value) || 0,
      type,
      special: x.special || null,
      prompt: x.prompt || '',
      media,
      answer: x.answer || '',
      note: x.note || '',
    };
  }

  window.loadQuiz = async function () {
    // ?sample в адресе — принудительно тестовые вопросы (для проверки вёрстки)
    const forceSample = /[?&]sample\b/.test(location.search);
    if (!forceSample && await inject('data/questions.js')) return { quiz: normalize(window.QUIZ), source: 'questions' };
    if (await inject('data/sample-questions.js')) return { quiz: normalize(window.QUIZ), source: 'sample' };
    return { quiz: normalize({ title: 'Нет вопросов', rounds: [] }), source: 'none' };
  };
})();
