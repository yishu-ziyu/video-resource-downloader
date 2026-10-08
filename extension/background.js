import { matchMedia, groupResources, assetKey, isXPost, rootItems, groupName, ownsJob } from './resources.js';
import { acquireSource, releaseSource, sourceRedirect } from './source-fetch.js';
import { inspectHls } from './hls.js';
import { validateMp4File } from './vendor/mp4.js';
const terminal = new Set(['complete', 'failed', 'cancelled']);
let mutations = Promise.resolve();
let creating;
const validations = new Map();
const starting = new Set();
// Keep every active task and the latest 100 finished tasks for this browser session.
async function readJobs() {
  const { jobs, job } = await chrome.storage.session.get(['jobs', 'job']);
  return jobs || (job ? [job] : []);
}
async function saveJob(job) {
  const jobs = await readJobs();
  const index = jobs.findIndex(current => current.id === job.id);
  if (index < 0) jobs.push(job); else jobs[index] = job;
  const finished = jobs.filter(current => terminal.has(current.state)).slice(-100);
  const keep = new Set(finished.map(current => current.id));
  await chrome.storage.session.set({ jobs: jobs.filter(current => !terminal.has(current.state) || keep.has(current.id)) });
  await chrome.storage.session.remove('job'); // Migrate the previous single-task session format.
}
const pages = new Map();
const requestEpochs = new Map();

// Serialize read/modify/write operations across network, popup and download events.
function mutate(fn) {
  const result = mutations.then(fn);
  mutations = result.catch(error => console.error(error));
  return result;
}

function httpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function classify(url, mime = '') {
  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname.toLowerCase();
  if (parsedUrl.hostname === 'video.twimg.com' && /^\/(?:amplify_video|ext_tw_video)\/\d+\/(?:pu\/)?(?:aud\/|vid\/(?:avc1|hevc)\/0\/0\/|pl\/(?:mp4a|avc1|hevc|s\d+)\/)/.test(pathname)) return null;
  if (/\.(ts|m4s|aac|key)$/.test(pathname) || /mp2t|iso.segment/.test(mime)) return null;
  if (/\.m3u8$/.test(pathname) || /mpegurl/i.test(mime)) return 'hls';
  if (/\.mpd$/.test(pathname) || /dash\+xml/i.test(mime)) return 'dash';
  if (/\.(mp4|webm|mov|mkv|m4v|ogv)$/.test(pathname) || /^video\//i.test(mime)) return 'file';
  return null;
}

function resourceName(url) {
  const pathname = new URL(url).pathname;
  try { return decodeURIComponent(pathname.split('/').pop()) || 'video'; }
  catch { return pathname.split('/').pop() || 'video'; }
}

function filename(item, extension) {
  let name = item.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'video';
  const sourceSuffix = new URL(item.url).pathname.match(/\.(mp4|webm|mov|mkv|m4v|ogv)$/i)?.[0];
  const suffix = extension || sourceSuffix || (/webm/i.test(item.mime) ? '.webm' : /quicktime/i.test(item.mime) ? '.mov' :
    /matroska/i.test(item.mime) ? '.mkv' : /ogg/i.test(item.mime) ? '.ogv' : /mp4/i.test(item.mime) ? '.mp4' : '.bin');
  name = name.replace(/\.(mp4|webm|mov|mkv|m4v|ogv|ts|m3u8|bin)$/i, '') + suffix;
  return `VideoDownloads/${name}`;
}

function remember(tabId, url, mime = '', source = '网络请求', request = { epoch: pages.get(tabId)?.epoch || 0 }, size = 0) {
  if (tabId < 0 || !httpUrl(url)) return;
  const kind = classify(url, mime) || (source === '页面播放器' ? 'file' : null);
  if (!kind) return;
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
    const existing = items.find(item => item.url === url);
    if (existing) { existing.mime = mime || existing.mime; existing.kind = kind; }
    else items.push({ url, name: resourceName(url), mime, kind, source });
    const item = existing || items[items.length - 1];
    if (kind === 'file' && size > 0) item.size = size;
    item.pageUrl = current.url;
    item.media = matchMedia(item, data[`media:${tabId}`] || []);
    const bounded = items.slice(-100);
    await chrome.storage.session.set({ [key]: bounded });
    await chrome.action.setBadgeText({ tabId, text: String(bounded.length) }).catch(() => {});
  });
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  const request = requestEpochs.get(details.requestId);
  if (!request || request.epoch !== (pages.get(details.tabId)?.epoch || 0)) return;
  const header = name => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
  // Players usually fetch ranges; the full size is after the slash in Content-Range.
  const size = details.statusCode === 206 ? Number(header('content-range').split('/')[1]) : Number(header('content-length'));
  remember(details.tabId, details.url, header('content-type'), '网络请求', request, Number.isSafeInteger(size) ? size : 0);
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

