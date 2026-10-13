/**
 * 推送范围内的**历史 blob** PII 扫描 —— pre-push 的第 4 道门（配合 pii_guard.ts）
 * ============================================================================
 * 为什么还需要它（2026-10-11 实测定位）：
 *   `scripts/pii_guard.ts` 的输入是 `git ls-files`（**工作区当前文件**），它守的是
 *   「此刻磁盘上会被推送的东西」。这留下一个结构性口子：
 *
 *       一次 push 里「先提交 PII → 再提交删除」⇒ tip 是干净的 ⇒ 门禁**全绿**，
 *       而 PII 已经永久进入远端历史（git 只增不减，克隆即得）。
 *
 *   实测该口子已经被踩过：本仓库公开历史里 38 个 blob / 23 条路径 /
 *   28 个提交（2026-09-04 ~ 09-27）含简历本人姓名、手机号、籍贯到区、身高体重、
 *   以及 `D:/Desktop/<姓名>简历.pdf` 这类本地路径。而 09-27 那 4 次「清理 PII」提交
 *   同样只洗了 tip —— 门禁每次都绿。
 *
 *   `.githooks/pre-push` 自己的注释早就写着「凡 git 跟踪的东西（含历史）都会被推送、
 *   被浏览、被抓取」—— 本文件就是把那句话落到实处。
 *
 * ── 为什么走 stdin 喂 `git cat-file --batch` 的原始流 ────────────────────────
 * 同样因为本环境下 node 自建子进程会 EBUSY（见 pii_guard.ts 文件头）。
 * 由 shell 侧完成「枚举 + 取内容」，本脚本只负责解析与比对：
 *     RANGE=<remote_sha>..<local_sha>
 *     git rev-list --objects "$RANGE" | cut -d' ' -f1 | sort -u \
 *       | git cat-file --batch-check='%(objectname) %(objecttype)' \
 *       | awk '$2=="blob"{print $1}' | sort -u \
 *       | git cat-file --batch | tsx scripts/pii_history_guard.ts --stdin
 *
 * 比对按 **UTF-8 字节**（同 pii_guard），所以二进制 blob 也一视同仁。
 * 输出只给「blob 短号 + 掩码 token」，**不回显明文** —— 免得 CI 日志变成新的泄露面。
 * 定位命令也一并打印：`git log --all --find-object=<sha> --oneline`。
 *
 * 运行：npm run pii:history -- <range>      （range 形如 origin/main..HEAD；不给则扫全库）
 * 退出码：有命中 1（fail-closed）；无命中 / denylist 不存在 0
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DENY_FILE = path.join(ROOT, 'data', '.pii_denylist.txt');
/** 最多逐条打印多少命中，避免一个高频词刷屏 */
const MAX_PRINT = 20;

export interface BlobHit {
  sha: string;
  bytes: number;
  tokenIndex: number;
  count: number;
}

/** 逐行解析 denylist：跳过空行与 `#` 注释行，两端空白裁掉（与 pii_guard 同一套规则） */
export function parseDenyList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    out.push(t);
  }
  return out;
}

/** 与 pii_guard 一致的掩码：只暴露长度、首字符与哈希前缀 */
export function maskToken(t: string): string {
  const h = crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 8);
  return `deny#${h} (len=${t.length}, starts ${JSON.stringify(t.slice(0, 1))})`;
}

/**
 * 解析 `git cat-file --batch` 的原始输出流。
 *
 * 格式（git 文档保证）：对每个输入对象
 *     <sha> <type> <size>\n
 *     <size 个字节的内容>\n
 * 对象不存在时只有一行 `<sha> missing\n`（本函数跳过）。
 */
export function* parseBatchStream(buf: Buffer): Generator<{ sha: string; type: string; content: Buffer }> {
  let pos = 0;
  const n = buf.length;
  while (pos < n) {
    const nl = buf.indexOf(10, pos); // 10 = '\n'
    if (nl < 0) return;
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const parts = header.split(' ');
    if (parts.length !== 3) continue; // `missing` / 空行
    const size = Number(parts[2]);
    if (!Number.isFinite(size) || size < 0) continue;
    const content = buf.subarray(pos, pos + size);
    pos += size + 1;
    yield { sha: parts[0], type: parts[1], content };
  }
}

/** 逐 blob 找命中（按 UTF-8 字节比对，二进制同样处理） */
export function findBlobHits(tokens: string[], buf: Buffer): BlobHit[] {
  const needles = tokens.map((t) => Buffer.from(t, 'utf8'));
  const hits: BlobHit[] = [];
  for (const { sha, content } of parseBatchStream(buf)) {
    for (let i = 0; i < needles.length; i++) {
      if (needles[i].length === 0) continue;
      const c = content.indexOf(needles[i]);
      if (c >= 0) {
        let count = 0;
        let p = c;
        while (p >= 0) { count++; p = content.indexOf(needles[i], p + needles[i].length); }
        hits.push({ sha, bytes: content.length, tokenIndex: i, count });
        break; // 一个 blob 只报一次（按第一个命中的 token），避免同一文件刷屏
      }
    }
  }
  return hits;
}

function readStdin(): Buffer {
  try { return fs.readFileSync(0); } catch { return Buffer.alloc(0); }
}

function main(): number {
  if (!fs.existsSync(DENY_FILE)) {
    if (process.env.REQUIRE_PII_SCAN === '1') {
      console.log('❌ PII history guard: data/.pii_denylist.txt 不存在，REQUIRE_PII_SCAN=1 ⇒ 拒绝放行');
      return 1;
    }
    console.log('PII history guard: SKIPPED (denylist 不存在)');
    return 0;
  }
  const tokens = parseDenyList(fs.readFileSync(DENY_FILE, 'utf8'));
  if (!tokens.length) {
    console.log('PII history guard: SKIPPED (denylist 无有效项)');
    return 0;
  }
  const buf = readStdin();
  if (!buf.length) {
    // 空输入是合法的：这次 push 没有引入任何新 blob（例如只删文件 / 只推 tag）
    console.log(`✅ PII history guard: 本次推送没有引入新 blob（0 命中）`);
    return 0;
  }
  const hits = findBlobHits(tokens, buf);
  const totalBytes = buf.length;
  if (!hits.length) {
    console.log(`✅ PII history guard: ${(totalBytes / 1048576).toFixed(1)}MB 历史 blob × ${tokens.length} 个 deny 项，0 命中`);
    return 0;
  }
  console.log(`❌ PII history guard: ${hits.length} 个历史 blob 命中（扫了 ${(totalBytes / 1048576).toFixed(1)}MB / ${tokens.length} 个 deny 项）`);
  for (const h of hits.slice(0, MAX_PRINT)) {
    console.log(`   - ${h.sha.slice(0, 12)} (${h.bytes}B) ← ${maskToken(tokens[h.tokenIndex])} ×${h.count}`);
  }
  if (hits.length > MAX_PRINT) console.log(`   ... 另有 ${hits.length - MAX_PRINT} 个未列出`);
  console.log('   定位：git log --all --find-object=<上方 sha> --oneline');
  console.log('   🔴 这不是"文件当前内容"的问题 —— 命中发生在**历史 blob**里，说明这次推送中间的某个提交');
  console.log('      曾把该值写进仓库。仅再提交一次删除**无效**（tip 干净但历史仍在），必须把该提交改掉或放弃这次推送。');
  return 1;
}

const invokedDirectly = (() => {
  const a = process.argv[1];
  if (!a) return false;
  try { return pathToFileURL(path.resolve(a)).href === import.meta.url; } catch { return false; }
})();

if (invokedDirectly) process.exit(main());
