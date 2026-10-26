'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  cleanDanmakuTitle,
  DANMAKU_AREA_OPTIONS,
  DANMAKU_DENSITY_OPTIONS,
  flattenCandidates,
  type DanmakuCandidate,
  type DanmakuMapping,
  type DandanplayAnime,
} from '@/lib/danmaku';
import {
  DANDANPLAY_DOC_URL,
  DanmakuNotConfiguredError,
  fetchDanmakuStatus,
  loadDanmakuCredentials,
  searchDanmaku,
} from '@/lib/danmaku-client';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';

/**
 * 播放页的「弹幕」抽屉：总开关 / 当前绑定 / 匹配 / 偏移校准。
 *
 * 数据源（弹弹play）是按番剧+分集组织的，而本站只有「采集站 + 剧名 + 集数」，
 * 两者之间必然要做一次匹配，且采集站的剧名常常带噪声（国语、HD、[未删减]…），
 * 所以这个面板的核心不是"配置项"，而是「让用户在一次播放内把这条链路校准好」：
 *   - 自动匹配先跑一遍，通常直接就对上了；
 *   - 对不上就列候选让人挑，或直接手搜关键词；
 *   - 时间轴对不上（片头长度不同 / 资源剪过）就用 ±1s/±5s 微调，立即可见。
 *
 * 偏移只改 store 里这一集的 mapping，播放页据此平移时间轴——不会重新请求弹幕。
 */

const OFFSET_STEP_SMALL = 1;
const OFFSET_STEP_LARGE = 5;
/** 偏移上限（秒）：超过一集的量级说明匹配错了集，卡住避免存进离谱的值 */
const OFFSET_LIMIT = 600;

const round1 = (value: number) => Math.round(value * 10) / 10;

