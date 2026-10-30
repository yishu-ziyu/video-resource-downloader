const base = 'http://localhost:9222';
const version = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

let seq = 0;
const pending = new Map();
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, msg => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetInfos } = await send('Target.getTargets');
const workers = targetInfos.filter(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
for (const worker of workers) {
  const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  const evalJs = async expr => (await send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;
  const manifest = await evalJs('JSON.stringify(chrome.runtime.getManifest())').catch(() => null);
  if (!manifest) { await send('Target.detachFromTarget', { sessionId }); continue; }
  const { name, version: v } = JSON.parse(manifest);
  console.log(`${name} v${v} (${worker.url.split('/')[2]})`);
  if (name === '视频资源下载器') {
    const files = await evalJs("fetch('content.js').then(r => r.text()).then(t => t.includes('RENDER_DATA'))").catch(() => null);
    console.log('  loaded content.js has douyin fix:', files);
    await evalJs('chrome.runtime.reload()');
    console.log('  -> chrome.runtime.reload() called');
    await new Promise(r => setTimeout(r, 2000));
    // Reload spawns a fresh worker; re-list targets to confirm new manifest.
    const again = (await send('Target.getTargets')).targetInfos
      .filter(t => t.type === 'service_worker' && t.url.includes(worker.url.split('/')[2]));
    for (const w of again) {
      const { sessionId: s2 } = await send('Target.attachToTarget', { targetId: w.targetId, flatten: true });
      const m2 = await (await send('Runtime.evaluate',
        { expression: 'JSON.stringify(chrome.runtime.getManifest())', returnByValue: true }, s2)).result?.value;
      console.log('  after reload:', m2);
    }
  }
}
ws.close();
process.exit(0);
