import {hostPermission, hostnameLabel, normalizeAddress} from './navigation.mjs';
const $ = id => document.getElementById(id);
let profiles = [];
let masterEnabled = true;
let promptedOrigin = null;
let promptAction = 'open';
let busy = false;
function status(text, error = false) {
  $('status').textContent = text;
  $('status').style.color = error ? '#ff9a9f' : '#b1bfd4';
}
async function message(payload) {
  const r = await chrome.runtime.sendMessage(payload);
  if (!r?.ok) {
    if (r?.needPassword) return r;
    throw new Error(r?.error || 'Неизвестная ошибка');
  }
  return r;
}
async function requirePermission(origin) {
  const pattern = hostPermission(origin);
  if (!await chrome.permissions.contains({origins: [pattern]})) {
    if (!await chrome.permissions.request({origins: [pattern]}))
      throw new Error('Chromium не разрешил доступ к выбранному сайту');
  }
}
function hideForms() {
  $('addForm').hidden = true;
  $('passwordPrompt').hidden = true;
  promptedOrigin = null;
}
function showPrompt(profile, mode = 'open') {
  $('addForm').hidden = true;
  $('passwordPrompt').hidden = false;
  promptedOrigin = profile.origin;
  promptAction = mode;
  $('promptName').textContent = 'Пароль для ' + hostnameLabel(profile.origin);
  $('submitProfile').textContent = mode === 'toggle' ? 'Включить подключение' : 'Войти и открыть';
  $('profilePassword').value = '';
  $('profilePassword').focus();
}
async function refresh() {
  const result = await message({action: 'status'});
  profiles = result.profiles;
  masterEnabled = result.enabled;
  $('masterSwitch').checked = masterEnabled;
  $('masterState').textContent = masterEnabled ? 'Включён' : 'Выключен';
  $('masterHint').hidden = masterEnabled;
  $('addToggle').disabled = !masterEnabled;
  const list = $('list');
  list.replaceChildren();
  $('empty').hidden = profiles.length > 0;
  for (const profile of profiles) {
    const card = document.createElement('div');
    card.className = 'site' + ((!masterEnabled || profile.paused) ? ' off' : '');
    const head = document.createElement('div'); head.className = 'site-head';
    const label = document.createElement('div');
    const title = document.createElement('div'); title.className = 'row site-name';
    const dot = document.createElement('span'); dot.className = 'dot' + (profile.connected ? ' on' : '');
    const host = document.createElement('span'); host.textContent = hostnameLabel(profile.origin);
    title.append(dot, host);
    const url = document.createElement('div'); url.className = 'site-url'; url.textContent = profile.homeUrl;
    const state = document.createElement('div'); state.className = 'subtle';
    state.textContent = !masterEnabled ? 'Shade выключен' : profile.paused ? 'Отключён вручную' : profile.connected ? 'Подключён' : 'Сессия неактивна';
    label.append(title, url, state); head.append(label);
    const actions = document.createElement('div'); actions.className = 'site-actions';
    const open = document.createElement('button'); open.textContent = 'Открыть';
    open.disabled = !masterEnabled || profile.paused;
    open.onclick = () => openProfile(profile);
    const toggle = document.createElement('button'); toggle.className = 'secondary';
    toggle.disabled = !masterEnabled;
    toggle.textContent = profile.connected ? 'Выключить' : 'Включить';
    toggle.title = profile.connected ? 'Завершить сеанс и заблокировать автоподключение' : 'Разрешить подключение и войти';
    toggle.onclick = () => changeProfile(profile, !profile.connected);
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '✕';
    del.title = 'Удалить профиль';
    del.onclick = async () => {
      if (!confirm('Удалить профиль ' + hostnameLabel(profile.origin) + '?')) return;
      await run(async () => {
        const r = await message({action:'forget',origin:profile.origin});
        status(r.remoteRevoked ? 'Профиль удалён' : 'Профиль удалён. Сервер недоступен: старый сеанс может действовать до истечения срока.');
        await refresh();
      });
    };
    actions.append(open, toggle, del); card.append(head, actions); list.append(card);
  }
}
async function run(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (err) { status(err.message || String(err), true); }
  finally { busy = false; }
}
async function openProfile(profile) {
  await run(async () => {
    await requirePermission(profile.origin);
    const result = await message({action:'open',origin:profile.origin});
    if (result.needPassword) return showPrompt(profile, 'open');
    window.close();
  });
}
async function changeProfile(profile, enabled) {
  await run(async () => {
    if (enabled) await requirePermission(profile.origin);
    const r = await message({action:'toggleSite',origin:profile.origin,enabled});
    if (r.needPassword) return showPrompt(profile, 'toggle');
    if (r.publicOnly) { status('Открыта только публичная версия. Для скрытого доступа потребуется повторный вход.'); await refresh(); return; }
    status(enabled ? 'Подключение включено' : r.remoteRevoked ? 'Подключение выключено, сеанс отозван' : 'Отключено локально. Сервер недоступен: токен может действовать до истечения срока.');
    await refresh();
  });
}
$('masterSwitch').onchange = () => run(async () => {
  const desired = $('masterSwitch').checked;
  const r = await message({action:'toggleAll',enabled:desired});
  await refresh();
  if (desired) status('Shade включён. Сохранённые сайты можно подключать.');
  else status(r.remoteFailures ? `Shade отключён. ${r.remoteFailures} сеанс(ов) не удалось отозвать на сервере.` : 'Все подключения Shade отключены.');
});
$('addToggle').onclick = () => { hideForms(); $('addForm').hidden = false; $('address').focus(); };
$('cancel').onclick = hideForms;
$('cancelPrompt').onclick = hideForms;
$('connect').onclick = () => run(async () => {
  const url = $('address').value.trim(); const password = $('password').value;
  if (!password) throw new Error('Введите пароль');
  const {origin} = normalizeAddress(url);
  await requirePermission(origin);
  status('Подключение…');
  const r = await message({action:'connect',url,password});
  $('password').value = '';
  if (r.publicOnly) status('Открыта публичная версия сайта. Доступ к скрытой версии не получен.');
  window.close();
});
$('submitProfile').onclick = () => run(async () => {
  if (!promptedOrigin) return;
  const password = $('profilePassword').value;
  if (!password) throw new Error('Введите пароль');
  await requirePermission(promptedOrigin);
  const args = promptAction === 'toggle'
    ? {action:'toggleSite',origin:promptedOrigin,enabled:true,password}
    : {action:'open',origin:promptedOrigin,password};
  const r = await message(args);
  $('profilePassword').value = '';
  if (r.publicOnly) {
    status('Скрытый доступ не получен; сервер оставил публичный сайт.');
    hideForms(); await refresh(); return;
  }
  if (promptAction === 'open') window.close();
  else { hideForms(); status('Подключение включено'); await refresh(); }
});
$('password').onkeydown = e => {if(e.key === 'Enter') $('connect').click();};
$('profilePassword').onkeydown = e => {if(e.key === 'Enter') $('submitProfile').click();};
refresh().then(() => { if (!profiles.length && masterEnabled) $('addForm').hidden = false; }).catch(err => status(err.message, true));
