// 标签页目录：拥有 tab:N 资源与 media:N 播放器的存储、页面 epoch 生命周期、
// webRequest 观察与标签升级。所有会话存储的读写都经同一个 mutate 队列串行，
// background.js 的任务引擎 import 同一队列来与网络/弹窗事件互斥。
import './media-taxonomy.js';
import { matchMedia } from './resources.js';
const { isXPost, assetKey, kindOf, mimeHintOf, resourceName } = globalThis.VDR_TAXONOMY;

let mutations = Promise.resolve();
const pages = new Map();
const requestEpochs = new Map();

// Serialize read/modify/write operations across network, popup and download events.
export function mutate(fn) {
  const result = mutations.then(fn);
  mutations = result.catch(error => console.error(error));
  return result;
}

function httpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

// Labels from page data: mirrors and signed variants share one path.
function pageNamesOf(players) {
  const pageNames = new Map();
  for (const player of players) for (const [url, name] of Object.entries(player.names || {})) {
    pageNames.set(url, name);
    try { pageNames.set(new URL(url).pathname, name); } catch {}
  }
  return pageNames;
}
// A request can arrive before page data; upgrade the fallback label later.
function upgradeName(item, pageNames) {
  const pageName = pageNames.get(item.url) ?? pageNames.get(pathnameOf(item.url));
  if (pageName && item.name === resourceName(item.url)) item.name = pageName;
}
function pathnameOf(url) {
  try { return new URL(url).pathname; } catch { return ''; }
}

export function remember(tabId, url, mime = '', source = '网络请求', request = { epoch: pages.get(tabId)?.epoch || 0 }, size = 0) {
  if (tabId < 0 || !httpUrl(url)) return;
  mime ||= mimeHintOf(url);
  const kind = kindOf(url, mime) || (source === '页面播放器' ? 'file' : null);
  // Skip icons, sprites and tracking pixels; keep images of unknown size.
  if (!kind || kind === 'image' && size > 0 && size < 30720) return;
  void mutate(async () => {
    if (request.epoch !== (pages.get(tabId)?.epoch || 0)) return;
    // Ignore late requests from tabs that have already been closed.
    let current;
    try { current = await chrome.tabs.get(tabId); } catch { return; }
    if (request.pageUrl && request.pageUrl !== current.url.split('#')[0]) return;
    const key = `tab:${tabId}`;
    const data = await chrome.storage.session.get([key, `media:${tabId}`]);
    const players = data[`media:${tabId}`] || [];
    if (isXPost(current.url) &&
      assetKey(url) && players.some(player => assetKey(player.poster)) && !matchMedia({ url }, players)) return;
    const items = data[key] || [];
    const pageNames = pageNamesOf(players);
    const existing = items.find(item => item.url === url);
    if (existing) {
      existing.mime = mime || existing.mime; existing.kind = kind;
      upgradeName(existing, pageNames);
    } else items.push({ url, name: pageNames.get(url) ?? pageNames.get(pathnameOf(url)) ?? resourceName(url), mime, kind, source });
    const item = existing || items[items.length - 1];
    if (kind !== 'hls' && kind !== 'dash' && size > 0) item.size = size;
    item.pageUrl = current.url;
    item.media = matchMedia(item, data[`media:${tabId}`] || []);
    const bounded = items.slice(-100);
    await chrome.storage.session.set({ [key]: bounded });
    await chrome.action.setBadgeText({ tabId, text: String(bounded.length) }).catch(() => {});
  });
}

