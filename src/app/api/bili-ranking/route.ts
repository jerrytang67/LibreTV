import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchBiliRanking, isBiliRid } from '@/lib/bili-ranking';

export const runtime = 'nodejs';

/** B站影视榜（影视区 rid=23 / 电视剧区 rid=5）：服务端直连 + 缓存 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const rid = parseInt(new URL(req.url).searchParams.get('rid') || '', 10);
  if (!isBiliRid(rid)) {
    return NextResponse.json({ error: `未知影视分区: ${rid}` }, { status: 400 });
  }

  try {
    const items = await fetchBiliRanking(rid, 50);
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'B站影视榜获取失败' },
      { status: 502 }
    );
  }
}
