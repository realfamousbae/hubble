# Hubble 🛰️

> 🇷🇺 **Русская версия:** [README.ru.md](README.ru.md)

**Hubble** is a desktop hub built on **Electron** — a single container for multiple web
services (Telegram Web, YouTube, weather, Twitch, Yandex.Music, SoundCloud, Discord, and
more). Each service opens as a **tiled window** inside one application window, sharing the
space via automatic BSP tiling, with a neon purple border, a floating pill taskbar at the
bottom, and a system-style media player at the top. Logins are **persisted** between
launches.

Application class — *web service aggregator* (similar to Ferdium, Rambox).

![Version](https://img.shields.io/badge/version-0.1.0--alpha-orange)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **Floating pill taskbar** at the bottom (iOS-style), detached from the window edge;
  service icons are generated from `src/apps.json`.
- **Multiple windows at once** — services open as tiles inside one app window. The ▦
  button opens all of them at once.
- **Automatic tiling** — windows split the space like Windows Snap (BSP layout); each new
  window splits the largest/active tile along its longer side.
- **Resize by dragging splitters** between windows (like Windows snap groups).
- **Drag-to-swap** — drag a window by its header and drop it onto another to swap their
  positions (no webview reload).
- **Neon purple borders**; the active window glows brighter.
- **Frameless window** — no File/Edit menu and no native title bar; custom
  minimize/maximize/close buttons. Native resize and Windows Snap are preserved
  (`titleBarStyle: 'hidden'`).
- **System media player** (top center, neon styled) — auto-detects the window that is
  playing and offers play/pause, previous/next track, and volume. Volume is **per window**
  and persisted.
- **Page zoom** (`Ctrl` `+` / `-` / `0`, Chrome-like) applied to the active tile.
- Maximize a window to the full area (double-click the header or the ▢ button) and close it (×).
- Services rendered via `<webview>` (not `<iframe>` — see Notes).
- Logins persisted between restarts via `partition: persist:*`.
- Lazy loading: a `<webview>` is created only when a service window is opened.
- Per-window navigation buttons (back / forward / reload) and a loading indicator.
- External links open in the system browser.
- Window layout (tiling tree + focus) is remembered between launches.
- Native notifications and unread badges (e.g. for Telegram).
- iOS-style open/minimize window animations (genie-in, dissolve, FLIP reflow).
- Windows installer build via `electron-builder`.

---

## Screenshots

> Screenshots are generated locally by the dev harness and are not committed to the
> repository. Add your own under `docs/` and reference them here if needed.

---

## Installation / Quick start (dev)

Requires [Node.js](https://nodejs.org/) (LTS) and npm.

```bash
npm install
npm start          # launch in dev (electron .)
```

## Build (Windows)

```bash
npm run dist       # NSIS installer + portable .exe in ./release
npm run pack       # faster unpacked build in ./release (no installer)
```

> **Note (Windows build):** electron-builder may fail on macOS symlinks inside
> `winCodeSign` ("Cannot create symbolic link"). Workaround — pre-extract
> `winCodeSign-2.6.0.7z` into the electron-builder cache while excluding the `darwin`
> folder.

---

## Configuring services (`src/apps.json`)

Adding/removing services is just editing JSON — no code changes required.

```json
{
  "apps": [
    {
      "id": "telegram",
      "name": "Telegram",
      "url": "https://web.telegram.org/a/",
      "icon": "assets/icons/telegram.svg",
      "partition": "persist:telegram",
      "userAgent": ""
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique service identifier. |
| `name` | yes | Label/tooltip on the icon and window header. |
| `url` | yes | Start URL of the web version. |
| `icon` | no | Path to the icon from the project root (`assets/...`). Falls back to a letter glyph. |
| `partition` | no | Must start with `persist:` to keep the session. Defaults to `persist:<id>`. |
| `userAgent` | no | Custom UA. Empty → a real desktop Chrome agent is used. |
| `hidden` | no | If `true`, the service stays in config/code but gets no taskbar icon (cannot be opened). |

---

## Architecture

```
BrowserWindow (titleBarStyle:'hidden', webviewTag, contextIsolation, nodeIntegration:false)
├── #titlebar           — drag zone + system media player (center) + window buttons
├── #workspace / #tiles — service tiles (one <webview> per open service) + splitters
│     layout = a binary space-partition (BSP) tree
└── #taskbar            — floating pill with service icons (from apps.json)
```

The layout is stored as a BSP tree: a leaf `{ leaf, id }` is a service window, a node
`{ dir:'row'|'col', ratio, a, b }` is a split. Tile rectangles are computed from the tree;
dragging a splitter changes a node's `ratio` (resizing neighbors). A transparent drag
shield is placed over webviews while dragging so the mouse reaches the app and is not
captured by the webview.

- **`src/main.js`** — main process: window, config reading, IPC, external-link
  interception (`setWindowOpenHandler` → `shell.openExternal`), OAuth login popups,
  permissions, notifications, screen-share picker, single-instance lock.
- **`src/preload.js`** — secure `contextBridge` bridge (renderer ↔ main).
- **`src/renderer.js`** — BSP tiling (open/close/focus/maximize windows, layout math,
  splitters, drag-to-swap), pill taskbar, system media player, window buttons, layout
  persistence, open/close animations.
- **`src/index.html` / `src/styles.css`** — markup and the neon dark theme.
- **`src/apps.json`** — the single source of truth for the service list.
- **`assets/icons/*.svg`** — service icons; `app.png`/`app.ico` are generated.

---

## Notes & gotchas

1. **No `<iframe>`** for services — `X-Frame-Options`/CSP would block YouTube, Telegram,
   etc. A `<webview>` (isolated browser process) is used instead.
2. **`webviewTag: true`** is required in the main window's `webPreferences`, otherwise the
   `<webview>` tag is disabled (off by default since Electron ≥ 5).
3. **Security**: the main window uses `nodeIntegration: false` and `contextIsolation: true`;
   renderer↔main communication goes only through `preload` + `contextBridge`.
4. **`partition: persist:*`** is the only way to keep logins. Without the `persist:` prefix
   the session lives in memory and is wiped on restart.
5. **External links** are intercepted via `setWindowOpenHandler`, otherwise they would open
   empty Electron windows.
6. **Media transport** is controlled via `webview.executeJavaScript` (HTML5 `<audio>/<video>`,
   captured `navigator.mediaSession` handlers, site-specific buttons). Play/pause and volume
   work universally; previous/next is best-effort where a site registers media-session handlers.
7. **Spotify Web Player requires Widevine DRM**, which stock Electron does not ship — login
   and navigation work, but playback may not start. Audio in Spotify needs an Electron build
   with bundled Widevine (e.g. castlabs). Spotify is therefore `hidden` by default.
8. The user agent must be a clean Chrome string (no `Electron` token) and should not lag
   behind the real Chromium version, or Google flags the browser as "insecure".

---

## Contributing

Contributions are welcome!

- 🐛 **Found a bug?** Please open an issue on the project's **Issues** tab:
  `https://github.com/realfamousbae/hubble/issues`. Include your OS version, steps to reproduce,
  and what you expected to happen.
- ✨ **Have a fix or feature?** Open a **Pull Request** against the default branch:
  `https://github.com/realfamousbae/hubble/pulls`. Describe the change and link any related issue.
- 💬 Questions and ideas can also go through Issues.

> Please report bugs and propose changes through **GitHub Issues** and **Pull Requests**
> rather than by email — it keeps discussion public and trackable.

Code conventions: vanilla HTML/CSS/JS, no frameworks. In-code comments are in Russian.

---

## Changelog & versioning

The full version history is kept in [CHANGELOG.md](CHANGELOG.md). Current version:
**0.1.0-alpha** (first alpha — working MVP).

- The changelog follows the [Keep a Changelog](https://keepachangelog.com/) format, and the
  project follows [Semantic Versioning](https://semver.org/).
- Unreleased changes accumulate in the **[Unreleased]** section under headings
  (`Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`).
- On a release, `[Unreleased]` is renamed to `[X.Y.Z] - YYYY-MM-DD`, the `version` field in
  `package.json` is bumped, and a fresh empty `[Unreleased]` is added on top.

Please record every notable change in the changelog as part of your pull request.

---

## License

Released under the [MIT License](LICENSE).
