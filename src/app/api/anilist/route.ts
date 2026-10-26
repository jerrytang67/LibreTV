import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchAnilistTrending } from '@/lib/anilist';

export const runtime = 'nodejs';

/** AniList 动漫趋势榜（GraphQL POST，免 key）：服务端转发 + 缓存 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  try {
    const items = await fetchAnilistTrending(50);
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'AniList 趋势获取失败' },
      { status: 502 }
    );
  }
}
