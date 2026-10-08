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
  const open = () => { if (!dialog.open) dialog.showModal(); };

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
