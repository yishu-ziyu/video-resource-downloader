// 媒体知识中枢：唯一知道「URL 是什么媒体、属于哪个站、该叫什么名」的地方。
// 经典脚本而非 ES 模块——内容脚本无法加载模块，本文件在 manifest 中先于
// content.js 注册；service worker、resources.js 与 popup 用副作用 import
// 加载同一全局，保证三个上下文读到同一份规则。
(() => {
  const parse = value => { try { return new URL(value); } catch { return null; } };

  function isXPost(value) {
    return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(value);
  }

  // 媒体身份：页面数据与网络请求的同一媒体资源的公共键（跨 host/签名/参数）。
  function assetKey(value) {
    try {
      const url = new URL(value);
      if (/(^|\.)twimg\.com$/.test(url.hostname)) {
        const match = url.pathname.match(/\/(ext_tw_video|amplify_video)(?:_thumb)?\/(\d+)(?:\/|$)/);
        return match ? `${match[1]}:${match[2]}` : null;
      }
      // Douyin splits playback into media-video-*/media-audio-* MP4 tracks. The file
      // segment stays identical between page data and signed CDN requests even when
      // hosts, signatures and query parameters differ.
      const douyin = url.pathname.match(/\/video\/tos\/[^/]+\/[^/]+\/([^/]+)(?:\/media-[^/]+)?\/?$/);
      if (douyin) return `dy:${douyin[1]}`;
      // Bilibili DASH tracks share one media id; the trailing code picks track+quality.
      const bili = url.pathname.match(/\/upgcxcode\/.*?(\d+)-\d+-\d+\.m4s$/);
      if (bili) return `bili:${bili[1]}`;
      // Xiaohongshu stream files: file id + quality type; master and backup hosts mirror.
      // EF4 lists carry complete mp4s, EF5 lists the fMP4 tracks the player fetches.
      if (/(^|\.)xhscdn\.com$/.test(url.hostname)) {
        const xhs = url.pathname.match(/\/stream\/\d+\/\d+\/\d+\/([0-9a-f]+_\d+)\.(mp4|m4s)$/i);
        if (xhs) return `xhs:${xhs[1]}.${xhs[2].toLowerCase()}`;
      }
      return null;
    } catch { return null; }
  }

  // 轨道级地址键：同一轨道的镜像地址归一键，用于注入地址去重（保留不同清晰度）。
  const mediaKey = url =>
    url.match(/\/video\/tos\/[^/]+\/[^/]+\/[^/]+\/media-[^/]+|\/video\/tos\/[^/]+\/[^/]+\/[^/]+|\/upgcxcode\/[^?]+|\/stream\/\d+\/\d+\/\d+\/[^/?]+/)?.[0] || url;

  const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|ogv)$/;
  const AUDIO_RE = /\.(mp3|m4a|wav|ogg|oga|flac|opus|weba)$/;
  const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico)$/;
  // 已知媒体后缀并集：文件命名与格式展示共用。aac/ico 不在 kindOf 音频判定里
  //（aac 先被分片规则拦截），但作为已知后缀应保留而非落到 .bin。
  const MEDIA_EXT_RE = /\.(mp4|webm|mov|mkv|m4v|ogv|mp3|m4a|wav|ogg|oga|flac|opus|weba|aac|jpe?g|png|gif|webp|avif|bmp|svg|ico)$/i;
  const STRIP_EXT_RE = /\.(mp4|webm|mov|mkv|m4v|ogv|mp3|m4a|wav|ogg|oga|flac|opus|weba|aac|jpe?g|png|gif|webp|avif|bmp|svg|ico|ts|m3u8|bin)$/i;

  // Bilibili upgcxcode and Xiaohongshu /stream/ .m4s files are whole MP4 tracks, not HLS segments.
  const isBiliTrack = parsed => /\/upgcxcode\//.test(parsed?.pathname || '');
  const isXhsM4s = parsed => /\.m4s$/.test(parsed?.pathname || '') && /(^|\.)xhscdn\.com$/.test(parsed?.hostname || '');

  function kindOf(url, mime = '') {
    const parsedUrl = parse(url);
    if (!parsedUrl) return null;
    const pathname = parsedUrl.pathname.toLowerCase();
    if (parsedUrl.hostname === 'video.twimg.com' && /^\/(?:amplify_video|ext_tw_video)\/\d+\/(?:pu\/)?(?:aud\/|vid\/(?:avc1|hevc)\/0\/0\/|pl\/(?:mp4a|avc1|hevc|s\d+)\/)/.test(pathname)) return null;
    if (isBiliTrack(parsedUrl) || isXhsM4s(parsedUrl)) return 'file';
    if (/\.(ts|m4s|aac|key)$/.test(pathname) || /mp2t|iso.segment/.test(mime)) return null;
    if (/\.m3u8$/.test(pathname) || /mpegurl/i.test(mime)) return 'hls';
    if (/\.mpd$/.test(pathname) || /dash\+xml/i.test(mime)) return 'dash';
    if (VIDEO_RE.test(pathname) || /^video\//i.test(mime)) return 'file';
    if (AUDIO_RE.test(pathname) || /^audio\//i.test(mime)) return 'audio';
    if (IMAGE_RE.test(pathname) || /^image\//i.test(mime)) return 'image';
    return null;
  }

  // Douyin track addresses carry their type in the query when the path has no suffix.
  const mimeHintOf = url => /[?&]mime_type=video_mp4(?:&|$)/.test(url) ? 'video/mp4' : '';

  function resourceName(url) {
    const pathname = parse(url)?.pathname || '';
    // Douyin media URLs end in a track segment: media-video-avc1, media-audio-und-mp4a.
    // One codec can offer several bitrates; the br param tells them apart.
    const track = pathname.match(/\/media-(video|audio)-([a-z0-9]+)/i);
    if (track) {
      const br = parse(url)?.searchParams.get('br');
      const base = track[1].toLowerCase() === 'audio' ? '音频轨' : `视频轨 ${track[2].toUpperCase()}`;
      return br ? `${base} ${br}k` : base;
    }
    // Bilibili tracks encode track+quality: {id}-{part}-{code}.m4s; audio ids are 302xx.
    const bili = pathname.match(/\/upgcxcode\/.*?(\d+)-\d+-\d+\.m4s$/);
    if (bili) {
      const code = +pathname.match(/-(\d+)\.m4s$/)[1];
      if ([30216, 30232, 30250, 30251, 30255, 30280, 30350, 30380].includes(code)) return '音频轨';
      const qn = { 16: '360P', 32: '480P', 64: '720P', 80: '1080P', 112: '1080P+', 116: '1080P60', 117: '1080P60', 120: '4K', 121: '4K', 127: '8K' }[code >= 30000 && code < 40000 ? code - 30000 : code];
      return qn ? `视频轨 ${qn}` : '视频轨';
    }
    try { return decodeURIComponent(pathname.split('/').pop()) || 'video'; }
    catch { return pathname.split('/').pop() || 'video'; }
  }

  const MIME_SUFFIX = [/^(?:audio\/mpeg|audio\/mp3)$/i, '.mp3', /^(?:audio\/mp4|audio\/x-m4a)$/i, '.m4a',
    /^audio\/(?:ogg|x-ogg|oga)$/i, '.ogg', /^audio\/(?:wav|x-wav|wave)$/i, '.wav', /^audio\/flac/i, '.flac',
    /^audio\/opus/i, '.opus', /^audio\/webm/i, '.weba', /^audio\/aac/i, '.aac',
    /^image\/jpe?g$/i, '.jpg', /^image\/png$/i, '.png', /^image\/webp$/i, '.webp', /^image\/gif$/i, '.gif',
    /^image\/avif$/i, '.avif', /^image\/bmp$/i, '.bmp', /^image\/svg$/i, '.svg',
    /webm/i, '.webm', /quicktime/i, '.mov', /matroska/i, '.mkv', /ogg/i, '.ogv', /mp4/i, '.mp4'];

  function suffixFor(item, forcedExt) {
    const parsed = parse(item.url);
    const sourceSuffix = parsed?.pathname.match(MEDIA_EXT_RE)?.[0];
    if (forcedExt || sourceSuffix) return forcedExt || sourceSuffix;
    if (parsed && (isBiliTrack(parsed) || isXhsM4s(parsed))) return '.mp4';
    const index = MIME_SUFFIX.findIndex((entry, i) => i % 2 === 0 && entry.test(item.mime || ''));
    if (index >= 0) return MIME_SUFFIX[index + 1];
    return item.kind === 'image' ? '.jpg' : '.bin';
  }

  function filename(item, extension) {
    let name = item.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'video';
    name = name.replace(STRIP_EXT_RE, '') + suffixFor(item, extension);
    return `VideoDownloads/${name}`;
  }

  // TS and fMP4 HLS both save as MP4; TS is kept only when MP4 cannot hold its codecs unchanged.
  const hlsOutput = format => format === 'TS' ? 'MP4' : format || '待检查';

  function format(item) {
    if (item.kind === 'hls') return hlsOutput(item.format);
    if (item.kind === 'dash') return 'DASH · 暂不支持';
    const parsed = parse(item.url);
    const suffix = parsed?.pathname.match(MEDIA_EXT_RE)?.[1];
    if (suffix) return suffix.toUpperCase().replace(/^JPEG$/, 'JPG');
    if (item.kind === 'image') {
      const type = item.mime?.match(/^image\/([\w.+-]+)/)?.[1];
      return type ? type.toUpperCase().replace(/^JPEG$/, 'JPG') : '图片';
    }
    if (item.kind === 'audio') {
      const type = item.mime?.match(/^audio\/([\w.+-]+)/)?.[1];
      return type ? type.toUpperCase().replace(/^MPEG$/, 'MP3').replace(/^X-M4A$/, 'M4A').replace(/^MP4$/, 'M4A') : '音频';
    }
    return isBiliTrack(parsed) || isXhsM4s(parsed) ||
      /mp4/i.test(item.mime) ? 'MP4' : /webm/i.test(item.mime) ? 'WEBM' : '原文件';
  }

  function isAudioItem(item) {
    return item.kind === 'audio' || /^audio\//.test(item.mime || '') || /^音频轨/.test(item.name);
  }

  // Direct kinds save through chrome.downloads without HLS processing or MP4 validation.
  const isDirect = item => item.kind === 'file' || item.kind === 'audio' || item.kind === 'image';

  globalThis.VDR_TAXONOMY = { isXPost, assetKey, mediaKey, kindOf, mimeHintOf, resourceName,
    suffixFor, filename, format, hlsOutput, isAudioItem, isDirect };
})();