async function recordMedia(sender, values, pageUrl) {
  const tabId = sender.tab.id;
  const epoch = pages.get(tabId)?.epoch || 0;
  const mediaKey = `media:${tabId}`;
  const players = (Array.isArray(values) ? values : []).slice(0, 100)
    .filter(player => typeof player.id === 'string')
    .map(player => ({ id: player.id.slice(0, 80), frameId: sender.frameId || 0,
      key: `${sender.frameId || 0}:${player.id.slice(0, 80)}`,
      title: String(player.title || '网页视频').slice(0, 180),
      poster: httpUrl(player.poster) ? player.poster.slice(0, 8192) : '',
      urls: (Array.isArray(player.urls) ? player.urls : []).filter(httpUrl).slice(0, 20),
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
    for (const item of items) {
      item.media = matchMedia(item, all);
      if (item.media) item.pageUrl = current.url;
    }
    await chrome.storage.session.set({ [mediaKey]: all, [`tab:${tabId}`]: items });
    return true;
  });
  if (accepted) for (const player of players) for (const url of player.urls) remember(tabId, url, '', '页面播放器', { epoch });
  return { ok: true };
}

function clearPage(tabId, url) {
  pages.set(tabId, { url, epoch: (pages.get(tabId)?.epoch || 0) + 1 });
  return mutate(async () => {
    await chrome.storage.session.remove([`tab:${tabId}`, `media:${tabId}`]);
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  });
}
function pageChanged(sender, pageUrl) {
  if (sender.frameId !== 0 || pageUrl !== sender.tab.url) return;
  if (!pages.has(sender.tab.id)) { pages.set(sender.tab.id, { url: pageUrl, epoch: 0 }); return; }
  if (pages.get(sender.tab.id)?.url !== pageUrl) void clearPage(sender.tab.id, pageUrl);
}
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  if (details.type === 'main_frame') void clearPage(details.tabId, details.url);
  requestEpochs.set(details.requestId, { epoch: pages.get(details.tabId)?.epoch || 0 });
}, { urls: ['http://*/*', 'https://*/*'] });
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  const request = requestEpochs.get(details.requestId);
  if (!request || details.frameId !== 0 || !classify(details.url)) return;
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

async function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'], justification: '组装 HLS 片段并管理下载文件的 Blob URL。',
    });
  })();
  try { await creating; } finally { creating = null; }
}

async function release(job) {
  if (job.kind === 'hls') await chrome.runtime.sendMessage({ target: 'offscreen', type: 'release', id: job.id }).catch(() => {});
}

