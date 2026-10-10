// 79: вид для телефона (≤ 600 px) — README, «Мобильная версия (79)». Всё здесь работает только на узком экране: на
// компьютере и планшете разметка остаётся как была (кнопки раскрытия не создаются, классы снимаются).
// - меню ☰ (details в шапке) закрывается по ссылке, по Esc и по нажатию мимо;
// - раскрывающиеся блоки: [data-m-fold="Подпись"] — перед блоком кнопка с подписью, блок свёрнут;
//   [data-m-fold-head] — содержимое элемента (заголовка) становится кнопкой, сворачивается следующий за ним элемент.
//   Без JS всё раскрыто. order.js строит пункты монтажа позже и зовёт событие montaggio:folds — тогда новые блоки;
// - «Услуги и цены»: переключатель услуг (.svc-tabs) — видна одна карточка; #адрес карточки выбирает её.
// Ничего не хранит и никуда не отправляет; слушателей прокрутки нет.
(() => {
  const phone = matchMedia('(max-width: 600px)');
  const root = document.documentElement;
  let uid = 0;

  // меню ☰
  const menu = document.querySelector('.m-menu');
  if (menu) {
    menu.addEventListener('click', e => { if (e.target.closest('a')) menu.open = false; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
    });
    document.addEventListener('click', e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    phone.addEventListener('change', () => { if (!phone.matches) menu.open = false; });
  }

  // раскрывающиеся блоки
  const button = label => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'm-fold-btn';
    b.setAttribute('aria-expanded', 'false');
    if (label) { const s = document.createElement('span'); s.textContent = label; b.append(s); }
    return b;
  };
  const wire = (b, body) => {
    if (!body.id) body.id = `m-fold-${++uid}`;
    b.setAttribute('aria-controls', body.id);
    body.classList.add('m-folded');
    b.addEventListener('click', () => {
      const open = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(open));
      body.classList.toggle('is-open', open);
    });
  };
  const made = [];   // что сделано на телефоне — чтобы вернуть как было на широком экране
  function fold() {
    if (!phone.matches) return;
    for (const el of document.querySelectorAll('[data-m-fold]:not(.m-folded)')) {
      const b = button(el.dataset.mFold);
      el.before(b);
      wire(b, el);
      made.push(() => { b.remove(); el.classList.remove('m-folded', 'is-open'); });
    }
    for (const head of document.querySelectorAll('[data-m-fold-head]:not([data-m-made])')) {
      const body = head.nextElementSibling;
      if (!body) continue;
      const b = button('');
      b.append(...head.childNodes);
      head.append(b);
      head.setAttribute('data-m-made', '');
      wire(b, body);
      made.push(() => { head.append(...b.childNodes); b.remove(); head.removeAttribute('data-m-made'); body.classList.remove('m-folded', 'is-open'); });
    }
    document.dispatchEvent(new CustomEvent('montaggio:folded'));
  }
  function unfold() { while (made.length) made.pop()(); }
  document.addEventListener('montaggio:folds', fold);

  // «Услуги и цены»: одна услуга на экране. Кнопки переключателя — из заголовков карточек (сколько карточек на
  // странице, столько и кнопок); создаются на телефоне, на компьютере их нет
  const cards = [...document.querySelectorAll('.services .service-card[id]')];
  let tabs = null;
  // id не карточки (#main и т. п.): при загрузке — первая карточка, при смене адреса (keep) — ничего не менять
  const pick = (id, keep) => {
    let i = cards.findIndex(c => c.id === id);
    if (i < 0) { if (keep) return; i = 0; }
    cards.forEach((c, n) => c.classList.toggle('is-current', n === i));
    tabs?.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('aria-controls') === cards[i].id)));
    // выбранная кнопка — в видимой части ленты (только по горизонтали: страница не сдвигается)
    const on = tabs?.querySelector('[aria-pressed="true"]');
    if (on) {
      const pad = parseFloat(getComputedStyle(tabs).paddingLeft) || 0;
      if (on.offsetLeft - pad < tabs.scrollLeft) tabs.scrollLeft = on.offsetLeft - pad;
      else if (on.offsetLeft + on.offsetWidth + pad > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = on.offsetLeft + on.offsetWidth + pad - tabs.clientWidth;
    }
  };
  function makeTabs() {
    if (tabs || cards.length < 2) return;
    tabs = document.createElement('div');
    tabs.className = 'svc-tabs';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Услуги');
    for (const card of cards) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-controls', card.id);
      const h2 = card.querySelector('h2'), emoji = h2.querySelector('.emoji');
      b.textContent = emoji ? `${emoji.textContent} ${h2.textContent.replace(emoji.textContent, '').trim()}` : h2.textContent.trim();
      tabs.append(b);
    }
    tabs.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      pick(b.getAttribute('aria-controls'));
      // ниже переключателя ушли — вернуть к началу карточки
      const card = document.getElementById(b.getAttribute('aria-controls'));
      if (card.getBoundingClientRect().top < tabs.getBoundingClientRect().bottom) card.scrollIntoView({block: 'start'});
    });
    cards[0].closest('.services').before(tabs);
  }
  if (cards.length > 1) addEventListener('hashchange', () => pick(location.hash.slice(1), true));

  // высота нижней панели (на узком экране и с вырезом снизу она другая) — место под неё в конце страницы и отступ
  // при переходе по якорю (--bar-h в mobile.css)
  const barIn = document.querySelector('.m-bar-in');
  if (barIn) new ResizeObserver(() => root.style.setProperty('--bar-h', `${barIn.offsetHeight}px`)).observe(barIn);

  // «Возможности»: описание сцены высотой по самому длинному из четырёх при этой ширине — смена сцены (и автопоказ)
  // не двигает страницу ниже. Меряется скрытой копией абзаца при смене ширины
  const note = document.getElementById('feature-note');
  if (note) {
    const texts = [...document.querySelectorAll('[data-feature] .feature-body')].map(b => b.textContent);
    let width = -1;
    new ResizeObserver(() => {
      if (!phone.matches) { note.style.minHeight = ''; width = -1; return; }
      if (note.clientWidth === width) return;
      width = note.clientWidth;
      const probe = note.cloneNode(false);
      probe.removeAttribute('id');
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, {position: 'absolute', visibility: 'hidden', minHeight: '0', width: `${width}px`});
      note.after(probe);
      let h = 0;
      for (const t of texts) { probe.textContent = t; h = Math.max(h, probe.offsetHeight); }
      probe.remove();
      note.style.minHeight = `${h}px`;
    }).observe(note);
  }

  const apply = () => {
    if (phone.matches) makeTabs();
    root.classList.toggle('m-tabs', phone.matches && !!tabs);
    // лента видна — выбрать карточку (по адресу при первом показе) и показать её кнопку
    if (phone.matches && tabs) pick(cards.find(c => c.classList.contains('is-current'))?.id ?? location.hash.slice(1));
    if (phone.matches) fold(); else unfold();
  };
  phone.addEventListener('change', apply);
  apply();
})();
