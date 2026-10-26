import { afterEach, describe, expect, it } from 'vitest';

import {
  DANDANPLAY_HOST,
  buildSignature,
  dandanplayHost,
  isDandanplayEnvConfigured,
  resolveCredentials,
  signatureTimestamp,
} from './dandanplay';
import {
  cleanDanmakuTitle,
  migrateDanmakuMappings,
  normalizeEpisodeNumber,
  parseComment,
  parseComments,
  pickBestAnime,
  shiftDanmaku,
  type DandanplayAnime,
} from './danmaku';

/**
 * 弹弹play 客户端的纯逻辑单测。
 * 签名用固定向量锁死：算法一旦被"顺手优化"（比如改成先转十六进制再 Base64，
 * 输出会从 44 字符变成 88 字符），线上会整片 Invalid Signature，
 * 而那种故障在本地开发环境不看日志根本发现不了。
 */

describe('buildSignature', () => {
  it('与官方口径一致：base64(sha256 原始摘要)', () => {
    // 入参形态照官方文档示例（AppId + 秒级 Timestamp + Path + AppSecret）
    expect(buildSignature('your_app_id', 1700000000, '/api/v2/comment/123450001', 'your_app_secret')).toBe(
      'MnwHjANapteJNjculmgqVceaxB0G8PkBJisDzoLXHmU='
    );
    expect(buildSignature('appid-123', 1735689600, '/api/v2/comment/185930001', 'appsecret-456')).toBe(
      'lHg5t75jD/24Cxrk0jWeCFiGjdwYEAOP5uWjSyNojDQ='
    );
  });

  it('输出 44 字符的 Base64（32 字节摘要），不是十六进制字符串', () => {
    const sig = buildSignature('a', 1, '/p', 's');
    // 长度是最有效的防线：十六进制再 Base64 会变成 88 字符，上游直接 Invalid Signature
    expect(sig).toHaveLength(44);
    expect(sig.endsWith('=')).toBe(true);
    expect(Buffer.from(sig, 'base64')).toHaveLength(32);
  });

  it('同一入参稳定、不同入参不同（path 与 secret 都参与计算）', () => {
    const base = buildSignature('app', 100, '/p', 'sec');
    expect(buildSignature('app', 100, '/p', 'sec')).toBe(base);
    expect(buildSignature('app', 101, '/p', 'sec')).not.toBe(base);
    expect(buildSignature('app', 100, '/q', 'sec')).not.toBe(base);
    expect(buildSignature('app', 100, '/p', 'other')).not.toBe(base);
  });
});

describe('signatureTimestamp', () => {
  it('取秒级时间戳', () => {
    expect(signatureTimestamp(1700000000123)).toBe(1700000000);
    expect(signatureTimestamp(1700000000999)).toBe(1700000000);
  });
});

describe('dandanplayHost', () => {
  afterEach(() => {
    delete process.env.DANDANPLAY_API_BASE;
  });

  it('默认使用官方 host', () => {
    expect(dandanplayHost()).toBe(DANDANPLAY_HOST);
  });

  it('允许自建反代覆盖，并去掉尾部斜杠', () => {
    process.env.DANDANPLAY_API_BASE = 'https://mirror.example.com/';
    expect(dandanplayHost()).toBe('https://mirror.example.com');
  });
});

