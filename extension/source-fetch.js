// A short-lived, exact-URL Referer rule. No Cookie, Authorization or Origin changes.
const RULE_BASE = 1000000;
let nextRule = RULE_BASE;
let initialized;
let operations = Promise.resolve();
function change(fn) {
  const result = operations.then(fn); operations = result.catch(() => {}); return result;
}
const locks = new Map();
const leases = new Map();

function ready() {
  if (!initialized) initialized = (async () => {
    if (!chrome.declarativeNetRequest) throw new Error('请重新加载新版插件，启用视频来源适配权限。');
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const { sourceRuleNext = RULE_BASE } = await chrome.storage.session.get('sourceRuleNext');
    nextRule = Math.max(sourceRuleNext, RULE_BASE, ...rules.filter(rule => rule.id >= RULE_BASE).map(rule => rule.id + 1));
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.filter(rule => rule.id >= RULE_BASE).map(rule => rule.id) });
    // Fetch hides manual redirect headers. Read only Location for a leased request.
    chrome.webRequest.onHeadersReceived.addListener(details => {
      if (details.initiator !== chrome.runtime.getURL('').slice(0, -1) || details.statusCode < 300 || details.statusCode >= 400) return;
      const lease = [...leases.values()].find(lease => lease.url === details.url);
      const location = details.responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
      if (lease && location) lease.redirect = new URL(location, details.url).href;
    }, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
  })();
  return initialized;
}
export async function acquireSource(url, pageUrl) {
  const target = new URL(url), page = new URL(pageUrl);
  if (![target, page].every(value => ['http:', 'https:'].includes(value.protocol))) throw new Error('视频来源必须是 HTTP 网页。');
  if (page.protocol === 'https:' && target.protocol === 'http:') throw new Error('不会向未加密地址发送 HTTPS 网页来源。');
  target.hash = ''; url = target.href;
  // Two pages can use the same media URL. Serialize its headers, not all downloads.
  const previous = locks.get(url) || Promise.resolve();
  let unlock, rejectLock;
  const held = new Promise((resolve, reject) => { unlock = resolve; rejectLock = reject; });
  const tail = previous.then(() => held);
  tail.catch(() => {}); // A failed cleanup blocks this URL with an explicit error.
  locks.set(url, tail);
  await previous;
  const finish = () => { if (locks.get(url) === tail) locks.delete(url); unlock(); };
  try {
    await ready();
    const regexFilter = '^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    const id = await change(async () => {
      const id = nextRule++;
      await chrome.storage.session.set({ sourceRuleNext: nextRule });
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: page.origin + '/' }] },
        condition: { regexFilter, isUrlFilterCaseSensitive: true, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
      }] });
      return id;
    });
    leases.set(id, { finish, url, poison: rejectLock });
    return id;
  } catch (error) { finish(); throw error; }
}
export async function releaseSource(id) {
  const lease = leases.get(id);
  if (!lease) return;
  for (let attempt = 0; ; attempt++) {
    try { await change(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] })); break; }
    catch {
      if (attempt === 2) {
        const error = new Error('视频来源规则清理失败，已停止该地址的请求。请重新加载插件后重试。');
        lease.poison(error); throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  leases.delete(id); lease.finish();
}

export function sourceRedirect(id) { return leases.get(id)?.redirect; }

async function fetchOnce(url, init, source) {
  const remote = typeof document !== 'undefined'; // Offscreen only exposes chrome.runtime.
  const acquire = remote ? chrome.runtime.sendMessage({ type: 'source-acquire', id: source.jobId, url }).then(result => {
    if (!result?.ok) throw new Error(result?.error || '无法设置视频网页来源。');
    return result.lease;
  }) : acquireSource(url, source.pageUrl);
  const release = id => remote ? chrome.runtime.sendMessage({ type: 'source-release', lease: id }).then(result => {
    if (!result?.ok) throw new Error(result?.error || '无法清理视频来源规则。');
  }) : releaseSource(id);
  const signal = init?.signal;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  let lease, response;
  try {
    lease = await Promise.race([acquire, cancelled]);
    signal?.throwIfAborted();
    response = await fetch(url, { ...init, redirect: 'manual' });
    const redirect = response.type === 'opaqueredirect' ? remote ?
      (await chrome.runtime.sendMessage({ type: 'source-redirect', lease })).redirect : sourceRedirect(lease) : undefined;
    if (response.type === 'opaqueredirect' && !redirect) throw new Error('无法确认视频重定向地址，已停止请求。');
    return { response, redirect };
  } catch (error) {
    // A cancelled waiter never fetches; release its eventual lease as well.
    if (lease === undefined) void acquire.then(release).catch(console.error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (lease !== undefined) {
      try { await release(lease); }
      catch (error) { await response?.body?.cancel().catch(() => {}); throw error; }
    }
  }
}

export async function sourceFetch(url, init, source = {}) {
  if (!source.pageUrl && !source.jobId) return fetch(url, init);
  const visited = new Set();
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url); target.hash = ''; url = target.href;
    if (visited.has(url)) throw new Error('视频请求重定向循环，已停止请求。');
    visited.add(url);
    const { response, redirect } = await fetchOnce(url, init, source);
    if (!redirect) return response;
    await response.body?.cancel(); url = redirect;
  }
  throw new Error('视频请求重定向超过 5 次，已停止请求。');
}
