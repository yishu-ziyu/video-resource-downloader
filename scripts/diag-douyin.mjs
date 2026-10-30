const target = process.argv[2];
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
const { sessionId } = await send('Target.attachToTarget', { targetId: target, flatten: true });
const result = await send('Runtime.evaluate', {
  expression: `(${async () => {
    const videos = [...document.querySelectorAll('video')].map(v => ({
      src: (v.currentSrc || v.src || '').slice(0, 60), duration: v.duration,
      readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
    }));
    const script = document.getElementById('RENDER_DATA');
    const out = { videos, hasRenderData: Boolean(script), awemes: [], error: null };
    if (script) {
      try {
        const data = JSON.parse(decodeURIComponent(script.textContent));
        const seen = new Set();
        const visit = node => {
          if (!node || typeof node !== 'object' || seen.has(node) || out.awemes.length > 15) return;
          seen.add(node);
          if (Array.isArray(node)) { for (const i of node) visit(i); return; }
          if (typeof node.awemeId === 'string' && node.video && typeof node.video === 'object') {
            const urls = new Set();
            const pull = v => {
              if (typeof v === 'string' && v.includes('/video/tos/')) urls.add(v);
              else if (Array.isArray(v)) v.forEach(pull);
              else if (v && typeof v === 'object') Object.values(v).forEach(pull);
            };
            for (const k of ['playAddr', 'playAddrH265', 'bitRateList', 'bitRateAudioList']) pull(node.video[k]);
            out.awemes.push({
              id: node.awemeId, duration: node.video.duration,
              title: (node.desc || '').slice(0, 40), urls: urls.size,
            });
          }
          for (const v of Object.values(node)) visit(v);
        };
        visit(data);
      } catch (e) { out.error = String(e); }
    }
    return JSON.stringify(out);
  }})()`,
  returnByValue: true, awaitPromise: true,
}, sessionId);
console.log(JSON.stringify(JSON.parse(result.result.value), null, 1));
ws.close();
process.exit(0);
