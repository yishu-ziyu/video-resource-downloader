(() => {
  const ids = new WeakMap();
  let timer;
  let previous = '';
  let pageUrl = location.href;
  let menuVideo = null;
  document.addEventListener('contextmenu', event => {
    menuVideo = event.target instanceof Element ? event.target.closest('video') : null;
  }, true);
  const http = value => /^https?:\/\//.test(value || '');
  const clean = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  // Douyin SSR keeps every aweme's signed media addresses in #RENDER_DATA. The file
  // segment in those URLs matches the player's CDN requests even though the video
  // element itself only exposes a blob: source.
  let renderText = null;
  let renderAwemes = [];
  function awemes() {
    const script = document.getElementById('RENDER_DATA');
    const text = script?.textContent || '';
    if (text === renderText) return renderAwemes;
    renderText = text;
    renderAwemes = [];
    if (!text) return renderAwemes;
    try {
      const seen = new Set();
      const pull = (urls, value) => {
        if (typeof value === 'string') {
          if (http(value) && value.includes('/video/tos/')) urls.add(value);
        } else if (Array.isArray(value)) value.forEach(item => pull(urls, item));
        else if (value && typeof value === 'object') for (const item of Object.values(value)) pull(urls, item);
      };
      const visit = node => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) { for (const item of node) visit(item); return; }
        const video = node.video;
        if (typeof node.awemeId === 'string' && video && typeof video === 'object') {
          const urls = new Set();
          for (const key of ['playAddr', 'playAddrH265', 'bitRateList', 'bitRateAudioList']) pull(urls, video[key]);
          if (urls.size && Number.isFinite(video.duration)) {
            const cover = [video.cover, video.coverUrlList?.[0], video.originCover].find(http);
            renderAwemes.push({
              duration: video.duration / 1000, title: clean(node.desc || node.caption || ''),
              poster: cover || '', urls: [...urls],
            });
          }
        }
        // Image posts carry aweme.images[] (each with urlList) instead of video tracks.
        if (typeof node.awemeId === 'string' && !node.video && Array.isArray(node.images)) {
          const urls = [], names = {};
          node.images.forEach((image, index) => {
            for (const url of image?.urlList || []) if (http(url)) { urls.push(url); names[url] ||= `图片 ${index + 1}`; }
          });
          if (urls.length) renderAwemes.push({ imageNote: true, duration: null,
            title: clean(node.desc || node.caption || ''), poster: urls[0], urls, names });
        }
        for (const value of Object.values(node)) visit(value);
      };
      visit(JSON.parse(decodeURIComponent(text)));
    } catch { renderAwemes = []; }
    return renderAwemes;
  }
  // Page globals are invisible in the isolated world, but Bilibili and Xiaohongshu
  // embed them as `window.KEY={json}` inline scripts. Extract the balanced object.
  function inlineJson(marker) {
    for (const script of document.scripts) {
      const text = script.textContent;
      const at = text.indexOf(marker);
      if (at < 0) continue;
      const start = text.indexOf('{', at + marker.length);
      if (start < 0) continue;
      let depth = 0, inString = false, escape = false, end = -1;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) { end = i + 1; break; }
      }
      if (end <= start) return null;
      try { return JSON.parse(text.slice(start, end)); }
      catch { try { return JSON.parse(jsToJson(text.slice(start, end))); } catch { return null; } }
    }
    return null;
  }
  // Page state is serialized as a JS literal, not JSON: raw `undefined`, `NaN`,
  // `Infinity`, and constructor calls like `new Map([])` must be sanitized first.
  function jsToJson(body) {
    let out = '', i = 0, inString = false, escape = false;
    while (i < body.length) {
      const ch = body[i];
      if (escape) { out += ch; escape = false; i++; continue; }
      if (inString) { out += ch; if (ch === '\\') escape = true; else if (ch === '"') inString = false; i++; continue; }
      if (ch === '"') { inString = true; out += ch; i++; continue; }
      const cons = body.slice(i).match(/^new\s+[A-Za-z_$][\w$]*\s*\(/);
      if (cons) {
        let j = i + cons[0].length - 1, depth = 0, s2 = false, e2 = false;
        for (; j < body.length; j++) {
          const c2 = body[j];
          if (e2) { e2 = false; continue; }
          if (c2 === '\\') { e2 = true; continue; }
          if (c2 === '"') { s2 = !s2; continue; }
          if (s2) continue;
          if (c2 === '(') depth++;
          else if (c2 === ')' && --depth === 0) { j++; break; }
        }
        out += 'null'; i = j; continue;
      }
      const lit = body.slice(i).match(/^(?:undefined|NaN|-?Infinity)(?![\w$])/);
      if (lit) { out += 'null'; i += lit[0].length; continue; }
      out += ch; i++;
    }
    return out;
  }
  // Bilibili serves split DASH tracks; playinfo lists every quality's video and audio
  // baseUrl plus backups. og meta tags carry the title and cover. The m4s code in a
  // track URL does not map to quality or codec, so names travel with the page data.
  function biliMedia() {
    const info = inlineJson('window.__playinfo__')?.data;
    if (!info) return [];
    const urls = new Set();
    const names = {};
    const qn = id => ({ 6: '240P', 15: '360P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
      80: '1080P', 112: '1080P+', 116: '1080P60', 117: '1080P60', 120: '4K', 121: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K' })[id];
    const codec = tag => /^avc/i.test(tag) ? '' : /^(hvc|hev)/i.test(tag) ? ' HEVC' : /^av0/i.test(tag) ? ' AV1' : '';
    const pull = (track, label) => {
      for (const url of [track?.baseUrl, track?.base_url, ...(track?.backup_url || track?.backupUrl || [])]) {
        if (http(url)) { urls.add(url); names[url] ||= label; }
      }
    };
    (info.dash?.video || []).forEach(track =>
      pull(track, `视频轨${qn(track.id) ? ` ${qn(track.id)}` : ''}${codec(track.codecs || '')}`));
    (info.dash?.audio || []).forEach(track =>
      pull(track, `音频轨${track.bandwidth ? ` ${Math.round(track.bandwidth / 1000)}k` : ''}`));
    (info.durl || []).forEach(track => pull(track, '视频'));
    const duration = info.dash?.duration ?? info.timelength / 1000;
    if (!urls.size || !Number.isFinite(duration)) return [];
    const title = document.querySelector('meta[name="title"]')?.content ||
      document.querySelector('meta[property="og:title"]')?.content || '';
    const poster = document.querySelector('meta[property="og:image"]')?.content || '';
    return [{ duration, title: clean(title.replace(/_哔哩哔哩.*$/, '')), poster: http(poster) ? poster : '', urls: [...urls], names }];
  }
  // Xiaohongshu notes carry muxed MP4 streams plus the fMP4 tracks the player
  // actually fetches; stream lists are keyed EF4/EF5/… rather than by codec.
  // Hydrated pages keep an empty noteDetailMap in the script text; page-state.js
  // (main world) relays the live map instead.
  function xhsMedia(liveMap) {
    const map = liveMap || inlineJson('window.__INITIAL_STATE__')?.note?.noteDetailMap;
    if (!map || typeof map !== 'object') return [];
    const out = [];
    const codec = tag => /^(h264|avc1)$/i.test(tag) ? 'H.264' : /^(h265|hevc|hev1|h266|vvc)$/i.test(tag) ? 'H.265' :
      /^av0?1$/i.test(tag) ? 'AV1' : '';
    for (const entry of Object.values(map)) {
      const note = entry?.note;
      const streams = note?.video?.media?.stream;
      const urls = new Set();
      const names = {};
      let duration = 0;
      if (streams && typeof streams === 'object') {
        for (const list of Object.values(streams)) {
          if (!Array.isArray(list)) continue;
          for (const stream of list) {
            const label = [stream?.height ? `${stream.height}P` : '', codec(stream?.videoCodec)]
              .filter(Boolean).join(' ') || '视频';
            for (const raw of [stream?.masterUrl, ...(stream?.backupUrls || [])]) {
              // Chrome upgrades http subresources on https pages, so the request is https.
              const url = typeof raw === 'string' && location.protocol === 'https:' ? raw.replace(/^http:\/\//, 'https://') : raw;
              if (http(url)) { urls.add(url); if (label) names[url] ||= label; }
            }
            duration ||= (stream?.videoDuration || stream?.duration || 0) / 1000;
          }
        }
      }
      const poster = note.imageList?.[0]?.urlDefault || '';
      const noteDuration = note.video?.duration > 10000 ? note.video.duration / 1000 : note.video?.duration || 0;
      if (urls.size) {
        out.push({ duration: duration || noteDuration,
          title: clean(note.title || note.desc || ''), poster: http(poster) ? poster : '', urls: [...urls], names });
        continue;
      }
      // Image notes have no stream; their imageList becomes the downloadable set.
      const imgUrls = [], imgNames = {};
      (note.imageList || []).forEach((image, index) => {
        for (const url of [image?.urlDefault, image?.urlPre, ...(image?.infoList || []).map(info => info?.url)]) {
          if (http(url)) { imgUrls.push(url); imgNames[url] ||= `图片 ${index + 1}`; }
        }
      });
      if (imgUrls.length) out.push({ imageNote: true, duration: null,
        title: clean(note.title || note.desc || ''), poster: imgUrls[0], urls: imgUrls, names: imgNames });
    }
    return out;
  }
  // Site adapters: each produces {title, poster, duration, urls, names, imageNote}
  // from page data. `relay` names the postMessage channel a main-world script
  // feeds (see page-state.js); scan() knows no site by name, so a new site is
  // one entry here plus its manifest content-script entry when it needs a relay.
  const siteAdapters = [
    { name: 'douyin', extract: awemes },
    { name: 'bilibili', extract: biliMedia },
    { name: 'xiaohongshu', extract: xhsMedia, relay: 'vdr-xhs-state' },
  ];
  const relayData = new Map();
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const site = siteAdapters.find(adapter => adapter.relay === event.data?.type);
    if (!site || typeof event.data.notes !== 'object' || !event.data.notes) return;
    relayData.set(site.name, event.data.notes);
    schedule();
  });
  // Each extractor keys off its own data marker, so all of them can run everywhere.
  // One bad adapter must not take the others down.
  function siteMedia() {
    return siteAdapters.flatMap(site => {
      try { return site.extract(relayData.get(site.name)); } catch { return []; }
    });
  }
  function scan() {
    const postId = /^(?:www\.)?(?:x|twitter)\.com$/.test(location.hostname) && location.pathname.match(/\/status\/(\d+)/)?.[1];
    const videos = [...document.querySelectorAll('video, audio')].filter(video => !postId ||
      [...(video.closest('article')?.querySelectorAll('a[href]') || [])].some(link =>
        new URL(link.href, location.href).pathname.match(/\/status\/(\d+)(?:\/|$)/)?.[1] === postId)).slice(0, 100);
    const players = videos.map((video, index) => {
      if (!ids.has(video)) ids.set(video, crypto.randomUUID());
      const container = video.closest('article, figure, [data-video-title]');
      const explicit = video.getAttribute('aria-label') || video.getAttribute('title');
      const caption = container?.getAttribute('data-video-title') ||
        container?.querySelector('[data-testid="tweetText"], figcaption, h1, h2, h3')?.textContent;
      const label = explicit && !/^(embedded video|video(?: player)?|嵌入视频|视频(?:播放器)?)$/i.test(explicit.trim()) ? explicit : caption;
      const urls = [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(source => source.src)]
        .filter(http);
      return { id: ids.get(video), urls: [...new Set(urls)],
        title: clean(label) || `${clean(document.title) || '网页视频'}${videos.length > 1 ? ` · ${video.tagName === 'AUDIO' ? '音频' : '视频'} ${index + 1}` : ''}`,
        poster: http(video.poster) ? video.poster : '',
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth, height: video.videoHeight };
    });
    // Attach page media only when its duration is a unique match for that element,
    // so a preloaded neighbour cannot take over the playing video's data.
    const media = siteMedia();
    const bound = new Set();
    for (const player of players) {
      const found = media.filter(aweme => !bound.has(aweme) && Number.isFinite(aweme.duration) &&
        Number.isFinite(player.duration) && Math.abs(aweme.duration - player.duration) <= 1.5);
      if (found.length !== 1) continue;
      const [aweme] = found;
      bound.add(aweme);
      if (aweme.title) player.title = aweme.title;
      if (aweme.poster && !player.poster) player.poster = aweme.poster;
      if (aweme.names) player.names = { ...aweme.names };
      // Track-level identity comes from media-taxonomy.js (loaded before this script).
      const { mediaKey } = globalThis.VDR_TAXONOMY;
      const seen = new Set(player.urls.map(mediaKey));
      for (const url of aweme.urls) {
        // Mirrors share a file segment; keep one address per media track, not per host.
        const key = mediaKey(url);
        if (seen.has(key) || seen.size >= 20) continue;
        seen.add(key); player.urls.push(url);
      }
    }
    // Image notes have no media element; register their image set as a synthetic
    // player so the card carries the note title, cover and labelled options.
    for (const extra of media.filter(entry => entry.imageNote)) {
      players.push({ id: `imgnote:${(extra.urls[0] || '').slice(-40)}`, urls: extra.urls,
        names: extra.names, title: extra.title || '图片', poster: extra.poster || '',
        duration: null, width: 0, height: 0, image: true });
    }
    const snapshot = JSON.stringify([location.href, players]);
    if (snapshot === previous) return;
    previous = snapshot;
    chrome.runtime.sendMessage({ type: 'media', pageUrl: location.href, players }).catch(() => { previous = ''; });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(scan, 200); }
  window.navigation.addEventListener('currententrychange', () => {
    if (location.href === pageUrl) return;
    pageUrl = location.href;
    previous = '';
    if (window === window.top) chrome.runtime.sendMessage({ type: 'page', pageUrl }).catch(() => {});
    schedule();
  });
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['src', 'poster', 'aria-label', 'title'],
  });
  for (const event of ['loadedmetadata', 'durationchange', 'play', 'emptied']) document.addEventListener(event, scan, true);
  window.addEventListener('pageshow', () => { previous = ''; scan(); });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'page-changed') { previous = ''; schedule(); return; }
    if (message.type === 'context-target') { respond({ id: menuVideo ? ids.get(menuVideo) : null }); return; }
    if (message.type !== 'locate') return;
    const video = [...document.querySelectorAll('video, audio')].find(video => ids.get(video) === message.id);
    if (!video) { respond({ ok: false, error: '视频已离开网页，请刷新资源列表。' }); return; }
    video.scrollIntoView({ block: 'center', behavior: 'instant' });
    const outline = video.style.outline;
    video.style.outline = '3px solid #2563eb';
    video.setAttribute('data-downloader-highlight', '');
    setTimeout(() => { video.style.outline = outline; video.removeAttribute('data-downloader-highlight'); }, 2500);
    respond({ ok: true });
  });
  scan();
})();
