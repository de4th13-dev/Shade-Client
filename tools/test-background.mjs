// Test startup and message routing without requiring the WASM package.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const nav = new URL('../src/navigation.mjs', import.meta.url).href;
const source = readFileSync(new URL('../src/background.js',import.meta.url),'utf8')
  .replace("'./navigation.mjs'", JSON.stringify(nav))
  .replace("import {ready, client} from '@serenity-kit/opaque';", 'const ready=Promise.resolve(), client={};');
for (const namespace of ['chrome','browser']) {
  delete globalThis.chrome; delete globalThis.browser;
  let listener, omnibox, created;
  const storage = {profiles:[{origin:'https://example.test',homeUrl:'https://example.test/',paused:false}], shadeEnabled:true};
  const local = {get:async()=>storage,remove:async()=>{},set:async obj=>Object.assign(storage,obj)};
  // Firefox need not implement Chromium-specific storage access control.
  if(namespace==='chrome') local.setAccessLevel=async()=>{};
  globalThis[namespace] = {storage:{local,session:{remove:async()=>{}}},
    permissions:{contains:async()=>true}, cookies:{get:async()=>null},
    runtime:{id:'test',getURL:p=>`https://extension.test/${p}`,onMessage:{addListener:fn=>{listener=fn}}},
    omnibox:{onInputChanged:{addListener(){}},onInputEntered:{addListener:fn=>{omnibox=fn}}},
    windows:{create:async options=>{created=options}}, tabs:{create:async()=>{throw Error('unexpected navigation')}}};
  await import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+namespace).toString('base64'));
  const send = msg=>new Promise(resolve=>assert.equal(listener(msg,{id:'test'},resolve),true));
  assert.equal((await send({action:'status'})).ok,true);
  assert.equal((await send({action:'open',origin:'https://example.test'})).needPassword,true);
  assert.equal(listener({action:'status'},{id:'foreign'},()=>assert.fail()),false);
  omnibox('example.test');
  await new Promise(r=>setImmediate(r));
  assert.equal(new URL(created.url).searchParams.get('profile'),'https://example.test');
  assert.equal(new URL(created.url).searchParams.get('window'),'1');
}
console.log('Background startup, trusted messages and omnibox password window OK (both API mocks)');
