/* Mini App Montaggio (промпт 83) — интерфейс партнёра (montaggio-miniapp, 10.10.2026) без имитаций: заказ собирается
   здесь, оформляется и оплачивается в боте. Приложение отдаёт боту только код заказа ?start=w1-… (README сайта, «Код
   заказа» и «Mini App»); цену и права бот считает сам. Сеть: только prices.json со своего адреса и скрипт Telegram.
   Данные клиента (черновики, избранное) — только в этом браузере (localStorage), никуда не отправляются. */
(() => {
  "use strict";
  const BOT = "Montaggio_bot";
  // Telegram: скрипт telegram.org грузится async (медленный или недоступный не держит страницу) — приложение сразу
  // работает витриной со ссылкой на бота, а поведение Telegram подключает attachTelegram(), когда скрипт появился.
  // Признак «внутри Telegram» — платформа (у кнопки клавиатуры initData пустая): из скрипта или из параметров запуска
  // в адресе (#tgWebAppPlatform=…, их Telegram ставит после #; запоминаем до первой смены # маршрутом)
  const START_HASH = location.hash.startsWith("#/") ? "" : location.hash.slice(1);
  const LAUNCH_PLATFORM = new URLSearchParams(START_HASH).get("tgWebAppPlatform") || "";
  let tg = null;
  let inTelegram = false;

  // --- код заказа: тот же формат, что у сайта (order.js); тест бота test_83 берёт этот кусок в node ---
  // <code>
  const STANDARD = [1, 2, 3, 14];
  const NEURO_CODES = { redraw: "r", replace: "s", motion: "m" };
  const STYLE_CODES = { real: "r", cartoon: "c", anime: "a", "3d": "3" };
  const RATIO_CODES = { "9:16": "916", "1:1": "11", "16:9": "169" };
  const maskOf = (list) => list.reduce((m, n) => m + 2 ** (n - 1), 0);
  function encode(d) {
    if (d.kind === "montage") return `w1-m-${d.sec}-${d.clips}-${maskOf(d.opts).toString(16)}`;
    if (d.kind === "neuro") return `w1-n-${NEURO_CODES[d.mode]}-${d.sec}-${parseInt(d.q, 10)}`;
    if (d.kind === "preset") return `w1-p-${STYLE_CODES[d.style]}`;
    return `w1-v-${RATIO_CODES[d.ratio]}-${d.sec}-${parseInt(d.q, 10)}-0-${d.trend}`;
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
  function aivTokens(ratio, quality, seconds) {
    const a = P.aivideo, dims = a.dims[quality];
    const [w, h] = ratio === "adaptive"
      ? Object.values(dims).reduce((best, d) => d[0] * d[1] > best[0] * best[1] ? d : best)
      : dims[ratio];
    return Math.ceil(w * h * (seconds * a.fps + 1) / 1024);
  }
  function aivPrice(ratio, quality, seconds, textFrame) {
    const a = P.aivideo;
    const rate = quality === "1080p" ? a.usd_per_m_tokens_1080 : a.usd_per_m_tokens;
    const usd = aivTokens(ratio, quality, seconds) / 1e6 * rate + (textFrame ? a.text_frame_usd : 0);
    return priceOf(usd, "aivideo");
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
    if (d.kind === "preset") return presetPrice();
    return aivPrice(d.ratio, d.q, d.sec, false);
  }

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
    bookmark: "M6 3h12v18l-6-4-6 4Z",
    search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-2 4 6 6",
    info: "M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
    reset: "M3 3v6h6M3 9a9 9 0 1 1 0 6",
    send: "m22 2-7 20-4-9-9-4Zm-11 11L22 2",
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n] || paths.spark}"/></svg>`;
  const monti = (size = "m") =>
    `<span class="mini-monti monti-${size}"><picture><source media="(prefers-reduced-motion: reduce)" srcset="assets/monti-still.png"><img src="assets/monti-sticker.gif" width="320" height="320" alt="Монти — помощник Montaggio"></picture></span>`;
  const button = (text, action, cls = "primary", attrs = "", ic = "") =>
    `<button class="button ${cls}" data-action="${action}" ${attrs}>${ic ? icon(ic) : ""}${text}</button>`;

  // тренды — те же id и длительность, что в каталоге бота (reels-bot/reelsbot/trends.py); обложка — одна из 4 картинок
  const TRENDS = [
    ["orbit", "Кино о вас", "Кино", "orbit", 8, "Солнечный город, плавный облёт камеры и тёплый киношный цвет.", "Выбор Монти"],
    ["chrome", "Жидкий хром", "Эффекты", "chrome", 6, "Зеркальный мир и металлические отражения.", "Эффект"],
    ["flowers", "Внутри цветка", "Образ", "flowers", 8, "Мягкий свет и огромные цветы — нежная модная история.", "Образ"],
    ["night", "После полуночи", "Кино", "night", 10, "Ночной город, неон и отражения на мокром асфальте.", "Кино"],
    ["editorial", "Как на обложке", "Образ", "chrome", 8, "Стильный кадр в отражениях металла."],
    ["slow", "Момент для себя", "Кино", "orbit", 10, "Неспешная прогулка в тёплом свете, как сцена из фильма."],
    ["sunset", "Тёплый вечер", "Кино", "orbit", 8],
    ["bloom", "Цветочная история", "Образ", "flowers", 8],
    ["neon", "В свете неона", "Кино", "night", 8],
    ["mirror", "В мире отражений", "Эффекты", "chrome", 8],
    ["walk", "Прогулка как в кино", "Кино", "orbit", 8],
    ["garden", "Волшебный сад", "Образ", "flowers", 8],
    ["city", "Большой город", "Кино", "night", 8],
    ["shine", "Металлический блеск", "Эффекты", "chrome", 8],
    ["portrait", "Ваш модный портрет", "Образ", "flowers", 8],
  ].map(([id, name, category, image, seconds, desc, tag]) =>
    ({ id, name, category, image, seconds, desc: desc || "Готовый сюжет — нейросеть снимет его с нуля.", tag }));
  const trendOf = (id) => TRENDS.find((t) => t.id === id);

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
  const PRESET_STYLES = [["real", "📷 Реализм"], ["cartoon", "🎨 Мультфильм"], ["anime", "🌸 Аниме"], ["3d", "🧸 3D"]];
  const FORMATS = [["9:16", "", "Вертикально"], ["1:1", "square", "Квадрат"], ["16:9", "wide", "Горизонтально"]];
  const QUALITIES = ["480p", "720p", "1080p"];
  const MONTAGE_SECONDS = [15, 30, 45, 60, 90, 120, 180];
  const SHORT_SECONDS = [4, 5, 6, 8, 10, 12, 15, 20, 30];
  const KIND_NAMES = { montage: "🎬 Монтаж", neuro: "🪄 Нейромонтаж", preset: "🧩 Пресет персонажа", aivideo: "🎥 AI-видео" };

  function newDraft(kind, trendId) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (kind === "montage") return { id, kind, sec: 60, clips: 1, opts: STANDARD.slice() };
    if (kind === "neuro") return { id, kind, mode: "redraw", sec: 10, q: "720p" };
    if (kind === "preset") return { id, kind, style: "real" };
    const t = trendOf(trendId) || TRENDS[0];
    return { id, kind: "aivideo", trend: t.id, ratio: "9:16", sec: t.seconds, q: "720p" };
  }
  // черновик из хранилища — только известные значения (хранилище мог испортить кто угодно на этом устройстве)
  function cleanDraft(d) {
    if (!d || typeof d !== "object" || !KIND_NAMES[d.kind]) return null;
    const base = newDraft(d.kind, d.trend);
    base.id = typeof d.id === "string" && /^[a-z0-9]{1,24}$/.test(d.id) ? d.id : base.id;
    base.updated = Number(d.updated) || Date.now();
    if (d.kind === "montage") {
      if (MONTAGE_SECONDS.includes(d.sec)) base.sec = d.sec;
      if (Number.isInteger(d.clips) && d.clips >= 1 && d.clips <= 10) base.clips = d.clips;
      if (Array.isArray(d.opts)) base.opts = STANDARD.filter((n) => d.opts.includes(n));
    } else if (d.kind === "neuro") {
      if (NEURO_CODES[d.mode]) base.mode = d.mode;
      if (SHORT_SECONDS.includes(d.sec)) base.sec = d.sec;
      if (QUALITIES.includes(d.q)) base.q = d.q;
    } else if (d.kind === "preset") {
      if (STYLE_CODES[d.style]) base.style = d.style;
    } else {
      if (RATIO_CODES[d.ratio]) base.ratio = d.ratio;
      if (SHORT_SECONDS.includes(d.sec)) base.sec = d.sec;
      if (QUALITIES.includes(d.q)) base.q = d.q;
    }
    return base;
  }

  // --- хранилище этого устройства ---
  const storageKey = "montaggio-app-v1";
  let drafts = [], saved = new Set(), trendsExpanded = true;
  try {
    const s = JSON.parse(localStorage.getItem(storageKey) || "{}");
    drafts = (Array.isArray(s.drafts) ? s.drafts : []).map(cleanDraft).filter(Boolean).slice(0, 8);
    saved = new Set((Array.isArray(s.saved) ? s.saved : []).filter((id) => trendOf(id)));
    trendsExpanded = s.trendsExpanded !== false;
  } catch {}
  let storageWarned = false;
  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ drafts, saved: [...saved], trendsExpanded }));
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
  function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
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
    nav(d.kind === "aivideo" ? "trend/" + d.trend : d.kind === "preset" ? "preset" : "edit/" + d.kind);
  }

  // --- куски экранов ---
  const pageTop = (title, sub = "") =>
    `<div class="page-top"><div><h1>${title}</h1>${sub ? `<p class="page-subtitle">${sub}</p>` : ""}</div></div>`;
  function navBar() {
    const r = route();
    $("#nav").innerHTML = [
      ["home", "home", "Главная"],
      ["trends", "spark", "Тренды"],
      ["edit", "sliders", "Изменить"],
      ["preset", "layers", "Персонаж"],
      ["profile", "user", "Профиль"],
    ].map(([to, ic, label]) => {
      const on = r === to || r.startsWith(to + "/") || (to === "trends" && r.startsWith("trend/")) || (to === "profile" && r === "drafts");
      return `<a href="#/${to}" class="nav-item ${on ? "current" : ""}" ${r === to ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`;
    }).join("");
  }
  const poster = (t, extra = "") =>
    `<span class="trend-art-wrap"><img class="trend-art ${extra}" src="assets/trends/${t.image}.webp" alt="" loading="lazy" decoding="async"></span>`;
  function trendCard(t) {
    const on = saved.has(t.id);
    return `<article class="trend-card"><button class="trend-open" data-action="trend" data-id="${t.id}" aria-label="Открыть тренд: ${esc(t.name)}"><div class="trend-poster animated-poster">${poster(t)}${t.tag ? `<span class="tag">${esc(t.tag)}</span>` : ""}<span class="duration">${icon("play")}${t.seconds} сек</span></div><h3>${esc(t.name)}</h3></button><button class="save-button ${on ? "saved" : ""}" data-action="save-trend" data-id="${t.id}" aria-label="${on ? "Убрать из избранного" : "Сохранить тренд"}: ${esc(t.name)}" aria-pressed="${on}">${icon("bookmark")}</button></article>`;
  }
  function draftTitle(d) {
    if (d.kind === "aivideo") return trendOf(d.trend)?.name || "AI-видео";
    return KIND_NAMES[d.kind].replace(/^\S+\s/, "");
  }
  function draftLine(d) {
    if (d.kind === "montage") return `${d.clips} видео · до ${secText(d.sec)}`;
    if (d.kind === "neuro") return `${NEURO_MODES.find((m) => m[0] === d.mode)[1]} · ${d.sec} сек · ${d.q}`;
    if (d.kind === "preset") return PRESET_STYLES.find((s) => s[0] === d.style)[1];
    return `AI-видео · ${d.ratio} · ${d.sec} сек · ${d.q}`;
  }
  const draftCard = (d) =>
    `<button class="continue-card" data-action="resume" data-id="${d.id}"><span class="continue-icon">${icon(d.kind === "aivideo" ? "spark" : d.kind === "preset" ? "user" : "video")}</span><span><strong>${esc(draftTitle(d))}</strong><small>${esc(draftLine(d))} · черновик</small></span>${icon("arrow")}</button>`;
  function continueCards() {
    if (!drafts.length) return "";
    return `<section class="continue-section" aria-label="Черновики"><div class="section-heading"><h2>Продолжить</h2><span class="saved-label">${icon("check")}Сохранено здесь</span></div><div class="draft-list">${drafts.slice(0, 3).map(draftCard).join("")}</div></section>`;
  }
  const secText = (s) => s < 60 ? `${s} сек` : `${Math.floor(s / 60)} мин` + (s % 60 ? ` ${s % 60} сек` : "");

  // --- экраны ---
  function home() {
    return `<div class="page-head welcome"><div><h1>Какое видео<br>сделаем?</h1><p>Выберите, с чего начать. Оформим и оплатим в боте.</p></div><div class="welcome-monti">${monti("l")}</div></div>
${continueCards()}
<div class="product-switch"><button class="product-tile active" data-action="nav" data-to="edit">${icon("sliders")}<div><span>Изменить видео</span><small>Смонтировать своё или изменить нейросетью</small></div>${icon("arrow")}</button><button class="product-tile" data-action="nav" data-to="trends">${icon("spark")}<div><span>Повторить тренд</span><small>Нейросеть снимет сюжет с нуля</small></div>${icon("arrow")}</button></div>
<div class="section-heading"><div><h2>Тренды</h2><p class="section-hint">Листайте и выбирайте сюжет</p></div><button class="text-button" data-action="toggle-trends" aria-expanded="${trendsExpanded}" aria-controls="home-trends">${trendsExpanded ? "Свернуть" : "Показать"} ${icon(trendsExpanded ? "x" : "plus")}</button></div>
${trendsExpanded ? `<div id="home-trends" class="trend-carousel" aria-label="Тренды">${TRENDS.map(trendCard).join("")}</div><div class="carousel-footer"><span>${TRENDS.length} сюжетов · листайте в сторону</span>${button("Все тренды", "nav", "secondary small", 'data-to="trends"', "arrow")}</div>` : ""}
<div class="onboarding-strip">${monti("s")}<div><h3>Свой персонаж</h3><p>Лист персонажа по вашим фото — для нейромонтажа и своих проектов.</p></div>${button("Пресет", "nav", "secondary small", 'data-to="preset"', "plus")}</div>`;
  }
  function catalogue() {
    const list = filtered();
    return `<div class="page-head"><div><h1>Тренды</h1><p>Готовые сюжеты — нейросеть снимет их с нуля.</p></div><button class="icon-button ${showSaved ? "lime" : ""}" data-action="toggle-saved" aria-label="Показать избранные тренды" aria-pressed="${showSaved}">${icon("bookmark")}</button></div><label class="search-box">${icon("search")}<input type="search" id="trend-search" aria-label="Поиск трендов" placeholder="Найти сюжет" value="${esc(search)}"></label><div class="filter-row" aria-label="Категории трендов">${["Все", "Кино", "Образ", "Эффекты"].map((f) => `<button class="filter ${f === filter ? "selected" : ""}" data-action="filter" data-value="${f}" aria-pressed="${f === filter}">${f}</button>`).join("")}</div><div class="trend-grid" id="catalog-grid">${gridHtml(list)}</div><p class="catalog-note">Картинки — иллюстрации сюжетов. Видео нейросеть создаёт заново по описанию тренда.</p>`;
  }
  let filter = "Все", search = "", showSaved = false;
  const filtered = () => TRENDS.filter((t) => (filter === "Все" || t.category === filter) && (!showSaved || saved.has(t.id))
    && t.name.toLowerCase().includes(search.toLowerCase()));
  const gridHtml = (list) => list.length ? list.map(trendCard).join("")
    : '<p class="no-results">Пока ничего нет. Попробуйте другую категорию.</p>';

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
    return `<h2>🪄 Нейромонтаж</h2><p>${mode[2]}</p><div class="field"><span class="field-label">Режим</span>${chips("mode", NEURO_MODES, d.mode)}</div><div class="field"><label for="n-sec">Длина видео</label>${select("n-sec", SHORT_SECONDS, d.sec, (v) => v + " сек")}</div><div class="field"><span class="field-label">Качество</span>${chips("q", QUALITIES.map((q) => [q, q]), d.q)}</div>`;
  }
  function presetFields(d) {
    return `<h2>🧩 Пресет персонажа</h2><p>Лист персонажа — портрет, поворот в полный рост, лицо, эмоции, позы — и файлы без фона: по ним нейросеть держит внешность в нейромонтаже.</p><div class="field"><span class="field-label">Стиль</span>${chips("style", PRESET_STYLES, d.style)}</div>`;
  }
  function trendFields(d) {
    const t = trendOf(d.trend);
    return `<h2>${esc(t.name)}</h2><p class="trend-desc">${esc(t.desc)}</p><div class="field"><span class="field-label">Где будете публиковать?</span><div class="format-row">${FORMATS.map(([v, c, label]) => `<button class="format-button ${d.ratio === v ? "selected" : ""}" data-action="ratio" data-value="${v}" aria-pressed="${d.ratio === v}"><i class="format-shape ${c}"></i>${label}</button>`).join("")}</div></div><div class="field"><label for="v-sec">Сколько секунд?</label>${select("v-sec", SHORT_SECONDS, d.sec, (v) => v + " секунд")}</div><div class="field"><span class="field-label">Качество</span>${chips("q", QUALITIES.map((q) => [q, q]), d.q)}</div>`;
  }
  // что будет в боте — честно: что прислать и где цена
  function botSteps(d) {
    if (d.kind === "montage")
      return [`Пришлите ${d.clips > 1 ? d.clips + " видео одним альбомом" : "видео"} в чат с ботом.`, "Бот проверит длину и покажет точную цену.", "Оплата — в боте, потом готовое видео придёт туда же."];
    if (d.kind === "neuro")
      return ["Бот откроет выбранный режим — пришлите видео и, если режим просит, промпт или образец.", "Точная цена — в карточке после видео.", "Оплата — в боте, результат придёт туда же."];
    if (d.kind === "preset")
      return ["Фото или описание персонажа пришлёте в чате с ботом — из приложения фото не передаются.", "Бот покажет цену до оплаты.", "Лист персонажа и файлы придут в чат."];
    return ["Бот сразу проверит описание тренда и пришлёт карточку с ценой.", "Хотите по-своему — напишите боту своё описание.", "Оплата — в боте, видео придёт туда же."];
  }
  function flowPage(kind) {
    if (!draft || draft.kind !== kind) draft = drafts.find((x) => x.kind === kind && kind !== "aivideo") || newDraft(kind);
    const d = draft;
    const fields = kind === "montage" ? montageFields(d) : kind === "neuro" ? neuroFields(d) : kind === "preset" ? presetFields(d) : trendFields(d);
    const t = kind === "aivideo" ? trendOf(d.trend) : null;
    const title = kind === "aivideo" ? "Повторить тренд" : kind === "preset" ? "Свой персонаж" : "Изменить видео";
    const body = `<div class="fields${t ? "" : " solo"}">${fields}${priceBlock(d)}<ol class="bot-steps">${botSteps(d).map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div id="flow-error" class="form-error" role="alert"></div><div class="workflow-actions">${ctaHtml(d)}</div></div>`;
    if (!t) return `<div class="workflow">${pageTop(title, "Черновик сохраняется на этом устройстве")}${body}</div>`;
    return `<div class="workflow">${pageTop(title, "Черновик сохраняется на этом устройстве")}<div class="workspace"><div class="work-preview"><div class="portrait-preview"><img src="assets/trends/${t.image}.webp" alt="Иллюстрация сюжета ${esc(t.name)}"><span class="tag preview-label">Иллюстрация</span></div></div>${body}</div></div>`;
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
    return `<div class="profile-page"><div class="profile-header">${monti("s")}<div><h1>Ваше пространство</h1><p>Черновики и избранное — только на этом устройстве</p></div></div>${[
      ["layers", "Черновики", `${drafts.length} не оформлено`, "nav", "drafts"],
      ["bookmark", "Избранные тренды", `${saved.size} сюжетов под рукой`, "favorites", ""],
      ["info", "Как это работает", "Приложение, бот и оплата", "help", ""],
      ["user", "Данные", "Что хранится и что уходит в бота", "about", ""],
    ].map(([ic, title, sub, a, to]) => `<button class="profile-row" data-action="${a}" ${to ? `data-to="${to}"` : ""}>${icon(ic)}<span><strong>${title}</strong><small>${sub}</small></span>${icon("chevron")}</button>`).join("")}<button class="text-button" data-action="reset">Стереть данные на этом устройстве ${icon("reset")}</button></div>`;
  }
  function draftsPage() {
    return `${pageTop("Черновики", "Не оформленные заказы — на этом устройстве.")}${drafts.length ? `<div class="draft-list">${drafts.map((d) => `<div class="draft-row">${draftCard(d)}<button class="icon-button" data-action="drop" data-id="${d.id}" aria-label="Удалить черновик">${icon("trash")}</button></div>`).join("")}</div>` : `<div class="empty-state">${monti("xl")}<h2>Черновиков нет</h2><p>Начатый заказ сохранится здесь, пока вы не оформите его в боте.</p>${button("Выбрать тренд", "nav", "primary", 'data-to="trends"')}</div>`}`;
  }

  function render() {
    navBar();
    const r = route();
    let html;
    if (r === "trends") html = catalogue();
    else if (r === "edit") html = editLanding();
    else if (FLOW[r]) html = flowPage(FLOW[r]);
    else if (r.startsWith("trend/") && trendOf(r.slice(6))) {
      const id = r.slice(6);
      if (!draft || draft.kind !== "aivideo" || draft.trend !== id)
        draft = drafts.find((x) => x.kind === "aivideo" && x.trend === id) || newDraft("aivideo", id);
      html = flowPage("aivideo");
    } else if (r === "profile") html = profile();
    else if (r === "drafts") html = draftsPage();
    else html = home();
    $("#app").innerHTML = `<div class="page-enter">${html}</div>`;
    document.title = "Montaggio — " + (r === "trends" ? "тренды" : r === "home" ? "приложение" : "заказ");
    const top = r === "home";
    $("#header-back").hidden = top || inTelegram;      // в Telegram — его кнопка «Назад» в шапке окна
    if (inTelegram && tg.BackButton) top ? tg.BackButton.hide() : tg.BackButton.show();
    observePosters();
  }
  // выбор в форме: черновик сохраняется, цена и кнопка — обновляются на месте
  function changed() {
    keepDraft();
    render();
  }

  let posterObserver;
  function observePosters() {
    posterObserver?.disconnect();
    if (!("IntersectionObserver" in window)) return;
    posterObserver = new IntersectionObserver((entries) =>
      entries.forEach((e) => e.target.classList.toggle("in-view", e.isIntersecting)), { threshold: 0.15 });
    document.querySelectorAll(".animated-poster").forEach((el) => posterObserver.observe(el));
  }
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

  document.addEventListener("input", (e) => {
    if (e.target.id !== "trend-search") return;
    search = e.target.value;
    $("#catalog-grid").innerHTML = gridHtml(filtered());
    observePosters();
  });
  document.addEventListener("change", (e) => {
    const id = e.target.id;
    if (!draft || !["m-sec", "n-sec", "v-sec"].includes(id)) return;
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
    if (!b) return;
    const a = b.dataset.action, v = b.dataset.value;
    if (a === "order-link") {                       // вне Telegram — обычная ссылка; черновик больше не нужен
      if (draft) dropDraft(draft.id);
      return;
    }
    if (a === "back") back();
    else if (a === "nav") nav(b.dataset.to);
    else if (a === "close") closeModal();
    else if (a === "toggle-trends") { trendsExpanded = !trendsExpanded; persist(); render(); }
    else if (a === "trend") { draft = null; nav("trend/" + b.dataset.id); }
    else if (a === "start") { draft = newDraft(b.dataset.kind); nav("edit/" + b.dataset.kind); }
    else if (a === "resume") { const d = drafts.find((x) => x.id === b.dataset.id); if (d) openDraft(d); }
    else if (a === "drop") { dropDraft(b.dataset.id); render(); toast("Черновик удалён."); }
    else if (a === "filter") { filter = v; render(); }
    else if (a === "toggle-saved") { showSaved = !showSaved; render(); }
    else if (a === "favorites") { showSaved = true; filter = "Все"; search = ""; nav("trends"); }
    else if (a === "save-trend") {
      const id = b.dataset.id;
      if (saved.has(id)) saved.delete(id); else saved.add(id);
      persist();
      b.classList.toggle("saved", saved.has(id));
      b.setAttribute("aria-pressed", saved.has(id));
      toast(saved.has(id) ? "Тренд в избранном" : "Тренд убран из избранного");
    } else if (draft && a === "opt") {
      const n = Number(v);
      draft.opts = draft.opts.includes(n) ? draft.opts.filter((x) => x !== n) : STANDARD.filter((x) => x === n || draft.opts.includes(x));
      changed();
    } else if (draft && a === "clips") { draft.clips = Math.min(10, Math.max(1, draft.clips + Number(v))); changed(); }
    else if (draft && a === "mode" && NEURO_CODES[v]) { draft.mode = v; changed(); }
    else if (draft && a === "q" && QUALITIES.includes(v)) { draft.q = v; changed(); }
    else if (draft && a === "style" && STYLE_CODES[v]) { draft.style = v; changed(); }
    else if (draft && a === "ratio" && RATIO_CODES[v]) { draft.ratio = v; changed(); }
    else if (a === "order") order();
    else if (a === "help")
      showModal("Как это работает", `${monti("m")}<ul class="sheet-list"><li><strong>Соберите заказ</strong>Выберите услугу или тренд и настройки — цену видно сразу.</li><li><strong>Оформите в боте</strong>Кнопка откроет чат с ботом @${BOT} с вашим выбором. Видео и фото пришлёте там.</li><li><strong>Оплата — в боте</strong>Бот покажет точную цену до оплаты. Готовый результат придёт в чат.</li></ul>`);
    else if (a === "about")
      showModal("Данные", `<ul class="sheet-list"><li><strong>Что хранится здесь</strong>Черновики и избранное — только в этом браузере. Фото и видео приложение не загружает.</li><li><strong>Что уходит в бота</strong>Только ваш выбор: услуга и настройки — коротким кодом в ссылке на бота.</li><li><strong>Оплата</strong>Приложение денег не принимает — оплата только в боте.</li></ul>`);
    else if (a === "reset")
      showModal("Стереть данные?", `<p>Удалятся черновики и избранное на этом устройстве.</p>${button("Стереть", "confirm-reset", "primary full")}${button("Оставить", "close", "ghost full")}`);
    else if (a === "confirm-reset") {
      drafts = []; saved = new Set(); draft = null;
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
    const platform = w.platform && w.platform !== "unknown" ? w.platform : LAUNCH_PLATFORM;
    if (!platform && !w.initData) return true;      // скрипт есть, но это не Telegram — ждать больше нечего
    tg = w;
    inTelegram = true;
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