async function finishDownload(job) {
  const [download] = await chrome.downloads.search({ id: job.downloadId });
  if (download?.state === 'complete' || download?.state === 'interrupted') {
    job.state = download.state === 'complete' ? 'complete' : 'failed';
    job.bytes = download.bytesReceived; job.totalBytes = download.totalBytes;
    job.savedName = download.filename.split(/[\\/]/).pop();
    job.message = download.state === 'complete' ? `${job.note ? `${job.note}文件：` : '已保存：'}${job.savedName}` : `下载中断：${download.error || '请检查浏览器下载列表'}`;
    await saveJob(job);
    await release(job);
  }
}

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state) return;
  void mutate(async () => {
    const job = (await readJobs()).find(job => job.downloadId === delta.id);
    if (job && !terminal.has(job.state)) await finishDownload(job);
  });
});

async function start(tabId, url, selectedUrl) {
  const job = await mutate(async () => {
    const data = await chrome.storage.session.get(`tab:${tabId}`);
    const item = (data[`tab:${tabId}`] || []).find(item => item.url === url);
    if (!item) throw new Error('资源已失效，请刷新页面并重新播放。');
    const pageUrl = (await chrome.tabs.get(tabId)).url;
    if (item.pageUrl && item.pageUrl !== pageUrl) throw new Error('资源属于上一页面，请重新播放当前视频后再下载。');
    if (isXPost(pageUrl) && !item.media) throw new Error('尚未确认对应当前帖子的视频。请先播放当前视频，等待封面和标题匹配后再下载。');
    if (item.kind === 'dash') throw new Error('暂不支持 DASH 下载。');
    if (selectedUrl && !item.variants?.some(variant => variant.url === selectedUrl)) throw new Error('清晰度已失效，请重新读取。');
    const group = groupResources(data[`tab:${tabId}`] || []).find(group => group.items.includes(item));
    const groupKey = group.key;
    if ((await readJobs()).some(job => job.tabId === tabId && job.pageUrl === pageUrl && !terminal.has(job.state) &&
      ownsJob(group, job))) throw new Error('这个视频已有下载任务，请勿重复下载。');
    const selected = item.variants?.find(variant => variant.url === selectedUrl);
    const name = groupName(group);
    const next = { id: crypto.randomUUID(), tabId, pageUrl, groupKey, url: selectedUrl || url, resourceUrl: url, name, kind: item.kind, mime: item.mime, audioUrl: selected?.audioUrl, requireAudio: selected?.requireAudio,
      filename: filename({ ...item, name }, item.kind === 'hls' ? '.ts' : null), state: item.kind === 'hls' ? 'queued' : 'inspecting',
      message: item.kind === 'hls' ? '等待 HLS 下载槽位；最多同时处理 3 个任务。' : '正在准备下载…', done: 0, total: 0 };
    await saveJob(next); starting.add(next.id); return next;
  });
  try {
    if (job.kind === 'file') {
      if (/\.(mp4|m4v|mov)$/i.test(new URL(job.url).pathname) || /\/(mp4|quicktime)(?:;|$)/i.test(job.mime || '')) {
        const controller = new AbortController(); validations.set(job.id, controller);
        try { await validateMp4File(job.url, controller.signal); }
        finally { validations.delete(job.id); }
      }
      await mutate(async () => {
        const current = (await readJobs()).find(current => current.id === job.id);
        if (!current || terminal.has(current.state)) return;
        // State check and dispatch are one mutation, so cancel cannot precede a late start.
        const downloadId = await chrome.downloads.download({ url: job.url, filename: job.filename, conflictAction: 'uniquify' });
        Object.assign(current, { downloadId, state: 'saving', message: '浏览器正在保存文件…' });
        await saveJob(current); await finishDownload(current);
      });
    } else {
      await ensureOffscreen();
      await mutate(async () => {
        const current = (await readJobs()).find(current => current.id === job.id);
        if (!current || terminal.has(current.state)) return;
        const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', job });
        if (!result?.ok) throw new Error('后台任务未能启动，请重新下载。');
      });
    }
  } catch (error) { await fail(job.id, error.message); }
  finally { starting.delete(job.id); }
  return { ok: true };
}

