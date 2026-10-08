import { downloadHls } from './hls.js';
const tasks = new Map();
const pending = new Map();
const MAX_CONCURRENT_HLS = 3;
const blobs = new Map();
const files = new Map();
// On a new offscreen lifetime, remove only this downloader's abandoned files.
const directory = (async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('hls-downloads', { create: true });
  for await (const name of dir.keys()) await dir.removeEntry(name);
  return dir;
})();
// Avoid an unhandled rejection; a TS task still receives the original failure.
directory.catch(() => {});
// A TS task owns its downloaded .ts and, while remuxing, a .mp4 beside it.
async function createFile(id, extension) {
  const dir = await directory;
  const name = `${id}${extension}`;
  const handle = await dir.getFileHandle(name, { create: true });
  const file = { handle, async remove() {
    await file.writer?.abort().catch(() => {});
    await dir.removeEntry(name).catch(error => { if (error.name !== 'NotFoundError') throw error; });
    files.set(id, (files.get(id) || []).filter(other => other !== file));
  } };
  files.set(id, [...(files.get(id) || []), file]);
  file.writer = await handle.createWritable();
  return file;
}
async function release(id) {
  if (blobs.has(id)) { URL.revokeObjectURL(blobs.get(id)); blobs.delete(id); }
  const results = await Promise.allSettled((files.get(id) || []).map(file => file.remove()));
  files.delete(id);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
const send = message => chrome.runtime.sendMessage(message);

async function run(job, controller) {
  try {
    await send({ type: 'progress', id: job.id, done: 0, total: 0, phase: 'inspecting' });
    controller.signal.throwIfAborted();
    const { blob, note } = await downloadHls(job.url, controller.signal, (done, total, phase, bytes) =>
      send({ type: 'progress', id: job.id, done, total, phase, bytes }), { jobId: job.id, pageUrl: job.pageUrl, audioUrl: job.audioUrl, requireAudio: job.requireAudio, createFile: extension => createFile(job.id, extension) });
    controller.signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    blobs.set(job.id, url);
    await send({ type: 'ready', id: job.id, url, format: blob.type === 'video/mp4' ? 'MP4' : 'TS', note });
  } catch (error) {
    await release(job.id).catch(() => {});
    if (!controller.signal.aborted) await send({ type: 'failed', id: job.id,
      message: error.name === 'QuotaExceededError' ? '浏览器临时磁盘空间不足，已停止下载。请释放磁盘空间后重试。' : error.name === 'TimeoutError' ? '视频请求超过 60 秒，已停止下载。' : error.message }).catch(() => {});
  } finally { tasks.delete(job.id); pump(); }
}

function pump() {
  while (tasks.size < MAX_CONCURRENT_HLS && pending.size) {
    const [id, job] = pending.entries().next().value;
    pending.delete(id);
    const controller = new AbortController(); tasks.set(id, controller);
    void run(job, controller);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  if (message.type === 'start') {
    if (!tasks.has(message.job.id) && !pending.has(message.job.id)) pending.set(message.job.id, message.job);
    pump();
  } else if (message.type === 'cancel') {
    pending.delete(message.id);
    tasks.get(message.id)?.abort();
  }
  else if (message.type === 'list') {
    respond({ ok: true, ids: [...tasks.keys(), ...pending.keys(), ...blobs.keys()] }); return;
  } else if (message.type === 'release') {
    // Active fetches own their cleanup; do not remove a file while it is being written.
    if (!tasks.has(message.id) || blobs.has(message.id)) {
      release(message.id).then(() => respond({ ok: true }), () => respond({ ok: false }));
      return true;
    }
  }
  respond({ ok: true });
});
