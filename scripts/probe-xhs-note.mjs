const base = 'http://localhost:9222';
const version = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let seq = 0;
const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, msg => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const attach = async t => (await send('Target.attachToTarget', { targetId: t, flatten: true })).sessionId;
const evalIn = async (s, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result?.value;
const { targetInfos } = await send('Target.getTargets');
const xhs = targetInfos.find(t => t.type === 'page' && t.url.includes('xiaohongshu.com/explore/'));
if (!xhs) { console.log('no xhs note tab'); process.exit(1); }
const s = await attach(xhs.targetId);
console.log(await evalIn(s, `JSON.stringify({
  title: document.title.slice(0, 60),
  type: (() => { try { const m = window.__INITIAL_STATE__?.note?.noteDetailMap; const n = Object.values(m || {})[0]?.note; return { type: n?.type, hasVideo: Boolean(n?.video), mediaKeys: n?.video ? Object.keys(n.video.media?.stream || {}) : [], title: n?.title?.slice(0, 40) }; } catch (e) { return 'ERR ' + e.message; } })(),
  videos: document.querySelectorAll('video').length,
  iframes: [...document.querySelectorAll('iframe')].map(f => f.src?.slice(0, 80)),
  shadowHosts: [...document.querySelectorAll('*')].filter(el => el.shadowRoot).map(el => el.tagName).slice(0, 8),
}, null, 1)`));
ws.close(); process.exit(0);
