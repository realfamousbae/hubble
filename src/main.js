'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, session, Notification, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Глушим спам Chromium в консоли: повторяющиеся SSL handshake / net_error -101
// (CONNECTION_RESET) идут от заблокированных в регионе сервисов, которые в цикле
// переподключаются — это поведение сайтов, а не баг приложения.
app.commandLine.appendSwitch('disable-logging');

// ---------------------------------------------------------------------------
// Пути и состояние
// ---------------------------------------------------------------------------

const APPS_CONFIG_PATH = path.join(__dirname, 'apps.json');

// UA реального Chromium из Electron 33 (Chrome 130). Нужен чистый UA без токена Electron —
// иначе сайты (Google при входе, Spotify) считают браузер небезопасным/устаревшим.
// Держать в синхроне с DEFAULT_UA в renderer.js.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Хосты провайдеров входа: их popup'ы открываем НЕ во внешнем браузере, а дочерним окном в той же
// сессии (партиции) сервиса — иначе кука авторизации уходит мимо webview и вход не завершается.
// Бонус: top-level окно (не webview) с чистым UA Google пускает на вход, в отличие от webview.
const AUTH_HOSTS = [
  'accounts.google.com', 'accounts.youtube.com', 'appleid.apple.com',
  'www.facebook.com', 'facebook.com', 'm.facebook.com',
  'login.live.com', 'login.microsoftonline.com',
  'api.twitter.com', 'twitter.com', 'x.com', 'vk.com', 'oauth.vk.com', 'id.vk.com'
];

/** Похож ли popup на окно входа (провайдер / тот же сайт / oauth-путь)? Тогда открываем в окне. */
function isAuthPopup(targetUrl, openerUrl) {
  try {
    const t = new URL(targetUrl);
    if (!/^https?:$/.test(t.protocol)) return false;
    const host = t.host.toLowerCase();
    if (AUTH_HOSTS.includes(host)) return true;
    if (/(^|\/)(oauth|authorize|signin|sign_in|connect|auth|login)(\/|$|\?)/i.test(t.pathname)) return true;
    if (openerUrl) {
      const oh = new URL(openerUrl).host.toLowerCase();
      if (oh && (host === oh || host.endsWith('.' + oh) || oh.endsWith('.' + host))) return true;
    }
  } catch { /* кривой URL — не auth */ }
  return false;
}

/** Обработчик window.open: окна входа — дочерним BrowserWindow в той же сессии, прочее — наружу. */
function makeWindowOpenHandler(getOpenerUrl) {
  return ({ url }) => {
    if (isAuthPopup(url, getOpenerUrl())) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 700, autoHideMenuBar: true, backgroundColor: '#11141b',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
        }
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  };
}

/** Файл с пользовательскими настройками (последний открытый сервис и т.п.). */
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

let mainWindow = null;
let loadedApps = [];           // список сервисов (для флаша хранилища всех партиций)

// ---------------------------------------------------------------------------
// Конфиг сервисов
// ---------------------------------------------------------------------------

/**
 * Читает apps.json. Возвращает массив валидных сервисов.
 * Невалидные записи (без id/url) отбрасываются, чтобы не ломать UI.
 */
