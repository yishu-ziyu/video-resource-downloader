import { groupResources, isXPost, rootItems, groupName, ownsJob } from './resources.js';
import { createVersionPicker, closeVersionPickers } from './version-picker.js';
const $ = selector => document.querySelector(selector);
const busy = job => job && !['complete', 'failed', 'cancelled'].includes(job.state);
const selections = new Map();
const inspecting = new Set();
const statusNodes = new Map();
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
  thumbnail.append(element('span', 'duration', duration(media?.duration)));
  const thumbnailHint = element('span', 'locate-hint'); thumbnail.append(thumbnailHint);
  const info = element('div', 'card-info');
  const eyebrow = element('div', 'card-eyebrow', media ? '网页视频' : '未确认对应视频');
  eyebrow.append(element('span', 'format-badge', group.items[0].kind === 'hls' ? 'HLS' : format(group.items[0])));
  info.append(eyebrow);
  const titleRow = element('div', 'title-row');
  const name = groupName(group);
  const title = element('h3', 'video-title', name); title.title = name;
  const edit = element('button', 'icon-button');
  edit.setAttribute('aria-label', '修改文件名'); edit.title = '修改文件名';
  edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z"/></svg>';
  titleRow.append(title, edit);
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
  // The badge already names the format, so a matched card's meta only shows size facts.
  const metaBase = media ? dimensions : `${types} · ${new URL(group.items[0].url).hostname}`;
  const meta = element('p', 'video-meta', metaBase);
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
  const fill = element('span', 'download-fill'); fill.setAttribute('aria-hidden', 'true');
  const downloadIcon = element('span', 'download-icon'); downloadIcon.setAttribute('aria-hidden', 'true');
  downloadIcon.innerHTML = '<svg viewBox="0 0 24 24"><path class="download-symbol" d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/><path class="complete-symbol" d="m5 12 4 4L19 6"/></svg>';
  download.append(fill, downloadIcon, element('span', 'download-label', '下载'));
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
  actions.append(picker.root, download);
  info.append(titleRow, rename, meta, actions);
  body.append(thumbnail, info); article.append(body, sizeWarning);
  const tools = element('div', 'card-tools');
  const hls = group.items.find(item => item.kind === 'hls' && (!item.inspected || item.inspectionError));
  if (hls) {
    const read = element('button', 'secondary read-quality', inspecting.has(hls.url) ? '正在读取…' : '读取清晰度');
    read.disabled = inspecting.has(hls.url) || Boolean(busy(job));
    read.addEventListener('click', async () => {
      inspecting.add(hls.url); read.disabled = true; read.textContent = '正在读取…';
      await command({ type: 'inspect', tabId, url: hls.url });
      inspecting.delete(hls.url); snapshot = ''; await render();
    });
    tools.append(read);
  }
  const technical = element('details', 'technical');
  const summary = element('summary', '', media ? `资源信息${group.items.length > 1 ? ` · ${group.items.length} 个地址` : ''}` : '未确认对应视频 · 查看资源');
  technical.append(summary);
  for (const item of group.items) {
    technical.append(element('span', 'resource-name', item.name), element('span', 'resource-url', item.url));
  }
  if (media) {
    const location = element('button', 'locate-link', '定位到网页视频');
    location.addEventListener('click', () => locate(media)); technical.append(location);
  }
  if (!media) technical.append(element('p', '', '无法确认这个资源对应哪个网页视频，请核对后下载。'));
  tools.prepend(technical); article.append(tools);
  const inspectionError = group.items.find(item => item.inspectionError)?.inspectionError;
  if (inspectionError) article.append(element('p', 'inspection-error', `无法读取清晰度：${inspectionError}`));
  const jobMount = element('div', 'job-mount'); article.append(jobMount);
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

function updateButton(button, job, nativeDownload) {
  let label = button.dataset.awaitingMatch === 'true' ? '等待匹配' : '下载';
  const { percent, source } = downloadProgress(job, nativeDownload);
  if (job) {
    const labels = { queued: '排队中', inspecting: '检查中…', fetching: '下载中…', muxing: '封装中…', saving: '保存中…',
      complete: '再次下载', failed: '重试下载', cancelled: '重新下载' };
    label = labels[job.state] || label;
    if (source === 'segments') label = `片段 ${percent}%`;
    else if (source === 'bytes') label = `下载 ${percent}%`;
    else if (source === 'unknown') label = '下载中…';
  }
  button.querySelector('.download-label').textContent = label;
  button.dataset.state = job?.state || 'idle';
  button.dataset.progressSource = source || '';
  button.dataset.progress = percent === undefined ? '' : String(percent);
  button.style.setProperty('--progress', `${percent || 0}%`);
  button.classList.toggle('has-progress', percent !== undefined);
  button.setAttribute('aria-busy', String(Boolean(busy(job))));
  button.title = source === 'segments' ? `按片段计：${job.done} / ${job.total}` :
    source === 'bytes' ? `浏览器已接收 ${nativeDownload.bytesReceived} / ${nativeDownload.totalBytes} 字节` : label;
  return { percent, source };
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
    statusNodes.set(job.id, node);
  }
  node.dataset.state = job.state;
  const titles = { queued: '排队等待', inspecting: '准备下载', fetching: '下载中', muxing: '封装 MP4', saving: '正在保存', complete: '下载完成', failed: '下载失败', cancelled: '已取消' };
  const oldPage = job.pageUrl && job.pageUrl !== pageUrl;
  node.querySelector('.job-title').textContent = oldPage ? `上一页面的下载 · ${job.name} · ${titles[job.state] || '下载任务'}` : titles[job.state] || '下载任务';
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
    const info = updateButton(article.querySelector('.download'), job, nativeDownloads.get(job?.id));
    article.dataset.state = job?.state || 'idle';
    article.style.setProperty('--task-progress', `${info.percent || 0}%`);
    if (job) {
      article.querySelector('.job-mount').append(renderStatus(job, nativeDownloads.get(job.id), page.url, info));
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
  const summaryJobs = jobs.filter(job => busy(job) || job.pageUrl === page.url || job === jobs.at(-1));
  $('#task-overview').hidden = summaryJobs.length < 2;
  const counts = [summaryJobs.filter(job => busy(job) && job.state !== 'queued').length,
    summaryJobs.filter(job => job.state === 'queued').length, summaryJobs.filter(job => job.state === 'complete').length];
  const labels = ['进行中', '排队中', '已完成'];
  $('#task-overview .overview-stats').replaceChildren(...counts.map((count, index) => {
    const stat = element('div', 'overview-stat'); stat.dataset.kind = ['active', 'queued', 'complete'][index];
    stat.append(element('strong', '', String(count)), element('span', '', labels[index])); return stat;
  }));
  clearTimeout(progressTimer);
  if (jobs.some(job => job.kind === 'file' && job.state === 'saving')) {
    progressTimer = setTimeout(() => void render().catch(showError), 400);
  }
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
$('#empty-reload').addEventListener('click', () => chrome.tabs.reload(tabId).catch(showError));
$('#other-resources').addEventListener('toggle', () => {
  if ($('#other-resources').hidden) return;
  try { localStorage.setItem(OTHER_OPEN, $('#other-resources').open ? '1' : '0'); } catch {}
});
$('#workspace-open').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=${tabId}&view=workspace`) }).catch(showError));
$('#downloads').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://downloads/' }).catch(showError));
void init().catch(showError);
