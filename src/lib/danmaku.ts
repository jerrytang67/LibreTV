import { normalizeTitle } from './cms-parser';

/**
 * 外挂弹幕的共享层（前端与服务端都会 import，因此这里不能出现 node:crypto、
 * fetch-utils 之类只能在 Node 跑的依赖——签名与上游请求见 lib/dandanplay.ts）。
 *
 * 数据源只做弹弹play 开放平台：它返回的字段在不同剧集/不同版本上并不稳定
 * （animes 可能缺失、episodes 可能为空、p 字段可能只有两段），所以这里所有
 * 解析都是「宽容解析」：能认就认，认不出返回 null 由调用方过滤，绝不抛错。
 */

/** 一条可渲染的弹幕（时间轴 = 播放器时间轴，单位秒） */
export interface DanmakuItem {
  time: number;
  /** 1 = 滚动（自右向左）；4 = 底部固定；5 = 顶部固定 */
  mode: 1 | 4 | 5;
  /** `#rrggbb` */
  color: string;
  text: string;
}

/** 弹弹play 原始弹幕：`p` 的格式为 `"时间,模式,颜色,uid"`，`m` 是正文 */
export interface RawComment {
  cid?: number | string;
  p: string;
  m: string;
}

export interface DandanplayEpisode {
  episodeId: number;
  episodeTitle: string;
}

export interface DandanplayAnime {
  animeId: number;
  animeTitle: string;
  type?: string;
  typeDescription?: string;
  episodes: DandanplayEpisode[];
}

export interface DandanplaySearchResponse {
  success?: boolean;
  errorCode?: number;
  errorMessage?: string;
  animes?: DandanplayAnime[];
}

export interface DandanplayCommentResponse {
  success?: boolean;
  errorCode?: number;
  errorMessage?: string;
  count?: number;
  comments?: RawComment[];
  /** 关联剧集（withRelated=true 时返回），这里只做类型占位，不参与解析 */
  related?: unknown;
}

/**
 * 弹弹play 的匹配结果项。
 * `shift` 是官方给出的时间轴偏移（秒）：正值表示弹幕整体需要后移，
 * 即「实际播放时间 = 弹幕时间 + shift」。
 */
export interface DandanplayMatchItem {
  episodeId?: number;
  animeId?: number;
  animeTitle?: string;
  episodeTitle?: string;
  shift?: number;
}

/** 一条「番剧 + 分集」候选（pickBestAnime 的打分结果，供 UI 直接列出） */
export interface DanmakuCandidate {
  animeId: number;
  animeTitle: string;
  episodeId: number;
  episodeTitle: string;
  /** 匹配得分，越大越可信；仅用于排序与「是否给出自动匹配」判断 */
  score: number;
}

/**
 * 一集的弹幕绑定关系。
 * key 用 `${sourceKey}:${vodId}:${episodeIndex}`，与播放页的 episodeKey 完全一致：
 * 弹幕是「按集」的资源，同一部剧换源/换集都必须重新绑定，不能像跳过片段那样按剧名共享。
 */
export interface DanmakuMapping {
  episodeId: number;
  animeTitle: string;
  episodeTitle: string;
  /** 时间轴偏移（秒）：正值后移，负值前移（弹弹play 的 shift 与用户手调共用这个字段） */
  offsetSeconds: number;
  matchedAt: number;
  /** true = 由标题自动匹配写入；false = 用户在面板里手动选定 */
  auto: boolean;
}

/** 渲染样式（Canvas 引擎与设置面板共用同一份结构，避免两处各写一套字段名） */
export interface DanmakuStyle {
  /** 不透明度 0.1 ~ 1 */
  opacity: number;
  /** 字号（px） */
  fontSize: number;
  /** 速度倍率 0.5 ~ 2 */
  speed: number;
  /** 弹幕占画面高度的比例：0.25 / 0.5 / 0.75 / 1 */
  areaRatio: number;
  showScroll: boolean;
  showTop: boolean;
  showBottom: boolean;
  /** 最多并行的轨道数 */
  maxTracks: number;
  /** 同屏最多同时存在的弹幕条数：只限轨道数并不能阻止横轴刷屏 */
  maxActive: number;
}

export const DEFAULT_DANMAKU_STYLE: DanmakuStyle = {
  opacity: 0.9,
  fontSize: 20,
  speed: 1,
  areaRatio: 1,
  showScroll: true,
  showTop: true,
  showBottom: true,
  maxTracks: 10,
  maxActive: 140,
};

