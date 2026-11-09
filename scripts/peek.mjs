/* 通用 CDP：打开任意 URL，截图 + 收集异常 + 可选执行表达式
   用法: node scripts/peek.mjs <url> <out.png> [w] [h] [expr] */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { findChrome } from './chrome.mjs';

const CHROME = findChrome();
const url = process.argv[2];
const out = process.argv[3] || 'peek.png';
const W = +(process.argv[4] || 1440);
const H = +(process.argv[5] || 900);
const EXPR = process.argv[6] || '';
const WAIT = +(process.env.WAIT || 4000);

const port = 12300 + Math.floor(Math.random() * 400);
const p = spawn(CHROME, ['--headless', '--remote-debugging-port=' + port, '--hide-scrollbars',
  '--disable-gpu', '--allow-file-access-from-files', '--force-device-scale-factor=1',
  '--window-size=' + W + ',' + H, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getWS() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/version', { }); const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch { }
    await sleep(150);
  }
  throw new Error('no devtools');
}
const ws = new WebSocket(await getWS());
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
    logs.push(m.params.type.toUpperCase() + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
};
await new Promise(r => ws.onopen = r);
function send(method, params = {}, sessionId) { const mid = ++id; return new Promise((res, rej) => { pending.set(mid, (m) => m.error ? rej(new Error(method + JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); }); }

const { targetInfos } = await send('Target.getTargets');
let t = targetInfos.find(x => x.type === 'page') || { targetId: (await send('Target.createTarget', { url: 'about:blank' })).targetId };
const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url }, sessionId);
await sleep(WAIT);

const CLICK = process.env.CLICK || '';
let result = null;
if (EXPR) {
  var rRaw = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true }, sessionId);
  var r = rRaw;
  result = r.result?.value;
  await sleep(1200);
}
if (CLICK) {
  const [cx, cy] = CLICK.split(',').map(Number);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 }, sessionId);
  await sleep(+(process.env.CLICKWAIT || 2500));
}
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
fs.writeFileSync(out, Buffer.from(data, 'base64'));
console.log('saved ' + out);
if (process.env.POST) {
  const pr = await send('Runtime.evaluate', { expression: process.env.POST, returnByValue: true, awaitPromise: true }, sessionId);
  console.log('POST ' + JSON.stringify(pr.result?.value ?? pr.exceptionDetails?.text));
}
if (result !== null && result !== undefined) console.log('RESULT ' + JSON.stringify(result));
else if (EXPR) console.log('RAW ' + JSON.stringify(rRaw));
console.log(logs.length ? logs.join('\n') : 'no console errors');
ws.close(); p.kill(); process.exit(0);
