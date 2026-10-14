/* Mini App Montaggio. «Монтаж» и «Изменить видео» (бывший «Нейромонтаж») собираются здесь и оформляются в боте кодом заказа ?start=w1-….
   Тренды, стили, AI-видео и свой персонаж (пресет) — заказ с фото, видео или описанием, оплата и результат — внутри
   приложения через сервер заказов; «Картинки» — пока «скоро» (владелец 13.10).
   Приложение ничего не решает о деньгах: цену, номер заказа и ссылки оплаты показывает из ответа сервера, который
   получил их от бота. Сеть: свой адрес (prices.json, ролики трендов), https://api.montaggio.shop (initData — только в
   заголовке), превью стилей и скрипт Telegram. */
(() => {
  "use strict";
  const BOT = "Montaggio_bot";
  const BOT_URL = "https://t.me/Montaggio_bot";
  const API = "https://api.montaggio.shop";
  // Telegram: скрипт telegram.org грузится async (медленный или недоступный не держит страницу) — приложение сразу
  // работает витриной со ссылкой на бота, а поведение Telegram подключает attachTelegram(), когда скрипт появился.
  // Признак «внутри Telegram» — платформа (у кнопки клавиатуры initData пустая): из скрипта или из параметров запуска
  // в адресе (#tgWebAppPlatform=…, их Telegram ставит после #; запоминаем до первой смены # маршрутом). Бот (89)
  // открывает и сразу экран: MINIAPP_URL#/trends — тогда Telegram дописывает параметры после маршрута:
  // «#/trends&tgWebAppData=…» или «#/trends?tgWebAppData=…»; маршрут — до первого «&» или «?»
  const HASH_ROUTE = /^#\/([^&?]*)[&?](.*)$/.exec(location.hash);
  const START_HASH = HASH_ROUTE ? HASH_ROUTE[2] : location.hash.startsWith("#/") ? "" : location.hash.slice(1);
  const LAUNCH_PLATFORM = new URLSearchParams(START_HASH).get("tgWebAppPlatform") || "";
  let tg = null;
  let inTelegram = false;
  let tgChecked = false;          // скрипт Telegram пришёл (или ждать больше нечего) — можно звать сервер

  // --- код заказа: тот же формат, что у сайта (order.js); тест бота test_83 берёт этот кусок в node ---
  // <code>
  const STANDARD = [1, 2, 3, 14];
  const NEURO_CODES = { redraw: "r", replace: "s", motion: "m" };
  const STYLE_CODES = { real: "r", cartoon: "c", anime: "a", "3d": "3" };
  const maskOf = (list) => list.reduce((m, n) => m + 2 ** (n - 1), 0);
  function encode(d) {
    if (d.kind === "montage") return `w1-m-${d.sec}-${d.clips}-${maskOf(d.opts).toString(16)}`;
    if (d.kind === "neuro") return `w1-n-${NEURO_CODES[d.mode]}-${d.sec}-${parseInt(d.q, 10)}`;
    return `w1-p-${STYLE_CODES[d.style]}`;
  }
  // </code>

  // --- цены: тот же расчёт, что в боте и на сайте (reelsbot/pricing.py, site/web/dist/order.js) ---
  let P = null;
  function priceOf(usd, service) {
    const f = P.formula, fx = P.fx;
    const cost = usd * (1 + f.estimate_error) * fx.usd_rub * (1 + fx.fx_fee);
    const markup = Math.min(10, Math.max(0, service in f.markups ? f.markups[service] : f.markup));
    const raw = cost * (1 + markup) / (1 - Math.min(Math.max(f.pay_fees, 0), 0.9));
    return Math.max(1, Math.ceil(f.min_prices[service] || 0), Math.ceil(Number(raw.toFixed(6))));
  }
  function neuroPrice(duration, quality, mode) {
    const n = P.neuro;
    const seconds = Math.max(n.min_billable_sec, Math.ceil(duration - 0.01));
    let usd;
    if (mode === "replace" || mode === "motion") usd = seconds * n.genjutsu_usd_per_sec[quality];
    else {
      const [w, h] = n.dims[quality];
      const tokens = Math.ceil(h * w * (seconds + seconds) * 24 / 1024);
      usd = tokens / 1000 * (quality === "1080p" ? n.usd_per_1k_tokens_1080 : n.usd_per_1k_tokens);
    }
    return priceOf(usd, "neuro");
  }
  function montagePrice(seconds, opts) {
    const e = P.montage.estimate, on = new Set(opts);
    let usd = e.base_usd + e.per_min_usd * seconds / 60;
    if (e.layer.some(n => on.has(n))) usd += e.motion_usd;
    if (on.has(e.shorten)) usd += e.shorten_usd;
    if (on.has(e.broll)) usd += e.broll_usd;
    if (on.has(e.draw)) usd += e.drawing_usd * Math.min(e.max_drawings, Math.max(1, Math.ceil(seconds / e.sec_per_drawing)));
    return priceOf(usd, "montage");
  }
  const presetPrice = () => priceOf(P.preset.usd, "preset");
  const sitesPrice = () => priceOf(P.sites.usd, "brag");
  // 96C: AI-видео — как pricing.aivideo_quote бота и aivPrice в order.js (без кадра с надписью — его считает бот):
  // токены = ширина × высота × (кадров в секунду × секунды + 1) / 1024, тариф — по качеству
  function aivideoPrice(ratio, quality, seconds) {
    const a = P.aivideo, [w, h] = a.dims[quality][ratio];
    const tokens = Math.ceil(w * h * (seconds * a.fps + 1) / 1024);
    return priceOf(tokens / 1e6 * (quality === "1080p" ? a.usd_per_m_tokens_1080 : a.usd_per_m_tokens), "aivideo");
  }
  const rub = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";

  function priceFor(d) {
    if (!P) return null;
    if (d.kind === "montage") return montagePrice(d.sec, d.opts);
    if (d.kind === "neuro") return neuroPrice(d.sec, d.q, d.mode);
    return presetPrice();
  }

  // --- язык интерфейса трендов (91): из Telegram, только для текстов; рубли — только ru ---
  let LANG = "ru";
  const TEXT = {
    ru: {
      nav: ["Главная", "Тренды", "Изменить", "Создать", "Профиль"],
      homeTitle: ["Какое видео", "сделаем?"], homeSub: "Повторите тренд со своим лицом — или измените своё видео.",
      tileEdit: ["Изменить видео", "Смонтировать своё или изменить нейросетью"],
      tileTrend: ["Повторить тренд", "Ваше лицо в готовом трендовом ролике"],
      trends: "Тренды", trendsHint: "Листайте и выбирайте", allTrends: "Все тренды",
      suggestBtn: "💡 Предложить свой тренд", suggestText: "Нашли классный ролик? Пришлите — мы попробуем сделать его трендом.",
      trendsSub: "Выберите ролик — повторим его с вами.", from: "от {p}", sec: "{n} сек",
      loading: "Загружаем тренды…", downTitle: "Тренды скоро вернутся", downText: "Пока оформите заказ в боте.",
      openBot: "Открыть бота", source: "Исходник", result: "Готовое видео",
      soundOn: "Включить звук", soundOff: "Выключить звук",
      quality: "Качество", q: { "480p": "Для сторис", "720p": "Чёткий HD", "1080p": "Максимум" }, repeat: "Повторить",
      whoTitle: "Кто будет в ролике?", recommended: "Советуем",
      optPreset: "Мой пресет", optPresetTag: "лучший результат",
      optPresetHint: "Ваш персонаж из пресета — лицо и фигура держатся точнее.",
      optMake: "Сделать пресет", optMakeHint: "1–3 фото — нарисуем лист персонажа, потом вернёмся к этому тренду.",
      optPhoto: "Загрузить фото", optPhotoHint: "1–8 ваших фото — без пресета.",
      photosTitle: "Ваши фото", presetTitle: "Новый пресет", presetSub: "Лист персонажа по вашим фото",
      wishLabel: "Ваши пожелания (по желанию)", wishPh: "Например: пусть второй будет в очках · сделай меня блондином · пусть будет ночь",
      wishHint: "Учтём, если это не меняет сам тренд и не нарушает правила.",
      askTitle: "Фото для ролика", optPhotos: "Фото", next: "Дальше", yourFace: "Ваше лицо", presetPhotos: "Ваши фото",
      presetUse: "Возьмём ваш последний пресет персонажа — фото для этого героя не нужны.", noPreset: "Нет пресета? Сделать",
      errMin: "Добавьте фото: {label}.", errTotalAll: "Видео и фото вместе — не больше 105 МБ.",
      tileStyle: ["Сменить стиль", "Ваше видео в другом виде: аниме, игрушка, вязаный мир…"],
      styles: "Стили", stylesHint: "Ваше видео — в новом виде", stylesSub: "Выберите стиль — перерисуем в нём ваше видео.",
      allStyles: "Все стили", styleFrom: "от {p} за 5 с", stylesDown: "Стили скоро вернутся",
      yourVideo: "Ваше видео", videoHint: "Одно видео от 4 до 30 секунд, до 100 МБ. Длиннее 30 с — возьмём первые 30 с.",
      addVideo: "Выбрать видео", removeVideo: "Убрать видео", videoLen: "{n} с · {mb} МБ",
      videoLong: "Видео {n} с — возьмём первые 30 с.", videoShort: "Видео {n} с — нужно не меньше 4 секунд.",
      videoBig: "Видео больше 100 МБ — выберите покороче или сожмите его.", videoType: "Это не видео: {name}",
      videoUnknown: "Длину проверим после загрузки.", videoNeed: "Выберите видео.",
      styleRefs: "Кто или что должно быть в ролике", styleRefsHint: "По желанию, до 5 фото: персонаж, товар, одежда.",
      promptLabel: "Подсказка (по желанию)", promptPh: "Например: тёплый закат, больше снега",
      estimate: "≈ {p} за {n} с — точную цену покажем до оплаты.", orderStyle: "Стиль «{t}»",
      checkingVideo: "Проверяем видео…", changeVideo: "Изменить видео", toStyles: "К стилям",
      photosHint: "1–8 фото, где хорошо видно лицо: свет спереди, без очков и масок. Можно себя, своего ребёнка или человека, который согласился. Чужие фото без согласия — нельзя.",
      presetHint: "1–3 фото: вы, ваш ребёнок или человек, который согласился. Чужие фото без согласия — нельзя. Нейросеть нарисует лист персонажа — портрет, поворот в полный рост, лицо, эмоции, позы — за 5–7 минут после оплаты.",
      addPhoto: "Добавить фото", removePhoto: "Убрать фото",
      send: "Отправить", sending: "Отправляем… {p}%", sent: "Отправлено",
      errCount: "Можно не больше {n} фото.", errSize: "Фото больше 10 МБ: {name}", errTotal: "Все фото вместе — не больше 40 МБ.",
      errType: "Это не фото: {name}", errNet: "Нет связи с сервером — попробуйте ещё раз.",
      errUpload: "Файлы слишком большие или связь прервалась — попробуйте файлы поменьше.",
      errNeed: "Добавьте хотя бы одно фото.",
      checking: "Проверяем фото…", checkingPreset: "Проверяем пресет…", toPay: "К оплате", orderNo: "Заказ №{n}",
      payCard: "💳 Оплатить картой / СБП", payStars: "⭐ Оплатить звёздами", payWhere: "Оплата на странице {host}",
      payBot: "Оплатить можно и в боте.", payCheck: "Проверяем оплату…", consent: "Нужно согласие",
      rejected: "Не получилось", changePhoto: "Изменить фото", makePreset: "Сделать пресет",
      support: "Написать в поддержку", supportHint: "В чате бота — команда /support.", review: "Проверяем заказ",
      working: "Делаем ваш ролик — 5–15 минут", workingPreset: "Рисуем пресет — 5–7 минут",
      workingText: "Можно закрыть приложение: результат придёт и в чат бота.",
      done: "Готово!", save: "Сохранить", share: "В историю",
      inChat: "Ролик уже в чате бота — оттуда его можно сохранить и переслать.", inChatPreset: "Лист и файлы — в чате бота.",
      backToTrend: "Вернуться к тренду", cancelled: "Заказ отменён", toTrends: "К трендам",
      cancel: "Отменить заказ", cancelAsk: "Отменить заказ?", cancelYes: "Отменить", cancelNo: "Оставить",
      notFound: "Заказ не найден", retry: "Нет связи — пробуем ещё…", myOrders: "Ваши заказы",
      orderTrend: "Тренд «{t}»", orderPreset: "Пресет персонажа", orderOpen: "открыть",
      saveStarted: "Сохраняем…", shareFail: "Не получилось — ролик есть в чате бота.",
      // 96C: вкладка «Создать» — AI-видео, картинки (в боте), свой персонаж
      tileCreate: ["Создать", "Видео по описанию, картинки, свой персонаж"],
      createTitle: "Создать", createSub: "Что сделаем с нуля?",
      cAiv: ["🎥 AI-видео", "Опишите — нейросеть снимет видео"],
      cImg: ["🖼 Картинки", "Создать по описанию, изменить фото, убрать фон"],
      cChar: ["🧩 Свой персонаж", "Лист персонажа по вашим фото — для трендов и «Изменить видео»"],
      soon: "скоро", imgSoon: "🖼 Картинки — на стадии разработки. Скоро!",
      ownStory: ["✍️ Свой сюжет", "Опишите, что снять"],
      aivTitle: "Создать видео", aivSub: "Нейросеть снимет видео по вашему описанию",
      aivWhat: "Что снять?", aivPh: "Например: кот-космонавт идёт по Луне, мультфильм…",
      aivPhotos: "Фото-образцы — по желанию, без людей", aivPhotosHint: "До 10 фото: товар, логотип, интерьер, место, стиль, рисунок.",
      photoN: "Фото {n}", aivFormat: "Формат", more: "ещё…", aivLen: "Длина · {n} с", errTotalAiv: "Все фото вместе — не больше 100 МБ.",
      ratio: { "9:16": "Вертикальное 9:16", "16:9": "Горизонтальное 16:9", "1:1": "Квадрат 1:1" },
      aivName: "🎥 AI-видео", aivNote: "Точная цена — в боте перед оплатой.", aivBtn: "Создать",
      aivBan: "Нельзя: фото с людьми, 18+, насилие, чужие бренды", rules: "Правила", aivNeed: "Опишите, что снять.",
      rulesTitle: "Правила AI-видео",
      rulesOk: "Можно: любые сцены, места, предметы, животные и стили; вымышленные люди по описанию; реклама своего товара или заведения. Знаменитость или герой фильма — будет персонаж «по мотивам»: тот же образ, но своё лицо и имя.",
      rulesNo: ["Реальные люди на фото-образцах — фото с людьми и лицами.", "18+: обнажённость, сексуальные сцены и намёки на них.",
        "Интимные, сексуализированные и унижающие сцены с детьми — без исключений.", "Насилие и жестокость: кровь, увечья, пытки, убийства.",
        "Оружие, наркотики, алкоголь и табак как предмет рекламы или инструкции.", "Ненависть и экстремизм.",
        "Обман: фейковые новости, поддельные документы, ложные обещания в рекламе.", "Чужие бренды: логотипы и товарные знаки чужих компаний.",
        "Всё, что запрещено законом и правилами Telegram."],
      rulesHow: "Перед ценой описание проверяется по этим правилам. Нарушение — объясним, что нельзя, и попросим переписать; платить ничего не нужно.",
      checkingDesc: "Проверяем описание…", changeDesc: "Изменить описание", orderAiv: "AI-видео", createMore: "Создать ещё",
      charTitle: "Свой персонаж", charSub: "Лист персонажа по вашим фото — нейросеть держит по нему лицо и фигуру в трендах и «Изменить видео».",
      charPhotos: "Ваши фото · 1–3", charStyle: "Стиль", charBtn: "Сделать персонажа", charName: "🧩 Пресет персонажа",
      styleNames: { real: "📷 Реализм", cartoon: "🎨 Мультфильм", anime: "🌸 Аниме", "3d": "🧸 3D" },
      // 97C: подсказки под «Что снять?», «Смягчить» на экране счёта
      aivHints: ["Надпись в кадре — в кавычках, до 30 знаков · текст по-английски уйдёт слово в слово",
        "Фото 1, 2… — в описании можно писать «как на Фото 1» · видео — со звуком"],
      softenRisk: "Нейросеть может отклонить: {what}.", softenRiskAny: "Нейросеть может отклонить это описание.",
      softenBtn: "🪶 Смягчить", softenKeep: "Оставить как есть", softening: "Смягчаем…",
      softeningText: "Перепишем описание — новый счёт появится здесь.", softenOnce: "Смягчить можно только один раз.",
      // 97C (ревью): окно «Данные» — честно, что лежит на устройстве
      editDescAsk: "Текущий счёт отменим — изменить описание?", editDescYes: "Отменить счёт и изменить",
      draftMontage: "{n} видео · до {t}", draftTag: "черновик",
      aboutTitle: "Данные",
      about: [["Что хранится здесь", "Черновики и номера ваших заказов — только на этом устройстве."],
        ["AI-видео", "Черновик описания и настроек AI-видео хранится только на этом устройстве — до 7 дней; последнее оплаченное описание — 24 часа. «Стереть данные» удаляет всё."],
        ["Фото, видео и описания для заказа", "Уходят в Montaggio только для вашего заказа, сроки хранения — в политике конфиденциальности. Фото и видео в браузере не остаются."],
        ["«Изменить видео» и «Монтаж»", "В бота уходит только ваш выбор — коротким кодом в ссылке."]],
      // 97C доделка 2: оплата открыта — «Изменить описание» и «Отменить» не показываем; профиль и черновики — ru/en/it
      payPending: "Проверяем оплату… Если уже оплатили — не отменяйте заказ, оплата дойдёт.",
      cancelPaidNote: "Если уже оплатили — не отменяйте, оплата дойдёт.",
      editDescOther: "Откроется ваш текущий черновик — не описание этого счёта.",
      editDescLost: "Описание этого счёта на устройстве не сохранилось — его придётся ввести заново.",
      contTitle: "Продолжить", savedHere: "Сохранено здесь", draftsTitle: "Черновики",
      draftsSub: "Не оформленные заказы — на этом устройстве.", draftDrop: "Удалить черновик", draftDropped: "Черновик удалён.",
      noDrafts: "Черновиков нет", noDraftsText: "Начатый заказ сохранится здесь, пока вы не оформите его в боте.",
      profileTitle: "Ваше пространство", profileSub: "Черновики — только на этом устройстве",
      profileRows: [["Черновики", "{n} не оформлено"], ["Как это работает", "Приложение, бот и оплата"], ["Данные", "Что хранится и что куда уходит"]],
      resetLink: "Стереть данные на этом устройстве", resetTitle: "Стереть данные?",
      resetText: "Удалятся черновики, описание AI-видео и номера заказов на этом устройстве.", resetYes: "Стереть",
      resetDone: "Данные на этом устройстве стёрты.",
      // 97C: вкладка «Изменить» по правкам партнёра (12.10): «Изменить видео» (нейросеть) — первым, «Монтаж» — последним
      editTitle: "Изменить видео", editSub: "Что сделать с вашим видео?",
      svcNeuro: ["🪄 Изменить видео", "Новый стиль, фон или персонаж — нейросеть перерисует ваше видео"],
      svcMontage: ["🎬 Монтаж", "Вырежем паузы, слова-паразиты и дубли, почистим голос"],
      editNote: "«Изменить видео» и «Монтаж» — видео пришлёте в чате с ботом. «Сменить стиль» — видео загружается прямо здесь.",
      kinds: { montage: "🎬 Монтаж", neuro: "🪄 Изменить видео" },
      modeLabel: "Режим",
      modes: {
        redraw: ["🎨 Изменить образ", "Измените одежду, макияж и другие детали образа, сохранив самого человека. Подходит для разговорных видео и съёмки в полный рост."],
        replace: ["🔁 Заменить персонажа", "Замените человека или объект в видео либо перенесите на человека другую внешность. Опишите, кого и как изменить, и добавьте образец — картинку или пресет. Можно заменить одного персонажа или нескольких."],
        motion: ["🕺 Перенос движения", "Персонаж с картинки повторит ваши движения и жесты."],
      },
      nLen: "Длина видео", nLenHint: "Выберите примерную длительность вашего видео",
      montageTitle: "Монтаж",
      montageDesc: "Уберём паузы, слова-паразиты и неудачные дубли, очистим звук — речь станет связнее, а видео короче. Внешность и изображение сохранятся.",
      montagePick: "Выберите, что нужно улучшить",
      montageItems: { 1: ["Вырезать паузы", "Тишина между фразами — долой."], 2: ["Слова-паразиты", "«ээ», «ну», «как бы»."],
        3: ["Дубли и оговорки", "Без потери смысла."], 14: ["Чистый голос", "Убрать шум, выровнять громкость."] },
      mLen: "Длина видео — примерно", mUpTo: "до {t}", mTotal: "Всех видео вместе — до 3 минут.", mClips: "Сколько видео склеить",
      fewer: "Меньше", moreClips: "Больше", dur: ["{s} сек", "{m} мин", "{m} мин {s} сек"],
      stepsMontage: ["Пришлите {what} в чат с ботом.", "Бот проверит длину и покажет точную цену.", "Оплата — в боте, потом готовое видео придёт туда же."],
      sendOne: "видео", sendMany: "{n} видео одним альбомом",
      stepsNeuro: ["Бот откроет выбранный режим — пришлите видео и, если режим просит, промпт или образец.", "Точная цена — в карточке после видео.", "Оплата — в боте, результат придёт туда же."],
      priceNone: "Точную цену бот покажет до оплаты.", priceMontage: "Бот проверит длину и покажет точную цену до оплаты.",
      priceNeuro: "Примерная цена. Точная — в боте перед оплатой.", toBot: "Оформить в боте", needOpt: "Оставьте хотя бы один пункт монтажа.",
    },
    en: {
      nav: ["Home", "Trends", "Edit", "Create", "Profile"],
      homeTitle: ["What video", "shall we make?"], homeSub: "Repeat a trend with your face — or edit your own video.",
      tileEdit: ["Edit a video", "Cut your own or change it with AI"],
      tileTrend: ["Repeat a trend", "Your face in a ready trending video"],
      trends: "Trends", trendsHint: "Swipe and pick", allTrends: "All trends",
      suggestBtn: "💡 Suggest your trend", suggestText: "Found a cool video? Send it — we'll try to make it a trend.",
      trendsSub: "Pick a video — we'll repeat it with you.", from: "from {p}", sec: "{n} s",
      loading: "Loading trends…", downTitle: "Trends will be back soon", downText: "Meanwhile, order in the bot.",
      openBot: "Open the bot", source: "Original", result: "Final video",
      soundOn: "Turn sound on", soundOff: "Turn sound off",
      quality: "Quality", q: { "480p": "For Stories", "720p": "Sharp HD", "1080p": "Maximum" }, repeat: "Repeat",
      whoTitle: "Who will be in the video?", recommended: "Recommended",
      optPreset: "My preset", optPresetTag: "best result",
      optPresetHint: "Your character from the preset — the face and figure stay more accurate.",
      optMake: "Make a preset", optMakeHint: "1–3 photos — we'll draw a character sheet, then come back to this trend.",
      optPhoto: "Upload photos", optPhotoHint: "1–8 photos of you — no preset needed.",
      photosTitle: "Your photos", presetTitle: "New preset", presetSub: "A character sheet from your photos",
      wishLabel: "Your wishes (optional)", wishPh: "For example: let the second one wear glasses · make me blond · make it night",
      wishHint: "We'll apply them if they don't change the trend itself or break the rules.",
      askTitle: "Photos for the video", optPhotos: "Photos", next: "Next", yourFace: "Your face", presetPhotos: "Your photos",
      presetUse: "We'll use your latest character preset — no photos needed for this person.", noPreset: "No preset? Make one",
      errMin: "Add photos: {label}.", errTotalAll: "Video and photos together — no more than 105 MB.",
      tileStyle: ["Change the style", "Your video in a new look: anime, toy, knitted world…"],
      styles: "Styles", stylesHint: "Your video in a new look", stylesSub: "Pick a style — we'll redraw your video in it.",
      allStyles: "All styles", styleFrom: "from {p} per 5 s", stylesDown: "Styles will be back soon",
      yourVideo: "Your video", videoHint: "One video from 4 to 30 seconds, up to 100 MB. Longer than 30 s — we take the first 30 s.",
      addVideo: "Choose a video", removeVideo: "Remove video", videoLen: "{n} s · {mb} MB",
      videoLong: "The video is {n} s — we'll take the first 30 s.", videoShort: "The video is {n} s — it needs at least 4 seconds.",
      videoBig: "The video is larger than 100 MB — choose a shorter one or compress it.", videoType: "Not a video: {name}",
      videoUnknown: "We'll check the length after upload.", videoNeed: "Choose a video.",
      styleRefs: "Who or what should be in the video", styleRefsHint: "Optional, up to 5 photos: a character, a product, clothes.",
      promptLabel: "Hint (optional)", promptPh: "For example: warm sunset, more snow",
      estimate: "≈ {p} for {n} s — the exact price is shown before payment.", orderStyle: "Style “{t}”",
      checkingVideo: "Checking the video…", changeVideo: "Change the video", toStyles: "To styles",
      photosHint: "1–8 photos with a clearly visible face: light from the front, no glasses or masks. You, your child or a person who agreed. Other people's photos without consent are not allowed.",
      presetHint: "1–3 photos: you, your child or a person who agreed. Other people's photos without consent are not allowed. The AI will draw a character sheet — portrait, full-length turnaround, face, emotions, poses — in 5–7 minutes after payment.",
      addPhoto: "Add photos", removePhoto: "Remove photo",
      send: "Send", sending: "Sending… {p}%", sent: "Sent",
      errCount: "No more than {n} photos.", errSize: "Photo larger than 10 MB: {name}", errTotal: "All photos together — no more than 40 MB.",
      errType: "Not a photo: {name}", errNet: "No connection to the server — please try again.",
      errUpload: "The files are too large or the connection dropped — try smaller files.",
      errNeed: "Add at least one photo.",
      checking: "Checking the photos…", checkingPreset: "Checking the preset…", toPay: "To pay", orderNo: "Order #{n}",
      payCard: "💳 Pay by card", payStars: "⭐ Pay with Stars", payWhere: "Payment on {host}",
      payBot: "You can also pay in the bot.", payCheck: "Checking the payment…", consent: "Consent needed",
      rejected: "That didn't work", changePhoto: "Change photos", makePreset: "Make a preset",
      support: "Contact support", supportHint: "In the bot chat — the /support command.", review: "Checking the order",
      working: "Making your video — 5–15 minutes", workingPreset: "Drawing the preset — 5–7 minutes",
      workingText: "You can close the app: the result will also arrive in the bot chat.",
      done: "Done!", save: "Save", share: "To Story",
      inChat: "The video is already in the bot chat — you can save and forward it from there.", inChatPreset: "The sheet and files are in the bot chat.",
      backToTrend: "Back to the trend", cancelled: "Order cancelled", toTrends: "To trends",
      cancel: "Cancel order", cancelAsk: "Cancel the order?", cancelYes: "Cancel", cancelNo: "Keep",
      notFound: "Order not found", retry: "No connection — retrying…", myOrders: "Your orders",
      orderTrend: "Trend “{t}”", orderPreset: "Character preset", orderOpen: "open",
      saveStarted: "Saving…", shareFail: "Didn't work — the video is in the bot chat.",
      tileCreate: ["Create", "Video from a description, images, your character"],
      createTitle: "Create", createSub: "What shall we make from scratch?",
      cAiv: ["🎥 AI video", "Describe it — the AI will shoot the video"],
      cImg: ["🖼 Images", "Create from a description, edit a photo, remove the background"],
      cChar: ["🧩 Your character", "A character sheet from your photos — for trends and “Change the video”"],
      soon: "soon", imgSoon: "🖼 Images — in development. Coming soon!",
      ownStory: ["✍️ Your own story", "Describe what to shoot"],
      aivTitle: "Create a video", aivSub: "The AI will shoot a video from your description",
      aivWhat: "What to shoot?", aivPh: "For example: a cat astronaut walking on the Moon, cartoon…",
      aivPhotos: "Reference photos — optional, no people", aivPhotosHint: "Up to 10 photos: a product, logo, interior, place, style, drawing.",
      photoN: "Photo {n}", aivFormat: "Format", more: "more…", aivLen: "Length · {n} s", errTotalAiv: "All photos together — no more than 100 MB.",
      ratio: { "9:16": "Vertical 9:16", "16:9": "Horizontal 16:9", "1:1": "Square 1:1" },
      aivName: "🎥 AI video", aivNote: "The exact price is shown in the bot before payment.", aivBtn: "Create",
      aivBan: "Not allowed: photos with people, 18+, violence, other people's brands", rules: "Rules", aivNeed: "Describe what to shoot.",
      rulesTitle: "AI video rules",
      rulesOk: "Allowed: any scenes, places, objects, animals and styles; fictional people from a description; ads for your own product or venue. A celebrity or a movie hero becomes a character “inspired by” them: the same look, but their own face and name.",
      rulesNo: ["Real people in reference photos — photos with people and faces.", "18+: nudity, sexual scenes and hints of them.",
        "Intimate, sexualized or degrading scenes with children — no exceptions.", "Violence and cruelty: blood, injuries, torture, killing.",
        "Weapons, drugs, alcohol and tobacco as the subject of ads or instructions.", "Hate and extremism.",
        "Deception: fake news, forged documents, false promises in ads.", "Other people's brands: logos and trademarks of other companies.",
        "Anything prohibited by law and Telegram rules."],
      rulesHow: "Before the price, the description is checked against these rules. If something breaks them, we'll explain what's not allowed and ask you to rewrite it; you pay nothing.",
      checkingDesc: "Checking the description…", changeDesc: "Edit the description", orderAiv: "AI video", createMore: "Create another",
      charTitle: "Your character", charSub: "A character sheet from your photos — the AI keeps the face and figure from it in trends and “Change the video”.",
      charPhotos: "Your photos · 1–3", charStyle: "Style", charBtn: "Make the character", charName: "🧩 Character preset",
      styleNames: { real: "📷 Realism", cartoon: "🎨 Cartoon", anime: "🌸 Anime", "3d": "🧸 3D" },
      aivHints: ["Text on screen — in quotes, up to 30 characters · an English description goes word for word",
        "Photo 1, 2… — you can write “like in Photo 1” · the video comes with sound"],
      softenRisk: "The AI may reject: {what}.", softenRiskAny: "The AI may reject this description.",
      softenBtn: "🪶 Soften", softenKeep: "Keep as is", softening: "Softening…",
      softeningText: "We'll rewrite the description — the new bill will appear here.", softenOnce: "It can only be softened once.",
      editDescAsk: "We'll cancel the current bill — edit the description?", editDescYes: "Cancel the bill and edit",
      draftMontage: "{n} video · up to {t}", draftTag: "draft",
      aboutTitle: "Data",
      about: [["What is stored here", "Drafts and your order numbers — only on this device."],
        ["AI video", "The draft of the AI video description and settings is kept only on this device — up to 7 days; the last paid description — 24 hours. “Erase data” deletes everything."],
        ["Photos, videos and descriptions for an order", "They go to Montaggio only for your order; storage periods are in the privacy policy. Photos and videos don't stay in the browser."],
        ["“Change the video” and “Editing”", "Only your choice goes to the bot — as a short code in the link."]],
      payPending: "Checking the payment… If you've already paid, don't cancel the order — the payment will come through.",
      cancelPaidNote: "If you've already paid, don't cancel — the payment will come through.",
      editDescOther: "Your current draft will open — not the description of this bill.",
      editDescLost: "The description of this bill isn't saved on this device — you'll need to enter it again.",
      contTitle: "Continue", savedHere: "Saved here", draftsTitle: "Drafts",
      draftsSub: "Orders not placed yet — on this device.", draftDrop: "Delete draft", draftDropped: "Draft deleted.",
      noDrafts: "No drafts", noDraftsText: "An order you start will be saved here until you place it in the bot.",
      profileTitle: "Your space", profileSub: "Drafts — only on this device",
      profileRows: [["Drafts", "{n} not placed"], ["How it works", "The app, the bot and payment"], ["Data", "What is stored and where it goes"]],
      resetLink: "Erase data on this device", resetTitle: "Erase data?",
      resetText: "Drafts, the AI video description and order numbers on this device will be deleted.", resetYes: "Erase",
      resetDone: "Data on this device erased.",
      editTitle: "Edit a video", editSub: "What shall we do with your video?",
      svcNeuro: ["🪄 Change the video", "A new style, background or character — the AI will redraw your video"],
      svcMontage: ["🎬 Editing", "We'll cut pauses, filler words and retakes, and clean up the voice"],
      editNote: "“Change the video” and “Editing” — you'll send the video in the bot chat. “Change the style” — the video is uploaded right here.",
      kinds: { montage: "🎬 Editing", neuro: "🪄 Change the video" },
      modeLabel: "Mode",
      modes: {
        redraw: ["🎨 Change the look", "Change clothes, makeup and other details of the look while keeping the person. Works for talking videos and full-length shots."],
        replace: ["🔁 Replace a character", "Replace a person or an object in the video, or give a person a different appearance. Describe who to change and how, and add a sample — an image or a preset. You can replace one character or several."],
        motion: ["🕺 Motion transfer", "The character from the image will repeat your movements and gestures."],
      },
      nLen: "Video length", nLenHint: "Choose the approximate length of your video",
      montageTitle: "Editing",
      montageDesc: "We'll remove pauses, filler words and failed retakes and clean up the sound — the speech gets smoother and the video shorter. Your appearance and the picture stay the same.",
      montagePick: "Choose what to improve",
      montageItems: { 1: ["Cut pauses", "Silence between phrases — gone."], 2: ["Filler words", "“uh”, “um”, “like”."],
        3: ["Retakes and slips", "Without losing the meaning."], 14: ["Clean voice", "Remove noise, even out the volume."] },
      mLen: "Video length — approximately", mUpTo: "up to {t}", mTotal: "All videos together — up to 3 minutes.", mClips: "How many videos to join",
      fewer: "Fewer", moreClips: "More", dur: ["{s} s", "{m} min", "{m} min {s} s"],
      stepsMontage: ["Send {what} to the bot chat.", "The bot will check the length and show the exact price.", "Pay in the bot — the finished video will arrive there too."],
      sendOne: "the video", sendMany: "{n} videos as one album",
      stepsNeuro: ["The bot will open the chosen mode — send the video and, if the mode asks, a prompt or a sample.", "The exact price is in the card after the video.", "Pay in the bot — the result will arrive there too."],
      priceNone: "The bot will show the exact price before payment.", priceMontage: "The bot will check the length and show the exact price before payment.",
      priceNeuro: "Approximate price. The exact one is in the bot before payment.", toBot: "Order in the bot", needOpt: "Keep at least one editing item.",
    },
    it: {
      nav: ["Home", "Trend", "Modifica", "Crea", "Profilo"],
      homeTitle: ["Che video", "facciamo?"], homeSub: "Ripeti un trend con il tuo volto — o modifica il tuo video.",
      tileEdit: ["Modifica un video", "Monta il tuo o cambialo con l'IA"],
      tileTrend: ["Ripeti un trend", "Il tuo volto in un video di tendenza"],
      trends: "Trend", trendsHint: "Scorri e scegli", allTrends: "Tutti i trend",
      suggestBtn: "💡 Proponi il tuo trend", suggestText: "Hai trovato un bel video? Mandacelo — proveremo a farne un trend.",
      trendsSub: "Scegli un video — lo ripetiamo con te.", from: "da {p}", sec: "{n} s",
      loading: "Caricamento dei trend…", downTitle: "I trend tornano presto", downText: "Intanto ordina nel bot.",
      openBot: "Apri il bot", source: "Originale", result: "Video finale",
      soundOn: "Attiva l'audio", soundOff: "Disattiva l'audio",
      quality: "Qualità", q: { "480p": "Per le storie", "720p": "HD nitido", "1080p": "Massima" }, repeat: "Ripeti",
      whoTitle: "Chi sarà nel video?", recommended: "Consigliato",
      optPreset: "Il mio preset", optPresetTag: "miglior risultato",
      optPresetHint: "Il tuo personaggio dal preset — volto e figura restano più fedeli.",
      optMake: "Crea un preset", optMakeHint: "1–3 foto — disegniamo la scheda del personaggio, poi torniamo a questo trend.",
      optPhoto: "Carica foto", optPhotoHint: "1–8 tue foto — senza preset.",
      photosTitle: "Le tue foto", presetTitle: "Nuovo preset", presetSub: "Scheda del personaggio dalle tue foto",
      wishLabel: "I tuoi desideri (facoltativi)", wishPh: "Per esempio: il secondo con gli occhiali · fammi biondo · che sia notte",
      wishHint: "Li applichiamo se non cambiano il trend e non violano le regole.",
      askTitle: "Foto per il video", optPhotos: "Foto", next: "Avanti", yourFace: "Il tuo volto", presetPhotos: "Le tue foto",
      presetUse: "Useremo il tuo ultimo preset del personaggio — per questa persona non servono foto.", noPreset: "Nessun preset? Crealo",
      errMin: "Aggiungi foto: {label}.", errTotalAll: "Video e foto insieme — non più di 105 MB.",
      tileStyle: ["Cambia stile", "Il tuo video in un nuovo look: anime, giocattolo, mondo a maglia…"],
      styles: "Stili", stylesHint: "Il tuo video in un nuovo look", stylesSub: "Scegli uno stile — ridisegniamo il tuo video.",
      allStyles: "Tutti gli stili", styleFrom: "da {p} per 5 s", stylesDown: "Gli stili tornano presto",
      yourVideo: "Il tuo video", videoHint: "Un video da 4 a 30 secondi, fino a 100 MB. Oltre 30 s — prendiamo i primi 30 s.",
      addVideo: "Scegli un video", removeVideo: "Rimuovi video", videoLen: "{n} s · {mb} MB",
      videoLong: "Il video dura {n} s — prendiamo i primi 30 s.", videoShort: "Il video dura {n} s — servono almeno 4 secondi.",
      videoBig: "Il video supera 100 MB — scegline uno più corto o comprimilo.", videoType: "Non è un video: {name}",
      videoUnknown: "Controlleremo la durata dopo il caricamento.", videoNeed: "Scegli un video.",
      styleRefs: "Chi o cosa deve esserci nel video", styleRefsHint: "Facoltativo, fino a 5 foto: un personaggio, un prodotto, dei vestiti.",
      promptLabel: "Suggerimento (facoltativo)", promptPh: "Per esempio: tramonto caldo, più neve",
      estimate: "≈ {p} per {n} s — il prezzo esatto prima del pagamento.", orderStyle: "Stile «{t}»",
      checkingVideo: "Controlliamo il video…", changeVideo: "Cambia video", toStyles: "Agli stili",
      photosHint: "1–8 foto con il volto ben visibile: luce frontale, senza occhiali né mascherine. Tu, tuo figlio o una persona che ha acconsentito. Foto di altri senza consenso — no.",
      presetHint: "1–3 foto: tu, tuo figlio o una persona che ha acconsentito. Foto di altri senza consenso — no. L'IA disegnerà la scheda del personaggio — ritratto, giro completo, volto, emozioni, pose — in 5–7 minuti dopo il pagamento.",
      addPhoto: "Aggiungi foto", removePhoto: "Rimuovi foto",
      send: "Invia", sending: "Invio… {p}%", sent: "Inviato",
      errCount: "Non più di {n} foto.", errSize: "Foto oltre 10 MB: {name}", errTotal: "Tutte le foto insieme — non più di 40 MB.",
      errType: "Non è una foto: {name}", errNet: "Nessuna connessione al server — riprova.",
      errUpload: "File troppo grandi o connessione interrotta — prova con file più piccoli.",
      errNeed: "Aggiungi almeno una foto.",
      checking: "Controlliamo le foto…", checkingPreset: "Controlliamo il preset…", toPay: "Da pagare", orderNo: "Ordine n. {n}",
      payCard: "💳 Paga con carta", payStars: "⭐ Paga con le Stelle", payWhere: "Pagamento su {host}",
      payBot: "Puoi pagare anche nel bot.", payCheck: "Verifichiamo il pagamento…", consent: "Serve il consenso",
      rejected: "Non è andata", changePhoto: "Cambia foto", makePreset: "Crea un preset",
      support: "Scrivi al supporto", supportHint: "Nella chat del bot — il comando /support.", review: "Controlliamo l'ordine",
      working: "Stiamo facendo il tuo video — 5–15 minuti", workingPreset: "Disegniamo il preset — 5–7 minuti",
      workingText: "Puoi chiudere l'app: il risultato arriverà anche nella chat del bot.",
      done: "Fatto!", save: "Salva", share: "Nella storia",
      inChat: "Il video è già nella chat del bot — da lì puoi salvarlo e inoltrarlo.", inChatPreset: "La scheda e i file sono nella chat del bot.",
      backToTrend: "Torna al trend", cancelled: "Ordine annullato", toTrends: "Ai trend",
      cancel: "Annulla ordine", cancelAsk: "Annullare l'ordine?", cancelYes: "Annulla", cancelNo: "Lascia",
      notFound: "Ordine non trovato", retry: "Nessuna connessione — riproviamo…", myOrders: "I tuoi ordini",
      orderTrend: "Trend «{t}»", orderPreset: "Preset del personaggio", orderOpen: "apri",
      saveStarted: "Salvataggio…", shareFail: "Non è riuscito — il video è nella chat del bot.",
      tileCreate: ["Crea", "Video da una descrizione, immagini, il tuo personaggio"],
      createTitle: "Crea", createSub: "Cosa creiamo da zero?",
      cAiv: ["🎥 Video AI", "Descrivilo — l'IA girerà il video"],
      cImg: ["🖼 Immagini", "Crea da una descrizione, modifica una foto, rimuovi lo sfondo"],
      cChar: ["🧩 Il tuo personaggio", "Scheda del personaggio dalle tue foto — per trend e «Cambia il video»"],
      soon: "presto", imgSoon: "🖼 Immagini — in sviluppo. Presto!",
      ownStory: ["✍️ La tua storia", "Descrivi cosa girare"],
      aivTitle: "Crea un video", aivSub: "L'IA girerà un video dalla tua descrizione",
      aivWhat: "Cosa girare?", aivPh: "Per esempio: un gatto astronauta cammina sulla Luna, cartone animato…",
      aivPhotos: "Foto di riferimento — facoltative, senza persone", aivPhotosHint: "Fino a 10 foto: un prodotto, un logo, un interno, un luogo, uno stile, un disegno.",
      photoN: "Foto {n}", aivFormat: "Formato", more: "altro…", aivLen: "Durata · {n} s", errTotalAiv: "Tutte le foto insieme — non più di 100 MB.",
      ratio: { "9:16": "Verticale 9:16", "16:9": "Orizzontale 16:9", "1:1": "Quadrato 1:1" },
      aivName: "🎥 Video AI", aivNote: "Il prezzo esatto — nel bot prima del pagamento.", aivBtn: "Crea",
      aivBan: "Non ammesso: foto con persone, 18+, violenza, marchi altrui", rules: "Regole", aivNeed: "Descrivi cosa girare.",
      rulesTitle: "Regole del video AI",
      rulesOk: "Ammesso: qualsiasi scena, luogo, oggetto, animale e stile; persone immaginarie dalla descrizione; pubblicità del tuo prodotto o locale. Una celebrità o un eroe di film diventa un personaggio «ispirato a»: lo stesso look, ma volto e nome propri.",
      rulesNo: ["Persone reali nelle foto di riferimento — foto con persone e volti.", "18+: nudità, scene sessuali e allusioni.",
        "Scene intime, sessualizzate o umilianti con bambini — senza eccezioni.", "Violenza e crudeltà: sangue, ferite, torture, omicidi.",
        "Armi, droghe, alcol e tabacco come oggetto di pubblicità o istruzioni.", "Odio ed estremismo.",
        "Inganni: notizie false, documenti falsi, false promesse nella pubblicità.", "Marchi altrui: loghi e marchi di altre aziende.",
        "Tutto ciò che è vietato dalla legge e dalle regole di Telegram."],
      rulesHow: "Prima del prezzo la descrizione viene controllata secondo queste regole. Se qualcosa non va, ti spieghiamo cosa non si può e ti chiediamo di riscrivere; non paghi nulla.",
      checkingDesc: "Controlliamo la descrizione…", changeDesc: "Modifica la descrizione", orderAiv: "Video AI", createMore: "Creane un altro",
      charTitle: "Il tuo personaggio", charSub: "Una scheda del personaggio dalle tue foto — l'IA mantiene volto e figura nei trend e in «Cambia il video».",
      charPhotos: "Le tue foto · 1–3", charStyle: "Stile", charBtn: "Crea il personaggio", charName: "🧩 Preset del personaggio",
      styleNames: { real: "📷 Realismo", cartoon: "🎨 Cartone", anime: "🌸 Anime", "3d": "🧸 3D" },
      aivHints: ["Scritta nell'inquadratura — tra virgolette, fino a 30 caratteri · il testo in inglese va parola per parola",
        "Foto 1, 2… — puoi scrivere «come nella Foto 1» · il video ha l'audio"],
      softenRisk: "L'IA potrebbe rifiutare: {what}.", softenRiskAny: "L'IA potrebbe rifiutare questa descrizione.",
      softenBtn: "🪶 Ammorbidisci", softenKeep: "Lascia così", softening: "Ammorbidiamo…",
      softeningText: "Riscriviamo la descrizione — il nuovo conto apparirà qui.", softenOnce: "Si può ammorbidire una sola volta.",
      editDescAsk: "Annulleremo il conto attuale — modificare la descrizione?", editDescYes: "Annulla il conto e modifica",
      draftMontage: "{n} video · fino a {t}", draftTag: "bozza",
      aboutTitle: "Dati",
      about: [["Cosa è salvato qui", "Bozze e numeri dei tuoi ordini — solo su questo dispositivo."],
        ["Video AI", "La bozza della descrizione e delle impostazioni del video AI resta solo su questo dispositivo — fino a 7 giorni; l'ultima descrizione pagata — 24 ore. «Cancella dati» elimina tutto."],
        ["Foto, video e descrizioni per l'ordine", "Vanno a Montaggio solo per il tuo ordine; i tempi di conservazione sono nell'informativa privacy. Foto e video non restano nel browser."],
        ["«Cambia il video» e «Montaggio»", "Al bot va solo la tua scelta — come codice breve nel link."]],
      payPending: "Verifichiamo il pagamento… Se hai già pagato, non annullare l'ordine — il pagamento arriverà.",
      cancelPaidNote: "Se hai già pagato, non annullare — il pagamento arriverà.",
      editDescOther: "Si aprirà la tua bozza attuale — non la descrizione di questo conto.",
      editDescLost: "La descrizione di questo conto non è salvata sul dispositivo — dovrai scriverla di nuovo.",
      contTitle: "Continua", savedHere: "Salvato qui", draftsTitle: "Bozze",
      draftsSub: "Ordini non ancora inviati — su questo dispositivo.", draftDrop: "Elimina bozza", draftDropped: "Bozza eliminata.",
      noDrafts: "Nessuna bozza", noDraftsText: "Un ordine iniziato resterà qui finché non lo invii nel bot.",
      profileTitle: "Il tuo spazio", profileSub: "Bozze — solo su questo dispositivo",
      profileRows: [["Bozze", "{n} non inviate"], ["Come funziona", "L'app, il bot e il pagamento"], ["Dati", "Cosa è salvato e dove va"]],
      resetLink: "Cancella dati su questo dispositivo", resetTitle: "Cancellare i dati?",
      resetText: "Verranno eliminati bozze, descrizione del video AI e numeri d'ordine su questo dispositivo.", resetYes: "Cancella",
      resetDone: "Dati su questo dispositivo cancellati.",
      editTitle: "Modifica un video", editSub: "Cosa facciamo con il tuo video?",
      svcNeuro: ["🪄 Cambia il video", "Nuovo stile, sfondo o personaggio — l'IA ridisegnerà il tuo video"],
      svcMontage: ["🎬 Montaggio", "Tagliamo pause, intercalari e ripetizioni, puliamo la voce"],
      editNote: "«Cambia il video» e «Montaggio» — il video lo invii nella chat del bot. «Cambia stile» — il video si carica qui.",
      kinds: { montage: "🎬 Montaggio", neuro: "🪄 Cambia il video" },
      modeLabel: "Modalità",
      modes: {
        redraw: ["🎨 Cambia look", "Cambia vestiti, trucco e altri dettagli del look, mantenendo la persona. Adatto ai video parlati e alle riprese a figura intera."],
        replace: ["🔁 Sostituisci il personaggio", "Sostituisci una persona o un oggetto nel video, oppure dai a una persona un altro aspetto. Descrivi chi cambiare e come, e aggiungi un modello — un'immagine o un preset. Puoi sostituire uno o più personaggi."],
        motion: ["🕺 Trasferimento del movimento", "Il personaggio dell'immagine ripeterà i tuoi movimenti e gesti."],
      },
      nLen: "Durata del video", nLenHint: "Scegli la durata approssimativa del tuo video",
      montageTitle: "Montaggio",
      montageDesc: "Togliamo pause, intercalari e ripetizioni venute male, puliamo l'audio — il discorso diventa più fluido e il video più corto. Aspetto e immagine restano gli stessi.",
      montagePick: "Scegli cosa migliorare",
      montageItems: { 1: ["Taglia le pause", "Via i silenzi tra le frasi."], 2: ["Intercalari", "«ehm», «cioè», «tipo»."],
        3: ["Ripetizioni e lapsus", "Senza perdere il senso."], 14: ["Voce pulita", "Via il rumore, volume uniforme."] },
      mLen: "Durata del video — circa", mUpTo: "fino a {t}", mTotal: "Tutti i video insieme — fino a 3 minuti.", mClips: "Quanti video unire",
      fewer: "Meno", moreClips: "Di più", dur: ["{s} s", "{m} min", "{m} min {s} s"],
      stepsMontage: ["Invia {what} nella chat del bot.", "Il bot controllerà la durata e mostrerà il prezzo esatto.", "Pagamento nel bot — il video finito arriverà lì."],
      sendOne: "il video", sendMany: "{n} video in un unico album",
      stepsNeuro: ["Il bot aprirà la modalità scelta — invia il video e, se la modalità lo chiede, un prompt o un modello.", "Il prezzo esatto — nella scheda dopo il video.", "Pagamento nel bot — il risultato arriverà lì."],
      priceNone: "Il prezzo esatto lo mostra il bot prima del pagamento.", priceMontage: "Il bot controllerà la durata e mostrerà il prezzo esatto prima del pagamento.",
      priceNeuro: "Prezzo indicativo. Quello esatto — nel bot prima del pagamento.", toBot: "Ordina nel bot", needOpt: "Lascia almeno una voce del montaggio.",
    },
  };
  const T = (key, vars) => {
    const s = (TEXT[LANG] && TEXT[LANG][key]) ?? TEXT.ru[key];
    return typeof s === "string" && vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")) : s;
  };
  function detectLang() {
    const code = String(tg?.initDataUnsafe?.user?.language_code || "").toLowerCase();
    LANG = !code || code.startsWith("ru") ? "ru" : code.startsWith("it") ? "it" : "en";
    document.documentElement.lang = LANG;
  }
  const stars = (n) => `${n} ⭐`;
  const money = (rubN, starsN) => LANG === "ru" ? rub(rubN) : stars(starsN);

  // --- данные интерфейса ---
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const paths = {
    home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
    spark: "m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z",
    sliders: "M4 7h6m4 0h6M4 17h10m4 0h2M10 4v6m4 4v6",
    user: "M19 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    layers: "m12 3 10 6-10 6L2 9Zm-10 12 10 6 10-6M2 12l10 6 10-6",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    chevron: "m9 5 7 7-7 7",
    back: "m15 5-7 7 7 7",
    plus: "M12 5v14M5 12h14",
    x: "m6 6 12 12M6 18 18 6",
    play: "m8 5 12 7-12 7Z",
    image: "M4 5h16v14H4Zm0 11 5-5 4 4 3-3 4 4M15 9h.01",
    video: "M3 5h13v14H3Zm13 5 5-4v12l-5-4",
    scissors: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12",
    check: "m5 12 4 4L19 6",
    info: "M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
    reset: "M3 3v6h6M3 9a9 9 0 1 1 0 6",
    send: "m22 2-7 20-4-9-9-4Zm-11 11L22 2",
    camera: "M4 8h3l2-3h6l2 3h3v11H4ZM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    download: "M12 3v12m-5-5 5 5 5-5M4 21h16",
    sound: "M4 9h4l5-4v14l-5-4H4ZM16 9a4 4 0 0 1 0 6m2.5-8.5a7.5 7.5 0 0 1 0 11",
    mute: "M4 9h4l5-4v14l-5-4H4Zm12 0 5 6m0-6-5 6",
  };
  // звук ролика на экране тренда: включить этот — остальные без звука
  function toggleSound(b) {
    const v = b.closest(".tmedia")?.querySelector("video");
    if (!v) return;
    const on = v.muted;
    document.querySelectorAll("video").forEach((x) => { if (x !== v) x.muted = true; });
    document.querySelectorAll(".sound-toggle").forEach((x) => {
      const me = x === b && on;
      x.setAttribute("aria-pressed", String(me));
      x.setAttribute("aria-label", T(me ? "soundOff" : "soundOn"));
      x.innerHTML = icon(me ? "sound" : "mute");
    });
    v.muted = !on;
    if (on) {
      if (!v.getAttribute("src")) v.src = v.dataset.src;
      v.play().catch(() => {});
    }
  }
  const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n] || paths.spark}"/></svg>`;
  const monti = (size = "m") =>
    `<span class="mini-monti monti-${size}"><picture><source media="(prefers-reduced-motion: reduce)" srcset="assets/monti-still.png"><img src="assets/monti-sticker.gif" width="320" height="320" alt="Монти — помощник Montaggio"></picture></span>`;
  const button = (text, action, cls = "primary", attrs = "", ic = "") =>
    `<button class="button ${cls}" data-action="${action}" ${attrs}>${ic ? icon(ic) : ""}${text}</button>`;

  // элемент DOM: данные сервера попадают в страницу только как текст (textContent) и проверенные адреса
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "icon") n.insertAdjacentHTML("afterbegin", icon(v));      // только свои значки
      else if (k === "data") Object.assign(n.dataset, v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }
  const btn = (text, action, cls = "primary", data = {}, ic = "") =>
    el("button", { class: `button ${cls}`, data: { action, ...data }, type: "button", icon: ic || null }, text);

  // «Монтаж» — клиенту только стандартные пункты (В100, номера — как в боте); названия и пояснения — TEXT.montageItems.
  // Режимы «Изменить видео» (бывший «Нейромонтаж»; 97C, правки партнёра): «Изменить образ» (redraw), «Заменить
  // персонажа» (replace); названия и пояснения — TEXT.modes
  const MONTAGE_ITEMS = [1, 2, 3, 14];
  const NEURO_MODES = ["redraw", "replace", "motion"];
  // режимы «Изменить видео» (нейромонтажа) в архиве — на экране не показываются, код, цена и тексты на месте; вернуть — убрать из списка.
  // motion — в архиве с 13.10 (вместо него — раздел «Стили»)
  const HIDDEN_MODES = ["motion"];
  const neuroModeOk = (m) => Object.prototype.hasOwnProperty.call(NEURO_CODES, m) && !HIDDEN_MODES.includes(m);
  // 96C: AI-видео из приложения (заказ через сервер). Отказались от сервера (SERVER_ORDERS=off у бота) — false: плитка
  // во вкладке «Создать», «Свой сюжет» в трендах и экран #/create/video не показываются; в боте «🎥 AI-видео» как было
  const AIVIDEO_ON = true;
  const PRESET_STYLES = [["real", "📷 Реализм"], ["cartoon", "🎨 Мультфильм"], ["anime", "🌸 Аниме"], ["3d", "🧸 3D"]];
  const QUALITIES = ["480p", "720p", "1080p"];
  const MONTAGE_SECONDS = [15, 30, 45, 60, 90, 120, 180];
  const SHORT_SECONDS = [4, 5, 6, 8, 10, 12, 15, 20, 30];
  const KIND_NAMES = { montage: "🎬 Монтаж", neuro: "🪄 Изменить видео", preset: "🧩 Пресет персонажа" };
  // ключ — только свой, не унаследованный (constructor, toString…): значения из хранилища и data-атрибутов чужие
  const has = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

  function newDraft(kind) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (kind === "montage") return { id, kind, sec: 60, clips: 1, opts: STANDARD.slice() };
    if (kind === "neuro") return { id, kind, mode: "redraw", sec: 10, q: "720p" };
    return { id, kind: "preset", style: "real" };
  }
  // черновик из хранилища — только известные значения (хранилище мог испортить кто угодно на этом устройстве);
  // черновики старых трендов партнёра (kind aivideo) больше не открываются — отбрасываются
  function cleanDraft(d) {
    if (!d || typeof d !== "object" || !has(KIND_NAMES, d.kind)) return null;
    const base = newDraft(d.kind);
    base.id = typeof d.id === "string" && /^[a-z0-9]{1,24}$/.test(d.id) ? d.id : base.id;
    base.updated = Number(d.updated) || Date.now();
    if (d.kind === "montage") {
      if (MONTAGE_SECONDS.includes(d.sec)) base.sec = d.sec;
      if (Number.isInteger(d.clips) && d.clips >= 1 && d.clips <= 10) base.clips = d.clips;
      if (Array.isArray(d.opts)) base.opts = STANDARD.filter((n) => d.opts.includes(n));
    } else if (d.kind === "neuro") {
      if (neuroModeOk(d.mode)) base.mode = d.mode;            // архивный режим — «Изменить образ» (redraw)
      if (SHORT_SECONDS.includes(d.sec)) base.sec = d.sec;
      if (QUALITIES.includes(d.q)) base.q = d.q;
    } else if (has(STYLE_CODES, d.style)) base.style = d.style;
    return base;
  }
  // свой заказ тренда/пресета/стиля/AI-видео (91, 92, 96): только номер, вид и тренд — чтобы вернуться к экрану заказа; 24 ч
  const ORDER_ID = /^[0-9a-f]{32}$/;
  const TREND_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const ORDER_TTL = 24 * 3600 * 1000;
  function cleanOrder(o) {
    if (!o || typeof o !== "object" || typeof o.id !== "string" || !ORDER_ID.test(o.id) || !["trend", "preset", "style", "aivideo"].includes(o.kind))
      return null;
    const at = Number(o.at);
    if (!(at > Date.now() - ORDER_TTL && at <= Date.now() + 60000)) return null;
    const payAt = Number(o.payAt);
    return { id: o.id, kind: o.kind, trend: typeof o.trend === "string" && TREND_ID.test(o.trend) ? o.trend : "",
      preset: o.preset === 1 ? 1 : 0, at,
      st: typeof o.st === "string" && /^[a-z_]{1,16}$/.test(o.st) ? o.st : "",
      payAt: payAt > 0 && payAt <= Date.now() + 60000 ? payAt : 0 };
  }
  // 97C доделка 2: клиент открыл оплату — 5 мин (или до смены статуса) «Изменить описание» и «Отменить» не показываем:
  // бот ещё не подтвердил оплату, отмена и новый заказ дали бы вторую оплату. Время — в записи заказа (localStorage)
  const PAY_WAIT = 5 * 60 * 1000;
  function payWaiting(id, d) {
    const m = myOrders.find((o) => o.id === id);
    return !!(m && m.payAt && d && d.status === "quoted" && Date.now() - m.payAt < PAY_WAIT);
  }
  function markPay(id, on = true) {
    const m = myOrders.find((o) => o.id === id);
    if (m) { m.payAt = on ? Date.now() : 0; persist(); }
  }
  // на главной — заказы, которые ещё идут или готовы (результат живёт 24 ч); отменённые и отказы — нет
  const SHOWN = new Set(["", "new", "picked", "quoted", "needs_consent", "paid", "working", "done"]);

  // --- хранилище этого устройства ---
  const storageKey = "montaggio-app-v1";
  let drafts = [], myOrders = [], trendsExpanded = true, storedAiv = null, storedLast = null;
  try {
    const s = JSON.parse(localStorage.getItem(storageKey) || "{}");
    drafts = (Array.isArray(s.drafts) ? s.drafts : []).map(cleanDraft).filter(Boolean).slice(0, 8);
    myOrders = (Array.isArray(s.orders) ? s.orders : []).map(cleanOrder).filter(Boolean).slice(0, 5);
    trendsExpanded = s.trendsExpanded !== false;
    storedAiv = s.aiv;                // черновик AI-видео (96C) — разбирает restoreAiv
    storedLast = s.aivLast;           // последнее оплаченное описание (97C) — тоже restoreAiv
  } catch {}
  let storageWarned = false;
  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ drafts, orders: myOrders, trendsExpanded, aiv: aivStored(), aivLast: packAiv(aivLast) }));
    } catch {
      if (!storageWarned) {
        storageWarned = true;
        toast("Браузер не разрешил сохранение — черновики пропадут после закрытия.");
      }
    }
  }
  let draft = null;              // открытый заказ (черновик) — сохраняется, пока не оформлен в боте
  function keepDraft() {
    if (!draft) return;
    draft.updated = Date.now();
    drafts = [draft, ...drafts.filter((d) => d.id !== draft.id)].slice(0, 8);
    persist();
  }
  function dropDraft(id) {
    drafts = drafts.filter((d) => d.id !== id);
    persist();
  }
  function rememberOrder(o) {
    myOrders = [o, ...myOrders.filter((x) => x.id !== o.id)].slice(0, 5);
    persist();
  }
  function forgetOrder(id) {
    myOrders = myOrders.filter((x) => x.id !== id);
    persist();
  }
  function toast(text) {
    const node = $("#toast");
    node.textContent = text;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 3200);
  }

  // --- сервер заказов (91): initData — только в заголовке, ответы — недоверенные данные ---
  const initData = () => (tg && typeof tg.initData === "string" ? tg.initData : "");
  class ApiError extends Error {
    constructor(status, body) {
      const msg = body && typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 600) : "";
      super(msg || T("errNet"));
      this.status = status;
      this.code = body && typeof body.error === "string" ? body.error : status ? "http_" + status : "network";
    }
  }
  async function api(path, { method = "GET", timeout = 10000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let r;
    try {
      r = await fetch(API + path, {
        method, headers: { "X-Telegram-Init-Data": initData() }, signal: ctl.signal,
        credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      });
    } catch {
      throw new ApiError(0, null);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) throw new ApiError(r.status, body);
    return body;
  }
  // заливка заказа с фото: XMLHttpRequest — ради полосы загрузки (fetch не умеет показывать отправку)
  function postOrder(form, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", API + "/api/orders");
      x.setRequestHeader("X-Telegram-Init-Data", initData());
      let bytes = 0;
      for (const v of form.values()) if (typeof v !== "string") bytes += v.size;
      x.timeout = 180000 + Math.ceil(bytes / (128 * 1024)) * 1000;     // 3 мин + 1 с на каждые 128 КБ
      x.upload.addEventListener("progress", (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); });
      x.addEventListener("load", () => {
        let body = null;
        try { body = JSON.parse(x.responseText); } catch {}
        if (x.status === 200 && body && ORDER_ID.test(body.order_id)) resolve(body.order_id);
        else reject(new ApiError(x.status, body));
      });
      // сеть оборвалась во время заливки — или nginx отказал по размеру (413 без CORS браузер показывает как обрыв)
      const fail = () => reject(new ApiError(0, form.has("photo[]") || form.has("video") ? { message: T("errUpload") } : null));
      x.addEventListener("error", fail);
      x.addEventListener("timeout", fail);
      x.send(form);
    });
  }

  // каталог трендов с сервера — только известные поля и проверенные значения
  let catalog = null, catalogState = "idle", catalogAt = 0;   // idle | loading | ok | down; down — повтор через 30 с
  const int = (v) => Number.isInteger(v) && v >= 0 && v <= 10000000 ? v : null;
  function cleanTrend(t) {
    if (!t || typeof t !== "object" || !TREND_ID.test(t.id)) return null;
    const str = (v) => typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : "";
    const titles = {};
    for (const l of ["ru", "en", "it"]) titles[l] = str(t.titles && t.titles[l]);
    const prices = {};
    for (const q of QUALITIES) {
      const p = t.prices && t.prices[q];
      if (p && int(p.rub) !== null && int(p.stars) !== null) prices[q] = { rub: p.rub, stars: p.stars };
    }
    if (!Object.keys(prices).length && int(t.price_rub) !== null && int(t.price_stars) !== null)
      prices["480p"] = { rub: t.price_rub, stars: t.price_stars };
    if (!Object.keys(prices).length) return null;
    const sec = Number(t.seconds);
    return { id: t.id, title: str(t.title) || t.id, titles, prices, seconds: sec > 0 && sec <= 600 ? Math.round(sec) : 0,
      single: !(t.prices && typeof t.prices === "object"), ask: cleanAsk(t.ask) };
  }
  const trendName = (t) => t.titles[LANG] || t.titles.ru || t.title;
  const trendById = (id) => (catalog || []).find((t) => t.id === id);
  const qualitiesOf = (t) => QUALITIES.filter((q) => t.prices[q]);
  function loadTrends() {
    if (catalogState === "loading") return;
    if (!inTelegram || !initData()) {           // без Telegram сервер не пустит — сразу «оформите в боте»
      catalogState = "down";
      render();
      return;
    }
    catalogState = "loading";
    api("/api/trends", { timeout: 5000 }).then((list) => {
      catalog = (Array.isArray(list) ? list : []).slice(0, 200).map(cleanTrend).filter(Boolean);
      catalogState = catalog.length ? "ok" : "down";
    }, () => { catalogState = "down"; }).finally(() => { catalogAt = Date.now(); render(); });
  }

  // --- стили: своя карусель и свой экран, отдельно от трендов. Каталог — GET /api/styles; превью — только с двух
  // адресов ниже (они же в CSP media-src/img-src) ---
  const STYLE_MEDIA = "https://static-public-media.higgsfield.ai/";
  const STYLE_CDN = "https://cdn.higgsfield.ai/";
  const STYLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const styleUrl = (u) => typeof u === "string" && u.length <= 1024 && (u.startsWith(STYLE_MEDIA) || u.startsWith(STYLE_CDN))
    && /^[A-Za-z0-9_\-./:%~]+$/.test(u) && !u.includes("..") ? u : "";
  let styles = null, stylesState = "idle", stylesAt = 0;      // idle | loading | ok | down; down — повтор через 30 с
  function cleanStyle(s) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !STYLE_ID.test(s.id)) return null;
    const titles = {};
    for (const l of ["ru", "en", "it"])
      titles[l] = s.titles && typeof s.titles[l] === "string" ? s.titles[l].trim().slice(0, 80) : "";
    if (!(titles.ru || titles.en || titles.it) && typeof s.title === "string") titles.en = s.title.trim().slice(0, 80);
    if (!(titles.ru || titles.en || titles.it)) return null;
    // превью и обложки может не быть (сервер отбросил чужой адрес — null): карточка с заглушкой
    return { id: s.id, titles, preview: styleUrl(s.preview_url), thumb: styleUrl(s.thumb_url) };
  }
  const styleName = (s) => s.titles[LANG] || s.titles.en || s.titles.ru || s.titles.it;
  const styleById = (id) => (styles || []).find((s) => s.id === id);
  function loadStyles() {
    if (stylesState === "loading") return;
    if (!inTelegram || !initData()) {
      stylesState = "down";
      render();
      return;
    }
    stylesState = "loading";
    api("/api/styles", { timeout: 5000 }).then((list) => {
      styles = (Array.isArray(list) ? list : []).slice(0, 60).map(cleanStyle).filter(Boolean);
      stylesState = styles.length ? "ok" : "down";
    }, () => { stylesState = "down"; }).finally(() => { stylesAt = Date.now(); render(); });
  }

  // --- маршруты ---
  // # без «/» — параметры запуска Telegram (#tgWebAppData=…), не маршрут: главная. Пока скрипт Telegram их не прочёл
  // (tgSettled), маршрут живёт в памяти (memRoute), а # не трогаем — иначе скрипт не узнает initData и версию
  let tgSettled = !START_HASH, memRoute = null;
  const route = () => memRoute !== null ? memRoute
    : location.hash.startsWith("#/") ? location.hash.slice(2).split(/[&?]/)[0] || "home" : "home";
  // 96C: «Персонаж» (код w1-p в бота) заменён экраном «Свой персонаж» в приложении — #/preset (старые адреса тоже)
  const FLOW = { "edit/montage": "montage", "edit/neuro": "neuro" };
  function nav(to) {
    closeModal();
    if (!tgSettled) {
      memRoute = to;
      render();
    } else {
      const same = route() === to;
      location.hash = "/" + to;
      if (same) render();
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function settleTelegram() {
    if (tgSettled) return;
    tgSettled = true;
    if (memRoute !== null) {
      const to = memRoute;
      memRoute = null;
      location.hash = "/" + to;
    } else if (/^#\/[^&?]*[&?]/.test(location.hash))      // «#/trends&tgWebAppData=…» — адрес без параметров запуска
      history.replaceState(null, "", location.pathname + location.search + "#/" + route());
  }
  function parentOf(r) {
    if (r.startsWith("trend/")) return "trends";
    if (r.startsWith("who/")) return "trend/" + r.slice(4);
    if (r.startsWith("style/")) return "styles";
    if (r === "preset-new") return presetReturn ? "who/" + presetReturn : "create";
    if (r === "preset" || r.startsWith("create/")) return "create";
    if (r.startsWith("order/")) return "trends";
    if (r.startsWith("edit/")) return "edit";
    if (r === "drafts") return "profile";
    return "home";
  }
  function back() {
    if (closeModal()) return;
    nav(parentOf(route()));
  }
  function openDraft(d) {
    if (d.kind === "preset") {       // старый черновик пресета (код в бота) — теперь экран «Свой персонаж» с его стилем
      presetStyle = d.style;
      presetReturn = "";
      dropDraft(d.id);
      return void nav("preset");
    }
    draft = d;
    nav("edit/" + d.kind);
  }

  // --- куски экранов ---
  const pageTop = (title, sub = "") =>
    `<div class="page-top"><div><h1>${title}</h1>${sub ? `<p class="page-subtitle">${sub}</p>` : ""}</div></div>`;
  const pageTopEl = (title, sub = "") =>
    el("div", { class: "page-top" }, el("div", {}, el("h1", { text: title }), sub ? el("p", { class: "page-subtitle", text: sub }) : null));
  function navBar() {
    const r = route();
    const labels = T("nav");
    $("#nav").innerHTML = [
      ["home", "home"], ["trends", "spark"], ["edit", "sliders"], ["create", "plus"], ["profile", "user"],
    ].map(([to, ic], i) => {
      const fromTrend = r === "preset-new" && !!presetReturn;      // «Сделать пресет» из тренда — это ещё тренды
      const on = r === to || r.startsWith(to + "/") || (to === "trends" && (/^(trend|who|order)\//.test(r) || fromTrend))
        || (to === "profile" && r === "drafts") || (to === "edit" && /^styles$|^style\//.test(r))
        || (to === "create" && (r === "preset" || (r === "preset-new" && !fromTrend)));
      return `<a href="#/${to}" class="nav-item ${on ? "current" : ""}" ${r === to ? 'aria-current="page"' : ""}>${icon(ic)}<span>${esc(labels[i])}</span></a>`;
    }).join("");
  }
  function draftTitle(d) {
    return (T("kinds")[d.kind] || KIND_NAMES[d.kind]).replace(/^\S+\s/, "");
  }
  function draftLine(d) {
    if (d.kind === "montage") return T("draftMontage", { n: d.clips, t: secText(d.sec) });
    if (d.kind === "neuro") return `${T("modes")[d.mode][0]} · ${T("sec", { n: d.sec })} · ${d.q}`;
    return PRESET_STYLES.find((s) => s[0] === d.style)[1];
  }
  const draftCard = (d) =>
    `<button class="continue-card" data-action="resume" data-id="${d.id}"><span class="continue-icon">${icon(d.kind === "preset" ? "user" : "video")}</span><span><strong>${esc(draftTitle(d))}</strong><small>${esc(draftLine(d))} · ${esc(T("draftTag"))}</small></span>${icon("arrow")}</button>`;
  function continueCards() {
    if (!drafts.length) return "";
    return `<section class="continue-section" aria-label="${esc(T("draftsTitle"))}"><div class="section-heading"><h2>${esc(T("contTitle"))}</h2><span class="saved-label">${icon("check")}${esc(T("savedHere"))}</span></div><div class="draft-list">${drafts.slice(0, 3).map(draftCard).join("")}</div></section>`;
  }
  const secText = (s) => { const [a, b, c] = T("dur"); return (s < 60 ? a : s % 60 ? c : b).replace("{s}", s % 60 || s).replace("{m}", Math.floor(s / 60)); };

  // --- тренды (91): карточки с готовым видео, ролики — со своего адреса по id ---
  const media = (id, kind) => `trends/${encodeURIComponent(id)}/${kind}`;
  const REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // ролик с обложкой: картинка видна всегда, ролик проявляется только когда реально заиграл (событие playing) —
  // не заиграл (iOS, кодек, экономия трафика) — остаётся обложка, а не пустая карточка. Без crossorigin
  function videoEl(id, kind, { controls = false, lazy = true } = {}) {
    return liveVideo(media(id, kind + ".mp4"), T("result"), { controls, lazy });
  }
  function liveVideo(src, label, { controls = false, lazy = true, fallback = "" } = {}) {
    const v = el("video", { class: "tvideo" + (REDUCED ? " live" : ""), preload: lazy ? "none" : "metadata",
      playsinline: true, "webkit-playsinline": true, autoplay: !REDUCED, loop: true, disablepictureinpicture: true,
      controls: controls || REDUCED, "aria-label": label });
    v.muted = true;
    v.defaultMuted = true;
    v.dataset.src = src;
    if (fallback) v.dataset.fallback = fallback;
    v.dataset.auto = REDUCED ? "0" : "1";
    v.addEventListener("playing", () => v.classList.add("live"));
    return v;
  }
  const coverEl = (src, lazy = true, fallback = "") => {
    const img = el("img", { class: "tcover", src, alt: "", loading: lazy ? "lazy" : null, decoding: "async" });
    if (fallback) img.dataset.fallback = fallback;
    return img;
  };
  function priceFrom(t) {
    const p = t.prices[qualitiesOf(t)[0]];
    return T("from", { p: money(p.rub, p.stars) });
  }
  function trendCard(t, size) {
    return el("article", { class: `tcard ${size}` },
      el("button", { class: "tcard-open", type: "button", data: { action: "trend", id: t.id }, "aria-label": trendName(t) },
        el("span", { class: "tmedia" }, coverEl(media(t.id, "result.webp")), videoEl(t.id, "result"),
          t.seconds ? el("span", { class: "duration", icon: "play" }, T("sec", { n: t.seconds })) : null),
        el("h3", { text: trendName(t) }),
        el("span", { class: "tprice", text: priceFrom(t) })));
  }
  function trendsState(compact) {
    if (catalogState === "ok") return null;
    if (catalogState === "down")       // трендов нет (пусто или сервер недоступен) — «Свой сюжет» всё равно есть (96C)
      return el("div", {}, el("div", { class: "trends-down" + (compact ? " compact" : "") },
        el("div", {}, el("h3", { text: T("downTitle") }), el("p", { text: T("downText") })),
        btn(T("openBot"), "open-bot", "secondary small", {}, "send")),
      AIVIDEO_ON ? ownStoryButton() : null);
    return el("div", { class: "trends-loading", role: "status" }, el("span", { class: "spinner" }), T("loading"));
  }
  function carousel(size) {
    return el("div", { class: `tcarousel ${size}`, "aria-label": T("trends") }, catalog.map((t) => trendCard(t, size)),
      AIVIDEO_ON ? ownStoryCard(size) : null);
  }
  const ownStoryButton = () => {
    const [title, sub] = T("ownStory");
    return btn(`${title} — ${sub.charAt(0).toLowerCase()}${sub.slice(1)}`, "nav", "secondary full own-story-button", { to: "create/video" });
  };
  // 96C: в конце карусели трендов — «✍️ Свой сюжет» → экран «Создать видео» (AI-видео по описанию)
  function ownStoryCard(size) {
    const [title, sub] = T("ownStory");
    return el("article", { class: `tcard ${size} own-story` },
      el("button", { class: "tcard-open", type: "button", data: { action: "nav", to: "create/video" }, "aria-label": `${title}. ${sub}` },
        el("span", { class: "tmedia" }, el("span", { class: "own-story-body" }, el("span", { class: "own-story-mark", icon: "plus" }),
          el("small", { text: sub }))),
        el("h3", { text: title })));
  }
  function homeTrends() {
    const state = trendsState(true);
    if (state) return state;
    return el("div", {}, carousel("small"),
      el("div", { class: "carousel-footer" }, el("span", { text: T("trendsHint") }),
        btn(T("allTrends"), "nav", "secondary small", { to: "trends" }, "arrow")), suggestTrend());
  }
  // 93C: «Предложить свой тренд» — в поддержку бота, глубокая ссылка ?start=trend (бот ведёт дальше сам)
  const suggestTrend = () => el("div", { class: "suggest-trend" }, el("p", { text: T("suggestText") }),
    btn(T("suggestBtn"), "suggest-trend", "secondary full"));
  function homeOrders() {
    const list = myOrders.filter((o) => SHOWN.has(o.st || "")).slice(0, 2);
    if (!list.length) return null;
    return el("section", { class: "continue-section", "aria-label": T("myOrders") },
      el("div", { class: "section-heading" }, el("h2", { text: T("myOrders") })),
      el("div", { class: "draft-list" }, list.map((o) => {
        const t = trendById(o.trend);
        const st = o.kind === "style" ? styleById(o.trend) : null;
        const name = o.kind === "preset" ? T("orderPreset") : o.kind === "style" ? T("orderStyle", { t: st ? styleName(st) : "…" })
          : o.kind === "aivideo" ? T("orderAiv") : T("orderTrend", { t: t ? trendName(t) : "…" });
        const ic = { preset: "user", style: "layers", aivideo: "video" }[o.kind] || "spark";
        return el("button", { class: "continue-card", type: "button", data: { action: "nav", to: "order/" + o.id } },
          el("span", { class: "continue-icon", icon: ic }),
          el("span", {}, el("strong", { text: name }), el("small", { text: "№ " + o.id.slice(0, 6) + " · " + T("orderOpen") })),
          el("span", { icon: "arrow", class: "continue-arrow" }));
      })));
  }
  // карусель стилей — своя, отдельно от трендов (владелец 13.10)
  function styleCard(s, size) {
    const p = stylePrice5();
    return el("article", { class: `tcard ${size}` },
      el("button", { class: "tcard-open", type: "button", data: { action: "style", id: s.id }, "aria-label": styleName(s) },
        styleMedia(s),
        el("h3", { text: styleName(s) }),
        p ? el("span", { class: "tprice", text: T("styleFrom", { p: rub(p) }) }) : null));
  }
  function stylesStateEl(compact) {
    if (stylesState === "ok") return null;
    if (stylesState === "down")
      return el("div", { class: "trends-down" + (compact ? " compact" : "") },
        el("div", {}, el("h3", { text: T("stylesDown") }), el("p", { text: T("downText") })),
        btn(T("openBot"), "open-bot", "secondary small", {}, "send"));
    return el("div", { class: "trends-loading", role: "status" }, el("span", { class: "spinner" }), T("loading"));
  }
  const styleCarousel = (size) =>
    el("div", { class: `tcarousel styles ${size}`, "aria-label": T("styles") }, styles.map((s) => styleCard(s, size)));
  function homeStyles() {
    const state = stylesStateEl(true);
    if (state) return state;
    return el("div", {}, styleCarousel("small"),
      el("div", { class: "carousel-footer" }, el("span", { text: T("stylesSub") }),
        btn(T("allStyles"), "nav", "secondary small", { to: "styles" }, "arrow")));
  }
  function stylesPage() {
    return el("div", {}, el("div", { class: "page-head" }, el("div", {}, el("h1", { text: T("styles") }), el("p", { text: T("stylesSub") }))),
      stylesStateEl(false) || styleCarousel("large"));
  }
  function trendsPage() {
    return el("div", {}, el("div", { class: "page-head" }, el("div", {}, el("h1", { text: T("trends") }), el("p", { text: T("trendsSub") }))),
      trendsState(false) || carousel("large"), suggestTrend());
  }
  // выбранное качество — по тренду, пока открыт этот тренд
  let pick = { trend: "", q: "480p" };
  function qualityOf(t) {
    if (pick.trend !== t.id || !t.prices[pick.q]) pick = { trend: t.id, q: qualitiesOf(t)[0] };
    return pick.q;
  }
  function trendPage(t) {
    const q = qualityOf(t), p = t.prices[q];
    // образец — готовый ролик автора тренда (TRENDS.md), со звуком: автоплей без звука (со звуком браузер не даст),
    // 🔊 — касанием
    const pair = el("figure", { class: "sample" }, el("span", { class: "tmedia" },
      coverEl(media(t.id, "result.webp"), false), videoEl(t.id, "result", { lazy: false }),
      el("button", { class: "sound-toggle", type: "button", data: { action: "sound" }, "aria-pressed": "false",
        "aria-label": T("soundOn"), icon: "mute" })));
    const qs = qualitiesOf(t);
    const qRow = t.single ? null : el("div", { class: "field" }, el("span", { class: "field-label", text: T("quality") }),
      el("div", { class: "q-row" }, qs.map((k) => el("button", {
        class: "q-choice" + (k === q ? " selected" : ""), type: "button", "aria-pressed": String(k === q),
        data: { action: "quality", value: k },
      }, el("strong", { text: T("q")[k] }), el("small", { text: money(t.prices[k].rub, t.prices[k].stars) })))));
    return el("div", { class: "trend-page" }, pageTopEl(trendName(t), t.seconds ? T("sec", { n: t.seconds }) : ""), pair, qRow,
      el("div", { class: "workflow-actions" },
        btn(`${T("repeat")} · ${money(p.rub, p.stars)}`, "nav", "primary full", { to: "who/" + t.id }, "spark")));
  }
  function summaryLine(t) {
    const q = qualityOf(t), p = t.prices[q];
    return [trendName(t), t.single ? "" : T("q")[q], money(p.rub, p.stars)].filter(Boolean).join(" · ");
  }
  let presetReturn = "";              // тренд, к которому вернуться после пресета
  let presetPick = "";                // вернулись к тренду с готовым пресетом — сразу «Мой пресет»
  let presetStyle = "real";           // 96C: стиль листа на экране «Свой персонаж» (preset_style)
  const charPath = () => route() === "preset";      // «Свой персонаж» из вкладки «Создать», не «Сделать пресет» из тренда

  // --- что просим у клиента (91, TRENDS.md): блоки ask из каталога, по порядку героев в промпте тренда ---
  const KINDS = new Set(["face", "body", "product", "car", "item"]);
  const loc = (o) => (o && (o[LANG] || o.ru || o.en || o.it)) || "";
  function cleanAsk(list) {
    if (!Array.isArray(list) || !list.length || list.length > 12) return null;
    const langs = (o, n) => {
      if (!o || typeof o !== "object") return null;
      const r = {};
      for (const l of ["ru", "en", "it"]) if (typeof o[l] === "string" && o[l].trim()) r[l] = o[l].trim().slice(0, n);
      return Object.keys(r).length ? r : null;
    };
    const out = [], keys = new Set();
    for (const b of list) {            // один неверный блок — весь список не наш: берём простой «ваше лицо»
      if (!b || typeof b !== "object" || typeof b.key !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(b.key)
        || keys.has(b.key) || !KINDS.has(b.kind)) return null;
      const min = Number.isInteger(b.min) ? b.min : 0, max = Number.isInteger(b.max) ? b.max : 1;
      const labels = langs(b.labels, 80);
      if (min < 0 || max < 1 || max > 8 || min > max || !labels) return null;
      keys.add(b.key);
      out.push({ key: b.key, kind: b.kind, preset: b.preset === true && !out.some((x) => x.preset), min, max, labels,
        hint: langs(b.hint, 300), group: langs(b.group, 80) });
    }
    return out;
  }
  const one = (text) => ({ [LANG]: text });
  function askFor(t) {
    if (!t) return [{ key: "P", kind: "face", preset: false, min: 1, max: 3, labels: one(T(charPath() ? "charPhotos" : "presetPhotos")),
      hint: one(T("presetHint")), group: null }];
    return t.ask || [{ key: "P1", kind: "face", preset: true, min: 1, max: 8, labels: one(T("yourFace")),
      hint: one(T("photosHint")), group: null }];
  }
  // галочки «На фото — я» нет ни у тренда, ни у пресета (владелец 12.10): согласие клиента — общее в боте, бот face_ok
  // не проверяет; приложение шлёт face_ok=1. Подсказка про чужие фото без согласия — в hint блоков

  // --- фото клиента (91): только в памяти до отправки, превью — blob:, после — revokeObjectURL ---
  const PHOTO_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;
  const MB = 1024 * 1024;
  const MAX_PHOTOS = 8;                // всего в заказе (контракт API)
  // video, prompt — только у экрана стиля (92C): видео клиента и его подсказка, тоже лишь в памяти до отправки
  const freshPhotos = () => ({ key: "", blocks: {}, preset: false, groupOpen: false, video: null, prompt: "" });
  let photos = freshPhotos();
  const listOf = (k) => photos.blocks[k] || (photos.blocks[k] = []);
  const allPhotos = () => Object.values(photos.blocks).flat();
  const usesPreset = (b) => b.preset && photos.preset;
  const countOf = (b) => usesPreset(b) ? 0 : listOf(b.key).length;
  function clearPhotos() {
    allPhotos().forEach((p) => p.url && URL.revokeObjectURL(p.url));
    if (photos.video) URL.revokeObjectURL(photos.video.url);
    photos = freshPhotos();
  }
  function dropBlock(k) {
    listOf(k).forEach((p) => p.url && URL.revokeObjectURL(p.url));
    photos.blocks[k] = [];
  }
  // чего не хватает до «Дальше» — текст ошибки; всё есть — ""
  function missing(ask) {
    for (const b of ask)
      if (b.min > 0 && !usesPreset(b) && countOf(b) < b.min) return T("errMin", { label: loc(b.labels) });
    if (!ask.some((b) => usesPreset(b) || countOf(b) > 0)) return T("errNeed");
    return "";
  }
  function addPhotos(b, files) {
    const err = [];
    for (const f of files) {
      // пустой тип (бывает на Android) — по расширению; содержимое всё равно проверяет сервер по магическим байтам
      const byName = !f.type && /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || "");
      if (!PHOTO_TYPES.test(f.type) && !byName) { err.push(T("errType", { name: f.name || "?" })); continue; }
      if (f.size > 10 * MB) { err.push(T("errSize", { name: f.name || "?" })); continue; }
      if (listOf(b.key).length >= b.max) { err.push(T("errCount", { n: b.max })); break; }
      if (allPhotos().length >= MAX_PHOTOS) { err.push(T("errCount", { n: MAX_PHOTOS })); break; }
      if (allPhotos().reduce((s, p) => s + p.file.size, 0) + f.size > 40 * MB) { err.push(T("errTotal")); break; }
      if (photos.video && styleBytes() + f.size > STYLE_BODY) { err.push(T("errTotalAll")); break; }
      const preview = /^image\/(jpeg|png|webp)$/.test(f.type);
      listOf(b.key).push({ file: f, url: preview ? URL.createObjectURL(f) : "", key: Math.random().toString(36).slice(2) });
    }
    render();
    if (err.length) showError(err.join(" "));
  }
  function showError(text) {
    const box = $("#flow-error");
    if (box) box.textContent = text;
    else toast(text);
  }
  // превью фото: numbered — подпись «Фото 1, 2…» (96C: AI-видео и «Свой персонаж»)
  function thumbEl(p, i, action, numbered) {
    return el("div", { class: "photo-thumb" },
      p.url ? el("img", { src: p.url, alt: "" }) : el("span", { class: "photo-noprev", icon: "camera" }),
      numbered ? el("span", { class: "photo-num", text: T("photoN", { n: i + 1 }) }) : null,
      el("button", { class: "photo-remove", type: "button", data: { action, key: p.key },
        "aria-label": `${T("removePhoto")} ${i + 1}`, icon: "x" }));
  }
  const addTile = (id) => el("label", { class: "photo-add", for: id }, el("span", { icon: "plus" }), el("small", { text: T("addPhoto") }));
  function blockEl(b, t) {
    const preset = !!t && b.preset, list = listOf(b.key), byPreset = usesPreset(b);
    const id = "photo-input-" + b.key;
    const parts = [el("div", { class: "ask-head" }, el("h3", { text: loc(b.labels) }),
      byPreset ? null : el("span", { class: "ask-count", text: `${list.length} / ${b.max}` }))];
    if (b.hint) parts.push(el("p", { class: "photo-hint", text: loc(b.hint) }));
    if (preset)                      // «Мой пресет» — только у блока клиента (preset: true)
      parts.push(el("div", { class: "q-row two" },
        el("button", { class: "q-choice" + (byPreset ? " selected" : ""), type: "button", "aria-pressed": String(byPreset),
          data: { action: "ask-mode", value: "preset" } }, el("strong", { text: T("optPreset") }), el("small", { text: T("optPresetTag") })),
        el("button", { class: "q-choice" + (byPreset ? "" : " selected"), type: "button", "aria-pressed": String(!byPreset),
          data: { action: "ask-mode", value: "photos" } }, el("strong", { text: T("optPhotos") }),
          el("small", { text: `${b.min || 1}–${b.max}` }))));
    if (byPreset)
      parts.push(el("p", { class: "ask-note", text: T("presetUse") }),
        el("button", { class: "text-button", type: "button", data: { action: "make-preset", id: t.id } }, T("noPreset")));
    else
      parts.push(el("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/heic,image/heif",
        multiple: b.max > 1, class: "visually-hidden", id, onchange: (e) => { addPhotos(b, [...e.target.files]); e.target.value = ""; } }),
      el("div", { class: "photo-grid" }, list.map((p, i) => thumbEl(p, i, "photo-remove", !t && charPath())),
        list.length < b.max ? addTile(id) : null));
    return el("section", { class: "ask-block" + (b.group ? " item" : "") }, parts);
  }
  // 94C: «Ваши пожелания» к тренду — необязательно, ≤ 300 знаков; текст уходит полем prompt, бот проверяет его после
  // оплаты и переводит (не учёл — ролик по тренду и сообщение клиенту). Ввод без перерисовки экрана — фокус не теряется
  const WISH_MAX = 300;
  function wishBlock() {
    const area = el("textarea", { id: "trend-wish", maxlength: String(WISH_MAX), rows: "3", placeholder: T("wishPh"),
      oninput: (e) => {
        photos.prompt = e.target.value.slice(0, WISH_MAX);
        const c = $("#wish-count");
        if (c) c.textContent = `${photos.prompt.length} / ${WISH_MAX}`;
      } });
    area.value = photos.prompt;
    return el("section", { class: "ask-block wish-block" },
      el("div", { class: "ask-head" }, el("h3", { text: T("wishLabel") }),
        el("span", { class: "ask-count", id: "wish-count", text: `${photos.prompt.length} / ${WISH_MAX}` })),
      el("p", { class: "photo-hint", text: T("wishHint") }), area);
  }
  // экран «Фото для ролика» (тренд) и «Новый пресет» (t = null)
  function askPage(t) {
    const key = t ? "trend:" + t.id : "preset";
    if (photos.key !== key) {
      clearPhotos();
      photos.key = key;
      if (t && presetPick === t.id) photos.preset = true;
      presetPick = "";
    }
    const ask = askFor(t);
    const plain = ask.filter((b) => !b.group), grouped = ask.filter((b) => b.group);
    let group = null;
    if (grouped.length) {
      const open = photos.groupOpen || grouped.some((b) => listOf(b.key).length);
      group = el("details", { class: "ask-group", open, ontoggle: (e) => { photos.groupOpen = e.target.open; } },
        el("summary", { text: loc(grouped[0].group) }), grouped.map((b) => blockEl(b, t)));
    }
    // 96C: «Свой персонаж» из вкладки «Создать» (#/preset) — тот же заказ пресета, плюс стиль листа и цена
    const char = !t && charPath(), price = char && LANG === "ru" && P ? presetPrice() : null;
    const send = btn(t ? T("next") : char ? T("charBtn") + (price ? ` · ≈ ${rub(price)}` : "") : T("send"), "send-photos",
      "primary full", {}, t ? "arrow" : char ? "spark" : "send");
    send.id = "send-photos";
    const charParts = char ? [
      el("div", { class: "field" }, el("span", { class: "field-label", text: T("charStyle") }),
        el("div", { class: "choice-row" }, PRESET_STYLES.map(([v]) => el("button", { class: "choice" + (v === presetStyle ? " selected" : ""),
          type: "button", "aria-pressed": String(v === presetStyle), data: { action: "preset-style", value: v } }, T("styleNames")[v])))),
      price ? el("div", { class: "price-card" }, el("span", { text: T("charName") }), el("strong", { text: "≈ " + rub(price) }),
        el("small", { text: T("aivNote") })) : null] : [];
    const node = el("div", { class: "photo-page" },
      pageTopEl(t ? T("askTitle") : char ? T("charTitle") : T("presetTitle"), t ? summaryLine(t) : char ? T("charSub") : T("presetSub")),
      plain.map((b) => blockEl(b, t)), group, t ? wishBlock() : null, charParts,
      el("div", { class: "upload-bar", id: "upload-bar", hidden: true }, el("span", { class: "upload-fill" })),
      el("div", { id: "flow-error", class: "form-error", role: "alert" }),
      el("div", { class: "workflow-actions" }, send));
    queueMicrotask(updateSend);
    return node;
  }
  let sending = false;
  function updateSend() {
    const b = $("#send-photos"), r = route();
    if (!b) return;
    if (r.startsWith("style/")) return void (b.disabled = sending || !!styleMissing());
    if (r === "create/video") {
      // идёт заливка — фото не добавить (в неё они уже не попадут)
      const input = $("#aiv-photo-input"), add = document.querySelector(".aiv-page .photo-add");
      if (input) input.disabled = sending;
      if (add) add.setAttribute("aria-disabled", String(sending));
      return void (b.disabled = sending || !aiv.desc.trim());
    }
    const t = r.startsWith("who/") ? trendById(r.slice(4)) : null;
    b.disabled = sending || !!missing(askFor(t));
  }
  // заказ: photo[] — строго по порядку блоков, counts — сколько фото в каждом блоке («Мой пресет» = 0)
  async function sendOrder(t) {
    if (sending) return;
    const ask = askFor(t);
    const miss = missing(ask);
    if (miss) return showError(miss);
    const usePreset = !!t && ask.some(usesPreset);
    const form = new FormData();
    form.append("type", t ? "trend" : "preset");
    if (t) {
      form.append("trend_id", t.id);
      form.append("quality", qualityOf(t));
    }
    form.append("use_preset", usePreset ? "1" : "0");
    form.append("face_ok", "1");
    form.append("lang", LANG);
    // 96C: стиль листа — только с экрана «Свой персонаж» и не «Реализм» (нет поля — реализм, как раньше)
    if (!t && charPath() && has(STYLE_CODES, presetStyle) && presetStyle !== "real") form.append("preset_style", presetStyle);
    if (t && t.ask) form.append("counts", ask.map(countOf).join(","));
    const wish = t ? photos.prompt.trim().slice(0, WISH_MAX) : "";
    if (wish) form.append("prompt", wish);            // 94C: пожелание клиента — недоверенный текст, проверяет бот
    let n = 0;
    for (const b of ask) if (!usesPreset(b)) listOf(b.key).forEach((p) => form.append("photo[]", p.file, `photo${++n}`));
    await submit(form, n > 0, { kind: t ? "trend" : "preset", trend: t ? t.id : charPath() ? "" : presetReturn,
      preset: usePreset ? 1 : 0 });
  }
  // отправка заказа с полосой загрузки; удалось — фото и видео стираются из памяти, экран заказа
  async function submit(form, files, meta) {
    sending = true;
    updateSend();
    const bar = $("#upload-bar"), fill = bar && bar.firstChild, sendBtn = $("#send-photos");
    const label = sendBtn ? sendBtn.lastChild.textContent : "";
    if (bar) bar.hidden = !files;
    showError("");
    try {
      const id = await postOrder(form, (f) => {
        if (fill) fill.style.width = Math.round(f * 100) + "%";
        if (sendBtn && files) sendBtn.lastChild.textContent = T("sending", { p: Math.round(f * 100) });
      });
      clearPhotos();
      rememberOrder({ id, ...meta, at: Date.now() });
      sending = false;
      nav("order/" + id);
      return id;
    } catch (e) {
      sending = false;
      if (bar) bar.hidden = true;
      if (sendBtn) sendBtn.lastChild.textContent = label;
      updateSend();
      showError(e.message);
    }
  }

  // --- заказ стиля (92C): видео клиента 4–30 с (≤ 100 МБ), 0–5 фото, подсказка ≤ 500, качество → сервер → цена бота ---
  const VIDEO_TYPES = /^video\/(mp4|quicktime|webm)$/;
  const VIDEO_MAX = 100 * MB;
  const STYLE_BODY = 105 * MB;          // всё тело заказа: nginx пускает 110 МБ
  const styleBytes = () => (photos.video ? photos.video.file.size : 0) + allPhotos().reduce((s, p) => s + p.file.size, 0);
  // длина — по метаданным файла в браузере; не прочиталась (кодек, браузер) — бот проверит после загрузки
  function videoLength(url) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      let done = false;
      const end = (d) => {
        if (done) return;
        done = true;
        v.removeAttribute("src");
        v.load();
        resolve(d);
      };
      v.preload = "metadata";
      v.muted = true;
      v.addEventListener("loadedmetadata", () => end(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null));
      v.addEventListener("error", () => end(null));
      setTimeout(() => end(null), 8000);
      v.src = url;
    });
  }
  async function pickVideo(f) {
    if (!f || sending) return;
    const byName = !f.type && /\.(mp4|mov|webm)$/i.test(f.name || "");
    if (!VIDEO_TYPES.test(f.type) && !byName) return showError(T("videoType", { name: f.name || "?" }));
    if (f.size > VIDEO_MAX) return showError(T("videoBig"));
    if (f.size + allPhotos().reduce((s, p) => s + p.file.size, 0) > STYLE_BODY) return showError(T("errTotalAll"));
    const key = photos.key;
    if (photos.video) URL.revokeObjectURL(photos.video.url);
    const url = URL.createObjectURL(f);
    photos.video = { file: f, url, dur: undefined };          // undefined — длину ещё читаем
    render();
    const dur = await videoLength(url);
    if (photos.key !== key || !photos.video || photos.video.url !== url) return;
    photos.video.dur = dur;
    render();
  }
  const num = (x) => { const s = (Math.round(x * 10) / 10).toString(); return LANG === "en" ? s : s.replace(".", ","); };
  const secs = (d) => num(d);
  // чего не хватает до «Дальше»: текст ошибки; " " — ждём длину видео; всё есть — ""
  function styleMissing() {
    const v = photos.video;
    if (!v) return T("videoNeed");
    if (v.dur === undefined) return " ";
    if (v.dur !== null && v.dur < 4) return T("videoShort", { n: secs(v.dur) });
    return "";
  }
  // оценка цены — те же формулы, что у бота (за секунду видео): только ru, со знаком «≈»; точную считает бот
  const billSec = (d) => Math.max(P ? P.neuro.min_billable_sec : 4, Math.ceil(Math.min(d, 30) - 0.01));
  function styleEstimate(q) {
    const v = photos.video;
    if (LANG !== "ru" || !P || !v || !v.dur || v.dur < 4) return null;
    return neuroPrice(Math.min(v.dur, 30), q, "replace");
  }
  const stylePrice5 = () => LANG === "ru" && P ? neuroPrice(5, "480p", "replace") : null;
  // превью стиля: своё, как у трендов (95: tools/app_styles.py → styles/<uuid>/cover.webp и, если превью у Higgsfield —
  // ролик, preview.mp4). Своего файла нет (новый стиль, ещё не скачан) — один раз адрес каталога (обработчик error);
  // картинку в <video> не кладём (на iPhone карточка оставалась пустой); ролик — поверх обложки, когда заиграл
  const isVideoUrl = (u) => /\.(mp4|webm|mov)(\?|$)/i.test(u);
  function styleMedia(s, lazy = true) {
    const own = `styles/${encodeURIComponent(s.id)}/`;
    const image = [s.thumb, s.preview].find((u) => u && !isVideoUrl(u)) || "";
    const parts = [coverEl(own + "cover.webp", lazy, image)];
    if (s.preview && isVideoUrl(s.preview))
      parts.push(liveVideo(own + "preview.mp4", styleName(s), { lazy, fallback: s.preview }));
    return el("span", { class: "tmedia" }, parts);
  }
  let styleQ = "480p";
  function stylePage(s) {
    const key = "style:" + s.id;
    if (photos.key !== key) {
      clearPhotos();
      photos.key = key;
      styleQ = "480p";
    }
    const v = photos.video;
    const vparts = [el("div", { class: "ask-head" }, el("h3", { text: T("yourVideo") })),
      el("p", { class: "photo-hint", text: T("videoHint") }),
      el("input", { type: "file", accept: "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm", class: "visually-hidden",
        id: "video-input", onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; pickVideo(f); } })];
    if (v) {
      const pv = el("video", { class: "client-video", src: v.url, controls: true, playsinline: true, preload: "metadata" });
      pv.muted = true;
      const short = v.dur && v.dur < 4;
      const info = v.dur === undefined ? "…" : v.dur === null ? T("videoUnknown") : short ? T("videoShort", { n: secs(v.dur) })
        : v.dur > 30 ? T("videoLong", { n: secs(v.dur) }) : T("videoLen", { n: secs(v.dur), mb: num(v.file.size / MB) });
      vparts.push(pv, el("p", { class: "ask-note" + (short ? " bad" : ""), text: info }),
        el("div", { class: "video-actions" },
          el("label", { class: "button secondary small", for: "video-input" }, T("changeVideo")),
          btn(T("removeVideo"), "video-remove", "ghost small")));
    } else
      vparts.push(el("label", { class: "photo-add video-add", for: "video-input" }, el("span", { icon: "video" }),
        el("small", { text: T("addVideo") })));
    const refs = { key: "IMG", kind: "item", preset: false, min: 0, max: 5, labels: one(T("styleRefs")),
      hint: one(T("styleRefsHint")), group: null };
    const prompt = el("textarea", { id: "style-prompt", maxlength: "500", rows: "3", placeholder: T("promptPh"),
      oninput: (e) => {
        photos.prompt = e.target.value.slice(0, 500);
        const c = $("#prompt-count");
        if (c) c.textContent = `${photos.prompt.length} / 500`;
      } });
    prompt.value = photos.prompt;
    const qRow = el("div", { class: "q-row" }, QUALITIES.map((k) => {
      const p = styleEstimate(k);
      return el("button", { class: "q-choice" + (k === styleQ ? " selected" : ""), type: "button",
        "aria-pressed": String(k === styleQ), data: { action: "style-q", value: k } },
      el("strong", { text: T("q")[k] }), p ? el("small", { text: "≈ " + rub(p) }) : null);
    }));
    const est = styleEstimate(styleQ);
    const send = btn(T("next") + (est ? ` · ≈ ${rub(est)}` : ""), "send-style", "primary full", { id: s.id }, "arrow");
    send.id = "send-photos";
    queueMicrotask(updateSend);
    return el("div", { class: "photo-page style-page" }, pageTopEl(styleName(s), T("stylesHint")),
      el("figure", { class: "sample style-sample" }, styleMedia(s, false)),
      el("section", { class: "ask-block" }, vparts), blockEl(refs, null),
      el("section", { class: "ask-block" }, el("div", { class: "ask-head" }, el("h3", { text: T("promptLabel") }),
        el("span", { class: "ask-count", id: "prompt-count", text: `${photos.prompt.length} / 500` })), prompt),
      el("div", { class: "field" }, el("span", { class: "field-label", text: T("quality") }), qRow),
      est ? el("p", { class: "ask-note", text: T("estimate", { p: rub(est), n: billSec(v.dur) }) }) : null,
      el("div", { class: "upload-bar", id: "upload-bar", hidden: true }, el("span", { class: "upload-fill" })),
      el("div", { id: "flow-error", class: "form-error", role: "alert" }),
      el("div", { class: "workflow-actions" }, send));
  }
  // заказ стиля: type=style, style_id, quality, lang, prompt?, video, photo[] (контракт 92)
  async function sendStyle(s) {
    if (sending) return;
    const miss = styleMissing();
    if (miss) return showError(miss.trim());
    const form = new FormData();
    form.append("type", "style");
    form.append("style_id", s.id);
    form.append("quality", styleQ);
    form.append("lang", LANG);
    const text = photos.prompt.trim().slice(0, 500);
    if (text) form.append("prompt", text);
    form.append("video", photos.video.file, "video");
    allPhotos().forEach((p, i) => form.append("photo[]", p.file, `photo${i + 1}`));
    await submit(form, true, { kind: "style", trend: s.id, preset: 0 });
  }

  // --- AI-видео (96C): описание 1–4000, 0–10 фото-образцов без людей, формат, длина 4–30 с, качество → сервер
  // (type=aivideo) → проверка описания и цена — бот. Черновик: описание, формат, длина, качество и номер отправленного
  // заказа — в localStorage (Telegram перезагрузил окно — текст на месте), фото — только в памяти страницы. После отказа
  // (rejected) и отмены счёта (97C) всё на месте — «Изменить описание»; после оплаты этого заказа — стирается, а
  // описание с форматом, длиной и качеством 24 ч лежит отдельно (aivLast) — для «Создать ещё» на экране результата ---
  const AIV_RATIOS = ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"];
  const AIV_MAIN = 3;                   // сразу видны три формата, остальные — под «ещё…»
  const AIV_DESC_MAX = 4000, AIV_PHOTOS = 10, AIV_MIN = 4, AIV_MAX = 30;
  // ratioSet (97C, поле ratio_set): клиент сам нажал формат; нет — бот может взять формат из описания
  const freshAiv = () => ({ desc: "", ratio: "9:16", ratioSet: false, sec: 10, q: "720p", more: false, photos: [], order: "", rev: 0 });
  // черновик из хранилища — только известные значения
  function restoreAiv(o) {
    const a = freshAiv();
    if (!o || typeof o !== "object") return a;
    if (typeof o.desc === "string") a.desc = o.desc.slice(0, AIV_DESC_MAX);
    if (AIV_RATIOS.includes(o.ratio)) a.ratio = o.ratio;
    a.ratioSet = o.rs === 1;
    if (Number.isInteger(o.sec) && o.sec >= AIV_MIN && o.sec <= AIV_MAX) a.sec = o.sec;
    if (QUALITIES.includes(o.q)) a.q = o.q;
    if (typeof o.order === "string" && ORDER_ID.test(o.order)) a.order = o.order;
    const at = Number(o.at);
    // срок: отправленный — как номер заказа (24 ч), неотправленный — 7 дней с последней правки; старше или без
    // времени — черновика нет
    if (!(at > Date.now() - (a.order ? ORDER_TTL : AIV_DRAFT_TTL) && at <= Date.now() + 60000)) return freshAiv();
    a.at = at;
    a.more = AIV_RATIOS.indexOf(a.ratio) >= AIV_MAIN;
    return a;
  }
  const AIV_DRAFT_TTL = 7 * 24 * 3600 * 1000;
  let aiv = restoreAiv(storedAiv);
  // последнее оплаченное описание (97C) — только с номером своего заказа и не старше 24 ч, как сам номер
  let aivLast = restoreAiv(storedLast);
  if (!aivLast.order || !aivLast.desc.trim()) aivLast = null;
  const packAiv = (a) => a && a.desc.trim()
    ? { desc: a.desc.slice(0, AIV_DESC_MAX), ratio: a.ratio, rs: a.ratioSet ? 1 : 0, sec: a.sec, q: a.q, order: a.order, at: a.at || Date.now() }
    : undefined;
  const aivStored = () => packAiv(aiv);
  let aivSaveTimer = 0;
  // клиент правит черновик: он больше не тот, что ушёл заказом, — оплата прошлого заказа его не сотрёт
  function aivTouched(save = true) {
    aiv.order = "";
    aiv.rev++;                        // правка во время заливки — тоже новый черновик
    aiv.at = Date.now();
    clearTimeout(aivSaveTimer);
    if (save) persist();
    else aivSaveTimer = setTimeout(flushAiv, 400);  // набор текста — сохраняем, когда пауза
  }
  function flushAiv() {
    clearTimeout(aivSaveTimer);
    aivSaveTimer = 0;
    persist();
  }
  function clearAiv() {
    aiv.photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    aiv = freshAiv();
    clearTimeout(aivSaveTimer);
    aivSaveTimer = 0;
    persist();
  }
  // окно сворачивают или закрывают — недописанное описание сохраняем сразу, не дожидаясь паузы
  document.addEventListener("visibilitychange", () => { if (document.hidden && aivSaveTimer) flushAiv(); });
  window.addEventListener("pagehide", () => { if (aivSaveTimer) flushAiv(); });
  // при запуске: заказ черновика уже не наш (номер забыт — старше 24 ч или не найден) — черновик не нужен; ушёл
  // дальше «к оплате» или отменён — как при опросе (settleAiv); истёкший — restoreAiv уже отбросил, здесь стираем и в
  // хранилище. Последнее описание — только пока номер его заказа среди своих
  {
    const mine = aiv.order && myOrders.find((o) => o.id === aiv.order);
    if (aivLast && !myOrders.some((o) => o.id === aivLast.order)) aivLast = null;
    if (aiv.order && !mine) clearAiv();
    else if (mine) settleAiv(mine.id, mine.st);
    if ((storedAiv && !aiv.desc) || (storedLast && !aivLast)) persist();
  }
  // длина описания для счётчика: перенос строки — один знак (в поле переносы всегда \n)
  const descLen = (s) => s.replace(/\r\n/g, "\n").length;
  // описание к отправке — как его примет сервер (API.md 96A: без управляющих и невидимых символов, иначе bad_desc):
  // невидимые (часто приходят со вставкой текста) — убрать, U+2028/2029 — перенос строки; U+200D в эмодзи — можно
  const cleanDesc = (s) => s.replace(/\r\n?/g, "\n").replace(/[\p{Zl}\p{Zp}]/gu, "\n")
    .replace(/[\p{Cf}\p{Cs}]|[^\P{Cc}\n\t]/gu, (c) => c.codePointAt(0) === 0x200d ? c : "").trim();
  const AIV_BYTES = 100 * MB;           // фото-образцы вместе (API.md 96A)
  function aivAddPhotos(files) {
    if (sending) return;              // идёт заливка — новое фото в неё уже не попадёт
    aivTouched();
    const err = [];
    for (const f of files) {
      const byName = !f.type && /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || "");
      if (!PHOTO_TYPES.test(f.type) && !byName) { err.push(T("errType", { name: f.name || "?" })); continue; }
      if (f.size > 10 * MB) { err.push(T("errSize", { name: f.name || "?" })); continue; }
      if (aiv.photos.length >= AIV_PHOTOS) { err.push(T("errCount", { n: AIV_PHOTOS })); break; }
      if (aiv.photos.reduce((s, p) => s + p.file.size, 0) + f.size > AIV_BYTES) { err.push(T("errTotalAiv")); break; }
      const preview = /^image\/(jpeg|png|webp)$/.test(f.type);
      aiv.photos.push({ file: f, url: preview ? URL.createObjectURL(f) : "", key: Math.random().toString(36).slice(2) });
    }
    render();
    if (err.length) showError(err.join(" "));
  }
  const aivEstimate = (q = aiv.q) => LANG === "ru" && P ? aivideoPrice(aiv.ratio, q, aiv.sec) : null;
  const aivSendLabel = () => { const p = aivEstimate(); return T("aivBtn") + (p ? ` · ≈ ${rub(p)}` : ""); };
  // длина ползунком: цены и подписи — на месте, без перерисовки экрана (ползунок не теряет палец)
  function aivRefresh() {
    const len = $("#aiv-len");
    if (len) len.textContent = T("aivLen", { n: aiv.sec });
    document.querySelectorAll(".aiv-q .q-choice").forEach((b) => {
      const p = aivEstimate(b.dataset.value), s = b.querySelector("small");
      if (s && p) s.textContent = "≈ " + rub(p);
    });
    const price = $("#aiv-price"), p = aivEstimate();
    if (price && p) price.textContent = "≈ " + rub(p);
    const send = $("#send-photos");
    if (send && !sending) send.lastChild.textContent = aivSendLabel();
  }
  function aivPage() {
    const area = el("textarea", { id: "aiv-desc", maxlength: String(AIV_DESC_MAX), rows: "5", placeholder: T("aivPh"),
      "aria-labelledby": "aiv-what", oninput: (e) => {
        aiv.desc = e.target.value;
        aivTouched(false);
        const c = $("#aiv-count");
        if (c) c.textContent = `${descLen(aiv.desc)} / ${AIV_DESC_MAX}`;
        updateSend();
      } });
    area.value = aiv.desc;
    const input = "aiv-photo-input";
    const ratios = aiv.more || AIV_RATIOS.indexOf(aiv.ratio) >= AIV_MAIN ? AIV_RATIOS : AIV_RATIOS.slice(0, AIV_MAIN);
    const chip = (r) => el("button", { class: "choice" + (r === aiv.ratio ? " selected" : ""), type: "button",
      "aria-pressed": String(r === aiv.ratio), data: { action: "aiv-ratio", value: r } }, T("ratio")[r] || r);
    const range = el("input", { type: "range", class: "aiv-range", id: "aiv-sec", min: String(AIV_MIN), max: String(AIV_MAX),
      step: "1", "aria-labelledby": "aiv-len", oninput: (e) => {
        const n = Number(e.target.value);
        if (Number.isInteger(n) && n >= AIV_MIN && n <= AIV_MAX) { aiv.sec = n; aivTouched(false); aivRefresh(); }
      } });
    range.value = String(aiv.sec);
    const est = aivEstimate();
    const send = btn(aivSendLabel(), "send-aiv", "primary full", {}, "spark");
    send.id = "send-photos";
    queueMicrotask(updateSend);
    return el("div", { class: "photo-page aiv-page" }, pageTopEl(T("aivTitle"), T("aivSub")),
      el("section", { class: "ask-block" },
        el("div", { class: "ask-head" }, el("h3", { id: "aiv-what", text: T("aivWhat") }),
          el("span", { class: "ask-count", id: "aiv-count", text: `${descLen(aiv.desc)} / ${AIV_DESC_MAX}` })), area,
        el("p", { class: "aiv-hints" }, T("aivHints").map((s) => el("span", { text: s })))),
      el("section", { class: "ask-block" },
        el("div", { class: "ask-head" }, el("h3", { text: T("aivPhotos") }),
          el("span", { class: "ask-count", text: `${aiv.photos.length} / ${AIV_PHOTOS}` })),
        el("p", { class: "photo-hint", text: T("aivPhotosHint") }),
        el("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/heic,image/heif", multiple: true,
          class: "visually-hidden", id: input, onchange: (e) => { aivAddPhotos([...e.target.files]); e.target.value = ""; } }),
        el("div", { class: "photo-grid" }, aiv.photos.map((p, i) => thumbEl(p, i, "aiv-photo-remove", true)),
          aiv.photos.length < AIV_PHOTOS ? addTile(input) : null)),
      el("div", { class: "field" }, el("span", { class: "field-label", text: T("aivFormat") }),
        el("div", { class: "choice-row" }, ratios.map(chip), ratios.length < AIV_RATIOS.length
          ? el("button", { class: "choice", type: "button", data: { action: "aiv-more" } }, T("more")) : null)),
      el("div", { class: "field" }, el("span", { class: "field-label", id: "aiv-len", text: T("aivLen", { n: aiv.sec }) }), range),
      el("div", { class: "field" }, el("span", { class: "field-label", text: T("quality") }),
        el("div", { class: "q-row aiv-q" }, QUALITIES.map((k) => {
          const p = aivEstimate(k);
          return el("button", { class: "q-choice" + (k === aiv.q ? " selected" : ""), type: "button",
            "aria-pressed": String(k === aiv.q), data: { action: "aiv-q", value: k } },
          el("strong", { text: T("q")[k] }), el("small", { text: p ? "≈ " + rub(p) : k }));
        }))),
      est ? el("div", { class: "price-card" }, el("span", { text: T("aivName") }), el("strong", { id: "aiv-price", text: "≈ " + rub(est) }),
        el("small", { text: T("aivNote") })) : el("div", { class: "quote-hint", icon: "info" }, T("aivNote")),
      el("div", { class: "upload-bar", id: "upload-bar", hidden: true }, el("span", { class: "upload-fill" })),
      el("div", { id: "flow-error", class: "form-error", role: "alert" }),
      el("div", { class: "workflow-actions" }, send),
      el("p", { class: "aiv-ban" }, T("aivBan") + " · ",
        el("button", { class: "text-button aiv-rules", type: "button", data: { action: "aiv-rules" } }, T("rules"))));
  }
  // заказ AI-видео: type (первым — сервер проверяет фото прямо во время заливки), desc, ratio, seconds, quality, lang,
  // photo[] (API.md 96A). Перенос строки браузер шлёт как \r\n — сервер считает его одним знаком
  async function sendAiv() {
    if (sending) return;
    const desc = cleanDesc(aiv.desc);
    if (!desc) return showError(T("aivNeed"));
    if (!AIV_RATIOS.includes(aiv.ratio) || !QUALITIES.includes(aiv.q) || !(aiv.sec >= AIV_MIN && aiv.sec <= AIV_MAX)) return;
    const form = new FormData();
    form.append("type", "aivideo");
    form.append("desc", desc);
    form.append("ratio", aiv.ratio);
    form.append("seconds", String(aiv.sec));
    form.append("quality", aiv.q);
    form.append("ratio_set", aiv.ratioSet ? "1" : "0");     // 97: 1 — формат нажат клиентом, 0 — по умолчанию
    form.append("lang", LANG);
    aiv.photos.forEach((p, i) => form.append("photo[]", p.file, `photo${i + 1}`));
    const rev = aiv.rev;
    const id = await submit(form, aiv.photos.length > 0, { kind: "aivideo", trend: "", preset: 0 });
    if (id && aiv.rev === rev) {
      aiv.order = id;                 // черновик — этот заказ: его оплата или отмена черновик сотрёт
      aiv.at = Date.now();            // срок отправленного черновика — 24 ч, как у номера заказа
      persist();
    }
  }
  function aivRulesSheet() {
    const items = T("rulesNo").map((s) => `<li>${esc(s)}</li>`).join("");
    showModal(esc(T("rulesTitle")), `<p class="sheet-text">${esc(T("rulesOk"))}</p><ol class="sheet-rules">${items}</ol><p class="sheet-text">${esc(T("rulesHow"))}</p>`);
  }
  // заказ AI-видео оплачен или ушёл в работу — черновик (описание и фото) больше не нужен; описание, формат, длина и
  // качество остаются последним описанием (aivLast) для «Создать ещё». Счёт отменён (97C) — черновик остаётся на
  // экране, уже не привязанный к этому заказу (неотправленный — 7 дней)
  function settleAiv(id, status) {
    if (aiv.order !== id) return;
    if (status === "cancelled") {
      aiv.order = "";
      aiv.at = Date.now();
      persist();
    } else if (["paid", "working", "done", "review"].includes(status)) {
      aivLast = { ...aiv, photos: [], order: id, at: Date.now() };
      clearAiv();
    }
  }
  // «Создать ещё» после результата (97C): последнее описание этого заказа — на экране, его можно изменить. Начатый
  // после него черновик не трогаем
  function createMore(id) {
    if (aivLast && aivLast.order === id && !aiv.desc.trim()) {
      aiv = { ...freshAiv(), desc: aivLast.desc, ratio: aivLast.ratio, ratioSet: aivLast.ratioSet, sec: aivLast.sec,
        q: aivLast.q, more: AIV_RATIOS.indexOf(aivLast.ratio) >= AIV_MAIN, at: Date.now() };
      persist();
    }
    nav("create/video");
  }

  // --- экран заказа (91): опрос раз в 2,5 с, пока окно видно; всё о деньгах — из ответа сервера ---
  const LIVE = new Set(["new", "picked", "quoted", "needs_consent", "paid", "working"]);
  const CANCELABLE = new Set(["new", "picked", "quoted", "needs_consent"]);
  const STATUSES = new Set([...LIVE, "rejected", "review", "done", "cancelled"]);
  // softenAt — когда сервер принял «Смягчить» (до ответа опроса, отправленного после этого, оплату не показываем);
  // softenKept — блок «Смягчить» скрыт: «Оставить как есть» или смягчение уже просили (одно на заказ, 97A
  // soften_once; бот не ответил за 30 мин — сервер снимает просьбу и снова показывает оплату старого счёта)
  // cancelAt — когда нажали «Отменить»: ответы опроса, отправленного раньше, отбрасываются
  let view = { id: "", data: null, gone: false, offline: false, paying: false, softenAt: 0, softenKept: false, cancelAt: 0 };
  let pollTimer = 0, pollBusy = false;
  function cleanStatus(b) {
    if (!b || typeof b !== "object" || !STATUSES.has(b.status)) return null;
    const pay = b.pay && typeof b.pay === "object" ? b.pay : {};
    const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
    const no = int(b.order_no) ?? (typeof b.order_no === "string" && /^\d{1,10}$/.test(b.order_no) ? b.order_no : null);
    return { status: b.status, price_rub: int(b.price_rub), price_stars: int(b.price_stars), order_no: no,
      rub_url: str(pay.rub_url, 2048), stars_link: str(pay.stars_link, 2048),
      message: str(b.message, 4000).trim(), result_url: str(b.result_url, 2048),
      soften: b.status === "quoted" ? cleanSoften(b.soften) : null, soften_wanted: b.soften_wanted === true };
  }
  // 97: предложение бота смягчить описание AI-видео — {offer: 1–300, risks: 0–3 строки по 1–120}; тексты бота, на
  // страницу — только textContent. Не того вида — предложения нет
  function cleanSoften(s) {
    if (!s || typeof s !== "object" || typeof s.offer !== "string" || !s.offer.trim()) return null;
    const risks = Array.isArray(s.risks) ? s.risks.filter((r) => typeof r === "string" && r.trim()).slice(0, 3)
      .map((r) => r.trim().slice(0, 120)) : [];
    return { offer: s.offer.trim().slice(0, 300), risks };
  }
  // ссылки оплаты: адрес кладёт бот, сервер (недоверенный) мог бы подменить — кнопка только для ссылки ровно того вида,
  // что даёт ЮKassa на платёж магазина (confirmation_url), и с суммой на кнопке; не тот вид — «оплатить в боте».
  // Бот всё равно сверяет платёж со своим заказом и суммой (ревью 91: переводы на чужой кошелёк yoomoney.ru не пускать)
  const YOOKASSA_URL = /^https:\/\/yoomoney\.ru\/checkout\/payments\/v2\/contract\?orderId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const payHost = (url) => YOOKASSA_URL.test(url) ? "yoomoney.ru" : "";
  const starsOk = (url) => /^https:\/\/t\.me\/(\$|invoice\/)[A-Za-z0-9_-]{1,512}$/.test(url);
  const resultOk = (url) => url.startsWith(API + "/api/results/") && /^[A-Za-z0-9_\-/.:]+$/.test(url) && !url.includes("..");
  function stopPoll() {
    clearTimeout(pollTimer);
    pollTimer = 0;
  }
  function schedulePoll(ms = 2500) {
    stopPoll();
    pollTimer = setTimeout(poll, ms);
  }
  async function poll() {
    pollTimer = 0;
    const id = view.id;
    if (!id || route() !== "order/" + id) return;
    if (document.hidden) return;                  // окно скрыто — продолжим по visibilitychange
    if (pollBusy) return;
    pollBusy = true;
    const asked = Date.now();
    try {
      const data = cleanStatus(await api("/api/orders/" + id));
      if (view.id !== id) return;
      if (view.cancelAt && asked < view.cancelAt) return;     // ответ до отмены — устарел (опрос продолжит cancelOrder)
      // снятие пометки «Смягчаем…» — тоже перемена экрана (сервер мог и не узнать о просьбе — данные те же)
      const before = JSON.stringify(view.data) + view.offline + payWaiting(id, view.data) + !!view.softenAt;
      // дальше о смягчении знает ответ сервера — но не пока идёт сам запрос «Смягчить» (softenBusy)
      if (view.softenAt && !softenBusy && asked > view.softenAt) view.softenAt = 0;
      view.offline = false;
      if (data) {
        view.data = data;
        const mine = myOrders.find((o) => o.id === id);
        if (mine && mine.st !== data.status) { mine.st = data.status; persist(); }
        settleAiv(id, data.status);
      }
      if (before !== JSON.stringify(view.data) + view.offline + payWaiting(id, view.data) + !!view.softenAt) render();
      if (!data || LIVE.has(data.status)) schedulePoll();
    } catch (e) {
      if (view.id !== id) return;
      if (e.status === 404) {
        view.gone = true;
        forgetOrder(id);
        if (aiv.order === id) clearAiv();            // заказа больше нет — и черновика, ушедшего им
        if (aivLast && aivLast.order === id) { aivLast = null; persist(); }   // и его последнего описания
        render();
        return;
      }
      if (e.status === 401 || e.status === 403) {
        view.error = e.message;
        render();
        return;
      }
      if (!view.offline) { view.offline = true; render(); }
      schedulePoll(5000);
    } finally {
      pollBusy = false;
      // пока шёл запрос, клиент открыл другой заказ — опросить его (его poll() вышел из-за pollBusy)
      if (view.id !== id && view.id && route() === "order/" + view.id && !pollTimer) schedulePoll(0);
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !view.id || route() !== "order/" + view.id || view.error || view.gone) return;
    if (view.paying && view.data && view.data.status === "quoted") {   // вернулись со страницы оплаты без оплаты
      view.paying = false;
      render();
    }
    if (!pollTimer && (!view.data || LIVE.has(view.data.status))) poll();
  });
  function orderPage(id) {
    if (view.id !== id) {
      view = { id, data: null, gone: false, offline: false, paying: false, error: "", softenAt: 0, softenKept: false, cancelAt: 0 };
      schedulePoll(0);
    } else if (!pollTimer && !pollBusy && !view.gone && !view.error && (!view.data || LIVE.has(view.data.status)))
      schedulePoll(0);                              // вернулись к заказу — опрос снова
    if (view.error) {                               // вход не прошёл (initData устарела) — открыть приложение заново
      return el("div", { class: "order-page" }, el("div", { class: "status-card" },
        el("div", { class: "status-head" }, el("h1", { text: T("rejected") })),
        el("p", { class: "status-message", text: view.error })),
        el("div", { class: "status-actions" }, btn(T("openBot"), "open-bot", "primary full", {}, "send")));
    }
    const meta = myOrders.find((o) => o.id === id) || { kind: "", trend: "", preset: 0 };
    const preset = meta.kind === "preset", style = meta.kind === "style", aivideo = meta.kind === "aivideo";
    const checking = preset ? T("checkingPreset") : style ? T("checkingVideo") : aivideo ? T("checkingDesc") : T("checking");
    const d = view.data;
    const waiting = payWaiting(id, d);                // оплату открывали — ждём подтверждения бота, не отменяем
    const box = el("div", { class: "status-card" });
    const head = (title, spinner) => box.append(el("div", { class: "status-head" },
      spinner ? el("span", { class: "spinner" }) : null, el("h1", { text: title })));
    const msg = () => d && d.message ? box.append(el("p", { class: "status-message", text: d.message })) : null;
    const actions = el("div", { class: "status-actions" });
    if (view.gone) {
      head(T("notFound"));
      actions.append(btn(T("toTrends"), "nav", "primary full", { to: "trends" }));
    } else if (!d) {
      head(checking, true);
    } else if (d.status === "new" || d.status === "picked") {
      head(checking, true);
    } else if (d.status === "quoted" && (d.soften_wanted || view.softenAt)) {
      // 97: клиент нажал «Смягчить» — ждём новый счёт от бота; ссылок старого счёта не показываем
      head(T("softening"), true);
      box.append(el("p", { class: "status-message", text: T("softeningText") }));
      if (aivideo && !waiting) actions.append(btn(T("changeDesc"), "edit-desc", "ghost full", {}, "sliders"));
    } else if (d.status === "quoted") {
      // «Заказ №N · сумма»: номер — order_no бота, сумма — из ответа (₽ только ru); номера нет — только сумма
      const sum = LANG === "ru" && d.price_rub ? rub(d.price_rub) : d.price_stars ? stars(d.price_stars) : "";
      const title = [d.order_no !== null ? T("orderNo", { n: d.order_no }) : T("toPay"), sum].filter(Boolean).join(" · ");
      head(view.paying ? T("payCheck") : title, view.paying);
      msg();
      if (waiting) box.append(el("p", { class: "status-note", text: T("payPending") }));
      // 97: бот видит риск отказа нейросети — «Смягчить» (новый счёт) или «Оставить как есть»; оплата видна сразу
      if (aivideo && d.soften && !view.softenKept && !view.paying && !waiting) {
        const what = d.soften.risks.join(", ");
        box.append(el("div", { class: "soften-block" },
          el("p", { class: "soften-risk", text: what ? T("softenRisk", { what }) : T("softenRiskAny") }),
          el("p", { class: "soften-offer", text: d.soften.offer }),
          el("div", { class: "soften-actions" }, btn(T("softenBtn"), "soften", "secondary small"),
            btn(T("softenKeep"), "soften-keep", "ghost small"))));
      }
      const host = payHost(d.rub_url);
      if (LANG === "ru" && host && d.price_rub)
        actions.append(btn(`${T("payCard")} · ${rub(d.price_rub)}`, "pay-rub", "primary full"),
          el("p", { class: "pay-where", text: T("payWhere", { host }) }));
      if (starsOk(d.stars_link) && d.price_stars)
        actions.append(btn(`${T("payStars")} · ${stars(d.price_stars)}`, "pay-stars", LANG === "ru" && host ? "secondary full" : "primary full"));
      if (!actions.childNodes.length) {
        box.append(el("p", { class: "status-note", text: T("payBot") }));
        actions.append(btn(T("openBot"), "open-bot", "secondary full", {}, "send"));
      }
      // 97C: описание можно поправить до оплаты — текущий счёт отменяем (два живых счёта — две оплаты), черновик
      // остаётся на экране «Создать видео» (новый заказ)
      if (aivideo && !waiting) actions.append(btn(T("changeDesc"), "edit-desc", "ghost full", {}, "sliders"));
    } else if (d.status === "needs_consent") {
      head(T("consent"));
      msg();
      actions.append(btn(T("openBot"), "open-bot", "primary full", {}, "send"));
    } else if (d.status === "rejected") {
      head(T("rejected"));
      msg();
      // описание не прошло правила (96) — текст причины от бота и правка: описание и фото — в черновике на экране
      if (aivideo) actions.append(btn(T("changeDesc"), "nav", "primary full", { to: "create/video" }, "sliders"));
      else if (preset) actions.append(btn(T("changePhoto"), "make-preset", "primary full", { id: meta.trend }, "camera"));
      else if (style && meta.trend) actions.append(btn(T("changeVideo"), "nav", "primary full", { to: "style/" + meta.trend }, "video"));
      else if (meta.trend) {
        if (meta.preset) actions.append(btn(T("makePreset"), "make-preset", "primary full", { id: meta.trend }, "layers"));
        actions.append(btn(meta.preset ? T("optPhoto") : T("changePhoto"), "nav", meta.preset ? "secondary full" : "primary full",
          { to: "who/" + meta.trend }, "camera"));
      }
      actions.append(btn(T("support"), "support", "ghost full"));
    } else if (d.status === "review") {
      head(T("review"));
      msg();
      actions.append(btn(T("support"), "support", "primary full"), el("p", { class: "pay-where", text: T("supportHint") }));
    } else if (d.status === "paid" || d.status === "working") {
      head(preset ? T("workingPreset") : T("working"), true);
      box.append(el("p", { class: "status-message", text: T("workingText") }));
      if (d.message) box.append(el("p", { class: "status-note", text: d.message }));
    } else if (d.status === "done") {
      head(T("done"));
      msg();
      if (resultOk(d.result_url)) {
        if (preset) box.append(el("img", { class: "result-media", src: d.result_url, alt: T("orderPreset") }));
        else {
          const v = el("video", { class: "result-media", src: d.result_url, controls: true, playsinline: true,
            autoplay: !REDUCED, loop: true, preload: "metadata" });
          v.muted = true;
          box.append(v);
          if (tg && tg.isVersionAtLeast && tg.isVersionAtLeast("8.0") && tg.downloadFile)
            actions.append(btn(T("save"), "save-result", "primary full", {}, "download"));
          if (tg && tg.isVersionAtLeast && tg.isVersionAtLeast("7.8") && tg.shareToStory)
            actions.append(btn(T("share"), "share-result", "secondary full", {}, "send"));
        }
      }
      box.append(el("p", { class: "status-note", text: preset ? T("inChatPreset") : T("inChat") }));
      if (preset && meta.trend && trendById(meta.trend))
        actions.append(btn(T("backToTrend"), "back-to-trend", "primary full", { id: meta.trend }, "arrow"));
      else if (style) actions.append(btn(T("toStyles"), "nav", "ghost full", { to: "styles" }));
      else if (aivideo) actions.append(btn(T("createMore"), "create-more", "ghost full", { id }));
      else actions.append(btn(T("toTrends"), "nav", preset ? "primary full" : "ghost full", { to: "trends" }));
    } else if (d.status === "cancelled") {
      head(T("cancelled"));
      actions.append(aivideo ? btn(T("aivTitle"), "nav", "primary full", { to: "create/video" })
        : btn(T("toTrends"), "nav", "primary full", { to: "trends" }));
    }
    if (view.offline) box.append(el("p", { class: "status-note offline", text: T("retry") }));
    if (!view.gone && (!d || CANCELABLE.has(d.status)) && !waiting)
      actions.append(btn(T("cancel"), "cancel-order", "ghost full"));
    const face = el("div", { class: "status-monti" });
    face.insertAdjacentHTML("afterbegin", monti("m"));               // свой Монти, без данных сервера
    return el("div", { class: "order-page" }, face, box, actions);
  }
  async function pay(kind) {
    const d = view.data;
    if (!d || d.status !== "quoted" || !tg) return;
    if (kind === "rub" && payHost(d.rub_url)) {
      markPay(view.id);
      tg.openLink(d.rub_url);                       // ЮKassa — во внешнем браузере; вернувшись, опрос подхватит
      view.paying = true;
      render();
    } else if (kind === "stars" && starsOk(d.stars_link)) {
      const id = view.id;
      markPay(id);
      if (tg.openInvoice && tg.isVersionAtLeast && tg.isVersionAtLeast("6.1")) {
        tg.openInvoice(d.stars_link, (status) => {
          if (status === "paid") { view.paying = true; render(); schedulePoll(500); }
          else if (status === "cancelled" || status === "failed") { markPay(id, false); render(); }   // окно закрыли без оплаты
        });
      } else tg.openTelegramLink(d.stars_link);
    }
  }
  // 97: «🪶 Смягчить» — только просьба (POST …/soften): новый текст, правила и новый счёт решает бот. Пока он не
  // выставил новый счёт — «Смягчаем…», кнопок оплаты старого счёта нет
  let softenBusy = false;
  async function softenOrder() {
    const id = view.id, d = view.data;
    if (softenBusy || !d || d.status !== "quoted" || !d.soften) return;
    softenBusy = true;
    // ревью 97C: кнопки оплаты старого счёта прячем сразу, до ответа сервера (запрос — до 10 с)
    view.softenAt = Date.now();
    view.softenKept = true;
    render();
    try {
      await api(`/api/orders/${id}/soften`, { method: "POST" });
      if (view.id === id) view.softenAt = Date.now();     // опросы, отправленные раньше этого, пометку не снимут
    } catch (e) {
      toast(e.code === "soften_once" ? T("softenOnce") : e.message);
      if (view.id === id && e.status === 0) {         // сеть: дошла ли просьба — скажет следующий удачный опрос
        view.softenAt = Date.now();
        view.softenKept = true;
        render();
      } else if (view.id === id) {                    // не принят — снова счёт; блок — только если смягчить ещё можно
        view.softenAt = 0;
        view.softenKept = ["no_soften", "soften_once", "already_paid", "order_cancelled", "cannot_soften"].includes(e.code);
        render();
      }
    } finally {
      softenBusy = false;
      if (view.id === id) schedulePoll(0);
    }
  }
  // then — после отмены (ревью 97C: «Изменить описание» на счёте — отмена, потом экран «Создать видео»); отказ — текст
  // сервера, без перехода
  async function cancelOrder(then) {
    const id = view.id;
    closeModal();
    view.cancelAt = Date.now();
    try {
      const b = await api(`/api/orders/${id}/cancel`, { method: "POST" });
      if (b && b.status === "cancelled" && view.id === id && view.data) view.data.status = "cancelled";
      else if (view.id === id) view.data = { ...(view.data || {}), status: "cancelled" };
      const mine = myOrders.find((o) => o.id === id);
      if (mine) { mine.st = "cancelled"; persist(); }
      settleAiv(id, "cancelled");
      stopPoll();
      if (then && view.id === id) nav(then);
      else render();
    } catch (e) {
      toast(e.message);
      schedulePoll(0);
    }
  }
  function openBot(path = "") {
    if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(BOT_URL + path);
    else location.href = BOT_URL + path;
  }

  // --- экраны ---
  function home() {
    const [h1, h2] = T("homeTitle"), [e1, e2] = T("tileEdit"), [r1, r2] = T("tileTrend"), [s1, s2] = T("tileStyle");
    const [c1, c2] = T("tileCreate");
    return `<div class="page-head welcome"><div><h1>${esc(h1)}<br>${esc(h2)}</h1><p>${esc(T("homeSub"))}</p></div><div class="welcome-monti">${monti("l")}</div></div>
<div data-mount="orders"></div>
${continueCards()}
<div class="product-switch"><button class="product-tile active" data-action="nav" data-to="trends">${icon("spark")}<div><span>${esc(r1)}</span><small>${esc(r2)}</small></div>${icon("arrow")}</button><button class="product-tile" data-action="nav" data-to="edit">${icon("sliders")}<div><span>${esc(e1)}</span><small>${esc(e2)}</small></div>${icon("arrow")}</button><button class="product-tile" data-action="nav" data-to="styles">${icon("layers")}<div><span>${esc(s1)}</span><small>${esc(s2)}</small></div>${icon("arrow")}</button><button class="product-tile" data-action="nav" data-to="create">${icon("plus")}<div><span>${esc(c1)}</span><small>${esc(c2)}</small></div>${icon("arrow")}</button></div>
<div class="section-heading"><div><h2>${esc(T("trends"))}</h2><p class="section-hint">${esc(T("trendsHint"))}</p></div><button class="text-button" data-action="toggle-trends" aria-expanded="${trendsExpanded}" aria-controls="home-trends">${trendsExpanded ? "Свернуть" : "Показать"} ${icon(trendsExpanded ? "x" : "plus")}</button></div>
${trendsExpanded ? '<div id="home-trends" data-mount="home-trends"></div>' : ""}
<div class="section-heading"><div><h2>${esc(T("styles"))}</h2><p class="section-hint">${esc(T("stylesHint"))}</p></div></div>
<div id="home-styles" data-mount="home-styles"></div>
<div class="onboarding-strip">${monti("s")}<div><h3>Свой персонаж</h3><p>Лист персонажа по вашим фото — для «Изменить видео» и своих проектов.</p></div>${button("Пресет", "new-preset", "secondary small", "", "plus")}</div>`;
  }
  const MOUNTS = { "home-trends": homeTrends, "home-styles": homeStyles, orders: homeOrders };

  // вкладка «Изменить» (97C, правки партнёра 12.10): «Изменить видео» (нейросеть) — первым и зелёным, «Монтаж» —
  // последним и тёмным
  function editLanding() {
    const [n1, n2] = T("svcNeuro"), [m1, m2] = T("svcMontage"), [s1, s2] = T("tileStyle");
    return `<div class="editor-landing">${pageTop(esc(T("editTitle")), esc(T("editSub")))}<div class="service-pick"><button class="product-tile active" data-action="start" data-kind="neuro">${icon("spark")}<div><span>${esc(n1)}</span><small>${esc(n2)}</small></div>${icon("arrow")}</button><button class="product-tile" data-action="nav" data-to="styles">${icon("layers")}<div><span>🎨 ${esc(s1)}</span><small>${esc(s2)}</small></div>${icon("arrow")}</button><button class="product-tile" data-action="start" data-kind="montage">${icon("scissors")}<div><span>${esc(m1)}</span><small>${esc(m2)}</small></div>${icon("arrow")}</button></div><p class="bottom-note">${esc(T("editNote"))}</p></div>`;
  }
  // 96C: вкладка «Создать» — AI-видео и свой персонаж (в приложении); «Картинки» — на стадии разработки (владелец
  // 13.10: в бота не уводим; пометка «скоро», касание — короткое сообщение). Код w1-i бот по-прежнему понимает
  function createPage() {
    const tile = (ic, [t, s], attrs, cls = "", tag = "") =>
      `<button class="product-tile ${cls}" ${attrs}>${icon(ic)}<div><span>${esc(t)}${tag ? ` <i class="soon-tag">${esc(tag)}</i>` : ""}</span><small>${esc(s)}</small></div>${icon("arrow")}</button>`;
    return `<div class="editor-landing">${pageTop(esc(T("createTitle")), esc(T("createSub")))}<div class="service-pick">${
      AIVIDEO_ON ? tile("video", T("cAiv"), 'data-action="nav" data-to="create/video"', "active") : ""}${
      tile("image", T("cImg"), 'data-action="images" aria-disabled="true"', "soon", T("soon"))}${
      tile("user", T("cChar"), 'data-action="new-preset"', AIVIDEO_ON ? "" : "active")}</div></div>`;
  }
  const chips = (action, items, current) =>
    `<div class="choice-row">${items.map(([v, label]) => `<button class="choice ${v === current ? "selected" : ""}" data-action="${action}" data-value="${esc(v)}" aria-pressed="${v === current}">${esc(label)}</button>`).join("")}</div>`;
  const select = (id, values, current, label) =>
    `<select id="${id}">${values.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${label(v)}</option>`).join("")}</select>`;

  // экран «Монтаж» (97C, правки партнёра): один заголовок «Монтаж», описание, «Выберите, что нужно улучшить» и пункты
  function montageFields(d) {
    const items = T("montageItems");
    return `<p>${esc(T("montageDesc"))}</p><div class="field-label montage-pick">${esc(T("montagePick"))}</div>${MONTAGE_ITEMS.map((n) => {
      const on = d.opts.includes(n), [name, hint] = items[n];
      return `<div class="edit-option ${on ? "selected" : ""}"><button class="option-title" data-action="opt" data-value="${n}" aria-pressed="${on}"><b class="opt-num">${n}</b><span>${esc(name)}<small class="opt-hint">${esc(hint)}</small></span><i class="switch" aria-hidden="true"></i></button></div>`;
    }).join("")}<div class="field"><label for="m-sec">${esc(T("mLen"))}</label>${select("m-sec", MONTAGE_SECONDS, d.sec, (v) => esc(T("mUpTo", { t: secText(v) })))}<small>${esc(T("mTotal"))}</small></div><div class="field"><span class="field-label">${esc(T("mClips"))}</span><div class="stepper"><button data-action="clips" data-value="-1" aria-label="${esc(T("fewer"))}">−</button><output id="m-clips">${d.clips}</output><button data-action="clips" data-value="1" aria-label="${esc(T("moreClips"))}">+</button></div></div>`;
  }
  // экран «Изменить видео» (бывший «Нейромонтаж»): режим и пояснение к выбранному режиму под переключателем
  function neuroFields(d) {
    const modes = T("modes");
    return `<div class="field"><span class="field-label">${esc(T("modeLabel"))}</span>${chips("mode", NEURO_MODES.filter(neuroModeOk).map((m) => [m, modes[m][0]]), d.mode)}<p class="mode-hint" aria-live="polite">${esc(modes[d.mode][1])}</p></div><div class="field"><label for="n-sec">${esc(T("nLen"))}</label>${select("n-sec", SHORT_SECONDS, d.sec, (v) => esc(T("sec", { n: v })))}<small>${esc(T("nLenHint"))}</small></div><div class="field"><span class="field-label">${esc(T("quality"))}</span>${chips("q", QUALITIES.map((q) => [q, q]), d.q)}</div>`;
  }
  // что будет в боте — честно: что прислать и где цена (пресет с 96C — в приложении, экран «Свой персонаж»)
  function botSteps(d) {
    if (d.kind === "montage") {
      const [a, ...rest] = T("stepsMontage");
      return [a.replace("{what}", d.clips > 1 ? T("sendMany", { n: d.clips }) : T("sendOne")), ...rest];
    }
    return T("stepsNeuro");
  }
  function flowPage(kind) {
    if (!draft || draft.kind !== kind) draft = drafts.find((x) => x.kind === kind) || newDraft(kind);
    const d = draft;
    const fields = kind === "montage" ? montageFields(d) : neuroFields(d);
    // один заголовок, поменьше (правки партнёра): «Изменить видео» или «Монтаж»; без «Черновик сохраняется…»
    const title = kind === "montage" ? T("montageTitle") : T("kinds").neuro.replace(/^\S+\s/, "");
    const body = `<div class="fields solo">${fields}${priceBlock(d)}<ol class="bot-steps">${botSteps(d).map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div id="flow-error" class="form-error" role="alert"></div><div class="workflow-actions">${ctaHtml(d)}</div></div>`;
    return `<div class="workflow">${pageTop(esc(title))}${body}</div>`;
  }
  // примерная цена — в рублях, только ru (как у AI-видео и стилей); en/it — «точную цену покажет бот»
  function priceBlock(d) {
    const price = LANG === "ru" ? priceFor(d) : null;
    if (price === null)
      return `<div class="quote-hint">${icon("info")}${esc(T("priceNone"))}</div>`;
    const note = d.kind === "montage" ? T("priceMontage") : T("priceNeuro");
    return `<div class="price-card"><span>${esc(T("kinds")[d.kind])}</span><strong id="price">≈ ${rub(price)}</strong><small>${esc(note)}</small></div>`;
  }
  function ctaLabel(d) {
    const price = LANG === "ru" ? priceFor(d) : null;
    return T("toBot") + (price === null ? "" : ` · ≈ ${rub(price)}`);
  }
  const botUrl = (d) => "https://t.me/Montaggio_bot?start=" + encode(d);
  function ctaHtml(d) {
    const bad = d.kind === "montage" && !d.opts.length;
    if (inTelegram || bad) return button(esc(ctaLabel(d)), "order", "primary full", bad ? "disabled" : "", "send");
    return `<a class="button primary full" href="${esc(botUrl(d))}" data-action="order-link">${icon("send")}${esc(ctaLabel(d))}</a>`;
  }
  function order() {
    const d = draft;
    if (!d) return;
    if (d.kind === "montage" && !d.opts.length) {
      $("#flow-error").textContent = T("needOpt");
      return;
    }
    const url = botUrl(d);
    dropDraft(d.id);                 // заказ ушёл в бота — черновик больше не нужен
    draft = null;
    if (inTelegram) {
      tg.openTelegramLink(url);      // чат бота с /start <код>; окно приложения закрываем сами (Bot API 7.0+)
      setTimeout(() => tg.close(), 300);
    } else location.href = url;
  }

  function profile() {
    const [r1, r2, r3] = T("profileRows");
    return `<div class="profile-page"><div class="profile-header">${monti("s")}<div><h1>${esc(T("profileTitle"))}</h1><p>${esc(T("profileSub"))}</p></div></div>${[
      ["layers", r1[0], r1[1].replace("{n}", drafts.length), "nav", "drafts"],
      ["info", r2[0], r2[1], "help", ""],
      ["user", r3[0], r3[1], "about", ""],
    ].map(([ic, title, sub, a, to]) => `<button class="profile-row" data-action="${a}" ${to ? `data-to="${to}"` : ""}>${icon(ic)}<span><strong>${esc(title)}</strong><small>${esc(sub)}</small></span>${icon("chevron")}</button>`).join("")}<button class="text-button" data-action="reset">${esc(T("resetLink"))} ${icon("reset")}</button></div>`;
  }
  function draftsPage() {
    return `${pageTop(esc(T("draftsTitle")), esc(T("draftsSub")))}${drafts.length ? `<div class="draft-list">${drafts.map((d) => `<div class="draft-row">${draftCard(d)}<button class="icon-button" data-action="drop" data-id="${d.id}" aria-label="${esc(T("draftDrop"))}">${icon("trash")}</button></div>`).join("")}</div>` : `<div class="empty-state">${monti("xl")}<h2>${esc(T("noDrafts"))}</h2><p>${esc(T("noDraftsText"))}</p>${button(esc(T("toTrends")), "nav", "primary", 'data-to="trends"')}</div>`}`;
  }
  function waitCatalog() {
    return trendsState(false) || trendsPage();       // такого тренда в каталоге уже нет — весь каталог
  }

  const TREND_FLOW = /^(trends|trend\/|who\/|preset-new|order\/)/;
  function render() {
    navBar();
    const r = route();
    if (!r.startsWith("order/")) stopPoll();
    if (!/^(who\/|preset-new$|preset$|style\/)/.test(r) && photos.key && !sending) clearPhotos();
    if (TREND_FLOW.test(r) || r === "home") {
      const retry = catalogState === "down" && inTelegram && Date.now() - catalogAt > 30000;
      if ((catalogState === "idle" || retry) && tgChecked) loadTrends();
    }
    if (/^(home|styles|style\/|order\/)/.test(r)) {    // стили — свой каталог, грузится отдельно от трендов
      const retry = stylesState === "down" && inTelegram && Date.now() - stylesAt > 30000;
      if ((stylesState === "idle" || retry) && tgChecked) loadStyles();
    }
    let out;
    const tid = r.replace(/^(trend|who)\//, "");
    if (r === "trends") out = trendsPage();
    else if (/^(trend|who)\//.test(r)) {
      const t = trendById(tid);
      out = !t ? waitCatalog() : r.startsWith("trend/") ? trendPage(t) : askPage(t);
    } else if (r === "preset-new" || r === "preset") out = askPage(null);
    else if (r === "create") out = createPage();
    else if (r === "create/video") out = AIVIDEO_ON ? aivPage() : createPage();
    else if (r === "styles") out = stylesPage();
    else if (r.startsWith("style/") && STYLE_ID.test(r.slice(6)))
      out = styleById(r.slice(6)) ? stylePage(styleById(r.slice(6))) : stylesStateEl(false) || stylesPage();
    else if (r.startsWith("order/") && ORDER_ID.test(r.slice(6))) out = orderPage(r.slice(6));
    else if (r === "edit") out = editLanding();
    else if (FLOW[r]) out = flowPage(FLOW[r]);
    else if (r === "profile") out = profile();
    else if (r === "drafts") out = draftsPage();
    else out = home();
    const page = el("div", { class: "page-enter" });
    if (typeof out === "string") page.innerHTML = out;
    else page.append(out);
    page.querySelectorAll("[data-mount]").forEach((m) => {
      const node = MOUNTS[m.dataset.mount] && MOUNTS[m.dataset.mount]();
      if (node) m.append(node);
      else m.remove();
    });
    $("#app").replaceChildren(page);
    document.title = "Montaggio — " + (TREND_FLOW.test(r) ? T("trends").toLowerCase() : /^styles?(\/|$)/.test(r)
      ? T("styles").toLowerCase() : r === "home" ? "приложение" : "заказ");
    const top = r === "home";
    $("#header-back").hidden = top || inTelegram;      // в Telegram — его кнопка «Назад» в шапке окна
    if (inTelegram && tg.BackButton) top ? tg.BackButton.hide() : tg.BackButton.show();
    observeVideos();
  }
  // выбор в форме: черновик сохраняется, цена и кнопка — обновляются на месте
  function changed() {
    keepDraft();
    render();
  }

  // ролики: загружаются и играют только видимые (≥ 60 % на экране), остальные — на паузе
  let videoObserver;
  function observeVideos() {
    videoObserver?.disconnect();
    const vids = document.querySelectorAll("video.tvideo");
    const start = (v) => {
      if (!v.getAttribute("src")) { v.src = v.dataset.src; }
      if (v.dataset.auto === "1") v.play().catch(() => {});
    };
    if (!("IntersectionObserver" in window)) return vids.forEach((v) => v.dataset.auto === "1" && start(v));
    videoObserver = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) start(e.target);
      else if (!e.target.paused) e.target.pause();
    }), { threshold: 0.6 });
    vids.forEach((v) => videoObserver.observe(v));
  }
  // окно скрыто (свернули, другая вкладка) — все ролики на паузу и без звука: звук не играет «из ниоткуда»
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return void observeVideos();     // вернулись — видимые карточки снова играют (без звука)
    document.querySelectorAll("video").forEach((v) => { v.muted = true; v.pause(); });
    document.querySelectorAll(".sound-toggle").forEach((x) => {
      x.setAttribute("aria-pressed", "false");
      x.setAttribute("aria-label", T("soundOn"));
      x.innerHTML = icon("mute");
    });
  });
  // своего файла нет (новый тренд или стиль, ещё не скачан): есть запасной адрес — берём его один раз, нет — убираем
  // элемент; карточка остаётся с обложкой или фоном
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (!t || !(t.tagName === "VIDEO" || t.tagName === "IMG") || !t.closest(".tmedia")) return;
    const next = t.dataset.fallback;
    if (next) {
      delete t.dataset.fallback;
      if (t.tagName === "VIDEO") t.dataset.src = next;
      t.src = next;
      if (t.tagName === "VIDEO" && t.dataset.auto === "1") t.play().catch(() => {});
    } else t.remove();
  }, true);

  let modalFrom = null;
  function showModal(title, body) {
    modalFrom = document.activeElement;
    $("#overlay").innerHTML = `<div class="overlay-backdrop"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-head"><h2 id="sheet-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Закрыть">${icon("x")}</button></div>${body}</section></div>`;
    document.body.style.overflow = "hidden";
    $("#overlay button")?.focus();
    if (inTelegram && tg.BackButton) tg.BackButton.show();
  }
  function closeModal() {
    if (!$("#overlay").innerHTML) return false;
    $("#overlay").innerHTML = "";
    document.body.style.overflow = "";
    modalFrom?.focus?.();
    modalFrom = null;
    if (inTelegram && tg.BackButton && route() === "home") tg.BackButton.hide();
    return true;
  }

  document.addEventListener("change", (e) => {
    const id = e.target.id;
    if (!draft || !["m-sec", "n-sec"].includes(id)) return;
    const v = Number(e.target.value);
    if ((id === "m-sec" ? MONTAGE_SECONDS : SHORT_SECONDS).includes(v)) draft.sec = v;
    changed();
  });
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("overlay-backdrop")) return void closeModal();
    const link = e.target.closest('a[href^="#/"]');
    if (link) {
      e.preventDefault();
      return void nav(link.getAttribute("href").slice(2));
    }
    const b = e.target.closest("[data-action]");
    if (!b || b.disabled) return;
    const a = b.dataset.action, v = b.dataset.value;
    if (a === "order-link") {                       // вне Telegram — обычная ссылка; черновик больше не нужен
      if (draft) dropDraft(draft.id);
      return;
    }
    if (a === "back") back();
    else if (a === "nav") nav(b.dataset.to);
    else if (a === "close") closeModal();
    else if (a === "toggle-trends") { trendsExpanded = !trendsExpanded; persist(); render(); }
    else if (a === "trend") nav("trend/" + b.dataset.id);
    else if (a === "quality") {
      const t = trendById(route().slice(6));
      if (t && t.prices[v]) { pick = { trend: t.id, q: v }; render(); }
    } else if (a === "make-preset") {
      presetReturn = trendById(b.dataset.id) ? b.dataset.id : "";
      nav(presetReturn ? "preset-new" : "preset");
    } else if (a === "new-preset") { presetReturn = ""; nav("preset"); }
    else if (a === "preset-style" && has(STYLE_CODES, v) && !sending) { presetStyle = v; render(); }
    else if (a === "images") toast(T("imgSoon"));
    else if (a === "aiv-ratio" && AIV_RATIOS.includes(v) && !sending) { aiv.ratio = v; aiv.ratioSet = true; aivTouched(); render(); }
    else if (a === "aiv-more") { aiv.more = true; render(); }
    else if (a === "aiv-q" && QUALITIES.includes(v) && !sending) { aiv.q = v; aivTouched(); render(); }
    else if (a === "aiv-photo-remove" && !sending) {
      const p = aiv.photos.find((x) => x.key === b.dataset.key);
      if (p) {
        if (p.url) URL.revokeObjectURL(p.url);
        aiv.photos = aiv.photos.filter((x) => x !== p);
        aivTouched();
        render();
      }
    } else if (a === "send-aiv" && AIVIDEO_ON) sendAiv();
    else if (a === "aiv-rules") aivRulesSheet();
    else if (a === "soften") softenOrder();
    else if (a === "soften-keep") { view.softenKept = true; render(); }
    else if (a === "create-more" && AIVIDEO_ON) createMore(b.dataset.id);
    else if (a === "back-to-trend") { presetPick = b.dataset.id; nav("who/" + b.dataset.id); }
    else if (a === "ask-mode" && !sending) {
      const t = trendById(route().slice(4)), blk = t && askFor(t).find((x) => x.preset);
      if (blk) {
        photos.preset = v === "preset";
        if (photos.preset) dropBlock(blk.key);       // фото этого героя не нужны — убрать из памяти сразу
        render();
      }
    } else if (a === "photo-remove" && !sending) {
      for (const [k, list] of Object.entries(photos.blocks)) {
        const p = list.find((x) => x.key === b.dataset.key);
        if (!p) continue;
        if (p.url) URL.revokeObjectURL(p.url);
        photos.blocks[k] = list.filter((x) => x !== p);
        render();
        break;
      }
    } else if (a === "send-photos") {
      const r = route();
      if (r === "preset-new" || r === "preset") sendOrder(null);
      else if (r.startsWith("who/") && trendById(r.slice(4))) sendOrder(trendById(r.slice(4)));
    } else if (a === "style") nav("style/" + b.dataset.id);
    else if (a === "style-q" && QUALITIES.includes(v) && !sending) { styleQ = v; render(); }
    else if (a === "video-remove" && !sending) {
      if (photos.video) URL.revokeObjectURL(photos.video.url);
      photos.video = null;
      render();
    } else if (a === "send-style") {
      const s = styleById(route().slice(6));
      if (s) sendStyle(s);
    } else if (a === "sound") toggleSound(b);
    else if (a === "pay-rub") pay("rub");
    else if (a === "pay-stars") pay("stars");
    else if (a === "open-bot") openBot();
    else if (a === "suggest-trend") openBot("?start=trend");
    else if (a === "support") { openBot(); toast(T("supportHint")); }
    else if (a === "cancel-order")
      showModal(esc(T("cancelAsk")), `${view.data && view.data.status === "quoted" ? `<p class="sheet-text">${esc(T("cancelPaidNote"))}</p>` : ""}${button(esc(T("cancelYes")), "confirm-cancel", "primary full")}${button(esc(T("cancelNo")), "close", "ghost full")}`);
    else if (a === "confirm-cancel") cancelOrder();
    else if (a === "edit-desc")
      // черновик — не описание этого счёта (правили после отправки или его уже нет): говорим, что откроется
      showModal(esc(T("changeDesc")), `<p class="sheet-text">${esc(T("editDescAsk"))}</p>${aiv.order === view.id ? ""
        : `<p class="sheet-text">${esc(T(aiv.desc.trim() ? "editDescOther" : "editDescLost"))}</p>`}<p class="sheet-text">${esc(T("cancelPaidNote"))}</p>${button(esc(T("editDescYes")), "confirm-edit-desc", "primary full")}${button(esc(T("cancelNo")), "close", "ghost full")}`);
    else if (a === "confirm-edit-desc") cancelOrder("create/video");
    else if (a === "save-result") {
      const d = view.data;
      if (d && resultOk(d.result_url)) {
        try {
          tg.downloadFile({ url: d.result_url, file_name: `montaggio-${view.id.slice(0, 8)}.mp4` });
        } catch { toast(T("shareFail")); }
      }
    } else if (a === "share-result") {
      const d = view.data;
      if (d && resultOk(d.result_url)) {
        try { tg.shareToStory(d.result_url); } catch { toast(T("shareFail")); }
      }
    } else if (a === "start") { draft = newDraft(b.dataset.kind); nav("edit/" + b.dataset.kind); }
    else if (a === "resume") { const d = drafts.find((x) => x.id === b.dataset.id); if (d) openDraft(d); }
    else if (a === "drop") { dropDraft(b.dataset.id); render(); toast(T("draftDropped")); }
    else if (draft && a === "opt") {
      const n = Number(v);
      draft.opts = draft.opts.includes(n) ? draft.opts.filter((x) => x !== n) : STANDARD.filter((x) => x === n || draft.opts.includes(x));
      changed();
    } else if (draft && a === "clips") { draft.clips = Math.min(10, Math.max(1, draft.clips + Number(v))); changed(); }
    else if (draft && a === "mode" && neuroModeOk(v)) { draft.mode = v; changed(); }
    else if (draft && a === "q" && QUALITIES.includes(v)) { draft.q = v; changed(); }
    else if (draft && a === "style" && has(STYLE_CODES, v)) { draft.style = v; changed(); }
    else if (a === "order") order();
    else if (a === "help")
      showModal("Как это работает", `${monti("m")}<ul class="sheet-list"><li><strong>Тренды, стили, AI-видео и свой персонаж — прямо здесь</strong>Выберите ролик или стиль, опишите видео или добавьте фото. Цену и оплату покажем в приложении, готовое придёт сюда и в чат бота @${BOT}.</li><li><strong>«Изменить видео» и «Монтаж» — в боте</strong>Соберите заказ, кнопка откроет чат с ботом с вашим выбором. Видео пришлёте там.</li><li><strong>Оплата</strong>Цену всегда считает бот и показывает до оплаты.</li></ul>`);
    else if (a === "about")
      showModal(esc(T("aboutTitle")), `<ul class="sheet-list">${T("about").map(([h, t]) => `<li><strong>${esc(h)}</strong>${esc(t)}</li>`).join("")}</ul>`);
    else if (a === "reset")
      showModal(esc(T("resetTitle")), `<p>${esc(T("resetText"))}</p>${button(esc(T("resetYes")), "confirm-reset", "primary full")}${button(esc(T("cancelNo")), "close", "ghost full")}`);
    else if (a === "confirm-reset") {
      drafts = []; myOrders = []; draft = null; aivLast = null;
      clearAiv();
      try { localStorage.removeItem(storageKey); } catch {}
      closeModal(); render(); toast(T("resetDone"));
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  window.addEventListener("hashchange", render);

  // скрипт Telegram появился (сразу, по load или опросом до TG_WAIT мс): внутри Telegram — его «Назад», цвета, ready;
  // в обычном браузере (платформа unknown, параметров запуска нет) — ничего, витрина остаётся витриной
  const TG_WAIT = 10000;
  function attachTelegram() {
    if (tg) return true;
    const w = window.Telegram && window.Telegram.WebApp;
    if (!w) return false;
    settleTelegram();                               // скрипт прочёл параметры запуска — # снова наш
    tgChecked = true;
    const platform = w.platform && w.platform !== "unknown" ? w.platform : LAUNCH_PLATFORM;
    if (!platform && !w.initData) {                 // скрипт есть, но это не Telegram — ждать больше нечего
      render();
      return true;
    }
    tg = w;
    inTelegram = true;
    detectLang();
    document.documentElement.classList.add("in-telegram");
    try {
      tg.ready();
      tg.expand();
      if (tg.isVersionAtLeast && tg.isVersionAtLeast("6.1")) {    // тёмное оформление партнёра — и в светлом Telegram
        tg.setHeaderColor("#090909");
        tg.setBackgroundColor("#090909");
      }
      tg.BackButton?.onClick(back);
    } catch {}
    render();
    return true;
  }
  function waitTelegram() {
    if (attachTelegram()) return;
    document.querySelector('script[src*="telegram-web-app.js"]')?.addEventListener("load", attachTelegram);
    const started = Date.now();
    const timer = setInterval(() => {
      if (attachTelegram()) clearInterval(timer);
      else if (Date.now() - started > TG_WAIT) {      // скрипт не пришёл — дальше обычной витриной
        clearInterval(timer);
        settleTelegram();
        tgChecked = true;
        render();
      }
    }, 100);
  }

  function boot() {
    render();
    waitTelegram();
    // цены — со своего адреса (тот же prices.json, что у сайта); не загрузились — без чисел, цена в боте
    fetch("../prices.json?v=6", { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((prices) => { P = prices; render(); }, () => {});
  }
  boot();
})();
