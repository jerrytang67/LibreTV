import { describe, expect, it } from 'vitest';
import { tvmazeEpisodeToItem } from './tvmaze';

describe('tvmazeEpisodeToItem', () => {
  it('以剧为单位映射：id 加前缀、封面 medium 优先、评分可空、isTv=true', () => {
    expect(
      tvmazeEpisodeToItem({
        id: 3767966,
        show: {
          id: 95124,
          name: 'Open House Outrageous',
          image: { medium: 'https://static.tvmaze.com/uploads/m.jpg', original: 'https://static.tvmaze.com/uploads/o.jpg' },
          rating: { average: 7.5 },
        },
      })
    ).toEqual({
      id: 'tvmaze_95124',
      title: 'Open House Outrageous',
      cover: 'https://static.tvmaze.com/uploads/m.jpg',
      rating: '7.5',
      isTv: true,
    });
  });

  it('medium 缺失回退 original；无评分不输出 rating', () => {
    expect(
      tvmazeEpisodeToItem({ id: 1, show: { id: 2, name: 'y', image: { original: 'https://o.jpg' }, rating: { average: null } } })
    ).toMatchObject({ cover: 'https://o.jpg', rating: undefined });
  });

  it('缺剧 id、剧名或封面的脏数据丢弃', () => {
    expect(tvmazeEpisodeToItem({ id: 1, show: { id: 2, name: 'y' } })).toBeUndefined();
    expect(tvmazeEpisodeToItem({ id: 1, show: { name: 'y', image: { medium: 'c' } } })).toBeUndefined();
    expect(tvmazeEpisodeToItem({ id: 1, show: { id: 2, image: { medium: 'c' } } })).toBeUndefined();
    expect(tvmazeEpisodeToItem({})).toBeUndefined();
  });
});
