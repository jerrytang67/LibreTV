import { createHash } from 'node:crypto';

import { fetchUpstream } from './fetch-utils';
import type {
  DanmakuItem,
  DandanplayAnime,
  DandanplayCommentResponse,
  DandanplaySearchResponse,
} from './danmaku';

/**
 * 弹弹play 开放平台的服务端客户端。
 *
 * 只允许被 API Route 引用：这里用了 node:crypto，且 AppSecret 绝不能进前端包。
 * 客户端拿到的只有已经解析好的弹幕数组（见 /api/danmaku/comment）。
 *
 * 签名算法是平台硬性约定：base64(sha256(AppId + Timestamp + Path + AppSecret))，
 * Base64 的对象是 32 字节原始摘要；Path 不含 query 串、Timestamp 为秒级——
 * 任何一处对不上都会被上游判为 401/403，因此用固定向量在单测里锁死（见 dandanplay.test.ts）。
 */

/** 官方 host；自建反代时用 DANDANPLAY_API_BASE 覆盖 */
export const DANDANPLAY_HOST = 'https://api.dandanplay.net';

/** 签名用的时间戳精度：秒（平台按秒校验，用毫秒会直接失败） */
const TIMESTAMP_UNIT_DIVISOR = 1000;

export interface DandanplayCredentials {
  appId: string;
  appSecret: string;
  /** env = 部署者统一配置；header = 用户在设置页自填并保存在本机 */
  source: 'env' | 'header';
}

/** 实际使用的上游地址：允许部署者用 DANDANPLAY_API_BASE 指向自建反代 */
export function dandanplayHost(): string {
  const base = (process.env.DANDANPLAY_API_BASE || '').trim() || DANDANPLAY_HOST;
  return base.replace(/\/+$/, '');
}

/** 是否已由部署者通过环境变量配置（供设置页显示「已由部署者配置」） */
export function isDandanplayEnvConfigured(): boolean {
  return Boolean((process.env.DANDANPLAY_APP_ID || '').trim() && (process.env.DANDANPLAY_APP_SECRET || '').trim());
}

/**
 * 是否指向**自建兼容上游**（danmu_api 等实现了同一套 /api/v2/* 契约的服务）。
 *
 * 这类服务不需要弹弹play 的 AppId/签名，通常也不会暴露在公网（如 docker 内部服务名
 * `http://danmu-api:9321/<token>`）。因此两处要区别对待：
 * - 不需要凭据：否则用户被迫先去申请密钥，自建的意义就没了；
 * - 允许内网地址：SSRF 校验针对的是「用户可控地址」，而这里是部署者在 env 里写死的。
 */
export function isSelfHostedUpstream(): boolean {
  return dandanplayHost() !== DANDANPLAY_HOST;
}

/**
 * 计算请求签名：base64(sha256(AppId + Timestamp + Path + AppSecret))。
 *
 * 关键：Base64 的对象是 sha256 产出的 **32 字节原始摘要**，输出 44 字符。
 * 官方文档给出的 Java / JavaScript / Python / PHP / .NET / Go 六份示例代码全部如此
 * （`digest('base64')`、`.digest()`、`hash(..., true)`、`Sum256` 后直接编码）；
 * 若先转成十六进制字符串再 Base64，会得到 88 字符的错误签名，上游回 Invalid Signature。
 *
 * Path 不含 `?` 之后的查询串，Timestamp 为秒级——任何一处对不上都会被判 401/403，
 * 因此用固定向量在单测里锁死（见 dandanplay.test.ts）。
 */
export function buildSignature(appId: string, timestamp: number, path: string, appSecret: string): string {
  const raw = `${appId}${timestamp}${path}${appSecret}`;
  return createHash('sha256').update(raw, 'utf8').digest('base64');
}

/** 秒级时间戳（导出便于单测注入固定值） */
export function signatureTimestamp(now = Date.now()): number {
  return Math.floor(now / TIMESTAMP_UNIT_DIVISOR);
}

/**
 * 解析凭据。
 * 优先用部署者的环境变量（一次配置全站可用），其次才看用户自带的应用凭据：
 * 开放平台的密钥与调用方绑定，站点若强制要求用户自备，等于把配置门槛转嫁给了观众。
 */
