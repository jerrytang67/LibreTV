import { describe, expect, it } from 'vitest';
import { anilistToItem } from './anilist';

describe('anilistToItem', () => {
  it('标题取 romaji 优先，评分 0-100 换算 0-10，isTv=true', () => {
    expect(
      anilistToItem({
        id: 195604,
        title: { romaji: 'Black Clover 2nd Season', native: 'ブラッククローバー', english: 'Black Clover' },
        coverImage: { large: 'https://s4.anilist.co/file/medium/bx195604.jpg' },
        averageScore: 87,
      })
    ).toEqual({
      id: 'anilist_195604',
      title: 'Black Clover 2nd Season',
      cover: 'https://s4.anilist.co/file/medium/bx195604.jpg',
      rating: '8.7',
      isTv: true,
    });
  });

  it('romaji 缺失时回退 native / english', () => {
    expect(anilistToItem({ id: 1, title: { native: '日本名' }, coverImage: { large: 'c' }, averageScore: 0 })).toMatchObject(
      { title: '日本名', cover: 'c' }
    );
    expect(anilistToItem({ id: 2, title: { english: 'Eng' }, coverImage: { large: 'c' } })?.title).toBe('Eng');
  });

  it('无评分或 0 分不输出 rating；缺 id/标题/封面丢弃', () => {
    expect(anilistToItem({ id: 1, title: { romaji: 'x' }, coverImage: { large: 'c' } })?.rating).toBeUndefined();
    expect(anilistToItem({ id: 1, title: { romaji: 'x' }, coverImage: { large: 'c' }, averageScore: 0 })?.rating).toBeUndefined();
    expect(anilistToItem({ title: { romaji: 'x' }, coverImage: { large: 'c' } })).toBeUndefined();
    expect(anilistToItem({ id: 1, coverImage: { large: 'c' } })).toBeUndefined();
    expect(anilistToItem({ id: 1, title: { romaji: 'x' } })).toBeUndefined();
  });
});
