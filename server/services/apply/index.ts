/**
 * 跨平台专用投递脚本调度入口
 */
import { runBoss } from './boss.js';
import { runZhilian } from './zhilian.js';
import { runJob51 } from './job51.js';
import { runNowcoder } from './nowcoder.js';
import { runOfferbiu } from './officialApply.js';
import { runOfferbiuEmail } from './offerbiu.js';
import { runLiepin } from './liepin.js';
import { runIguopin } from './iguopin.js';
import { runYupao } from './yupao.js';
import { runChinahr } from './chinahr.js';
import { runYingjiesheng } from './yingjiesheng.js';
import { runWangshen } from './wangshen.js';
import { runEngine } from './engine.js';
import { isWangshenUrl, classifyDelivery } from './deliveryClassify.js';
import { normalizeApplyInput } from './previewGate.js';
// 基础 ↔ 核心接缝：本文件是 `POST /api/apply`（**基础版路由**）的分发器，
// 其中「offerbiu 邮箱直投」那一条分支会走到核心模块 —— 必须就地兜底，
// 不能让桩的异常逃逸（逃逸出去会被终末中间件翻成 501，等于说「/api/apply 不存在」）。
import { coreOrAsync, CORE_REQUIRED_MESSAGE } from '../../coreBridge.js';
import type { ApplyInput, ApplyPlatform, ApplyResult } from './types.js';

export const SUPPORTED_PLATFORMS: ApplyPlatform[] = [
  'boss', 'zhilian', 'job51', 'nowcoder', 'offerbiu', 'liepin',
  // 2026-09-21 接入：国聘（API 采集 + 详情页投递）、鱼泡直聘（列表/详情采集 + 聊一聊投递）
  'iguopin', 'yupao',
  // 2026-09-21 接入：中华英才网（无 URL 搜索，/job/ 推荐列表 → 详情页投递）、应届生求职网（51job 城市码 → 频道页卡片 → 详情页投递）
  'chinahr', 'yingjiesheng',
  // 2026-09-30 接入：独立「网申」平台（企业官网/校招网申系统，复用官网引擎，独立上下文与端口）
  'wangshen',
];

/**
 * **已登记但尚未接入投递实现**的平台。
 *
 * 含义：基础设施已就绪（独立 CDP 窗口/端口、`cdp.json` 映射、控制台下拉、平台巡检主页与登录特征），
 * 但还没有各自的采集器与投递 DOM 实现 —— 需要各自登录后用调试窗口实机探针校准选择器。
 *
 * 为什么不直接放进 SUPPORTED_PLATFORMS：那样批量投递会把它当"可投平台"选出来，
 * 跑一半才失败；这里显式区分，让失败信息说清楚「是待接入，不是不认识」。
 * 接入某个平台时：实现 `runXxx` → 从本数组移除 → 加入 SUPPORTED_PLATFORMS（并在 console 上标注）。
 */
export const PENDING_PLATFORMS: ApplyPlatform[] = [
  'easyzhipin', 'job58', 'dianzhang', 'maimai', 'ganji',
];

/** 已登记（含待接入）的全部平台 —— 控制台下拉与巡检的口径 */
export const REGISTERED_PLATFORMS: ApplyPlatform[] = [...SUPPORTED_PLATFORMS, ...PENDING_PLATFORMS];

/** 是否为「已登记但投递实现待接入」的平台 */
export function isPendingPlatform(platform: string): boolean {
  return (PENDING_PLATFORMS as string[]).includes(platform);
}

/** 支持「全套」批量/搜索/复聊/求职信动作的平台（由统一引擎处理） */
const ENGINE_PLATFORMS = new Set(['zhilian', 'boss', 'job51', 'liepin']);

export function isSupported(platform: string): platform is ApplyPlatform {
  return (SUPPORTED_PLATFORMS as string[]).includes(platform);
}

/**
 * offerbiu 聚合岗位的 apply_url 多为外部官网/平台链接。
 * 按域名把「平台链接」路由到对应平台引擎（复用已登录持久会话一键投），
 * 纯企业官网 / 微信文章 / 问卷等则走 offerbiu.ts 通用官网投递。
 */
function platformFromUrl(url: string): ApplyPlatform | null {
  if (!url) return null;
  if (/51job\.com/.test(url)) return 'job51';
  if (/zhaopin\.com/.test(url)) return 'zhilian';
  if (/zhipin\.com/.test(url)) return 'boss';
  if (/nowcoder\.com/.test(url)) return 'nowcoder';
  return null;
}