async function inspect(tabId, url) {
  const key = `tab:${tabId}`;
  const data = await chrome.storage.session.get(key);
  if (!(data[key] || []).some(item => item.url === url && item.kind === 'hls')) throw new Error('资源已失效，请重新播放。');
  let inspected;
  let error;
  try { inspected = await inspectHls(url, undefined, (await chrome.tabs.get(tabId)).url); } catch (failure) { error = failure.message; }
  await mutate(async () => {
    const latest = await chrome.storage.session.get(key);
    const item = (latest[key] || []).find(item => item.url === url);
    if (!item) return;
    item.variants = inspected?.variants || [];
    item.format = inspected?.format;
    item.inspected = true;
    item.inspectionError = error || '';
    await chrome.storage.session.set(latest);
  });
  return { ok: true };
}

async function rename(tabId, url, name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('请输入文件名。');
  return mutate(async () => {
    const key = `tab:${tabId}`;
    const data = await chrome.storage.session.get(key);
    const group = groupResources(data[key] || []).find(group => group.items.some(item => item.url === url));
    if (!group) throw new Error('资源已失效，请重新播放。');
    for (const item of group.items) item.displayName = name.trim().slice(0, 120);
    await chrome.storage.session.set(data);
    return { ok: true };
  });
}

async function fail(id, message) {
  await mutate(async () => {
    const job = (await readJobs()).find(job => job.id === id);
    if (!job || terminal.has(job.state)) return;
    job.state = 'failed'; job.message = message;
    await saveJob(job); await release(job);
  });
}

async function cancel(id) {
  return mutate(async () => {
    if (typeof id !== 'string') throw new Error('请指定要取消的下载任务。');
    const job = (await readJobs()).find(job => job.id === id);
    if (!job || terminal.has(job.state)) return { ok: true };
    validations.get(job.id)?.abort();
    if (job.downloadId !== undefined) await chrome.downloads.cancel(job.downloadId).catch(() => {});
    if (job.kind === 'hls') await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', id: job.id }).catch(() => {});
    job.state = 'cancelled'; job.message = '已取消。未保存不完整文件。';
    await saveJob(job); await release(job); return { ok: true };
  });
}

