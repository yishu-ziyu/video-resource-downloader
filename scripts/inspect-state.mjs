const EXT_ID = 'ddfmccldgbikkpihmnklndbhjjmdllgl';
const version = await (await fetch('http://localhost:9222/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const { targetInfos } = await send('Target.getTargets');
const worker = targetInfos.find(t => t.type === 'service_worker' && t.url.includes(EXT_ID));
const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
const evalJs = async expr => (await send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;
const result = await evalJs(`(async () => {
  const tabs = await chrome.tabs.query({});
  const dy = tabs.filter(t => (t.url || '').includes('douyin.com'));
  const out = [];
  for (const tab of dy) {
    const data = await chrome.storage.session.get(['tab:' + tab.id, 'media:' + tab.id]);
    const items = data['tab:' + tab.id] || [];
    const media = data['media:' + tab.id] || [];
    out.push({
      tabId: tab.id, url: tab.url.slice(0, 80),
      media: media.map(m => ({ title: (m.title || '').slice(0, 40), urls: m.urls?.length, duration: m.duration, key: m.key })),
      items: items.map(i => ({ name: i.name, source: i.source, kind: i.kind, size: i.size })),
    });
  }
  return JSON.stringify(out);
})()`);
console.log(JSON.stringify(JSON.parse(result), null, 1));
ws.close();
process.exit(0);
