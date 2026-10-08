const editToggle=document.querySelector('#edit-toggle');
editToggle.addEventListener('click',()=>{const clean=editToggle.getAttribute('aria-pressed')!=='true';editToggle.setAttribute('aria-pressed',String(clean));document.querySelector('.edit-demo').classList.toggle('is-clean',clean);editToggle.querySelector('span').textContent=clean?'Вернуть исходный текст':'Убрать лишнее';document.querySelector('#demo-time').textContent=clean?'00:32':'00:46';document.querySelector('#edit-status').textContent=clean?'Та же мысль. Без заминок.':'Нажмите и сравните';});

// Лёгкая главная (59a, README «Производительность»): прокрутка — обычная браузерная, без параллакса, ничего не
// анимируется само. Бандл эффектов партнёра (в assets/, React + WebGL) не подключается: на
// настоящей видеокарте он занимал процесс GPU целиком и вешал браузер — вместе с соседними вкладками и окнами.

// галереи «Создано с Montaggio» на странице нет (промпт 75: пустую скрытую секцию убрали до проверки ЮKassa), пока нет
// настоящих примеров с согласием людей; вернуть — разметку взять из index.html в коммите 8c34bd6 (стили остались в
// style.css, .video-gallery; ряд листается вручную, сам не едет).

// Оживление (59b, README «Оживление (59b)»): анимируются только transform, opacity и clip-path, и только пока блок
// на экране (IntersectionObserver). prefers-reduced-motion — всё неподвижно, как в 59a.
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');

const compareRange=document.querySelector('.compare-range');
compareRange.addEventListener('input',()=>{compareRange.parentElement.style.setProperty('--split',compareRange.value+'%');compareRange.setAttribute('aria-valuetext',`До: ${compareRange.value}%, после: ${100-compareRange.value}%`);});

// «До / После»: при появлении на экране ползунок один раз сам проходит 50 → 25 → 75 → 50 %, ручка «дышит» 3 раза.
// Повтор — при новом появлении, не чаще раза в 20 с; тронули ползунок — подсказки больше нет. Всё двигает transform
// (style.css, «59b»): линия, окно «после» и картинка в нём (встречно) — без пересчёта вёрстки и перерисовки.
(()=>{
  const stage=compareRange.parentElement;
  const after=stage.querySelector('.compare-after'),divider=stage.querySelector('.compare-divider'),knob=divider.firstElementChild;
  let touched=false,pressed=false,last=-Infinity,hint=[];
  const stop=()=>{hint.forEach(a=>a.cancel());hint=[];};
  const touch=()=>{touched=true;stop();};
  // тронули — ввод, клавиша или нажатие, которое не стало прокруткой (вертикальный свайп по ползунку даёт
  // pointercancel: touch-action pan-y — и это не «тронули»)
  compareRange.addEventListener('input',touch);
  compareRange.addEventListener('keydown',touch);
  compareRange.addEventListener('pointerdown',()=>{pressed=true;},{passive:true});
  compareRange.addEventListener('pointercancel',()=>{pressed=false;},{passive:true});
  compareRange.addEventListener('pointerup',()=>{if(pressed)touch();pressed=false;},{passive:true});
  reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches)stop();});
  const play=()=>{
    const way=[50,25,75,50],at=[0,.3,.72,1],ease='cubic-bezier(.45,0,.25,1)';
    const move=sign=>way.map((p,i)=>({offset:at[i],easing:ease,transform:`translateX(${sign*p}%)`}));
    hint=[
      divider.animate(move(1),{duration:2500}),
      after.animate(move(1),{duration:2500}),
      after.animate(move(-1),{duration:2500,pseudoElement:'::before'}),
      knob.animate([{transform:'translate(-50%,-50%) scale(1)'},{transform:'translate(-50%,-50%) scale(1.14)'},{transform:'translate(-50%,-50%) scale(1)'}],{duration:800,iterations:3,easing:'ease-in-out'})];
    hint[0].finished.then(()=>{hint=hint.filter(a=>a.playState!=='finished');},()=>{});
  };
  new IntersectionObserver(entries=>{
    const e=entries.at(-1);
    if(!e.isIntersecting){stop();return;}
    if(e.intersectionRatio<.6||touched||hint.length||reducedMotion.matches||performance.now()-last<20000)return;
    last=performance.now();play();
  },{threshold:[0,.6]}).observe(stage);
})();

