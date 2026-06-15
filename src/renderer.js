'use strict';

// ---------------------------------------------------------------------------
// Hubble renderer.
//
// Модель окон: панели-«окна» внутри одного окна приложения, разложенные
// авто-тайлингом. Раскладка хранится как дерево бинарных разбиений (BSP):
//   leaf  = { leaf:true, id }                      — окно сервиса
//   split = { leaf:false, dir:'row'|'col', ratio, a, b }
// 'row' — дети слева/справа (вертикальный разделитель), 'col' — сверху/снизу.
// Новое окно делит самую большую (или активную) плитку вдоль длинной стороны.
// Перетаскивание разделителя меняет ratio соответствующего split-узла —
// это и есть «изменение размера как в Windows».
// ---------------------------------------------------------------------------

const tilesEl = document.getElementById('tiles');
const emptyState = document.getElementById('empty-state');
const shield = document.getElementById('drag-shield');
const taskbarApps = document.getElementById('taskbar-apps');
const openAllBtn = document.getElementById('open-all');

const playerEl = document.getElementById('player');
const playPauseBtn = playerEl.querySelector('[data-pact=playpause]');
const volRange = document.getElementById('player-volume');
const volIco = playerEl.querySelector('[data-pact=mute]');

const GAP = 6;   // зазор между плитками (px)
const HIT = 14;  // ширина зоны захвата разделителя (px)
const SWAP_THRESHOLD = 5; // порог начала drag-to-swap (px)
const MIN_RATIO = 0.12;
const MAX_RATIO = 0.88;
const MEDIA_POLL_MS = 1000;

// iOS-подобные анимации окон (открытие/сворачивание).
const ANIM_MS = 340;
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';   // мягкое торможение — открытие/растворение/реколэйаут
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Селекторы кнопок плеера для известных сервисов (best-effort, для сайтов, где
// нет управляемого <audio>/<video> в обычном DOM — напр. Spotify/Я.Музыка).
const SITE = {
  'soundcloud.com': { play: '.playControls__play', next: '.skipControl__next', prev: '.skipControl__previous' },
  'music.yandex.ru': {
    // Транспорт Я.Музыки идёт через window.externalAPI (см. mediaCmd) — он переживает
    // редизайны DOM. Селекторы ниже — лишь фолбэк на случай, если externalAPI недоступен;
    // после редизайна 2024 data-test-id="*_BUTTON" перестали совпадать (отсюда регрессия
    // паузы/перемотки). Широкие aria-селекторы намеренно не используем: они совпадали с play
    // в строке трека / «Моей волне» и пауза запускала чужой трек.
    play: '[data-test-id="PLAY_BUTTON"], .player-controls__btn_play',
    next: '[data-test-id="NEXT_TRACK_BUTTON"], .d-icon_track-next',
    prev: '[data-test-id="PREV_TRACK_BUTTON"], .d-icon_track-prev'
  },
  'open.spotify.com': {
    play: '[data-testid="control-button-playpause"]',
    next: '[data-testid="control-button-skip-forward"]',
    prev: '[data-testid="control-button-skip-back"]'
  },
  'youtube.com': { play: '.ytp-play-button', next: '.ytp-next-button', prev: '.ytp-prev-button' },
  'music.youtube.com': { play: '#play-pause-button', next: '.next-button', prev: '.previous-button' },
  'twitch.tv': { play: 'button[data-a-target="player-play-pause-button"]' }
};

// Помощник, пробивающий shadow DOM (Я.Музыка/Spotify прячут элементы в shadow root).
const DEEP_FN = `function __deep(sel){var o=[];function w(r){try{var n=r.querySelectorAll(sel);for(var i=0;i<n.length;i++)o.push(n[i]);}catch(e){}var a;try{a=r.querySelectorAll('*');}catch(e){a=[];}for(var i=0;i<a.length;i++){if(a[i].shadowRoot)w(a[i].shadowRoot);}}w(document);return o;}`;

// UA совпадает с реальным Chromium Electron 33 (Chrome 130) — иначе сайты ругаются на
// «устаревший/небезопасный браузер» (так Google блокирует вход). Держать в синхроне с main.js.
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Шаги зума как в Chrome (множитель). Ctrl +/− двигают по списку, Ctrl 0 — сброс на 100%.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Следующий фактор зума от текущего: ищем ближайший шаг и сдвигаемся на один (или сброс на 1).
function nextZoom(cur, dir) {
  if (dir === 'reset') return 1;
  let idx = 0, best = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - cur);
    if (d < best) { best = d; idx = i; }
  }
  idx = dir === 'in' ? Math.min(ZOOM_STEPS.length - 1, idx + 1) : Math.max(0, idx - 1);
  return ZOOM_STEPS[idx];
}

/** @type {Map<string,{app:object, button:HTMLElement}>} */
const services = new Map();
/** @type {Map<string,{app:object, el:HTMLElement, webview:HTMLElement}>} */
const tiles = new Map();

let tree = null;          // корень BSP-дерева раскладки (или null)
let focusedId = null;     // активное окно
let maximizedId = null;   // развёрнутое на всю область окно (или null)
let currentSplits = [];   // split-узлы текущего дерева (для разделителей)

let playerTargetId = null; // окно-цель плеера: активное, если в нём есть медиа, иначе играющее (см. resolvePlayerTarget)
let volumes = {};          // громкость по сервисам {id: 0..1} — у каждого окна своя, сохраняется в settings
let lastResults = [];      // последний снимок media-опроса (мгновенный пересчёт цели при смене фокуса)
let saveVolTimers = {};    // дебаунс записи громкости в настройки, по сервисам
let polling = false;       // защита от наложения опросов media
let lastCmdAt = 0;         // дебаунс команд плеера (двойной клик → двойное срабатывание)

// Сохранённая громкость сервиса (0..1), по умолчанию 1.
function volumeFor(id) {
  const v = volumes[id];
  return typeof v === 'number' ? clamp(v, 0, 1) : 1;
}

// ---------------------------------------------------------------------------
// Инициализация
// ---------------------------------------------------------------------------