/**
 * 已确认实现「`preview:true` 不点击」语义的平台适配器。
 *
 * 🔴 为什么要有这份清单（2026-10-11 实测事故）：
 *   `preview` 的契约写在 `types.ts`，但**执行靠每个适配器各自实现**。实测
 *   `engine.ts` / `job51.ts` / `nowcoder.ts` 对 preview 的引用数都是 0 ⇒
 *   `POST /api/apply {platform:'job51', preview:true}` 真的投出去了一份
 *   （`applications` 1267→1268，日志见 `点击主投 (17440ms)`）。
 *   ⇒ 补完实现之后，再加一道**分发前的 fail-closed 兜底**：不在本清单里的平台，
 *     带 `preview:true` 时**直接拒绝分发**，绝不"猜它大概会遵守"。
 *     新增平台若忘了实现 preview，得到的是「被阻止」而不是「悄悄真投」。
 *   合约测试会钉住本清单与 SUPPORTED_PLATFORMS 的一致性。
 */
export const PREVIEW_AWARE_PLATFORMS: ApplyPlatform[] = [
  'boss', 'zhilian', 'job51', 'nowcoder', 'offerbiu', 'liepin', 'iguopin', 'yupao', 'chinahr', 'yingjiesheng', 'wangshen',
];

async function dispatchApply(input: ApplyInput): Promise<ApplyResult> {
  const action = input.action || 'hello';
  // 非 hello 动作（auto/keyword/search/again/letter）走统一引擎
  if (action !== 'hello' && ENGINE_PLATFORMS.has(input.platform)) {
    return runEngine(input);
  }
  // offerbiu 官网投递：按 apply_url 域名路由（命中平台→引擎一键投；微信推文→邮箱投；否则通用官网投递）
  if (input.platform === 'offerbiu') {
    const url = input.jobUrl || input.job?.apply_url || '';
    const routed = platformFromUrl(url);
    if (routed) {
      return runEngine({ ...input, platform: routed });
    }
    // 微信招聘推文：没有可点的网申入口，只给 HR 邮箱 + 标题格式 → 走邮箱投递
    if (input.channel === 'email' || /mp\.weixin\.qq\.com/.test(url)) {
      // 🔴 `runOfferbiuEmail` 属**核心**（邮箱直投依赖 subjectSpec 拼标题 + SMTP 发信）。
      //    基础版里它是调用即抛的桩 ⇒ 这里 coreOrAsync 兜底成一条「通道不可用」的结果。
      //    刻意**不**让它抛出去：本路由是基础版的，抛出去会变成 501，
      //    而 501 的语义是「这个接口不存在」—— `/api/apply` 明明是存在的。
      return coreOrAsync(() => runOfferbiuEmail(input), {
        platform: input.platform,
        status: 'need_manual',
        message: `${CORE_REQUIRED_MESSAGE}。该岗位只能通过 HR 邮箱投递，请在完整版中投递，或手动发邮件。`,
        logs: [],
      } as ApplyResult);
    }
    // 网申型链接（企业 ATS / 校招网申系统 / 企业自建招聘子域）：自动走独立「网申」通道（9238 窗口），
    // 与 offerbiu 官网聚合通道（9227）隔离，登录态/表单记忆互不污染。这是「遇到需要网申的就自动网申」的核心路由。
    if (isWangshenUrl(url)) {
      return runWangshen(input);
    }
    return runOfferbiu(input);
  }
  switch (input.platform) {
    case 'boss':
      return runBoss(input);
    case 'zhilian':
      return runZhilian(input);
    case 'job51':
      return runJob51(input);
    case 'liepin':
      return runLiepin(input);
    case 'nowcoder':
      return runNowcoder(input);
    case 'iguopin':
      return runIguopin(input);
    case 'yupao':
      return runYupao(input);
    case 'chinahr':
      return runChinahr(input);
    case 'yingjiesheng':
      return runYingjiesheng(input);
    case 'wangshen':
      return runWangshen(input);
    default:
      // 已登记但投递实现待接入：给出可执行的下一步，而不是笼统的"不支持"
      if (isPendingPlatform(String(input.platform))) {
        return {
          platform: input.platform as ApplyPlatform,
          status: 'need_manual',
          message: `平台「${input.platform}」已登记（窗口/巡检/控制台就绪），但自动投递实现尚未接入。`
            + `请先在调试窗口登录该平台，再运行实机探针校准页面选择器；`
            + `当前可投平台：${SUPPORTED_PLATFORMS.join(' / ')}`,
          logs: [],
        };
      }
      return {
        platform: input.platform as ApplyPlatform,
        status: 'error',
        message: `不支持的平台：${input.platform}（支持：${SUPPORTED_PLATFORMS.join(' / ')}）`,
        logs: [],
      };
  }
}

