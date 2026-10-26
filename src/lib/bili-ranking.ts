import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * B站影视榜（影视区 / 电视剧区排行榜）数据获取。
 * 接口 api.bilibili.com/x/web-interface/ranking/v2 为公开接口、免 key，
 * 2026-10-25 实测电影（rid=23）、电视剧（rid=5）可用；番剧（rid=13）/国创（rid=167）不可用。
 * 注意：B站对该接口有风控（数据中心 IP 偶发 412），服务端直连失败时前端按现有错误文案处理。
 */

const BILI_RANKING_API = 'https://api.bilibili.com/x/web-interface/ranking/v2';
const CACHE_TTL = 30 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 可用的影视分区 rid：23=影视区排行，5=电视剧区排行 */
export const BILI_RIDS = { movie: 23, tv: 5 } as const;

export function isBiliRid(rid: number): boolean {
  return rid === BILI_RIDS.movie || rid === BILI_RIDS.tv;
}

export interface BiliRankItemRaw {
  aid?: number;
  title?: string;
  /** 封面图地址，接口返回 http:// 前缀 */
  pic?: string;
}

export interface BiliRankingResponse {
  code?: number;
  message?: string;
  data?: { list?: BiliRankItemRaw[] };
}

/** 排行条目 → DoubanItem；缺 aid/标题/封面丢弃；pic 统一转 https；无评分字段 */
export function biliRankToItem(raw: BiliRankItemRaw, isTv: boolean): DoubanItem | undefined {
  if (!raw.aid || !raw.title || !raw.pic) return undefined;
  const cover = raw.pic.replace(/^http:\/\//, 'https://');
  return { id: `bili_${raw.aid}`, title: raw.title, cover, isTv };
}

export async function fetchBiliRanking(rid: number, limit = 50): Promise<DoubanItem[]> {
  if (!isBiliRid(rid)) throw new Error(`不支持的影视分区: ${rid}`);

  const cacheKey = `bili-ranking:${rid}:${limit}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  const target = `${BILI_RANKING_API}?rid=${rid}&type=all`;
  const res = await fetchUpstream(target, {
    timeoutMs: 8000,
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`B站接口响应异常 (${res.status})`);

  const data = (await res.json()) as BiliRankingResponse;
  if (data.code !== 0 || !Array.isArray(data.data?.list)) {
    throw new Error(data.message ? `B站接口返回错误: ${data.message}` : 'B站排行数据异常');
  }

  const isTv = rid === BILI_RIDS.tv;
  const items = data.data.list
    .slice(0, limit)
    .map((entry) => biliRankToItem(entry, isTv))
    .filter((item): item is DoubanItem => item !== undefined);

  if (items.length === 0) throw new Error('B站排行数据为空');

  setCache(cacheKey, items, CACHE_TTL);
  return items;
}
