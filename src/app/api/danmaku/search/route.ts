import { NextResponse } from 'next/server';

import { guardRequest } from '@/lib/api-guard';
import { pickBestAnime, type DandanplayAnime } from '@/lib/danmaku';
import { isSelfHostedUpstream, resolveCredentials, searchDandanplayEpisodes } from '@/lib/dandanplay';
import { getCache, setCache } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

/** 搜索结果短缓存：换集时自动匹配会连续打同一部剧，60s 足够吃掉这些重复请求 */
const SEARCH_CACHE_TTL = 60 * 1000;

interface PickedEpisode {
  animeId: number;
  animeTitle: string;
  episodeId: number;
  episodeTitle: string;
}

interface SearchPayload {
  items: DandanplayAnime[];
  picked?: PickedEpisode;
}

/**
 * 弹幕匹配搜索：按「番剧标题 + 集数」查弹弹play 的番剧/分集。
 *
 * 返回全部候选（items）而不是只返回一条：采集站标题与番剧名对不上的情况很常见
 * （译名、季数、副标题），用户需要在面板里自己挑一条正确的。
 * picked 只是打分最高的一条，供「自动匹配后静默写入绑定」使用。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const title = (url.searchParams.get('title') || '').trim();
  const episode = (url.searchParams.get('episode') || '').trim();

  if (!title) {
    return NextResponse.json({ error: '缺少搜索标题' }, { status: 400 });
  }
  if (title.length > 120) {
    return NextResponse.json({ error: '搜索标题过长' }, { status: 400 });
  }

  const creds = resolveCredentials(req);
  // 自建上游（DANDANPLAY_API_BASE 指向 danmu_api 等兼容服务）不需要弹弹play 凭据；
  // 官方服务则必须带签名，缺凭据时直接 501 让用户去配置
  if (!creds && !isSelfHostedUpstream()) {
    return NextResponse.json(
      { error: '未配置弹弹play密钥', code: 'danmaku_not_configured' },
      { status: 501 }
    );
  }

  // appId 进缓存键：部署者凭据与用户自备凭据的来源/配额不同，结果不应互相串；
  // 自建上游没有 appId，用固定标记区分
  const cacheKey = `danmaku:search:${creds?.appId ?? 'self-hosted'}:${title}|${episode}`;
  const cached = getCache<SearchPayload>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const data = await searchDandanplayEpisodes(title, episode || undefined, creds);
    const items: DandanplayAnime[] = Array.isArray(data.animes) ? data.animes : [];
    const best = pickBestAnime(items, title, episode || null)[0];

    const payload: SearchPayload = {
      items,
      picked:
        best && best.score > 0
          ? {
              animeId: best.animeId,
              animeTitle: best.animeTitle,
              episodeId: best.episodeId,
              episodeTitle: best.episodeTitle,
            }
          : undefined,
    };

    setCache(cacheKey, payload, SEARCH_CACHE_TTL);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '弹幕搜索失败' },
      { status: 502 }
    );
  }
}
