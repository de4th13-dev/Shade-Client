import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dest = path.join(root, 'dist');
const stage = fs.mkdtempSync(path.join(root, '.shade-build-'));
const backup = path.join(root, '.shade-dist-backup');
try {
  // The extension must never have unresolved module imports or fetch code from a CDN.
  for (const name of ['background.js', 'popup.js']) {
    const outfile = path.join(stage, name);
    const result = await build({
      absWorkingDir: root,
      entryPoints: [path.join(src, name)], outfile,
      bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
      legalComments: 'eof', loader: {'.wasm': 'binary'},
      metafile: true, logLevel: 'warning',
    });
    const outputs = Object.values(result.metafile.outputs);
    if (outputs.length !== 1 || outputs.some(o => o.imports.length)) {
      throw new Error(`Unexpected runtime import or extra output in ${name}`);
    }
    const check = spawnSync(process.execPath, ['--check', outfile], {stdio:'inherit'});
    if (check.status !== 0) throw new Error(`JavaScript validation failed: ${name}`);
  }
  for (const name of ['manifest.json','popup.html']) fs.copyFileSync(path.join(src,name),path.join(stage,name));
  fs.mkdirSync(path.join(stage,'icons'));
  for (const name of ['shade-16.png','shade-32.png','shade-48.png','shade-128.png']) {
    fs.copyFileSync(path.join(src,'icons',name),path.join(stage,'icons',name));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(stage,'manifest.json'),'utf8'));
  const files = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const file of files) if (!fs.statSync(path.join(stage,file)).isFile()) throw new Error(`Missing manifest file: ${file}`);
  const pkg = path.join(root,'node_modules','@serenity-kit','opaque');
  for (const filename of ['LICENSE','LICENSE.md','LICENSE.txt']) {
    if (fs.existsSync(path.join(pkg,filename))) fs.copyFileSync(path.join(pkg,filename),path.join(stage,'OPAQUE-'+filename));
  }
  // Only publish a complete build; keep the old installation if the build fails.
  if (fs.existsSync(backup)) throw new Error(`Previous backup exists: ${backup}. Restore or remove it manually.`);
  if (fs.existsSync(dest)) fs.renameSync(dest,backup);
  try { fs.renameSync(stage,dest); }
  catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup,dest); throw error; }
  fs.rmSync(backup,{recursive:true,force:true});
  console.log(`Готовая папка расширения: ${dest}`);
} finally {
  fs.rmSync(stage,{recursive:true,force:true});
}
