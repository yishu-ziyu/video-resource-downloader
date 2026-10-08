import { sourceFetch } from './source-fetch.js';
import { muxMp4, remuxTsToMp4, checkRemux } from './vendor/mp4.js';
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SEGMENTS = 10000;

function attributes(line) {
  const result = {};
  for (const match of line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}
function absolute(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('清单包含非 HTTP 视频地址。');
  return url.href;
}
function parse(text, base) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('服务器未返回有效 HLS 清单，可能需要登录或地址已过期。');
  const variants = [], segments = [], audio = new Map();
  let pending, init;
  let segmentExpected = false;
  let duration = 0;
  for (const line of lines) {
    if (/^#EXT-X-(?:KEY|SESSION-KEY):/.test(line) && attributes(line).METHOD !== 'NONE') {
      throw new Error('暂不支持加密视频，也不会破解 DRM。');
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const data = attributes(line);
      if (data.TYPE === 'AUDIO' && data.URI) {
        const previous = audio.get(data['GROUP-ID']);
        if (!previous || data.DEFAULT === 'YES') audio.set(data['GROUP-ID'], absolute(data.URI, base));
      }
    }
    if (/^#EXT-X-(BYTERANGE:|DISCONTINUITY(?:$|:)|GAP(?:$|:)|PART:)/.test(line)) {
      throw new Error('此清单的字节范围或不连续分片结构暂不支持。');
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const data = attributes(line);
      if (!data.URI || data.BYTERANGE) throw new Error('初始化片段的字节范围结构暂不支持。');
      const next = absolute(data.URI, base);
      if (init && init !== next) throw new Error('清单中途更换初始化片段，已停止下载。');
      init = next;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) { pending = attributes(line); continue; }
    if (line.startsWith('#EXTINF:')) {
      segmentExpected = true; duration += Number(line.slice(8).split(',')[0]) || 0; continue;
    }
    if (line.startsWith('#')) continue;
    if (pending) {
      const [width, height] = (pending.RESOLUTION || '').split('x').map(Number);
      variants.push({ url: absolute(line, base), bandwidth: Number(pending.BANDWIDTH) || 0,
        averageBandwidth: Number(pending['AVERAGE-BANDWIDTH']) || 0,
        width: width || null, height: height || null, audioGroup: pending.AUDIO,
        requireAudio: /mp4a|aac/i.test(pending.CODECS || '') });
      pending = undefined;
    } else if (segmentExpected) { segments.push(absolute(line, base)); segmentExpected = false; }
    else throw new Error('HLS 清单结构不完整，已停止下载。');
  }
  if (pending || segmentExpected) throw new Error('HLS 清单缺少片段地址。');
  if (variants.length) {
    if (variants.length > 50) throw new Error('清晰度数量超过 50 个限制。');
    for (const variant of variants) {
      if (variant.audioGroup && !audio.has(variant.audioGroup)) throw new Error('独立音轨地址缺失，已停止下载。');
      variant.audioUrl = audio.get(variant.audioGroup);
      delete variant.audioGroup;
    }
    return { variants: variants.sort((a,b) => b.bandwidth - a.bandwidth) };
  }
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('暂不支持直播，只支持已经结束的点播视频。');
  if (!segments.length || segments.length > MAX_SEGMENTS) throw new Error('片段数量为空或超过 10000 个限制。');
  return { segments, init, duration, format: init ? 'MP4' : 'TS' };
}
async function fetchBytes(url, signal, limit, limitMessage = '清单超过 2 MiB 大小限制。', source) {
  const timed = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const response = await sourceFetch(url, { signal: timed, credentials: 'include' }, source);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}：视频请求失败，可能需要登录或地址已过期。`); }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new Error(limitMessage);
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(limitMessage);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, url: response.url };
}
async function manifest(url, signal, source) {
  const result = await fetchBytes(url, signal, 2 * 1024 * 1024, undefined, source);
  return parse(new TextDecoder().decode(result.bytes), result.url);
}
export async function inspectHls(url, signal = new AbortController().signal, pageUrl) {
  const source = { pageUrl };
  const parsed = await manifest(url, signal, source);
  if (!parsed.variants) return { variants: [], format: parsed.format };
  for (const variant of parsed.variants) {
    const child = await manifest(variant.url, signal, source);
    variant.format = child.format || '待检查';
    variant.duration = child.duration || 0;
  }
  return { variants: parsed.variants, format: parsed.variants[0].format };
}

function checkMp4Boxes(bytes, init) {
  const types = new Set(); let offset = 0; let dataPresent = false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) throw new Error('MP4 片段头不完整。');
      size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12); header = 16;
    } else if (size === 0) size = bytes.length - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length) throw new Error('MP4 片段数据损坏或不完整。');
    types.add(type); if (type === 'mdat' && size > header) dataPresent = true; offset += size;
  }
  if (offset !== bytes.length || (init ? !types.has('ftyp') || !types.has('moov') : !types.has('moof') || !types.has('mdat') || !dataPresent)) {
    throw new Error('服务器未返回有效的 fMP4 初始化数据或音画分片。');
  }
}
// Validate TS packet boundaries across network chunks without retaining a segment.
async function streamTs(url, signal, writer, onBytes, source) {
  const timed = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const response = await sourceFetch(url, { signal: timed, credentials: 'include' }, source);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}：视频请求失败，可能需要登录或地址已过期。`);
  }
  const reader = response.body.getReader(); let size = 0; let lastUpdate = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      for (let i = (188 - size % 188) % 188; i < value.length; i += 188) {
        if (value[i] !== 0x47) throw new Error('片段不是有效的 MPEG-TS 数据或已损坏，已停止下载。');
      }
      size += value.length;
      await writer.write(value);
      timed.throwIfAborted();
      if (performance.now() - lastUpdate >= 250) {
        lastUpdate = performance.now(); await onBytes(size);
      }
    }
    if (!size || size % 188) throw new Error('片段不是完整的 MPEG-TS 数据，已停止下载。');
    return size;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
