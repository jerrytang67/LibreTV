import { describe, expect, it } from 'vitest';

import {
  DANMAKU_AREA_OPTIONS,
  DANMAKU_LIMITS,
  DEFAULT_DANMAKU_STYLE,
  densityLimits,
  normalizeDanmakuDensity,
  resolveDanmakuStyle,
} from './danmaku';

/**
 * 弹幕显示参数（密度 / 区域 / 透明度）的换算与夹紧。
 *
 * 这几项直接决定"屏幕上有多吵"，且都来自持久化快照（可能被手改、可能是旧版本），
 * 因此必须有单测兜住：非法值不能变成 NaN，也不能把画面铺满。
 */

describe('densityLimits', () => {
  it('三档密度各自给出轨道数与同屏条数', () => {
    expect(densityLimits('low')).toEqual({ maxTracks: 5, maxActive: 60 });
    expect(densityLimits('medium')).toEqual({ maxTracks: 10, maxActive: 140 });
    expect(densityLimits('high')).toEqual({ maxTracks: 16, maxActive: 260 });
  });

  it('低档必须比高档更克制（否则「调少」反而更密）', () => {
    const low = densityLimits('low');
    const high = densityLimits('high');
    expect(low.maxTracks).toBeLessThan(high.maxTracks);
    expect(low.maxActive).toBeLessThan(high.maxActive);
  });

  it('缺失或非法档位回落到「中」', () => {
    expect(densityLimits(undefined)).toEqual(densityLimits('medium'));
    // @ts-expect-error 故意传非法值，模拟手改过的存储快照
    expect(densityLimits('huge')).toEqual(densityLimits('medium'));
  });
});

describe('normalizeDanmakuDensity', () => {
  it('合法值原样返回', () => {
    expect(normalizeDanmakuDensity('low')).toBe('low');
    expect(normalizeDanmakuDensity('high')).toBe('high');
  });

  it('非法值一律回落到 medium', () => {
    for (const bad of [undefined, null, 0, 1, '', 'LOW', 'max', {}, []]) {
      expect(normalizeDanmakuDensity(bad)).toBe('medium');
    }
  });
});

describe('DANMAKU_AREA_OPTIONS', () => {
  it('提供 1/3 与 1/2 两档（用户最常见的两个诉求）', () => {
    const labels = DANMAKU_AREA_OPTIONS.map((o) => o.label);
    expect(labels).toContain('1/3');
    expect(labels).toContain('1/2');
  });

  it('取值递增且都落在合法区间内', () => {
    const values = DANMAKU_AREA_OPTIONS.map((o) => o.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(DANMAKU_LIMITS.areaRatio.min);
      expect(v).toBeLessThanOrEqual(DANMAKU_LIMITS.areaRatio.max);
    }
  });
});

describe('resolveDanmakuStyle', () => {
  it('空入参给默认值，且默认 maxActive 明确', () => {
    const style = resolveDanmakuStyle();
    expect(style.maxActive).toBe(DEFAULT_DANMAKU_STYLE.maxActive);
    expect(style.maxTracks).toBe(DEFAULT_DANMAKU_STYLE.maxTracks);
    expect(style.opacity).toBe(DEFAULT_DANMAKU_STYLE.opacity);
  });

  it('同屏条数超界会被夹紧，不会把上限拉成 0 或几千', () => {
    expect(resolveDanmakuStyle({ maxActive: 0 }).maxActive).toBe(DANMAKU_LIMITS.maxActive.min);
    expect(resolveDanmakuStyle({ maxActive: 99999 }).maxActive).toBe(DANMAKU_LIMITS.maxActive.max);
    // NaN / 字符串等脏值走默认值，而不是变成 NaN 让比较恒为 false（那会让上限形同虚设）
    expect(resolveDanmakuStyle({ maxActive: Number.NaN }).maxActive).toBe(DEFAULT_DANMAKU_STYLE.maxActive);
  });

  it('透明度与区域都按区间夹紧', () => {
    expect(resolveDanmakuStyle({ opacity: 0 }).opacity).toBe(DANMAKU_LIMITS.opacity.min);
    expect(resolveDanmakuStyle({ opacity: 5 }).opacity).toBe(DANMAKU_LIMITS.opacity.max);
    expect(resolveDanmakuStyle({ areaRatio: 0.34 }).areaRatio).toBeCloseTo(0.34, 5);
    expect(resolveDanmakuStyle({ areaRatio: 0 }).areaRatio).toBe(DANMAKU_LIMITS.areaRatio.min);
  });
});
