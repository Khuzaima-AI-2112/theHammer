# The Hammer — Extension

Chrome MV3 extension. Load unpacked from this directory.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest: permissions, commands, service worker, popup, content scripts |
| `service-worker.js` | Background: handles keyboard shortcut, popup message, content script relay, capture logic, session + page guards |
| `popup.html` / `popup.js` | Toolbar popup: project/user/tool dropdowns, Save, Capture Now, Admin link |
| `admin.html` / `admin.js` | Admin tab: create/delete Projects and Users, persisted under `config` key |
| `content.js` | Injected into all http/https pages: floating 🔨 button, relays CAPTURE message to service worker via long-lived port |
| `icons/icon128.png` | 128×128 extension icon (required for notifications) |

## Storage keys

| Key | Shape | Set by |
|---|---|---|
| `config` | `{ projects: [{id, name}], users: [{id, name}] }` | `admin.js` |
| `session` | `{ projectId, userId, tool }` | `popup.js` |

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

All three triggers are blocked with a notification if no Project or User is saved in the popup.

## Sprint 1 acceptance checklist

- [ ] `chrome://extensions` shows 0 errors
- [ ] Shortcut visible in `chrome://extensions/shortcuts`
- [ ] Floating button appears on any `http/https` page
- [ ] Clicking floating button logs PNG data URL > 10,000 chars in service worker console
- [ ] Popup "Capture Now" button logs PNG data URL
- [ ] Keyboard shortcut logs PNG data URL
- [ ] `chrome://` page shows error notification, no crash
- [ ] Popup with no project/user set: all three triggers show error notification
- [ ] Admin page opens from popup Admin link
- [ ] Admin add/remove project persists after popup close and reopen
- [ ] Popup dropdowns reflect admin config after save
- [ ] Project/User/Tool selection persists after full Chrome restart