describe('resolveCredentials', () => {
  const originalId = process.env.DANDANPLAY_APP_ID;
  const originalSecret = process.env.DANDANPLAY_APP_SECRET;

  afterEach(() => {
    if (originalId === undefined) delete process.env.DANDANPLAY_APP_ID;
    else process.env.DANDANPLAY_APP_ID = originalId;
    if (originalSecret === undefined) delete process.env.DANDANPLAY_APP_SECRET;
    else process.env.DANDANPLAY_APP_SECRET = originalSecret;
  });

  const requestWith = (headers: Record<string, string>) => new Request('http://localhost/api', { headers });

  it('优先使用部署者的环境变量', () => {
    process.env.DANDANPLAY_APP_ID = 'env-id';
    process.env.DANDANPLAY_APP_SECRET = 'env-secret';
    expect(resolveCredentials(requestWith({ 'x-danmaku-app-id': 'u', 'x-danmaku-app-secret': 'p' }))).toEqual({
      appId: 'env-id',
      appSecret: 'env-secret',
      source: 'env',
    });
  });

  it('环境变量缺失时回落到请求头里的用户凭据', () => {
    delete process.env.DANDANPLAY_APP_ID;
    delete process.env.DANDANPLAY_APP_SECRET;
    expect(resolveCredentials(requestWith({ 'x-danmaku-app-id': 'u', 'x-danmaku-app-secret': 'p' }))).toEqual({
      appId: 'u',
      appSecret: 'p',
      source: 'header',
    });
  });

  it('两边都没有时返回 null（半个凭据也算没有）', () => {
    delete process.env.DANDANPLAY_APP_ID;
    delete process.env.DANDANPLAY_APP_SECRET;
    expect(resolveCredentials(requestWith({}))).toBeNull();
    expect(resolveCredentials(requestWith({ 'x-danmaku-app-id': 'only-id' }))).toBeNull();
    process.env.DANDANPLAY_APP_ID = 'env-id';
    expect(resolveCredentials(requestWith({}))).toBeNull();
  });

  it('isDandanplayEnvConfigured 只看环境变量是否成对存在', () => {
    delete process.env.DANDANPLAY_APP_ID;
    delete process.env.DANDANPLAY_APP_SECRET;
    expect(isDandanplayEnvConfigured()).toBe(false);
    process.env.DANDANPLAY_APP_ID = 'id';
    process.env.DANDANPLAY_APP_SECRET = 'secret';
    expect(isDandanplayEnvConfigured()).toBe(true);
  });
});

describe('parseComment', () => {
  it('解析滚动弹幕并转换颜色', () => {
    expect(parseComment({ cid: 1, p: '12.5,1,16777215,abc', m: '前排' })).toEqual({
      time: 12.5,
      mode: 1,
      color: '#ffffff',
      text: '前排',
    });
    expect(parseComment({ p: '0,1,255,0', m: '片头' })?.time).toBe(0);
    expect(parseComment({ p: '3,1,16711680,0', m: '红字' })?.color).toBe('#ff0000');
  });

  it('模式 2/3 归为滚动，4 底部、5 顶部', () => {
    expect(parseComment({ p: '1,2,0,0', m: 'a' })?.mode).toBe(1);
    expect(parseComment({ p: '1,3,0,0', m: 'b' })?.mode).toBe(1);
    expect(parseComment({ p: '1,4,0,0', m: 'c' })?.mode).toBe(4);
    expect(parseComment({ p: '1,5,0,0', m: 'd' })?.mode).toBe(5);
  });

  it('颜色越界/缺失回退白色', () => {
    expect(parseComment({ p: '1,1,99999999,0', m: 'x' })?.color).toBe('#ffffff');
    expect(parseComment({ p: '1,1,-1,0', m: 'x' })?.color).toBe('#ffffff');
    expect(parseComment({ p: '1,1,0,0', m: 'x' })?.color).toBe('#000000');
    expect(parseComment({ p: '1,1,abc,0', m: 'x' })?.color).toBe('#ffffff');
    expect(parseComment({ p: '1,1', m: 'x' })?.color).toBe('#ffffff');
  });

  it('丢弃脏数据：时间非法、模式非法、正文为空、结构缺失', () => {
    expect(parseComment(null)).toBeNull();
    expect(parseComment(undefined)).toBeNull();
    expect(parseComment({ p: 'abc,1,0,0', m: 'x' })).toBeNull();
    expect(parseComment({ p: '-2,1,0,0', m: 'x' })).toBeNull();
    expect(parseComment({ p: 'NaN,1,0,0', m: 'x' })).toBeNull();
    expect(parseComment({ p: 'Infinity,1,0,0', m: 'x' })).toBeNull();
    expect(parseComment({ p: '1,7,0,0', m: 'x' })).toBeNull();
    expect(parseComment({ p: '1,abc,0,0', m: 'x' })).toBeNull();
    expect(parseComment({ p: '1', m: 'x' })).toBeNull();
    expect(parseComment({ p: '1,1,0,0', m: '   ' })).toBeNull();
    expect(parseComment({ p: '1,1,0,0' } as never)).toBeNull();
    expect(parseComment({ p: undefined, m: 'x' } as never)).toBeNull();
  });

  it('parseComments 过滤并升序排列，非数组输入返回空', () => {
    const items = parseComments([
      { p: '9,1,0,0', m: 'late' },
      { p: 'bad,1,0,0', m: 'dirty' },
      { p: '2,5,0,0', m: 'early' },
      null,
      'not-an-object',
    ]);
    expect(items.map((i) => i.text)).toEqual(['early', 'late']);
    expect(parseComments(undefined)).toEqual([]);
    expect(parseComments({})).toEqual([]);
  });
});

