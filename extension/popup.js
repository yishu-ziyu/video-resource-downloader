import { groupResources, isXPost, rootItems, groupName, ownsJob } from './resources.js';
import { createVersionPicker, closeVersionPickers } from './version-picker.js';
const $ = selector => document.querySelector(selector);
const busy = job => job && !['complete', 'failed', 'cancelled'].includes(job.state);
const selections = new Map();
const inspecting = new Set();
const statusNodes = new Map();
// Cards rebuild on every resource change; remember which finished task the user reopened.
const reopened = new Map();
const workspace = new URL(location.href).searchParams.get('view') === 'workspace';
document.body.classList.toggle('workspace', workspace);
let tabId;
let snapshot = '';
let groups = [];
let progressTimer;
let previewSource;
let rendering = Promise.resolve();
let cardNodes = [];
const OTHER_OPEN = 'otherResourcesOpen';
function otherOpen() { try { return localStorage.getItem(OTHER_OPEN) === '1'; } catch { return false; } }

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function command(message) {
  $('#error').hidden = true;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '后台任务未响应，请重新尝试。');
    return result;
  } catch (error) { $('#error').textContent = error.message; $('#error').hidden = false; }
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '时长未知';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` :
    `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

// TS and fMP4 HLS both save as MP4; TS is kept only when MP4 cannot hold its codecs unchanged.
const hlsOutput = format => format === 'TS' ? 'MP4' : format || '待检查';
function format(item) {
  if (item.kind === 'hls') return hlsOutput(item.format);
  if (item.kind === 'dash') return 'DASH · 暂不支持';
  const suffix = new URL(item.url).pathname.match(/\.(mp4|webm|mov|mkv|m4v|ogv)$/i)?.[1];
  return suffix?.toUpperCase() || (/mp4/i.test(item.mime) ? 'MP4' : /webm/i.test(item.mime) ? 'WEBM' : '原文件');
}

function options(group) {
  const choices = [];
  for (const item of rootItems(group)) {
    choices.push({ item, value: JSON.stringify([item.url, null]),
      label: item.kind === 'hls' ? `${item.inspected && !item.variants?.length ? '原清单' : '自动最高'} · ${format(item)}` :
        `${format(item)}${group.items.length > 1 ? ` · ${item.name}` : ' · 原文件'}` });
    for (const variant of item.variants || []) choices.push({ item, selectedUrl: variant.url,
      value: JSON.stringify([item.url, variant.url]), label: `${variant.height ? `${variant.height}p` : `${Math.round(variant.bandwidth / 1000)} kbps`} · ${hlsOutput(variant.format)}` });
  }
  return choices;
}

const FMP4_LIMIT = 256 * 1024 ** 2;
// File sizes come from response headers; HLS sizes are estimates from bitrate × playlist duration.
function sizeInfo(choice) {
  if (!choice) return {};
  if (choice.item.kind === 'file') return { text: choice.item.size > 0 ? bytes(choice.item.size) : '' };
  const variant = choice.selectedUrl ? choice.item.variants?.find(variant => variant.url === choice.selectedUrl) : choice.item.variants?.[0];
  const rate = variant?.averageBandwidth || variant?.bandwidth;
  if (!(variant?.duration > 0 && rate > 0)) return {};
  const estimate = rate / 8 * variant.duration;
  return { text: `约 ${bytes(estimate)}`, warning: variant.format === 'MP4' && estimate > FMP4_LIMIT ?
    `预计约 ${bytes(estimate)}，可能超过 fMP4 合并的 256 MiB 上限，下载可能失败。建议改选较低清晰度。` : '' };
}

async function locate(media) {
  $('#error').hidden = true;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'locate', id: media.id }, { frameId: media.frameId });
    if (!result?.ok) throw new Error(result?.error || '无法定位视频，请刷新网页并重新播放。');
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) { $('#error').textContent = error.message; $('#error').hidden = false; }
}

