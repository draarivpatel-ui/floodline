import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const url = new URL(process.argv[2] || 'http://127.0.0.1:4173/floodline/');
assert.equal(url.hostname, '127.0.0.1', 'Only test the local release.');
const profile = await mkdtemp(join(tmpdir(), 'floodline-chrome-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--mute-audio', '--disable-extensions', '--disable-background-networking', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const closed = once(chrome, 'close');
let socket;
const events = [];
const CHECK_TIMEOUT_MS = Number(process.env.FLOODLINE_CHECK_TIMEOUT_MS || 6000);
const CDP_TIMEOUT_MS = Number(process.env.FLOODLINE_CDP_TIMEOUT_MS || 8000);

async function until(label, get, timeout = CHECK_TIMEOUT_MS) {
  const end = Date.now() + timeout;
  do {
    const value = await get();
    if (value) return value;
    await sleep(45);
  } while (Date.now() < end);
  assert.fail(`Timed out: ${label}`);
}

try {
  const port = await until('Chrome debugging port', async () => {
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return 0; }
  });
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(item => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (packet.id) {
      pending.get(packet.id)?.(packet);
    } else if (packet.method) events.push(packet);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome did not complete ${method}`));
    }, CDP_TIMEOUT_MS);
    pending.set(id, packet => {
      clearTimeout(timer);
      pending.delete(id);
      if (packet.error) reject(new Error(`${method}: ${packet.error.message}`));
      else resolve(packet.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!res.exceptionDetails, JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
  const visible = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const text = selector => evaluate(`${visible(selector)}.textContent.trim()`);
  async function click(selector) {
    const point = await evaluate(`(() => {
      const target = ${visible(selector)};
      target.scrollIntoView({block:'nearest'});
      const r = target.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!target.contains(document.elementFromPoint(x, y))) throw Error('Pointer does not hit '+target.id);
      return {x, y};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async function pressKey(key, code, keyCode) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    }
  }
  async function setValue(selector, value, event) {
    await evaluate(`(() => {
      const target = ${visible(selector)};
      target.value = ${JSON.stringify(value)};
      target.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true}));
    })()`);
  }
  async function ready() {
    await until('workbench map', () => evaluate(`Boolean(document.querySelector('#map path') && document.querySelector('#stage-now')?.textContent.trim())`));
  }
  async function navigate() {
    const result = await send('Page.navigate', { url: url.href });
    assert.ok(!result.errorText, result.errorText);
    await ready();
  }
  async function reload() {
    const oldTimeOrigin = await evaluate('performance.timeOrigin');
    await send('Page.reload');
    await until('reload creates a new document', () => evaluate(`performance.timeOrigin !== ${oldTimeOrigin}`).catch(() => false));
    await ready();
  }
  async function capture(file) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const destination = process.env.FLOODLINE_CAPTURE_DIR
      ? join(process.env.FLOODLINE_CAPTURE_DIR, file) : new URL(`../docs/${file}`, import.meta.url);
    await writeFile(destination, Buffer.from(data, 'base64'));
  }
  async function verifyPrint(language) {
    await send('Emulation.setEmulatedMedia', { media: 'print' });
    assert.equal(await evaluate(`document.querySelector('#card-paper').getAttribute('lang')`), language);
    assert.ok(await evaluate(`document.querySelector('#card-paper').getBoundingClientRect().height > 0`));
    const { data } = await send('Page.printToPDF', { printBackground: true, paperWidth: 8.5, paperHeight: 11, preferCSSPageSize: true });
    assert.equal(Buffer.from(data, 'base64').toString('latin1').match(/\/Type\s*\/Page\b/g)?.length, 1, `${language} go-card must fit one printed page`);
    await send('Emulation.setEmulatedMedia', { media: 'screen' });
  }

  await Promise.all(['Runtime', 'Page', 'Log', 'Network'].map(domain => send(`${domain}.enable`)));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate();
  assert.equal(await evaluate(`document.querySelector('link[rel="canonical"]')?.href`), 'https://aariv.me/floodline/');
  assert.equal(await evaluate(`document.querySelector('meta[property="og:image"]')?.content`), 'https://aariv.me/floodline/og-image.png');
  assert.ok(await evaluate(`Boolean(document.querySelector('script[type="application/ld+json"]'))`));
  assert.equal(await evaluate(`document.querySelectorAll('table caption.sr-only').length`), 3);
  assert.ok(await evaluate(`document.querySelectorAll('table tbody th[scope="row"]').length >= 3`));
  assert.equal(await evaluate(`Number(document.querySelector('#minute').value)`), 75);
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 1440);
  assert.equal(await evaluate(`document.querySelectorAll('.table-wrap[tabindex="0"][role="region"][aria-label]').length`), 3);
  const initial = await text('#route-status');
  assert.doesNotMatch(initial, /unreachable/i);
  assert.match(await text('#map'), /Canal Underpass/);
  await evaluate('window.scrollTo(0, 0)');
  await capture('desktop.png');

  for (const selector of ['#pavement', '#clear', '#bridge']) await click(selector);
  assert.match(await text('#metrics'), /2: Willow Homes, Terrace Homes/);
  assert.match(await text('#hydrograph'), /before mitigation/);
  for (const selector of ['#bridge', '#clear', '#pavement']) await click(selector);
  assert.equal(await text('#route-status'), initial);
  await click('#settings .advanced summary');
  await setValue('#custom-rain', '-25 10', 'input');
  await click('#apply-edits');
  assert.match(await text('#edit-error'), /nonnegative/);
  assert.equal(await text('#route-status'), initial);
  await setValue('#preset', 'urban', 'change');
  assert.equal(await evaluate(`Number(document.querySelector('#minute').value)`), 54);
  await setValue('#preset', 'bayou', 'change');
  assert.equal(await text('#route-status'), initial);

  await evaluate(`(() => {
    window.floodlineTestDownloads = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = blob => {
      window.floodlineTestDownloads.push(blob);
      return original(blob);
    };
    document.addEventListener('click', event => {
      if (event.target.closest('a[download]')) event.preventDefault();
    });
  })()`);
  for (const selector of ['#export-csv', '#export-geojson', '#export-json']) await click(selector);
  await until('three browser export blobs', () => evaluate('window.floodlineTestDownloads.length === 3'));
  const [csv, geo, audit] = await evaluate('Promise.all(window.floodlineTestDownloads.map(blob => blob.text()))');
  assert.match(csv, /"selected_snapshot"/);
  assert.equal(JSON.parse(geo).type, 'FeatureCollection');
  assert.match(JSON.parse(audit).sha256, /^[a-f0-9]{64}$/);

  // Storm tier comparator, cutoff timeline, self-tests, signed brief, bookmark.
  assert.equal(await evaluate(`document.querySelectorAll('#tier-row button').length`), 5);
  assert.equal(await evaluate(`document.querySelectorAll('#compare-table tbody tr').length`), 6);
  assert.match(await text('#compare-note'), /50-yr/);
  assert.equal(await evaluate(`document.querySelectorAll('#cutoff-chart g[data-origin]').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('#alert-matrix tbody tr').length`), 3);
  assert.ok(await evaluate(`document.querySelectorAll('#alert-matrix tbody td.ok, #alert-matrix tbody td.cut').length > 6`));

  const baseStage = await evaluate(`document.querySelector('#compare-table tbody tr td:nth-child(3)').textContent`);
  await click('#tier-row button[data-tier="t500"]');
  await until('500-yr comparator', () => evaluate(`/500-yr/.test(${visible('#compare-note')}.textContent)`));
  assert.notEqual(await evaluate(`document.querySelector('#compare-table tbody tr td:nth-child(3)').textContent`), baseStage);
  assert.equal(await evaluate(`${visible('#tier-row button[data-tier="t500"]')}.getAttribute('aria-pressed')`), 'true');
  await setValue('#intensity', '170', 'input');
  await until('custom intensity tier', () => evaluate(`/custom x1.70/.test(${visible('#compare-note')}.textContent)`));
  await setValue('#budget', '30', 'input');
  assert.equal(await text('#budget-readout'), '$3.0M');
  assert.equal(await evaluate(`document.querySelectorAll('#compare-table tbody tr.dim').length`), 4);
  await setValue('#budget', '90', 'input');
  assert.equal(await evaluate(`document.querySelectorAll('#compare-table tbody tr.dim').length`), 0);
  await click('#tier-row button[data-tier="t50"]');
  await until('50-yr comparator restored', () => evaluate(`/50-yr/.test(${visible('#compare-note')}.textContent)`));

  await evaluate(`${visible('#cutoff-chart')}.focus()`);
  await pressKey('ArrowRight', 'ArrowRight', 39);
  await until('strip arrow key selects the next zone', () => evaluate(`${visible('#origin')}.value === 'homes'`));
  await pressKey('ArrowLeft', 'ArrowLeft', 37);
  await until('strip arrow key returns to school', () => evaluate(`${visible('#origin')}.value === 'school'`));
  await click('#cutoff-chart g[data-origin="homes"]');
  await until('strip click selects the homes zone', () => evaluate(`${visible('#origin')}.value === 'homes'`));
  assert.equal(await evaluate(`Number(${visible('#minute')}.value)`), 80);
  await setValue('#origin', 'school', 'change');
  await setValue('#minute', '75', 'input');

  // Neighborhood buddy check-in: pairing table, bilingual card, copy and print.
  assert.equal(await evaluate(`document.querySelectorAll('#buddy-table tbody tr').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('#buddy-table select').length`), 3);
  assert.match(await text('#buddy-note'), /50-yr/);
  assert.equal(await evaluate(`document.querySelector('#buddy-table tbody tr select').value`), 'homes');
  await setValue('#buddy-table tbody tr select', 'gardens', 'change');
  await click('#buddy-open');
  await until('buddy dialog', () => evaluate(`document.querySelector('#buddy-dialog').open`));
  assert.match(await text('#buddy-paper'), /Neighborhood buddy card/);
  assert.match(await text('#buddy-paper'), /Cypress School <> Terrace Homes/);
  assert.match(await text('#buddy-paper'), /storm minute 81/);
  assert.match(await evaluate(`${visible('#buddy-text')}.value`), /NEIGHBORHOOD BUDDY CARD/);
  await setValue('#buddy-language', 'es', 'change');
  assert.match(await text('#buddy-paper'), /Tarjeta de apoyo entre vecinos/);
  assert.match(await text('#buddy-paper'), /en automóvil/);
  assert.match(await evaluate(`${visible('#buddy-text')}.value`), /TARJETA DE APOYO ENTRE VECINOS/);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  const buddyPdf = await send('Page.printToPDF', { printBackground: true, paperWidth: 8.5, paperHeight: 11, preferCSSPageSize: true });
  assert.ok(Buffer.from(buddyPdf.data, 'base64').length > 2000, 'buddy card must print a nonempty page');
  await send('Emulation.setEmulatedMedia', { media: 'screen' });
  await click('#buddy-close');
  assert.equal(await evaluate(`document.querySelector('#buddy-dialog').open`), false);
  await setValue('#buddy-table tbody tr select', 'homes', 'change');
  await click('#methodology > summary');
  assert.equal(await evaluate(`document.querySelector('#methodology').open`), true);
  assert.match(await text('#methodology'), /curve-number/);

  await click('#selftest');
  await until('nine self-test rows', () => evaluate(`document.querySelectorAll('#selftest-list li').length === 9`));
  assert.equal(await evaluate(`document.querySelectorAll('#selftest-list .pass').length`), 9);
  assert.equal(await evaluate(`document.querySelectorAll('#selftest-list .fail').length`), 0);

  for (const selector of ['#export-brief-json', '#export-brief-csv', '#export-brief-md']) await click(selector);
  await until('three brief download blobs', () => evaluate('window.floodlineTestDownloads.length === 6'));
  const [briefJson, briefCsv, briefMd] = await evaluate(
    'Promise.all(window.floodlineTestDownloads.slice(3).map(blob => blob.text()))');
  assert.match(JSON.parse(briefJson).sha256, /^[a-f0-9]{64}$/);
  assert.match(briefCsv, /^"storm_tier"/);
  assert.match(briefMd, /SHA-256 [a-f0-9]{64}/);

  await setValue('#verify-input', briefJson, 'input');
  await click('#verify-btn');
  assert.match(await text('#verify-result'), /Signature valid/);
  const tampered = await evaluate(`JSON.stringify((() => {
    const d = JSON.parse(${JSON.stringify(briefJson)});
    d.payload.preset = 'tampered';
    return d;
  })())`);
  await setValue('#verify-input', tampered, 'input');
  await click('#verify-btn');
  assert.match(await text('#verify-result'), /Signature check failed/);

  await setValue('#preset', 'coastal', 'change');
  await setValue('#minute', '123', 'input');
  await setValue('#mode', 'pedestrian', 'change');
  await click('#pavement');
  await setValue('#origin', 'homes', 'change');
  await click('#bookmark');
  const bookmarkUrl = await evaluate(`${visible('#bookmark-url')}.value`);
  assert.match(bookmarkUrl, /#flood=/);
  const bookmarkHash = new URL(bookmarkUrl).hash;
  const replay = await send('Page.navigate', { url: `${url.origin}${url.pathname}?b=1${bookmarkHash}` });
  assert.ok(!replay.errorText, replay.errorText);
  await ready();
  assert.equal(await evaluate(`${visible('#preset')}.value`), 'coastal');
  assert.equal(await evaluate(`Number(${visible('#minute')}.value)`), 123);
  assert.equal(await evaluate(`${visible('#mode')}.value`), 'pedestrian');
  assert.equal(await evaluate(`${visible('#pavement')}.checked`), true);
  assert.equal(await evaluate(`${visible('#origin')}.value`), 'homes');
  const replayNote = await send('Page.navigate', { url: url.href });
  assert.ok(!replayNote.errorText, replayNote.errorText);
  await ready();
  assert.equal(await evaluate(`Number(${visible('#minute')}.value)`), 75);

  await click('#play');
  await until('simulation playback advances the time', () => evaluate(`Number(document.querySelector('#minute').value)>75`));
  await click('#play');
  await setValue('#minute', 101, 'input');
  assert.match(await text('#route-status'), /unreachable/i);
  await click('#go-card');
  await until('unreachable go-card', () => evaluate(`document.querySelector('#card-dialog').open && /unreachable/i.test(document.querySelector('#card-paper').textContent)`));
  assert.doesNotMatch(await text('#card-paper'), /Follow Cypress Rise/i);
  await click('#card-close');

  await setValue('#minute', 75, 'input');
  await click('#go-card');
  await until('go-card dialog', () => evaluate(`document.querySelector('#card-dialog').open`));
  assert.match(await text('#card-paper'), /Cypress Rise/);
  assert.match(await text('#card-paper'), /High Bridge/);
  assert.match(await evaluate(`${visible('#card-text')}.value`), /From: Cypress School/);
  assert.equal(await evaluate(`${visible('#card-dialog-title')}.textContent`), 'Family go-card');
  await verifyPrint('en');
  await setValue('#card-language', 'es', 'change');
  assert.match(await text('#card-paper'), /Tarjeta familiar/i);
  assert.match(await text('#card-paper'), /Simulaci\u00f3n ficticia/i);
  assert.match(await evaluate(`${visible('#card-text')}.value`), /Desde: Cypress School/);
  assert.match(await evaluate(`${visible('#card-text')}.value`), /Ruta:/);
  assert.equal(await evaluate(`${visible('#card-dialog-title')}.textContent`), 'Tarjeta familiar');
  assert.equal(await evaluate(`${visible('#card-copy')}.textContent`), 'Copiar texto');
  assert.doesNotMatch(await text('#card-paper ol li:first-child'), /^\s*1\./);
  await verifyPrint('es');
  await capture('evacuation.png');
  await click('#card-close');
  await until('closing the card restores focus to its opener', () => evaluate(`document.activeElement?.id === 'go-card'`));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await reload();
  await evaluate('window.scrollTo(0, 0)');
  assert.equal(await evaluate('innerWidth'), 390);
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 390);
  const touchTargets = await evaluate(`[...document.querySelectorAll('.mast-actions .btn, .timeline .btn, .tier-row .btn, #minute, #preset, #origin, #mode')]
    .filter(el => el.getClientRects().length)
    .map(el => ({ name: el.id || el.textContent.trim(), height: el.getBoundingClientRect().height }))`);
  assert.ok(touchTargets.length >= 8, `expected mobile touch targets, saw ${touchTargets.length}`);
  assert.ok(touchTargets.every(target => target.height >= 44), JSON.stringify(touchTargets));
  assert.equal(await evaluate(`document.querySelector('#settings').open`), false);
  assert.ok(await evaluate(`document.querySelector('#go-card').getBoundingClientRect().height >= 44`));
  assert.ok(await evaluate(`document.querySelector('#map').getBoundingClientRect().bottom < innerHeight`));
  for (const selector of ['#tier-row', '#cutoff-chart', '#alert-matrix', '#compare-table',
    '#buddy-table', '#selftest', '#verify-btn', '#verify-input']) {
    const box = await evaluate(`(() => {
      const el = ${visible(selector)};
      const wrap = el.closest('.table-wrap') ?? el;
      return wrap.getBoundingClientRect().width;
    })()`);
    assert.ok(box <= 390.5, `${selector} overflows the 390 px viewport (${box})`);
  }
  await click('#selftest');
  await until('nine mobile self-test rows', () => evaluate(`document.querySelectorAll('#selftest-list .pass').length === 9`));
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 390);
  if (process.env.FLOODLINE_MOBILE_PNG) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(process.env.FLOODLINE_MOBILE_PNG, Buffer.from(data, 'base64'));
  }
  await click('#go-card');
  assert.ok(await evaluate(`document.querySelector('#card-dialog').open`));
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 390);
  await click('#card-close');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await click('#buddy-open');
  assert.ok(await evaluate(`document.querySelector('#buddy-dialog').open`));
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 390);
  await click('#buddy-close');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });

  await until('local scope is controlled by the offline worker', () => evaluate('Boolean(navigator.serviceWorker.controller)'), 8000);
  const onlineEvents = [...events];
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await reload();
  assert.equal(await evaluate('navigator.onLine'), false);
  await setValue('#minute', 101, 'input');
  assert.match(await text('#route-status'), /unreachable/i);

  const exceptions = events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && e.params.entry.source !== 'network'));
  const badResponses = onlineEvents.filter(e => e.method === 'Network.responseReceived' && e.params.response.status >= 400);
  const outgoing = events.filter(e => e.method === 'Network.requestWillBeSent' &&
    /^https?:/.test(e.params.request.url) && new URL(e.params.request.url).origin !== url.origin);
  assert.deepEqual(exceptions, []);
  assert.deepEqual(badResponses, []);
  assert.deepEqual(outgoing, []);
  console.log('1440x900 and 390x844 pass; playback and rerouting, mitigation, storm tiers, budget cap, keyboard cutoff strips, localized plain-text cards, self-tests, signed briefs, tamper check, bookmark replay, exports, both one-page cards, zero app errors, no external requests, and offline reload verified.');
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  await closed;
  await rm(profile, { recursive: true, force: true });
}