describe('normalizeEpisodeNumber', () => {
  it('支持数字与「第N集」文本', () => {
    expect(normalizeEpisodeNumber(3)).toBe(3);
    expect(normalizeEpisodeNumber('3')).toBe(3);
    expect(normalizeEpisodeNumber('第07集')).toBe(7);
    expect(normalizeEpisodeNumber('')).toBeNull();
    expect(normalizeEpisodeNumber('第 集')).toBeNull();
    expect(normalizeEpisodeNumber(0)).toBeNull();
    expect(normalizeEpisodeNumber(null)).toBeNull();
  });
});

describe('pickBestAnime', () => {
  const animes: DandanplayAnime[] = [
    {
      animeId: 101,
      animeTitle: '庆余年 第二季',
      episodes: [
        { episodeId: 9001, episodeTitle: '第 1 话' },
        { episodeId: 9003, episodeTitle: '第 3 话' },
      ],
    },
    {
      animeId: 202,
      animeTitle: '庆余年',
      episodes: [{ episodeId: 8001, episodeTitle: '第 1 话' }],
    },
    {
      animeId: 303,
      animeTitle: '无关的番剧',
      episodes: [{ episodeId: 7001, episodeTitle: '第 3 话' }],
    },
  ];

  it('标题完全相等 + 集数命中排第一', () => {
    const ranked = pickBestAnime(animes, '庆余年 第二季', 3);
    expect(ranked[0]).toMatchObject({ animeId: 101, episodeId: 9003 });
    expect(ranked[0].score).toBe(150);
  });

  it('集数命中可以压过「标题精确但没有这一集」的候选', () => {
    const ranked = pickBestAnime(animes, '庆余年', 3);
    // 101：标题被包含(70) + 第 3 话命中(50)；202：标题精确(100) 但没有第 3 话
    expect(ranked[0]).toMatchObject({ animeId: 101, episodeId: 9003, score: 120 });
    expect(ranked.find((c) => c.animeId === 202)).toMatchObject({ episodeId: 8001, score: 100 });
  });

  it('完全无关的番剧不进候选', () => {
    expect(pickBestAnime(animes, '庆余年', 1).some((c) => c.animeId === 303)).toBe(false);
  });

  it('标点/空格/大小写差异不影响匹配（复用 normalizeTitle）', () => {
    const ranked = pickBestAnime(animes, '庆余年第二季', 1);
    expect(ranked[0]?.animeId).toBe(101);
    expect(ranked[0]?.score).toBe(150);
  });

  it('「番剧名被标题包含」记 40 分（低于精确/包含，避免短名误命中）', () => {
    // wanted（第二季）比番剧名长：命中 40 分这一档；分集不匹配则不加 50
    const list: DandanplayAnime[] = [
      { animeId: 1, animeTitle: '庆余年', episodes: [{ episodeId: 10, episodeTitle: '第 9 话' }] },
    ];
    expect(pickBestAnime(list, '庆余年第二季', 1)).toEqual([
      { animeId: 1, animeTitle: '庆余年', episodeId: 10, episodeTitle: '第 9 话', score: 40 },
    ]);
  });

  it('单字番剧名（正常化后长度 < 2）不进入候选，防止过度匹配', () => {
    const list: DandanplayAnime[] = [
      { animeId: 1, animeTitle: '庆', episodes: [{ episodeId: 10, episodeTitle: '第 1 话' }] },
    ];
    expect(pickBestAnime(list, '庆余年', 1)).toEqual([]);
  });

  it('空标题 / 空列表 / 脏字段时安全返回', () => {
    expect(pickBestAnime(animes, '', 1)).toEqual([]);
    expect(pickBestAnime(undefined, '庆余年', 1)).toEqual([]);
    expect(pickBestAnime([], '庆余年', 1)).toEqual([]);
    expect(pickBestAnime([{ animeId: 1, animeTitle: '庆余年', episodes: undefined } as never], '庆余年', 1)).toEqual(
      []
    );
  });
});

