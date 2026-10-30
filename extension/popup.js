import { busy, bytes, downloadProgress, nextStep, describePage } from './card-model.js';
import { createVersionPicker, closeVersionPickers } from './version-picker.js';
const $ = selector => document.querySelector(selector);
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

async function locate(media) {
  $('#error').hidden = true;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'locate', id: media.id }, { frameId: media.frameId });
    if (!result?.ok) throw new Error(result?.error || '无法定位视频，请刷新网页并重新播放。');
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) { $('#error').textContent = error.message; $('#error').hidden = false; }
}

// Builds DOM from a describeCard() descriptor; display decisions live in card-model.js.
function card(desc) {
  const { group, media, job } = desc;
  const article = element('article', 'video-card');
  article.dataset.key = desc.key;
  const body = element('div', 'card-body');
  const thumbnail = element('button', 'thumbnail');
  thumbnail.type = 'button';
  thumbnail.setAttribute('aria-label', '预览视频');
  const placeholder = element('span', 'placeholder-icon', '▷');
  const missing = element('span', 'thumbnail-copy', desc.missingText);
  if (!desc.posterSrc) thumbnail.dataset.format = desc.posterMark.split(' · ')[0];
  if (!desc.posterSrc) thumbnail.append(element('span', 'format-mark', desc.posterMark));
  thumbnail.append(placeholder, missing);
  if (desc.posterSrc) {
    const image = element('img'); image.src = desc.posterSrc; image.alt = media?.title || desc.name; image.referrerPolicy = 'no-referrer';
    placeholder.hidden = true; missing.hidden = true;
    image.addEventListener('error', () => { image.remove(); placeholder.hidden = false; missing.hidden = false; });
    thumbnail.prepend(image);
  }
  if (desc.durationText) thumbnail.append(element('span', 'duration', desc.durationText));
  const thumbnailHint = element('span', 'locate-hint'); thumbnail.append(thumbnailHint);
  const info = element('div', 'card-info');
  const titleRow = element('div', 'title-row');
  const title = element('h3', 'video-title', desc.name); title.title = desc.name;
  const edit = element('button', 'icon-button');
  edit.setAttribute('aria-label', '修改文件名'); edit.title = '修改文件名';
  edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z"/></svg>';
  const infoToggle = element('button', 'icon-button info-toggle');
  infoToggle.setAttribute('aria-label', '资源信息'); infoToggle.title = '资源信息'; infoToggle.setAttribute('aria-expanded', 'false');
  infoToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>';
  titleRow.append(title, edit, infoToggle);
  const rename = element('form', 'rename'); rename.hidden = true;
  const input = element('input'); input.value = desc.name; input.maxLength = 120; input.required = true; input.setAttribute('aria-label', '文件名');
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
  // The version picker already names the format; meta only carries size facts or, unmatched, the host.
  const metaLine = element('p', 'meta-line');
  const meta = element('span', 'video-meta', desc.metaBase);
  metaLine.append(meta);
  const sizeWarning = element('p', 'size-warning'); sizeWarning.hidden = true;
  function updateSize(choice) {
    const { text, warning } = desc.sizeFor(choice);
    meta.textContent = text ? [desc.metaBase, text].filter(Boolean).join(' · ') : desc.metaBase;
    sizeWarning.textContent = warning || ''; sizeWarning.hidden = !warning;
  }
  const actions = element('div', 'card-actions');
  const choices = desc.choices;
  const picker = createVersionPicker(choices, desc.initialValue, desc.pickerDisabled, choice => {
      selections.set(group.key, choice.value);
      download.disabled = desc.downloadDisabledFor(choice);
      updateThumbnail(choice); updateSize(choice);
    });
  selections.set(group.key, picker.value);
  const download = element('button', 'download');
  download.dataset.awaitingMatch = String(desc.unconfirmed);
  const downloadIcon = element('span', 'download-icon'); downloadIcon.setAttribute('aria-hidden', 'true');
  downloadIcon.innerHTML = '<svg viewBox="0 0 24 24"><path class="download-symbol" d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/><path class="complete-symbol" d="m5 12 4 4L19 6"/></svg>';
  download.append(downloadIcon, element('span', 'download-label', '下载'));
  download.disabled = desc.downloadDisabledFor(choices.find(choice => choice.value === picker.value));
  download.addEventListener('click', () => {
    const choice = choices.find(choice => choice.value === picker.value);
    void command({ type: 'start', tabId, url: choice.item.url, selectedUrl: choice.selectedUrl });
  });
  function updateThumbnail(choice) {
    const thumb = desc.thumbFor(choice);
    thumbnail.disabled = !thumb.enabled;
    thumbnail.setAttribute('aria-label', thumb.label);
    thumbnailHint.textContent = thumb.hint;
  }
  const current = () => choices.find(choice => choice.value === picker.value);
  updateThumbnail(current()); updateSize(current());
  thumbnail.addEventListener('click', () => {
    const choice = current();
    const action = desc.thumbFor(choice).action;
    if (action === 'preview') openPreview(group, choice.item, thumbnail);
    else if (action === 'locate') void locate(media);
  });
  actions.append(picker.root);
  const hls = desc.hlsItem;
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
  technical.append(element('strong', '', desc.technical.heading));
  infoToggle.addEventListener('click', () => {
    technical.hidden = !technical.hidden; infoToggle.setAttribute('aria-expanded', String(!technical.hidden));
  });
  for (const item of group.items) {
    technical.append(element('span', 'resource-name', item.name), element('span', 'resource-url', item.url));
  }
  if (desc.technical.canLocate) {
    const location = element('button', 'locate-link', '定位到网页视频');
    location.addEventListener('click', () => locate(media)); technical.append(location);
  }
  if (desc.technical.showNote) technical.append(element('p', '', '无法确认这个资源对应哪个网页视频，请核对后下载。'));
  if (desc.inspectionError) article.append(element('p', 'inspection-error', `无法读取清晰度：${desc.inspectionError}`));
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

function openPreview(group, item, source) {
  closeVersionPickers();
  previewSource = { button: source, url: item.url, media: group.media };
  $('#preview-title').textContent = item.displayName || group.media?.title || item.name;
  document.querySelector('.preview-subtitle').textContent =
    `${item.kind === 'image' ? '图片预览' : '原文件预览 · 默认静音'}${group.items.length > 1 ? ` · ${item.name}` : ''}`;
  $('#preview-error').hidden = true; $('#preview-loading').hidden = false;
  $('#preview-page').hidden = !group.media || group.media.image;
  const video = $('#preview-video'), image = $('#preview-image');
  video.hidden = item.kind === 'image'; image.hidden = item.kind !== 'image';
  if (item.kind === 'image') { image.src = item.url; image.alt = item.name; }
  else {
    video.poster = group.media?.poster || '';
    video.src = item.url;
    video.muted = true;
    void video.play().catch(() => {});
  }
  $('#preview').showModal();
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
  const model = describePage({ items, players: data[`media:${tabId}`] || [], jobs,
    pageUrl: page.url, tabId, selectedValues: selections });
  const cardJobs = model.cards.map(desc => desc.job);
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
    // Build first, assign second: a card() throw must not leave groups and
    // cardNodes pointing at different generations of the same list.
    const nodes = model.cards.map(desc => card(desc));
    groups = model.groups;
    cardNodes = nodes;
    $('#resources').replaceChildren(...nodes.filter((node, index) => !model.cards[index].folded));
    $('#other-list').replaceChildren(...nodes.filter((node, index) => model.cards[index].folded));
    $('#other-resources').open = model.fold && otherOpen();
    $('#other-resources').hidden = !model.foldedCount;
    $('#other-resources .other-count').textContent = `其他资源 ${model.foldedCount} 个`;
    $('#count').textContent = model.countText;
  }
  renderEmpty(model.empty);
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
function renderEmpty(empty) {
  $('#empty').hidden = !empty;
  if (!empty) return;
  $('#count').textContent = empty.countText;
  $('#empty-title').textContent = empty.title;
  $('#empty-text').textContent = empty.text;
  $('#empty-locate').hidden = !empty.hasPlayers;
  $('#empty-locate').onclick = () => locate(empty.locate);
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
  const image = $('#preview-image'); image.removeAttribute('src'); image.hidden = true; video.hidden = false;
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
$('#preview-image').addEventListener('load', () => { $('#preview-loading').hidden = true; });
$('#preview-image').addEventListener('error', () => {
  if (!$('#preview').open) return;
  $('#preview-loading').hidden = true;
  $('#preview-error').textContent = '无法预览这张图片。地址可能已失效。';
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
