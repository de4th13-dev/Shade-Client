import {readFileSync} from 'node:fs';
export const FIREFOX_ID = 'shade-client@requiem.su';
export function manifestFor(target) {
  const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));
  if (target === 'chromium') return manifest;
  if (target !== 'firefox') throw new Error(`Unknown target: ${target}`);
  delete manifest.minimum_chrome_version;
  manifest.background = {scripts:['background.js'], type:'module'};
  manifest.browser_specific_settings = {gecko:{
    id:FIREFOX_ID, strict_min_version:'140.0',
    data_collection_permissions:{required:['authenticationInfo']}
  }};
  return manifest;
}
