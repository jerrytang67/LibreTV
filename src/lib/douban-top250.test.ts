import { describe, expect, it } from 'vitest';
import { doubanTop250ToItem } from './douban-top250';

describe('doubanTop250ToItem', () => {
  it('标题、封面、评分正确映射，isTv=false', () => {
    expect(
      doubanTop250ToItem({
        id: '1292052',
        title: '肖申克的救赎',
        cover_url: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2934829882.jpg',
        score: '9.7',
      })
    ).toEqual({
      id: '1292052',
      title: '肖申克的救赎',
      cover: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2934829882.jpg',
      rating: '9.7',
      isTv: false,
    });
  });

  it('0 分或空分不输出 rating', () => {
    expect(doubanTop250ToItem({ id: '1', title: 'x', cover_url: 'c', score: '0' })).toMatchObject({
      cover: 'c',
      isTv: false,
    });
    expect(doubanTop250ToItem({ id: '1', title: 'x', cover_url: 'c' })?.rating).toBeUndefined();
  });

  it('缺 id、标题或封面的脏数据丢弃', () => {
    expect(doubanTop250ToItem({ title: 'x', cover_url: 'c' })).toBeUndefined();
    expect(doubanTop250ToItem({ id: '1', cover_url: 'c' })).toBeUndefined();
    expect(doubanTop250ToItem({ id: '1', title: 'x' })).toBeUndefined();
  });
});