/**
 * 投递总入口 —— 在分发之外，额外兜住「`preview:true` 绝不真投」这条安全不变量。
 *
 * 三道保险（2026-10-11 审计：第 0 道是补的，因为前两道都"假设适配器读 preview"）：
 *   ⓿ **前置归一**：`preview:true` ⇒ 强制 `dryRun:true` 再分发。
 *      🔴 为什么必须有：本仓库有三套并存的「别真投」写法，且**互不相通** ——
 *         · 平台通道（engine/boss/...）读 `preview`
 *         · 官网通道（offerbiu.runOfficialApply）读 `dryRun || !realSend`
 *         · 邮箱通道（offerbiu.runOfferbiuEmail）**只读 `dryRun`** ⇒ 只传 `preview:true`
 *           会一路走到 `sendMail()` **真发出去**（实测过的同型事故见 job51）。
 *         此前靠三个调用点各自「手工同时传两个字段」维持一致（batch.ts 还专门写了注释），
 *         但**没有一层把 preview 翻译成 dryRun** ⇒ 第四个调用点忘传就是一次真投。
 *         归一只加不减：`preview:true` 的任何合法调用方本来就不想真投，故不可能误伤真实投递。
 *   ① **前置 fail-closed**：`preview:true` 且适配器不在 `PREVIEW_AWARE_PLATFORMS` ⇒ 拒绝分发。
 *      （防止新适配器忘实现 preview 后被"默认放行" —— 失败方向必须是安全的。）
 *   ② **后置矛盾检测**：`preview:true` 却返回 `applied` ⇒ 适配器违反了契约，**降级成 error 并大声报错**。
 *      即便真有漏网的点击发生，也绝不会被静默记成"成功投递"而让用户以为只是预览。
 */
export async function runApply(input: ApplyInput): Promise<ApplyResult> {
  const wantPreview = input.preview === true;

  if (wantPreview && !PREVIEW_AWARE_PLATFORMS.includes(input.platform)) {
    console.error(`[apply] 🔴 平台「${input.platform}」未登记 preview 支持，已阻止本次调用（fail-closed）`);
    return {
      platform: input.platform,
      status: 'preview',
      message: `已阻止：平台「${input.platform}」的适配器尚未登记「预览不点击」支持，`
        + `为避免 preview:true 仍然产生真实投递，本次调用被拒绝（未打开浏览器、未做任何点击）。`
        + `修法：在该适配器里实现 preview 分支后，把平台加入 PREVIEW_AWARE_PLATFORMS。`,
      logs: [],
    };
  }

  // ⓿ 归一：`preview:true` 一律连 `dryRun` 一起置真，好在分发前让三套写法口径一致。
  //    实现抽在 `previewGate.ts`（纯函数、零依赖），由 `tests/unit/previewGate.test.ts` 钉住。
  const result = await dispatchApply(normalizeApplyInput(input));

  if (wantPreview && result.status === 'applied') {
    console.error(`[apply] 🔴 契约违背：preview:true 却返回 status=applied（platform=${input.platform}）。`
      + `该适配器很可能走了真实点击路径，请检查它是否漏了 preview 分支。`);
    return {
      ...result,
      status: 'error',
      message: `🔴 预览模式却报告「已投递」—— 平台「${input.platform}」的适配器未遵守 preview 契约，`
        + `本次很可能已产生真实投递，请立即到该平台核对。原始返回：${result.message}`,
    };
  }
  return result;
}

export * from './types.js';
export { isWangshenUrl, classifyDelivery, aggregatorPlatformOf } from './deliveryClassify.js';
export type { DeliveryMethod, DeliveryClassification } from './deliveryClassify.js';
// ⚠️ 这里原先还有 `export { previewBatchRouting } from './batch.js'`。
//    `batch.ts` 属**核心**（批量投递引擎）⇒ 从这个基础侧 barrel 再导出核心符号，
//    会让「基础版依赖核心」这件事被藏进一行 re-export 里，读代码看不出来。
//    已改为由 `server/index.ts` 直接从 `./services/apply/batch.js` 取 —— 与它其余
//    16 条核心 import 放在一起，**核心依赖全部集中在 index.ts，一眼可数**。
