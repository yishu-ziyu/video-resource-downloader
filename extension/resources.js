// Only group resources when a concrete relationship is known.
export function isXPost(value) {
  return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(value);
}

export function assetKey(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)twimg\.com$/.test(url.hostname)) return null;
    const match = url.pathname.match(/\/(ext_tw_video|amplify_video)(?:_thumb)?\/(\d+)(?:\/|$)/);
    return match ? `${match[1]}:${match[2]}` : null;
  } catch { return null; }
}

export function matchMedia(item, players) {
  const exact = players.find(player => player.urls.includes(item.url));
  if (exact) return exact;
  const key = assetKey(item.url);
  return key ? players.find(player => assetKey(player.poster) === key ||
    player.urls.some(url => assetKey(url) === key)) : undefined;
}

export function groupResources(items) {
  const parents = new Map();
  for (const item of items) {
    for (const variant of item.variants || []) parents.set(variant.url, item);
  }
  const groups = new Map();
  for (const item of items) {
    const parent = parents.get(item.url);
    const key = parent?.media?.key || (parent && assetKey(parent.url)) || parent?.url ||
      item.media?.key || assetKey(item.url) || item.url;
    if (!groups.has(key)) groups.set(key, { key, items: [], media: item.media });
    const group = groups.get(key);
    group.items.push(item);
    group.media ||= item.media;
  }
  return [...groups.values()].sort((a, b) => Number(Boolean(b.media)) - Number(Boolean(a.media)));
}

// Variant playlists are reached through their parent, so only roots are offered; direct files first.
export function rootItems(group) {
  const children = new Set(group.items.flatMap(item => (item.variants || []).map(variant => variant.url)));
  const items = [...group.items].sort((a, b) => Number(a.kind !== 'file') - Number(b.kind !== 'file'));
  const roots = items.filter(item => !children.has(item.url));
  // A malformed cyclic playlist must still offer one item.
  return roots.length ? roots : items.slice(0, 1);
}

// The card title and the saved filename both come from this name.
export function groupName(group) {
  return group.items.find(item => item.displayName)?.displayName || group.media?.title || group.items[0].name;
}

export function ownsJob(group, job) {
  return job.groupKey === group.key || group.items.some(item => item.url === (job.resourceUrl || job.url) ||
    item.variants?.some(variant => variant.url === job.url));
}
