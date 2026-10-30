// 真实小红书验证：从发现页挑一条带播放标识的视频笔记，导航进去，读扩展存储。
const base = 'http://localhost:9222';
const extId = 'ddfmccldgbikkpihmnklndbhjjmdllgl';

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
const xhs = targetInfos.find(t => t.type === 'page' && t.url.includes('xiaohongshu.com'));
if (!xhs) { console.log('no xhs tab'); process.exit(1); }
const s = await attach(xhs.targetId);

// On the feed, pick the first note card marked as a video and navigate to it.
const link = await evalIn(s, `(() => {
  const a = [...document.querySelectorAll('section.note-item a[href*="/explore/"]')]
    .find(a => a.href.includes('xsec_token') && a.parentElement?.outerHTML?.includes('play'));
  return a ? a.href : null;
})()`);
console.log('note link:', link?.slice(0, 130));
if (!link) { await evalIn(s, `location.href='https://www.xiaohongshu.com/explore'`); await new Promise(r => setTimeout(r, 8000)); }
if (link) {
  await evalIn(s, `location.href = ${JSON.stringify(link)}`);
  await new Promise(r => setTimeout(r, 10000));
}
console.log('note:', await evalIn(s, `JSON.stringify({
  title: document.title.slice(0, 60), url: location.href.slice(0, 110),
  video: [...document.querySelectorAll('video')].map(v => ({ src: (v.currentSrc || '').slice(0, 60), duration: v.duration, w: v.videoWidth, h: v.videoHeight })).slice(0, 4),
})`));
// Play the video a moment so real media requests fire.
await evalIn(s, `(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } return 1; })()`);
await new Promise(r => setTimeout(r, 9000));

const wTargets = (await send('Target.getTargets')).targetInfos;
const worker = wTargets.find(t => t.type === 'service_worker' && t.url.includes(extId));
const wSession = await attach(worker.targetId);
const storage = await evalIn(wSession, `(async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.xiaohongshu.com/*' });
  const t = tabs.find(tab => tab.url.includes('explore/')) || tabs[0];
  if (!t) return 'no xhs tab';
  const data = await chrome.storage.session.get([('media:' + t.id), ('tab:' + t.id)]);
  return JSON.stringify({ tabId: t.id, tabUrl: t.url.slice(0, 110),
    media: data['media:' + t.id]?.map(p => ({ title: p.title?.slice(0, 50), duration: p.duration, urls: p.urls?.length, names: Object.keys(p.names || {}).length })),
    items: data['tab:' + t.id]?.map(i => ({ name: i.name?.slice(0, 45), kind: i.kind, matched: Boolean(i.media) })).slice(0, 15) }, null, 1);
})()`);
console.log(storage);
ws.close();
process.exit(0);
