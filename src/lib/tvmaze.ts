import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * TVMaze 每日排期数据获取（公开 REST API，免 key）。
 * api.tvmaze.com/schedule?country=US 返回今日在播剧集（含剧集信息），
 * 2026-10-25 实测可用；内容为欧美剧、英文标题。
 * 同一剧同日可能有多集，按 show.id 去重后取首个条目。
 */

const TVMAZE_API = 'https://api.tvmaze.com/schedule';
const CACHE_TTL = 60 * 60 * 1000;
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';

export interface TvmazeEpisodeRaw {
  id?: number;
  show?: {
    id?: number;
    name?: string;
    image?: { medium?: string | null; original?: string | null };
    rating?: { average?: number | null };
  };
}

/** 单条排期 → DoubanItem（以剧为单位）；缺剧 id/剧名/封面丢弃 */
export function tvmazeEpisodeToItem(raw: TvmazeEpisodeRaw): DoubanItem | undefined {
  const show = raw.show;
  const cover = show?.image?.medium || show?.image?.original;
  if (!show?.id || !show.name || !cover) return undefined;
  const rating = show.rating?.average && show.rating.average > 0 ? String(show.rating.average) : undefined;
  return { id: `tvmaze_${show.id}`, title: show.name, cover, rating, isTv: true };
}

export async function fetchTvmazeSchedule(limit = 50): Promise<DoubanItem[]> {
  const cacheKey = `tvmaze-schedule:${limit}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  const target = `${TVMAZE_API}?country=US`;
  const res = await fetchUpstream(target, {
    timeoutMs: 10000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TVMaze 接口响应异常 (${res.status})`);

  const data = (await res.json()) as TvmazeEpisodeRaw[];
  if (!Array.isArray(data)) throw new Error('TVMaze 数据异常');

  // 同一剧同日多集只保留首条，避免重复卡片
  const byShow = new Map<number, DoubanItem>();
  for (const ep of data) {
    const item = tvmazeEpisodeToItem(ep);
    if (!item) continue;
    const showId = Number(item.id.replace(/^tvmaze_/, ''));
    if (!byShow.has(showId)) byShow.set(showId, item);
  }

  const items = Array.from(byShow.values()).slice(0, limit);
  if (items.length === 0) throw new Error('TVMaze 排期数据为空');

  setCache(cacheKey, items, CACHE_TTL);
  return items;
}
