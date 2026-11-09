/* 端到端：真实注入代码 → 点运行 → 采样截图 + 读取状态
   在项目根目录执行：
     node scripts/e2e.mjs <outPrefix> <python|java|c|cpp> <codeFile>
   例：node scripts/e2e.mjs py python scripts/fixtures/quicksort.py
   可用环境变量：URL（默认 http://127.0.0.1:5321/algo/）、LIGHT=1、W/H、CHROME（覆盖浏览器路径）
   截图固定写到 scripts/out/，已由 .gitignore 忽略。
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = findChrome();
const PREFIX = process.argv[2] || 'e2e';
const LANG = process.argv[3] || 'python';
const CODEFILE = process.argv[4] || path.join(HERE, 'fixtures', 'quicksort.py');
const URL = process.env.URL || 'http://127.0.0.1:5321/algo/';
const W = +(process.env.W || 1600);
const H = +(process.env.H || 980);

const code = fs.readFileSync(CODEFILE, 'utf8');
const port = 12700 + Math.floor(Math.random() * 300);
const p = spawn(CHROME, ['--headless', '--remote-debugging-port=' + port, '--hide-scrollbars',
  '--disable-gpu', '--force-device-scale-factor=1', '--window-size=' + W + ',' + H, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getWS() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch { }
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
const t = targetInfos.find(x => x.type === 'page') || { targetId: (await send('Target.createTarget', { url: 'about:blank' })).targetId };
const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: URL }, sessionId);
await sleep(6000);

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}
// 截图统一落到 scripts/out/，不污染项目根目录（该目录已被 .gitignore 忽略）
const OUTDIR = path.join(HERE, 'out');
fs.mkdirSync(OUTDIR, { recursive: true });
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUTDIR, PREFIX + '-' + name + '.png'), Buffer.from(data, 'base64'));
}
async function clickSel(sel) {
  const box = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);
  if (!box) return null;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
  return box;
}

// 1. 切语言（用原生 select 事件）
if (process.env.LIGHT) {
  await clickSel('.topbar .btn:last-of-type');
  await sleep(600);
}
const langOk = await ev(`(()=>{
  const sels=[...document.querySelectorAll('.topbar select')];
  const s=sels[0]; if(!s) return 'no-select';
  const opt=[...s.options].find(o=>o.value==='${LANG}'); if(!opt) return 'no-opt';
  const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  setter.call(s,'${LANG}');
  s.dispatchEvent(new Event('change',{bubbles:true}));
  return 'ok';
})()`);
await sleep(900);

// 2. 注入代码：走 debug 口拿 monaco 实例直接 setValue（触发 React onChange）
const injected = await ev(`(()=>{
  const m=window.__dsaMonaco;
  if(!m||!m.editor) return 'no-monaco';
  const models=m.editor.getModels();
  if(!models.length) return 'no-model';
  models[0].setValue(${JSON.stringify(code)});
  return models[0].getValue().length;
})()`);
console.log('injected chars =', injected, 'langOk =', langOk);
await sleep(1200);
await shot('00-typed');

// 3. 点运行
const runBox = await clickSel('.btn.primary');
await sleep(500);
await shot('01-compiling');
console.log('enginebar(early) =', await ev(`(document.querySelector('.engine-bar')||{}).innerText||''`));

// 4. 等执行完成
let state = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  state = await ev(`(()=>{
    const lb=document.querySelector('.step-label');
    const st=document.querySelector('.status-pill');
    return {label:lb?lb.innerText:'', status:st?st.innerText:'', err:(document.querySelector('.error-banner')||{}).innerText||''};
  })()`);
  if (state && (state.status === '错误' || (state.label && !/0 \/ 0/.test(state.label) && state.status !== '编译中'))) break;
}
console.log('after-run state =', JSON.stringify(state));

// 5. 中途采样
await ev(`(()=>{const r=document.querySelector('.progress-row input[type=range]');if(r){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(r,String(Math.floor(r.max*0.45)));r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));}return 1;})()`);
await sleep(1400);
await shot('02-mid');
await ev(`(()=>{const r=document.querySelector('.progress-row input[type=range]');if(r){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(r,String(r.max));r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));}return 1;})()`);
await sleep(1400);
await shot('03-end');

console.log('enginebar =', await ev(`(document.querySelector('.engine-bar')||{}).innerText||''`));
// 注意：Monaco 编辑器里也有 <canvas>（迷你地图 14px 宽），必须只取可视化画布
console.log('canvas =', await ev(`(()=>{const c=[...document.querySelectorAll('canvas')].find(x=>x.parentElement&&x.parentElement.classList.contains('canvas-wrap'));return c?c.width+'x'+c.height:'none';})()`));
console.log('statepanel =', JSON.stringify(await ev(`(()=>{const e=document.querySelector('.statepanel, .state-panel');return e?e.innerText.slice(0,600):'none';})()`)));
console.log(logs.length ? logs.join('\n') : 'no console errors');
if (process.env.POST) console.log('POST ' + JSON.stringify(await ev(process.env.POST)));
ws.close(); p.kill(); process.exit(0);