async function init() {
  const apps = await window.hubble.getApps();

  // hidden:true — сервис остаётся в конфиге/коде, но без иконки в пилюле. Раз его нет в
  // `services`, его нельзя открыть, он не попадает в openAll(), а prune() выкидывает его
  // плитку из сохранённой раскладки. Вернуть = убрать "hidden" в apps.json (см. Spotify).
  for (const app of apps) if (!app.hidden) buildTaskbarButton(app);

  // Восстанавливаем прошлую раскладку.
  const ws = await window.hubble.getWorkspace();
  if (ws && ws.tree) {
    tree = prune(ws.tree);
    if (tree) {
      focusedId = ws.focusedId && findLeaf(tree, ws.focusedId) ? ws.focusedId : firstLeaf(tree).id;
      maximizedId = ws.maximizedId && findLeaf(tree, ws.maximizedId) ? ws.maximizedId : null;
    }
  }

  // Восстанавливаем сохранённую громкость по сервисам (применится к webview на dom-ready,
  // слайдер подстроится под окно-цель в updatePlayerUI).
  const storedVols = await window.hubble.getVolumes();
  if (storedVols && typeof storedVols === 'object') {
    for (const [id, v] of Object.entries(storedVols)) {
      if (typeof v === 'number' && isFinite(v)) volumes[id] = clamp(v, 0, 1);
    }
  }

  openAllBtn.addEventListener('click', openAll);
  window.addEventListener('resize', relayout);
  new ResizeObserver(relayout).observe(tilesEl);

  wireWindowControls();
  wirePlayer();
  wireScreenPicker();

  // Клик по нативному уведомлению — открыть/показать сервис.
  window.hubble.onFocusApp((id) => { if (id && services.has(id)) toggleOpenFocus(id); });
  window.hubble.onUnreadCount(({ appId, count } = {}) => updateBadge(appId, count));

  // Зум активной плитки: из webview (через main → onZoom) и когда фокус на хосте (keydown тут).
  window.hubble.onZoom((dir) => zoomFocused(dir));
  window.addEventListener('keydown', onZoomKey);

  syncDom();
  setInterval(pollMedia, MEDIA_POLL_MS);
}

// ---------------------------------------------------------------------------
// Кнопки управления окном (frameless)
// ---------------------------------------------------------------------------

function wireWindowControls() {
  document.getElementById('win-min').addEventListener('click', () => window.hubble.windowControl('minimize'));
  document.getElementById('win-max').addEventListener('click', () => window.hubble.windowControl('maximize'));
  document.getElementById('win-close').addEventListener('click', () => window.hubble.windowControl('close'));
  window.hubble.onMaximizeChange((isMax) => {
    const b = document.getElementById('win-max');
    b.textContent = isMax ? '❐' : '▢';
    b.title = isMax ? 'Восстановить' : 'Развернуть';
  });
}

// ---------------------------------------------------------------------------
// Пилюля-таскбар
// ---------------------------------------------------------------------------

function buildTaskbarButton(app) {
  const button = document.createElement('button');
  button.className = 'taskbar-btn';
  button.dataset.id = app.id;
  button.title = app.name;
  button.setAttribute('aria-label', app.name);

  const icon = document.createElement('img');
  icon.className = 'taskbar-icon';
  icon.alt = app.name;
  icon.src = resolveIcon(app.icon);
  icon.addEventListener('error', () => icon.replaceWith(makeFallbackIcon(app.name)));

  const dot = document.createElement('span');
  dot.className = 'taskbar-dot';

  button.append(icon, dot);
  button.addEventListener('click', () => toggleOpenFocus(app.id));

  taskbarApps.appendChild(button);
  services.set(app.id, { app, button });
}

function makeFallbackIcon(name) {
  const span = document.createElement('span');
  span.className = 'taskbar-icon sidebar-icon-fallback';
  span.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return span;
}

function resolveIcon(iconPath) {
  if (!iconPath) return '';
  if (/^https?:\/\//i.test(iconPath)) return iconPath;
  return iconPath.startsWith('assets/') ? `../${iconPath}` : iconPath;
}

function updateTaskbar() {
  for (const [id, s] of services) {
    const open = tiles.has(id);
    s.button.classList.toggle('open', open);
    s.button.classList.toggle('focused', open && id === focusedId);
  }
}

function updateBadge(appId, count) {
  // Бейдж непрочитанных можно показать на кнопке таскбара (для неактивных окон).
  if (!appId || appId === focusedId) return;
  const s = services.get(appId);
  if (!s) return;
  let badge = s.button.querySelector('.taskbar-badge');
  const n = Number(count) || 0;
  if (n <= 0) { if (badge) badge.hidden = true; return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'sidebar-badge taskbar-badge';
    badge.style.cssText = 'position:absolute;top:1px;right:1px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#e8484f;color:#fff;font:600 10px/16px sans-serif;text-align:center;';
    s.button.appendChild(badge);
  }
  badge.hidden = false;
  badge.textContent = n > 99 ? '99+' : String(n);
}

// ---------------------------------------------------------------------------
// iOS-подобные анимации окон (genie-открытие + растворение + плавный реколэйаут)
//
// Плитки позиционируются абсолютно (left/top/width/height в px). Чтобы движения
// не дёргались, анимируем через CSS transform/opacity поверх готовой раскладки:
//  • открытие — новая плитка «вырастает» из своей иконки в пилюле (genie in);
//  • сворачивание — плитка «растворяется вдаль» (scale↓ + fade по центру), затем удаляется;
//  • соседние плитки доезжают в новые позиции по технике FLIP (без layout-трэша).
// Анимации НЕ вешаем на ресайз окна и перетаскивание разделителя — там нужна
// мгновенная реакция (их геометрию двигает relayout напрямую, без этих хелперов).
//
// Плавность (иначе анимация «в 2 fps»):
//  • `will-change: transform` промоутит плитку в отдельный GPU-слой — иначе тяжёлый
//    многослойный box-shadow плитки перерисовывается на main-thread каждый кадр.
//  • на открытии прячем webview (`visibility:hidden`): его слой иначе ре-растеризуется
//    на каждый шаг масштабирования. Контент при открытии всё равно ещё грузится —
//    скрытие незаметно, показываем по завершении полёта.
// ---------------------------------------------------------------------------

// Снимок экранных прямоугольников всех плиток — основа FLIP-реколэйаута.
function snapshotRects() {
  const m = new Map();
  for (const [id, t] of tiles) m.set(id, t.el.getBoundingClientRect());
  return m;
}

// Трансформация, переносящая плитку в центр её иконки в пилюле (translate + scale).
// transform-origin:center → translate двигает центр, scale ужимает к точке иконки.
function genieToIcon(el, id) {
  const s = services.get(id);
  const tr = el.getBoundingClientRect();
  if (!s || tr.width < 1 || tr.height < 1) return null;
  const ir = s.button.getBoundingClientRect();
  const tx = (ir.left + ir.width / 2) - (tr.left + tr.width / 2);
  const ty = (ir.top + ir.height / 2) - (tr.top + tr.height / 2);
  const scale = Math.max(0.05, ir.width / tr.width);
  return { tx, ty, scale };
}

// Сброс временных inline-стилей анимации (после её завершения возвращаем CSS-управление).
function clearAnimSoon(el, ms = ANIM_MS) {
  clearTimeout(el._animTimer);
  el._animTimer = setTimeout(() => {
    el.style.transition = '';
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.opacity = '';
    el.style.zIndex = '';
    el.style.pointerEvents = '';
    el.style.willChange = '';
  }, ms + 60);
}

// FLIP: доводим уже существующие плитки из старых позиций (prevRects) в новые —
// инвертируем сдвиг трансформом без анимации, затем на след. кадре отпускаем к нулю.
function flipReflow(prevRects, skipId) {
  if (reduceMotion || !prevRects) return;
  for (const [id, t] of tiles) {
    if (id === skipId) continue; // эту плитку анимируем genie-ом, не FLIP-ом
    const prev = prevRects.get(id);
    if (!prev) continue;
    const el = t.el;
    const now = el.getBoundingClientRect();
    if (now.width < 1 || now.height < 1) continue;
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    const sx = prev.width / now.width;
    const sy = prev.height / now.height;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.004 && Math.abs(sy - 1) < 0.004) continue;
    el.style.willChange = 'transform'; // GPU-слой: иначе box-shadow перерисовывается каждый кадр
    el.style.transition = 'none';
    el.style.transformOrigin = 'top left';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void el.offsetWidth; // зафиксировать стартовое (инвертированное) состояние
    requestAnimationFrame(() => {
      el.style.transition = `transform ${ANIM_MS}ms ${EASE_OUT}`;
      el.style.transform = 'none';
    });
    clearAnimSoon(el);
  }
}

