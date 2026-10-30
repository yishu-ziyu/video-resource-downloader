// Xiaohongshu fills noteDetailMap after hydration, so the serialized script text
// stays empty. Running in the main world lets us read the live object and relay
// a slim copy to the isolated content script via postMessage.
(() => {
  const TYPE = 'vdr-xhs-state';
  let last = '';
  const emit = () => { try {
    const map = window.__INITIAL_STATE__?.note?.noteDetailMap;
    if (!map || typeof map !== 'object') return;
    const notes = {};
    for (const [key, entry] of Object.entries(map)) {
      const note = entry?.note;
      // Video notes carry streams; image notes carry imageList. Relay both.
      if (!note?.video?.media?.stream && !(note?.imageList || []).length) continue;
      notes[key] = { note: {
        title: note.title, desc: note.desc, type: note.type,
        video: note.video ? { duration: note.video.duration, media: { stream: note.video.media?.stream } } : undefined,
        imageList: (note.imageList || []).map(image => ({ urlDefault: image?.urlDefault, urlPre: image?.urlPre,
          infoList: (image?.infoList || []).map(info => ({ url: info?.url })) })),
      } };
    }
    const json = JSON.stringify(notes);
    if (!Object.keys(notes).length || json === last) return;
    last = json;
    window.postMessage({ type: TYPE, notes }, location.origin);
  } catch {} };
  emit();
  setInterval(emit, 1500);
})();
