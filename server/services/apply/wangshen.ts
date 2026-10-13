/**
 * 独立「网申」平台：直接向企业官网招聘系统 / 校招网申系统投递。
 *
 * 复用的投递引擎 `runOfficialApply` 在**基础侧** `./officialApply.js`（原在 offerbiu.ts 里）。
 * 🔴 必须从基础侧取：`POST /api/apply` 属基础版路由，而 'wangshen' 是 `SUPPORTED_PLATFORMS`
 *   里登记的平台 ⇒ 若引擎留在核心模块，基础版一点「投递」就会抛 CORE_UNAVAILABLE。
 */
import { runOfficialApply } from './officialApply.js';
import type { ApplyInput, ApplyResult } from './types.js';

/** 网申专用浏览器上下文键（与 offerbiu 的 'official' 区分，端口 9238） */
export const WANGSHEN_CTX = 'wangshen';

export async function runWangshen(input: ApplyInput): Promise<ApplyResult> {
  return runOfficialApply(input, WANGSHEN_CTX);
}