/**
 * 弹幕覆盖层的层级。
 *
 * 取值不是拍脑袋来的：ArtPlayer 内部是 `z-index` 分层的——
 *   `.art-video`(10) 是 <video> 本身，`.art-mask`(50)、`.art-bottom`(60)、
 *   `.art-notice`(80) 依次在上；而 `.art-video-player` 容器本身没有 z-index，
 *   不构成层叠上下文，所以它的子元素会与覆盖层在同一个层叠上下文里比较。
 * 因此覆盖层必须高于 10（否则被 <video> 盖住、弹幕完全看不见），
 * 又要低于 60（否则会画到控制栏上面去）。
 */
export const DANMAKU_LAYER_Z_INDEX = 20;

/**
 * 网页全屏下的层级与底部留白。
 *
 * 网页全屏是 ArtPlayer 把播放器根节点本身改成 `position: fixed; z-index: 9999`，
 * 而覆盖层是它的兄弟节点——留在原位的 canvas 会被整块盖住（弹幕在网页全屏里消失）。
 * 因此全屏时覆盖层也改成 fixed，并取 9999 之上的层级；底部留出控制栏的高度，
 * 让弹幕不压在进度条与按钮上（控制栏在网页全屏下高 60px）。
 */
export const DANMAKU_FULLSCREEN_Z_INDEX = 10000;

/** 网页全屏时底部给控制栏预留的高度（px），同时是绘制区域的底边界 */
export const DANMAKU_FULLSCREEN_BOTTOM_RESERVE = 60;

/** 设置面板的候选项（保持一处定义，面板与播放页不会各写一套取值） */
export const DANMAKU_OPACITY_OPTIONS = [0.3, 0.5, 0.7, 0.9, 1];
export const DANMAKU_FONT_SIZE_OPTIONS = [16, 18, 20, 24, 28];
export const DANMAKU_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
/**
 * 显示区域（弹幕占画面高度的比例）。
 * 用分数标签而不是百分比：1/3 显示成「33%」既不准也不直观。
 */
export const DANMAKU_AREA_OPTIONS: { value: number; label: string }[] = [
  { value: 0.25, label: '1/4' },
  { value: 0.34, label: '1/3' },
  { value: 0.5, label: '1/2' },
  { value: 0.75, label: '3/4' },
  { value: 1, label: '全部' },
];

/** 弹幕密度档位：轨道数与同屏条数一起缩放，避免「只减轨道、横轴照样刷屏」 */
export type DanmakuDensity = 'low' | 'medium' | 'high';

export const DANMAKU_DENSITY_OPTIONS: {
  value: DanmakuDensity;
  label: string;
  maxTracks: number;
  maxActive: number;
}[] = [
  { value: 'low', label: '少', maxTracks: 5, maxActive: 60 },
  { value: 'medium', label: '中', maxTracks: 10, maxActive: 140 },
  { value: 'high', label: '多', maxTracks: 16, maxActive: 260 },
];

/** 把密度档位换算成引擎参数；未知值（旧快照/手改）回落到「中」 */
export function densityLimits(density: DanmakuDensity | undefined): {
  maxTracks: number;
  maxActive: number;
} {
  const hit = DANMAKU_DENSITY_OPTIONS.find((o) => o.value === density);
  const opt = hit ?? DANMAKU_DENSITY_OPTIONS[1];
  return { maxTracks: opt.maxTracks, maxActive: opt.maxActive };
}

/** 持久化数据可能来自旧版本，密度必须先归一化再进引擎 */
export function normalizeDanmakuDensity(value: unknown): DanmakuDensity {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

/** 各项取值的合法区间：持久化数据可能来自旧版本或被手改，渲染前统一夹紧 */
export const DANMAKU_LIMITS = {
  opacity: { min: 0.1, max: 1 },
  fontSize: { min: 12, max: 48 },
  speed: { min: 0.5, max: 2 },
  areaRatio: { min: 0.25, max: 1 },
  maxTracks: { min: 1, max: 20 },
  maxActive: { min: 20, max: 400 },
} as const;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 把任意来源的样式补全并夹到合法区间（引擎 setOptions 与设置面板共用） */
export function resolveDanmakuStyle(patch?: Partial<DanmakuStyle> | null): DanmakuStyle {
  const src = patch ?? {};
  return {
    opacity: clampNumber(src.opacity, DANMAKU_LIMITS.opacity.min, DANMAKU_LIMITS.opacity.max, DEFAULT_DANMAKU_STYLE.opacity),
    fontSize: clampNumber(src.fontSize, DANMAKU_LIMITS.fontSize.min, DANMAKU_LIMITS.fontSize.max, DEFAULT_DANMAKU_STYLE.fontSize),
    speed: clampNumber(src.speed, DANMAKU_LIMITS.speed.min, DANMAKU_LIMITS.speed.max, DEFAULT_DANMAKU_STYLE.speed),
    areaRatio: clampNumber(src.areaRatio, DANMAKU_LIMITS.areaRatio.min, DANMAKU_LIMITS.areaRatio.max, DEFAULT_DANMAKU_STYLE.areaRatio),
    showScroll: typeof src.showScroll === 'boolean' ? src.showScroll : DEFAULT_DANMAKU_STYLE.showScroll,
    showTop: typeof src.showTop === 'boolean' ? src.showTop : DEFAULT_DANMAKU_STYLE.showTop,
    showBottom: typeof src.showBottom === 'boolean' ? src.showBottom : DEFAULT_DANMAKU_STYLE.showBottom,
    maxActive: Math.round(
      clampNumber(src.maxActive, DANMAKU_LIMITS.maxActive.min, DANMAKU_LIMITS.maxActive.max, DEFAULT_DANMAKU_STYLE.maxActive)
    ),
    maxTracks: Math.round(
      clampNumber(src.maxTracks, DANMAKU_LIMITS.maxTracks.min, DANMAKU_LIMITS.maxTracks.max, DEFAULT_DANMAKU_STYLE.maxTracks)
    ),
  };
}

/**
 * 弹幕颜色：上游给的是十进制 RGB 整数（如 16777215 = 白色）。
 * 越界/缺失一律回退白色——深色描边保证白字在亮画面上依然可读，
 * 而颜色算错（变成透明或纯黑）会让弹幕直接"消失"，比颜色不准更糟。
 */
function toHexColor(raw: string | undefined): string {
  if (!raw) return '#ffffff';
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 0xffffff) return '#ffffff';
  return `#${Math.trunc(value).toString(16).padStart(6, '0')}`;
}

