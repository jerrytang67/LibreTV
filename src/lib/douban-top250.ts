import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * 豆瓣高分电影榜（豆瓣电影 Top250，type=11）数据获取。
 * 服务端直连 movie.douban.com/j/chart/top_list，与 douban.ts（search_subjects）
 * 同一套反爬对策：Chrome UA + Referer 伪装，直连失败降级到 FALLBACK_CORS_PROXY。
 * 接口返回字段齐全（标题/封面/评分），2026-10-25 从家庭宽带直连实测可用。
 */

const CHART_API = 'https://movie.douban.com/j/chart/top_list';
const CACHE_TTL = 10 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface DoubanTop250Raw {
  id?: string;
  title?: string;
  cover_url?: string;
  /** 字符串评分，如 "9.7"；无评分时为 "0" */
  score?: string;
}

function fallbackProxies(): string[] {
  const proxies: string[] = [];
  if (process.env.FALLBACK_CORS_PROXY) proxies.push(process.env.FALLBACK_CORS_PROXY);
  return proxies;
}

/** Top250 条目 → DoubanItem；缺标题或封面的脏数据丢弃，0 分不输出 rating */
export function doubanTop250ToItem(raw: DoubanTop250Raw): DoubanItem | undefined {
  const cover = raw.cover_url;
  if (!raw.id || !raw.title || !cover) return undefined;
  const score = raw.score && raw.score !== '0' ? raw.score : undefined;
  return { id: raw.id, title: raw.title, cover, rating: score, isTv: false };
}

export async function fetchDoubanTop250(limit = 50): Promise<DoubanItem[]> {
  const cacheKey = `douban-top250:${limit}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  const pageSize = Math.min(100, Math.max(1, limit));
  const target = `${CHART_API}?type=11&interval_id=100%3A90&action=&start=0&limit=${pageSize}`;

  let raw: DoubanTop250Raw[] | undefined;

  // 1) 服务端直连
  try {
    const res = await fetchUpstream(target, {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Referer: 'https://movie.douban.com/', Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as DoubanTop250Raw[];
      if (Array.isArray(data)) raw = data;
    }
  } catch {
    // 忽略，走降级
  }

  // 2) 降级：经 FALLBACK_CORS_PROXY
  if (!raw) {
    for (const proxy of fallbackProxies()) {
      try {
        const res = await fetchUpstream(proxy + encodeURIComponent(target), {
          timeoutMs: 8000,
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const data = (await res.json()) as DoubanTop250Raw[];
          if (Array.isArray(data)) {
            raw = data;
            break;
          }
        }
      } catch {
        // 继续尝试下一个
      }
    }
  }

  if (!raw) throw new Error('豆瓣 Top250 获取失败');

  const items = raw
    .map(doubanTop250ToItem)
    .filter((item): item is DoubanItem => item !== undefined);

  if (items.length === 0) throw new Error('豆瓣 Top250 数据为空');

  setCache(cacheKey, items, CACHE_TTL);
  return items;
}