function card(group, job, pageUrl) {
  const article = element('article', 'video-card');
  article.dataset.key = group.key;
  const media = group.media;
  const unconfirmed = isXPost(pageUrl) && !media;
  const body = element('div', 'card-body');
  const thumbnail = element('button', 'thumbnail');
  thumbnail.type = 'button';
  thumbnail.setAttribute('aria-label', '预览视频');
  const placeholder = element('span', 'placeholder-icon', '▷');
  const missing = element('span', 'thumbnail-copy', media ? '暂无封面' : '未匹配视频');
  if (!media?.poster) thumbnail.dataset.format = group.items[0].kind === 'hls' ? 'HLS' : format(group.items[0]).split(' · ')[0];
  if (!media?.poster) thumbnail.append(element('span', 'format-mark', group.items[0].kind === 'hls' ? 'HLS' : format(group.items[0])));
  thumbnail.append(placeholder, missing);
  if (media?.poster) {
    const image = element('img'); image.src = media.poster; image.alt = media.title; image.referrerPolicy = 'no-referrer';
    placeholder.hidden = true; missing.hidden = true;
    image.addEventListener('error', () => { image.remove(); placeholder.hidden = false; missing.hidden = false; });
    thumbnail.prepend(image);
  }
  if (media?.duration > 0) thumbnail.append(element('span', 'duration', duration(media.duration)));
  const thumbnailHint = element('span', 'locate-hint'); thumbnail.append(thumbnailHint);
  const info = element('div', 'card-info');
  const titleRow = element('div', 'title-row');
  const name = groupName(group);
  const title = element('h3', 'video-title', name); title.title = name;
  const edit = element('button', 'icon-button');
  edit.setAttribute('aria-label', '修改文件名'); edit.title = '修改文件名';
  edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z"/></svg>';
  const infoToggle = element('button', 'icon-button info-toggle');
  infoToggle.setAttribute('aria-label', '资源信息'); infoToggle.title = '资源信息'; infoToggle.setAttribute('aria-expanded', 'false');
  infoToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>';
  titleRow.append(title, edit, infoToggle);
  const rename = element('form', 'rename'); rename.hidden = true;
  const input = element('input'); input.value = name; input.maxLength = 120; input.required = true; input.setAttribute('aria-label', '文件名');
  const save = element('button', '', '保存'); save.setAttribute('aria-label', '保存名称'); save.type = 'submit';
  rename.append(input, save);
  rename.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    article.querySelector('.download').disabled = true;
    await command({ type: 'rename', tabId, url: group.items[0].url, name: input.value });
    snapshot = ''; await render();
  });
  edit.addEventListener('click', () => { rename.hidden = !rename.hidden; if (!rename.hidden) { input.focus(); input.select(); } });
  const types = [...new Set(group.items.map(item => item.kind === 'hls' ? 'HLS' : format(item)))].join(' / ');
  const dimensions = media?.width && media?.height ? `${media.width} × ${media.height}` : '尺寸未知';
  // The badge names the format, so the meta text only shows size facts or, unmatched, the host.
  const metaBase = media ? dimensions : new URL(group.items[0].url).hostname;
  const metaLine = element('p', 'meta-line');
  const meta = element('span', 'video-meta', metaBase);
  metaLine.append(element('span', 'format-badge', types), meta);
  const sizeWarning = element('p', 'size-warning'); sizeWarning.hidden = true;
  function updateSize(choice) {
    const { text, warning } = sizeInfo(choice);
    meta.textContent = text ? `${metaBase} · ${text}` : metaBase;
    sizeWarning.textContent = warning || ''; sizeWarning.hidden = !warning;
  }
  const actions = element('div', 'card-actions');
  const choices = options(group);
  const jobChoice = job?.tabId === tabId && group.items.some(item => item.url === (job.resourceUrl || job.url)) ?
    JSON.stringify([job.resourceUrl || job.url, job.resourceUrl && job.url !== job.resourceUrl ? job.url : null]) : undefined;
  const picker = createVersionPicker(choices, selections.get(group.key) || jobChoice,
    Boolean(busy(job)) || choices.every(choice => choice.item.kind === 'dash'), choice => {
      selections.set(group.key, choice.value);
      download.disabled = Boolean(busy(job)) || choice.item.kind === 'dash' || unconfirmed;
      updateThumbnail(choice); updateSize(choice);
    });
  selections.set(group.key, picker.value);
  const download = element('button', 'download');
  download.dataset.awaitingMatch = String(unconfirmed);
  const downloadIcon = element('span', 'download-icon'); downloadIcon.setAttribute('aria-hidden', 'true');
  downloadIcon.innerHTML = '<svg viewBox="0 0 24 24"><path class="download-symbol" d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/><path class="complete-symbol" d="m5 12 4 4L19 6"/></svg>';
  download.append(downloadIcon, element('span', 'download-label', '下载'));
  download.disabled = Boolean(busy(job)) || choices.find(choice => choice.value === picker.value)?.item.kind === 'dash' || unconfirmed;
  download.addEventListener('click', () => {
    const choice = choices.find(choice => choice.value === picker.value);
    void command({ type: 'start', tabId, url: choice.item.url, selectedUrl: choice.selectedUrl });
  });
  function updateThumbnail(choice) {
    const direct = choice.item.kind === 'file';
    thumbnail.disabled = !direct && !media;
    thumbnail.setAttribute('aria-label', direct ? '预览视频' : media ? '定位到网页视频' : '尚未匹配到网页视频');
    thumbnailHint.textContent = direct ? '预览视频 ▷' : '网页中播放 ↗';
  }
  updateThumbnail(choices.find(choice => choice.value === picker.value));
  updateSize(choices.find(choice => choice.value === picker.value));
  thumbnail.addEventListener('click', () => {
    const choice = choices.find(choice => choice.value === picker.value);
    if (choice.item.kind === 'file') openPreview(group, choice.item, thumbnail);
    else if (media) void locate(media);
  });
  actions.append(picker.root);
  const hls = group.items.find(item => item.kind === 'hls' && (!item.inspected || item.inspectionError));
  if (hls) {
    const read = element('button', 'secondary read-quality', inspecting.has(hls.url) ? '正在读取…' : '读取清晰度');
    read.disabled = inspecting.has(hls.url) || Boolean(busy(job));
    read.addEventListener('click', async () => {
      inspecting.add(hls.url); read.disabled = true; read.textContent = '正在读取…';
      await command({ type: 'inspect', tabId, url: hls.url });
      inspecting.delete(hls.url); snapshot = ''; await render();
    });
    actions.append(read);
  }
  actions.append(download);
  // A finished task hides the version row; "更多操作" on its status brings it back for another download.
  const jobMount = element('div', 'job-mount');
  info.append(titleRow, rename, metaLine, actions, jobMount);
  body.append(thumbnail, info); article.append(body, sizeWarning);
  const technical = element('div', 'technical'); technical.hidden = true;
  technical.append(element('strong', '', media ? `资源信息${group.items.length > 1 ? ` · ${group.items.length} 个地址` : ''}` : '未确认对应视频'));
  infoToggle.addEventListener('click', () => {
    technical.hidden = !technical.hidden; infoToggle.setAttribute('aria-expanded', String(!technical.hidden));
  });
  for (const item of group.items) {
    technical.append(element('span', 'resource-name', item.name), element('span', 'resource-url', item.url));
  }
  if (media) {
    const location = element('button', 'locate-link', '定位到网页视频');
    location.addEventListener('click', () => locate(media)); technical.append(location);
  }
  if (!media) technical.append(element('p', '', '无法确认这个资源对应哪个网页视频，请核对后下载。'));
  const inspectionError = group.items.find(item => item.inspectionError)?.inspectionError;
  if (inspectionError) article.append(element('p', 'inspection-error', `无法读取清晰度：${inspectionError}`));
  article.append(technical);
  return article;
}