async function offscreenEvent(message) {
  if (message.type === 'failed') { await fail(message.id, message.message); return { ok: true }; }
  return mutate(async () => {
    const job = (await readJobs()).find(job => job.id === message.id);
    if (!job || terminal.has(job.state)) {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', id: message.id }).catch(() => {});
      await release({ ...job, id: message.id, kind: 'hls' }); return { ok: true };
    }
    if (message.type === 'progress') {
      const phases = { muxing: '正在合并音画并封装 MP4…', remuxing: '正在转为 MP4，不重新编码…', inspecting: '正在检查 HLS 清单…' };
      Object.assign(job, { state: ['muxing', 'remuxing'].includes(message.phase) ? 'muxing' : message.phase === 'inspecting' ? 'inspecting' : 'fetching', done: message.done, total: message.total, bytes: message.bytes ?? job.bytes,
        message: phases[message.phase] || `正在下载片段 ${message.done} / ${message.total}` });
      await saveJob(job);
    } else if (message.type === 'ready') {
      if (!message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) throw new Error('无效的文件来源。');
      job.filename = job.filename.replace(/\.ts$/, message.format === 'MP4' ? '.mp4' : '.ts');
      if (message.note) job.note = String(message.note);
      job.downloadId = await chrome.downloads.download({ url: message.url, filename: job.filename, conflictAction: 'uniquify' });
      job.state = 'saving'; job.message = '片段已组装，浏览器正在保存文件…';
      await saveJob(job); await finishDownload(job);
    }
    return { ok: true };
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // Recreate on install and update so an existing menu never raises a duplicate-id error.
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create(
    { id: 'download-video', title: '用视频资源下载器下载这个视频', contexts: ['video'] }, () => void chrome.runtime.lastError));
});
// Download the right-clicked video with the popup's default choice, then open the popup to show the result.
async function downloadFromMenu(info, tab) {
  if (info.menuItemId !== 'download-video' || !(tab?.id >= 0)) return;
  const tabId = tab.id, frameId = info.frameId || 0;
  let text = '';
  try {
    const target = await chrome.tabs.sendMessage(tabId, { type: 'context-target' }, { frameId }).catch(() => null);
    const items = (await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || [];
    const group = target?.id && groupResources(items).find(group => group.media?.key === `${frameId}:${target.id}`);
    if (!group) throw new Error(items.length ? '没能确认哪个资源属于这个视频。请在弹窗的资源列表里选择下载。' :
      '这个视频还没有可下载的地址。先播放几秒，再右键下载。');
    const item = rootItems(group).find(item => item.kind !== 'dash');
    if (!item) throw new Error('这个视频的格式暂不支持下载。');
    await start(tabId, item.url);
  } catch (error) { text = error.message; }
  await chrome.storage.session.set({ [`notice:${tabId}`]: { text, at: Date.now() } });
  await chrome.action.openPopup?.().catch(() => {});
}
chrome.contextMenus.onClicked.addListener((info, tab) => void downloadFromMenu(info, tab));
// E2E tests cannot click a native context menu, so they call the same handler.
globalThis.downloadFromMenu = downloadFromMenu;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === 'offscreen') return;
  if (message.type === 'page' && sender.tab && sender.id === chrome.runtime.id) {
    pageChanged(sender, message.pageUrl);
    respond({ ok: true }); return;
  }
  if (message.type === 'media' && sender.tab && sender.id === chrome.runtime.id) {
    pageChanged(sender, message.pageUrl);
    recordMedia(sender, message.players, message.pageUrl).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'resource' && sender.tab) {
    for (const url of (message.urls || []).slice(0, 100)) remember(sender.tab.id, url, '', '页面播放器');
    respond({ ok: true }); return;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  let task;
  if (sender.url === chrome.runtime.getURL('offscreen.html')) {
    if (message.type === 'source-acquire') {
      task = (async () => {
        const job = (await readJobs()).find(job => job.id === message.id && job.kind === 'hls');
        if (!job || terminal.has(job.state)) throw new Error('下载任务已停止。');
        return { ok: true, lease: await acquireSource(message.url, job.pageUrl) };
      })();
    } else if (message.type === 'source-redirect') {
      task = Promise.resolve({ ok: true, redirect: sourceRedirect(message.lease) });
    } else if (message.type === 'source-release') {
      task = releaseSource(message.lease).then(() => ({ ok: true }));
    } else task = offscreenEvent(message).catch(async error => { await fail(message.id, error.message); return { ok: false }; });
  } else if (message.type === 'start') task = start(message.tabId, message.url, message.selectedUrl);
  else if (message.type === 'inspect') task = inspect(message.tabId, message.url);
  else if (message.type === 'rename') task = rename(message.tabId, message.url, message.name);
  else if (message.type === 'cancel') task = cancel(message.id);
  else if (message.type === 'reconcile') task = mutate(async () => {
    const jobs = await readJobs();
    await chrome.storage.session.set({ jobs });
    await chrome.storage.session.remove('job');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    const running = contexts.length ? await chrome.runtime.sendMessage({ target: 'offscreen', type: 'list' }).catch(() => null) : null;
    for (const job of jobs) {
      if (terminal.has(job.state) || starting.has(job.id)) continue;
      if (job.downloadId !== undefined) await finishDownload(job);
      else if (!validations.has(job.id) && !running?.ids?.includes(job.id)) {
        job.state = 'failed'; job.message = '后台任务已停止，请重新下载。';
        await saveJob(job);
      }
    }
    return { ok: true };
  });
  if (!task) return;
  task.then(respond, error => respond({ ok: false, error: error.message })); return true;
});
