import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * AniList 动漫趋势榜数据获取（GraphQL POST，公开接口免 key）。
 * https://graphql.anilist.co，查询 TRENDING_DESC 的 ANIME 媒体，2026-10-25 实测可用。
 * 标题取英文/罗马音（原生日文对多数用户可读性差），封面 anilistcdn.net 无防盗链。
 * 注意：该接口仅支持 POST JSON；GET 请求会 400。
 */

const ANILIST_API = 'https://graphql.anilist.co';
const CACHE_TTL = 60 * 60 * 1000;

const QUERY = `
query($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(sort: TRENDING_DESC, type: ANIME) {
      id
      title { native romaji english }
      coverImage { large }
      averageScore
    }
  }
}`;

export interface AniMediaRaw {
  id?: number;
  title?: { native?: string | null; romaji?: string | null; english?: string | null };
  coverImage?: { large?: string | null };
  /** 0-100 分；空/null 表示暂无评分 */
  averageScore?: number | null;
}

export interface AniListResponse {
  data?: { Page?: { media?: AniMediaRaw[] } };
}

/** 单条 media → DoubanItem；缺 id/标题/封面丢弃；评分 0-100 换算为 0-10 */
export function anilistToItem(raw: AniMediaRaw): DoubanItem | undefined {
  const title = raw.title?.romaji || raw.title?.native || raw.title?.english || '';
  const cover = raw.coverImage?.large || undefined;
  if (!raw.id || !title || !cover) return undefined;
  const score = raw.averageScore && raw.averageScore > 0 ? (raw.averageScore / 10).toFixed(1) : undefined;
  return { id: `anilist_${raw.id}`, title, cover, rating: score, isTv: true };
}

export async function fetchAnilistTrending(limit = 50): Promise<DoubanItem[]> {
  const cacheKey = `anilist-trending:${limit}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  const pageSize = Math.min(100, Math.max(1, limit));
  const res = await fetchUpstream(ANILIST_API, {
    method: 'POST',
    timeoutMs: 10000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'LibreTV (+https://github.com/LibreSpark/LibreTV)',
    },
    body: JSON.stringify({ query: QUERY, variables: { page: 1, perPage: pageSize } }),
  });
  if (!res.ok) throw new Error(`AniList 接口响应异常 (${res.status})`);

  const data = (await res.json()) as AniListResponse;
  const media = data.data?.Page?.media;
  if (!Array.isArray(media)) throw new Error('AniList 数据异常');

  const items = media
    .map(anilistToItem)
    .filter((item): item is DoubanItem => item !== undefined);

  if (items.length === 0) throw new Error('AniList 数据为空');

  setCache(cacheKey, items, CACHE_TTL);
  return items;
}