/** `p` 的第二个字段映射到三种渲染模式；未知模式丢弃（宁可少画，不要画出错位的弹幕） */
function toMode(raw: string | undefined): 1 | 4 | 5 | null {
  const value = Number(raw);
  // 1/2/3 都是滚动（2、3 极少见，弹弹play 文档里只保留了定义），统一按滚动处理
  if (value === 1 || value === 2 || value === 3) return 1;
  if (value === 4) return 4;
  if (value === 5) return 5;
  return null;
}

/** 解析一条原始弹幕；脏数据返回 null（时间非法、模式非法、正文为空） */
export function parseComment(raw: RawComment | null | undefined): DanmakuItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.m === 'string' ? raw.m.trim() : '';
  if (!text) return null;
  if (typeof raw.p !== 'string' || !raw.p) return null;

  const parts = raw.p.split(',');
  if (parts.length < 2) return null;

  const time = Number(parts[0]);
  // 时间为 0 是合法的（片头第一条），只有负数与非有限数才算脏数据
  if (!Number.isFinite(time) || time < 0) return null;

  const mode = toMode(parts[1]);
  if (mode === null) return null;

  return { time, mode, color: toHexColor(parts[2]), text };
}

/** 批量解析并按时间升序（时间轴游标依赖有序，必须在入口排好） */
export function parseComments(rawList: unknown): DanmakuItem[] {
  if (!Array.isArray(rawList)) return [];
  const items: DanmakuItem[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const item = parseComment(raw as RawComment);
    if (item) items.push(item);
  }
  items.sort((a, b) => a.time - b.time);
  return items;
}

/**
 * 施加时间轴偏移。
 * 负偏移会把靠前的弹幕推到 0 之前（时间轴没有负时间），这些直接丢弃；
 * 偏移量非法时退化为原样返回，不能让一次错误的持久化数据清空整集弹幕。
 */
export function shiftDanmaku(items: readonly DanmakuItem[], offsetSeconds: number): DanmakuItem[] {
  const offset = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  if (offset === 0) return items.slice();
  const shifted: DanmakuItem[] = [];
  for (const item of items) {
    const time = item.time + offset;
    if (!Number.isFinite(time) || time < 0) continue;
    shifted.push({ ...item, time });
  }
  shifted.sort((a, b) => a.time - b.time);
  return shifted;
}

/** 集数归一：支持数字、`"3"`、`"第3集"`；认不出返回 null */
export function normalizeEpisodeNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const matched = value.match(/\d{1,4}/);
  if (!matched) return null;
  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 从分集标题里抽出所有数字，用于判断「这一条是不是要找的那一集」 */
function numbersIn(text: string): number[] {
  const matched = text.match(/\d{1,4}/g);
  return matched ? matched.map((n) => Number(n)) : [];
}

/**
 * 给「番剧 + 分集」打分并排序。
 *
 * 采集站的标题带一堆噪声（国语、HD、[未删减]…），所以先归一化再比：
 *   - 完全相等 100 分，标题包含 70 分，被包含 40 分（短标题容易误命中，故降权）；
 *   - 分集标题里出现目标集数再加 50 分：看起来权重偏高，但"这一集对不对"
 *     比"番剧名对不对"更能决定体验——集数错了整集弹幕全是别人的时间轴；
 *   - 一条都打不上分的番剧直接不进入候选，避免候选列表被无关结果淹没。
 * 返回排序后的完整列表而不是单个最优项：UI 要把候选全列出来让用户改选，
 * 自动匹配只取第一条（score > 0 才认为匹配成功）。
 */