// Called straight from the click: downloads.open only works during a user gesture.
async function openDownload(action, downloadId) {
  $('#error').hidden = true;
  try { await chrome.downloads[action](downloadId); }
  catch (error) {
    showError(new Error(/deleted|exist|missing/i.test(error.message) ? '文件已被移动或删除。可在浏览器下载记录中查看。' : `无法打开文件：${error.message}`));
  }
}

function nextStep(message) {
  if (/不是完整视频|只是音轨|初始化片段/.test(message)) return '请重新播放，并选择这个视频的 HLS 主清单；不要单独下载音轨或初始化片段。';
  if (/独立音轨|暂不支持加密|未加密地址|非 HTTP|必须是 HTTP|DRM|分片结构|直播|MPEG-TS|格式不支持/.test(message)) return '该资源暂不支持。若列表中有直接视频文件，可选择原文件下载。';
  if (/HTTP \d|过期|登录/.test(message)) return '回到网页重新播放，再选择新发现的资源。';
  if (/磁盘空间/.test(message)) return '释放磁盘空间后重试；也可选择较低清晰度，减少临时磁盘占用。';
  if (/限制/.test(message)) return '可尝试较低清晰度，或选择直接视频文件。';
  return '请检查网络；重新播放视频后可以再次下载。';
}

