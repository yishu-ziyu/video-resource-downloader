// MP4 helper, bundled with Mediabunny under MPL-2.0. No decoding or re-encoding.
import { Input, MP4, MPEG_TS, BlobSource, UrlSource, EncodedPacketSink, Output, Mp4OutputFormat,
  BufferTarget, StreamTarget, Conversion, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';

// Conversion re-encodes codecs the output cannot hold; only these are copied into MP4 unchanged.
const COPYABLE = { video: ['avc', 'hevc'], audio: ['aac', 'mp3', 'ac3', 'eac3'] };

// Copies MPEG-TS packets into MP4 on disk. Returns a reason instead of converting when MP4
// cannot hold the stream unchanged; the caller then keeps the original TS.
export async function remuxTsToMp4(tsFile, writable, signal) {
  const input = new Input({ source: new BlobSource(tsFile), formats: [MPEG_TS] });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true }) });
  const decline = async reason => { await output.cancel(); return reason; };
  try {
    const tracks = await input.getTracks();
    if (!tracks.some(track => track.isVideoTrack())) return decline('没有找到视频轨道');
    for (const track of tracks) {
      const codec = await track.getCodec();
      if (!COPYABLE[track.type]?.includes(codec)) return decline(`${codec || '未知'} 编码不能原样放入 MP4`);
    }
    // 'forced' discards instead of transcoding, so any non-copyable track becomes a decline below.
    const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' }, showWarnings: false });
    if (!conversion.isValid || conversion.discardedTracks.length) return decline('部分音画轨道不能原样放入 MP4');
    const cancel = () => void conversion.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try { signal.throwIfAborted(); await conversion.execute(); }
    finally { signal.removeEventListener('abort', cancel); }
    signal.throwIfAborted();
    return null;
  } catch (error) { await output.cancel().catch(() => {}); throw error; }
  finally { input.dispose(); }
}

async function packetCounts(input, signal) {
  const counts = [];
  for (const track of await input.getTracks()) {
    let count = 0;
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      signal.throwIfAborted(); count++;
    }
    counts.push(`${track.type}:${count}`);
  }
  return counts.sort().join(', ');
}

// Every TS packet must reach the MP4: duration alone misses a track that lost packets midway.
export async function checkRemux(tsFile, mp4File, signal) {
  const ts = new Input({ source: new BlobSource(tsFile), formats: [MPEG_TS] });
  const mp4 = new Input({ source: new BlobSource(mp4File), formats: [MP4] });
  try {
    const [before, after] = [await packetCounts(ts, signal), await packetCounts(mp4, signal)];
    return { seconds: await mp4.computeDuration(), lost: before === after ? null : `数据包 ${before} → ${after}` };
  } finally { ts.dispose(); mp4.dispose(); }
}

export async function validateMp4File(url, signal) {
  const timed = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const input = new Input({ formats: [MP4], source: new UrlSource(url, {
    requestInit: { credentials: 'include' }, getRetryDelay: () => null,
    maxCacheSize: 4 * 1024 * 1024, parallelism: 1,
    fetchFn: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([timed, ...(init?.signal ? [init.signal] : [])]) }),
  }) });
  const abort = () => input.dispose();
  timed.addEventListener('abort', abort, { once: true });
  try {
    timed.throwIfAborted();
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await new EncodedPacketSink(video).getFirstPacket())) {
      throw new Error('这不是完整视频，可能只是音轨或初始化片段。请下载对应的 HLS 主清单。');
    }
  } finally { timed.removeEventListener('abort', abort); input.dispose(); }
}

export async function muxMp4(videoBlob, audioBlob, signal, requireAudio = false) {
  const inputs = [new Input({ source: new BlobSource(videoBlob), formats: [MP4] })];
  if (audioBlob) inputs.push(new Input({ source: new BlobSource(audioBlob), formats: [MP4] }));
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  try {
    signal.throwIfAborted();
    const video = await inputs[0].getPrimaryVideoTrack();
    const audio = await inputs[inputs.length - 1].getPrimaryAudioTrack();
    if (!video || (requireAudio && !audio)) throw new Error('视频或音轨缺失，未保存不完整文件。');
    if (await video.getCodec() !== 'avc' || (audio && await audio.getCodec() !== 'aac')) {
      throw new Error('目前只支持 H.264 / AAC 的 fMP4 音画合并，未保存不支持的格式。');
    }
    const tracks = [];
    for (const [track, type] of [[video, 'video'], [audio, 'audio']]) {
      if (!track) continue;
      const sink = new EncodedPacketSink(track);
      const first = await sink.getFirstPacket();
      if (!first) throw new Error('片段中没有实际音画数据，未保存不完整文件。');
      const source = type === 'video' ? new EncodedVideoPacketSource('avc') : new EncodedAudioPacketSource('aac');
      const decoderConfig = await track.getDecoderConfig();
      if (type === 'video') output.addVideoTrack(source); else output.addAudioTrack(source);
      tracks.push({ source, sink, first, decoderConfig });
    }
    await output.start();
    await Promise.all(tracks.map(async ({ source, sink, first, decoderConfig }) => {
      let firstPacket = true;
      for await (const packet of sink.packets(first)) {
        signal.throwIfAborted();
        await source.add(packet, firstPacket ? { decoderConfig } : undefined);
        firstPacket = false;
      }
      source.close();
    }));
    signal.throwIfAborted();
    await output.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } catch (error) { await output.cancel().catch(() => {}); throw error; }
  finally { for (const input of inputs) input.dispose(); }
}
