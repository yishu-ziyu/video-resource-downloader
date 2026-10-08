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
  function scan() {
    const postId = /^(?:www\.)?(?:x|twitter)\.com$/.test(location.hostname) && location.pathname.match(/\/status\/(\d+)/)?.[1];
    const videos = [...document.querySelectorAll('video')].filter(video => !postId ||
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
        title: clean(label) || `${clean(document.title) || '网页视频'}${videos.length > 1 ? ` · 视频 ${index + 1}` : ''}`,
        poster: http(video.poster) ? video.poster : '',
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth, height: video.videoHeight };
    });
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
    const video = [...document.querySelectorAll('video')].find(video => ids.get(video) === message.id);
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
