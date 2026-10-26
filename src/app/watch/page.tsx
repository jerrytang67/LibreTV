'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
// 播放器（artplayer + hls.js）按需加载：拆出独立 chunk，不占首屏 First Load JS
const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { SwitchSourceModal } from '@/components/switch-source';
import { SkipMarkPanel } from '@/components/skip-mark-panel';
import { DanmakuPanel } from '@/components/danmaku-panel';
import { skipMarkKey, validateSegment, UNKNOWN_TITLE, type SkipSegment } from '@/lib/skip-marks';
import {
  cleanDanmakuTitle,
  densityLimits,
  shiftDanmaku,
  type DanmakuItem,
  type DanmakuStyle,
} from '@/lib/danmaku';
import { DanmakuNotConfiguredError, fetchDanmakuComments, searchDanmaku } from '@/lib/danmaku-client';
import type { PlayerSkipApi } from '@/components/player-shell';
import { useToast } from '@/components/toast';
import { enqueueDownload } from '@/components/download-manager';
import { Icon } from '@/components/icon';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityKey } from '@/lib/quality';
import {
  clearProgress,
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
  db,
} from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * 共享的空弹幕数组常量。
 * 换集/未匹配时返回它而不是 `[]`：每次渲染都 new 一个数组会让下游 useMemo/useEffect
 * 误判「数据变了」，进而每帧重置引擎。
 */
const EMPTY_DANMAKU_ITEMS: DanmakuItem[] = [];

/**
 * 播放页（唯一入口，替代旧版 watch.html → player.html 跳转链）。
 * 状态全部由 URL 驱动：/watch?source=xx&id=..&index=..&title=..
 * 集数列表由服务端详情接口获取；进度与历史走 IndexedDB。
 */
