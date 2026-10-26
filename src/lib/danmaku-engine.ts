'use client';

import {
  resolveDanmakuStyle,
  type DanmakuItem,
  type DanmakuStyle,
} from './danmaku';

/**
 * 外挂弹幕的 Canvas 渲染引擎。
 *
 * 「外挂」的含义：不接 ArtPlayer 的弹幕插件、不往 DOM 里插节点，只用一块绝对定位的
 * <canvas> 盖在 <video> 上自己画。代价是覆盖层与 video 元素是两个独立的图层
 * （原生全屏只渲染 video，见 player-shell 里对 fullscreen 的处理），
 * 换来的是零依赖、可完全按本站需求裁剪的渲染逻辑。
 *
 * 时间轴只有一个：video.currentTime。不用自己累加时间，
 * 暂停 / 倍速 / seek 因此天然正确——累加方案在这三件事上都要额外打补丁。
 *
 * 模块内的纯函数（文本宽度估算、轨道分配、时间窗口游标）单独导出，
 * 便于在 node 环境单测：整条渲染链路依赖 canvas/video，无法在单测里跑。
 */

/** 滚动弹幕的基准速度（px/秒）；style.speed 在此之上做倍率 */
const BASE_SCROLL_SPEED = 140;
/** 顶部/底部固定弹幕的停留时间（秒），与主流播放器观感一致 */
const FIXED_DURATION = 4;
/** 轨道行距系数：字号 × 该系数 = 一条轨道的高度 */
const TRACK_LINE_HEIGHT = 1.35;
/** 两条滚动弹幕之间的入场间隔（秒）：防止尾巴刚离开右侧就贴上下一条 */
const SCROLL_ENTRY_GAP_SECONDS = 0.12;
/** 时间回退超过该值即判定为 seek（正常播放不会倒退） */
const SEEK_BACKWARD_EPSILON = 0.35;
/** 时间前跳超过该值也判定为「跳过了内容」（后台标签页恢复 rAF、直播式跳变等） */
const FORWARD_JUMP_EPSILON = 2;
/** 同屏活跃弹幕上限：脏数据里同一秒可能有上千条，无限堆叠会直接卡死渲染 */

/** 绘制字体族：优先系统中文黑体，避免回退到衬线体导致小字糊成一团 */
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

/** 各类弹幕在同屏时的绘制结果（只在这里持有状态，不产生 DOM 节点） */
interface ActiveDanmaku {
  text: string;
  color: string;
  mode: 1 | 4 | 5;
  /** 出现与消失的播放时间（秒） */
  start: number;
  end: number;
  /** 所在轨道下标 */
  track: number;
  /** 文本宽度（px），滚动与居中定位都依赖它 */
  width: number;
}

/**
 * 估算文本宽度。
 * Canvas 的 measureText 需要 ctx，而引擎每帧要为新弹幕算宽度、单测里又没有 canvas，
 * 所以用字宽近似：中日韩字符按 1em、ASCII 按 0.55em。
 * 弹幕场景只需要"够用"的宽度（决定滚动时长与轨道占用），不需要像素级精确。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  if (!text || !Number.isFinite(fontSize) || fontSize <= 0) return 0;
  let width = 0;
  for (const char of text) {
    width += isWideChar(char) ? fontSize : fontSize * 0.55;
  }
  return width;
}

/** 全角字符判定：CJK 统一表意文字、假名、谚文、全角标点与兼容表意区 */
function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * 轨道分配：返回第一条「已释放」的轨道下标，全部占用时返回 -1。
 * -1 的语义是「本帧丢弃」而不是「排队等待」：弹幕晚 1 秒出现就已经和画面对不上了，
 * 排队只会让积压越来越多，宁可少画一条。
 *
 * releasedAt[i] 是该轨道恢复可用的时间（播放时间轴，秒）；非有限值视为空闲（防御脏数据）。
 */