function openPreview(group, item, source) {
  closeVersionPickers();
  previewSource = { button: source, url: item.url, media: group.media };
  $('#preview-title').textContent = item.displayName || group.media?.title || item.name;
  $('#preview-error').hidden = true; $('#preview-loading').hidden = false;
  $('#preview-page').hidden = !group.media;
  $('#preview-video').poster = group.media?.poster || '';
  $('#preview-video').src = item.url;
  $('#preview-video').muted = true;
  $('#preview').showModal();
  void $('#preview-video').play().catch(() => {});
}

function downloadProgress(job, nativeDownload) {
  if (job?.state === 'fetching' && job.total > 0) return { percent: Math.round(job.done / job.total * 100), source: 'segments' };
  if (job?.kind === 'file' && job.state === 'saving' && nativeDownload) {
    return nativeDownload.totalBytes > 0 ?
      { percent: Math.min(100, Math.round(nativeDownload.bytesReceived / nativeDownload.totalBytes * 100)), source: 'bytes' } : { source: 'unknown' };
  }
  return {};
}

// A running task replaces the button with its status row, so the button only names the next action.
function updateButton(button, job) {
  const labels = { complete: '再次下载', failed: '重试下载', cancelled: '重新下载' };
  button.querySelector('.download-label').textContent = button.dataset.awaitingMatch === 'true' ? '等待匹配' : labels[job?.state] || '下载';
  button.dataset.state = job?.state || 'idle';
}

function render() {
  const task = rendering.then(renderView);
  rendering = task.catch(showError);
  return task;
}

