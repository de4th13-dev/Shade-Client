// Shade 0.9 — OPAQUE browser-only client. No password verifier or HMAC key stored.
// Only trusted extension contexts communicate with this service worker.
import {gatewayCookieName, normalizeAddress, hostPermission} from './navigation.mjs';
import {ready, client} from '@serenity-kit/opaque';

// Keep WASM initialization errors out of worker startup; login reports them.
const cryptoReady = Promise.resolve(ready).then(() => null, error => error || new Error('OPAQUE initialization failed'));

const PROFILES = 'profiles';
const MASTER = 'shadeEnabled';

// One-way migration: legacy reusable PBKDF/HMAC credentials MUST be discarded.
const storageReady = (async () => {
  await Promise.allSettled([
    chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
    chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})
  ]);
  await Promise.all([
    chrome.storage.local.remove(['savedKeys']),
    chrome.storage.session.remove(['tempKeys'])
  ]);
})();

// Manifest V3 service workers support static imports, not dynamic import().
async function settings() {
  await storageReady;
  const {profiles = [], shadeEnabled = true} = await chrome.storage.local.get([PROFILES, MASTER]);
  return {profiles, enabled: shadeEnabled !== false};
}
async function sessionCookie(origin) {
  return chrome.cookies.get({url: origin + '/', name: gatewayCookieName(origin)});
}
async function sendLogin(origin, password) {
  const initializationError = await cryptoReady;
  if (initializationError) throw new Error('Не удалось загрузить OPAQUE. Обновите расширение из релиза.');
  const state = client.startLogin({password});
  const start = await fetch(origin + '/.well-known/shade-opaque/start', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ke1: state.startLoginRequest}), credentials: 'omit',
    cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15000)
  });
  if (!start.ok || start.type === 'opaqueredirect') return false;
  let data;
  try { data = await start.json(); } catch (_) { return false; }
  if (!data || data.shade_opaque !== 'v1' ||
      typeof data.ke2 !== 'string' || typeof data.attempt !== 'string') return false;
  let finished;
  try {
    finished = client.finishLogin({clientLoginState: state.clientLoginState, password, loginResponse: data.ke2});
  } catch (_) {
    return false;  // wrong password: open the public website, not an auth error
  }
  if (!finished || typeof finished.finishLoginRequest !== 'string') return false;
  const response = await fetch(origin + '/.well-known/shade-opaque/finish', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({attempt: data.attempt, ke3: finished.finishLoginRequest}),
    credentials: 'omit', cache: 'no-store', redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok || response.type === 'opaqueredirect') return false;
  let info;
  try { info = await response.json(); } catch (_) { return false; }
  if (!info || info.shade_authenticated !== true ||
      typeof info.session_token !== 'string' ||
      !/^[A-Za-z0-9_-]{35,128}$/.test(info.session_token)) return false;
  const ttl = Math.min(86400, Math.max(10, Number(info.expires_in) || 0));
  const cookie = await chrome.cookies.set({
    url: origin + '/', name: gatewayCookieName(origin), value: info.session_token,
    path: '/', httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + ttl
  });
  if (!cookie) throw new Error('Не удалось установить cookie сессии');
  return true;
}
async function doLogin(origin, password) {
  if (await sessionCookie(origin)) return {ok: true};
  if (!password) return {needPassword: true};
  const authenticated = await sendLogin(origin, password);
  return authenticated ? {ok: true} : {publicOnly: true};
}
async function storeProfile(address, paused = false) {
  const {origin, homeUrl} = normalizeAddress(address);
  const {profiles} = await settings();
  const old = profiles.find(p => p.origin === origin);
  const record = {origin, homeUrl: homeUrl || old?.homeUrl || origin + '/', paused};
  await chrome.storage.local.set({profiles: [record, ...profiles.filter(p => p.origin !== origin)]});
  return record;
}

// Reload open tabs belonging to the disconnected Gateway so already rendered
// private pages are replaced by their unauthenticated public responses.
// Host permissions (requested on profile creation) suffice; no global tabs
// permission is needed.
async function reloadGatewayTabs(origin) {
  try {
    const tabs = await chrome.tabs.query({url: hostPermission(origin)});
    for (const tab of tabs) {
      if (tab.id !== undefined && tab.url && new URL(tab.url).origin === origin)
        await chrome.tabs.reload(tab.id, {bypassCache: true});
    }
  } catch (err) {
    console.warn('Shade: unable to refresh one or more disconnected tabs', err);
  }
}

