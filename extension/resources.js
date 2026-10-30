// Only group resources when a concrete relationship is known.
// Site identity, audio detection and URL classification live in media-taxonomy.js.
import './media-taxonomy.js';
const { assetKey, isAudioItem } = globalThis.VDR_TAXONOMY;

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
  // Complete video files first; a track or sibling file must not become the
  // default choice for a video. Rank: file > hls/dash > audio > image.
  const rank = kind => ({ file: 0, hls: 1, dash: 1, audio: 2, image: 3 })[kind] ?? 4;
  // Bound items follow the page's own order (quality lists, image index);
  // network arrival order is not meaningful.
  const pageOrder = item => {
    const index = group.media?.urls?.indexOf(item.url) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const items = [...group.items].sort((a, b) =>
    rank(a.kind) - rank(b.kind) ||
    pageOrder(a) - pageOrder(b) ||
    Number(isAudioItem(a)) - Number(isAudioItem(b)) ||
    Number(/\.m4s(\?|#|$)/.test(a.url)) - Number(/\.m4s(\?|#|$)/.test(b.url)));
  // Two options with the same label cannot be told apart; keep the first
  // (best-sorted) variant and let different labels stay selectable.
  const seen = new Set();
  const roots = items.filter(item => {
    if (children.has(item.url)) return false;
    const key = `${item.kind}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // A malformed cyclic playlist must still offer one item.
  return roots.length ? roots : items.slice(0, 1);
}

// The card title and the saved filename both come from this name.
export function groupName(group) {
  return group.items.find(item => item.displayName)?.displayName || group.media?.title ||
    (group.items.find(item => !isAudioItem(item)) || group.items[0]).name;
}

export function ownsJob(group, job) {
  return job.groupKey === group.key || group.items.some(item => item.url === (job.resourceUrl || job.url) ||
    item.variants?.some(variant => variant.url === job.url));
}
