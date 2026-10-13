/**
 * 基础版 ↔ 核心版的接缝（seam）—— 基础侧模块
 * ─────────────────────────────────────────────────────────────
 * 背景：本仓库按「自动化 + AI」切成**基础版**（公开）与**核心版**（私有）。
 *   发布基础版时，核心模块会被替换成**同路径的桩**（见 `_tools/core_split/gen_public.mjs`），
 *   桩的行为是：任何导出被**调用**时抛出 `code === 'CORE_UNAVAILABLE'` 的错误，绝不返回值。
 *
 * 因此基础侧的代码分成两种，处置方式**刻意不同**：
 *
 *   1) **核心专属路由**（`/api/ai-status`、`/api/apply/batch` …）
 *      → 不用本模块。让异常照常抛出，由终末错误中间件统一翻译成 501 + 明确文案。
 *        这样「这一屏属于完整版」对用户与调用方都是**可见**的，而不是伪装成 404。
 *
 *   2) **基础路由上「顺带报告核心状态」的调用**（典型：`/api/health` 里的 `isAiEnabled()`）
 *      → 用 `coreOr()` 包一层。核心缺席时给一个**语义正确的兜底值**（这里就是 `false`），
 *        因为「AI 未启用」正是基础版的真实状态，不该让整个健康检查 500。
 *
 * 🔴 判据只认 `code === 'CORE_UNAVAILABLE'`，**不按 message 匹配**：
 *   message 里带文件路径，改个路径就会静默失配（本仓已踩过这类坑）。
 * 🔴 不要用本模块去包 `safeOp`/`riskSignals` 这类**基础链路真正需要**的东西 ——
 *   那种情况正确做法是把那个纯函数挪到基础侧（见 `server/services/pipeNoise.ts`），
 *   靠 `coreOr()` 掩盖只会把「功能缺失」伪装成「功能正常但没效果」。
 */

/** 桩抛出的固定错误码。与 gen_public.mjs 中的桩实现保持一致 */
export const CORE_UNAVAILABLE_CODE = 'CORE_UNAVAILABLE';

/** 给最终用户的文案（核心版专属路由被访问时） */
export const CORE_REQUIRED_MESSAGE = '此功能属于完整版（含自动化与 AI 能力），未随基础版发布';

/** 该错误是否来自「核心模块缺失」的桩 */
export function isCoreUnavailable(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === CORE_UNAVAILABLE_CODE;
}

/**
 * 调用一个核心能力；核心缺席时返回兜底值而不是抛错。
 * 仅用于**基础路由上只是顺带报告核心状态**的调用点（见文件头注释）。
 */
export function coreOr<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (isCoreUnavailable(err)) return fallback;
    throw err;
  }
}

/**
 * `coreOr()` 的异步版本：核心缺席时返回兜底值。
 *
 * 🔴 为什么必须有它（2026-10-12 实测）：基础侧的**分发器**里有几条分支会走到核心能力，
 *   例如 `apply/index.ts` 的 `dispatchApply` 按 URL 判断「这条 offerbiu 岗位该走邮箱投递」，
 *   而那一步 `runOfferbiuEmail` 属核心。基础版里它是个调用即抛的桩 ⇒
 *   整个 `POST /api/apply`（**基础版路由**）会以 500 收场。
 *   这类调用点不能「让异常抛出交给中间件」—— 因为路由本身是基础版的，
 *   抛出去就变成 501，等于告诉用户「/api/apply 这个接口不存在」，而它其实在。
 *   正确语义是「这个**通道**属于完整版」，于是就地兜底成一条说得清的结果。
 */
export async function coreOrAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isCoreUnavailable(err)) return fallback;
    throw err;
  }
}

/** 只依赖 express Response 的这两件事，避免把 express 类型引进来 */
type MinimalRes = { status(code: number): { json(body: unknown): unknown } };

/**
 * 给**自己 catch 了异常**的路由用的收口：若错误是「核心缺失」，就发 501 并返回 true，
 * 调用方直接 `return`；否则返回 false，让它按原逻辑处理。
 *
 * 为什么需要它：终末错误中间件只能翻译**逃逸出去**的异常。路由若把异常吞在自己的
 * catch 里再 `res.status(500)`，中间件根本看不到 —— 实测基础版里有 4 条核心路由是这样，
 * 表现成 500 + 把 `CORE_UNAVAILABLE: <内部路径>` 直接吐给用户（既不准确，也泄露内部结构）。
 */
export function coreRequiredReplied(err: unknown, res: MinimalRes): boolean {
  if (!isCoreUnavailable(err)) return false;
  // 同时带 `ok:false`：本仓的响应体有两套约定（`{error}` 与 `{ok,error}`），
  // 一起给出去，两种调用方都能正确识别失败。
  res.status(501).json({ ok: false, error: CORE_REQUIRED_MESSAGE, code: 'CORE_REQUIRED' });
  return true;
}
