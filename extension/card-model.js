// 卡片视图模型：资源列表的全部展示决策（标题、meta、选项、尺寸、折叠、空态、
// 建议）在这里算成纯数据。popup.js 只把描述落成 DOM；本文件不碰 DOM、
// chrome API 或事件监听，可在 Node 里直接测。
import './media-taxonomy.js';
import { groupResources, rootItems, groupName, ownsJob } from './resources.js';
const { format, hlsOutput, isAudioItem, isXPost, isDirect } = globalThis.VDR_TAXONOMY;

export const busy = job => job && !['complete', 'failed', 'cancelled'].includes(job.state);
export const bytes = value =>
  !Number.isFinite(value) || value < 0 ? '' :
  value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` :
  value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '时长未知';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` :
    `${minutes}:${String(total % 60).padStart(2, '0')}`;
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
  if (isDirect(choice.item)) return { text: choice.item.size > 0 ? bytes(choice.item.size) : '' };
  const variant = choice.selectedUrl ? choice.item.variants?.find(variant => variant.url === choice.selectedUrl) : choice.item.variants?.[0];
  const rate = variant?.averageBandwidth || variant?.bandwidth;
  if (!(variant?.duration > 0 && rate > 0)) return {};
  const estimate = rate / 8 * variant.duration;
  return { text: `约 ${bytes(estimate)}`, warning: variant.format === 'MP4' && estimate > FMP4_LIMIT ?
    `预计约 ${bytes(estimate)}，可能超过 fMP4 合并的 256 MiB 上限，下载可能失败。建议改选较低清晰度。` : '' };
}

export function jobForGroup(group, jobs, pageUrl) {
  const matching = jobs.filter(job => (!job.pageUrl || job.pageUrl === pageUrl) && ownsJob(group, job));
  return matching.find(busy) || matching.at(-1);
}

export function downloadProgress(job, nativeDownload) {
  if (job?.state === 'fetching' && job.total > 0) return { percent: Math.round(job.done / job.total * 100), source: 'segments' };
  if (job?.kind === 'file' && job.state === 'saving' && nativeDownload) {
    return nativeDownload.totalBytes > 0 ?
      { percent: Math.min(100, Math.round(nativeDownload.bytesReceived / nativeDownload.totalBytes * 100)), source: 'bytes' } : { source: 'unknown' };
  }
  return {};
}

export function nextStep(message) {
  if (/不是完整视频|只是音轨|初始化片段/.test(message)) return '请重新播放，并选择这个视频的 HLS 主清单；不要单独下载音轨或初始化片段。';
  if (/独立音轨|暂不支持加密|未加密地址|非 HTTP|必须是 HTTP|DRM|分片结构|直播|MPEG-TS|格式不支持/.test(message)) return '该资源暂不支持。若列表中有直接视频文件，可选择原文件下载。';
  if (/HTTP \d|过期|登录/.test(message)) return '回到网页重新播放，再选择新发现的资源。';
  if (/磁盘空间/.test(message)) return '释放磁盘空间后重试；也可选择较低清晰度，减少临时磁盘占用。';
  if (/限制/.test(message)) return '可尝试较低清晰度，或选择直接视频文件。';
  return '请检查网络；重新播放视频后可以再次下载。';
}

// One card's display decisions. DOM reads the descriptor; select changes call
// sizeFor/thumbFor/downloadDisabledFor again with the new choice.
export function describeCard({ group, job, pageUrl, tabId, selectedValue }) {
  const media = group.media;
  const unconfirmed = isXPost(pageUrl) && !media;
  const name = groupName(group);
  const choices = options(group);
  const jobChoice = job?.tabId === tabId && group.items.some(item => item.url === (job.resourceUrl || job.url)) ?
    JSON.stringify([job.resourceUrl || job.url, job.resourceUrl && job.url !== job.resourceUrl ? job.url : null]) : undefined;
  const initialValue = selectedValue || jobChoice;
  const pickerDisabled = Boolean(busy(job)) || choices.every(choice => choice.item.kind === 'dash');
  const downloadDisabledFor = choice => Boolean(busy(job)) || choice.item.kind === 'dash' || unconfirmed;
  const sizeFor = choice => sizeInfo(choice);
  const thumbFor = choice => {
    const direct = isDirect(choice.item);
    return { enabled: direct || Boolean(media), action: direct ? 'preview' : media ? 'locate' : null,
      label: direct ? '预览视频' : media ? '定位到网页视频' : '尚未匹配到网页视频',
      hint: direct ? '预览视频 ▷' : '网页中播放 ↗' };
  };
  const dimensions = media?.width && media?.height ? `${media.width} × ${media.height}` :
    media?.image ? `${new Set(group.items.map(item => item.name)).size} 张图` :
    group.items.every(isAudioItem) ? '' : '尺寸未知';
  let hostname = '';
  try { hostname = new URL(group.items[0].url).hostname; } catch {}
  return {
    group, media, job, key: group.key, name, unconfirmed, choices, initialValue, pickerDisabled,
    downloadDisabledFor, sizeFor, thumbFor,
    metaBase: media ? dimensions : hostname,
    posterSrc: media?.poster || (group.items[0]?.kind === 'image' ? group.items[0].url : ''),
    posterMark: group.items[0].kind === 'hls' ? 'HLS' : format(group.items[0]),
    missingText: media ? '暂无封面' : '未匹配视频',
    durationText: media?.duration > 0 ? duration(media.duration) : '',
    hlsItem: group.items.find(item => item.kind === 'hls' && (!item.inspected || item.inspectionError)),
    technical: { heading: media ? `资源信息${group.items.length > 1 ? ` · ${group.items.length} 个地址` : ''}` : '未确认对应视频',
      canLocate: Boolean(media), showNote: !media },
    inspectionError: group.items.find(item => item.inspectionError)?.inspectionError || '',
  };
}

// Fold unmatched resources (often ads or preloads) only when a real page video is listed.
export function describePage({ items, players, jobs, pageUrl, tabId, selectedValues }) {
  const rank = group => {
    const job = jobForGroup(group, jobs, pageUrl);
    return busy(job) ? job.state === 'queued' ? 1 : 0 : 2;
  };
  const groups = groupResources(items).sort((a, b) => rank(a) - rank(b));
  const cardJobs = groups.map(group => jobForGroup(group, jobs, pageUrl));
  const matched = groups.filter(group => group.media).length;
  const unmatched = groups.length - matched;
  const fold = matched > 0 && unmatched > 0;
  // Running or failed tasks stay visible so progress, errors and cancel are never hidden.
  const folded = index => fold && !groups[index].media && !busy(cardJobs[index]) && cardJobs[index]?.state !== 'failed';
  const cards = groups.map((group, index) => ({
    ...describeCard({ group, job: cardJobs[index], pageUrl, tabId, selectedValue: selectedValues?.get(group.key) }),
    folded: folded(index) }));
  const foldedCount = cards.filter(card => card.folded).length;
  return { cards, groups, matched, unmatched, fold, foldedCount,
    countText: `${matched} 个媒体${unmatched ? ` · ${unmatched} 组未匹配资源` : ''}`,
    empty: items.length ? null : {
      hasPlayers: players.length > 0,
      countText: players.length ? `发现 ${players.length} 个媒体` : '0 个媒体',
      title: players.length ? `网页上有 ${players.length} 个视频，还没找到下载地址` : '这个网页没有找到视频',
      text: players.length ? '先播放几秒，这里会出现下载按钮。已经在播放的话，刷新网页后再播放一次。' :
        '视频还没加载时，刷新网页后再播放。浏览器内部页面无法识别视频。',
      locate: players[0] || null } };
}
