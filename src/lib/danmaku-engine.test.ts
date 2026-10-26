import { describe, expect, it } from 'vitest';

import type { DanmakuItem } from './danmaku';
import {
  allocateTrack,
  createCursor,
  estimateTextWidth,
  resetCursor,
  takeDueComments,
} from './danmaku-engine';

/**
 * 弹幕引擎的纯函数单测。
 * 只测不依赖 canvas/video 的部分（宽度估算、轨道分配、时间窗口游标）：
 * 整条渲染链路在 node 环境里没有 canvas，硬测只能靠 mock，收益远低于成本。
 */

const item = (time: number, text = 'x'): DanmakuItem => ({
  time,
  mode: 1,
  color: '#ffffff',
  text,
});

describe('estimateTextWidth', () => {
  it('ASCII 按 0.55em、中日文按 1em 估算', () => {
    expect(estimateTextWidth('ab', 20)).toBeCloseTo(22, 5);
    expect(estimateTextWidth('中文', 20)).toBeCloseTo(40, 5);
    expect(estimateTextWidth('中a', 10)).toBeCloseTo(15.5, 5);
  });

  it('空串、非法字号返回 0', () => {
    expect(estimateTextWidth('', 20)).toBe(0);
    expect(estimateTextWidth('abc', 0)).toBe(0);
    expect(estimateTextWidth('abc', Number.NaN)).toBe(0);
  });

  it('长文本宽度随字符数线性增长', () => {
    expect(estimateTextWidth('中文弹幕测试', 24)).toBeCloseTo(24 * 6, 5);
  });
});

describe('allocateTrack', () => {
  it('返回第一条已释放的轨道', () => {
    expect(allocateTrack([5, 2, 9], 3)).toBe(1);
    expect(allocateTrack([5, 2, 9], 10)).toBe(0);
  });

  it('全部占用时返回 -1（本帧丢弃，不排队）', () => {
    expect(allocateTrack([5, 5], 3)).toBe(-1);
    expect(allocateTrack([0.1], 0)).toBe(-1);
  });

  it('边界：恰好释放的时刻可用；空轨道表 / 非有限值也安全', () => {
    expect(allocateTrack([1], 1)).toBe(0);
    expect(allocateTrack([], 1)).toBe(-1);
    // 非有限值视为「没有占用信息」，按空闲处理（数组刚扩容/脏数据都不会卡死整条轨道）
    expect(allocateTrack([Number.POSITIVE_INFINITY, 2], 3)).toBe(0);
    expect(allocateTrack([Number.NaN], 1)).toBe(0);
    expect(allocateTrack([1], Number.NaN)).toBe(-1);
  });
});

describe('时间窗口游标', () => {
  const items = [item(1), item(2), item(2.5), item(5), item(9)];

  it('按播放时间逐条取出，且不会重复取', () => {
    const cursor = createCursor();
    expect(takeDueComments(items, cursor, 0.5)).toEqual([]);
    expect(takeDueComments(items, cursor, 2.2).map((i) => i.time)).toEqual([1, 2]);
    expect(takeDueComments(items, cursor, 2.2)).toEqual([]);
    expect(takeDueComments(items, cursor, 6).map((i) => i.time)).toEqual([2.5, 5]);
    expect(takeDueComments(items, cursor, 100).map((i) => i.time)).toEqual([9]);
    expect(takeDueComments(items, cursor, 100)).toEqual([]);
  });

  it('seek 回退时重置游标，遗漏的弹幕可以重新取出', () => {
    const cursor = createCursor();
    takeDueComments(items, cursor, 6);
    // 用户拖回 2 秒：游标必须回退到「第一条 time >= 2」，否则 2.5/5 永远补不回来
    resetCursor(cursor, items, 2);
    expect(takeDueComments(items, cursor, 3).map((i) => i.time)).toEqual([2, 2.5]);
  });

  it('seek 前进时重置游标会跳过中间那段（不会一次性喷出几百条）', () => {
    const cursor = createCursor();
    takeDueComments(items, cursor, 1);
    resetCursor(cursor, items, 8);
    expect(takeDueComments(items, cursor, 8)).toEqual([]);
    expect(takeDueComments(items, cursor, 9)).toEqual([items[4]]);
    expect(cursor.next).toBe(items.length);
  });

  it('边界：负时间/非有限时间按 0 处理，空列表不越界', () => {
    const cursor = createCursor();
    const empty: DanmakuItem[] = [];
    resetCursor(cursor, empty, 5);
    expect(cursor.next).toBe(0);
    expect(takeDueComments(empty, cursor, 5)).toEqual([]);

    const c2 = createCursor();
    resetCursor(c2, items, -10);
    expect(c2.next).toBe(0);
    expect(takeDueComments(items, c2, Number.NaN)).toEqual([]);
    expect(takeDueComments(items, c2, 0)).toEqual([]);
  });

  it('播放时间不推进时（同一帧重复调用）不会重复发射', () => {
    const cursor = createCursor();
    const first = takeDueComments(items, cursor, 5);
    const second = takeDueComments(items, cursor, 5);
    expect(first.map((i) => i.time)).toEqual([1, 2, 2.5, 5]);
    expect(second).toEqual([]);
  });
});
