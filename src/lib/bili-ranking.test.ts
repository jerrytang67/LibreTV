import { describe, expect, it } from 'vitest';
import { biliRankToItem, isBiliRid, BILI_RIDS } from './bili-ranking';

describe('isBiliRid', () => {
  it('仅放行影视区与电视剧区', () => {
    expect(isBiliRid(BILI_RIDS.movie)).toBe(true);
    expect(isBiliRid(BILI_RIDS.tv)).toBe(true);
    expect(isBiliRid(13)).toBe(false); // 番剧区不可用
    expect(isBiliRid(167)).toBe(false); // 国创区不可用
    expect(isBiliRid(0)).toBe(false);
  });
});

describe('biliRankToItem', () => {
  it('id 加前缀、pic 转 https、isTv 由分区决定', () => {
    expect(
      biliRankToItem({ aid: 712432257, title: '金刚川预告', pic: 'http://i0.hdslb.com/bfs/archive/a.jpg' }, false)
    ).toEqual({
      id: 'bili_712432257',
      title: '金刚川预告',
      cover: 'https://i0.hdslb.com/bfs/archive/a.jpg',
      isTv: false,
    });
    expect(biliRankToItem({ aid: 1, title: '某剧', pic: 'https://p.jpg' }, true)).toMatchObject({ isTv: true });
  });

  it('不输出 rating（B站排行接口无评分字段）', () => {
    const item = biliRankToItem({ aid: 1, title: 'x', pic: 'https://p.jpg' }, false);
    expect(item?.rating).toBeUndefined();
  });

  it('缺 aid、标题或封面的脏数据丢弃', () => {
    expect(biliRankToItem({ title: 'x', pic: 'https://p.jpg' }, false)).toBeUndefined();
    expect(biliRankToItem({ aid: 1, pic: 'https://p.jpg' }, false)).toBeUndefined();
    expect(biliRankToItem({ aid: 1, title: 'x' }, false)).toBeUndefined();
  });
});