// Открытие: новая плитка вырастает из своей иконки в пилюле.
function animateGenieIn(id) {
  if (reduceMotion) return;
  const t = tiles.get(id);
  if (!t) return;
  const g = genieToIcon(t.el, id);
  if (!g) return;
  const el = t.el;
  t.webview.style.visibility = 'hidden'; // не ре-растеризуем тяжёлый webview-слой при масштабе
  el.style.willChange = 'transform, opacity';
  el.style.transition = 'none';
  el.style.transformOrigin = 'center';
  el.style.transform = `translate(${g.tx}px, ${g.ty}px) scale(${g.scale})`;
  el.style.opacity = '0';
  void el.offsetWidth;
  requestAnimationFrame(() => {
    el.style.transition = `transform ${ANIM_MS}ms ${EASE_OUT}, opacity ${ANIM_MS}ms ease-out`;
    el.style.transform = 'none';
    el.style.opacity = '1';
  });
  setTimeout(() => { t.webview.style.visibility = ''; }, ANIM_MS); // показываем контент по приземлении
  clearAnimSoon(el);
}

// Сворачивание: плитка «растворяется вдаль» — отдаляется (scale↓) и тает (opacity→0)
// по своему центру, НЕ в иконку. По завершении (after) дерево реально меняется.
function animateDissolve(id, after) {
  const t = tiles.get(id);
  if (reduceMotion || !t) { after(); return; }
  const el = t.el;
  el.style.willChange = 'transform, opacity';
  el.style.transformOrigin = 'center';
  el.style.transition = `transform ${ANIM_MS}ms ${EASE_OUT}, opacity ${ANIM_MS}ms ${EASE_OUT}`;
  el.style.pointerEvents = 'none';
  el.style.zIndex = '6'; // тает поверх соседей
  requestAnimationFrame(() => {
    el.style.transform = 'scale(0.82)'; // отдаляется «вдаль»
    el.style.opacity = '0';
  });
  setTimeout(after, ANIM_MS);
}

// ---------------------------------------------------------------------------
// Открытие / закрытие / фокус окон
// ---------------------------------------------------------------------------

function toggleOpenFocus(id) {
  if (tiles.has(id)) {
    if (maximizedId) { maximizedId = id; updateMaxButtons(); relayout(); }
    setFocus(id);
  } else {
    openWindow(id);
  }
}

function openWindow(id, mode = 'focused', animate = true) {
  if (tiles.has(id) || !services.has(id)) { setFocus(id); return; }

  const prevRects = animate ? snapshotRects() : null;
  const leaf = { leaf: true, id };
  if (!tree) {
    tree = leaf;
  } else {
    measure(); // нужны актуальные _rect для выбора цели и направления
    let target = mode === 'focused' && focusedId && findLeaf(tree, focusedId)
      ? findLeaf(tree, focusedId)
      : largestLeaf();
    if (!target) target = largestLeaf();
    const dir = chooseDir(target._rect);
    replaceNode(target, { leaf: false, dir, ratio: 0.5, a: target, b: leaf });
  }

  maximizedId = null;
  focusedId = id;
  syncDom();
  persist();

  if (animate) {
    flipReflow(prevRects, id);  // соседи плавно ужимаются под новое окно
    animateGenieIn(id);         // новое окно вырастает из своей иконки
  }
}

function closeWindow(id) {
  if (!tree || !findLeaf(tree, id)) return;

  // Сначала «растворяем» окно вдаль, и лишь по завершении меняем дерево и
  // освобождаем место — иначе соседи дёрнулись бы до того, как окно растает.
  animateDissolve(id, () => {
    const leaf = findLeaf(tree, id);
    if (!leaf) return;
    const prevRects = snapshotRects();

    if (tree === leaf) {
      tree = null;
    } else {
      const p = findParent(tree, leaf);
      const sibling = p.a === leaf ? p.b : p.a;
      if (p === tree) tree = sibling;
      else {
        const gp = findParent(tree, p);
        if (gp.a === p) gp.a = sibling; else gp.b = sibling;
      }
    }

    if (maximizedId === id) maximizedId = null;
    if (focusedId === id) focusedId = tree ? firstLeaf(tree).id : null;
    syncDom();
    persist();
    flipReflow(prevRects, id); // оставшиеся плитки плавно занимают освободившееся место
  });
}

function openAll() {
  for (const id of services.keys()) {
    if (!tiles.has(id)) openWindow(id, 'largest', false); // без genie — открываем пачкой
  }
  maximizedId = null;
  updateMaxButtons();
  relayout();
  persist();
}

function setFocus(id) {
  if (!tiles.has(id)) return;
  focusedId = id;
  for (const [tid, t] of tiles) t.el.classList.toggle('focused', tid === id);
  updateTaskbar();
  applyPlayerTarget(); // плеер и громкость следуют за активным окном
  persist();
}

function toggleMaximize(id) {
  if (!tiles.has(id)) return;
  maximizedId = maximizedId === id ? null : id;
  if (maximizedId) focusedId = id;
  updateMaxButtons();
  relayout();
  if (maximizedId) setFocus(id); else persist();
}

function updateMaxButtons() {
  for (const [id, t] of tiles) {
    const btn = t.el.querySelector('[data-act=max]');
    if (btn) {
      btn.textContent = maximizedId === id ? '▭' : '▢';
      btn.title = maximizedId === id ? 'Свернуть' : 'Развернуть';
    }
    t.el.classList.toggle('maximized', maximizedId === id);
  }
}

// ---------------------------------------------------------------------------
// DOM-синхронизация (создание/удаление плиток и разделителей по дереву)
// ---------------------------------------------------------------------------

function syncDom() {
  const ids = tree ? collectLeaves(tree) : [];

  // Удаляем плитки закрытых окон.
  for (const id of [...tiles.keys()]) {
    if (!ids.includes(id)) {
      tiles.get(id).el.remove();
      tiles.delete(id);
    }
  }
  // Создаём недостающие плитки (лениво — webview только для открытых окон).
  for (const id of ids) if (!tiles.has(id)) createTile(id);

  // Пересобираем разделители.
  for (const d of tilesEl.querySelectorAll('.divider')) d.remove();
  currentSplits = tree ? collectSplits(tree) : [];
  for (const split of currentSplits) {
    const d = document.createElement('div');
    d.className = 'divider ' + split.dir;
    d.addEventListener('mousedown', (e) => startDividerDrag(split, d, e));
    tilesEl.appendChild(d);
    split._divEl = d;
  }

  emptyState.hidden = !!tree;
  updateTaskbar();
  updateMaxButtons();
  if (focusedId) setFocusClass(focusedId);
  relayout();
}

