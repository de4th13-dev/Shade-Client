// Regression: new-site permissions are requested from a persistent window.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const script = pathToFileURL(resolve('src/popup.js')).href;
let namespace = 'chrome';
const tick = () => new Promise(r => setImmediate(r));
async function setup(query, {grant = true, profiles = []} = {}) {
  const nodes = new Map(), messages = [], windows = [], permissions = [];
  let closed = false, resolvePermission;
  delete globalThis.browser; delete globalThis.chrome;
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, {value:'', hidden:true, style:{}, focus(){}, replaceChildren(){}, append(){}, className:''});
    return nodes.get(id);
  };
  globalThis.location = {search:query};
  globalThis.document = {getElementById:el, body:{classList:{add(){}}}, createElement:()=>el(Symbol())};
  globalThis.window = {close(){closed=true}};
  globalThis[namespace] = {
    runtime:{getURL:p=>`chrome-extension://test/${p}`, sendMessage:async msg=>{
      messages.push(msg);
      return msg.action==='status'?{ok:true,enabled:true,profiles}:{ok:true};
    }},
    windows:{create:async opts=>{windows.push(opts);return {id:1}}},
    permissions:{contains:async()=>false, request:opts=>{permissions.push(opts);return new Promise(r=>{resolvePermission=r})}}
  };
  await import(script+'?case='+Math.random()); await tick();
  return {el,messages,windows,permissions,get closed(){return closed}, allow:()=>resolvePermission(grant)};
}
for (const name of ['chrome','browser']) {
namespace=name;
{
  const t=await setup('');
  assert.equal(t.el('addForm').hidden,true);
  await t.el('addToggle').onclick();
  assert.equal(t.windows.length,1);assert.equal(t.windows[0].type,'popup');
  assert.equal(new URL(t.windows[0].url).searchParams.get('window'),'1');
  assert.equal(t.closed,true);assert.equal(t.permissions.length,0);
}
for (const grant of [true,false]) {
  const t=await setup('?window=1',{grant});
  assert.equal(t.el('addForm').hidden,false);
  t.el('address').value='https://example.test/admin/';t.el('password').value='test-password';
  const click=t.el('connect').onclick();
  assert.equal(t.permissions.length,1);assert.equal(t.messages.filter(m=>m.action==='connect').length,0);
  assert.equal(t.closed,false);
  t.allow(); await click;
  assert.equal(t.messages.filter(m=>m.action==='connect').length,grant?1:0);
  assert.equal(t.closed,grant);
  if (grant) assert.equal(t.el('password').value,'');
}
}
console.log('Popup (Chromium and Firefox API mocks): separate window, first permission approval and denial OK');
