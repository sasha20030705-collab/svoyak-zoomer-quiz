/* Временные (тестовые) вопросы. Загружаются, только если нет data/questions.js.
   Картинки — сгенерированные SVG-плейсхолдеры из assets/sample/. */
(function () {
  const S = (n) => `assets/sample/star-${n}.svg`;
  const SC = (n) => `assets/sample/scene-${n}.svg`;
  const P = (n) => `assets/sample/poster-${n}.svg`;
  // точки фокуса, совпадают с тем, где в scene-N.svg нарисован объект
  const F = {
    1: { x: 0.78, y: 0.22 }, 2: { x: 0.2, y: 0.7 }, 3: { x: 0.55, y: 0.35 }, 4: { x: 0.85, y: 0.8 },
    5: { x: 0.3, y: 0.25 }, 6: { x: 0.6, y: 0.6 }, 7: { x: 0.15, y: 0.4 }, 8: { x: 0.7, y: 0.15 },
    9: { x: 0.45, y: 0.75 }, 10: { x: 0.9, y: 0.5 },
  };
  const zoom = (n, scale) => ({ images: [SC(n)], zoom: { ...F[n], scale } });

  window.QUIZ = {
    title: "ТЕСТОВЫЙ КВИЗ · ДР 21.10",
    rounds: [
      {
        name: "Раунд 1",
        multiplier: 1,
        categories: [
          {
            name: "Слияние звёзд", emoji: "🧬",
            description: "Нейросеть скрестила двух звёзд. Назовите обоих.",
            questions: [
              { value: 100, type: "fusion", prompt: "Кто здесь смешался?", media: { images: [S(1), S(2)] }, answer: "Звезда 1 + Звезда 2", note: "Тестовый вопрос: две картинки накладываются." },
              { value: 200, type: "fusion", prompt: "Назовите обоих", media: { images: [S(3), S(4)] }, answer: "Звезда 3 + Звезда 4", note: "" },
              { value: 300, type: "fusion", special: "cat", prompt: "Кот в мешке! Кто эти двое?", media: { images: [S(5), S(6)] }, answer: "Звезда 5 + Звезда 6", note: "Кот в мешке — вопрос передаётся другой команде." },
              { value: 400, type: "fusion", prompt: "Готовое ИИ-слияние — кто внутри?", media: { images: [S(7), S(8)], fused: S(9) }, answer: "Звезда 7 + Звезда 8", note: "Пример с media.fused." },
              { value: 500, type: "fusion", prompt: "Самое сложное слияние", media: { images: [S(10), S(11)] }, answer: "Звезда 10 + Звезда 11", note: "" },
            ],
          },
          {
            name: "Что на фото?", emoji: "🔍",
            description: "Сильный зум — картинка отдаляется по таймеру.",
            questions: [
              { value: 100, type: "zoom", prompt: "Что спрятано на картинке?", media: zoom(1, 4), answer: "Торт 🎂", note: "Зум отдаляется вместе с таймером." },
              { value: 200, type: "zoom", prompt: "Что это?", media: zoom(2, 5), answer: "Единорог 🦄", note: "" },
              { value: 300, type: "zoom", prompt: "Угадайте объект", media: zoom(3, 6), answer: "Пицца 🍕", note: "" },
              { value: 400, type: "zoom", prompt: "Кто тут сидит?", media: zoom(4, 7), answer: "Лягушка 🐸", note: "" },
              { value: 500, type: "zoom", prompt: "А это что?", media: zoom(5, 8), answer: "Диск 💿", note: "" },
            ],
          },
          {
            name: "Мыльно", emoji: "🫧",
            description: "Картинка размыта и проясняется по таймеру.",
            questions: [
              { value: 100, type: "blur", prompt: "Что на размытом фото?", media: { images: [SC(6)] }, answer: "Гитара 🎸", note: "" },
              { value: 200, type: "blur", prompt: "Кто это?", media: { images: [S(12)] }, answer: "Звезда 12", note: "" },
              { value: 300, type: "blur", prompt: "Что за постер?", media: { images: [P(1)] }, answer: "Постер 1", note: "" },
              { value: 400, type: "blur", prompt: "Что летит?", media: { images: [SC(7)] }, answer: "НЛО 🛸", note: "" },
              { value: 500, type: "blur", prompt: "Какая ягода?", media: { images: [SC(8)] }, answer: "Клубника 🍓", note: "" },
            ],
          },
          {
            name: "Эмодзи-кино", emoji: "🎬",
            description: "Фильм или сериал, зашифрованный эмодзи.",
            questions: [
              { value: 100, type: "emoji", prompt: "Какой фильм?", media: { emoji: "🧛‍♂️🌒💍" }, answer: "Сумерки", note: "" },
              { value: 200, type: "emoji", prompt: "Какой сериал?", media: { emoji: "🦑🎮💰" }, answer: "Игра в кальмара", note: "" },
              { value: 300, type: "emoji", prompt: "Какой фильм?", media: { emoji: "👱‍♀️💗🌍👠" }, answer: "Барби", note: "" },
              { value: 400, type: "emoji", prompt: "Какой сериал?", media: { emoji: "🖤🎻🏫🐺" }, answer: "Уэнсдэй", note: "" },
              { value: 500, type: "emoji", special: "auction", prompt: "Аукцион! Какой фильм?", media: { emoji: "🐀👨‍🍳🇫🇷" }, answer: "Рататуй", note: "Аукцион — команды делают ставки." },
            ],
          },
          {
            name: "Корея", emoji: "🇰🇷",
            description: "K-pop, дорамы и всё корейское.",
            questions: [
              { value: 100, type: "text", prompt: "Как называется корейская группа из 7 участников, спевшая «Dynamite»?", answer: "BTS", note: "" },
              { value: 200, type: "text", prompt: "Как по-корейски «спасибо» (вежливо)?", answer: "Камсахамнида", note: "" },
              { value: 300, type: "image", prompt: "Что изображено на этом постере?", media: { images: [P(2)] }, answer: "Постер 2", note: "" },
              { value: 400, type: "text", prompt: "Как называется острая квашеная капуста — главное блюдо Кореи?", answer: "Кимчи", note: "" },
              { value: 500, type: "text", prompt: "Как называется женская группа с участницей Lisa, у которой хит «Pink Venom»?", answer: "BLACKPINK", note: "" },
            ],
          },
          {
            name: "Где логика?", emoji: "🤔",
            description: "Найди логику между картинками.",
            questions: [
              { value: 100, type: "image", prompt: "Что объединяет эти картинки?", media: { images: [P(3), P(4)] }, answer: "Обе — плейсхолдеры", note: "" },
              { value: 200, type: "image", prompt: "Найдите логику", media: { images: [SC(9), SC(10)] }, answer: "Напитки и котики", note: "" },
              { value: 300, type: "text", prompt: "Сколько будет 2 + 2 × 2?", answer: "6", note: "Сначала умножение!" },
              { value: 400, type: "image", prompt: "Что общего?", media: { images: [P(5), P(6), P(1)] }, answer: "Все — постеры", note: "" },
              { value: 500, type: "text", prompt: "Какое слово лишнее: кринж, рофл, вайб, табуретка?", answer: "Табуретка", note: "" },
            ],
          },
        ],
      },
      {
        name: "Раунд 2",
        multiplier: 2,
        categories: [
          {
            name: "Слияние 2.0", emoji: "🧪",
            description: "Ещё больше слияний.",
            questions: [
              { value: 200, type: "fusion", prompt: "Кто здесь?", media: { images: [S(2), S(5)] }, answer: "Звезда 2 + Звезда 5", note: "" },
              { value: 400, type: "fusion", prompt: "Кто здесь?", media: { images: [S(4), S(9)] }, answer: "Звезда 4 + Звезда 9", note: "" },
              { value: 600, type: "fusion", prompt: "Кто здесь?", media: { images: [S(6), S(12)] }, answer: "Звезда 6 + Звезда 12", note: "" },
              { value: 800, type: "fusion", special: "auction", prompt: "Аукцион! Кто эти двое?", media: { images: [S(1), S(8)] }, answer: "Звезда 1 + Звезда 8", note: "" },
              { value: 1000, type: "fusion", prompt: "Кто здесь?", media: { images: [S(3), S(11)] }, answer: "Звезда 3 + Звезда 11", note: "" },
            ],
          },
          {
            name: "Песни в эмодзи", emoji: "🎧",
            description: "Угадай трек.",
            questions: [
              { value: 200, type: "emoji", prompt: "Какая песня?", media: { emoji: "💚🍏🎉" }, answer: "Charli XCX — 360 (Brat)", note: "" },
              { value: 400, type: "emoji", prompt: "Какая песня?", media: { emoji: "🌧️☔💃" }, answer: "Umbrella", note: "" },
              { value: 600, type: "emoji", prompt: "Какая песня?", media: { emoji: "🍬🍭🥰" }, answer: "Тестовая песня", note: "" },
              { value: 800, type: "emoji", special: "cat", prompt: "Кот в мешке! Какая песня?", media: { emoji: "🌊🏄‍♀️☀️" }, answer: "Тестовая песня 2", note: "" },
              { value: 1000, type: "emoji", prompt: "Какая песня?", media: { emoji: "🚗💨🌃" }, answer: "Тестовая песня 3", note: "" },
            ],
          },
          {
            name: "Интернет-2025", emoji: "📱",
            description: "Мемы и тренды.",
            questions: [
              { value: 200, type: "text", prompt: "Как называется мем-персонаж — тралалело тралала?", answer: "Итальянский брейнрот", note: "" },
              { value: 400, type: "text", prompt: "Что значит «вайб»?", answer: "Атмосфера, настроение", note: "" },
              { value: 600, type: "text", prompt: "Какой цвет у обложки альбома «Brat»?", answer: "Кислотно-зелёный", note: "" },
              { value: 800, type: "text", prompt: "Что такое «скибиди»?", answer: "Мем-сериал Skibidi Toilet", note: "" },
              { value: 1000, type: "text", prompt: "Что такое «сигма»?", answer: "Мем про одиночку-«альфу»", note: "" },
            ],
          },
          {
            name: "Постеры", emoji: "🖼️",
            description: "Угадай по картинке.",
            questions: [
              { value: 200, type: "image", prompt: "Что за постер?", media: { images: [P(1)] }, answer: "Постер 1", note: "" },
              { value: 400, type: "image", prompt: "Что за постер?", media: { images: [P(2)] }, answer: "Постер 2", note: "" },
              { value: 600, type: "blur", prompt: "Что за постер?", media: { images: [P(3)] }, answer: "Постер 3", note: "" },
              { value: 800, type: "image", prompt: "Что за постер?", media: { images: [P(4)] }, answer: "Постер 4", note: "" },
              { value: 1000, type: "blur", prompt: "Что за постер?", media: { images: [P(5)] }, answer: "Постер 5", note: "" },
            ],
          },
          {
            name: "Супер-зум", emoji: "🔬",
            description: "Ещё сильнее зум.",
            questions: [
              { value: 200, type: "zoom", prompt: "Что это?", media: zoom(6, 5), answer: "Гитара 🎸", note: "" },
              { value: 400, type: "zoom", prompt: "Что это?", media: zoom(7, 6), answer: "НЛО 🛸", note: "" },
              { value: 600, type: "zoom", prompt: "Что это?", media: zoom(8, 7), answer: "Клубника 🍓", note: "" },
              { value: 800, type: "zoom", prompt: "Что это?", media: zoom(9, 8), answer: "Сок 🧃", note: "" },
              { value: 1000, type: "zoom", prompt: "Что это?", media: zoom(10, 9), answer: "Кот 🐱", note: "" },
            ],
          },
          {
            name: "Стендап", emoji: "🎤",
            description: "ТНТ и стендап.",
            questions: [
              { value: 200, type: "text", prompt: "Как называется шоу, где Нурлан Сабуров и Азамат Мусагалиев ищут логику?", answer: "Где логика?", note: "" },
              { value: 400, type: "text", prompt: "На каком канале выходит «Comedy Club»?", answer: "ТНТ", note: "" },
              { value: 600, type: "text", prompt: "Как называется импровизационное шоу ТНТ с Арсением Поповым?", answer: "Импровизация", note: "" },
              { value: 800, type: "text", prompt: "Тестовый вопрос на 400", answer: "Тестовый ответ", note: "" },
              { value: 1000, type: "text", prompt: "Тестовый вопрос на 500", answer: "Тестовый ответ", note: "" },
            ],
          },
        ],
      },
    ],
    final: {
      category: "Именинница",
      prompt: "Финальный тестовый вопрос: в какой день у нас праздник?",
      type: "text",
      media: {},
      answer: "21 октября",
      note: "Тестовый финал.",
    },
  };
})();
