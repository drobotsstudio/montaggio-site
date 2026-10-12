/* Mini App Montaggio. Промпт 83 — интерфейс партнёра (montaggio-miniapp, 10.10.2026) без имитаций: Монтаж, Нейромонтаж
   и Пресет собираются здесь и оформляются в боте кодом заказа ?start=w1-… (README сайта, «Код заказа» и «Mini App»).
   Промпт 91 — тренды: каталог, заказ с фото или пресетом, оплата и результат — внутри приложения через сервер приёма
   заказов (montaggio-server/API.md). Приложение ничего не решает о деньгах: цену, номер заказа и ссылки оплаты
   показывает из ответа сервера, который получил их от бота. Сеть: свой адрес (prices.json, ролики трендов),
   https://api.montaggio.shop (initData — только в заголовке) и скрипт Telegram. */
(() => {
  "use strict";
  const BOT = "Montaggio_bot";
  const BOT_URL = "https://t.me/Montaggio_bot";
  const API = "https://api.montaggio.shop";
  // Telegram: скрипт telegram.org грузится async (медленный или недоступный не держит страницу) — приложение сразу
  // работает витриной со ссылкой на бота, а поведение Telegram подключает attachTelegram(), когда скрипт появился.
  // Признак «внутри Telegram» — платформа (у кнопки клавиатуры initData пустая): из скрипта или из параметров запуска
  // в адресе (#tgWebAppPlatform=…, их Telegram ставит после #; запоминаем до первой смены # маршрутом)
  const START_HASH = location.hash.startsWith("#/") ? "" : location.hash.slice(1);
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
      nav: ["Главная", "Тренды", "Изменить", "Персонаж", "Профиль"],
      homeTitle: ["Какое видео", "сделаем?"], homeSub: "Повторите тренд со своим лицом — или измените своё видео.",
      tileEdit: ["Изменить видео", "Смонтировать своё или изменить нейросетью"],
      tileTrend: ["Повторить тренд", "Ваше лицо в готовом трендовом ролике"],
      trends: "Тренды", trendsHint: "Листайте и выбирайте", allTrends: "Все тренды",
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
      askTitle: "Фото для ролика", optPhotos: "Фото", next: "Дальше", yourFace: "Ваше лицо", presetPhotos: "Ваши фото",
      presetUse: "Возьмём ваш последний пресет персонажа — фото для этого героя не нужны.", noPreset: "Нет пресета? Сделать",
      errMin: "Добавьте фото: {label}.",
      photosHint: "1–8 фото, где хорошо видно лицо: свет спереди, без очков и масок. Можно себя, своего ребёнка или человека, который согласился. Чужие фото без согласия — нельзя.",
      presetHint: "1–3 фото: вы, ваш ребёнок или человек, который согласился. Чужие фото без согласия — нельзя. Нейросеть нарисует лист персонажа — портрет, поворот в полный рост, лицо, эмоции, позы — за 5–7 минут после оплаты.",
      addPhoto: "Добавить фото", removePhoto: "Убрать фото",
      send: "Отправить", sending: "Отправляем… {p}%", sent: "Отправлено",
      errCount: "Можно не больше {n} фото.", errSize: "Фото больше 10 МБ: {name}", errTotal: "Все фото вместе — не больше 40 МБ.",
      errType: "Это не фото: {name}", errNet: "Нет связи с сервером — попробуйте ещё раз.",
      errUpload: "Файлы слишком большие или связь прервалась — попробуйте фото поменьше.",
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
    },
    en: {
      nav: ["Home", "Trends", "Edit", "Character", "Profile"],
      homeTitle: ["What video", "shall we make?"], homeSub: "Repeat a trend with your face — or edit your own video.",
      tileEdit: ["Edit a video", "Cut your own or change it with AI"],
      tileTrend: ["Repeat a trend", "Your face in a ready trending video"],
      trends: "Trends", trendsHint: "Swipe and pick", allTrends: "All trends",
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
      askTitle: "Photos for the video", optPhotos: "Photos", next: "Next", yourFace: "Your face", presetPhotos: "Your photos",
      presetUse: "We'll use your latest character preset — no photos needed for this person.", noPreset: "No preset? Make one",
      errMin: "Add photos: {label}.",
      photosHint: "1–8 photos with a clearly visible face: light from the front, no glasses or masks. You, your child or a person who agreed. Other people's photos without consent are not allowed.",
      presetHint: "1–3 photos: you, your child or a person who agreed. Other people's photos without consent are not allowed. The AI will draw a character sheet — portrait, full-length turnaround, face, emotions, poses — in 5–7 minutes after payment.",
      addPhoto: "Add photos", removePhoto: "Remove photo",
      send: "Send", sending: "Sending… {p}%", sent: "Sent",
      errCount: "No more than {n} photos.", errSize: "Photo larger than 10 MB: {name}", errTotal: "All photos together — no more than 40 MB.",
      errType: "Not a photo: {name}", errNet: "No connection to the server — please try again.",
      errUpload: "The files are too large or the connection dropped — try smaller photos.",
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
    },
    it: {
      nav: ["Home", "Trend", "Modifica", "Personaggio", "Profilo"],
      homeTitle: ["Che video", "facciamo?"], homeSub: "Ripeti un trend con il tuo volto — o modifica il tuo video.",
      tileEdit: ["Modifica un video", "Monta il tuo o cambialo con l'IA"],
      tileTrend: ["Ripeti un trend", "Il tuo volto in un video di tendenza"],
      trends: "Trend", trendsHint: "Scorri e scegli", allTrends: "Tutti i trend",
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
      askTitle: "Foto per il video", optPhotos: "Foto", next: "Avanti", yourFace: "Il tuo volto", presetPhotos: "Le tue foto",
      presetUse: "Useremo il tuo ultimo preset del personaggio — per questa persona non servono foto.", noPreset: "Nessun preset? Crealo",
      errMin: "Aggiungi foto: {label}.",
      photosHint: "1–8 foto con il volto ben visibile: luce frontale, senza occhiali né mascherine. Tu, tuo figlio o una persona che ha acconsentito. Foto di altri senza consenso — no.",
      presetHint: "1–3 foto: tu, tuo figlio o una persona che ha acconsentito. Foto di altri senza consenso — no. L'IA disegnerà la scheda del personaggio — ritratto, giro completo, volto, emozioni, pose — in 5–7 minuti dopo il pagamento.",
      addPhoto: "Aggiungi foto", removePhoto: "Rimuovi foto",
      send: "Invia", sending: "Invio… {p}%", sent: "Inviato",
      errCount: "Non più di {n} foto.", errSize: "Foto oltre 10 MB: {name}", errTotal: "Tutte le foto insieme — non più di 40 MB.",
      errType: "Non è una foto: {name}", errNet: "Nessuna connessione al server — riprova.",
      errUpload: "File troppo grandi o connessione interrotta — prova con foto più piccole.",
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

  // «Монтаж» — клиенту только стандартные пункты (В100): номер → название и пояснение, как в боте
  const MONTAGE_ITEMS = [
    [1, "Вырезать паузы", "Тишина между фразами — долой."],
    [2, "Слова-паразиты", "«ээ», «ну», «как бы»."],
    [3, "Дубли и оговорки", "Без потери смысла."],
    [14, "Чистый голос", "Убрать шум, выровнять громкость."],
  ];
  const NEURO_MODES = [
    ["redraw", "🎨 Перерисовка", "Нейросеть перерисует весь ролик: стиль, фон, свет, одежду."],
    ["replace", "🔁 Замена", "Персонаж или предмет в видео — на ваш образец."],
    ["motion", "🕺 Перенос движения", "Персонаж с картинки повторит ваши движения и жесты."],
  ];
  // режимы нейромонтажа в архиве — на экране не показываются, код, цена и тексты на месте; вернуть — убрать из списка.
  // motion — архив, владелец 13.10 — вместо него будут Стили Higgsfield (в боте скрыт с 12.10)
  const HIDDEN_MODES = ["motion"];
  const neuroModeOk = (m) => !!NEURO_CODES[m] && !HIDDEN_MODES.includes(m);
  const PRESET_STYLES = [["real", "📷 Реализм"], ["cartoon", "🎨 Мультфильм"], ["anime", "🌸 Аниме"], ["3d", "🧸 3D"]];
  const QUALITIES = ["480p", "720p", "1080p"];
  const MONTAGE_SECONDS = [15, 30, 45, 60, 90, 120, 180];
  const SHORT_SECONDS = [4, 5, 6, 8, 10, 12, 15, 20, 30];
  const KIND_NAMES = { montage: "🎬 Монтаж", neuro: "🪄 Нейромонтаж", preset: "🧩 Пресет персонажа" };

  function newDraft(kind) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (kind === "montage") return { id, kind, sec: 60, clips: 1, opts: STANDARD.slice() };
    if (kind === "neuro") return { id, kind, mode: "redraw", sec: 10, q: "720p" };
    return { id, kind: "preset", style: "real" };
  }
  // черновик из хранилища — только известные значения (хранилище мог испортить кто угодно на этом устройстве);
  // черновики старых трендов партнёра (kind aivideo) больше не открываются — отбрасываются
  function cleanDraft(d) {
    if (!d || typeof d !== "object" || !KIND_NAMES[d.kind]) return null;
    const base = newDraft(d.kind);
    base.id = typeof d.id === "string" && /^[a-z0-9]{1,24}$/.test(d.id) ? d.id : base.id;
    base.updated = Number(d.updated) || Date.now();
    if (d.kind === "montage") {
      if (MONTAGE_SECONDS.includes(d.sec)) base.sec = d.sec;
      if (Number.isInteger(d.clips) && d.clips >= 1 && d.clips <= 10) base.clips = d.clips;
      if (Array.isArray(d.opts)) base.opts = STANDARD.filter((n) => d.opts.includes(n));
    } else if (d.kind === "neuro") {
      if (neuroModeOk(d.mode)) base.mode = d.mode;            // архивный режим — «Перерисовка»
      if (SHORT_SECONDS.includes(d.sec)) base.sec = d.sec;
      if (QUALITIES.includes(d.q)) base.q = d.q;
    } else if (STYLE_CODES[d.style]) base.style = d.style;
    return base;
  }
  // свой заказ тренда/пресета (91): только номер, вид и тренд — чтобы вернуться к экрану заказа; 24 ч
  const ORDER_ID = /^[0-9a-f]{32}$/;
  const TREND_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const ORDER_TTL = 24 * 3600 * 1000;
  function cleanOrder(o) {
    if (!o || typeof o !== "object" || typeof o.id !== "string" || !ORDER_ID.test(o.id) || !["trend", "preset"].includes(o.kind))
      return null;
    const at = Number(o.at);
    if (!(at > Date.now() - ORDER_TTL && at <= Date.now() + 60000)) return null;
    return { id: o.id, kind: o.kind, trend: typeof o.trend === "string" && TREND_ID.test(o.trend) ? o.trend : "",
      preset: o.preset === 1 ? 1 : 0, at,
      st: typeof o.st === "string" && /^[a-z_]{1,16}$/.test(o.st) ? o.st : "" };
  }
  // на главной — заказы, которые ещё идут или готовы (результат живёт 24 ч); отменённые и отказы — нет
  const SHOWN = new Set(["", "new", "picked", "quoted", "needs_consent", "paid", "working", "done"]);

  // --- хранилище этого устройства ---
  const storageKey = "montaggio-app-v1";
  let drafts = [], myOrders = [], trendsExpanded = true;
  try {
    const s = JSON.parse(localStorage.getItem(storageKey) || "{}");
    drafts = (Array.isArray(s.drafts) ? s.drafts : []).map(cleanDraft).filter(Boolean).slice(0, 8);
    myOrders = (Array.isArray(s.orders) ? s.orders : []).map(cleanOrder).filter(Boolean).slice(0, 5);
    trendsExpanded = s.trendsExpanded !== false;
  } catch {}
  let storageWarned = false;
  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ drafts, orders: myOrders, trendsExpanded }));
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
      x.timeout = 180000;
      x.upload.addEventListener("progress", (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); });
      x.addEventListener("load", () => {
        let body = null;
        try { body = JSON.parse(x.responseText); } catch {}
        if (x.status === 200 && body && ORDER_ID.test(body.order_id)) resolve(body.order_id);
        else reject(new ApiError(x.status, body));
      });
      // сеть оборвалась во время заливки — или nginx отказал по размеру (413 без CORS браузер показывает как обрыв)
      const fail = () => reject(new ApiError(0, form.has("photo[]") ? { message: T("errUpload") } : null));
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

  // --- маршруты ---
  // # без «/» — параметры запуска Telegram (#tgWebAppData=…), не маршрут: главная. Пока скрипт Telegram их не прочёл
  // (tgSettled), маршрут живёт в памяти (memRoute), а # не трогаем — иначе скрипт не узнает initData и версию
  let tgSettled = !START_HASH, memRoute = null;
  const route = () => memRoute !== null ? memRoute
    : location.hash.startsWith("#/") ? location.hash.slice(2) || "home" : "home";
  const FLOW = { "edit/montage": "montage", "edit/neuro": "neuro", preset: "preset" };
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
    }
  }
  function parentOf(r) {
    if (r.startsWith("trend/")) return "trends";
    if (r.startsWith("who/")) return "trend/" + r.slice(4);
    if (r === "preset-new") return presetReturn ? "who/" + presetReturn : "trends";
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
    draft = d;
    nav(d.kind === "preset" ? "preset" : "edit/" + d.kind);
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
      ["home", "home"], ["trends", "spark"], ["edit", "sliders"], ["preset", "layers"], ["profile", "user"],
    ].map(([to, ic], i) => {
      const on = r === to || r.startsWith(to + "/") || (to === "trends" && /^(trend|who|order)\/|^preset-new$/.test(r))
        || (to === "profile" && r === "drafts");
      return `<a href="#/${to}" class="nav-item ${on ? "current" : ""}" ${r === to ? 'aria-current="page"' : ""}>${icon(ic)}<span>${esc(labels[i])}</span></a>`;
    }).join("");
  }
  function draftTitle(d) {
    return KIND_NAMES[d.kind].replace(/^\S+\s/, "");
  }
  function draftLine(d) {
    if (d.kind === "montage") return `${d.clips} видео · до ${secText(d.sec)}`;
    if (d.kind === "neuro") return `${NEURO_MODES.find((m) => m[0] === d.mode)[1]} · ${d.sec} сек · ${d.q}`;
    return PRESET_STYLES.find((s) => s[0] === d.style)[1];
  }
  const draftCard = (d) =>
    `<button class="continue-card" data-action="resume" data-id="${d.id}"><span class="continue-icon">${icon(d.kind === "preset" ? "user" : "video")}</span><span><strong>${esc(draftTitle(d))}</strong><small>${esc(draftLine(d))} · черновик</small></span>${icon("arrow")}</button>`;
  function continueCards() {
    if (!drafts.length) return "";
    return `<section class="continue-section" aria-label="Черновики"><div class="section-heading"><h2>Продолжить</h2><span class="saved-label">${icon("check")}Сохранено здесь</span></div><div class="draft-list">${drafts.slice(0, 3).map(draftCard).join("")}</div></section>`;
  }
  const secText = (s) => s < 60 ? `${s} сек` : `${Math.floor(s / 60)} мин` + (s % 60 ? ` ${s % 60} сек` : "");

  // --- тренды (91): карточки с готовым видео, ролики — со своего адреса по id ---
  const media = (id, kind) => `trends/${encodeURIComponent(id)}/${kind}`;
  const REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function videoEl(id, kind, { controls = false, lazy = true } = {}) {
    const v = el("video", { class: "tvideo", poster: media(id, kind + ".webp"), preload: lazy ? "none" : "metadata",
      playsinline: true, "webkit-playsinline": true, loop: true, disablepictureinpicture: true, controls: controls || REDUCED,
      "aria-label": T("result") });
    v.muted = true;
    v.defaultMuted = true;
    v.dataset.src = media(id, kind + ".mp4");
    v.dataset.auto = REDUCED ? "0" : "1";
    return v;
  }
  function priceFrom(t) {
    const p = t.prices[qualitiesOf(t)[0]];
    return T("from", { p: money(p.rub, p.stars) });
  }
  function trendCard(t, size) {
    return el("article", { class: `tcard ${size}` },
      el("button", { class: "tcard-open", type: "button", data: { action: "trend", id: t.id }, "aria-label": trendName(t) },
        el("span", { class: "tmedia" }, videoEl(t.id, "result"),
          t.seconds ? el("span", { class: "duration", icon: "play" }, T("sec", { n: t.seconds })) : null),
        el("h3", { text: trendName(t) }),
        el("span", { class: "tprice", text: priceFrom(t) })));
  }
  function trendsState(compact) {
    if (catalogState === "ok") return null;
    if (catalogState === "down")
      return el("div", { class: "trends-down" + (compact ? " compact" : "") },
        el("div", {}, el("h3", { text: T("downTitle") }), el("p", { text: T("downText") })),
        btn(T("openBot"), "open-bot", "secondary small", {}, "send"));
    return el("div", { class: "trends-loading", role: "status" }, el("span", { class: "spinner" }), T("loading"));
  }
  function carousel(size) {
    return el("div", { class: `tcarousel ${size}`, "aria-label": T("trends") }, catalog.map((t) => trendCard(t, size)));
  }
  function homeTrends() {
    const state = trendsState(true);
    if (state) return state;
    return el("div", {}, carousel("small"),
      el("div", { class: "carousel-footer" }, el("span", { text: T("trendsHint") }),
        btn(T("allTrends"), "nav", "secondary small", { to: "trends" }, "arrow")));
  }
  function homeOrders() {
    const list = myOrders.filter((o) => SHOWN.has(o.st || "")).slice(0, 2);
    if (!list.length) return null;
    return el("section", { class: "continue-section", "aria-label": T("myOrders") },
      el("div", { class: "section-heading" }, el("h2", { text: T("myOrders") })),
      el("div", { class: "draft-list" }, list.map((o) => {
        const t = trendById(o.trend);
        const name = o.kind === "preset" ? T("orderPreset") : T("orderTrend", { t: t ? trendName(t) : "…" });
        return el("button", { class: "continue-card", type: "button", data: { action: "nav", to: "order/" + o.id } },
          el("span", { class: "continue-icon", icon: o.kind === "preset" ? "user" : "spark" }),
          el("span", {}, el("strong", { text: name }), el("small", { text: "№ " + o.id.slice(0, 6) + " · " + T("orderOpen") })),
          el("span", { icon: "arrow", class: "continue-arrow" }));
      })));
  }
  function trendsPage() {
    return el("div", {}, el("div", { class: "page-head" }, el("div", {}, el("h1", { text: T("trends") }), el("p", { text: T("trendsSub") }))),
      trendsState(false) || carousel("large"));
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
    const pair = el("figure", { class: "sample" }, el("span", { class: "tmedia" }, videoEl(t.id, "result", { lazy: false }),
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
    if (!t) return [{ key: "P", kind: "face", preset: false, min: 1, max: 3, labels: one(T("presetPhotos")),
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
  let photos = { key: "", blocks: {}, preset: false, groupOpen: false };
  const listOf = (k) => photos.blocks[k] || (photos.blocks[k] = []);
  const allPhotos = () => Object.values(photos.blocks).flat();
  const usesPreset = (b) => b.preset && photos.preset;
  const countOf = (b) => usesPreset(b) ? 0 : listOf(b.key).length;
  function clearPhotos() {
    allPhotos().forEach((p) => p.url && URL.revokeObjectURL(p.url));
    photos = { key: "", blocks: {}, preset: false, groupOpen: false };
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
      el("div", { class: "photo-grid" },
        list.map((p, i) => el("div", { class: "photo-thumb" },
          p.url ? el("img", { src: p.url, alt: "" }) : el("span", { class: "photo-noprev", icon: "camera" }),
          el("button", { class: "photo-remove", type: "button", data: { action: "photo-remove", key: p.key },
            "aria-label": `${T("removePhoto")} ${i + 1}`, icon: "x" }))),
        list.length < b.max ? el("label", { class: "photo-add", for: id }, el("span", { icon: "plus" }),
          el("small", { text: T("addPhoto") })) : null));
    return el("section", { class: "ask-block" + (b.group ? " item" : "") }, parts);
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
    const send = btn(t ? T("next") : T("send"), "send-photos", "primary full", {}, t ? "arrow" : "send");
    send.id = "send-photos";
    const node = el("div", { class: "photo-page" },
      pageTopEl(t ? T("askTitle") : T("presetTitle"), t ? summaryLine(t) : T("presetSub")),
      plain.map((b) => blockEl(b, t)), group,
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
    if (t) form.append("counts", ask.map(countOf).join(","));
    let n = 0;
    for (const b of ask) if (!usesPreset(b)) listOf(b.key).forEach((p) => form.append("photo[]", p.file, `photo${++n}`));
    sending = true;
    updateSend();
    const bar = $("#upload-bar"), fill = bar && bar.firstChild, sendBtn = $("#send-photos");
    const label = sendBtn ? sendBtn.lastChild.textContent : "";
    if (bar) bar.hidden = !n;
    showError("");
    try {
      const id = await postOrder(form, (f) => {
        if (fill) fill.style.width = Math.round(f * 100) + "%";
        if (sendBtn && n) sendBtn.lastChild.textContent = T("sending", { p: Math.round(f * 100) });
      });
      clearPhotos();
      rememberOrder({ id, kind: t ? "trend" : "preset", trend: t ? t.id : presetReturn, preset: usePreset ? 1 : 0, at: Date.now() });
      sending = false;
      nav("order/" + id);
    } catch (e) {
      sending = false;
      if (bar) bar.hidden = true;
      if (sendBtn) sendBtn.lastChild.textContent = label;
      updateSend();
      showError(e.message);
    }
  }

  // --- экран заказа (91): опрос раз в 2,5 с, пока окно видно; всё о деньгах — из ответа сервера ---
  const LIVE = new Set(["new", "picked", "quoted", "needs_consent", "paid", "working"]);
  const CANCELABLE = new Set(["new", "picked", "quoted", "needs_consent"]);
  const STATUSES = new Set([...LIVE, "rejected", "review", "done", "cancelled"]);
  let view = { id: "", data: null, gone: false, offline: false, paying: false };
  let pollTimer = 0, pollBusy = false;
  function cleanStatus(b) {
    if (!b || typeof b !== "object" || !STATUSES.has(b.status)) return null;
    const pay = b.pay && typeof b.pay === "object" ? b.pay : {};
    const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
    const no = int(b.order_no) ?? (typeof b.order_no === "string" && /^\d{1,10}$/.test(b.order_no) ? b.order_no : null);
    return { status: b.status, price_rub: int(b.price_rub), price_stars: int(b.price_stars), order_no: no,
      rub_url: str(pay.rub_url, 2048), stars_link: str(pay.stars_link, 2048),
      message: str(b.message, 4000).trim(), result_url: str(b.result_url, 2048) };
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
    try {
      const data = cleanStatus(await api("/api/orders/" + id));
      if (view.id !== id) return;
      const before = JSON.stringify(view.data) + view.offline;
      view.offline = false;
      if (data) {
        view.data = data;
        const mine = myOrders.find((o) => o.id === id);
        if (mine && mine.st !== data.status) { mine.st = data.status; persist(); }
      }
      if (before !== JSON.stringify(view.data) + view.offline) render();
      if (!data || LIVE.has(data.status)) schedulePoll();
    } catch (e) {
      if (view.id !== id) return;
      if (e.status === 404) {
        view.gone = true;
        forgetOrder(id);
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
      view = { id, data: null, gone: false, offline: false, paying: false, error: "" };
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
    const preset = meta.kind === "preset";
    const d = view.data;
    const box = el("div", { class: "status-card" });
    const head = (title, spinner) => box.append(el("div", { class: "status-head" },
      spinner ? el("span", { class: "spinner" }) : null, el("h1", { text: title })));
    const msg = () => d && d.message ? box.append(el("p", { class: "status-message", text: d.message })) : null;
    const actions = el("div", { class: "status-actions" });
    if (view.gone) {
      head(T("notFound"));
      actions.append(btn(T("toTrends"), "nav", "primary full", { to: "trends" }));
    } else if (!d) {
      head(preset ? T("checkingPreset") : T("checking"), true);
    } else if (d.status === "new" || d.status === "picked") {
      head(preset ? T("checkingPreset") : T("checking"), true);
    } else if (d.status === "quoted") {
      // «Заказ №N · сумма»: номер — order_no бота, сумма — из ответа (₽ только ru); номера нет — только сумма
      const sum = LANG === "ru" && d.price_rub ? rub(d.price_rub) : d.price_stars ? stars(d.price_stars) : "";
      const title = [d.order_no !== null ? T("orderNo", { n: d.order_no }) : T("toPay"), sum].filter(Boolean).join(" · ");
      head(view.paying ? T("payCheck") : title, view.paying);
      msg();
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
    } else if (d.status === "needs_consent") {
      head(T("consent"));
      msg();
      actions.append(btn(T("openBot"), "open-bot", "primary full", {}, "send"));
    } else if (d.status === "rejected") {
      head(T("rejected"));
      msg();
      if (preset) actions.append(btn(T("changePhoto"), "nav", "primary full", { to: "preset-new" }, "camera"));
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
      else actions.append(btn(T("toTrends"), "nav", preset ? "primary full" : "ghost full", { to: "trends" }));
    } else if (d.status === "cancelled") {
      head(T("cancelled"));
      actions.append(btn(T("toTrends"), "nav", "primary full", { to: "trends" }));
    }
    if (view.offline) box.append(el("p", { class: "status-note offline", text: T("retry") }));
    if (!view.gone && (!d || CANCELABLE.has(d.status)))
      actions.append(btn(T("cancel"), "cancel-order", "ghost full"));
    const face = el("div", { class: "status-monti" });
    face.insertAdjacentHTML("afterbegin", monti("m"));               // свой Монти, без данных сервера
    return el("div", { class: "order-page" }, face, box, actions);
  }
  async function pay(kind) {
    const d = view.data;
    if (!d || d.status !== "quoted" || !tg) return;
    if (kind === "rub" && payHost(d.rub_url)) {
      tg.openLink(d.rub_url);                       // ЮKassa — во внешнем браузере; вернувшись, опрос подхватит
      view.paying = true;
      render();
    } else if (kind === "stars" && starsOk(d.stars_link)) {
      if (tg.openInvoice && tg.isVersionAtLeast && tg.isVersionAtLeast("6.1")) {
        tg.openInvoice(d.stars_link, (status) => {
          if (status === "paid") { view.paying = true; render(); schedulePoll(500); }
        });
      } else tg.openTelegramLink(d.stars_link);
    }
  }
  async function cancelOrder() {
    const id = view.id;
    closeModal();
    try {
      const b = await api(`/api/orders/${id}/cancel`, { method: "POST" });
      if (b && b.status === "cancelled" && view.id === id && view.data) view.data.status = "cancelled";
      else if (view.id === id) view.data = { ...(view.data || {}), status: "cancelled" };
      const mine = myOrders.find((o) => o.id === id);
      if (mine) { mine.st = "cancelled"; persist(); }
      stopPoll();
      render();
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
    const [h1, h2] = T("homeTitle"), [e1, e2] = T("tileEdit"), [r1, r2] = T("tileTrend");
    return `<div class="page-head welcome"><div><h1>${esc(h1)}<br>${esc(h2)}</h1><p>${esc(T("homeSub"))}</p></div><div class="welcome-monti">${monti("l")}</div></div>
<div data-mount="orders"></div>
${continueCards()}
<div class="product-switch"><button class="product-tile" data-action="nav" data-to="edit">${icon("sliders")}<div><span>${esc(e1)}</span><small>${esc(e2)}</small></div>${icon("arrow")}</button><button class="product-tile active" data-action="nav" data-to="trends">${icon("spark")}<div><span>${esc(r1)}</span><small>${esc(r2)}</small></div>${icon("arrow")}</button></div>
<div class="section-heading"><div><h2>${esc(T("trends"))}</h2><p class="section-hint">${esc(T("trendsHint"))}</p></div><button class="text-button" data-action="toggle-trends" aria-expanded="${trendsExpanded}" aria-controls="home-trends">${trendsExpanded ? "Свернуть" : "Показать"} ${icon(trendsExpanded ? "x" : "plus")}</button></div>
${trendsExpanded ? '<div id="home-trends" data-mount="home-trends"></div>' : ""}
<div class="onboarding-strip">${monti("s")}<div><h3>Свой персонаж</h3><p>Лист персонажа по вашим фото — для нейромонтажа и своих проектов.</p></div>${button("Пресет", "nav", "secondary small", 'data-to="preset"', "plus")}</div>`;
  }
  const MOUNTS = { "home-trends": homeTrends, orders: homeOrders };

  function editLanding() {
    return `<div class="editor-landing">${pageTop("Изменить видео", "Что сделать с вашим видео?")}<div class="service-pick"><button class="product-tile active" data-action="start" data-kind="montage">${icon("scissors")}<div><span>🎬 Монтаж</span><small>Вырежем паузы, слова-паразиты и дубли, почистим голос</small></div>${icon("arrow")}</button><button class="product-tile" data-action="start" data-kind="neuro">${icon("spark")}<div><span>🪄 Нейромонтаж</span><small>Новый стиль, фон или персонаж — нейросеть перерисует видео</small></div>${icon("arrow")}</button></div><p class="bottom-note">Видео пришлёте в чате с ботом — приложение его не загружает.</p></div>`;
  }
  const chips = (action, items, current) =>
    `<div class="choice-row">${items.map(([v, label]) => `<button class="choice ${v === current ? "selected" : ""}" data-action="${action}" data-value="${esc(v)}" aria-pressed="${v === current}">${esc(label)}</button>`).join("")}</div>`;
  const select = (id, values, current, label) =>
    `<select id="${id}">${values.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${label(v)}</option>`).join("")}</select>`;

  function montageFields(d) {
    return `<h2>🎬 Монтаж</h2><p>Стандартный монтаж — всё включено, лишнее можно снять.</p>${MONTAGE_ITEMS.map(([n, name, hint]) => {
      const on = d.opts.includes(n);
      return `<div class="edit-option ${on ? "selected" : ""}"><button class="option-title" data-action="opt" data-value="${n}" aria-pressed="${on}"><b class="opt-num">${n}</b><span>${name}<small class="opt-hint">${hint}</small></span><i class="switch" aria-hidden="true"></i></button></div>`;
    }).join("")}<div class="field"><label for="m-sec">Длина видео — примерно</label>${select("m-sec", MONTAGE_SECONDS, d.sec, (v) => "до " + secText(v))}<small>Всех видео вместе — до 3 минут.</small></div><div class="field"><span class="field-label">Сколько видео склеить</span><div class="stepper"><button data-action="clips" data-value="-1" aria-label="Меньше">−</button><output id="m-clips">${d.clips}</output><button data-action="clips" data-value="1" aria-label="Больше">+</button></div></div>`;
  }
  function neuroFields(d) {
    const mode = NEURO_MODES.find((m) => m[0] === d.mode);
    return `<h2>🪄 Нейромонтаж</h2><p>${mode[2]}</p><div class="field"><span class="field-label">Режим</span>${chips("mode", NEURO_MODES.filter((m) => neuroModeOk(m[0])), d.mode)}</div><div class="field"><label for="n-sec">Длина видео</label>${select("n-sec", SHORT_SECONDS, d.sec, (v) => v + " сек")}</div><div class="field"><span class="field-label">Качество</span>${chips("q", QUALITIES.map((q) => [q, q]), d.q)}</div>`;
  }
  function presetFields(d) {
    return `<h2>🧩 Пресет персонажа</h2><p>Лист персонажа — портрет, поворот в полный рост, лицо, эмоции, позы — и файлы без фона: по ним нейросеть держит внешность в нейромонтаже.</p><div class="field"><span class="field-label">Стиль</span>${chips("style", PRESET_STYLES, d.style)}</div>`;
  }
  // что будет в боте — честно: что прислать и где цена
  function botSteps(d) {
    if (d.kind === "montage")
      return [`Пришлите ${d.clips > 1 ? d.clips + " видео одним альбомом" : "видео"} в чат с ботом.`, "Бот проверит длину и покажет точную цену.", "Оплата — в боте, потом готовое видео придёт туда же."];
    if (d.kind === "neuro")
      return ["Бот откроет выбранный режим — пришлите видео и, если режим просит, промпт или образец.", "Точная цена — в карточке после видео.", "Оплата — в боте, результат придёт туда же."];
    return ["Фото или описание персонажа пришлёте в чате с ботом — из приложения фото не передаются.", "Бот покажет цену до оплаты.", "Лист персонажа и файлы придут в чат."];
  }
  function flowPage(kind) {
    if (!draft || draft.kind !== kind) draft = drafts.find((x) => x.kind === kind) || newDraft(kind);
    const d = draft;
    const fields = kind === "montage" ? montageFields(d) : kind === "neuro" ? neuroFields(d) : presetFields(d);
    const title = kind === "preset" ? "Свой персонаж" : "Изменить видео";
    const body = `<div class="fields solo">${fields}${priceBlock(d)}<ol class="bot-steps">${botSteps(d).map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div id="flow-error" class="form-error" role="alert"></div><div class="workflow-actions">${ctaHtml(d)}</div></div>`;
    return `<div class="workflow">${pageTop(title, "Черновик сохраняется на этом устройстве")}${body}</div>`;
  }
  function priceBlock(d) {
    const price = priceFor(d);
    if (price === null)
      return `<div class="quote-hint">${icon("info")}Точную цену бот покажет до оплаты.</div>`;
    const note = d.kind === "montage" ? "Бот проверит длину и покажет точную цену до оплаты." : "Примерная цена. Точная — в боте перед оплатой.";
    return `<div class="price-card"><span>${KIND_NAMES[d.kind]}</span><strong id="price">≈ ${rub(price)}</strong><small>${note}</small></div>`;
  }
  function ctaLabel(d) {
    const price = priceFor(d);
    return "Оформить в боте" + (price === null ? "" : ` · ≈ ${rub(price)}`);
  }
  const botUrl = (d) => "https://t.me/Montaggio_bot?start=" + encode(d);
  function ctaHtml(d) {
    const bad = d.kind === "montage" && !d.opts.length;
    if (inTelegram || bad) return button(ctaLabel(d), "order", "primary full", bad ? "disabled" : "", "send");
    return `<a class="button primary full" href="${esc(botUrl(d))}" data-action="order-link">${icon("send")}${esc(ctaLabel(d))}</a>`;
  }
  function order() {
    const d = draft;
    if (!d) return;
    if (d.kind === "montage" && !d.opts.length) {
      $("#flow-error").textContent = "Оставьте хотя бы один пункт монтажа.";
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
    return `<div class="profile-page"><div class="profile-header">${monti("s")}<div><h1>Ваше пространство</h1><p>Черновики — только на этом устройстве</p></div></div>${[
      ["layers", "Черновики", `${drafts.length} не оформлено`, "nav", "drafts"],
      ["info", "Как это работает", "Приложение, бот и оплата", "help", ""],
      ["user", "Данные", "Что хранится и что куда уходит", "about", ""],
    ].map(([ic, title, sub, a, to]) => `<button class="profile-row" data-action="${a}" ${to ? `data-to="${to}"` : ""}>${icon(ic)}<span><strong>${title}</strong><small>${sub}</small></span>${icon("chevron")}</button>`).join("")}<button class="text-button" data-action="reset">Стереть данные на этом устройстве ${icon("reset")}</button></div>`;
  }
  function draftsPage() {
    return `${pageTop("Черновики", "Не оформленные заказы — на этом устройстве.")}${drafts.length ? `<div class="draft-list">${drafts.map((d) => `<div class="draft-row">${draftCard(d)}<button class="icon-button" data-action="drop" data-id="${d.id}" aria-label="Удалить черновик">${icon("trash")}</button></div>`).join("")}</div>` : `<div class="empty-state">${monti("xl")}<h2>Черновиков нет</h2><p>Начатый заказ сохранится здесь, пока вы не оформите его в боте.</p>${button("К трендам", "nav", "primary", 'data-to="trends"')}</div>`}`;
  }
  function waitCatalog() {
    return trendsState(false) || trendsPage();       // такого тренда в каталоге уже нет — весь каталог
  }

  const TREND_FLOW = /^(trends|trend\/|who\/|preset-new|order\/)/;
  function render() {
    navBar();
    const r = route();
    if (!r.startsWith("order/")) stopPoll();
    if (!/^(who\/|preset-new)/.test(r) && photos.key && !sending) clearPhotos();
    if (TREND_FLOW.test(r) || r === "home") {
      const retry = catalogState === "down" && inTelegram && Date.now() - catalogAt > 30000;
      if ((catalogState === "idle" || retry) && tgChecked) loadTrends();
    }
    let out;
    const tid = r.replace(/^(trend|who)\//, "");
    if (r === "trends") out = trendsPage();
    else if (/^(trend|who)\//.test(r)) {
      const t = trendById(tid);
      out = !t ? waitCatalog() : r.startsWith("trend/") ? trendPage(t) : askPage(t);
    } else if (r === "preset-new") out = askPage(null);
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
    document.title = "Montaggio — " + (TREND_FLOW.test(r) ? T("trends").toLowerCase() : r === "home" ? "приложение" : "заказ");
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
  // ролика нет на своём адресе (новый тренд, ещё не скачан) — карточка без видео, с фоном
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && (t.tagName === "VIDEO" || t.tagName === "IMG") && t.closest(".tmedia")) t.closest(".tmedia").classList.add("no-media");
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
    } else if (a === "make-preset") { presetReturn = trendById(b.dataset.id) ? b.dataset.id : ""; nav("preset-new"); }
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
      if (r === "preset-new") sendOrder(null);
      else if (r.startsWith("who/") && trendById(r.slice(4))) sendOrder(trendById(r.slice(4)));
    } else if (a === "sound") toggleSound(b);
    else if (a === "pay-rub") pay("rub");
    else if (a === "pay-stars") pay("stars");
    else if (a === "open-bot") openBot();
    else if (a === "support") { openBot(); toast(T("supportHint")); }
    else if (a === "cancel-order")
      showModal(esc(T("cancelAsk")), `${button(esc(T("cancelYes")), "confirm-cancel", "primary full")}${button(esc(T("cancelNo")), "close", "ghost full")}`);
    else if (a === "confirm-cancel") cancelOrder();
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
    else if (a === "drop") { dropDraft(b.dataset.id); render(); toast("Черновик удалён."); }
    else if (draft && a === "opt") {
      const n = Number(v);
      draft.opts = draft.opts.includes(n) ? draft.opts.filter((x) => x !== n) : STANDARD.filter((x) => x === n || draft.opts.includes(x));
      changed();
    } else if (draft && a === "clips") { draft.clips = Math.min(10, Math.max(1, draft.clips + Number(v))); changed(); }
    else if (draft && a === "mode" && neuroModeOk(v)) { draft.mode = v; changed(); }
    else if (draft && a === "q" && QUALITIES.includes(v)) { draft.q = v; changed(); }
    else if (draft && a === "style" && STYLE_CODES[v]) { draft.style = v; changed(); }
    else if (a === "order") order();
    else if (a === "help")
      showModal("Как это работает", `${monti("m")}<ul class="sheet-list"><li><strong>Тренды — прямо здесь</strong>Выберите ролик, качество и фото или свой пресет. Цену и оплату покажем в приложении, готовое видео придёт сюда и в чат бота @${BOT}.</li><li><strong>Монтаж и нейромонтаж — в боте</strong>Соберите заказ, кнопка откроет чат с ботом с вашим выбором. Видео пришлёте там.</li><li><strong>Оплата</strong>Цену всегда считает бот и показывает до оплаты.</li></ul>`);
    else if (a === "about")
      showModal("Данные", `<ul class="sheet-list"><li><strong>Что хранится здесь</strong>Черновики и номера ваших заказов трендов — только в этом браузере.</li><li><strong>Фото для тренда</strong>Уходят в Montaggio только для вашего заказа, сроки хранения — в политике конфиденциальности. В браузере не остаются.</li><li><strong>Монтаж и нейромонтаж</strong>В бота уходит только ваш выбор — коротким кодом в ссылке.</li></ul>`);
    else if (a === "reset")
      showModal("Стереть данные?", `<p>Удалятся черновики и номера заказов на этом устройстве.</p>${button("Стереть", "confirm-reset", "primary full")}${button("Оставить", "close", "ghost full")}`);
    else if (a === "confirm-reset") {
      drafts = []; myOrders = []; draft = null;
      try { localStorage.removeItem(storageKey); } catch {}
      closeModal(); render(); toast("Данные на этом устройстве стёрты.");
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
    fetch("../prices.json?v=5", { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((prices) => { P = prices; render(); }, () => {});
  }
  boot();
})();
