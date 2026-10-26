import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchTvmazeSchedule } from '@/lib/tvmaze';

export const runtime = 'nodejs';

/** TVMaze 每日排期（欧美剧，免 key）：服务端转发 + 缓存 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  try {
    const items = await fetchTvmazeSchedule(50);
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'TVMaze 排期获取失败' },
      { status: 502 }
    );
  }
}