function loadApps() {
  try {
    const raw = fs.readFileSync(APPS_CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const apps = Array.isArray(data.apps) ? data.apps : [];
    return apps
      .filter((a) => a && typeof a.id === 'string' && typeof a.url === 'string')
      .map((a) => ({
        id: a.id,
        name: a.name || a.id,
        url: a.url,
        icon: a.icon || '',
        // partition обязан начинаться с persist: — иначе сессия не сохранится.
        partition: a.partition && a.partition.startsWith('persist:')
          ? a.partition
          : `persist:${a.id}`,
        userAgent: a.userAgent || '',
        // hidden:true — сервис без иконки в пилюле (renderer пропускает его в buildTaskbarButton).
        // Раньше поле терялось здесь → Spotify оставался виден вопреки apps.json.
        hidden: !!a.hidden
      }));
  } catch (err) {
    console.error('[hubble] Не удалось прочитать apps.json:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Настройки (last app)
// ---------------------------------------------------------------------------

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  try {
    const current = readSettings();
    const next = { ...current, ...patch };
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (err) {
    console.error('[hubble] Не удалось записать settings.json:', err);
  }
}

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#11141b',
    icon: path.join(__dirname, '..', 'assets', 'icons', 'app.png'),
    title: 'Hubble',
    // Прячем системную строку заголовка, но оставляем нативную рамку:
    // окно остаётся resizable и поддерживает Windows Snap. Свои кнопки — в UI.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,        // включаем тег <webview> (по умолчанию выключен)
      contextIsolation: true,  // изоляция контекста — безопасность
      nodeIntegration: false,  // без Node в renderer
      sandbox: false           // preload использует require()
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Главное окно (renderer) не должно «уплывать» по ссылке: всё, кроме локального file://,
  // отменяем и (если это http/https) открываем во внешнем браузере. На дочерние OAuth-окна
  // этот замок НЕ вешаем — там навигация по редиректам провайдера легитимна.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Сообщаем renderer о смене состояния развёрнутости (для иконки кнопки).
  const sendMaxState = () => {
    if (mainWindow) mainWindow.webContents.send('window-maximized', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  // Закрытие окна (X) — флашим хранилище до уничтожения webview, чтобы вход сохранился.
  mainWindow.on('close', () => flushAllStorage(loadedApps));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Безопасность гостевого контента (webview)
// ---------------------------------------------------------------------------

/**
 * Перехватываем создание любых webContents. Для встраиваемых webview:
 *  - внешние ссылки / window.open / target=_blank → системный браузер;
 *  - запрет навигации главного окна на сторонние страницы.
 */
app.on('web-contents-created', (_event, contents) => {
  const type = contents.getType();

  if (type === 'webview') {
    // window.open: окна входа открываем дочерним BrowserWindow (см. makeWindowOpenHandler),
    // внешние ссылки — в системном браузере, остальное не плодим.
    contents.setWindowOpenHandler(makeWindowOpenHandler(() => contents.getURL()));

    // Зум страницы Ctrl +/−/0 (как в Chrome). Webview в фокусе «съедает» клавиши, поэтому ловим
    // их тут и форвардим намерение в renderer — он владеет зумом по плиткам (применяет к активной).
    // preventDefault — чтобы сайт сам не реагировал на эти сочетания.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
      const k = input.key;
      let dir = null;
      if (k === '=' || k === '+') dir = 'in';
      else if (k === '-' || k === '_') dir = 'out';
      else if (k === '0') dir = 'reset';
      if (!dir) return;
      event.preventDefault();
      if (mainWindow) mainWindow.webContents.send('zoom', dir);
    });
  }

  // type 'window' — это главное окно ЛИБО дочернее окно входа (OAuth-popup). Навигацию НЕ
  // блокируем здесь (иначе сломаем OAuth-редиректы); замок главного окна вешаем в createWindow.
  // Окнам входа даём чистый UA и тот же обработчик popup'ов (на случай вложенного window.open).
  if (type === 'window') {
    contents.setUserAgent(BROWSER_UA);
    contents.setWindowOpenHandler(makeWindowOpenHandler(() => contents.getURL()));
  }
});

// ---------------------------------------------------------------------------
// Разрешения (уведомления для сервисов вроде Telegram)
// ---------------------------------------------------------------------------

// Безопасный набор разрешений. 'media' — микрофон/камера (голос Discord), 'display-capture' —
// демонстрация экрана (getDisplayMedia, см. configureDisplayMedia).
const ALLOWED_PERMS = ['notifications', 'media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'];

function configurePermissions(apps) {
  for (const a of apps) {
    const ses = session.fromPartition(a.partition);
    // Асинхронный запрос разрешения (всплывает при первом обращении сайта).
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMS.includes(permission));
    });
    // Синхронная проверка: некоторые API (enumerateDevices/getDisplayMedia в Discord)
    // опираются на неё — без неё доступ к медиа/экрану молча отклоняется.
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMS.includes(permission));
  }
}

// ---------------------------------------------------------------------------
// Демонстрация экрана (getDisplayMedia) — Discord и пр.
//
// В Electron navigator.mediaDevices.getDisplayMedia() не работает «из коробки»:
// нужно повесить setDisplayMediaRequestHandler на сессию партиции и САМИМ выбрать
// источник (экран/окно) через desktopCapturer — нативного пикера на Windows нет.
// Показываем свой пикер в renderer, ждём выбор и отдаём источник в callback.
// Звук демонстрации — 'loopback' (системный звук Windows); включаем, только если сайт
// сам запросил аудио (request.audioRequested) — иначе loopback ни к чему.
// ---------------------------------------------------------------------------

let pendingDisplayMedia = null; // { callback, sources, audioRequested } — ожидаем выбор источника

function configureDisplayMedia(apps) {
  for (const a of apps) {
    const ses = session.fromPartition(a.partition);
    ses.setDisplayMediaRequestHandler((request, callback) => {
      handleDisplayMediaRequest(callback, !!request.audioRequested);
    }, { useSystemPicker: false }); // на Windows системного пикера нет — рисуем свой
  }
}