function jobForGroup(group, jobs, pageUrl) {
  const matching = jobs.filter(job => (!job.pageUrl || job.pageUrl === pageUrl) && ownsJob(group, job));
  return matching.find(busy) || matching.at(-1);
}
function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` :
    value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
}
function renderStatus(job, nativeDownload, pageUrl, progressInfo) {
  let node = statusNodes.get(job.id);
  if (!node) {
    node = $('#job-template').content.firstElementChild.cloneNode(true);
    node.dataset.jobId = job.id;
    node.querySelector('.cancel').addEventListener('click', () => command({ type: 'cancel', id: job.id }));
    for (const [selector, action] of [['.open-file', 'open'], ['.show-file', 'show']]) {
      node.querySelector(selector).addEventListener('click', () => openDownload(action, Number(node.dataset.downloadId)));
    }
    node.querySelector('.more-actions').addEventListener('click', () => {
      const article = node.closest('.video-card');
      if (article) { reopened.set(article.dataset.key, job.id); article.classList.add('reopen'); }
    });
    statusNodes.set(job.id, node);
  }
  node.dataset.state = job.state;
  const titles = { queued: '排队等待', inspecting: '准备下载', fetching: '下载中', muxing: '封装 MP4', saving: '正在保存', complete: '下载完成', failed: '下载失败', cancelled: '已取消' };
  const oldPage = job.pageUrl && job.pageUrl !== pageUrl;
  const title = `${titles[job.state] || '下载任务'}${progressInfo.percent === undefined ? '' : ` ${progressInfo.percent}%`}`;
  node.querySelector('.job-title').textContent = oldPage ? `上一页面的下载 · ${job.name} · ${title}` : title;
  node.dataset.progressSource = progressInfo.source || '';
  node.dataset.progress = progressInfo.percent === undefined ? '' : String(progressInfo.percent);
  node.title = progressInfo.source === 'segments' ? `按片段计：${job.done} / ${job.total}` :
    progressInfo.source === 'bytes' ? `浏览器已接收 ${nativeDownload.bytesReceived} / ${nativeDownload.totalBytes} 字节` : '';
  node.querySelector('.job-message').textContent = job.message;
  node.querySelector('.cancel').hidden = !busy(job);
  node.querySelector('.file-actions').hidden = job.state !== 'complete' || job.downloadId === undefined;
  node.dataset.downloadId = job.downloadId ?? '';
  const progress = node.querySelector('.job-progress');
  progress.hidden = !['fetching', 'saving', 'muxing'].includes(job.state);
  progress.max = 100;
  if (progressInfo.percent === undefined) progress.removeAttribute('value'); else progress.value = progressInfo.percent;
  const currentBytes = nativeDownload?.bytesReceived ?? job.bytes;
  const totalBytes = nativeDownload?.totalBytes ?? job.totalBytes;
  const metrics = node.querySelector('.job-metrics');
  const size = bytes(currentBytes);
  metrics.textContent = job.state === 'fetching' ? `${job.done} / ${job.total} 个片段${size ? ` · 已写入 ${size}` : ''}` :
    job.state === 'complete' ? size :
    size ? `${size}${totalBytes > 0 ? ` / ${bytes(totalBytes)}` : ''}${progressInfo.source === 'unknown' ? ' · 总大小未知' : ''}` : '';
  metrics.hidden = !metrics.textContent;
  const hint = node.querySelector('.next-step');
  hint.hidden = job.state !== 'failed'; hint.textContent = job.state === 'failed' ? nextStep(job.message) : '';
  return node;
}

async function renderView() {
  const page = await chrome.tabs.get(tabId);
  $('#page-name').textContent = page.title || '当前网页';
  const data = await chrome.storage.session.get([`tab:${tabId}`, `media:${tabId}`, 'jobs']);
  const jobs = (data.jobs || []).filter(job => job.tabId === tabId);
  const items = data[`tab:${tabId}`] || [];
  if ($('#preview').open && !items.some(item => item.url === previewSource?.url)) closePreview();
  const rank = group => {
    const job = jobForGroup(group, jobs, page.url);
    return busy(job) ? job.state === 'queued' ? 1 : 0 : 2;
  };
  const nextGroups = groupResources(items).sort((a, b) => rank(a) - rank(b));
  const cardJobs = nextGroups.map(group => jobForGroup(group, jobs, page.url));
  const nativeDownloads = new Map();
  await Promise.all(jobs.filter(job => job.state === 'saving' && job.kind === 'file' && job.downloadId !== undefined).map(async job => {
    const [download] = await chrome.downloads.search({ id: job.downloadId });
    nativeDownloads.set(job.id, download);
  }));
  const next = JSON.stringify([page.url, items, cardJobs.map(job => [job?.id, Boolean(busy(job))])]);
  if (next !== snapshot) {
    snapshot = next; closeVersionPickers();
    // Keep status nodes and their cancel listeners while replacing cards.
    for (const node of statusNodes.values()) $('#unmatched-jobs').append(node);
    groups = nextGroups;
    cardNodes = groups.map((group, index) => card(group, cardJobs[index], page.url));
    const matched = groups.filter(group => group.media).length;
    const unmatched = groups.length - matched;
    // Fold unmatched resources (often ads or preloads) only when a real page video is listed.
    const fold = matched > 0 && unmatched > 0;
    // Running or failed tasks stay visible so progress, errors and the cancel button are never hidden.
    const folded = index => fold && !groups[index].media && !busy(cardJobs[index]) && cardJobs[index]?.state !== 'failed';
    $('#resources').replaceChildren(...cardNodes.filter((node, index) => !folded(index)));
    $('#other-list').replaceChildren(...cardNodes.filter((node, index) => folded(index)));
    $('#other-resources').open = fold && otherOpen();
    const foldedCount = groups.filter((group, index) => folded(index)).length;
    $('#other-resources').hidden = !foldedCount;
    $('#other-resources summary').textContent = `其他资源 ${foldedCount} 个 · 没有对应到网页上的视频，可能是广告或预加载`;
    $('#count').textContent = `${matched} 个视频${unmatched ? ` · ${unmatched} 组未匹配资源` : ''}`;
  }
  renderEmpty(items, data[`media:${tabId}`] || []);
  const otherCount = (data.jobs || []).filter(job => job.tabId !== tabId && busy(job)).length;
  $('#other-job').hidden = !otherCount;
  $('#other-job').textContent = `其他页面还有 ${otherCount} 个任务，可继续下载当前页面的视频。`;
  const visible = new Set();
  for (const [index, group] of groups.entries()) {
    const job = cardJobs[index];
    const article = cardNodes[index];
    updateButton(article.querySelector('.download'), job);
    article.classList.toggle('reopen', job?.state === 'complete' && reopened.get(group.key) === job.id);
    article.dataset.state = job?.state || 'idle';
    if (job) {
      article.querySelector('.job-mount').append(renderStatus(job, nativeDownloads.get(job.id), page.url, downloadProgress(job, nativeDownloads.get(job.id))));
      visible.add(job.id);
    }
  }
  for (const job of jobs.filter(job => busy(job) || job === jobs.at(-1))) {
    if (visible.has(job.id)) continue;
    // Keep active downloads and the latest result visible even after navigation.
    $('#unmatched-jobs').append(renderStatus(job, nativeDownloads.get(job.id), page.url, downloadProgress(job, nativeDownloads.get(job.id))));
    visible.add(job.id);
  }
  for (const [id, node] of statusNodes) if (!visible.has(id)) { node.remove(); statusNodes.delete(id); }
  const active = jobs.filter(job => busy(job) && job.state !== 'queued').length;
  const queued = jobs.filter(job => job.state === 'queued').length;
  $('#task-overview').hidden = !active && !queued;
  $('#task-overview .overview-text').textContent = [active && `${active} 个下载中`, queued && `${queued} 个排队`].filter(Boolean).join(' · ');
  if (workspace) renderTasks(jobs, nativeDownloads, page.url);
  clearTimeout(progressTimer);
  if (jobs.some(job => job.kind === 'file' && job.state === 'saving')) {
    progressTimer = setTimeout(() => void render().catch(showError), 400);
  }
}

// The full panel manages every task of this tab, including ones whose card is gone after navigation.
const TASK_FILTERS = [['all', '全部'], ['running', '下载中'], ['queued', '排队中'], ['failed', '失败'], ['complete', '已完成'], ['cancelled', '已取消']];
const TASK_TITLES = { queued: '排队中', inspecting: '准备中', fetching: '下载中', muxing: '封装中', saving: '保存中', complete: '已完成', failed: '失败', cancelled: '已取消' };
const taskGroup = job => job.state === 'queued' ? 'queued' : busy(job) ? 'running' : job.state;
const taskRows = new Map();
let taskFilter = 'all';
let lastTasks;
// Rows and buttons are updated in place: progress writes arrive several times a second,
// and rebuilding would swallow a click or drop keyboard focus mid-download.
function renderTasks(allJobs, nativeDownloads, pageUrl) {
  lastTasks = [allJobs, nativeDownloads, pageUrl];
  // A failed or cancelled attempt that was retried later is history, not something left to handle.
  const resource = job => `${job.pageUrl}\n${job.resourceUrl || job.url}`;
  const jobs = allJobs.filter((job, index) => !['failed', 'cancelled'].includes(job.state) ||
    !allJobs.slice(index + 1).some(later => resource(later) === resource(job)));
  $('#task-list').hidden = !jobs.length;
  if (!$('.task-filters').children.length) $('.task-filters').append(...TASK_FILTERS.map(([key, label]) => {
    const button = element('button', 'task-filter', label); button.dataset.filter = key;
    button.append(element('span'));
    button.addEventListener('click', () => { taskFilter = key; renderTasks(...lastTasks); });
    return button;
  }));
  for (const button of $('.task-filters').children) {
    const key = button.dataset.filter;
    button.lastChild.textContent = String(key === 'all' ? jobs.length : jobs.filter(job => taskGroup(job) === key).length);
    button.setAttribute('aria-pressed', String(taskFilter === key));
  }
  const shown = jobs.filter(job => taskFilter === 'all' || taskGroup(job) === taskFilter).reverse();
  $('.task-list-empty').hidden = shown.length > 0;
  const live = new Set(allJobs.map(job => job.id));
  for (const id of taskRows.keys()) if (!live.has(id)) taskRows.delete(id);
  const nodes = shown.flatMap(job => {
    const entry = taskRows.get(job.id) || createTaskRow(job);
    taskRows.set(job.id, entry);
    updateTaskRow(entry, job, nativeDownloads.get(job.id), pageUrl);
    return job.state === 'failed' ? [entry.row, entry.detail] : [entry.row];
  });
  const body = $('#task-list tbody');
  if (nodes.length !== body.children.length || nodes.some((node, index) => body.children[index] !== node)) body.replaceChildren(...nodes);
}
function createTaskRow(job) {
  const row = element('tr'); row.dataset.taskId = job.id;
  const cells = ['name', 'state', 'progress', 'size', 'actions'].map(name => element('td', `task-${name}-cell`));
  const nameBox = element('div', 'task-name');
  const ext = (job.savedName || job.filename || '').match(/\.([a-z0-9]+)$/i)?.[1];
  nameBox.append(element('span', 'task-format', job.kind === 'hls' ? 'HLS' : ext?.toUpperCase() || '文件'), element('div', 'task-label'));
  cells[0].append(nameBox); cells[1].append(element('span', 'task-state'));
  cells[2].className = 'task-progress'; cells[3].className = 'task-size'; cells[4].className = 'task-actions';
  row.append(...cells);
  const detail = element('tr', 'task-error'); const cell = element('td'); cell.colSpan = 5; detail.append(cell);
  return { row, cells, detail, actionsKey: '' };
}
function updateTaskRow(entry, job, native, pageUrl) {
  const { row, cells, detail } = entry;
  const name = job.savedName || job.name;
  const oldPage = job.pageUrl && job.pageUrl !== pageUrl;
  row.dataset.state = job.state;
  const label = cells[0].querySelector('.task-label');
  label.textContent = name;
  const sub = oldPage ? '上一页面' : job.note;
  if (sub) label.append(element('small', '', sub));
  const state = cells[1].firstChild; state.className = `task-state ${taskGroup(job)}`; state.textContent = TASK_TITLES[job.state] || job.state;
  const { percent } = downloadProgress(job, native);
  if (busy(job) && percent !== undefined) {
    let bar = cells[2].querySelector('progress');
    if (!bar) { bar = element('progress'); bar.max = 100; bar.setAttribute('aria-label', '下载进度'); cells[2].replaceChildren(bar, element('span')); }
    bar.value = percent; cells[2].lastChild.textContent = `${percent}%`;
  } else cells[2].textContent = job.state === 'complete' ? '100%' : '—';
  cells[3].textContent = bytes(native?.bytesReceived ?? job.bytes) || '—';
  // A task from another page cannot be restarted here: its resource is gone from this tab.
  const kind = busy(job) ? 'cancel' : job.state === 'complete' && job.downloadId !== undefined ? 'file' :
    ['failed', 'cancelled'].includes(job.state) && !oldPage ? job.state : 'none';
  const actionsKey = `${kind}|${job.downloadId}|${name}`;
  if (entry.actionsKey !== actionsKey) {
    entry.actionsKey = actionsKey;
    const button = (className, text, action) => {
      const node = element('button', className, text); node.setAttribute('aria-label', `${text} ${name}`);
      node.addEventListener('click', action); return node;
    };
    const retry = () => command({ type: 'start', tabId, url: job.resourceUrl || job.url,
      selectedUrl: job.resourceUrl && job.url !== job.resourceUrl ? job.url : undefined });
    cells[4].replaceChildren(...(kind === 'cancel' ? [button('secondary', '取消', () => command({ type: 'cancel', id: job.id }))] :
      kind === 'file' ? [button('open-file', '打开', () => openDownload('open', job.downloadId)),
        button('secondary', '在文件夹中显示', () => openDownload('show', job.downloadId))] :
      kind === 'failed' ? [button('retry', '重试', retry)] : kind === 'cancelled' ? [button('secondary', '重新下载', retry)] : []));
  }
  detail.firstChild.textContent = job.state === 'failed' ? `${job.message} → ${nextStep(job.message)}` : '';
}

// Tell "videos exist but have no address yet" apart from "no video on this page".
function renderEmpty(items, players) {
  $('#empty').hidden = items.length > 0;
  if (items.length) return;
  $('#count').textContent = players.length ? `发现 ${players.length} 个视频` : '0 个视频';
  $('#empty-title').textContent = players.length ? `网页上有 ${players.length} 个视频，还没找到下载地址` : '这个网页没有找到视频';
  $('#empty-text').textContent = players.length ? '先播放几秒，这里会出现下载按钮。已经在播放的话，刷新网页后再播放一次。' :
    '视频还没加载时，刷新网页后再播放。浏览器内部页面无法识别视频。';
  $('#empty-locate').hidden = !players.length;
  $('#empty-locate').onclick = () => locate(players[0]);
}

async function showMenuNotice() {
  const key = `notice:${tabId}`;
  const notice = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  // A notice from an earlier right-click is stale once the user has moved on.
  if (!notice?.text || Date.now() - notice.at > 60000) return;
  $('#menu-notice').textContent = notice.text; $('#menu-notice').hidden = false;
}

async function init() {
  const explicit = Number(new URL(location.href).searchParams.get('tab'));
  const tab = explicit > 0 ? await chrome.tabs.get(explicit) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  tabId = tab?.id;
  $('#page-name').textContent = tab?.title || '当前网页';
  if (!tabId) throw new Error('请先打开一个含视频的网页。');
  await command({ type: 'reconcile' });
  await showMenuNotice();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes.jobs || changes[`tab:${tabId}`] || changes[`media:${tabId}`]) void render().catch(showError);
    if (changes[`notice:${tabId}`]?.newValue) void showMenuNotice().catch(showError);
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (id === tabId && (change.url || change.title)) void render().catch(showError);
  });
  await render();
}
function showError(error) { $('#error').textContent = error.message; $('#error').hidden = false; }
function closePreview() {
  if (!previewSource) return;
  if ($('#preview').open) $('#preview').close();
  const video = $('#preview-video'); video.pause(); video.removeAttribute('src'); video.removeAttribute('poster'); video.load();
  if (previewSource.button.isConnected) previewSource.button.focus();
  else {
    const index = groups.findIndex(group => group.items.some(item => item.url === previewSource.url));
    cardNodes[index]?.querySelector('.thumbnail')?.focus();
  }
  previewSource = undefined;
}
$('#preview-close').addEventListener('click', closePreview);
$('#preview').addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
$('#preview').addEventListener('close', () => { if (!$('#preview').open) closePreview(); });
$('#preview-video').addEventListener('loadeddata', () => { $('#preview-loading').hidden = true; });
$('#preview-video').addEventListener('error', () => {
  if (!$('#preview').open) return;
  $('#preview-loading').hidden = true;
  $('#preview-error').textContent = '无法预览这个文件。地址可能已失效，或浏览器不支持它的编码；可回到网页播放。';
  $('#preview-error').hidden = false;
});
$('#preview-page').addEventListener('click', () => { if (previewSource?.media) void locate(previewSource.media); });
$('#workspace-open').hidden = workspace;
$('#overview-open').hidden = workspace;
$('#empty-reload').addEventListener('click', () => chrome.tabs.reload(tabId).catch(showError));
$('#other-resources').addEventListener('toggle', () => {
  if ($('#other-resources').hidden) return;
  try { localStorage.setItem(OTHER_OPEN, $('#other-resources').open ? '1' : '0'); } catch {}
});
for (const button of [$('#workspace-open'), $('#overview-open')]) button.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=${tabId}&view=workspace`) }).catch(showError));
$('#downloads').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://downloads/' }).catch(showError));
void init().catch(showError);