function setFocusClass(id) {
  for (const [tid, t] of tiles) t.el.classList.toggle('focused', tid === id);
}

// ---------------------------------------------------------------------------
// Зум страниц (Ctrl +/−/0, как в Chrome) — по активной плитке
// ---------------------------------------------------------------------------

// Обработчик клавиш, когда фокус на хосте (таскбар/титлбар), а не в webview.
// Из самого webview клавиши приходят через main → onZoom (webview их «съедает»).
function onZoomKey(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  let dir = null;
  if (e.key === '=' || e.key === '+') dir = 'in';
  else if (e.key === '-' || e.key === '_') dir = 'out';
  else if (e.key === '0') dir = 'reset';
  if (!dir) return;
  e.preventDefault();
  zoomFocused(dir);
}

function zoomFocused(dir) {
  const t = focusedId && tiles.has(focusedId) ? tiles.get(focusedId) : null;
  if (!t) return;
  const factor = nextZoom(typeof t.zoom === 'number' ? t.zoom : 1, dir);
  t.zoom = factor;
  try { t.webview.setZoomFactor(factor); } catch { /* webview ещё не подключён */ }
  showZoomIndicator(t, factor);
}

// Кратко показываем процент зума в углу плитки (как всплывающая подсказка Chrome).
function showZoomIndicator(entry, factor) {
  let badge = entry.el.querySelector('.tile-zoom');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'tile-zoom';
    entry.el.appendChild(badge);
  }
  badge.textContent = Math.round(factor * 100) + '%';
  badge.classList.add('show');
  clearTimeout(entry._zoomTimer);
  entry._zoomTimer = setTimeout(() => badge.classList.remove('show'), 900);
}

function createTile(id) {
  const app = services.get(id).app;
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = id;
  el.innerHTML = `
    <div class="tile-header">
      <img class="tile-ico" alt="">
      <span class="tile-title"></span>
      <div class="tile-actions">
        <button class="tile-btn" data-act="back" title="Назад">‹</button>
        <button class="tile-btn" data-act="fwd" title="Вперёд">›</button>
        <button class="tile-btn" data-act="reload" title="Обновить">⟳</button>
        <button class="tile-btn" data-act="max" title="Развернуть">▢</button>
        <button class="tile-btn tile-close" data-act="close" title="Закрыть">×</button>
      </div>
    </div>
    <div class="tile-body"><div class="tile-loadbar"></div></div>`;

  const ico = el.querySelector('.tile-ico');
  ico.src = resolveIcon(app.icon);
  ico.addEventListener('error', () => ico.replaceWith(makeFallbackIcon(app.name)));
  el.querySelector('.tile-title').textContent = app.name;

  const wv = document.createElement('webview');
  wv.setAttribute('src', app.url);
  wv.setAttribute('partition', app.partition); // persist:* → сессия сохраняется
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('useragent', app.userAgent || DEFAULT_UA);
  el.querySelector('.tile-body').appendChild(wv);

  let host = '';
  try { host = new URL(app.url).hostname.replace(/^www\./, ''); } catch {}
  const vol = volumeFor(id);
  const entry = { app, el, webview: wv, host, zoom: 1, volume: vol, lastVol: vol > 0 ? vol : 1 };
  tiles.set(id, entry);

  // Фокус по клику в любом месте плитки (capture — webview перехватывает события).
  el.addEventListener('mousedown', () => setFocus(id), true);

  const header = el.querySelector('.tile-header');
  header.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tile-btn')) toggleMaximize(id);
  });
  // Drag-to-swap: тащим окно за шапку и бросаем на другое — меняются местами.
  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.tile-btn')) return;
    startTileDrag(id, e);
  });

  el.querySelector('[data-act=back]').addEventListener('click', () => { try { if (wv.canGoBack()) wv.goBack(); } catch {} });
  el.querySelector('[data-act=fwd]').addEventListener('click', () => { try { if (wv.canGoForward()) wv.goForward(); } catch {} });
  el.querySelector('[data-act=reload]').addEventListener('click', () => { try { wv.reload(); } catch {} });
  el.querySelector('[data-act=max]').addEventListener('click', () => toggleMaximize(id));
  el.querySelector('[data-act=close]').addEventListener('click', () => closeWindow(id));

  // На dom-ready ставим хуки: master-gain (через volumeJS) и перехват mediaSession-транспорта.
  // Оба идемпотентны и инжектятся рано — до того, как сайт построит аудиограф / зарегистрирует
  // обработчики медиа-действий (это обычно происходит на первом play, позже dom-ready).
  wv.addEventListener('dom-ready', () => {
    applyVolumeTo(wv, entry.volume);
    try { wv.setZoomFactor(entry.zoom || 1); } catch { /* зум переживает reload/навигацию */ }
    try { wv.executeJavaScript(MEDIA_SESSION_HOOK, true); } catch { /* webview ещё не готов */ }
    // Telegram: глушим автозапуск видеосообщений-«кружок» (см. TG_NO_AUTOROUND).
    if (id === 'telegram') { try { wv.executeJavaScript(TG_NO_AUTOROUND, true); } catch {} }
  });
  wv.addEventListener('did-start-loading', () => el.classList.add('loading'));
  wv.addEventListener('did-stop-loading', () => { el.classList.remove('loading'); updateNav(entry); });
  wv.addEventListener('did-navigate', () => updateNav(entry));
  wv.addEventListener('did-navigate-in-page', () => updateNav(entry));
  wv.addEventListener('focus', () => setFocus(id));

  tilesEl.appendChild(el);
}

function updateNav(entry) {
  try {
    entry.el.querySelector('[data-act=back]').disabled = !entry.webview.canGoBack();
    entry.el.querySelector('[data-act=fwd]').disabled = !entry.webview.canGoForward();
  } catch {
    /* webview ещё не прикреплён */
  }
}

// ---------------------------------------------------------------------------
// Раскладка: расчёт прямоугольников из дерева и позиционирование
// ---------------------------------------------------------------------------

function measure() {
  if (!tree) return;
  const W = tilesEl.clientWidth;
  const H = tilesEl.clientHeight;
  (function walk(n, x, y, w, h) {
    n._rect = { x, y, w, h };
    if (n.leaf) return;
    if (n.dir === 'row') {
      const aw = w * n.ratio;
      walk(n.a, x, y, aw, h);
      walk(n.b, x + aw, y, w - aw, h);
    } else {
      const ah = h * n.ratio;
      walk(n.a, x, y, w, ah);
      walk(n.b, x, y + ah, w, h - ah);
    }
  })(tree, 0, 0, W, H);
}

