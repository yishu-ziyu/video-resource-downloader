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
const xhs = targetInfos.find(t => t.type === 'page' && t.url.includes('xiaohongshu.com/explore'));
if (!xhs) { console.log('no xhs tab'); process.exit(1); }
const s = await attach(xhs.targetId);
// Go back to feed first.
await evalIn(s, `location.href = 'https://www.xiaohongshu.com/explore'`);
await new Promise(r => setTimeout(r, 8000));
const out = await evalIn(s, `JSON.stringify([...document.querySelectorAll('section.note-item a[href]')].slice(0, 40).map(a => ({
  href: a.href.slice(0, 110),
  marks: a.parentElement?.outerHTML?.match(/play|视频|video/g)?.slice(0, 3) || [],
  hasVideo: Boolean(a.querySelector('video')),
})).filter(x => x.href.includes('explore')), null, 1)`);
console.log(out);
ws.close(); process.exit(0);
