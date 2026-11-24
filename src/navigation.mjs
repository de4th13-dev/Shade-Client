// The browser does not register the shade:// scheme; this extension uses HTTPS.
export function normalizeAddress(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Введите адрес сайта');
  if (!text.includes('://')) {
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(text);
    text = (local ? 'http://' : 'https://') + text;
  }
  let u;
  try { u = new URL(text); } catch { throw new Error('Некорректный URL сайта'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('Используйте HTTP(S)-адрес без логина в URL');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    throw new Error('Для удалённых серверов требуется HTTPS');
  if (u.hash) u.hash = '';
  return {origin: u.origin, homeUrl: u.href};
}
export function gatewayCookieName(origin) {
  return new URL(origin).protocol === 'https:' ? '__Host-Shade-Session' : 'shade_session';
}
export function hostnameLabel(origin) {
  return new URL(origin).host;
}
export function hostPermission(origin) {
  const u = new URL(origin);
  // Permission patterns intentionally scope to one hostname, with all ports.
  return `${u.protocol}//${u.hostname}/*`;
}