function applyLayout() {
  // Развёрнутое окно занимает всю область, остальные скрыты.
  if (maximizedId && tiles.has(maximizedId)) {
    const W = tilesEl.clientWidth, H = tilesEl.clientHeight;
    for (const [id, t] of tiles) t.el.style.display = id === maximizedId ? 'flex' : 'none';
    placeTile(tiles.get(maximizedId).el, 0, 0, W, H);
    for (const s of currentSplits) if (s._divEl) s._divEl.style.display = 'none';
    return;
  }

  for (const [, t] of tiles) t.el.style.display = 'flex';
  for (const s of currentSplits) if (s._divEl) s._divEl.style.display = 'block';

  if (!tree) return;
  (function place(n) {
    if (n.leaf) {
      const t = tiles.get(n.id);
      if (t) placeTile(t.el, n._rect.x, n._rect.y, n._rect.w, n._rect.h);
      return;
    }
    place(n.a);
    place(n.b);
    positionDivider(n);
  })(tree);
}

function relayout() {
  measure();
  applyLayout();
}

function placeTile(el, x, y, w, h) {
  el.style.left = (x + GAP) + 'px';
  el.style.top = (y + GAP) + 'px';
  el.style.width = Math.max(0, w - 2 * GAP) + 'px';
  el.style.height = Math.max(0, h - 2 * GAP) + 'px';
}

function positionDivider(split) {
  const d = split._divEl;
  if (!d) return;
  const r = split._rect;
  if (split.dir === 'row') {
    const bx = r.x + r.w * split.ratio;
    d.style.left = (bx - HIT / 2) + 'px';
    d.style.top = r.y + 'px';
    d.style.width = HIT + 'px';
    d.style.height = r.h + 'px';
  } else {
    const by = r.y + r.h * split.ratio;
    d.style.left = r.x + 'px';
    d.style.top = (by - HIT / 2) + 'px';
    d.style.width = r.w + 'px';
    d.style.height = HIT + 'px';
  }
}

// ---------------------------------------------------------------------------
// Перетаскивание разделителя (ресайз соседних окон)
// ---------------------------------------------------------------------------

