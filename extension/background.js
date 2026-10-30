import './media-taxonomy.js';
import { mutate, remember, recordMedia, pageChanged } from './catalog.js';
import { groupResources, rootItems, groupName, ownsJob } from './resources.js';
import { acquireSource, releaseSource, sourceRedirect } from './source-fetch.js';
import { inspectHls } from './hls.js';
import { validateMp4File } from './vendor/mp4.js';
const { isXPost, filename, isDirect } = globalThis.VDR_TAXONOMY;
const terminal = new Set(['complete', 'failed', 'cancelled']);
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
  if (job?.lease !== undefined) await releaseSource(job.lease).catch(() => {});
  if (job?.kind === 'hls' || job?.viaFetch) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'release', id: job.id }).catch(() => {});
}

async function finishDownload(job) {
  const [download] = await chrome.downloads.search({ id: job.downloadId });
  if (download?.state === 'complete' || download?.state === 'interrupted') {
    // A server rejection may be a missing page Referer; browser downloads cannot
    // carry one, so retry through the offscreen fetch path exactly once.
    if (download.state === 'interrupted' && /^SERVER_/.test(download.error || '') && job.pageUrl && !job.viaFetch) {
      if (job.lease !== undefined) { await releaseSource(job.lease).catch(() => {}); job.lease = undefined; }
      job.viaFetch = true; job.state = 'fetching'; job.done = 0; job.total = 0;
      // Clear the stale download id: further deltas for it must not find this job.
      const abandonedId = job.downloadId;
      job.downloadId = undefined;
      // The rejected attempt would linger in the download shelf while the real
      // transfer continues in the background; remove its entry and partial file.
      if (abandonedId !== undefined) {
        chrome.downloads.removeFile(abandonedId).catch(() => {});
        chrome.downloads.erase({ id: abandonedId }).catch(() => {});
      }
      job.message = '浏览器下载被服务器拒绝，改用网页来源获取文件…';
      await saveJob(job);
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', job }).catch(() => null);
      if (result?.ok) return;
      job.viaFetch = false; job.state = 'failed'; job.message = '后台任务未能启动，请重新下载。';
      await saveJob(job); await release(job); return;
    }
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
    const base = groupName(group);
    // Image-note options are labelled 图片 N; keep the label in the saved name.
    const name = group.media?.image && item.name !== base ? `${base}-${item.name}` : base;
    const next = { id: crypto.randomUUID(), tabId, pageUrl, groupKey, url: selectedUrl || url, resourceUrl: url, name, kind: item.kind, mime: item.mime, audioUrl: selected?.audioUrl, requireAudio: selected?.requireAudio,
      filename: filename({ ...item, name }, item.kind === 'hls' ? '.ts' : null), state: item.kind === 'hls' ? 'queued' : 'inspecting',
      message: item.kind === 'hls' ? '等待 HLS 下载槽位；最多同时处理 3 个任务。' : '正在准备下载…', done: 0, total: 0 };
    await saveJob(next); starting.add(next.id); return next;
  });
  try {
    if (isDirect(job)) {
      // CDNs like bilivideo.com reject browser downloads without the page Referer.
      // Lease an exact-URL rule for validation and the whole download lifetime.
      try { job.lease = await acquireSource(job.url, job.pageUrl, { allTypes: true }); }
      catch { /* Page URL is not a web page; download without a source. */ }
      if (job.lease !== undefined) await saveJob(job);
      if (job.kind === 'file' && (/\.(mp4|m4v|mov)$/i.test(new URL(job.url).pathname) || /\/(mp4|quicktime)(?:;|$)/i.test(job.mime || ''))) {
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
    if (job.kind === 'hls' || job.viaFetch) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', id: job.id }).catch(() => {});
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
      const phases = { muxing: '正在合并音画并封装 MP4…', remuxing: '正在转为 MP4，不重新编码…', inspecting: '正在检查 HLS 清单…', fetching: '正在经网页来源获取文件…' };
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
        const job = (await readJobs()).find(job => job.id === message.id);
        if (!job || terminal.has(job.state) || job.kind !== 'hls' && !job.viaFetch) throw new Error('下载任务已停止。');
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