// «Возможности». Сцены — четверти атласа feature-scenes-v2.webp (как в бандле); атлас уже в разметке, четверть
// выбирает CSS (style.css, .feature-image.is-scene, --q, --x и --y). --q — большая сторона блока: ResizeObserver
// срабатывает только при изменении размера, в покое ничего не делает.
// 59b: автопоказ по кругу, 4 с на сцену, пока блок на экране (.feature-layout.is-live ставит IntersectionObserver).
// Под активным пунктом — полоска прогресса (--scene-progress → scaleX у ::after). Нажатие — переход и отсчёт заново.
// Смена картинки (59c) — растворение: новая сцена проступает сквозь старую за FADE мс. Второй слой картинки
// (.feature-fade, копия атласа) лежит поверх, его opacity 0 → 1 ведёт CSS transition, а не таймер. По transitionend
// (и запасному таймеру) нижний слой получает новую сцену, верхний гаснет без анимации. Начатое растворение всегда
// доигрывает: наведение, фокус, «Приостановить» и нажатие останавливают только отсчёт до следующей сцены. Сразу,
// без анимации: reduced-motion, блок за экраном, вкладка скрыта. Нажатия подряд — последняя сцена побеждает.
// На «Чистом звуке» полоски звука меняют высоту (scaleY, data-beat). Прогресс и полоски — шагами одного таймера
// (TICK), а не плавной анимацией: плавная — кадр на каждое обновление экрана (замер 59b: на AMD GPU 40 %), шаги —
// несколько кадров в секунду, полоска прогресса и полоски звука — в одном кадре. За экраном таймер стоит — кадров
// нет. У preview с data-fx (вариант Б, lab/) слоя нет: картинку меняет эффект по событию montaggio:scene. Без JS и
// с prefers-reduced-motion — как в 59a: первая сцена, смена по нажатию, ничего не движется.
(()=>{
  const items=[...document.querySelectorAll('[data-feature]')];
  const layout=document.querySelector('.feature-layout');
  const preview=layout.querySelector('.feature-preview');
  const image=preview.querySelector('.feature-image');
  const prompt=document.querySelector('#feature-prompt');
  const wave=preview.querySelector('.sound-wave');
  // TICK — шаг таймера, мс; сцена — STEP мс; прогресс и полоски звука — раз в BEAT шагов; растворение — FADE мс
  // (то же число — transition в style.css, .feature-fade)
  const TICK=100,STEP=4000,BEAT=2,FADE=400;
  const scenes=[
    ['«Замени фон на светлую студию. Добавь мягкий дневной свет»','Иллюстрация: автор видео в светлой студии, мягкий дневной свет'],
    ['«Сделай аккуратную причёску и замени футболку на рубашку оверсайз»','Иллюстрация: тот же автор с аккуратной причёской, в белой рубашке оверсайз'],
    ['«Добавь золотые серьги-кольца»','Иллюстрация: тот же автор в белой рубашке и с золотыми серьгами-кольцами'],
    ['«Убери фоновый шум. Сделай голос чистым и разборчивым»','Иллюстрация: автор видео говорит в кадре, голос чистый, без фонового шума']];
  // --q — на самом preview: его наследуют оба слоя картинки
  new ResizeObserver(([e])=>preview.style.setProperty('--q',`${Math.ceil(Math.max(e.contentRect.width,e.contentRect.height))}px`)).observe(preview);
  let current=0,live=false,elapsed=0,beat=0,timer=0;
  const show=i=>{
    prompt.textContent=scenes[i][0];
    image.alt=scenes[i][1];
    image.style.setProperty('--x',String(i%2));
    image.style.setProperty('--y',String(Math.floor(i/2)));
    preview.dataset.scene=items[i].dataset.feature;
  };
  // верхний слой растворения — копия картинки, создаётся при первой смене; живёт под подписью (в разметке — сразу
  // после картинки). Что показывает слой — четверть --x/--y, как у нижнего
  let fade=null,fading=false,fadeTimer=0;
  const layer=()=>{
    if(fade)return fade;
    fade=image.cloneNode(false);
    fade.removeAttribute('loading');fade.removeAttribute('id');
    fade.alt='';fade.setAttribute('aria-hidden','true');
    fade.classList.add('feature-fade');
    fade.addEventListener('transitionend',e=>{if(e.target===fade&&e.propertyName==='opacity')finish();});
    image.after(fade);
    return fade;
  };
  const place=(el,i)=>{
    el.style.setProperty('--x',String(i%2));
    el.style.setProperty('--y',String(Math.floor(i/2)));
  };
  // закончить растворение: нижний слой получает текущую сцену, верхний гаснет без анимации. Зовут transitionend,
  // запасной таймер и settle — повторный вызов ничего не делает
  const finish=()=>{
    if(!fading)return;
    fading=false;clearTimeout(fadeTimer);
    place(image,current);
    fade.style.transition='none';
    fade.classList.remove('is-on');
    void fade.offsetWidth;
    fade.style.transition='';
  };
  // закончить переход сразу (за экраном, вкладка скрыта, reduced-motion, смена без анимации)
  const settle=()=>finish();
  // растворение к сцене i. Идёт уже одно — верхний слой просто переключается на новую сцену, переход не
  // перезапускается: последняя сцена побеждает, закончится в срок
  const dissolve=i=>{
    const top=layer();
    prompt.textContent=scenes[i][0];
    image.alt=scenes[i][1];
    preview.dataset.scene=items[i].dataset.feature;
    place(top,i);
    if(fading)return;
    fading=true;
    void top.offsetWidth;
    top.classList.add('is-on');
    fadeTimer=setTimeout(finish,FADE+150);
  };
  // смена сцены: пункт — сразу; картинка без эффекта — сразу, с эффектом — растворение (CSS transition)
  const go=(i,animate)=>{
    items[current].style.setProperty('--scene-progress','0');
    current=i;elapsed=0;
    items.forEach((x,j)=>x.setAttribute('aria-pressed',String(i===j)));
    preview.dispatchEvent(new CustomEvent('montaggio:scene',{detail:{index:i}}));
    if(animate&&!preview.dataset.fx){dissolve(i);return;}
    finish();
    show(i);
  };
  const tick=()=>{
    elapsed+=TICK;
    if(elapsed>=STEP){go((current+1)%items.length,true);return;}
    if(elapsed%(TICK*BEAT))return;
    items[current].style.setProperty('--scene-progress',String(elapsed/STEP));
    if(preview.dataset.scene==='sound')wave.dataset.beat=String(beat=(beat+1)%4);
  };
  // Автопоказ идёт, только если блок на экране, вкладка видна, нет reduced-motion, автопоказ не остановлен кнопкой
  // «Приостановить показ» (видна, когда автопоказ возможен) и посетитель не держит блок: курсор мыши над ним или
  // фокус с клавиатуры внутри (WCAG 2.2.2) — тогда ждёт. Ушёл с экрана, вкладка скрыта, reduced-motion — переход
  // заканчивается сразу.
  const pauseButton=layout.querySelector('.sequence-pause');
  let hover=false,focus=false,stopped=false;
  // .is-playing — показ идёт (таймер работает), а не просто «блок на экране»: по ней свечение кнопок (59d) знает,
  // когда круги не нужны; смену объявляет событие montaggio:playing
  const playing=v=>{
    if(layout.classList.contains('is-playing')===v)return;
    layout.classList.toggle('is-playing',v);
    layout.dispatchEvent(new CustomEvent('montaggio:playing'));
  };
  const pause=()=>{clearInterval(timer);timer=0;playing(false);};
  const update=()=>{
    const motion=!reducedMotion.matches;
    layout.classList.toggle('is-live',live&&motion);
    pauseButton.hidden=!motion;
    if(live&&motion&&!document.hidden&&!stopped&&!hover&&!focus){if(!timer)timer=setInterval(tick,TICK);playing(true);return;}
    pause();
    if(!live||!motion||document.hidden)settle();
  };
  items.forEach((item,i)=>item.addEventListener('click',()=>{
    go(i,live&&i!==current&&!reducedMotion.matches);
    // отсчёт заново; .is-playing не снимается на миг — иначе свечение кнопок (59d) запускало бы круг на каждое нажатие
    clearInterval(timer);timer=0;update();
  }));
  pauseButton.addEventListener('click',()=>{
    stopped=!stopped;
    pauseButton.setAttribute('aria-pressed',String(stopped));
    pauseButton.textContent=stopped?'Продолжить показ':'Приостановить показ';
    update();
  });
  layout.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){hover=true;update();}});
  layout.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'){hover=false;update();}});
  // фокус с клавиатуры (:focus-visible) — ждёт; на самой кнопке паузы — нет: там решает кнопка. Фокус от щелчка
  // мышью не держит — иначе «Продолжить показ» мышью не продолжал бы
  layout.addEventListener('focusin',e=>{focus=e.target!==pauseButton&&e.target.matches(':focus-visible');update();});
  layout.addEventListener('focusout',e=>{if(!layout.contains(e.relatedTarget)){focus=false;update();}});
  document.addEventListener('visibilitychange',update);
  reducedMotion.addEventListener('change',update);
  new IntersectionObserver(entries=>{live=entries.at(-1).isIntersecting;update();},{threshold:.25}).observe(layout);
})();

