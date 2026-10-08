// 78: маскот на главной (с 08.10, вариант Б) — 3D-кот партнёра, записанный заранее спрайтом (кадры —
// tools/mascot_capture.mjs, лист — tools/mascot_sprite.py → assets/mascot-b.webp). README, «Маскот (78)».
// - Клипы «моргнул», «прыжок», «смотрит влево / вправо» — Web Animations по transform листа спрайта шагами (steps):
//   считает композитор, JS кадров не рисует. Между клипами анимаций нет.
// - Путь с прокруткой — одна анимация transform на ScrollTimeline (прокрутка страницы), её тоже считает композитор;
//   слушателя прокрутки нет. JS только раскладывает точки маршрута по вёрстке: при загрузке и при смене размеров.
// - Прыжок к блоку и взгляд на него — когда блок доходит до середины окна (IntersectionObserver), а не по прокрутке.
// - Клипы идут, только пока маскот на экране и вкладка видна. reduced-motion — сидит у заголовка и моргает.
//   Без ScrollTimeline — тоже сидит у заголовка (моргает, прыгает). Без JS — неподвижный кот в слоте у заголовка.
// - Пока открыто окно «Согласие и cookie» (consent.js, модальное — поверх всего, фокус в нём) — клипов нет:
//   маскот под затемнением стоит и фокус не трогает (он не фокусируется, aria-hidden).
// Ничего не хранит и никуда не ходит.
(() => {
  const mascot = document.querySelector('.mascot');
  const sheet = mascot?.querySelector('.mascot-sheet');
  const slot = mascot?.parentElement;
  if (!mascot || !sheet || !slot || !('animate' in sheet)) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const phone = matchMedia('(max-width: 480px)');
  const BLINK = [3500, 6000];     // моргает раз в 3,5–6 с
  const JUMP = 12_000;            // прыгает раз в 12 с — как jumpEvery у кота партнёра
  const LOOK = 2500;              // сколько смотрит на блок

  // клипы — из mascot.css (её блок спрайта пишет mascot_sprite.py): «имя:первый кадр:кадров:кадров в секунду …».
  // Лист — сетка --cols × --rows, кадры подряд; кадр 0 — «покой» (его и видно, когда клипа нет)
  const css = getComputedStyle(mascot);
  const cols = Number(css.getPropertyValue('--cols')), rows = Number(css.getPropertyValue('--rows'));
  const clips = Object.fromEntries(css.getPropertyValue('--clips').trim().replace(/"/g, '').split(/\s+/).map(s => {
    const [name, start, frames, fps] = s.split(':').map((v, i) => i ? Number(v) : v);
    return [name, {start, frames, fps}];
  }));
  if (!cols || !rows || !clips.jump) return;
  const at = i => `translate(${-100 * (i % cols) / cols}%, ${-100 * Math.floor(i / cols) / rows}%)`;

  let current = null, held = null, heldName = null;
  const busy = () => current?.playState === 'running' || !!held;
  // клип: покой → кадры клипа → покой, каждый кадр держится 1/fps (ключевые кадры со steps(1)). hold — остаться на
  // последнем кадре (смотрит), reverse — назад к покою
  function play(name, {hold = false, reverse = false} = {}) {
    const c = clips[name];
    if (!c || !c.frames) return null;
    const list = [0, ...Array.from({length: c.frames}, (_, i) => c.start + i), ...(hold || reverse ? [] : [0])];
    const n = list.length - 1;
    const a = sheet.animate(list.map((i, k) => ({offset: k / n, transform: at(i), easing: 'steps(1, end)'})),
      {duration: n * 1000 / c.fps, fill: hold ? 'forwards' : 'none', direction: reverse ? 'reverse' : 'normal'});
    held?.cancel();
    held = hold ? a : null; heldName = hold ? name : null;
    current = a;
    return a;
  }
  // вернуть взгляд: тот же клип назад, до позы «покой»
  function release() {
    clearTimeout(lookTimer);
    if (!held) return;
    const name = heldName;
    held.cancel(); held = null; heldName = null;
    if (live()) play(name, {reverse: true});
  }

  // ---------- когда можно двигаться ----------
  let visible = false, travel = false, blinkTimer = 0, jumpTimer = 0, lookTimer = 0;
  // Клипы посреди прокрутки — лишние кадры (замер: +2,1–2,5 % ЦП при прокрутке колесом). Прокрутку видно по scrollend —
  // одно событие в конце каждого жеста, а не обработчик на каждый её кадр: 0,6 с после него — «ещё крутят», клипов нет
  // (посреди одного долгого жеста — ползунок, бросок пальцем — таймерный клип ещё может начаться);
  // прыжок к блоку — когда прокрутка постоит 0,4 с
  let lastEnd = -1e9, last = null, due = null, arriveTimer = 0;
  const scrolling = () => performance.now() - lastEnd < 600;
  addEventListener('scrollend', () => {
    lastEnd = performance.now();
    clearTimeout(arriveTimer);
    if (due) arriveTimer = setTimeout(() => { const p = due; due = null; arrive(p); }, 400);
  }, {passive: true});
  const motion = () => !reduce.matches;
  const live = () => visible && !document.hidden && !document.querySelector('dialog[open]');
  function stopClips() {
    clearTimeout(blinkTimer); clearTimeout(jumpTimer); clearTimeout(lookTimer);
    blinkTimer = jumpTimer = 0;
    // отменить, а не доиграть: доигранный взгляд (fill: forwards) оставил бы кота смотреть вбок
    current?.cancel(); held?.cancel(); current = held = heldName = null;
  }
  function blinkLater() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => { if (live() && !busy() && !scrolling()) play('blink'); blinkLater(); }, BLINK[0] + Math.random() * (BLINK[1] - BLINK[0]));
  }
  function jumpLater() {
    clearTimeout(jumpTimer);
    if (!motion()) return;
    jumpTimer = setTimeout(() => { if (live() && !busy() && !scrolling()) play('jump'); jumpLater(); }, JUMP);
  }
  function wake() {
    if (!live()) { stopClips(); return; }
    if (!blinkTimer) blinkLater();
    if (!jumpTimer) jumpLater();
  }
  new IntersectionObserver(entries => { visible = entries.at(-1).isIntersecting; wake(); }).observe(mascot);
  document.addEventListener('visibilitychange', wake);
  document.getElementById('joke-consent')?.addEventListener('close', wake);   // окно согласия закрыли — клипы снова

  // нажатие — короткий прыжок (не ссылка, ничего не открывает)
  mascot.addEventListener('click', () => {
    if (!motion() || current?.playState === 'running' && !held) return;
    clearTimeout(lookTimer); held?.cancel(); held = null; heldName = null;
    play('jump');
  });

  // ---------- маршрут ----------
  let route = null, track = null, blocks = [], io = null, settled = false;
  const box = el => { const r = el.getBoundingClientRect(); return {l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY}; };
  // правый край текста, а не блока (абзац во всю колонку, а строки короче)
  const textRight = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().right + scrollX; };

  function points(S, vw, vh, maxS) {
    const at = el => { const b = box(el); return {x: (b.l + b.r) / 2 - S / 2, y: (b.t + b.b) / 2 - S / 2}; };
    const q = s => document.querySelector(s);
    const hero = q('.hero'), stage = q('.compare-stage'), poss = q('#possibilities .feature-layout'), price = q('#price'),
      final = q('.final-cta'), finalSlot = q('.final-avatar');
    // в слоте у заголовка — размер слота (80 px, на телефоне 60): без скачка, когда маскот уходит из слота на путь
    const P0 = {...at(slot), r: 12, k: slot.offsetWidth / S || 1, el: stage, look: 'right'};
    if (!hero || !stage || !poss || !price || !final || !finalSlot) return null;
    const F = {...at(finalSlot), el: final, look: null};
    // телефон: только старт и финиш — у заголовка, пока он на экране, потом сразу у «Не откладывайте» (смена — за экраном)
    if (phone.matches) return {list: [{...P0, s: [0, P0.y + S + 20]}, {...F, s: [P0.y + S + 20, maxS]}]};
    const wrap = box(hero), margin = vw - wrap.r;
    // край: в поле справа от колонки сайта, если там есть место, иначе выглядывает из-за края окна
    // выглядывает настолько, сколько поля справа (не меньше 0,4 маскота): край колонки с текстом почти не закрывает
    const peek = margin < S + 16, edge = peek ? vw - Math.max(margin - 4, 0.4 * S) : wrap.r + (margin - S) / 2;
    const sit = (y, k = 0.5, half = 0.12) => { const s = y + S / 2 - k * vh; return [s - half * vh, s + half * vh]; };
    const list = [{...P0, s: [0, 0.12 * vh]}];
    const st = box(stage);
    const copy = Math.max(...['.hero-title-group', '.hero-description', '.hero-cta'].map(s => q(s)).filter(Boolean).map(e => e.matches('p') ? textRight(e) : box(e).r));
    if (st.l - copy >= S + 24 && st.t < P0.y + S) {
      // две колонки: вниз по проходу между заголовком и «До / После», под ним — вправо к краю
      const lane = (copy + st.l) / 2 - S / 2;
      const title = q('#possibilities-title'), gapY = title ? (wrap.b + box(title).t) / 2 - S / 2 : wrap.b;
      list.push({x: lane, y: st.b - S - 24, el: stage, look: 'right', s: sit(st.b - S - 24)});
      list.push({x: lane, y: gapY, s: sit(gapY, 0.55, 0)}, {x: edge, y: gapY, s: sit(gapY, 0.45, 0)});
    } else list.push({x: edge, y: (st.t + st.b) / 2 - S / 2, el: stage, look: 'left', s: sit((st.t + st.b) / 2 - S / 2)});
    const pb = box(poss), pr = box(price), fb = box(final);
    list.push({x: edge, y: pb.t + 24, el: poss, look: 'left', s: sit(pb.t + 24)});
    list.push({x: edge, y: pr.t + 24, el: price, look: 'left', s: sit(pr.t + 24)});
    list.push({x: edge, y: fb.t - S - 8, s: sit(fb.t - S - 8, 0.4, 0)});   // у края, мимо «Частых вопросов» — к финишу
    list.push({...F, end: true, s: [maxS, maxS]});
    // по порядку: каждая точка после предыдущей и не позже конца страницы; на переход — не меньше 0,1 окна
    const gap = 0.1 * vh, out = [];
    for (const p of list) {
      const prev = out.at(-1), from = prev ? prev.s[1] + gap : 0;
      const s0 = p.end ? maxS : Math.max(p.s[0], from), s1 = p.end ? maxS : Math.min(Math.max(p.s[1], s0), maxS - gap);
      if (!p.end && s0 > maxS - gap) continue;
      if (p.end && prev && prev.s[1] > maxS - gap) prev.s[1] = Math.max(prev.s[0], maxS - gap);
      out.push({...p, s: [s0, s1]});
    }
    return {list: out, peek};
  }

  function build() {
    route?.cancel(); route = null;
    io?.disconnect(); io = null;
    travel = motion() && typeof ScrollTimeline === 'function';
    if (!travel) {
      if (mascot.parentElement !== slot) slot.append(mascot);
      document.body.classList.remove('has-mascot-route');
      track?.remove(); track = null;
      return;
    }
    if (!track) { track = document.createElement('div'); track.className = 'mascot-track'; track.setAttribute('aria-hidden', 'true'); }
    document.body.classList.add('has-mascot-route');
    if (track.parentElement !== document.body) document.body.append(track);
    if (mascot.parentElement !== track) track.append(mascot);
    const de = document.documentElement, vw = de.clientWidth, vh = innerHeight, maxS = de.scrollHeight - vh;
    const S = mascot.offsetWidth;
    const plan = maxS > 0 && points(S, vw, vh, maxS);
    if (!plan) { slot.append(mascot); document.body.classList.remove('has-mascot-route'); track.remove(); track = null; travel = false; return; }
    const tf = p => `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) rotate(${p.r || 0}deg) scale(${(p.k || 1).toFixed(3)})`;
    // выглядывает из-за края окна — поверх края колонки: нажатия пропускает к странице (не перехватывает кнопки и карточки)
    track.classList.toggle('is-peek', !!plan.peek);
    const frames = [];
    for (const p of plan.list) {
      frames.push({offset: p.s[0] / maxS, transform: tf(p), easing: 'linear'});
      if (p.s[1] > p.s[0]) frames.push({offset: p.s[1] / maxS, transform: tf(p), easing: 'ease-in-out'});
      else frames.at(-1).easing = 'ease-in-out';
    }
    // телефон: до точки смены — у заголовка, после — у финиша (две точки с одним offset — скачок)
    for (let i = 1; i < frames.length; i++) frames[i].offset = Math.min(1, Math.max(frames[i].offset, frames[i - 1].offset));
    frames[0].offset = 0; frames.at(-1).offset = 1;
    route = mascot.animate(frames, {timeline: new ScrollTimeline({source: de, axis: 'block'}), fill: 'both'});
    // блоки по пути: дошёл до середины окна — прыжок и взгляд на него, когда прокрутка остановится
    blocks = plan.list.filter(p => p.el);
    settled = false;
    io = new IntersectionObserver(entries => {
      if (!settled) { settled = true; return; }   // первое срабатывание — при загрузке (приходит всегда), не прыгаем
      const hit = entries.filter(e => e.isIntersecting).at(-1);
      if (!hit) return;
      const p = blocks.find(b => b.el === hit.target);
      due = p;
      if (!('onscrollend' in window)) arrive(p);
    }, {rootMargin: '-45% 0px -45% 0px'});
    for (const b of new Set(blocks.map(b => b.el))) io.observe(b);
  }

  function arrive(p) {
    if (!p || p === last || !live() || !motion()) return;
    last = p;
    release();
    const a = current?.playState === 'running' ? current : play('jump');
    a?.finished.then(() => {
      if (!p.look || !live() || last !== p || busy()) return;
      play(p.look, {hold: true});
      lookTimer = setTimeout(release, LOOK);
    }).catch(() => {});
  }

  let pending = 0;
  const later = () => { clearTimeout(pending); pending = setTimeout(build, 150); };
  new ResizeObserver(later).observe(document.body);
  addEventListener('resize', later, {passive: true});   // меняется только высота окна (адресная строка телефона) — body тот же
  reduce.addEventListener('change', () => { stopClips(); build(); wake(); });
  phone.addEventListener('change', later);
  build();
})();
