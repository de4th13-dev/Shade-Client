"""Install the unsigned test build temporarily into a real Firefox profile."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile, ZIP_DEFLATED
from selenium import webdriver
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.by import By

root = Path(__file__).resolve().parents[1] / 'dist' / 'firefox'
manifest = json.loads((root / 'manifest.json').read_text())
addon_id = manifest['browser_specific_settings']['gecko']['id']
uuid = '27fa780e-d2fb-437e-bf1a-8db9705eea74'
url = f'moz-extension://{uuid}/popup.html'
opts = webdriver.FirefoxOptions()
opts.add_argument('-headless')
opts.set_preference('extensions.webextensions.uuids', json.dumps({addon_id: uuid}))
if os.environ.get('FIREFOX_BIN'):
    opts.binary_location = os.environ['FIREFOX_BIN']
with TemporaryDirectory() as tmp:
    xpi = Path(tmp) / 'test.xpi'
    with ZipFile(xpi, 'w', ZIP_DEFLATED) as archive:
        for p in root.rglob('*'):
            if p.is_file(): archive.write(p, p.relative_to(root))
    with webdriver.Firefox(options=opts, service=Service(service_args=['--allow-system-access'])) as driver:
        driver.set_script_timeout(30)
        assert driver.install_addon(str(xpi), temporary=True) == addon_id
        # Use the browser's own privileged navigation; newer Firefox versions
        # restrict WebDriver's content-context navigation to moz-extension URLs.
        with driver.context(driver.CONTEXT_CHROME):
            driver.execute_script('gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});', url)
        WebDriverWait(driver, 30).until(lambda d: d.find_element(By.ID, 'masterSwitch'))
        result = driver.execute_async_script('''
            const done = arguments[arguments.length-1];
            browser.runtime.sendMessage({action:'status'}).then(done, e=>done({error:String(e)}));
        ''')
        assert result.get('ok') is True, result
        assert result['enabled'] is True and result['profiles'] == [], result
        print('Firefox: temporary install, popup and background messaging OK')