// Свечение кнопок «в бота» (59d, README «Свечение кнопок (59d)»): кольцо, блик и ореол рисует CSS (style.css, «59d»),
// без WebGL. Блик обегает кнопку кругами: круг LAP мс шагами (STEPS — 20 кадров/с), раз в EVERY мс, между кругами
// стоит. Не бесконечная CSS-анимация: идущая анимация на этом ноутбуке (AMD) стоит ~1,6 % ЦП рендерера даже при
// 3 кадрах/с, а между кругами анимации нет вовсе. Круг — Web Animations (rotate у :before, рисует видеокарта).
// Наведение мышью и фокус — круг сразу (если не идёт). Круги идут, только пока кнопка на экране (.is-live ставит
// IntersectionObserver); ушла с экрана или reduced-motion — круг обрывается, кольцо стоит. Кнопка только что вышла
// на экран или таймер пошёл снова — первый круг сразу. Таймер кругов стоит, когда вкладка скрыта (visibilitychange) и пока идёт автопоказ
// «Возможностей» (.feature-layout.is-playing — первая кнопка видна вместе с ним): вместе с «Чистым звуком» круги
// выводили AMD на 3,1 % ЦП / 10,1 % GPU при пределе 3 / 10 %. Показ остановлен (кнопкой, наведением, фокусом) —
// круги снова идут. Браузер без pseudoElement у Web Animations повернул бы всю ссылку — там кругов нет.
(()=>{
  if(typeof KeyframeEffect==='undefined'||!('pseudoElement' in KeyframeEffect.prototype))return;
  const LAP=1200,STEPS=24,EVERY=6000;
  const features=document.querySelector('.feature-layout');
  const bots=[...document.querySelectorAll('.button[data-destination="bot"]')];
  const seen=new Set(),laps=new Map();
  let timer=0;
  const quiet=()=>document.hidden||features.classList.contains('is-playing');
  const lap=b=>{
    if(!b.classList.contains('is-live')||laps.get(b)?.playState==='running')return;
    laps.set(b,b.animate([{transform:'rotate(0turn)'},{transform:'rotate(1turn)'}],{duration:LAP,easing:`steps(${STEPS})`,pseudoElement:'::before'}));
  };
  const tick=()=>{if(!quiet())bots.forEach(lap);};
  const update=()=>{
    let fresh=false;
    bots.forEach(b=>{
      const live=seen.has(b)&&!reducedMotion.matches,was=b.classList.contains('is-live');
      b.classList.toggle('is-live',live);
      if(!live){laps.get(b)?.cancel();laps.delete(b);}
      else if(!was)fresh=true;
    });
    const run=bots.some(b=>b.classList.contains('is-live'))&&!quiet();
    // круг сразу — и следующий через полные EVERY (иначе старый таймер дал бы второй круг через пару секунд)
    if(run&&(fresh||!timer)){clearInterval(timer);tick();timer=setInterval(tick,EVERY);}
    if(!run&&timer){clearInterval(timer);timer=0;}
  };
  bots.forEach(b=>{
    b.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')lap(b);});
    b.addEventListener('focus',()=>{if(b.matches(':focus-visible'))lap(b);});
  });
  const io=new IntersectionObserver(entries=>{entries.forEach(e=>e.isIntersecting?seen.add(e.target):seen.delete(e.target));update();});
  bots.forEach(b=>io.observe(b));
  reducedMotion.addEventListener('change',update);
  document.addEventListener('visibilitychange',update);
  features.addEventListener('montaggio:playing',update);
})();
