import assert from 'node:assert/strict';
const moduleUrl = new URL('../extension/source-fetch.js', import.meta.url);
function stub(failures) {
  const rules = new Map(); let attempts = 0;
  globalThis.chrome = {
    runtime: { id: 'test-extension', getURL: p => `chrome-extension://test-extension/${p}` },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    webRequest: { onHeadersReceived: { addListener() {} } },
    declarativeNetRequest: { getSessionRules: async () => [...rules.values()], updateSessionRules: async ({addRules=[],removeRuleIds=[]}) => {
      if (removeRuleIds.length && attempts++ < failures) throw new Error('transient API failure');
      for(const id of removeRuleIds) rules.delete(id);
      for(const rule of addRules) rules.set(rule.id,rule);
    } },
  };
  return { rules, attempts: () => attempts };
}
const normal = stub(1);
const first = await import(moduleUrl.href + '?case=retry');
let id = await first.acquireSource('https://cdn.test/video.m3u8#ignored', 'https://page.test/private?token=secret');
const rule = normal.rules.get(id);
assert.equal(rule.action.requestHeaders[0].value, 'https://page.test/');
assert.equal(rule.condition.regexFilter.includes('ignored'), false);
await first.releaseSource(id);
assert.equal(normal.rules.size, 0); assert.equal(normal.attempts(), 2);
id = await first.acquireSource('https://cdn.test/video.m3u8', 'https://other.test/');
await first.releaseSource(id);
console.log('PASS source cleanup transient failure retries, removes the rule and unlocks');

const broken = stub(100);
const second = await import(moduleUrl.href + '?case=permanent');
id = await second.acquireSource('https://cdn.test/video.m3u8', 'https://page.test/');
await assert.rejects(second.releaseSource(id), /清理失败/);
assert.equal(broken.attempts(), 3); assert.equal(broken.rules.size, 1);
let timer;
try {
  await assert.rejects(Promise.race([
    second.acquireSource('https://cdn.test/video.m3u8', 'https://other.test/'),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('hung URL lock')), 100); }),
  ]), /清理失败/);
} finally { clearTimeout(timer); }
console.log('PASS source permanent cleanup failure fails closed without a hanging URL waiter');
