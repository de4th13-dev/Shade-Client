// Real integration check using exactly the browser bundle. Password on stdin only.
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {normalizeAddress} from '../src/navigation.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({stdin:{contents:'export {ready, client} from "@serenity-kit/opaque";',resolveDir:root}, bundle:true,platform:'browser',format:'esm',target:'chrome116',loader:{'.wasm':'binary'},write:false});
const {ready,client} = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
await ready;
const {origin} = normalizeAddress(process.argv[2]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, '');
if (!password) throw new Error('Missing password');
const state = client.startLogin({password});
const challenge = await fetch(origin + '/.well-known/shade-opaque/start', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ke1:state.startLoginRequest}), redirect:'manual', signal:AbortSignal.timeout(15000)
}).then(r=>r.json());
if (challenge.shade_opaque !== 'v1') throw new Error('No OPAQUE challenge');
const finish = client.finishLogin({clientLoginState:state.clientLoginState, password, loginResponse:challenge.ke2});
if (!finish) throw new Error('OPAQUE login not verified');
const info = await fetch(origin + '/.well-known/shade-opaque/finish', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({attempt:challenge.attempt, ke3:finish.finishLoginRequest}), redirect:'manual', signal:AbortSignal.timeout(15000)
}).then(r=>r.json());
if (info.shade_authenticated !== true || typeof info.session_token !== 'string') throw new Error('No authenticated session');
const logout = await fetch(origin + '/.well-known/shade-logout', {
  method:'POST', headers:{'X-Shade-Session':info.session_token}, redirect:'manual', signal:AbortSignal.timeout(5000)
});
if (!logout.ok || (await logout.json()).logged_out !== true) throw new Error('Login succeeded, but session revocation failed');
console.log('OPAQUE Gateway ↔ browser bundle: вход и отзыв сессии — OK');