function startDividerDrag(split, divEl, e) {
  e.preventDefault();
  document.body.classList.add('dragging');
  divEl.classList.add('active');
  shield.hidden = false;
  shield.style.cursor = split.dir === 'row' ? 'col-resize' : 'row-resize';

  const cont = tilesEl.getBoundingClientRect();
  const rect = split._rect; // прямоугольник самого split не меняется при ресайзе детей

  function onMove(ev) {
    if (split.dir === 'row') {
      split.ratio = clamp((ev.clientX - cont.left - rect.x) / rect.w, MIN_RATIO, MAX_RATIO);
    } else {
      split.ratio = clamp((ev.clientY - cont.top - rect.y) / rect.h, MIN_RATIO, MAX_RATIO);
    }
    relayout();
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('dragging');
    divEl.classList.remove('active');
    shield.hidden = true;
    persist();
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---------------------------------------------------------------------------
// Drag-to-swap: перетаскивание окна за шапку для обмена местами
// ---------------------------------------------------------------------------

function startTileDrag(id, e) {
  if (maximizedId) return; // в развёрнутом режиме обмен не имеет смысла
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  let lastTarget = null;

  function clearTarget() {
    if (lastTarget && tiles.has(lastTarget)) tiles.get(lastTarget).el.classList.remove('drop-target');
  }
  function move(ev) {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < SWAP_THRESHOLD) return;
      started = true;
      document.body.classList.add('dragging', 'swapping');
      shield.hidden = false;
      shield.style.cursor = 'grabbing';
      measure();
    }
    const over = tileAtPoint(ev.clientX, ev.clientY, id);
    if (over !== lastTarget) {
      clearTarget();
      if (over && tiles.has(over)) tiles.get(over).el.classList.add('drop-target');
      lastTarget = over;
    }
  }
  function up(ev) {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (!started) return;
    clearTarget();
    document.body.classList.remove('dragging', 'swapping');
    shield.hidden = true;
    const over = tileAtPoint(ev.clientX, ev.clientY, id);
    if (over && over !== id) swapTiles(id, over);
  }
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function tileAtPoint(cx, cy, exceptId) {
  const r = tilesEl.getBoundingClientRect();
  const x = cx - r.left, y = cy - r.top;
  let found = null;
  (function w(n) {
    if (!n) return;
    if (n.leaf) {
      const R = n._rect;
      if (R && n.id !== exceptId && x >= R.x && x <= R.x + R.w && y >= R.y && y <= R.y + R.h) found = n.id;
    } else { w(n.a); w(n.b); }
  })(tree);
  return found;
}

function swapTiles(a, b) {
  const la = findLeaf(tree, a);
  const lb = findLeaf(tree, b);
  if (!la || !lb) return;
  // Меняем местами id листьев — плитки (с webview) переезжают без перезагрузки.
  la.id = b;
  lb.id = a;
  relayout();
  persist();
}

// ---------------------------------------------------------------------------
// Системный плеер: авто-определение играющего окна + управление
// ---------------------------------------------------------------------------

// Определение состояния воспроизведения: media-элементы (включая shadow DOM) +
// navigator.mediaSession (Я.Музыка/Spotify часто не дают <audio> в обычном DOM).
const MEDIA_PROBE = `(function(){try{${DEEP_FN}
  var ms=navigator.mediaSession, st=ms&&ms.playbackState, meta=ms&&ms.metadata;
  var l=[].slice.call(document.querySelectorAll('video,audio')); if(!l.length) l=__deep('video,audio');
  var m=null; for(var i=0;i<l.length;i++){if(!l[i].paused&&!l[i].ended){m=l[i];break;}} if(!m&&l.length)m=l[0];
  var elPlaying=!!(m&&!m.paused&&!m.ended);
  var playing=(st==='playing')||elPlaying;
  var has=!!m||(st&&st!=='none')||!!(meta&&meta.title);
  // Эффективная громкость: master-gain (Web Audio) → externalAPI (Я.Музыка) → media-элемент.
  var hv=null; try{ if(window.__hubbleVol) hv=window.__hubbleVol.v;
    else if(window.externalAPI&&externalAPI.getVolume) hv=externalAPI.getVolume();
    else if(m) hv=(m.muted?0:m.volume); }catch(e){ hv=(m?(m.muted?0:m.volume):null); }
  return {has:has, playing:playing, vol:hv};
}catch(e){return {has:false,playing:false,vol:null};}})()`;

// Универсальный регулятор громкости: вставляем master-GainNode перед AudioContext.destination,
// перехватывая AudioNode.connect (нужно ДО построения аудиографа сайтом — поэтому инжектим на
// dom-ready, пользователь жмёт play позже). Покрывает сайты на Web Audio (Я.Музыка/Spotify),
// где у <audio> «пустышки» свойство .volume не влияет на звук. Идемпотентно (флаг __hubbleVol).
const AUDIO_HOOK = `(function(){try{
  if (window.__hubbleVol) return 'dup';
  var st = window.__hubbleVol = { v: 1, gains: [], media: [] };
  function applyMedia(m){ try{ m.muted=(st.v<=0); m.volume=st.v; }catch(e){} }
  function track(m){ try{ if(m && st.media.indexOf(m)===-1){ st.media.push(m); applyMedia(m); } }catch(e){} }
  window.__hubbleTrackMedia = track;
  window.__hubbleSetVolume = function(v){
    st.v = v;
    for (var i=0;i<st.gains.length;i++){ try{ st.gains[i].gain.value = v; }catch(e){} }
    for (var j=0;j<st.media.length;j++){ applyMedia(st.media[j]); }
  };
  // Я.Музыка создаёт <audio> через new Audio() и НЕ кладёт его в DOM → querySelector его не видит,
  // а externalAPI в новом дизайне пропал. Ловим ВСЕ media-элементы по вызову play() (и detached) —
  // это и даёт работающую громкость на новой Я.Музыке.
  try{ if (window.HTMLMediaElement && HTMLMediaElement.prototype && HTMLMediaElement.prototype.play){
    var op = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ track(this); return op.apply(this, arguments); };
  } }catch(e){}
  var AC = window.AudioContext || window.webkitAudioContext;
  if (AC && window.AudioNode && AudioNode.prototype && AudioNode.prototype.connect){
    var oc = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(dest){
      try{
        var ctx = this.context;
        if (ctx && dest === ctx.destination && !this.__hbRouted){
          this.__hbRouted = true;
          var g = ctx.__hbGain;
          if (!g){ g = ctx.createGain(); g.gain.value = st.v; oc.call(g, ctx.destination); ctx.__hbGain = g; st.gains.push(g); }
          return oc.call(this, g);
        }
      }catch(e){}
      return oc.apply(this, arguments);
    };
  }
  return 'ok';
}catch(e){return 'err';}})()`;

// Перехват транспорта через navigator.mediaSession: оборачиваем setActionHandler и складываем
// колбэки сайта (play/pause/nexttrack/previoustrack). Затем дёргаем их напрямую — это переживает
// редизайны DOM и не требует externalAPI (после редизайна 2024 у Я.Музыки externalAPI пропал, а
// mediaSession остался — его же использует ОС для медиа-клавиш). Универсально: работает на любом
// сайте, регистрирующем эти хэндлеры (Spotify, YouTube Music, SoundCloud и т.д.). Сайты обычно
// (пере)регистрируют хэндлеры при старте воспроизведения — позже dom-ready, поэтому обёртка их
// ловит. Идемпотентно (флаг __hubbleMS). cb===null = сайт снимает хэндлер → выкидываем из стора.
const MEDIA_SESSION_HOOK = `(function(){try{
  if (window.__hubbleMS) return 'dup';
  var store = window.__hubbleMS = { h: {} };
  var ms = navigator.mediaSession;
  if (ms && typeof ms.setActionHandler === 'function'){
    var orig = ms.setActionHandler.bind(ms);
    ms.setActionHandler = function(a, cb){ try{ if(cb) store.h[a]=cb; else delete store.h[a]; }catch(e){} return orig(a, cb); };
  }
  window.__hubbleMediaAction = function(n){ try{
    var h = store.h;
    if (n==='playpause'){
      // play/pause — раздельные хэндлеры; выбираем по фактическому состоянию.
      var st = navigator.mediaSession && navigator.mediaSession.playbackState;
      var pick = (st==='playing') ? 'pause' : 'play';
      var cb = h[pick] || h[pick==='play'?'pause':'play'];
      if (typeof cb==='function'){ cb({action:pick}); return true; }
      return false;
    }
    var cb2 = h[n];
    if (typeof cb2==='function'){ cb2({action:n}); return true; }
    return false;
  }catch(e){ return false; } };
  return 'ok';
}catch(e){return 'err';}})()`;

// Telegram сам автозапускает видеосообщения-«кружки» (muted+loop preview). Пользователь не хочет
// автозапуска. Глушим автостарт, НЕ ломая запуск по тапу: в capture-фазе ловим событие 'play' на
// видео внутри контейнера кружка и ставим на паузу, если это НЕ результат недавнего клика ИМЕННО по
// кружку. Клик по чату в списке (вне кружка) разрешения не даёт → открытие чата, скролл и авто-
// перемотка непрочитанных больше не запускают кружки сами; тап по самому кружку — играет как обычно.
// Намеренно НЕ опираемся на muted/navigator.userActivation: непрочитанные кружки играют со звуком,
// а transient-активация живёт ~5с после любого клика (в т.ч. по чату) — оба дали бы ложный «пуск».
// Зависимость от DOM — только класс контейнера кружка: .media-round (WebK /k/) либо .RoundVideo
// (WebA /a/). Один хук покрывает оба клиента (см. исходники tweb и telegram-tt). Сменится при
// редизайне — хук станет no-op (кружки заиграют как раньше), без поломок. Идемпотентно (флаг
// __hubbleNoRound). Инжектится на dom-ready только в webview Telegram (см. createTile).
const TG_NO_AUTOROUND = `(function(){try{
  if (window.__hubbleNoRound) return 'dup';
  window.__hubbleNoRound = 1;
  var SEL = '.media-round, .RoundVideo'; // контейнер кружка: WebK | WebA
  var lastTap = 0; // момент последнего клика внутри кружка → «пользователь сам запустил»
  document.addEventListener('pointerdown', function(e){
    try{ var t=e.target; if(t && t.closest && t.closest(SEL)) lastTap = Date.now(); }catch(_){}
  }, true);
  document.addEventListener('play', function(e){
    try{
      var v = e.target;
      if (!v || v.tagName !== 'VIDEO' || !v.closest) return;
      if (!v.closest(SEL)) return;              // не кружок — не трогаем (обычные видео/стикеры)
      if (Date.now() - lastTap < 800) return;   // только что тапнули этот кружок → пускаем со звуком
      v.autoplay = false;                       // снимаем атрибут, иначе UA перезапустит сам
      v.pause();
    }catch(_){}
  }, true);
  return 'ok';
}catch(e){return 'err';}})()`;

function wirePlayer() {
  playerEl.querySelector('[data-pact=prev]').addEventListener('click', () => mediaCmd('prev'));
  playPauseBtn.addEventListener('click', () => mediaCmd('playpause'));
  playerEl.querySelector('[data-pact=next]').addEventListener('click', () => mediaCmd('next'));
  volIco.addEventListener('click', toggleMute);
  volRange.addEventListener('input', () => setVolume(parseFloat(volRange.value)));
}

async function pollMedia() {
  if (polling) return;
  if (tiles.size === 0) { lastResults = []; applyPlayerTarget(); return; }
  polling = true;
  try {
    const results = [];
    for (const [id, t] of tiles) {
      try {
        const s = await t.webview.executeJavaScript(MEDIA_PROBE, true);
        if (s) results.push({ id, ...s });
      } catch { /* webview грузится / cross-origin */ }
    }
    lastResults = results;
    applyPlayerTarget();
  } finally {
    polling = false;
  }
}

// Окно-цель плеера: активное окно, если в нём есть медиа (его и хотим контролировать), иначе
// первое играющее (чтобы не терять управление фоновым звуком), иначе любое с медиа, иначе само
// активное (тогда слайдер задаёт его громкость наперёд). Привязка к активному окну с фолбэком.
function resolvePlayerTarget(results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const f = focusedId ? byId.get(focusedId) : null;
  if (f && f.has) return f;
  return results.find((r) => r.playing) || results.find((r) => r.has) || f || null;
}

function applyPlayerTarget() {
  const target = resolvePlayerTarget(lastResults);
  // Цель — окно с медиа; если такого нет, по умолчанию активное окно (чтобы слайдер всегда
  // регулировал его громкость, даже пока в нём ничего не играет).
  playerTargetId = target ? target.id : (focusedId && tiles.has(focusedId) ? focusedId : null);
  updatePlayerUI(target);
}

function updatePlayerUI(cur) {
  const has = !!(cur && cur.has);
  const playing = !!(cur && cur.playing);
  playerEl.classList.toggle('idle', !has);
  playerEl.classList.toggle('active', playing);
  playPauseBtn.textContent = playing ? '❚❚' : '▶';
  // Слайдер показывает громкость окна-цели (у каждого окна своя). Не трогаем, пока тащат слайдер.
  if (document.activeElement !== volRange) {
    const t = playerTargetId && tiles.has(playerTargetId) ? tiles.get(playerTargetId) : null;
    const v = t ? t.volume : (cur && typeof cur.vol === 'number' ? cur.vol : null);
    if (typeof v === 'number') { volRange.value = String(v); updateVolIcon(v); }
  }
}

function updateVolIcon(v) {
  volIco.classList.toggle('muted', v <= 0);
}

function targetEntry() {
  return playerTargetId && tiles.has(playerTargetId) ? tiles.get(playerTargetId) : null;
}

function siteFor(host) {
  for (const key of Object.keys(SITE)) {
    if (host && host.indexOf(key) !== -1) return SITE[key];
  }
  return {};
}

async function mediaCmd(action) {
  // Дебаунс: двойной клик/дребезг не должен слать команду дважды (иначе play→pause→play
  // или случайный второй клик по next).
  const now = Date.now();
  if (now - lastCmdAt < 350) return;
  lastCmdAt = now;
  const t = targetEntry();
  if (!t) return;
  const site = siteFor(t.host);
  let result = 'err';
  try {
    if (action === 'playpause') {
      // 1) externalAPI (старый дизайн Я.Музыки); 2) захваченный mediaSession-хэндлер (новый
      // дизайн без externalAPI + большинство плееров); 3) кнопка сайта; 4) media-элемент.
      result = await t.webview.executeJavaScript(
        `(function(){try{${DEEP_FN}
          try{ if(window.externalAPI && typeof externalAPI.togglePause==='function'){ externalAPI.togglePause(); return 'api'; } }catch(e){}
          try{ if(window.__hubbleMediaAction && __hubbleMediaAction('playpause')) return 'ms'; }catch(e){}
          var sel=${JSON.stringify(site.play || '')}; if(sel){var b=document.querySelector(sel)||__deep(sel)[0]; if(b){b.click();return 'btn';}}
          var l=[].slice.call(document.querySelectorAll('video,audio')); if(!l.length) l=__deep('video,audio');
          var m=null; for(var i=0;i<l.length;i++){if(!l[i].paused&&!l[i].ended){m=l[i];break;}} if(!m&&l.length)m=l[0];
          if(m){ if(m.paused){m.play&&m.play();} else {m.pause&&m.pause();} return 'el'; }
          return 'none';
        }catch(e){return 'err';}})()`,
        true
      );
    } else {
      const sel = action === 'next' ? site.next : site.prev;
      // externalAPI и захваченный mediaSession-хэндлер приоритетнее селектора — см. playpause выше.
      result = await t.webview.executeJavaScript(
        `(function(){try{${DEEP_FN}
          var dir=${JSON.stringify(action)};
          try{ if(window.externalAPI && typeof externalAPI[dir]==='function'){ externalAPI[dir](); return 'api'; } }catch(e){}
          try{ var msa=(dir==='next')?'nexttrack':'previoustrack'; if(window.__hubbleMediaAction && __hubbleMediaAction(msa)) return 'ms'; }catch(e){}
          var sel=${JSON.stringify(sel || '')}; if(!sel) return 'nosel';
          var b=document.querySelector(sel)||__deep(sel)[0]; if(b){b.click();return 'ok';} return 'none';
        }catch(e){return 'err';}})()`,
        true
      );
    }
  } catch { /* no-op */ }

  // Универсальный фолбэк: медиа-клавиша роутится в navigator.mediaSession сайта —
  // работает там, где звук идёт через Web Audio без управляемого <audio>/кнопки.
  if (result === 'none' || result === 'nosel' || result === 'err') {
    const key = action === 'playpause' ? 'MediaPlayPause' : (action === 'next' ? 'MediaNextTrack' : 'MediaPreviousTrack');
    try {
      t.webview.sendInputEvent({ type: 'keyDown', keyCode: key });
      t.webview.sendInputEvent({ type: 'keyUp', keyCode: key });
    } catch { /* no-op */ }
  }
  setTimeout(pollMedia, 250);
}

// JS применения громкости в одном webview. Включает AUDIO_HOOK (идемпотентно), поэтому годится
// и для первичной установки на dom-ready, и для живого изменения слайдером.
function volumeJS(v) {
  const vol = Number(v);
  return `(function(){try{${DEEP_FN}
    var v=${vol};
    // На случай, если dom-ready проскочил — ставим хук (no-op, если уже стоит).
    ${AUDIO_HOOK};
    // 1) Универсальный master-gain (Web Audio: Я.Музыка/Spotify и пр.).
    if (typeof window.__hubbleSetVolume==='function') window.__hubbleSetVolume(v);
    // 2) Yandex ExternalAPI (если доступен).
    try{ if(window.externalAPI&&externalAPI.setVolume) externalAPI.setVolume(v); }catch(e){}
    // 3) Обычные media-элементы.
    var l=[].slice.call(document.querySelectorAll('video,audio')); if(!l.length) l=__deep('video,audio');
    l.forEach(function(m){try{m.muted=(v<=0);m.volume=v;}catch(e){}});
    return l.length;
  }catch(e){return 0;}})()`;
}

function applyVolumeTo(webview, v) {
  try { webview.executeJavaScript(volumeJS(v), true); } catch { /* webview ещё не готов */ }
}

// Сохранение громкости дебаунсим по сервису: input слайдера сыплет событиями при перетаскивании.
function scheduleSaveVolume(id, v) {
  clearTimeout(saveVolTimers[id]);
  saveVolTimers[id] = setTimeout(() => window.hubble.setVolume(id, clamp(v, 0, 1)), 300);
}

// Громкость регулирует окно-цель плеера (активное при наличии медиа). У каждого окна — своя.
function setVolume(v) {
  updateVolIcon(v);
  const t = targetEntry();
  if (!t) return;               // нет окна-цели — регулировать нечего
  if (v > 0) t.lastVol = v;
  t.volume = v;
  volumes[t.id] = v;
  applyVolumeTo(t.webview, v);
  scheduleSaveVolume(t.id, v);  // запоминаем для этого сервиса между запусками
}

function toggleMute() {
  const t = targetEntry();
  if (!t) return;
  const v = t.volume || 0;
  const nv = v > 0 ? 0 : (t.lastVol > 0 ? t.lastVol : 1);
  volRange.value = String(nv);
  setVolume(nv);
}

// ---------------------------------------------------------------------------
// Пикер источника демонстрации экрана (getDisplayMedia → setDisplayMediaRequestHandler)
//
// Сайт в webview (Discord) зовёт getDisplayMedia → main опрашивает desktopCapturer и шлёт
// сюда список экранов/окон. Показываем выбор; ответ уходит обратно в main, который отдаёт
// выбранный источник сайту. Закрытие без выбора = отмена (getDisplayMedia отклоняется).
// Оверлей рисуется поверх webview за счёт высокого z-index (см. .screen-picker в styles.css).
// ---------------------------------------------------------------------------

const screenPicker = document.getElementById('screen-picker');
const spList = document.getElementById('sp-list');
const spShareBtn = document.getElementById('sp-share');
const spCancelBtn = document.getElementById('sp-cancel');
const spAudioRow = document.getElementById('sp-audio-row');
const spAudio = document.getElementById('sp-audio');
let spSelectedId = null;
let spAnswered = true; // true = активного запроса нет (ответ уже отправлен/не нужен)

function wireScreenPicker() {
  window.hubble.onPickScreenShare(openScreenPicker);
  spCancelBtn.addEventListener('click', () => closeScreenPicker(null));
  spShareBtn.addEventListener('click', shareSelected);
  // Клик по подложке (вне диалога) — отмена.
  screenPicker.addEventListener('mousedown', (e) => { if (e.target === screenPicker) closeScreenPicker(null); });
  // Esc — отмена, Enter — поделиться выбранным.
  window.addEventListener('keydown', (e) => {
    if (screenPicker.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeScreenPicker(null); }
    else if (e.key === 'Enter') { e.preventDefault(); shareSelected(); }
  });
}

function shareSelected() {
  if (spSelectedId) closeScreenPicker({ id: spSelectedId, withAudio: spAudio.checked });
}

function openScreenPicker(payload) {
  const sources = (payload && payload.sources) || [];
  spSelectedId = null;
  spAnswered = false;
  spShareBtn.disabled = true;
  spAudioRow.hidden = !(payload && payload.audioRequested); // галочка звука — только если сайт его просил
  spAudio.checked = true;
  spList.innerHTML = '';

  for (const s of sources) {
    const card = document.createElement('div');
    card.className = 'sp-source';
    card.dataset.id = s.id;

    if (s.thumbnail) {
      const img = document.createElement('img');
      img.className = 'sp-thumb';
      img.src = s.thumbnail;
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'sp-thumb sp-thumb-empty';
      ph.textContent = s.isScreen ? '🖥' : '🪟';
      card.appendChild(ph);
    }

    const name = document.createElement('div');
    name.className = 'sp-name';
    if (s.appIcon) {
      const ic = document.createElement('img');
      ic.src = s.appIcon;
      name.appendChild(ic);
    }
    const label = document.createElement('span');
    label.textContent = s.name || (s.isScreen ? 'Экран' : 'Окно');
    name.appendChild(label);
    card.appendChild(name);

    card.addEventListener('click', () => {
      spSelectedId = s.id;
      spShareBtn.disabled = false;
      for (const el of spList.querySelectorAll('.sp-source')) el.classList.toggle('selected', el === card);
    });
    card.addEventListener('dblclick', () => closeScreenPicker({ id: s.id, withAudio: spAudio.checked }));

    spList.appendChild(card);
  }

  screenPicker.hidden = false;
}

// answer = { id, withAudio } для выбора, null/undefined — отмена. Ответ шлём строго один раз.
function closeScreenPicker(answer) {
  screenPicker.hidden = true;
  if (spAnswered) return;
  spAnswered = true;
  window.hubble.pickScreenShare(answer || {});
}

// ---------------------------------------------------------------------------
// Операции над BSP-деревом
// ---------------------------------------------------------------------------

function chooseDir(rect) {
  // Делим вдоль длинной стороны — раскладка остаётся сбалансированной.
  return rect.w >= rect.h ? 'row' : 'col';
}

function replaceNode(target, repl) {
  if (target === tree) { tree = repl; return; }
  const p = findParent(tree, target);
  if (p.a === target) p.a = repl; else p.b = repl;
}

function findLeaf(n, id) {
  if (!n) return null;
  if (n.leaf) return n.id === id ? n : null;
  return findLeaf(n.a, id) || findLeaf(n.b, id);
}

function findParent(n, target) {
  if (!n || n.leaf) return null;
  if (n.a === target || n.b === target) return n;
  return findParent(n.a, target) || findParent(n.b, target);
}

function firstLeaf(n) {
  return n.leaf ? n : firstLeaf(n.a);
}

function largestLeaf() {
  let best = null, bestArea = -1;
  (function w(n) {
    if (n.leaf) {
      const a = n._rect ? n._rect.w * n._rect.h : 0;
      if (a > bestArea) { bestArea = a; best = n; }
    } else { w(n.a); w(n.b); }
  })(tree);
  return best;
}

function collectLeaves(n, acc = []) {
  if (!n) return acc;
  if (n.leaf) acc.push(n.id);
  else { collectLeaves(n.a, acc); collectLeaves(n.b, acc); }
  return acc;
}

function collectSplits(n, acc = []) {
  if (!n || n.leaf) return acc;
  acc.push(n);
  collectSplits(n.a, acc);
  collectSplits(n.b, acc);
  return acc;
}

// ---------------------------------------------------------------------------
// Сохранение раскладки между запусками
// ---------------------------------------------------------------------------

function serialize(n) {
  if (!n) return null;
  return n.leaf
    ? { leaf: true, id: n.id }
    : { leaf: false, dir: n.dir, ratio: n.ratio, a: serialize(n.a), b: serialize(n.b) };
}

/** Чистит сохранённое дерево: выкидывает сервисы, которых больше нет в конфиге. */
function prune(n) {
  if (!n) return null;
  if (n.leaf) return services.has(n.id) ? { leaf: true, id: n.id } : null;
  const a = prune(n.a);
  const b = prune(n.b);
  if (a && b) {
    return { leaf: false, dir: n.dir === 'col' ? 'col' : 'row', ratio: clamp(n.ratio ?? 0.5, MIN_RATIO, MAX_RATIO), a, b };
  }
  return a || b;
}

function persist() {
  window.hubble.setWorkspace({ tree: serialize(tree), focusedId, maximizedId });
}

window.addEventListener('DOMContentLoaded', init);
