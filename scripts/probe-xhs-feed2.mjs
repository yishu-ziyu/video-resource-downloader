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
let { targetInfos } = await send('Target.getTargets');
let xhs = targetInfos.find(t => t.type === 'page' && t.url.includes('xiaohongshu.com'));
if (!xhs) {
  const t = await send('Target.createTarget', { url: 'https://www.xiaohongshu.com/explore' });
  await new Promise(r => setTimeout(r, 10000));
  targetInfos = (await send('Target.getTargets')).targetInfos;
  xhs = targetInfos.find(t => t.targetId === t.targetId && t.type === 'page' && t.url.includes('xiaohongshu.com'));
  xhs = targetInfos.find(x => x.targetId === t.targetId) || targetInfos.find(x => x.type === 'page' && x.url.includes('xiaohongshu.com'));
}
const s = await attach(xhs.targetId);
console.log(await evalIn(s, `(() => {
  const secs = [...document.querySelectorAll('section.note-item')].slice(0, 30);
  return JSON.stringify(secs.map(sec => {
    const a = sec.querySelector('a[href*="/explore/"], a[href*="/search_result/"]');
    const icons = [...sec.querySelectorAll('[class]')].map(e => e.getAttribute('class')).filter(c => /play|video/i.test(c)).slice(0, 5);
    return { href: a?.href?.slice(0, 105), icons };
  }).filter(x => x.href), null, 1);
})()`));
ws.close(); process.exit(0);