// Logout removes the *browser* cookie regardless of Gateway reachability.
// If server revocation fails, the token may remain valid on the Gateway until TTL.
async function dropSession(origin) {
  const cookie = await sessionCookie(origin);
  let remoteRevoked = !cookie;
  if (cookie) {
    try {
      const response = await fetch(origin + '/.well-known/shade-logout', {
        method: 'POST', headers: {'X-Shade-Session': cookie.value},
        credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });
      remoteRevoked = response.ok && (await response.json()).logged_out === true;
    } catch (_) { remoteRevoked = false; }
    await chrome.cookies.remove({url: origin + '/', name: gatewayCookieName(origin)});
  }
  await reloadGatewayTabs(origin);
  return {remoteRevoked};
}
async function connect(message) {
  const {enabled} = await settings();
  if (!enabled) return {ok: false, error: 'Shade выключен. Сначала включи общий переключатель.'};
  const address = normalizeAddress(message.url);
  const logged = await doLogin(address.origin, message.password);
  if (logged.needPassword) return logged;
  const record = await storeProfile(message.url, false);
  if (message.open !== false) await chrome.tabs.create({url: record.homeUrl});
  return {ok: true, publicOnly: Boolean(logged.publicOnly)};
}
async function open(message) {
  const origin = normalizeAddress(message.origin).origin;
  const {enabled, profiles} = await settings();
  if (!enabled) return {ok: false, error: 'Shade выключен. Включи общий переключатель.'};
  const profile = profiles.find(p => p.origin === origin);
  if (!profile) return {ok: false, error: 'Профиль не найден'};
  if (profile.paused) return {ok: false, error: 'Этот сайт выключен. Включи соединение в его профиле.'};
  const logged = await doLogin(origin, message.password);
  if (logged.needPassword) return logged;
  await chrome.tabs.create({url: profile.homeUrl});
  return {ok: true, publicOnly: Boolean(logged.publicOnly)};
}
async function toggleSite(message) {
  const origin = normalizeAddress(message.origin).origin;
  const {enabled, profiles} = await settings();
  const profile = profiles.find(p => p.origin === origin);
  if (!profile) return {ok: false, error: 'Профиль не найден'};
  const turnOn = message.enabled === true;
  if (turnOn && !enabled) return {ok: false, error: 'Сначала включи Shade целиком'};
  if (turnOn) {
    // Do not mark enabled until login succeeds (or user supplies a password).
    const result = await doLogin(origin, message.password);
    if (result.needPassword || result.publicOnly) return {...result, ok: !result.needPassword};
    profile.paused = false;
    await chrome.storage.local.set({profiles});
    return {ok: true, enabled: true};
  }
  // Set paused before logout; any later open will be rejected.
  profile.paused = true;
  await chrome.storage.local.set({profiles});
  const result = await dropSession(origin);
  return {ok: true, enabled: false, ...result};
}
async function toggleAll(message) {
  const enabled = message.enabled === true;
  const state = await settings();
  if (enabled === state.enabled) return {ok: true, enabled, remoteFailures: 0};
  await chrome.storage.local.set({[MASTER]: enabled});
  if (!enabled) {
    let remoteFailures = 0;
    for (const profile of state.profiles) {
      const r = await dropSession(profile.origin);
      if (!r.remoteRevoked) remoteFailures++;
    }
    return {ok: true, enabled: false, remoteFailures};
  }
  // Master ON enables manual connections; it does not silently log in everywhere.
  return {ok: true, enabled: true, remoteFailures: 0};
}
async function disconnect(message) {
  const origin = normalizeAddress(message.origin).origin;
  return toggleSite({origin, enabled: false});
}
async function forget(message) {
  const origin = normalizeAddress(message.origin).origin;
  const result = await dropSession(origin);
  const {profiles} = await settings();
  await chrome.storage.local.set({profiles: profiles.filter(p => p.origin !== origin)});
  return {ok: true, ...result};
}
async function status() {
  const {profiles, enabled} = await settings();
  const result = [];
  for (const p of profiles) {
    const cookie = enabled && !p.paused ? await sessionCookie(p.origin) : null;
    result.push({...p, paused: p.paused === true, connected: Boolean(cookie), remembered: false});
  }
  return {ok: true, enabled, profiles: result};
}

// Serialize mutations: an in-flight login must never re-create a cookie after OFF.
let mutationQueue = Promise.resolve();
function exclusive(action) {
  const result = mutationQueue.then(action, action);
  mutationQueue = result.catch(() => {});
  return result;
}
const actions = {connect, open, toggleSite, toggleAll, disconnect, forget, status};
const mutations = new Set(['connect', 'open', 'toggleSite', 'toggleAll', 'disconnect', 'forget']);
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || !Object.hasOwn(actions, msg.action)) return false;
  const task = () => actions[msg.action](msg);
  const promise = mutations.has(msg.action) ? exclusive(task) : mutationQueue.then(task);
  promise.then(reply).catch(err => reply({ok: false, error: err.message || String(err)}));
  return true;
});
chrome.omnibox.onInputChanged.addListener((input, suggest) => {
  suggest([{content: input, description: 'Открыть включённый профиль Shade'}]);
});
chrome.omnibox.onInputEntered.addListener(input => {
  exclusive(async () => {
    const {profiles, enabled} = await settings();
    if (!enabled) return;
    const q = input.trim().replace(/^shade:\/\//i, '').replace(/\/$/, '').toLowerCase();
    const p = profiles.find(p => new URL(p.origin).host.toLowerCase() === q || p.origin.toLowerCase() === q);
    if (!p || p.paused) return;
    const result = await doLogin(p.origin);
    if (result.needPassword) return chrome.action.openPopup();
    await chrome.tabs.create({url: p.homeUrl});
  }).catch(err => console.warn('Shade omnibox', err));
});
