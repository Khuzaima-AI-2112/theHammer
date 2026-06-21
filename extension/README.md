# The Hammer — Extension

Chrome MV3 extension. Load unpacked from this directory.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest: permissions, commands, service worker, popup, content scripts |
| `service-worker.js` | Background: handles keyboard shortcut, popup message, content script relay, capture logic, session + page guards, and Firebase token injection |
| `popup.html` / `popup.js` | Toolbar popup: OAuth login via `chrome.identity`, project/tool dropdowns, Save, Capture Now |
| `content.js` | Injected into all http/https pages: floating 🔨 button, relays CAPTURE message to service worker |
| `offscreen.html` / `offscreen.js` | Used for processing data that requires a DOM (e.g. image manipulation/blob handling) |
| `icons/` | Extension icons |

## Legacy Files (Deprecated)
- `admin.html` / `admin.js`: Originally used for a local admin settings view. Now fully replaced by the web-based Admin Portal SPA.

## Storage keys

| Key | Shape | Set by |
|---|---|---|
| `session` | `{ projectId, workspaceId, tool }` | `popup.js` |
| Firebase Auth | Managed by `chrome.identity` / Firebase JS SDK | `popup.js` / `service-worker.js` |

## Loading in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this `extension/` folder
4. Check `chrome://extensions/shortcuts` — verify `Ctrl+Shift+S` is not "(Not set)"

> ⚠️ Chrome 149+ shows a "Disable developer mode extensions" banner on every restart. This is expected and safe to dismiss.

## Capture triggers

- **Keyboard:** `Ctrl+Shift+S` / `Command+Shift+S`
- **Popup:** "Capture Now" button
- **Page:** floating 🔨 button (bottom-right of every http/https page)

All three triggers are blocked with a notification if no Project is saved in the popup or if the user is not authenticated.
