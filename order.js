// «Собрать заказ»: те же услуги и настройки, что в меню бота, цена по prices.json (формулы reelsbot/pricing.py,
// README, «Цены»), итог — ссылка в бота с кодом выбора ?start=w1-… (формат кода — README, «Код заказа»).
// Ничего не отправляет: только читает prices.json со своего адреса и меняет #код в адресе страницы.
(() => {
  'use strict';
  const BOT = 'Montaggio_bot';
  const QUALITIES = ['480p', '720p', '1080p'];

  // список возможностей «Монтажа» — reelsbot/montage_options.py (номер, текст), по группам
  const MONTAGE_OPTIONS = [
    ['✂️ Нарезка', [[1, 'Вырезать паузы'], [2, 'Вырезать слова-паразиты («ээ», «ну», «как бы»)'],
      [3, 'Вырезать дубли и оговорки — без потери смысла'], [4, 'Сократить до нужной длины — напишите, например, «до 30 секунд»'],
      [5, 'Крючок: самая сильная фраза — в первые секунды']]],
    ['💬 Текст', [[6, 'Субтитры с подсветкой слов'], [7, 'Исправить ошибки в субтитрах (имена, термины)']]],
    ['🎥 Картинка', [[8, '«Несколько камер»: смена планов из одной записи'], [9, 'Крупный план на важных фразах'],
      [10, 'Зеркальные кадры'], [11, 'Цвет: тёплый, холодный, контрастный, сочный, ч/б, плёнка, мягкий'],
      [12, 'Чуть ускорить речь'], [13, 'Горизонтальное видео — на размытый фон (иначе обрежу по лицу)']]],
    ['🔊 Звук', [[14, 'Чистый голос: убрать шум, выровнять']]],
    ['✨ Графика', [[15, 'Анимированные надписи: заголовок, плашки, списки, цифры'], [16, 'Рисунки предметов, о которых вы говорите'],
      [17, 'Графика у рук: надпись на ладони, по указанию пальца'], [18, 'Переходы на склейках'], [19, 'Звуки под графику'],
      [20, 'Полоса прогресса сверху'], [21, 'Эффекты: огонь, искры, плёнка, VHS, блики'],
      [22, 'Врезки: на секунду кадр по теме (стоковое видео)'], [23, 'Призыв в конце («подпишись», «пиши ХОЧУ»)']]],
  ];
  const OPTION_COUNT = 23;

  const SERVICES = {montage: '🎬 Монтаж', neuro: '🪄 Нейромонтаж', preset: '🧩 Пресет персонажа', aivideo: '🎥 AI-видео',
    sites: '🖥 Сайты и презентации'};
  const NEURO_MODES = {redraw: ['r', '🎨 Перерисовка'], replace: ['s', '🔁 Замена'], motion: ['m', '🕺 Перенос движения']};
  const PRESET_STYLES = {real: ['r', '📷 Реализм'], cartoon: ['c', '🎨 Мультфильм'], anime: ['a', '🌸 Аниме'], '3d': ['3', '🧸 3D']};
  const RATIOS = {'9:16': ['916', '9:16, вертикальное'], '16:9': ['169', '16:9, горизонтальное'], '1:1': ['11', '1:1, квадрат'],
    '4:3': ['43', '4:3'], '3:4': ['34', '3:4'], '21:9': ['219', '21:9, широкое кино'], adaptive: ['a', 'на выбор нейросети']};
  const SITE_FORMATS = {vertical: ['v', '📱 Вертикальный'], horizontal: ['h', '🖥 Горизонтальный'], square: ['s', '⬛ Квадрат']};

  const form = document.getElementById('order');
  if (!form) return;
  const $ = id => document.getElementById(id);
  const value = name => { const el = form.querySelector(`[name="${name}"]:checked`); return el ? el.value : ''; };
  const setRadio = (name, v) => { const el = form.querySelector(`[name="${name}"][value="${v}"]`); if (el) el.checked = true; };
  const keyOf = (map, code) => Object.keys(map).find(k => map[k][0] === code);
  let P = null;

  // --- цены: тот же расчёт, что pricing.py бота (промпт 65: себестоимость + наценка услуги) ---
  // service — как в боте: montage, neuro, aivideo, preset, brag
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
    if (mode === 'replace' || mode === 'motion') usd = seconds * n.genjutsu_usd_per_sec[quality];
    else {
      const [w, h] = n.dims[quality];
      const tokens = Math.ceil(h * w * (seconds + seconds) * 24 / 1024);
      usd = tokens / 1000 * (quality === '1080p' ? n.usd_per_1k_tokens_1080 : n.usd_per_1k_tokens);
    }
    return priceOf(usd, 'neuro');
  }
  function aivTokens(ratio, quality, seconds) {
    const a = P.aivideo, dims = a.dims[quality];
    const [w, h] = ratio === 'adaptive'
      ? Object.values(dims).reduce((best, d) => d[0] * d[1] > best[0] * best[1] ? d : best)
      : dims[ratio];
    return Math.ceil(w * h * (seconds * a.fps + 1) / 1024);
  }
  function aivPrice(ratio, quality, seconds, textFrame) {
    const a = P.aivideo;
    const rate = quality === '1080p' ? a.usd_per_m_tokens_1080 : a.usd_per_m_tokens;
    const usd = aivTokens(ratio, quality, seconds) / 1e6 * rate + (textFrame ? a.text_frame_usd : 0);
    return priceOf(usd, 'aivideo');
  }
  // pricing.montage_usd: оценка себестоимости по длине и пунктам
  function montagePrice(seconds, opts) {
    const e = P.montage.estimate, on = new Set(opts);
    let usd = e.base_usd + e.per_min_usd * seconds / 60;
    if (e.layer.some(n => on.has(n))) usd += e.motion_usd;
    if (on.has(e.shorten)) usd += e.shorten_usd;
    if (on.has(e.broll)) usd += e.broll_usd;
    if (on.has(e.draw)) usd += e.drawing_usd * Math.min(e.max_drawings, Math.max(1, Math.ceil(seconds / e.sec_per_drawing)));
    return priceOf(usd, 'montage');
  }
  const presetPrice = () => priceOf(P.preset.usd, 'preset');
  const sitesPrice = () => priceOf(P.sites.usd, 'brag');
  const rub = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  const approx = n => '≈ ' + rub(n);
  const seconds = s => s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин` + (s % 60 ? ` ${s % 60} с` : '');
  const fxDate = () => P.fx.date.split('-').reverse().join('.');
  const fxRate = () => P.fx.usd_rub.toFixed(2).replace('.', ',');

  // --- «Монтаж»: список с номерами (промпт 66: сверху ✅ стандартный монтаж, ниже 🧪 экспериментальные — как в боте) ---
  const EXPERIMENTAL_WARNING = '⚠️ Экспериментальная функция — результат может быть хуже ожидаемого.';
  function buildOptions() {
    const box = $('m-options');
    const standard = new Set(P.montage.standard);
    const all = MONTAGE_OPTIONS.flatMap(([, items]) => items);
    const groups = [['✅ Стандартный монтаж — включён сразу, любой пункт можно снять', all.filter(([n]) => standard.has(n))]];
    const experimental = MONTAGE_OPTIONS.map(([group, items]) => [group, items.filter(([n]) => !standard.has(n))])
      .filter(([, items]) => items.length);
    if (experimental.length) {
      const title = document.createElement('p');
      title.className = 'opt-group';
      title.textContent = '🧪 Экспериментальные — включите сами';
      const warning = document.createElement('p');
      warning.className = 'step-note';
      warning.textContent = EXPERIMENTAL_WARNING;
      groups.push([null, [title, warning]], ...experimental);
    }
    for (const [group, items] of groups) {
      if (group === null) { box.append(...items); continue; }
      if (!items.length) continue;
      const title = document.createElement('p');
      title.className = 'opt-group';
      title.textContent = group;
      const list = document.createElement('ul');
      list.className = 'opt-list';
      for (const [n, text] of items) {
        const li = document.createElement('li');
        const label = document.createElement('label');
        label.className = 'opt';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'm-opt';
        input.value = String(n);
        input.checked = standard.has(n);
        const body = document.createElement('span');
        const b = document.createElement('b');
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(n);
        b.append(num, standard.has(n) ? text : '🧪 ' + text);
        if (standard.has(n)) {
          const tag = document.createElement('span');
          tag.className = 'std';
          tag.textContent = 'стандарт';
          b.append(tag);
        }
        body.append(b);
        label.append(input, body);
        li.append(label);
        list.append(li);
      }
      box.append(title, list);
    }
  }
  const selectedOptions = () => [...form.querySelectorAll('[name="m-opt"]:checked')].map(el => Number(el.value)).sort((a, b) => a - b);
  const maskOf = list => list.reduce((m, n) => m + 2 ** (n - 1), 0);
  function setOptions(list) {
    const want = new Set(list);
    form.querySelectorAll('[name="m-opt"]').forEach(el => { el.checked = want.has(Number(el.value)); });
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function clips() {
    const el = $('m-clips');
    const n = clamp(Math.round(Number(el.value) || 1), 1, P.montage.max_clips);
    return n;
  }

  // --- состояние формы → код → итог ---
  function state() {
    const service = value('service');
    if (service === 'montage') return {service, sec: Number($('m-sec').value), clips: clips(), opts: selectedOptions()};
    if (service === 'neuro') return {service, mode: value('n-mode'), sec: Number($('n-sec').value), q: value('n-q')};
    if (service === 'preset') return {service, style: value('p-style')};
    if (service === 'aivideo') return {service, ratio: value('v-ratio'), sec: Number($('v-sec').value), q: value('v-q'), text: $('v-text').checked};
    return {service: 'sites', format: value('b-format')};
  }

  // Код ≤ 64 знаков, только A-Za-z0-9_- (ограничение Telegram для ?start=); формат — README, «Код заказа».
  function encode(s) {
    switch (s.service) {
      case 'montage': return `w1-m-${s.sec}-${s.clips}-${maskOf(s.opts).toString(16)}`;
      case 'neuro': return `w1-n-${NEURO_MODES[s.mode][0]}-${s.sec}-${parseInt(s.q, 10)}`;
      case 'preset': return `w1-p-${PRESET_STYLES[s.style][0]}`;
      case 'aivideo': return `w1-v-${RATIOS[s.ratio][0]}-${s.sec}-${parseInt(s.q, 10)}-${s.text ? 1 : 0}`;
      default: return `w1-b-${SITE_FORMATS[s.format][0]}`;
    }
  }
  const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  function decode(code) {
    let m;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return null;
    if ((m = /^w1-m-(\d{1,3})-(\d{1,2})-([0-9a-f]{1,6})$/.exec(code))) {
      const sec = Number(m[1]), n = Number(m[2]), mask = parseInt(m[3], 16);
      if (!inRange(sec, P.montage.min_sec, P.montage.max_sec) || !inRange(n, 1, P.montage.max_clips) || mask < 1 || mask >= 2 ** OPTION_COUNT) return null;
      const opts = [];
      for (let i = 1; i <= OPTION_COUNT; i++) if (mask & 2 ** (i - 1)) opts.push(i);
      return {service: 'montage', sec, clips: n, opts};
    }
    if ((m = /^w1-n-([rsm])-(\d{1,2})-(480|720|1080)$/.exec(code))) {
      const sec = Number(m[2]);
      if (!inRange(sec, P.neuro.min_sec, P.neuro.max_sec)) return null;
      return {service: 'neuro', mode: keyOf(NEURO_MODES, m[1]), sec, q: `${m[3]}p`};
    }
    if ((m = /^w1-p-([rca3])$/.exec(code))) return {service: 'preset', style: keyOf(PRESET_STYLES, m[1])};
    if ((m = /^w1-v-(916|169|11|43|34|219|a)-(\d{1,2})-(480|720|1080)-([01])$/.exec(code))) {
      const sec = Number(m[2]);
      if (!inRange(sec, P.aivideo.min_sec, P.aivideo.max_sec)) return null;
      return {service: 'aivideo', ratio: keyOf(RATIOS, m[1]), sec, q: `${m[3]}p`, text: m[4] === '1'};
    }
    if ((m = /^w1-b-([vhs])$/.exec(code))) return P.sites.enabled === false ? null : {service: 'sites', format: keyOf(SITE_FORMATS, m[1])};
    return null;
  }
  function apply(s) {
    setRadio('service', s.service);
    if (s.service === 'montage') { $('m-sec').value = s.sec; $('m-clips').value = s.clips; setOptions(s.opts); }
    if (s.service === 'neuro') { setRadio('n-mode', s.mode); $('n-sec').value = s.sec; setRadio('n-q', s.q); }
    if (s.service === 'preset') setRadio('p-style', s.style);
    if (s.service === 'aivideo') { setRadio('v-ratio', s.ratio); $('v-sec').value = s.sec; setRadio('v-q', s.q); $('v-text').checked = s.text; }
    if (s.service === 'sites') setRadio('b-format', s.format);
  }

  // подсказка «в боте выберите то же»: пункты относительно стандартного монтажа — как их понимает бот
  function montageWords(opts) {
    const standard = P.montage.standard;
    const on = opts.filter(n => !standard.includes(n)), off = standard.filter(n => !opts.includes(n));
    if (!on.length && !off.length) return 'нажмите «✅ Стандартный монтаж»';
    if (opts.length === OPTION_COUNT) return 'напишите «всё»';
    if (on.length && !off.length) return `напишите «включи ${on.join(' ')}»`;
    if (off.length && !on.length) return `напишите «без ${off.join(' ')}»`;
    return `напишите «только ${opts.join(' ')}»`;
  }

  // «1 2 3 14 · 🧪 6 16» — экспериментальные пункты в итоге отмечены 🧪 (промпт 66)
  function optionsLine(opts) {
    if (!opts.length) return 'не выбраны';
    const std = opts.filter(n => P.montage.standard.includes(n)), exp = opts.filter(n => !P.montage.standard.includes(n));
    return [std.join(' '), exp.length ? '🧪 ' + exp.join(' ') : ''].filter(Boolean).join(' · ');
  }

  function summary(s) {
    const rows = [['Услуга', SERVICES[s.service]]];
    let price = 0, note = '', hint = [];
    if (s.service === 'montage') {
      price = montagePrice(s.sec, s.opts);
      rows.push(['Видео', (s.clips > 1 ? `${s.clips} шт., всего ` : '') + seconds(s.sec)], ['Пункты', optionsLine(s.opts)]);
      note = `Примерно: по длине и пунктам, курс ${fxRate()} ₽ за $ на ${fxDate()}. Бот проверит длину и покажет точную цену до оплаты.`;
      hint = ['«🎬 Монтаж» в меню', s.clips > 1 ? `пришлите ${s.clips} видео одним альбомом` : 'пришлите видео', montageWords(s.opts),
        `в карточке заказа — «🎬 Монтаж — ${approx(price)}»`];
    } else if (s.service === 'neuro') {
      price = neuroPrice(s.sec, s.q, s.mode);
      const mode = NEURO_MODES[s.mode][1];
      rows.push(['Режим', mode], ['Видео', seconds(s.sec)], ['Качество', s.q]);
      note = `Примерно: по курсу ${fxRate()} ₽ за $ на ${fxDate()}. Бот считает по курсу дня — точная цена в карточке до оплаты.`;
      const sample = s.mode === 'redraw' ? '«📝 Промпт» — опишите, что изменить; образец — по желанию'
        : s.mode === 'replace' ? '«📝 Промпт» и образец: «🧩 Сделать пресет» или «📎 Свой пресет или картинка»'
          : 'образец: «🧩 Сделать пресет» или «📎 Свой пресет или картинка»; промпт — по желанию';
      hint = ['«🪄 Нейромонтаж» в меню', `режим «${mode}»`, sample, `«▶️ Дальше: прислать видео» — пришлите видео ${seconds(s.sec)}`,
        `в карточке — «${s.q} — ${approx(price)}»`];
    } else if (s.service === 'preset') {
      price = presetPrice();
      rows.push(['Стиль', PRESET_STYLES[s.style][1]]);
      note = `Примерно: по стоимости картинок у нейросети, курс ${fxRate()} ₽ за $ на ${fxDate()}. Точная цена — в боте перед оплатой.`;
      hint = ['«🧩 Пресет персонажа» в меню', '«➕ Создать пресет»', 'опишите персонажа и/или пришлите 1–3 фото',
        `стиль «${PRESET_STYLES[s.style][1]}»`, `«✨ Создать — ${approx(price)}»`];
    } else if (s.service === 'aivideo') {
      price = aivPrice(s.ratio, s.q, s.sec, s.text);
      const ratio = s.ratio === 'adaptive' ? 'Авто' : s.ratio;
      rows.push(['Формат', RATIOS[s.ratio][1]], ['Длительность', seconds(s.sec)], ['Качество', s.q], ['Звук', 'есть'], ['Надпись в кадре', s.text ? 'да' : 'нет']);
      note = `Примерно: по курсу ${fxRate()} ₽ за $ на ${fxDate()}. Точная цена — в карточке бота до оплаты.`;
      hint = ['«🎥 AI-видео» в меню', s.text ? 'пришлите описание, надпись — в кавычках' : 'пришлите описание',
        `в карточке: «${ratio}», «${s.sec} с», «${s.q} — ${approx(price)}»`, `«▶️ Создать · ${ratio} · ${s.sec} с · ${s.q} — ${approx(price)}»`];
    } else {
      price = sitesPrice();
      rows.push(['Формат', SITE_FORMATS[s.format][1]]);
      note = `Примерно: по средней работе нейросети, курс ${fxRate()} ₽ за $ на ${fxDate()}. Точная цена — в боте перед оплатой.`;
      hint = ['«🖥 Сайты и презентации» в меню', 'пришлите ссылку на сайт или файл PDF / PPTX', `формат «${SITE_FORMATS[s.format][1]}»`,
        `«✅ Заказать промо-ролик — ${approx(price)}»`];
    }
    return {rows, price, note, hint};
  }

  function qualityPrices(s) {
    const box = form.querySelector(`[data-quality-for="${s.service}"]`);
    if (!box) return;
    for (const q of QUALITIES) {
      const p = s.service === 'neuro' ? neuroPrice(s.sec, q, s.mode) : aivPrice(s.ratio, q, s.sec, s.text);
      box.querySelector(`[data-q-price="${q}"]`).textContent = approx(p);
    }
  }

  function render() {
    const s = state();
    form.querySelectorAll('[data-service]').forEach(el => { el.hidden = el.dataset.service !== s.service; });
    // длина словами — и в <output>, и для скринридера (aria-valuetext у ползунка)
    for (const [svc, id] of [['montage', 'm-sec'], ['neuro', 'n-sec'], ['aivideo', 'v-sec']]) {
      if (s.service !== svc) continue;
      $(`${id}-out`).textContent = seconds(s.sec);
      $(id).setAttribute('aria-valuetext', seconds(s.sec));
    }
    qualityPrices(s);
    const sum = summary(s);
    const list = $('sum-list');
    list.replaceChildren(...sum.rows.map(([k, v]) => {
      const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = k; dd.textContent = v; div.append(dt, dd); return div;
    }));
    const empty = s.service === 'montage' && !s.opts.length;
    $('sum-price').textContent = empty ? '—' : approx(sum.price);
    $('sum-note').textContent = empty ? 'Отметьте хотя бы один пункт монтажа.' : sum.note;
    const hint = empty ? ['сначала отметьте пункты монтажа'] : sum.hint;
    $('sum-hint').replaceChildren(...hint.map(t => { const li = document.createElement('li'); li.textContent = t; return li; }));
    const go = $('sum-go'), code = encode(s);
    if (empty) {
      // ссылка остаётся ссылкой (role), но не ведёт никуда и не в порядке Tab
      go.setAttribute('role', 'link'); go.setAttribute('aria-disabled', 'true'); go.setAttribute('tabindex', '-1');
      go.removeAttribute('href');
    } else {
      go.removeAttribute('role'); go.removeAttribute('aria-disabled'); go.removeAttribute('tabindex');
      go.href = `https://t.me/${BOT}?start=${code}`;
    }
    $('sum-code').textContent = empty ? '—' : code;
    // #код в адресе — чтобы ссылкой на выбор можно было поделиться; реже, чем события ползунка (браузеры
    // ограничивают частые replaceState)
    clearTimeout(hashTimer);
    if (!empty) hashTimer = setTimeout(() => { if (location.hash !== `#${code}`) history.replaceState(null, '', `#${code}`); }, 300);
  }
  let hashTimer = 0;

  function init(prices) {
    P = prices;
    // «Сайты и презентации» выключены в боте (prices.json: sites.enabled false) — в конфигураторе их нет
    if (P.sites.enabled === false) {
      const radio = form.querySelector('[name="service"][value="sites"]');
      if (radio) { if (radio.checked) setRadio('service', 'montage'); radio.closest('label').remove(); }
      form.querySelectorAll('[data-service="sites"]').forEach(el => el.remove());
    }
    buildOptions();
    // код — только A-Za-z0-9_-, декодировать %-последовательности не нужно (битая «%» не должна ломать страницу)
    const fromHash = decode(location.hash.slice(1));
    if (fromHash) apply(fromHash);
    form.addEventListener('input', render);
    form.addEventListener('change', event => {
      if (event.target.id === 'm-clips') event.target.value = clips();
      render();
    });
    form.addEventListener('submit', event => event.preventDefault());
    $('m-standard').addEventListener('click', () => { setOptions(P.montage.standard); render(); });
    addEventListener('hashchange', () => { const s = decode(location.hash.slice(1)); if (s) { apply(s); render(); } });
    form.hidden = false;
    render();
  }

  // ошибка загрузки цен — отдельно от ошибок init: баг в коде не должен выдаваться за «цены не загрузились»
  fetch('prices.json?v=4', {credentials: 'same-origin'})
    .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
    .then(init, () => {
      const box = document.createElement('div');
      box.className = 'wrap order-nojs';
      box.textContent = 'Не удалось загрузить цены. Обновите страницу или посмотрите «Услуги и цены».';
      form.before(box);
    });
})();