export function allocateTrack(releasedAt: readonly number[], now: number): number {
  if (!Number.isFinite(now)) return -1;
  for (let i = 0; i < releasedAt.length; i++) {
    const freeAt = releasedAt[i];
    if (!Number.isFinite(freeAt) || freeAt <= now) return i;
  }
  return -1;
}

/** 时间窗口游标：只记「下一条待发射弹幕」的下标，避免每帧从头扫描整集弹幕 */
export interface DanmakuCursor {
  next: number;
}

export function createCursor(): DanmakuCursor {
  return { next: 0 };
}

/** 二分找到第一条 time >= target 的下标（弹幕必须已按 time 升序） */
function firstIndexAtOrAfter(items: readonly DanmakuItem[], target: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (items[mid].time < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 把游标重新定位到指定播放时间。
 * seek 是唯一会让游标失效的操作：向后拖时必须回退游标（否则中间那段弹幕永远补不回来），
 * 向前拖时也必须跳过（否则会被当成"刚到时"一次性喷出几百条）。
 */
export function resetCursor(cursor: DanmakuCursor, items: readonly DanmakuItem[], time: number): void {
  const target = Number.isFinite(time) ? Math.max(0, time) : 0;
  cursor.next = firstIndexAtOrAfter(items, target);
}

/**
 * 取窗口内（time 及之前）尚未发射的弹幕，并推进游标。
 * 等价于「按播放时间取窗口 + 游标推进」，但不需要传右边界：
 * 调用方每帧以当前播放时间为上界，弹幕自然只在到点的那一帧被取出。
 */
export function takeDueComments(
  items: readonly DanmakuItem[],
  cursor: DanmakuCursor,
  time: number
): DanmakuItem[] {
  if (!Number.isFinite(time)) return [];
  const due: DanmakuItem[] = [];
  while (cursor.next < items.length && items[cursor.next].time <= time) {
    due.push(items[cursor.next]);
    cursor.next += 1;
  }
  return due;
}

/**
 * DanmakuEngine：把弹幕画到 canvas 上。
 * 生命周期：new → load(items) →（播放中每帧渲染）→ destroy()。
 */
export class DanmakuEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private style: DanmakuStyle;
  private items: DanmakuItem[] = [];
  private cursor: DanmakuCursor = createCursor();
  private active: ActiveDanmaku[] = [];
  private scrollTracks: number[] = [];
  private topTracks: number[] = [];
  private bottomTracks: number[] = [];
  private rafHandle = 0;
  private destroyed = false;
  /** 覆盖层是否可见：关闭弹幕时整帧跳过，不白烧 CPU */
  private visible = true;
  /** 上一帧的播放时间：用于识别 seek 造成的回退 */
  private lastTime = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private resizeObserver: ResizeObserver | null = null;

  private readonly handleSeek = () => {
    // seek 后既有的在屏弹幕属于"旧时间点"，必须清掉；游标按新位置重定位。
    // 这里必须连画布一起清：暂停中 seek 不会有下一帧绘制，不清屏会留下定格残影
    this.reset();
  };

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement, options?: Partial<DanmakuStyle>) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.style = resolveDanmakuStyle(options);

    this.measure();
    this.watchResize();
    video.addEventListener('seeking', this.handleSeek);
    video.addEventListener('seeked', this.handleSeek);

    this.lastTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    this.rafHandle = requestAnimationFrame(this.loop);
  }

  /** 换集/换片：整体替换弹幕并复位时间轴 */
  load(items: readonly DanmakuItem[]): void {
    // 拷贝一份并按时间升序：游标推进与二分查找都依赖有序，调用方不该被强制排序
    this.items = items.slice().sort((a, b) => a.time - b.time);
    this.resetTimeline();
    this.clearCanvas();
  }

  /** 增量更新样式（设置面板改透明度/字号/速度时不需要重建引擎） */
  setOptions(patch: Partial<DanmakuStyle>): void {
    const next = resolveDanmakuStyle({ ...this.style, ...patch });
    const layoutChanged =
      next.fontSize !== this.style.fontSize ||
      next.areaRatio !== this.style.areaRatio ||
      next.speed !== this.style.speed ||
      next.maxTracks !== this.style.maxTracks;
    this.style = next;
    if (layoutChanged) {
      // 轨道高度/速度变了，在屏弹幕的坐标与时长都不再正确：清屏重来
      this.resetTimeline();
      this.clearCanvas();
    }
  }

  /** 复位：清屏 + 游标回到当前播放位置（换集、seek、开关弹幕都走这里） */
  reset(): void {
    this.resetTimeline();
    this.clearCanvas();
  }

  /**
   * 显示/隐藏覆盖层。
   * 隐藏时整帧跳过：弹幕关掉后 rAF 仍在跑，继续绘制纯属浪费电量（移动端尤其明显）。
   * 再次显示必须伴随一次 reset()（调用方负责），否则会补喷隐藏期间的弹幕。
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.active = [];
      this.clearCanvas();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafHandle);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.video.removeEventListener('seeking', this.handleSeek);
    this.video.removeEventListener('seeked', this.handleSeek);
    this.active = [];
    this.items = [];
    this.clearCanvas();
  }

  private resetTimeline(): void {
    this.active = [];
    this.scrollTracks = [];
    this.topTracks = [];
    this.bottomTracks = [];
    const now = Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
    this.lastTime = now;
    resetCursor(this.cursor, this.items, now);
  }

  private watchResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      this.measure();
      // 尺寸变了（进出网页全屏 / 窗口缩放），在屏弹幕的坐标全部失效：
      // 直接复位而不是硬搬坐标，避免弹幕挤成一团或从屏幕外飘进来
      this.reset();
    });
    this.resizeObserver.observe(this.canvas);
  }

  /** 按 devicePixelRatio 缩放后备缓冲，让文字在高分屏上不发虚 */
  private measure(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2);
    if (width === this.cssWidth && height === this.cssHeight) {
      const expectedWidth = Math.round(width * dpr);
      if (this.canvas.width === expectedWidth) return;
    }
    this.cssWidth = width;
    this.cssHeight = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clearCanvas(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  /** 可用轨道数：受区域比例、字号与 maxTracks 三者共同约束 */
  private trackCount(): number {
    const lineHeight = this.style.fontSize * TRACK_LINE_HEIGHT;
    const areaHeight = this.cssHeight * this.style.areaRatio;
    const byArea = Math.floor(areaHeight / lineHeight);
    return Math.max(1, Math.min(this.style.maxTracks, byArea || 1));
  }

  private ensureTrackArrays(count: number): void {
    if (this.scrollTracks.length !== count) this.scrollTracks = new Array<number>(count).fill(Number.NEGATIVE_INFINITY);
    if (this.topTracks.length !== count) this.topTracks = new Array<number>(count).fill(Number.NEGATIVE_INFINITY);
    // 底部固定弹幕与顶部共用轨道数即可：两者很少同时占满
    if (this.bottomTracks.length !== count) this.bottomTracks = new Array<number>(count).fill(Number.NEGATIVE_INFINITY);
  }

  private loop = (): void => {
    if (this.destroyed) return;
    this.rafHandle = requestAnimationFrame(this.loop);

    const video = this.video;
    // 弹幕关闭 / 暂停 / 拖动 / 已结束时停止推进：时间轴不动就不该有新弹幕"凭空出现"
    if (!this.visible || video.paused || video.ended || video.seeking) return;

    const now = video.currentTime;
    if (!Number.isFinite(now)) return;
    // 回退或大幅前跳都说明「时间轴不连续」（seek / 后台标签页恢复），
    // 此时把游标重定位到当前位置：否则一次前跳会把中间所有弹幕当成"刚到点"一起喷出来
    if (now < this.lastTime - SEEK_BACKWARD_EPSILON || now - this.lastTime > FORWARD_JUMP_EPSILON) {
      this.resetTimeline();
    }
    this.lastTime = now;

    this.spawn(now);
    this.paint(now);
  };

  /** 把到点的弹幕分配到轨道上（找不到轨道就丢弃） */
  private spawn(now: number): void {
    const due = takeDueComments(this.items, this.cursor, now);
    if (due.length === 0) return;

    const tracks = this.trackCount();
    this.ensureTrackArrays(tracks);

    const fontSize = this.style.fontSize;
    const pxPerSecond = Math.max(1, BASE_SCROLL_SPEED * this.style.speed);

    for (const item of due) {
      if (this.active.length >= this.style.maxActive) break;
      const width = estimateTextWidth(item.text, fontSize);
      if (width <= 0) continue;

      if (item.mode === 1) {
        if (!this.style.showScroll) continue;
        const track = allocateTrack(this.scrollTracks, now);
        if (track < 0) continue;
        // 上一条的尾部完全进入画面后本轨道才算空出来：同速滚动不会追尾，这是最小间隔条件
        this.scrollTracks[track] = now + width / pxPerSecond + SCROLL_ENTRY_GAP_SECONDS;
        this.active.push({
          text: item.text,
          color: item.color,
          mode: 1,
          start: now,
          end: now + (this.cssWidth + width) / pxPerSecond,
          track,
          width,
        });
        continue;
      }

      const isTop = item.mode === 5;
      if (isTop && !this.style.showTop) continue;
      if (!isTop && !this.style.showBottom) continue;

      const track = allocateTrack(isTop ? this.topTracks : this.bottomTracks, now);
      if (track < 0) continue;
      if (isTop) this.topTracks[track] = now + FIXED_DURATION;
      else this.bottomTracks[track] = now + FIXED_DURATION;
      this.active.push({
        text: item.text,
        color: item.color,
        mode: item.mode,
        start: now,
        end: now + FIXED_DURATION,
        track,
        width,
      });
    }
  }

  /** 绘制当前时刻的所有在屏弹幕，并顺手回收已结束的 */
  private paint(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    if (this.active.length === 0) return;

    const fontSize = this.style.fontSize;
    const lineHeight = fontSize * TRACK_LINE_HEIGHT;
    const pxPerSecond = Math.max(1, BASE_SCROLL_SPEED * this.style.speed);
    const areaHeight = this.cssHeight * this.style.areaRatio;

    ctx.font = `${fontSize}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = this.style.opacity;
    // 描边保证在亮画面上可读：纯 fillText 在雪景/白墙镜头里会完全消失
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = Math.max(2, fontSize / 8);

    const alive: ActiveDanmaku[] = [];
    for (const danmaku of this.active) {
      if (now >= danmaku.end) continue;
      alive.push(danmaku);

      const elapsed = Math.max(0, now - danmaku.start);
      let x: number;
      let y: number;

      if (danmaku.mode === 1) {
        x = this.cssWidth - elapsed * pxPerSecond;
        y = danmaku.track * lineHeight + 2;
      } else if (danmaku.mode === 5) {
        x = (this.cssWidth - danmaku.width) / 2;
        y = danmaku.track * lineHeight + 2;
      } else {
        // 底部固定从区域底边往上排：视觉上"贴底"，与顶部固定对称
        x = (this.cssWidth - danmaku.width) / 2;
        y = Math.max(0, areaHeight - (danmaku.track + 1) * lineHeight);
      }

      // 完全移出画面的滚动弹幕不必再画（省掉不可见的绘制开销）
      if (x + danmaku.width < 0 || x > this.cssWidth) continue;

      ctx.strokeText(danmaku.text, x, y);
      ctx.fillStyle = danmaku.color;
      ctx.fillText(danmaku.text, x, y);
    }

    this.active = alive;
    ctx.globalAlpha = 1;
  }
}