export default function WatchPage() {
  return (
    <Suspense>
      <WatchContent />
    </Suspense>
  );
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  const { verified } = useAuth();
  const { toast } = useToast();

  const sourceKey = searchParams.get('source') || '';
  const vodId = searchParams.get('id') || '';
  const directUrl = searchParams.get('url') || '';
  const titleParam = searchParams.get('title') || '';
  const indexParam = parseInt(searchParams.get('index') || '0', 10) || 0;

  const [reversed, setReversed] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [skipPanelOpen, setSkipPanelOpen] = useState(false);
  const [danmakuPanelOpen, setDanmakuPanelOpen] = useState(false);
  // 播放器对外暴露的精确时间读取接口（「记录当前」用），随播放器卸载置空
  const playerApiRef = useRef<PlayerSkipApi | null>(null);
  // 播放框：小屏「跳过标记」抽屉要按它的底边算剩余高度，避免压住画面
  const playerFrameRef = useRef<HTMLDivElement | null>(null);
  const [sheetMaxHeight, setSheetMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    // 两个抽屉（跳过标记 / 弹幕）都按同一套规则算高度：小屏都要避开画面
    if (!skipPanelOpen && !danmakuPanelOpen) return;
    const measure = () => {
      // 桌面端抽屉贴右侧、整屏高，不受播放器位置影响
      if (window.matchMedia('(min-width: 1024px)').matches) {
        setSheetMaxHeight(undefined);
        return;
      }
      const box = playerFrameRef.current?.getBoundingClientRect();
      if (!box) {
        setSheetMaxHeight(undefined);
        return;
      }
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const room = viewport - box.bottom - 12;
      // 不超过视口 60%；矮窗下最多压到 160px，再小就没法用了
      setSheetMaxHeight(Math.round(Math.max(160, Math.min(viewport * 0.6, room))));
    };
    measure();
    // 只在打开与尺寸变化时测：跟着滚动实时改高度会让抽屉边滚边长，很晃
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [skipPanelOpen, danmakuPanelOpen]);

  const source = resolveSource(store, sourceKey, {
    url: searchParams.get('sourceUrl') || undefined,
    detail: searchParams.get('detail') || undefined,
  });

  // 详情查询：无 id（纯直连链接分享）时跳过
  const detailQuery = useQuery({
    queryKey: ['detail', sourceKey, vodId, source?.url],
    queryFn: ({ signal }) => api.detail(vodId, source!, signal),
    enabled: Boolean(source && vodId && verified),
    staleTime: 5 * 60_000,
  });

  const episodes = useMemo(() => detailQuery.data?.episodes ?? [], [detailQuery.data]);
  const videoTitle = titleParam || detailQuery.data?.videoInfo?.title || UNKNOWN_TITLE;

  // 当前播放地址：优先取剧集列表中的当前集，其次直连 URL 参数
  const currentUrl = useMemo(() => {
    if (episodes.length > 0) {
      const idx = Math.min(Math.max(indexParam, 0), episodes.length - 1);
      return episodes[idx] || directUrl;
    }
    return directUrl;
  }, [episodes, indexParam, directUrl]);

  const currentIndex = useMemo(() => {
    if (episodes.length > 0) return Math.min(Math.max(indexParam, 0), episodes.length - 1);
    return indexParam;
  }, [episodes, indexParam]);

  // 跳过片段按剧名记忆：换集不变，换源到同名资源也能命中。
  // 标题缺失（直连链接）时退回 source:vodId，至少保证本源本片可用。
  const skipMarkFallback = `${sourceKey}:${vodId || currentUrl}`;
  const markKey = useMemo(
    () => skipMarkKey(videoTitle, skipMarkFallback),
    [videoTitle, skipMarkFallback]
  );
  const skipMark = store.skipMarks[markKey];
  const markedCount = skipMark?.segments.length ?? 0;

  // —— 外挂弹幕 ——
  // 绑定按「源 + 影片 + 集数」记录：弹幕是每集独立的资源，换集必须重新匹配，
  // 不能沿用上一集的 items（时间轴连着，但内容与偏移完全不同）。
  const episodeKey = `${sourceKey}:${vodId}:${currentIndex}`;
  const danmakuMapping = store.danmakuMappings[episodeKey];
  const danmakuEpisodeId = danmakuMapping?.episodeId;
  /**
   * 已加载的弹幕，**连同它属于哪一集**一起存。
   *
   * 只存 items 会有一个真实缺陷：换集时 danmakuEpisodeId 变了、effect 重跑只是发起新请求，
   * 上一集的几百条弹幕仍留在 state 里，直到新请求 resolve 才被覆盖——这中间会把上一集的
   * 弹幕（还套着新集的 offset）画到新集上。打上 episodeId 后，下面的渲染期判定可以在
   * **换集后的第一帧**就返回空数组，不留任何残留窗口。
   * 同一集的手动「重新加载弹幕」不清空（id 相同），避免画面闪白。
   */
  const [danmakuLoaded, setDanmakuLoaded] = useState<{ episodeId: number; items: DanmakuItem[] } | null>(null);
  // 是否正在拉取本集弹幕：按钮要能区分「加载中」和「一条都没有」，否则用户只会觉得功能坏了
  const [danmakuLoading, setDanmakuLoading] = useState(false);
  const [danmakuReloadToken, setDanmakuReloadToken] = useState(0);
  // 渲染期按归属过滤：这一行是「跨集零残留」的全部保证，不要挪进 effect
  const danmakuRaw =
    danmakuLoaded && danmakuLoaded.episodeId === danmakuEpisodeId ? danmakuLoaded.items : EMPTY_DANMAKU_ITEMS;
  // 弹幕是增强功能：任何失败都只提示一次，绝不阻塞播放。用 ref 持有 toast，
  // 避免它进依赖数组导致 effect 反复重跑（重新发请求）
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // 拉取本集弹幕。只在「已开启 + 已匹配 + 换集/重新加载」时发起：
  // 偏移校准不重新请求，时间轴由下面的 shiftDanmaku 在本地平移
  useEffect(() => {
    if (!store.danmakuEnabled || !danmakuEpisodeId) {
      setDanmakuLoaded(null);
      setDanmakuLoading(false);
      return;
    }
    // 闭包里固定本次请求对应的集：请求返回时若已换集，写入的数据也不会被当前渲染采信
    const episodeId = danmakuEpisodeId;
    const controller = new AbortController();
    setDanmakuLoading(true);
    fetchDanmakuComments(episodeId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDanmakuLoaded({ episodeId, items: result.items });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDanmakuLoaded(null);
        toastRef.current(err instanceof Error ? err.message : '弹幕加载失败', 'warning');
      })
      .finally(() => {
        if (!controller.signal.aborted) setDanmakuLoading(false);
      });
    return () => controller.abort();
  }, [store.danmakuEnabled, danmakuEpisodeId, danmakuReloadToken]);

  // 自动匹配：开启弹幕后本集还没绑定过，就用「清洗后的剧名 + 集数」静默匹配一次。
  // 每集只尝试一次（autoMatchTriedRef），失败提示过一次就不再打扰观众。
  const autoMatchTriedRef = useRef<Set<string>>(new Set());
  // 「没配密钥」是全局状态：整个会话提示一次就够，不能每换一集弹一遍
  const danmakuConfigWarnedRef = useRef(false);
  // 「自动匹配没命中」也只提示一次：每换一集都弹一遍会变成噪音
  const danmakuNoMatchWarnedRef = useRef(false);
  useEffect(() => {
    if (!store.danmakuEnabled || !currentUrl) return;
    if (danmakuMapping) return;
    // 占位标题（纯直链链接 / 详情还没回来）没有匹配价值，等真实标题到了再试
    if (!videoTitle || videoTitle === UNKNOWN_TITLE) return;
    if (autoMatchTriedRef.current.has(episodeKey)) return;
    autoMatchTriedRef.current.add(episodeKey);

    const controller = new AbortController();
    searchDanmaku(cleanDanmakuTitle(videoTitle), currentIndex + 1, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const picked = result.picked;
        if (!picked) {
          // 静默返回是最糟的体验：用户开了弹幕却什么都没发生，会以为功能坏了
          if (!danmakuNoMatchWarnedRef.current) {
            danmakuNoMatchWarnedRef.current = true;
            toastRef.current('未自动匹配到弹幕，可在「弹幕」面板里手动搜索', 'warning');
          }
          return;
        }
        useAppStore.getState().setDanmakuMapping(episodeKey, {
          episodeId: picked.episodeId,
          animeTitle: picked.animeTitle,
          episodeTitle: picked.episodeTitle,
          offsetSeconds: 0,
          matchedAt: Date.now(),
          auto: true,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof DanmakuNotConfiguredError) {
          if (danmakuConfigWarnedRef.current) return;
          danmakuConfigWarnedRef.current = true;
        }
        toastRef.current(err instanceof Error ? err.message : '弹幕自动匹配失败', 'warning');
      });
    return () => controller.abort();
  }, [store.danmakuEnabled, danmakuMapping, currentUrl, videoTitle, episodeKey, currentIndex]);

  // 偏移只在这一层施加：引擎拿到的永远是「已经平移好的时间轴」，
  // 拖动偏移时不需要重新请求，也不需要重建引擎
  const danmakuItems = useMemo(
    () =>
      store.danmakuEnabled && danmakuRaw.length > 0
        ? shiftDanmaku(danmakuRaw, danmakuMapping?.offsetSeconds ?? 0)
        : EMPTY_DANMAKU_ITEMS,
    [store.danmakuEnabled, danmakuRaw, danmakuMapping?.offsetSeconds]
  );

  const danmakuOptions = useMemo<DanmakuStyle>(
    () => ({
      opacity: store.danmakuOpacity,
      fontSize: store.danmakuFontSize,
      speed: store.danmakuSpeed,
      areaRatio: store.danmakuArea,
      showScroll: store.danmakuShowScroll,
      showTop: store.danmakuShowTop,
      showBottom: store.danmakuShowBottom,
      ...densityLimits(store.danmakuDensity),
    }),
    [
      store.danmakuOpacity,
      store.danmakuFontSize,
      store.danmakuSpeed,
      store.danmakuArea,
      store.danmakuShowScroll,
      store.danmakuShowTop,
      store.danmakuShowBottom,
      store.danmakuDensity,
    ]
  );

  // 中段两步态的起点：页面层持有，面板按钮与 Shift+S/E 共用同一份状态
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  // 换集清空中段两步态：起点属于上一集，不能和新集的位置拼成区间
  useEffect(() => setPendingStart(null), [sourceKey, vodId, currentIndex]);

  const goEpisode = useCallback(
    (index: number) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('index', String(index));
      sp.set('url', episodes[index] || directUrl);
      sp.delete('position');
      router.replace(`/watch?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams, episodes, directUrl]
  );

  // 进度恢复优先级：URL position 参数 > IndexedDB 记录
  const getRestorePosition = useCallback(async () => {
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) return urlPos;
    if (!vodId) return 0;
    const entry = await db.progress.get(progressKeyOf(sourceKey, vodId, currentIndex));
    return entry?.position ?? 0;
  }, [searchParams, sourceKey, vodId, currentIndex]);

  // 写入观看历史（进入页面即记录，进度后续增量更新）
  useEffect(() => {
    if (!verified || !sourceKey || !currentUrl) return;
    const timer = setTimeout(() => {
      upsertHistory({
        sourceKey,
        sourceUrl: source?.url,
        vodId: vodId || currentUrl,
        title: videoTitle,
        pic: detailQuery.data?.videoInfo?.cover,
        episodeIndex: currentIndex,
        totalEpisodes: episodes.length,
        playbackPosition: 0,
        duration: 0,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, sourceKey, vodId, currentIndex, videoTitle, currentUrl]);

  // 播放中与暂停时的进度落盘逻辑一致，共用同一回调
  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (vodId) {
        saveProgress(sourceKey, vodId, currentIndex, position, duration).catch(() => {});
        updateHistoryProgress(sourceKey, vodId || currentUrl, position, duration).catch(() => {});
      }
    },
    [sourceKey, vodId, currentIndex, currentUrl]
  );

  // 自动连播的 800ms 延迟切集要在卸载时取消，避免离开页面后跳转
  const autoNextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoNextTimer.current) clearTimeout(autoNextTimer.current);
  }, []);

  const handleEnded = useCallback(() => {
    if (vodId) clearProgress(sourceKey, vodId, currentIndex).catch(() => {});
    if (store.autoplayNext && currentIndex < episodes.length - 1) {
      autoNextTimer.current = setTimeout(() => goEpisode(currentIndex + 1), 800);
    }
  }, [store.autoplayNext, currentIndex, episodes.length, goEpisode, sourceKey, vodId]);

  // 快捷键（Shift+I/O/S/E）记录片段：校验后写入
  const handleRecordSegment = useCallback(
    (segment: SkipSegment) => {
      const duration = playerApiRef.current?.getDuration() ?? 0;
      const existing = useAppStore.getState().skipMarks[markKey]?.segments ?? [];
      const error = validateSegment(segment, duration, existing);
      if (error) {
        toast(error, 'error');
        return;
      }
      useAppStore.getState().setSkipMark(markKey, [...existing, segment]);
      const label =
        segment.type === 'opening' ? '片头结束' : segment.type === 'ending' ? '片尾开始' : '中段片段';
      // 中段命中时的表现取决于全局「自动跳过片段」，记完就说清楚，避免"标了却没反应"
      const hint =
        segment.type === 'middle'
          ? useAppStore.getState().autoSkipSegments
            ? '，命中时将自动跳过'
            : '，命中时显示跳过按钮'
          : '';
      toast(`已记录${label}${hint}`, 'success');
    },
    [markKey, toast]
  );

  // Alt+←/→ 集数切换快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        goEpisode(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && currentIndex < episodes.length - 1) {
        e.preventDefault();
        goEpisode(currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [currentIndex, episodes.length, goEpisode]);

  // 按钮文案就是功能状态：关闭 / 加载中 / 已加载条数 / 已匹配但 0 条 / 未匹配。
  // 默认关闭却不显示状态，是「播放时看不到弹幕」最常见的误解来源。
  const danmakuButtonLabel = !store.danmakuEnabled
    ? '弹幕 · 关'
    : danmakuLoading
      ? '弹幕 · 加载中'
      : danmakuItems.length > 0
        ? `弹幕 (${danmakuItems.length})`
        : danmakuMapping
          ? '弹幕 · 0 条'
          : '弹幕 · 未匹配';

  const orderedEpisodes = reversed ? [...episodes].map((_, i) => episodes.length - 1 - i) : episodes.map((_, i) => i);

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-faint text-sm">等待访问验证...</p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-content font-medium mb-2">点播源不存在</h1>
          <p className="text-sm text-muted mb-4">
            该视频来自点播源「{sourceKey}」，但它可能已被删除。请在设置中重新添加后重试。
          </p>
          <Link href="/" className="btn-primary">返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-3">
          <BackButton />
          <HomeButton />
          <div className="min-w-0">
            <h1 className="text-sm font-medium text-content truncate">{videoTitle}</h1>
            <p className="text-xs text-faint">
              {source.name}
              {episodes.length > 0 && ` · 第 ${currentIndex + 1}/${episodes.length} 集`}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                if (!currentUrl) return;
                enqueueDownload({
                  url: currentUrl,
                  // 多集才带集数后缀；单集影片（含电影）文件名就是纯标题
                  title: `${videoTitle}${episodes.length > 1 ? ` 第${currentIndex + 1}集` : ''}`,
                  format: 'MP4',
                });
                // 「已加入下载队列」由 DownloadManager 在真正入队后提示：
                // 这里先提示的话，用户随后取消保存位置会出现「已加入→已取消」的矛盾
              }}
            >
              下载本集
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setSwitchOpen(true)}>
              切换资源
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
          <div>
            <div ref={playerFrameRef} className="aspect-video bg-black rounded-lg overflow-hidden">
              {currentUrl ? (
                <PlayerShell
                  url={currentUrl}
                  title={videoTitle}
                  adFilter={store.adFilter}
                  autoplayNext={store.autoplayNext}
                  skipMark={skipMark}
                  autoSkipSegments={store.autoSkipSegments}
                  pendingStart={pendingStart}
                  onPendingStart={setPendingStart}
                  onPlayerApi={(api) => { playerApiRef.current = api; }}
                  onRecordSegment={handleRecordSegment}
                  episodeKey={episodeKey}
                  nextUrl={currentIndex + 1 < episodes.length ? episodes[currentIndex + 1] : undefined}
                  nextEpisodeKey={currentIndex + 1 < episodes.length ? `${sourceKey}:${vodId}:${currentIndex + 1}` : undefined}
                  getRestorePosition={getRestorePosition}
                  onTimeUpdate={handleProgress}
                  onPause={handleProgress}
                  onEnded={handleEnded}
                  hasPrevEpisode={currentIndex > 0}
                  hasNextEpisode={episodes.length > 0 && currentIndex < episodes.length - 1}
                  onPrevEpisode={() => goEpisode(currentIndex - 1)}
                  onNextEpisode={() => goEpisode(currentIndex + 1)}
                  onQuality={(height) => {
                    // 播放实测是最权威的画质来源，回写后搜索列表里该「源 + 影片」直接显示
                    if (!sourceKey || !vodId) return;
                    useAppStore.getState().setQuality({
                      [qualityKey(sourceKey, vodId)]: { height, from: 'play', timestamp: Date.now() },
                    });
                  }}
                  danmakuItems={danmakuItems}
                  danmakuOptions={danmakuOptions}
                  danmakuVisible={store.danmakuEnabled && danmakuItems.length > 0}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {detailQuery.isLoading ? (
                    <Spinner size="lg" />
                  ) : (
                    <p className="text-faint text-sm">
                      {detailQuery.isError ? '视频加载失败，请尝试其他资源' : '无可用播放地址'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 操作栏 */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                className="btn-ghost btn-sm"
                disabled={currentIndex <= 0}
                onClick={() => goEpisode(currentIndex - 1)}
              >
                上一集
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={episodes.length === 0 || currentIndex >= episodes.length - 1}
                onClick={() => goEpisode(currentIndex + 1)}
              >
                下一集
              </button>
              <button
                className={cn('btn-ghost btn-sm', skipPanelOpen && 'bg-chip text-content')}
                aria-expanded={skipPanelOpen}
                aria-haspopup="dialog"
                onClick={() => setSkipPanelOpen((v) => !v)}
                title={
                  markedCount > 0
                    ? `本剧已标记 ${markedCount} 段${skipMark?.enabled === false ? '（本剧跳过已关闭）' : ''}`
                    : '标记片头 / 中段 / 片尾，供本剧各集自动跳过'
                }
              >
                跳过标记{markedCount > 0 ? ` (${markedCount})` : ''}
                {markedCount > 0 && skipMark?.enabled === false && (
                  <span className="ml-1 inline-block size-1.5 rounded-full bg-faint" aria-label="本剧跳过已关闭" />
                )}
              </button>
              <button
                className={cn('btn-ghost btn-sm', danmakuPanelOpen && 'bg-chip text-content')}
                aria-expanded={danmakuPanelOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  // 一次点击就完成「打开面板 + 开启功能」：默认关闭时若只打开面板，
                  // 用户看到的仍是一个没有弹幕的进度条，会以为功能没生效
                  if (danmakuPanelOpen) {
                    setDanmakuPanelOpen(false);
                    return;
                  }
                  if (!store.danmakuEnabled) store.updateSettings({ danmakuEnabled: true });
                  setDanmakuPanelOpen(true);
                }}
                title={
                  !store.danmakuEnabled
                    ? '外挂弹幕当前关闭，点击开启并打开面板'
                    : danmakuMapping
                      ? `已绑定「${danmakuMapping.animeTitle}${danmakuMapping.episodeTitle ? ` · ${danmakuMapping.episodeTitle}` : ''}」，点击调整匹配与偏移`
                      : '未匹配到分集，点击打开面板手动搜索'
                }
              >
                {danmakuButtonLabel}
                {store.danmakuEnabled && (
                  <span
                    className={cn(
                      'ml-1 inline-block size-1.5 rounded-full',
                      danmakuItems.length > 0 ? 'bg-accent' : 'bg-faint'
                    )}
                    aria-label={danmakuItems.length > 0 ? '本集已有弹幕' : '本集暂无弹幕'}
                  />
                )}
              </button>
              <label className="flex items-center gap-1.5 text-xs text-muted ml-auto cursor-pointer">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#2563eb]"
                  checked={store.autoplayNext}
                  onChange={(e) => store.updateSettings({ autoplayNext: e.target.checked })}
                />
                自动连播
              </label>
            </div>

            <SkipMarkPanel
              open={skipPanelOpen}
              onClose={() => setSkipPanelOpen(false)}
              markKey={markKey}
              pendingStart={pendingStart}
              onPendingStart={setPendingStart}
              mobileMaxHeight={sheetMaxHeight}
              getPlayerClock={() => {
                const api = playerApiRef.current;
                if (!api) return null;
                return {
                  currentTime: api.getCurrentTime(),
                  duration: api.getDuration(),
                  seek: (s) => api.seek(s),
                  pause: () => api.pause(),
                  isPaused: () => api.isPaused(),
                };
              }}
            />

            <DanmakuPanel
              open={danmakuPanelOpen}
              onClose={() => setDanmakuPanelOpen(false)}
              episodeKey={episodeKey}
              mapping={danmakuMapping}
              queryTitle={videoTitle}
              episodeNumber={currentIndex + 1}
              count={danmakuItems.length}
              onReload={() => setDanmakuReloadToken((token) => token + 1)}
              mobileMaxHeight={sheetMaxHeight}
            />
          </div>

          {/* 剧集侧栏 */}
          <aside className="bg-surface-raised rounded-lg p-3 h-fit">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <h2 className="text-sm font-semibold text-content">
                剧集列表{episodes.length > 0 && `（${episodes.length}）`}
              </h2>
              {/* 排列开关紧贴它所作用的列表：放在这里才看得出它管的是这一栏的顺序 */}
              {episodes.length > 1 && (
                <button
                  className="btn-ghost btn-sm shrink-0"
                  onClick={() => setReversed((v) => !v)}
                  aria-label={reversed ? '切换为正序排列' : '切换为倒序排列'}
                  title="调整剧集列表的排列顺序"
                >
                  <Icon
                    name="arrowDown"
                    className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                  />
                  {reversed ? '正序排列' : '倒序排列'}
                </button>
              )}
            </div>
            {episodes.length === 0 ? (
              detailQuery.isLoading ? (
                <LoadingState />
              ) : (
                <EmptyState variant="plain" title={detailQuery.isError ? '获取剧集失败' : '暂无剧集信息'} />
              )
            ) : (
              <div className="grid grid-cols-5 lg:grid-cols-4 gap-1.5 max-h-[65vh] overflow-y-auto scrollbar-thin pr-1">
                {orderedEpisodes.map((realIndex) => (
                  <EpisodeButton
                    key={realIndex}
                    index={realIndex}
                    active={realIndex === currentIndex}
                    onClick={() => goEpisode(realIndex)}
                  />
                ))}
              </div>
            )}
            <p className="hidden md:block text-[10px] text-faint mt-3 leading-relaxed">
              快捷键：空格 播放/暂停 · ←/→ 快退/快进 5s · ↑/↓ 音量 · F 全屏 · Alt+←/→ 切换集数
            </p>
          </aside>
        </div>
      </main>

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={videoTitle}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          onClose={() => setSwitchOpen(false)}
        />
      )}
    </div>
  );
}

/** 集数按钮：激活时自动滚动进可视区（长剧列表） */
function EpisodeButton({ index, active, onClick }: { index: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={ref}
      className={cn('btn btn-sm !px-1', active ? 'episode-active' : 'btn-ghost')}
      onClick={onClick}
    >
      {index + 1}
    </button>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      className="p-2 -ml-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push('/');
      }}
      aria-label="返回"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

/** 首页按钮：直达首页，避免从外链进入时逐级 back */
function HomeButton() {
  return (
    <Link
      href="/"
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      aria-label="回首页"
      title="回首页"
    >
      <Icon name="home" className="w-5 h-5" />
    </Link>
  );
}