export async function recordMedia(sender, values, pageUrl) {
  const tabId = sender.tab.id;
  const epoch = pages.get(tabId)?.epoch || 0;
  const mediaKey = `media:${tabId}`;
  const players = (Array.isArray(values) ? values : []).slice(0, 100)
    .filter(player => typeof player.id === 'string')
    .map(player => ({ id: player.id.slice(0, 80), frameId: sender.frameId || 0,
      key: `${sender.frameId || 0}:${player.id.slice(0, 80)}`,
      title: String(player.title || '网页视频').slice(0, 180),
      poster: httpUrl(player.poster) ? player.poster.slice(0, 8192) : '',
      // Page-provided track labels keyed by address; mirrors share one label.
      names: Object.fromEntries(Object.entries(player.names || {})
        .filter(([url, name]) => httpUrl(url) && typeof name === 'string')
        .slice(0, 40).map(([url, name]) => [url.slice(0, 8192), name.slice(0, 60)])),
      urls: (Array.isArray(player.urls) ? player.urls : []).filter(httpUrl).slice(0, 40),
      image: player.image === true,
      duration: Number.isFinite(player.duration) && player.duration >= 0 ? player.duration : null,
      width: Number.isFinite(player.width) ? player.width : 0,
      height: Number.isFinite(player.height) ? player.height : 0 }));
  const accepted = await mutate(async () => {
    if (epoch !== (pages.get(tabId)?.epoch || 0)) return false;
    const current = await chrome.tabs.get(tabId);
    if (current.url !== sender.tab.url) return false;
    if (sender.frameId === 0 && pageUrl !== current.url) return false;
    const data = await chrome.storage.session.get([mediaKey, `tab:${tabId}`]);
    const all = [...(data[mediaKey] || []).filter(player => player.frameId !== (sender.frameId || 0)), ...players].slice(-100);
    let items = data[`tab:${tabId}`] || [];
    if (isXPost(current.url) &&
      all.some(player => assetKey(player.poster))) {
      items = items.filter(item => !assetKey(item.url) || matchMedia(item, all));
    }
    // Labels can arrive after the first requests; upgrade fallback names.
    const pageNames = pageNamesOf(all);
    for (const item of items) {
      item.media = matchMedia(item, all);
      if (item.media) item.pageUrl = current.url;
      upgradeName(item, pageNames);
    }
    await chrome.storage.session.set({ [mediaKey]: all, [`tab:${tabId}`]: items });
    return true;
  });
  // Image-note players inject their URLs with an image hint so items get the
  // image kind (and preview) even before the page's own requests are observed.
  if (accepted) for (const player of players) for (const url of player.urls)
    remember(tabId, url, player.image ? 'image/*' : '', '页面播放器', { epoch });
  return { ok: true };
}

function clearPage(tabId, url) {
  pages.set(tabId, { url, epoch: (pages.get(tabId)?.epoch || 0) + 1 });
  return mutate(async () => {
    await chrome.storage.session.remove([`tab:${tabId}`, `media:${tabId}`]);
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  });
}
export function pageChanged(sender, pageUrl) {
  if (sender.frameId !== 0 || pageUrl !== sender.tab.url) return;
  if (!pages.has(sender.tab.id)) { pages.set(sender.tab.id, { url: pageUrl, epoch: 0 }); return; }
  if (pages.get(sender.tab.id)?.url !== pageUrl) void clearPage(sender.tab.id, pageUrl);
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  if (details.type === 'main_frame') void clearPage(details.tabId, details.url);
  requestEpochs.set(details.requestId, { epoch: pages.get(details.tabId)?.epoch || 0 });
}, { urls: ['http://*/*', 'https://*/*'] });

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  const request = requestEpochs.get(details.requestId);
  if (!request || request.epoch !== (pages.get(details.tabId)?.epoch || 0)) return;
  const header = name => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
  // Players usually fetch ranges; the full size is after the slash in Content-Range.
  const size = details.statusCode === 206 ? Number(header('content-range').split('/')[1]) : Number(header('content-length'));
  remember(details.tabId, details.url, header('content-type'), '网络请求', request, Number.isSafeInteger(size) ? size : 0);
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  const request = requestEpochs.get(details.requestId);
  if (!request || details.frameId !== 0 || !kindOf(details.url)) return;
  const referer = details.requestHeaders?.find(header => header.name.toLowerCase() === 'referer')?.value;
  if (!httpUrl(referer)) return;
  const source = new URL(referer);
  // Cross-origin requests often disclose only an origin, not a document URL.
  // Do not guess the route in that case. Only read Referer; never copy headers.
  if (source.origin === new URL(details.url).origin || source.pathname !== '/' || source.search) request.pageUrl = source.href.split('#')[0];
}, { urls: ['http://*/*', 'https://*/*'] }, ['requestHeaders', 'extraHeaders']);

for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) {
  event.addListener(details => requestEpochs.delete(details.requestId), { urls: ['http://*/*', 'https://*/*'] });
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Full loads were already cleared at main_frame request start. Clearing again
  // at commit could discard resources the new document has already requested.
  if (!change.url || pages.get(tabId)?.url === change.url) return;
  void clearPage(tabId, change.url).then(() => chrome.tabs.sendMessage(tabId, { type: 'page-changed' }).catch(() => {}));
});

chrome.tabs.onRemoved.addListener(tabId => {
  pages.delete(tabId);
  void mutate(() => chrome.storage.session.remove([`tab:${tabId}`, `media:${tabId}`, `notice:${tabId}`]));
});
