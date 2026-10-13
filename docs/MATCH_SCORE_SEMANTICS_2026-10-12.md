# 匹配分语义修复：无 JD 不再写成 0 分（2026-10-12）

## 起因

`新岗位采集 + 微信长图 OCR` 例行任务跑完后核验「新采集岗位与本人的匹配程度」，
发现本轮 47 条新增里 44 条被判「< 30 分」，初看像是关键词选错导致采了一堆无关岗位。
深查发现：**低分的大头不是「不匹配」，而是「无法评估」被写成了 0 分**。

## 问题

- 全库 3310 条岗位中，**1749 条（53%）match_score = 0**，且无一例外都是 `jd` 与 `requirements` 皆空的岗位。
- 这 1749 条的 `match_detail` 是 `{"matched":[],"missing":[],"rule":true}`（规则回填）
  或 `{"matched":[],"missing":[],"suggestions":["岗位 JD 为空或过短，无法评估匹配度…"]}`（LLM 路径）
  —— **两个写入方都明确知道「无法评估」，却都落了 0 分**。
- 后果：`0` 是「评估过、确实不像」的有效分，与「没得评」混用后，匹配度指标整体失真 ——
  全库均值被拉低到 **15**，按可评估口径复算实为 **31.3**。
  下游影响：按匹配度排序、投递漏斗 low/mid/high 分档、来源质量对比结论，全部被污染。

## 根因

`server/services/match.ts` 的 `matchResumeToJob`：

```ts
if (corpus.length < 10) {
  return { score: 0, ..., basis: 'none' };   // ← 注释写着「此岗位不应参与按分数排序」，却仍返回 0
}
```

接口注释（`MatchResult.basis`）早已写明 `'none'` 时「分数无意义（恒为 0），不要参与排序」，
但返回值没有兑现这个约定；调用方 `backfill_match.ts` 与 `/api/jobs/match` 又无差别落库，
于是「未知」被固化成「0 分」。

**注**：`server/services/apply/batch.ts:487` 早已用正确范式规避同一坑
（「无 JD 文本 → 跳过且不写库」），本次修复即向该范式对齐。

## 修复

| 文件 | 改动 |
|---|---|
| `server/services/match.ts` | `MatchResult.score` 改 `number \| null`；无 JD 时返回 `null` |
| `scripts/backfill_match.ts` | 只回填有 JD 的岗位；打印跳过的无 JD 条数（照 `batch.ts:487` 口径） |
| `server/index.ts` `/api/jobs/match` | 候选池先滤掉无 JD 文本的岗位（不送 LLM 白花钱）；响应新增 `skippedNoJd`；写入前判 `r.score != null` |
| `server/services/apply/batch.ts` | `score` 为 `null` 时不写库、不进 `scoreMap`（与「打分失败 ⇒ 放行」同取舍） |
| `server/services/apply/resumeTailor.ts` | `matchScore` 放宽为 `number \| null`；Markdown 渲染改 `?? '—'` |
| `server/services/apply/tailoredResumePdf.ts` | 同上，类型放宽 |
| `_tools/_reset_nojd_match.ts`（新增） | 把 1749 条伪 0 分重置为 `NULL`；执行前 `VACUUM INTO` 落快照，支持 `--dry` |
| `_tools/_match_semantics_check.ts`（新增） | 语义冒烟：有 JD ⇒ 数字，空/极短 JD ⇒ `null` |

**口径统一**：可评估 ⇔ `(jd + requirements).trim().length >= 10`。
实测本库「< 10 字」的条数（1749）与「jd/requirements 全空」的条数完全相等，
即不存在边界情况，故 `server/index.ts` 的过滤阈值与 `match.ts` 天然一致。

## 验证

- `tsc -b`：零错误（此前暴露 `resumeTailor.ts:162` 类型不兼容，已修）。
- 语义冒烟：有 JD → 76 分；空 JD / 极短 JD → `null`。✅
- `backfill_match.ts` 复跑：待回填 0，跳过 1749；覆盖 1561（= 可评估岗位数），均值 31。
- 合约测试：**1088 / 1088 全通过**。
- 投递链路影响：`greetDecision.ts` 只读 `mr.matched` / `mr.missing`，不读 `mr.score`，
  且其注释已声明「`0` 必须视为未评分」—— 与本次修复同向，投递闸门行为未变。

## 修正后的数据

本轮 47 条新增：**可评估 6 条（均值 32）+ 未知 41 条**（而非「44 条低分」）。

各来源**可评估**岗位平均分（排除未知）：

| 来源 | 总数 | 可评估 | 无 JD | 均值 | ≥50 | ≥70 |
|---|---|---|---|---|---|---|
| boss | 1393 | 719 | 674 | 31.8 | 287 | 211 |
| offerbiu | 1141 | 305 | 836 | **21.3** | 59 | 48 |
| iguopin | 193 | 193 | 0 | 42.1 | 67 | 40 |
| zhilian | 128 | 76 | 52 | 2.4 | 2 | 2 |
| liepin | 103 | 93 | 10 | 25 | 31 | 25 |
| job51 | 101 | 38 | 63 | 32.4 | 9 | 6 |
| nowcoder | 101 | 101 | 0 | **58.8** | 70 | 46 |
| yingjiesheng | 95 | 0 | 95 | — | 0 | 0 |
| chinahr | 54 | 36 | 18 | **48.7** | 17 | 11 |

## 结论

1. **修正了一个会长期误导决策的缺陷**：修复前 offerbiu 显示 5.7 分，据此会得出「该来源质量差」的错误结论；
   按可评估口径实为 **21.3**，与 boss（31.8）同一量级。
2. **offerbiu 的真瓶颈是 JD 覆盖率，不是岗位质量** —— 1141 条里仅 305 条有 JD（27%）。
   补 JD（抓图 + OCR，或 `jobs:backfill-jd`）的收益远高于换关键词扩池。
3. 全库无 JD 共 1749 条（offerbiu 836、boss 674、job51 63、zhilian 52、chinahr 18、liepin 10、
   yingjiesheng 95）——**这是当前最大的可回收资产**。
4. `yingjiesheng` 95 条全部无 JD，来源基本不可用。
5. 本轮 6 个关键词（芯片验证 / FPGA开发 / 音视频算法 / 推荐算法 / 搜索算法 / 电力电子）
   采到的岗位方向确实与画像不符（仅 1 条「新浪微博 Agent架构」真正对口），
   但判定依据应是「可评估的 6 条里 1 条对口」，而不是「44 条低分」。
