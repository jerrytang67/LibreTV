'use client';

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';

import {
  DANMAKU_FULLSCREEN_BOTTOM_RESERVE,
  DANMAKU_FULLSCREEN_Z_INDEX,
  DANMAKU_LAYER_Z_INDEX,
  type DanmakuItem,
  type DanmakuStyle,
} from '@/lib/danmaku';
import { DanmakuEngine } from '@/lib/danmaku-engine';

/**
 * 弹幕覆盖层：一块铺满播放器画面、不吃点击的 <canvas>。
 *
 * 为什么是独立组件而不是塞进 player-shell：
 * 播放器外壳已经很长了，弹幕的生命周期（创建引擎 / 装载数据 / 更新样式 / 销毁）
 * 自成一套，抽出来才能保证「换集只换数据、不重建引擎」。
 *
 * pointer-events: none 是硬性要求——覆盖层不允许挡住播放器的任何点击（点画面暂停、
 * 拖进度条、右键菜单），否则最基础的播放交互会整个失灵。
 *
 * 两种定位：
 * - 常态：wrapper 内的 absolute 铺满，z-index 20（高于 <video> 的 10、低于控制栏的 60）；
 * - 网页全屏：ArtPlayer 把播放器根节点改成 fixed + z-index 9999，覆盖层必须跟着改成
 *   fixed 并抬到 10000，否则会被播放器整块盖住（网页全屏下弹幕"消失"）。
 *   底部预留控制栏高度，避免弹幕压在进度条上。
 */
export function DanmakuLayer({
  video,
  items,
  options,
  visible,
  fullscreen = false,
}: {
  /** 播放器创建后由 PlayerShell 传入；为 null 时不渲染引擎 */
  video: HTMLVideoElement | null;
  items: DanmakuItem[];
  options: DanmakuStyle;
  visible: boolean;
  /** 是否处于网页全屏（由 PlayerShell 监听 ArtPlayer 的 fullscreenWeb 事件传入） */
  fullscreen?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DanmakuEngine | null>(null);
  // 首帧（引擎创建时）需要立即用上最新的数据与样式，用 ref 取，避免把 video 之外的依赖
  // 放进创建 effect 里导致「改一下字号就重建引擎」
  const itemsRef = useRef(items);
  const optionsRef = useRef(options);
  const visibleRef = useRef(visible);
  itemsRef.current = items;
  optionsRef.current = options;
  visibleRef.current = visible;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !video) return;
    const engine = new DanmakuEngine(canvas, video, optionsRef.current);
    // 挂载时 layout effect 已经跑过（那时还没有引擎），可见性在这里补一次：
    // 否则「初始不可见」的弹幕层会让引擎白跑 rAF
    engine.setVisible(visibleRef.current);
    engine.load(itemsRef.current);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [video]);

  // 同步引擎状态一律用 layout effect：必须在本帧绘制前完成。
  // 用普通 effect（绘制后才执行）时，换集传入 items=[] 的那一帧画布上还留着上一集的像素，
  // 于是"换集残留一帧"仍然肉眼可见。本组件由 PlayerShell 动态加载（ssr:false），不会 SSR，
  // 因此没有 useLayoutEffect 的服务端告警问题。
  // 注意：挂载时 layout effect 先于下面创建引擎的 effect 执行，此时 engineRef 还是空，
  // 可选链会安全跳过；首帧数据由创建 effect 里 engine.load(itemsRef.current) 补上。
  useLayoutEffect(() => {
    engineRef.current?.load(items);
  }, [items]);

  useLayoutEffect(() => {
    engineRef.current?.setOptions(options);
  }, [options]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.visibility = visible ? 'visible' : 'hidden';
    engineRef.current?.setVisible(visible);
    // 切换开关时复位：重新打开不应该把「关掉期间」积压的弹幕一次性喷出来
    engineRef.current?.reset();
  }, [visible]);

  // 尺寸变化（进出网页全屏）由引擎内部的 ResizeObserver 感知，这里只负责定位
  const style: CSSProperties = fullscreen
    ? {
        position: 'fixed',
        top: 0,
        left: 0,
        // 必须显式给宽高：canvas 是**替换元素**，在「left/right 都不是 auto 而 width:auto」
        // 的情况下不会按约束拉伸，而是退回内在尺寸（CSS2.1 §10.3.8）。
        // 只写 left/right 时实测全屏后仍是 932×524，弹幕只铺满左上角一小块。
        width: '100vw',
        height: `calc(100vh - ${DANMAKU_FULLSCREEN_BOTTOM_RESERVE}px)`,
        zIndex: DANMAKU_FULLSCREEN_Z_INDEX,
        pointerEvents: 'none',
        // 透明底是硬性要求：覆盖层一旦有背景色，全屏时会把整个画面盖成一片纯色
        background: 'transparent',
      }
    : {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: DANMAKU_LAYER_Z_INDEX,
        pointerEvents: 'none',
        background: 'transparent',
      };

  return <canvas ref={canvasRef} aria-hidden className="select-none" style={style} />;
}
