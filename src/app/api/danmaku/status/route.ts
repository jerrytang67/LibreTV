import { NextResponse } from 'next/server';

import { guardRequest } from '@/lib/api-guard';
import { dandanplayHost, isDandanplayEnvConfigured, isSelfHostedUpstream } from '@/lib/dandanplay';

export const runtime = 'nodejs';

/**
 * 弹幕配置状态：设置页据此提示「已由部署者配置」。
 * 只回布尔值与上游地址，绝不回 appId/appSecret —— 这个接口的响应会进前端状态。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  // 自建兼容上游（danmu_api 等）不需要密钥，对前端来说与「部署者已配置」等价
  const selfHosted = isSelfHostedUpstream();
  return NextResponse.json({
    envConfigured: isDandanplayEnvConfigured() || selfHosted,
    selfHosted,
    host: dandanplayHost(),
  });
}
