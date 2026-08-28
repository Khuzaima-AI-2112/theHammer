'use strict';

// #39: a Firebase ID token lives one hour. The popup and the service worker
// each captured one at sign-in and then used that string for the rest of the
// profile's life, so every authenticated call began 401ing an hour later.
// `firebaseRefreshToken` and `firebaseApiKey` have been written into settings
// at every sign-in since the flow was built (popup.js) and nothing ever spent
// them. This is the one place that does.
//
// The extension has no bundler and both callers need this, so it loads as a
// classic script: <script src="auth.js"> from popup.html, importScripts() from
// the service worker. Everything here is therefore a plain global.

const TOKEN_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';

async function readSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || {};
}

/**
 * Spend the stored refresh token on a new ID token, and persist it.
 *
 * Returns '' when there is nothing to refresh with, or when Google refuses the
 * exchange. A revoked or expired refresh token means a real sign-in is needed
 * and no amount of retrying will help, so the caller should say so rather than
 * loop.
 */
async function refreshFirebaseToken() {
  const settings = await readSettings();
  const refreshToken = String(settings.firebaseRefreshToken || '').trim();
  const apiKey       = String(settings.firebaseApiKey || '').trim();

  // Profiles that signed in before the extension stored these have neither.
  if (!refreshToken || !apiKey) return '';

  let body;
  try {
    const res = await fetch(`${TOKEN_REFRESH_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    if (!res.ok) {
      console.warn('[Hammer auth] refresh refused:', res.status);
      return '';
    }
    body = await res.json();
  } catch (err) {
    console.warn('[Hammer auth] refresh failed:', err.message);
    return '';
  }

  const idToken = String(body?.id_token || '');
  if (!idToken) return '';

  // Re-read rather than reusing the settings above: a capture may have written
  // to storage while the exchange was in flight.
  const current = await readSettings();
  await chrome.storage.local.set({
    settings: {
      ...current,
      firebaseToken: idToken,
      // Google rotates the refresh token on some exchanges and omits it on
      // others; keep the one we have when it does not send a new one.
      firebaseRefreshToken: String(body.refresh_token || refreshToken)
    }
  });

  console.log('[Hammer auth] ID token refreshed');
  return idToken;
}

/**
 * fetch() with the stored ID token attached, renewing it once on a 401.
 *
 * The 401 is the trigger rather than a clock check, because it is what the
 * backend actually says: it catches a token revoked early as well as one simply
 * aged out, and it needs no assumption about expiry. A second 401 after a
 * successful refresh is returned unchanged — the problem is then authorisation,
 * not expiry, and the caller should surface it.
 */
async function authedFetch(url, options = {}) {
  const settings = await readSettings();

  const send = (token) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), 'Authorization': `Bearer ${token}` }
  });

  const res = await send(String(settings.firebaseToken || '').trim());
  if (res.status !== 401) return res;

  const fresh = await refreshFirebaseToken();
  return fresh ? send(fresh) : res;
}

/**
 * Is this the failure that only a real sign-in can clear?
 *
 * authedFetch already spends the refresh token once before it hands a 401 back,
 * so a 401 that reaches a caller has survived that attempt: the refresh token is
 * revoked or expired, and no amount of retrying will change the answer. Callers
 * need to tell that apart from a dead network, because the two want opposite
 * things — one wants the user to sign in, the other wants to wait and retry.
 *
 * Callers mark the status on the Error they throw (`err.status = res.status`).
 */
function isAuthExpired(err) {
  return Number(err?.status) === 401;
}

/**
 * What to tell the user when an upload finally gives up.
 *
 * Split out from the capture path so the choice is testable on its own. It is
 * the whole point of #39's third `Done when`: an expired session used to be
 * reported as "No connection", which sends the reader to check the one thing
 * that is fine. See lessons_learned.md 52 and 55 for the same shape elsewhere.
 */
function uploadFailureNotice(err) {
  return isAuthExpired(err)
    ? { title: 'Sign in required',
        message: 'Your session expired — sign in from the popup. Your capture is saved.' }
    : { title: 'Upload queued',
        message: 'No connection — will retry when online.' };
}