function handleDisplayMediaRequest(callback, audioRequested) {
  desktopCapturer
    .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
    .then((sources) => {
      if (!mainWindow || !sources.length) { callback({}); return; } // нет окна/источников → отказ
      // Если уже висит запрос — отменяем старый (пустой ответ = отказ getDisplayMedia).
      if (pendingDisplayMedia) { try { pendingDisplayMedia.callback({}); } catch { /* уже разрешён */ } }
      pendingDisplayMedia = { callback, sources, audioRequested };
      mainWindow.webContents.send('pick-screen-share', {
        audioRequested,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          isScreen: s.id.startsWith('screen:'),
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
          appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
        }))
      });
    })
    .catch(() => { try { callback({}); } catch { /* no-op */ } });
}

// Ответ из пикера: { id, withAudio }. id отсутствует → пользователь отменил (отказ).
ipcMain.on('screen-share-pick', (_event, payload) => {
  const pending = pendingDisplayMedia;
  pendingDisplayMedia = null;
  if (!pending) return;
  const id = payload && payload.id;
  const src = id && pending.sources.find((s) => s.id === id);
  if (!src) { try { pending.callback({}); } catch { /* no-op */ } return; }
  const resp = { video: src };
  // Звук демонстрации только если сайт его запросил И пользователь не снял галочку.
  if (pending.audioRequested && payload.withAudio) resp.audio = 'loopback';
  try { pending.callback(resp); } catch { /* окно закрылось */ }
});

// ---------------------------------------------------------------------------
// Надёжное сохранение сессий (вход не должен «слетать» при перезапуске)
//
// localStorage/IndexedDB Chromium сбрасывает на диск лениво (по таймеру) и при чистом
// выходе. Discord держит токен входа в localStorage — если сброс не успел (быстрый выход
// или форс-килл), вход теряется. Поэтому периодически и при выходе принудительно флашим
// DOMStorage и куки всех persist-партиций. Полезно всем сервисам, не только Discord.
// ---------------------------------------------------------------------------

function flushAllStorage(apps) {
  for (const a of apps) {
    try {
      const ses = session.fromPartition(a.partition);
      ses.flushStorageData();                       // localStorage/IndexedDB → диск
      if (ses.cookies) ses.cookies.flushStore().catch(() => { /* партиция могла не подняться */ });
    } catch { /* партиция не инициализирована — пропускаем */ }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// Кнопки управления окном (frameless): свернуть / развернуть / закрыть.
ipcMain.on('window-control', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});

ipcMain.handle('get-apps', () => loadApps());

ipcMain.handle('get-workspace', () => readSettings().workspace || null);

ipcMain.handle('set-workspace', (_event, state) => {
  if (state && typeof state === 'object') writeSettings({ workspace: state });
});

// Громкость по сервисам ({ [id]: 0..1 }) — у каждого окна своя, сохраняется между запусками.
ipcMain.handle('get-volumes', () => readSettings().volumes || {});

ipcMain.on('set-volume', (_event, { id, v } = {}) => {
  if (typeof id !== 'string' || typeof v !== 'number' || !isFinite(v)) return;
  const volumes = readSettings().volumes || {};
  volumes[id] = Math.max(0, Math.min(1, v));
  writeSettings({ volumes });
});

// Нативные уведомления, инициированные из сервиса через preload-мост.
ipcMain.on('notify', (_event, { title, body, appId } = {}) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || 'Hubble', body: body || '' });
  n.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('focus-app', appId || null);
    }
  });
  n.show();
});

// Бейдж непрочитанных в сайдбаре прокидываем обратно в renderer.
ipcMain.on('unread-count', (_event, payload) => {
  if (mainWindow) mainWindow.webContents.send('unread-count', payload);
});

// ---------------------------------------------------------------------------
// Жизненный цикл
// ---------------------------------------------------------------------------

// Один экземпляр приложения: вторая попытка запуска фокусирует уже открытое окно.
// Заодно избегаем конфликтов за блокировку кэша партиций.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // убираем меню File/Edit/View/…
    loadedApps = loadApps();
    configurePermissions(loadedApps);
    configureDisplayMedia(loadedApps);
    createWindow();

    // Периодический флаш хранилища — чтобы вход не терялся даже при некорректном выходе.
    setInterval(() => flushAllStorage(loadedApps), 30000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // При выходе сбрасываем хранилище на диск (см. flushAllStorage).
  app.on('before-quit', () => flushAllStorage(loadedApps));
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