export function DanmakuPanel({
  open,
  onClose,
  episodeKey,
  mapping,
  queryTitle,
  episodeNumber,
  count,
  onReload,
  mobileMaxHeight,
}: {
  open: boolean;
  onClose: () => void;
  /** `${sourceKey}:${vodId}:${episodeIndex}`，与播放页 episodeKey 一致 */
  episodeKey: string;
  /** 当前集的绑定；未匹配为 undefined */
  mapping?: DanmakuMapping;
  /** 自动匹配用的标题（原样传入，面板内部负责清洗） */
  queryTitle: string;
  /** 当前集数（从 1 起） */
  episodeNumber: number;
  /** 当前已加载的弹幕条数 */
  count: number;
  /** 重新拉取弹幕（换集/重新匹配后由播放页负责，这里只触发） */
  onReload: () => void;
  /**
   * 小屏抽屉的最大高度（px，由播放页按播放器底边算出）：
   * 手机上弹幕面板不该压住画面——调偏移时要能同时看到弹幕的变化。
   */
  mobileMaxHeight?: number;
}) {
  const danmakuEnabled = useAppStore((s) => s.danmakuEnabled);
  const danmakuDensity = useAppStore((s) => s.danmakuDensity);
  const danmakuArea = useAppStore((s) => s.danmakuArea);
  const danmakuOpacity = useAppStore((s) => s.danmakuOpacity);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setDanmakuMapping = useAppStore((s) => s.setDanmakuMapping);
  const { toast } = useToast();

  const [candidates, setCandidates] = useState<DanmakuCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [needsConfig, setNeedsConfig] = useState(false);
  const [manualQuery, setManualQuery] = useState('');
  const [offsetDraft, setOffsetDraft] = useState('0');

  const offset = mapping?.offsetSeconds ?? 0;

  // 打开时确认一次凭据状态：部署者配了就不用打扰用户，没配才提示去设置里填
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const local = loadDanmakuCredentials();
    if (local.appId && local.appSecret) {
      setNeedsConfig(false);
      return;
    }
    fetchDanmakuStatus()
      .then((status) => {
        if (alive) setNeedsConfig(!status.envConfigured);
      })
      .catch(() => {
        // 状态接口失败（离线/未登录）不作结论，让实际匹配请求去报错
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 偏移输入框跟随 mapping：换集或点 ±N 按钮后同步回显
  useEffect(() => {
    setOffsetDraft(String(offset));
  }, [offset, mapping?.episodeId]);

  // 换集后上一集的候选必须清掉，否则会拿着新集的标题去点旧集的条目
  const episodeKeyRef = useRef(episodeKey);
  useEffect(() => {
    if (episodeKeyRef.current === episodeKey) return;
    episodeKeyRef.current = episodeKey;
    setCandidates([]);
    setSearched(false);
    setError('');
    setManualQuery('');
  }, [episodeKey]);

  const describeError = useCallback((err: unknown): string => {
    if (err instanceof DanmakuNotConfiguredError) {
      setNeedsConfig(true);
      return err.message;
    }
    return err instanceof Error ? err.message : '弹幕请求失败';
  }, []);

  const runSearch = useCallback(
    async (rawTitle: string) => {
      const keyword = cleanDanmakuTitle(rawTitle.trim());
      if (!keyword) {
        toast('请输入番剧名后再搜索', 'warning');
        return;
      }
      setSearching(true);
      setSearched(true);
      setError('');
      try {
        const result = await searchDanmaku(keyword, episodeNumber);
        const ranked = flattenCandidates(result.items, keyword, episodeNumber);
        // 打分全部落空（用户搜的词和番剧名完全不同）时把结果原样列出：
        // 面板的职责是"让人能选"，不是"判断用户搜得对不对"
        const rows =
          ranked.length > 0
            ? ranked
            : flattenCandidatesFallback(result.items);
        setCandidates(rows);
        if (rows.length === 0) setError('没有找到匹配的番剧，换个关键词试试');
      } catch (err) {
        setCandidates([]);
        setError(describeError(err));
      } finally {
        setSearching(false);
      }
    },
    [episodeNumber, toast, describeError]
  );

  const bind = (candidate: DanmakuCandidate) => {
    setDanmakuMapping(episodeKey, {
      episodeId: candidate.episodeId,
      animeTitle: candidate.animeTitle,
      episodeTitle: candidate.episodeTitle,
      // 保留已经校准过的偏移：重选匹配项通常是为了修正番剧，不该把时间轴偏移一起抹掉
      offsetSeconds: mapping?.offsetSeconds ?? 0,
      matchedAt: Date.now(),
      auto: false,
    });
    setCandidates([]);
    setSearched(false);
    toast(`已绑定「${candidate.animeTitle} · ${candidate.episodeTitle}」`, 'success');
  };

  const unbind = () => {
    if (!mapping) return;
    setDanmakuMapping(episodeKey, null);
    toast('已解除本集弹幕绑定', 'info');
  };

  const setOffset = (value: number) => {
    if (!mapping) return;
    const next = round1(Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, value)));
    if (next === mapping.offsetSeconds) return;
    // 只改偏移不重新请求：时间轴在播放页本地平移，调整过程可以边看边调
    setDanmakuMapping(episodeKey, { ...mapping, offsetSeconds: next });
  };

  const commitOffsetDraft = () => {
    const parsed = Number(offsetDraft);
    if (Number.isFinite(parsed)) setOffset(parsed);
    else setOffsetDraft(String(offset));
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="弹幕"
      width="max-w-sm lg:max-w-[20rem]"
      modal={false}
      mobileSheet
      panelStyle={mobileMaxHeight ? { maxHeight: mobileMaxHeight } : undefined}
      footer={
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={!mapping}
            title={mapping ? '按当前绑定重新拉取本集弹幕' : '先匹配一集弹幕'}
            onClick={onReload}
          >
            <Icon name="refresh" className="w-3.5 h-3.5" />
            重新加载弹幕
          </button>
          <span className="text-[11px] text-muted">
            已加载 <span className="font-mono text-content">{count}</span> 条
          </span>
        </div>
      }
    >
      {/* 总开关 + 当前状态：作用域最大的放最上，和「跳过标记」抽屉的层级关系保持一致 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            本集弹幕{' '}
            <span className={cn('font-medium', count > 0 ? 'text-accent' : 'text-muted')}>
              {mapping ? `${count} 条` : '未匹配'}
            </span>
          </p>
          <p className="mt-1 text-[11px] text-muted">
            数据来自弹弹play 开放平台 · 需要匹配到具体分集
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted hover:text-content">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={danmakuEnabled}
            onChange={(e) => updateSettings({ danmakuEnabled: e.target.checked })}
          />
          外挂弹幕
        </label>
      </div>

      {needsConfig && (
        <div className="mt-3 rounded-lg border border-line bg-surface px-3 py-2.5">
          <p className="text-xs font-medium text-content">尚未配置弹弹play 密钥</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            到「设置 → 播放与过滤 → 弹幕」填写 appId 与 appSecret（仅保存在本机浏览器）；
            若部署者已通过环境变量配置则无需填写。
          </p>
          <a
            className="mt-1.5 inline-block text-[11px] text-accent hover:underline"
            href={DANDANPLAY_DOC_URL}
            target="_blank"
            rel="noreferrer"
          >
            {DANDANPLAY_DOC_URL}
          </a>
        </div>
      )}

      {/* —— 当前绑定 —— */}
      <div className="mt-3 rounded-lg border border-line/70 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">当前绑定</span>
          {mapping && (
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-faint">{mapping.auto ? '自动匹配' : '手动匹配'}</span>
              <button
                type="button"
                className="rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-danger"
                title="解除本集绑定"
                aria-label="解除本集弹幕绑定"
                onClick={unbind}
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
        {mapping ? (
          <>
            <p className="mt-1 truncate text-xs text-content" title={mapping.animeTitle}>
              {mapping.animeTitle || '（未命名番剧）'}
            </p>
            <p className="truncate text-[11px] text-muted" title={mapping.episodeTitle}>
              {mapping.episodeTitle || `分集 #${mapping.episodeId}`}
            </p>
          </>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            未匹配。点下方「自动匹配」按剧名与集数查找，或直接手搜番剧名。
          </p>
        )}
      </div>

      {/* —— 显示：放在播放页而不是设置页，是因为"太密/太亮/占屏太多"必须边看边调 —— */}
      <div className="mt-3 space-y-2.5 rounded-lg border border-line/70 px-2.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted" title="同时限制轨道数与同屏条数，只减轨道挡不住横向刷屏">
            弹幕量
          </span>
          <div className="flex items-center gap-1">
            {DANMAKU_DENSITY_OPTIONS.map((o) => (
              <Choice
                key={o.value}
                active={danmakuDensity === o.value}
                title={`最多 ${o.maxTracks} 条轨道 · 同屏 ${o.maxActive} 条`}
                onClick={() => updateSettings({ danmakuDensity: o.value })}
              >
                {o.label}
              </Choice>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted" title="弹幕只占画面上部，不压字幕与画面主体">
            显示区域
          </span>
          <div className="flex items-center gap-1">
            {DANMAKU_AREA_OPTIONS.map((o) => (
              <Choice
                key={o.value}
                active={Math.abs(danmakuArea - o.value) < 0.01}
                onClick={() => updateSettings({ danmakuArea: o.value })}
              >
                {o.label}
              </Choice>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted">透明度</span>
            <span className="font-mono text-[11px] text-content">
              {Math.round(danmakuOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            className="mt-1 w-full accent-accent"
            min={20}
            max={100}
            step={5}
            value={Math.round(danmakuOpacity * 100)}
            aria-label="弹幕透明度"
            onChange={(e) => updateSettings({ danmakuOpacity: Number(e.target.value) / 100 })}
          />
        </div>
      </div>

      {/* —— 匹配 —— */}
      <div className="mt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={searching || !queryTitle}
            title="用当前剧名（已清洗）与集数搜索"
            onClick={() => runSearch(queryTitle)}
          >
            {searching ? '匹配中...' : '自动匹配'}
          </button>
          <span className="text-[11px] text-faint">
            关键词：{cleanDanmakuTitle(queryTitle) || '（无标题）'} · 第 {episodeNumber} 集
          </span>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <input
            className="input w-full !py-1.5 text-xs"
            aria-label="手动搜索番剧名"
            placeholder="手动搜索番剧名，如：庆余年"
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch(manualQuery || queryTitle);
            }}
          />
          <button
            type="button"
            className="btn-ghost btn-sm shrink-0"
            disabled={searching}
            onClick={() => void runSearch(manualQuery || queryTitle)}
          >
            <Icon name="search" className="w-3.5 h-3.5" />
            搜索
          </button>
        </div>

        {error && <p className="mt-1.5 text-[11px] leading-relaxed text-danger">{error}</p>}

        {candidates.length > 0 ? (
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto scrollbar-thin pr-1">
            {candidates.map((candidate) => {
              const active = mapping?.episodeId === candidate.episodeId;
              return (
                <li key={candidate.episodeId}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                      active
                        ? 'border-accent/60 bg-chip/60'
                        : 'border-line/70 hover:border-accent/40 hover:bg-hover/60'
                    )}
                    onClick={() => bind(candidate)}
                  >
                    <span className="w-full truncate text-xs text-content">{candidate.animeTitle}</span>
                    <span className="w-full truncate text-[11px] text-muted">
                      {candidate.episodeTitle || `分集 #${candidate.episodeId}`}
                      {active && <span className="ml-1 text-accent">· 当前</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          searched &&
          !searching &&
          !error && (
            <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-3 text-xs leading-relaxed text-muted">
              没有候选。换个更短的番剧名再试（去掉季数、語言与清晰度后缀通常更准）。
            </p>
          )
        )}
      </div>

      {/* —— 偏移校准 —— */}
      <div className="mt-3 rounded-lg border border-line bg-surface px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">时间轴偏移</span>
          <span className={cn('font-mono text-xs', offset === 0 ? 'text-muted' : 'text-accent')}>
            偏移 {offset >= 0 ? '+' : ''}
            {offset.toFixed(1)}s
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {[-OFFSET_STEP_LARGE, -OFFSET_STEP_SMALL, OFFSET_STEP_SMALL, OFFSET_STEP_LARGE].map((step) => (
            <button
              key={step}
              type="button"
              className="btn-ghost btn-sm"
              disabled={!mapping}
              title={step > 0 ? `弹幕整体后移 ${step}s` : `弹幕整体前移 ${-step}s`}
              onClick={() => setOffset(offset + step)}
            >
              {step > 0 ? `+${step}s` : `${step}s`}
            </button>
          ))}
          <input
            className="input w-20 !py-1 text-xs font-mono"
            aria-label="偏移秒数"
            inputMode="decimal"
            disabled={!mapping}
            value={offsetDraft}
            onChange={(e) => setOffsetDraft(e.target.value)}
            onBlur={commitOffsetDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitOffsetDraft();
            }}
          />
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={!mapping || offset === 0}
            title="偏移归零"
            onClick={() => setOffset(0)}
          >
            归零
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          弹幕比画面早出现就往正方向调，晚出现就往负方向调。正值表示整体后移。
        </p>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        弹幕按「源 + 影片 + 集数」单独记录，换集会重新匹配；同一集下次播放直接复用本次绑定与偏移。
      </p>
    </Drawer>
  );
}

/** 打分全落空时的兜底：把上游返回的全部分集原样摊平，交由用户自己挑 */
function flattenCandidatesFallback(items: DandanplayAnime[]): DanmakuCandidate[] {
  const rows: DanmakuCandidate[] = [];
  for (const anime of items ?? []) {
    if (!anime || !Array.isArray(anime.episodes)) continue;
    for (const episode of anime.episodes) {
      const episodeId = Number(episode?.episodeId);
      if (!Number.isFinite(episodeId) || episodeId <= 0) continue;
      rows.push({
        animeId: Number(anime.animeId),
        animeTitle: anime.animeTitle || '',
        episodeId,
        episodeTitle: episode.episodeTitle || '',
        score: 0,
      });
    }
  }
  return rows;
}

/** 小尺寸分段选择：面板里选项多，用按钮组比下拉少一次点击 */
function Choice({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        'btn btn-sm !px-2 !py-0.5 text-[11px]',
        active ? 'bg-chip text-content' : 'btn-ghost'
      )}
    >
      {children}
    </button>
  );
}
