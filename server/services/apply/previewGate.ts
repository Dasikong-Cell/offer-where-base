/**
 * 「仅预览（dry-run）」语义的**唯一收口** —— 纯函数，零 IO、零依赖。
 *
 * 🔴 为什么单独成文件（2026-10-11 全链路审计）：
 *
 *   本仓库历史上并存**三套**「别真投」的写法，且**互不相通**：
 *     · 平台通道（engine / boss / job51 / nowcoder / ...）读 `input.preview`
 *     · 官网通道（offerbiu.runOfficialApply）读 `input.dryRun || !input.realSend`
 *     · 邮箱通道（offerbiu.runOfferbiuEmail）**只读 `input.dryRun`**
 *   ⇒ 只传 `preview:true` 而不传 `dryRun` 的调用方，在邮箱通道会一路走到
 *     `sendMail()` **真把邮件发出去**；在平台通道则会被适配器真的点下投递按钮
 *     （实测事故：`POST /api/apply {platform:'job51', preview:true}` 真的投出去一份，
 *      `applications` 1267→1268）。
 *
 *   修法分两层：
 *     ① 各适配器补 `preview` 分支（engine / job51 / nowcoder）；
 *     ② **在分发前把 `preview` 翻译成 `dryRun`** —— 就是本函数。
 *   第 ② 层是"收口"：不变量不该靠每个调用点各自记得同时传两个字段
 *   （那正是 P0-1 的根因 —— 契约写在 types.ts，执行靠各自实现）。
 *
 * 为什么抽成独立纯函数而不是内联一句三元：
 *   内联写法只能靠**静态字符串断言**钉住，而静态断言在本仓历史上已多次"腐烂"
 *   （正则跟着源码字形漂移、计数写死等）。抽成纯函数后可被 `tests/unit/` 直接
 *   机械验证，且该模块**不 import 任何运行时依赖**（只 `import type`，编译期擦除），
 *   所以单测不会顺带把浏览器/CDP/DB 那一串重依赖拉起来。
 *
 * 归一只加不减：`preview:true` 的任何合法调用方本来就不想真投，
 * 因此本函数**不可能**把一次真实投递误伤成预览（`preview !== true` 一律原样返回）。
 */
import type { ApplyInput } from './types.js';

/**
 * 把 `preview:true` 归一成「同时 `dryRun:true`」，使三套写法口径一致。
 *
 * 语义：
 *   · `preview !== true` ⇒ **原样返回**（真投路径绝不被改动，见上"归一只加不减"）。
 *   · `preview === true` ⇒ 保证 `dryRun === true`（含显式传 `dryRun:false` 的情况 ——
 *     那正是"调用方以为显式关了干跑、实际只关了一半通道"的坑）。
 *   · 已一致时**返回同一引用**，不制造多余对象（便于调用方与测试判断"有没有发生改动"）。
 */
export function normalizeApplyInput(input: ApplyInput): ApplyInput {
  if (input.preview !== true) return input;
  if (input.dryRun === true) return input;
  return { ...input, dryRun: true };
}