// Remux the finished TS into MP4 without re-encoding. Any failure other than cancel keeps
// the complete TS, so the user never receives a partial file.
async function tsToMp4(tsFile, expected, signal, createFile) {
  const ts = await tsFile.handle.getFile();
  let mp4, reason;
  try {
    mp4 = await createFile('.mp4');
    reason = await remuxTsToMp4(ts, mp4.writer, signal);
    if (!reason) {
      const saved = await mp4.handle.getFile();
      const { seconds, lost } = await checkRemux(ts, saved, signal);
      if (lost) reason = `转换后音画数据不完整（${lost}）`;
      else if (expected > 0 && Math.abs(seconds - expected) > Math.max(2, expected * 0.03)) {
        reason = `转换后时长 ${seconds.toFixed(1)} 秒与清单的 ${expected.toFixed(1)} 秒不一致`;
      } else {
        await tsFile.remove().catch(() => {});
        return { blob: saved.slice(0, saved.size, 'video/mp4') };
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('TS remux failed', error);
    reason = error.name === 'QuotaExceededError' ? '浏览器临时磁盘空间不足，无法再写一份 MP4' : '转换 MP4 时出错';
  }
  await mp4?.remove().catch(() => {});
  return { blob: ts.slice(0, ts.size, 'video/mp2t'), note: `已保存为原始 TS：${reason}。` };
}
export async function downloadHls(url, signal, progress, selection = {}) {
  const source = { pageUrl: selection.pageUrl, jobId: selection.jobId };
  let parsed; let audioUrl = selection.audioUrl; let requireAudio = selection.requireAudio;
  const visited = new Set();
  for (let depth = 0; depth < 5; depth++) {
    if (visited.has(url)) throw new Error('HLS 清单出现循环引用。');
    visited.add(url); parsed = await manifest(url, signal, source);
    if (parsed.segments) break;
    const variant = parsed.variants[0]; url = variant.url;
    audioUrl = variant.audioUrl; requireAudio = variant.requireAudio;
  }
  if (!parsed?.segments) throw new Error('HLS 清单嵌套层级超过限制。');
  if (audioUrl && !parsed.init) throw new Error('目前不支持 MPEG-TS 独立音轨合并，已停止下载。');
  const audio = audioUrl ? await manifest(audioUrl, signal, source) : null;
  if (audio && (!audio.init || !audio.segments)) throw new Error('独立音轨不是受支持的 fMP4 点播清单。');
  const total = parsed.segments.length + (audio?.segments.length || 0);
  if (total > MAX_SEGMENTS) throw new Error('音画总片段数超过 10000 个限制。');
  if (audio && Math.abs(audio.duration - parsed.duration) > 1) throw new Error('音画清单时长不一致，已停止下载。');
  let size = 0, done = 0;
  await progress(done, total);
  if (!parsed.init) {
    const file = await selection.createFile('.ts');
    for (const segment of parsed.segments) {
      signal.throwIfAborted();
      size += await streamTs(segment, signal, file.writer, bytes => progress(done, total, undefined, size + bytes), source);
      await progress(++done, total, undefined, size);
    }
    signal.throwIfAborted();
    await file.writer.close();
    await progress(done, total, 'remuxing');
    return tsToMp4(file, parsed.duration, signal, selection.createFile);
  }
  async function collect(track) {
    const parts = [];
    if (track.init) {
      const result = await fetchBytes(track.init, signal, MAX_BYTES - size, 'fMP4 数据超过 256 MiB 合并内存限制。', source);
      checkMp4Boxes(result.bytes, true); size += result.bytes.length; parts.push(result.bytes);
    }
    for (const segment of track.segments) {
      signal.throwIfAborted();
      const { bytes } = await fetchBytes(segment, signal, MAX_BYTES - size, 'fMP4 数据超过 256 MiB 合并内存限制。', source);
      checkMp4Boxes(bytes, false);
      size += bytes.length; parts.push(bytes); await progress(++done, total, undefined, size);
    }
    return new Blob(parts, { type: 'video/mp4' });
  }
  const videoBlob = await collect(parsed);
  const audioBlob = audio ? await collect(audio) : null;
  signal.throwIfAborted();
  await progress(done, total, 'muxing');
  return { blob: await muxMp4(videoBlob, audioBlob, signal, requireAudio || Boolean(audio)) };
}