export function resolveCredentials(req: Request): DandanplayCredentials | null {
  const envId = (process.env.DANDANPLAY_APP_ID || '').trim();
  const envSecret = (process.env.DANDANPLAY_APP_SECRET || '').trim();
  if (envId && envSecret) return { appId: envId, appSecret: envSecret, source: 'env' };

  const headerId = (req.headers.get('x-danmaku-app-id') || '').trim();
  const headerSecret = (req.headers.get('x-danmaku-app-secret') || '').trim();
  if (headerId && headerSecret) return { appId: headerId, appSecret: headerSecret, source: 'header' };
  return null;
}

/** 非 2xx 时把上游的 errorMessage 捞出来，直接给用户看（它本来就是中文） */
async function readUpstreamError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { errorMessage?: string; error?: string };
    if (data?.errorMessage) return data.errorMessage;
    if (data?.error) return data.error;
  } catch {
    /* 非 JSON 响应（网关错误页等）走下面的兜底文案 */
  }
  return '';
}

/**
 * 调用弹弹play 接口并返回 JSON。
 *
 * 走 fetchUpstream 而不是裸 fetch：超时、重试与 SSRF 校验统一在这个工具里
 * （DANDANPLAY_API_BASE 可被部署者改成任意地址，必须同样过一遍校验）。
 */
export async function fetchDandanplay<T>(
  path: string,
  searchParams: URLSearchParams | undefined,
  creds: DandanplayCredentials | null,
  init: RequestInit = {}
): Promise<T> {
  const base = dandanplayHost();
  const query = searchParams?.toString();
  const url = `${base}${path}${query ? `?${query}` : ''}`;
  const selfHosted = isSelfHostedUpstream();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  // 自建上游不做签名校验；只有官方服务（或用户自带凭据）才需要三个签名头
  if (creds) {
    const timestamp = signatureTimestamp();
    headers['X-AppId'] = creds.appId;
    headers['X-Timestamp'] = String(timestamp);
    headers['X-Signature'] = buildSignature(creds.appId, timestamp, path, creds.appSecret);
  }

  // 自建上游通常是容器内网服务（如 http://danmu-api:9321/<token>）。
  // SSRF 校验是用来挡"用户可控地址"的，而这里是部署者写死在 env 里的地址，
  // 因此关闭逐跳校验（否则私网地址一律被拦），只保留协议白名单：
  // 防止把 fetch 变成 file:// 之类的本地读取。
  if (selfHosted) {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('弹幕上游地址仅支持 http/https');
    }
  }

  const res = await fetchUpstream(url, {
    ...init,
    headers,
    timeoutMs: 8000,
    retries: 1,
    safeRedirects: !selfHosted,
  });
  if (!res.ok) {
    const detail = await readUpstreamError(res);
    throw new Error(detail || `弹弹play 请求失败（HTTP ${res.status}）`);
  }

  const data = (await res.json()) as T & { success?: boolean; errorMessage?: string };
  if (!data || typeof data !== 'object') throw new Error('弹弹play 返回了非预期的响应');
  // 平台在业务失败时仍可能回 200，只认 success 字段
  if (data.success === false) throw new Error(data.errorMessage || '弹弹play 接口返回失败');
  return data;
}

/** 搜索番剧/分集：`/api/v2/search/episodes?anime=&episode=` */
export function searchDandanplayEpisodes(
  title: string,
  episode: string | undefined,
  creds: DandanplayCredentials | null,
  init?: RequestInit
): Promise<DandanplaySearchResponse> {
  const params = new URLSearchParams({ anime: title });
  if (episode) params.set('episode', episode);
  return fetchDandanplay<DandanplaySearchResponse>('/api/v2/search/episodes', params, creds, init);
}

/**
 * 拉取某分集的弹幕。
 * withRelated=true 会连带返回关联剧集的弹幕（平台侧已按相似度合并），
 * chConvert=1 把繁体统一转成简体，避免同一句话两种字形混排。
 */
export function fetchDandanplayComments(
  episodeId: number,
  creds: DandanplayCredentials | null,
  init?: RequestInit
): Promise<DandanplayCommentResponse> {
  const params = new URLSearchParams({ withRelated: 'true', chConvert: '1' });
  return fetchDandanplay<DandanplayCommentResponse>(`/api/v2/comment/${episodeId}`, params, creds, init);
}

/** 供路由复用的类型出口（避免各处再从 danmaku.ts 单独 import 一遍） */
export type { DanmakuItem, DandanplayAnime, DandanplayCommentResponse, DandanplaySearchResponse };