describe('shiftDanmaku', () => {
  const items = [
    { time: 1, mode: 1 as const, color: '#ffffff', text: 'a' },
    { time: 3, mode: 5 as const, color: '#ffffff', text: 'b' },
    { time: 10, mode: 4 as const, color: '#ffffff', text: 'c' },
  ];

  it('正偏移整体后移且保持升序', () => {
    expect(shiftDanmaku(items, 2.5).map((i) => i.time)).toEqual([3.5, 5.5, 12.5]);
  });

  it('负偏移把时间推到 0 之前的弹幕直接丢弃', () => {
    const shifted = shiftDanmaku(items, -3);
    expect(shifted.map((i) => i.text)).toEqual(['b', 'c']);
    expect(shifted.map((i) => i.time)).toEqual([0, 7]);
  });

  it('偏移 0 / 非法偏移返回等价数据（不共享可变引用）', () => {
    expect(shiftDanmaku(items, 0).map((i) => i.time)).toEqual([1, 3, 10]);
    expect(shiftDanmaku(items, Number.NaN).map((i) => i.time)).toEqual([1, 3, 10]);
    expect(shiftDanmaku(items, 0)).not.toBe(items);
  });
});

describe('cleanDanmakuTitle', () => {
  it('去掉括注、集数与清晰度/语言标签', () => {
    expect(cleanDanmakuTitle('庆余年 第二季 第03集【高清】')).toBe('庆余年 第二季');
    expect(cleanDanmakuTitle('繁花[国语] 1080P 第 12 集')).toBe('繁花');
    expect(cleanDanmakuTitle('（未删减）狂飙')).toBe('狂飙');
  });

  it('清洗后为空时退回原串，避免搜索参数变空', () => {
    expect(cleanDanmakuTitle('【】')).toBe('【】');
    expect(cleanDanmakuTitle('')).toBe('');
  });
});

describe('migrateDanmakuMappings', () => {
  it('保留合法条目并补齐缺失字段', () => {
    const migrated = migrateDanmakuMappings({
      'a:1:0': { episodeId: 100, animeTitle: '番剧', episodeTitle: '第1话', offsetSeconds: -1.5, auto: true },
      'b:2:1': { episodeId: '200' },
    });
    expect(migrated['a:1:0']).toMatchObject({ episodeId: 100, offsetSeconds: -1.5, auto: true });
    expect(migrated['b:2:1']).toMatchObject({ episodeId: 200, offsetSeconds: 0, auto: false });
    expect(typeof migrated['b:2:1'].matchedAt).toBe('number');
  });

  it('丢弃脏条目，非对象输入返回空表', () => {
    expect(migrateDanmakuMappings({ x: { episodeId: 'abc' }, y: null, z: 'str' })).toEqual({});
    expect(migrateDanmakuMappings(undefined)).toEqual({});
    expect(migrateDanmakuMappings([])).toEqual({});
  });
});
