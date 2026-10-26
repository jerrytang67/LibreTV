import { NextResponse } from 'next/server';

import { guardRequest } from '@/lib/api-guard';
import { parseComments, type DanmakuItem } from '@/lib/danmaku';
import { fetchDandanplayComments, isSelfHostedUpstream, resolveCredentials } from '@/lib/dandanplay';
import { getCache, setCache } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

/** 弹幕缓存 5 分钟：同一集反复切换进度/换源重进时不必重复拉取（单集体积可达数 MB） */
const COMMENT_CACHE_TTL = 5 * 60 * 1000;

/**
 * 拉取某一分集的弹幕。
 *
 * 解析放在服务端完成：前端拿到的是可以直接丢给 Canvas 引擎的数组，
 * 既省掉重复的解析逻辑，也避免把上游的脏字段（缺失的 p/m、非法模式）漏到渲染层。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const episodeIdRaw = (url.searchParams.get('episodeId') || '').trim();
  // 只接受纯数字：这个值会被拼进上游路径，任何符号都可能导致路径穿越或奇怪的 404
  if (!/^\d{1,12}$/.test(episodeIdRaw)) {
    return NextResponse.json({ error: '无效的分集 ID' }, { status: 400 });
  }
  const episodeId = Number(episodeIdRaw);
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) {
    return NextResponse.json({ error: '无效的分集 ID' }, { status: 400 });
  }

  const creds = resolveCredentials(req);
  // 同搜索路由：自建兼容上游不需要凭据，官方服务缺凭据时 501
  if (!creds && !isSelfHostedUpstream()) {
    return NextResponse.json(
      { error: '未配置弹弹play密钥', code: 'danmaku_not_configured' },
      { status: 501 }
    );
  }

  const cacheKey = `danmaku:comment:${episodeId}`;
  const cached = getCache<{ count: number; items: DanmakuItem[] }>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const data = await fetchDandanplayComments(episodeId, creds);
    const items = parseComments(data.comments);
    const payload = { count: items.length, items };
    setCache(cacheKey, payload, COMMENT_CACHE_TTL);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '弹幕获取失败' },
      { status: 502 }
    );
  }
}
