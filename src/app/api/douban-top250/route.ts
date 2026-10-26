import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchDoubanTop250 } from '@/lib/douban-top250';

export const runtime = 'nodejs';

/** 豆瓣高分电影榜（豆瓣电影 Top250）：服务端直连 + 缓存 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  try {
    const items = await fetchDoubanTop250(50);
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '豆瓣 Top250 获取失败' },
      { status: 502 }
    );
  }
}