export function pickBestAnime(
  animes: readonly DandanplayAnime[] | undefined,
  wantedTitle: string,
  wantedEpisode?: number | string | null
): DanmakuCandidate[] {
  const wanted = normalizeTitle(wantedTitle ?? '');
  if (!wanted) return [];
  const target = normalizeEpisodeNumber(wantedEpisode ?? null);

  const candidates: DanmakuCandidate[] = [];
  for (const anime of animes ?? []) {
    if (!anime || !Array.isArray(anime.episodes)) continue;
    const animeId = Number(anime.animeId);
    if (!Number.isFinite(animeId)) continue;
    const animeTitle = typeof anime.animeTitle === 'string' ? anime.animeTitle : '';
    const normalized = normalizeTitle(animeTitle);
    if (!normalized) continue;

    let titleScore = 0;
    if (normalized === wanted) titleScore = 100;
    else if (normalized.includes(wanted)) titleScore = 70;
    else if (wanted.includes(normalized) && normalized.length >= 2) titleScore = 40;
    else continue;

    for (const episode of anime.episodes) {
      if (!episode) continue;
      const episodeId = Number(episode.episodeId);
      if (!Number.isFinite(episodeId) || episodeId <= 0) continue;
      const episodeTitle = typeof episode.episodeTitle === 'string' ? episode.episodeTitle : '';
      const episodeScore = target !== null && numbersIn(episodeTitle).includes(target) ? 50 : 0;
      candidates.push({ animeId, animeTitle, episodeId, episodeTitle, score: titleScore + episodeScore });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.episodeId - b.episodeId);
  return candidates;
}

/**
 * 把弹弹play 的候选摊平成 UI 可以直接渲染的行。
 * 面板与自动匹配需要的是同一个顺序，摊平逻辑放这里，避免两处各写一遍导致顺序不一致。
 */
export function flattenCandidates(
  animes: readonly DandanplayAnime[] | undefined,
  wantedTitle: string,
  wantedEpisode?: number | string | null
): DanmakuCandidate[] {
  return pickBestAnime(animes, wantedTitle, wantedEpisode);
}

/** 标题噪声：采集站标题里的括注、集数、清晰度/语言标签，匹配前必须清掉 */
const TITLE_NOISE_PATTERNS: readonly RegExp[] = [
  /\[[^\]]*\]/g,
  /【[^】]*】/g,
  /\([^)]*\)/g,
  /（[^）]*）/g,
  /第\s*\d{1,4}\s*[集话話期]/g,
  /\b(?:HD|BD|4K|8K|1080P|2160P|720P|WEB-DL|HDR|HEVC|AVC|X264|X265)\b/gi,
  /(?:国语|粤语|中字|中文字幕|简繁字幕|完整版|无删减|未删减|抢先版|高清版)/g,
];

/**
 * 清洗视频标题，得到可以直接拿去搜番剧的关键词。
 * 例如「庆余年 第二季 第03集【高清】」→「庆余年 第二季」。
 * 清洗后为空（极端情况）时返回原标题，至少不会让搜索参数为空。
 */
export function cleanDanmakuTitle(raw: string): string {
  if (!raw) return '';
  let cleaned = raw;
  for (const pattern of TITLE_NOISE_PATTERNS) cleaned = cleaned.replace(pattern, ' ');
  cleaned = cleaned
    .replace(/[-_·／/|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw.trim();
}

/**
 * 迁移持久化快照里的 danmakuMappings（persist v8 → v9）。
 * 逐条校验结构：面板与播放页直接读这些字段，损坏条目会让请求带上 NaN。
 */
export function migrateDanmakuMappings(raw: unknown): Record<string, DanmakuMapping> {
  const result: Record<string, DanmakuMapping> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<DanmakuMapping>;
    const episodeId = Number(entry.episodeId);
    if (!Number.isFinite(episodeId) || episodeId <= 0) continue;
    result[key] = {
      episodeId,
      animeTitle: typeof entry.animeTitle === 'string' ? entry.animeTitle : '',
      episodeTitle: typeof entry.episodeTitle === 'string' ? entry.episodeTitle : '',
      offsetSeconds:
        typeof entry.offsetSeconds === 'number' && Number.isFinite(entry.offsetSeconds) ? entry.offsetSeconds : 0,
      matchedAt: typeof entry.matchedAt === 'number' && Number.isFinite(entry.matchedAt) ? entry.matchedAt : Date.now(),
      auto: entry.auto === true,
    };
  }
  return result;
}
