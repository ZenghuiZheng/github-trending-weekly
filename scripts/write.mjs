/**
 * write.mjs — 调用 LLM 撰写报告（按 SKILL.md 方法论）
 *
 * 严格遵循用户要求：**失败直接报错退出，不降级、不生成简陋替代品**
 *
 * 用法:
 *   node scripts/write.mjs --file=data/weekly/2026-10-26.json
 *   node scripts/write.mjs --file=data/weekly/2026-10-26.json --dry-run   # 只打印 prompt
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log, logErr, readJSON, writeJSON, writeText, retry, lastDayOf } from "./lib/common.mjs";
import { loadConfig, reportConfigHealth } from "./lib/config.mjs";

const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith("--file="))?.split("=")[1];
const dryRun = args.includes("--dry-run");
const file = fileArg ? path.join(ROOT, fileArg) : pickLatest();

function pickLatest() {
  let best = null, bestT = 0;
  for (const sub of ["weekly", "monthly"]) {
    const dir = path.join(ROOT, "data", sub);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n), t = fs.statSync(p).mtimeMs;
      if (t > bestT) { bestT = t; best = p; }
    }
  }
  return best;
}

// ---------------- Prompt 构建 ----------------
function buildSystemPrompt() {
  const skillPath = path.join(ROOT, "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  return `你是技术选型顾问，负责撰写 GitHub 开源热榜报告。

以下是你的写作方法论（必须严格遵守，尤其"铁律"和"自检清单"部分）：

${skill}

---
再次强调三条不可违反的规则：
1. 报告中每一个数字都必须能在用户提供的数据中找到原文出处，不得计算或推测。
2. 「快速上手」中的每一条命令都必须来自数据的 install.installCommands / install.installSection 字段；数据中没有就写「README 未提供安装说明」。
3. 信息不足时明确说明"仓库未说明"，绝对不允许编造项目功能细节。

现在开始撰写。直接输出报告内容，不要有任何前言、客套话或"以下是报告"之类的说明。`;
}

function buildUserPrompt(data) {
  const isMonthly = data.since === "monthly";
  const window = data.window;

  // 为 LLM 准备精简但完整的数据（避免 token 浪费）
  const items = data.items.map((it, i) => ({
    序号: i + 1,
    仓库: it.repo,
    链接: it.url,
    语言: it.lang || "未标注",
    简介: it.desc || "（仓库未提供简介）",
    标签: it.topicsLine || "（无）",
    README开头: it.install?.intro || "（未获取）",
    本周涨星: it.gain,
    总星: it.stars,
    相对热度: it.relativeHeatPct != null ? `${it.relativeHeatPct}%` : "无法计算",
    创建时间: it.createdAt || "未知",
    距今天数: it.ageDays ?? "未知",
    最近提交: it.pushedAt || "未知",
    许可证: it.license || "未知",
    未处理issue: it.openIssues ?? "未知",
    已归档: it.archived ?? null,
    项目分类: it.category,
    维护状态: it.maintenance,
    维护说明: it.maintenanceNote,
    安装标题: it.install?.installHeading || null,
    安装命令: it.install?.installCommands || [],
    安装段落原文: it.install?.installSection || null,
    安装信息缺失: it.install?.found === false,
    安装缺失原因: it.install?.reason || null,
  }));

  const extra = isMonthly && data.streaks
    ? `\n\n## 连续霸榜数据（用于"连续霸榜项目"章节）\n${JSON.stringify(data.streaks, null, 2)}`
    : "";

  return `## 本期基本信息

- 类型：${isMonthly ? "月度报告" : "周度报告"}
- 统计窗口：${window.startISO} 至 ${window.endISO}
- 窗口说明：${isMonthly ? `截至 ${window.endISO} 的过去 30 日（非自然月首尾，请在报告中说明这一点以降低歧义）` : "过去 7 天（北京时间）"}
- 数据来源：${data.source}
- 筛选阈值：${data.threshold === 0 ? "无阈值" : `期间涨星 ≥ ${data.threshold}`}
- 解析到项目总数：${data.totalParsed}，达标：${data.passedCount}，本期收录：${data.items.length}
- 要求输出条数：${isMonthly ? 20 : 10}

## 项目数据（这是唯一事实来源）

\`\`\`json
${JSON.stringify(items, null, 2)}
\`\`\`
${extra}

## 输出要求

${isMonthly
  ? "按 SKILL.md 的「二、月报撰写」结构输出：趋势 + Top3 深度点评 + 连续霸榜 + 20 条精简版。"
  : "按 SKILL.md 的「一、周报撰写」结构输出完整周报。"}

文件名中会使用：${window.startISO}至${window.endISO}（周报）或 ${window.year}年${window.month}月（月报）。

直接输出 Markdown 报告正文。`;
}

// ---------------- LLM 调用 ----------------
async function callLLM(cfg, system, user) {
  const url = `${cfg.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: cfg.llm.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: cfg.llm.temperature,
    max_tokens: cfg.llm.maxTokens,
    stream: false,
  };

  log(`  调用 ${cfg.llm.model}（prompt ≈ ${(system.length + user.length)} 字符）`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.llm.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const j = await res.json();
    const content = j.choices?.[0]?.message?.content;
    if (!content || content.trim().length < 200) {
      throw new Error(`LLM 返回内容过短或为空（${content?.length ?? 0} 字符）`);
    }
    log(`  ✅ 收到 ${content.length} 字符，usage: ${JSON.stringify(j.usage || {})}`);
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 主流程 ----------------
async function main() {
  if (!file) throw new Error("未找到数据文件，请先运行 fetch.mjs + enrich.mjs + readme.mjs");
  const data = readJSON(file);
  if (!data) throw new Error(`无法读取 ${file}`);
  if (!data.items?.length) throw new Error("数据中没有项目");

  const cfg = loadConfig();
  log("=".repeat(60));
  reportConfigHealth(cfg);

  const isMonthly = data.since === "monthly";
  const system = buildSystemPrompt();
  const user = buildUserPrompt(data);

  // 保存 prompt 便于排查
  const promptPath = path.join(ROOT, "logs", `prompt-${path.basename(file, ".json")}.txt`);
  writeText(promptPath, `=== SYSTEM ===\n${system}\n\n=== USER ===\n${user}`);
  log(`Prompt 已存档: ${path.relative(ROOT, promptPath)}`);

  if (dryRun) {
    log("--dry-run 模式，不调用 LLM。Prompt 已写入上述文件。");
    return;
  }

  if (!cfg.llm.apiKey) {
    throw new Error("缺少 LLM API Key。请在 config.json 填 deepseekApiKey，或设置环境变量 DEEPSEEK_API_KEY");
  }

  log("开始撰写报告...");
  // 严格模式：失败重试 2 次，仍失败则抛错退出（不降级）
  const markdown = await retry(() => callLLM(cfg, system, user), {
    times: 2,
    delayMs: 5000,
    label: "LLM 撰写",
  });

  // 落盘
  const outDir = isMonthly ? "月总结" : "周总结";
  const name = isMonthly
    ? `Github每月开源热榜—${data.window.year}年${data.window.month}月.md`
    : `Github每周开源热榜—${data.window.startISO}至${lastDayOf(data.window.endISO)}.md`;

  const outPath = path.join(ROOT, outDir, name);
  writeText(outPath, markdown);
  log(`✅ 报告已生成: ${path.relative(ROOT, outPath)}（${markdown.length} 字符）`);

  // 记录到数据文件
  data.reportPath = path.relative(ROOT, outPath);
  data.reportGeneratedAt = new Date().toISOString();
  data.reportCharCount = markdown.length;
  writeJSON(file, data);
}

main().catch((e) => {
  logErr("=".repeat(60));
  logErr("报告撰写失败（按配置不生成降级内容）");
  logErr(e.stack || e.message);
  logErr("=".repeat(60));
  process.exit(1);
});
