'use client';

import type { DanmakuItem, DandanplayAnime } from './danmaku';

/**
 * 弹幕相关的客户端请求封装。
 *
 * 应用凭据只放 localStorage、且用**独立 key**——它不进 zustand 快照，
 * 是因为设置面板的「导出配置」会把整个快照序列化给用户下载/粘贴，
 * 密钥一旦进去就会跟着配置文件到处传播。
 *
 * 请求时把凭据放在自定义请求头里转发给同源 API 路由，由服务端算签名：
 * AppSecret 只出现在 Node 进程内，永远不会被打进前端 bundle。
 */

export const DANMAKU_CREDENTIALS_KEY = 'libretv:danmaku-credentials';

/** 弹弹play 开放平台的应用凭据（申请地址见 DANDANPLAY_DOC_URL） */
export interface DanmakuCredentials {
  appId: string;
  appSecret: string;
}

export const DANDANPLAY_DOC_URL = 'https://doc.dandanplay.net/open/';

const EMPTY_CREDENTIALS: DanmakuCredentials = { appId: '', appSecret: '' };

export function loadDanmakuCredentials(): DanmakuCredentials {
  if (typeof window === 'undefined') return { ...EMPTY_CREDENTIALS };
  try {
    const raw = window.localStorage.getItem(DANMAKU_CREDENTIALS_KEY);
    if (!raw) return { ...EMPTY_CREDENTIALS };
    const parsed = JSON.parse(raw) as Partial<DanmakuCredentials>;
    return {
      appId: typeof parsed?.appId === 'string' ? parsed.appId : '',
      appSecret: typeof parsed?.appSecret === 'string' ? parsed.appSecret : '',
    };
  } catch {
    // 隐私模式 / 被手改坏的 JSON：当作没配置，不影响其他设置
    return { ...EMPTY_CREDENTIALS };
  }
}

export function saveDanmakuCredentials(credentials: DanmakuCredentials): void {
  if (typeof window === 'undefined') return;
  try {
    const appId = credentials.appId.trim();
    const appSecret = credentials.appSecret.trim();
    if (!appId && !appSecret) {
      window.localStorage.removeItem(DANMAKU_CREDENTIALS_KEY);
      return;
    }
    window.localStorage.setItem(DANMAKU_CREDENTIALS_KEY, JSON.stringify({ appId, appSecret }));
  } catch {
    // 写不进去（配额满/隐私模式）时静默失败：本次会话仍可用环境变量配置
  }
}

/** 未配置密钥：单独类型化，面板据此给出「去设置里填」的引导而不是一句泛泛的失败 */
export class DanmakuNotConfiguredError extends Error {
  constructor(message = '未配置弹弹play密钥') {
    super(message);
    this.name = 'DanmakuNotConfiguredError';
  }
}

function credentialHeaders(): Record<string, string> {
  const { appId, appSecret } = loadDanmakuCredentials();
  if (!appId || !appSecret) return {};
  return { 'x-danmaku-app-id': appId, 'x-danmaku-app-secret': appSecret };
}

async function requestDanmaku<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: credentialHeaders(), signal });
  if (res.status === 501) {
    let message = '未配置弹弹play密钥';
    try {
      const data = (await res.json()) as { error?: string; code?: string };
      if (data?.error) message = data.error;
    } catch {
      /* 非 JSON 响应：沿用默认文案 */
    }
    throw new DanmakuNotConfiguredError(message);
  }
  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* 同上 */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** 自动/手动匹配的返回：items 是全部候选，picked 是服务端打分后的最优项 */
export interface DanmakuSearchResult {
  items: DandanplayAnime[];
  picked?: {
    animeId: number;
    animeTitle: string;
    episodeId: number;
    episodeTitle: string;
  };
}

export function searchDanmaku(
  title: string,
  episode: number | undefined,
  signal?: AbortSignal
): Promise<DanmakuSearchResult> {
  const params = new URLSearchParams({ title });
  if (typeof episode === 'number' && Number.isFinite(episode) && episode > 0) {
    params.set('episode', String(episode));
  }
  return requestDanmaku<DanmakuSearchResult>(`/api/danmaku/search?${params.toString()}`, signal);
}

export function fetchDanmakuComments(
  episodeId: number,
  signal?: AbortSignal
): Promise<{ count: number; items: DanmakuItem[] }> {
  const params = new URLSearchParams({ episodeId: String(episodeId) });
  return requestDanmaku<{ count: number; items: DanmakuItem[] }>(
    `/api/danmaku/comment?${params.toString()}`,
    signal
  );
}

export function fetchDanmakuStatus(
  signal?: AbortSignal
): Promise<{ envConfigured: boolean; selfHosted?: boolean; host: string }> {
  return requestDanmaku<{ envConfigured: boolean; selfHosted?: boolean; host: string }>(
    '/api/danmaku/status',
    signal
  );
}
