// Шуточное согласие (С-6, промпт 75, доделка 2 — решение владельца 08.10): окно при первом открытии сайта за визит.
// Галочки никуда не отправляются. Хранится только отметка «окно закрыто» — в sessionStorage, до закрытия вкладки
// (новый визит или новая вкладка — окно снова); ни cookie, ни localStorage. sessionStorage недоступен — окно на каждой
// странице, без ошибок. Разметка окна — в подвале (tools/layout.py, JOKE_CONSENT).
(() => {
  const dialog = document.getElementById('joke-consent');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const KEY = 'montaggio-consent-closed';
  const seen = () => { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
  const remember = () => { try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* без хранилища — окно снова */ } };
  const open = () => { if (!dialog.open) { dialog.showModal(); laugh(); } };

  // 78, доделка 2: кот у заголовка смеётся, пока окно открыто. Лист — assets/mascot-laugh.webp, кадры и скорость — блок
  // laugh в pages.css (mascot_sprite.py --set laugh). Клип — Web Animations по transform шагами (считает композитор):
  // улыбка → смех (подскок) → улыбка, потом PAUSE мс улыбается и снова (в движении ~1/3 времени: бюджет 78 в покое). Закрыли окно или вкладку — смех
  // обрывается, таймер стоит. reduced-motion — только улыбка. Кот aria-hidden и не фокусируется: фокус — на «Согласен».
  const sheet = dialog.querySelector('.joke-cat-sheet');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const PAUSE = 2400;
  let laughTimer = 0, laughing = null;
  function stop() { clearTimeout(laughTimer); laughing?.cancel(); laughing = null; }
  function laugh() {
    stop();
    if (!dialog.open || document.hidden || reduced.matches || !sheet || !('animate' in sheet)) return;
    const css = getComputedStyle(sheet.closest('.joke-cat'));
    const cols = Number(css.getPropertyValue('--cols')), rows = Number(css.getPropertyValue('--rows'));
    const [, start, count, fps] = (css.getPropertyValue('--clips').replace(/"/g, '').trim().split(/\s+/)[0] || '').split(':').map(Number);
    if (!cols || !rows || !count || !fps) return;
    const at = i => `translate(${-100 * (i % cols) / cols}%, ${-100 * Math.floor(i / cols) / rows}%)`;
    const list = [0, ...Array.from({length: count}, (_, i) => start + i), start + 1, start, 0];
    const n = list.length - 1;
    laughing = sheet.animate(list.map((i, k) => ({offset: k / n, transform: at(i), easing: 'steps(1, end)'})), {duration: n * 1000 / fps});
    laughing.finished.then(() => { laughTimer = setTimeout(laugh, PAUSE); }).catch(() => {});
  }
  dialog.addEventListener('close', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else laugh(); });
  reduced.addEventListener('change', laugh);

  dialog.addEventListener('close', remember);
  dialog.querySelector('.joke-agree').addEventListener('click', () => {
    dialog.querySelectorAll('input[type=checkbox]').forEach(box => { box.checked = true; });
    remember();   // сразу, не дожидаясь события close (оно приходит позже)
    dialog.close();
  });
  document.querySelectorAll('.joke-open').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    open();
  }));
  if (!seen()) open();
})();
