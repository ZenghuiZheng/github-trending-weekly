/**
 * verify.mjs — 报告校验（防编造）
 *
 * 用户要求：宁可失败告警，不可发出含错误信息的报告。
 *
 * 校验项：
 *   1. 报告存在且非空
 *   2. 收录条数与数据一致
 *   3. 每个数字（涨星/总星）都能在数据中找到
 *   4. 「快速上手」中的命令必须来自 install 字段
 *   5. 密钥泄露扫描
 *   6. 必填字段无 undefined/NaN/占位符
 *
 * 用法: node scripts/verify.mjs --data=data/weekly/2026-10-26.json
 * 退出码 0 = 通过；1 = 失败
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log, logErr, readJSON, monthFileBase, weekFileBase } from "./lib/common.mjs";

const args = process.argv.slice(2);
const dataArg = args.find((a) => a.startsWith("--data="))?.split("=")[1];
const mdArg = args.find((a) => a.startsWith("--md="))?.split("=")[1];

const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

const dataFile = dataArg ? path.join(ROOT, dataArg) : pickLatestData();

function pickLatestData() {
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

// ---------------- 1. 基础校验 ----------------
if (!dataFile || !fs.existsSync(dataFile)) {
  logErr("找不到数据文件");
  process.exit(1);
}
const data = readJSON(dataFile);
const isMonthly = data.since === "monthly";

const mdFile = mdArg
  ? path.join(ROOT, mdArg)
  : resolveReportPath(data);

/**
 * 定位报告文件（不依赖 JSON 里的 reportPath，因为重跑 capture 会丢失）
 * 优先级：JSON 里记录的路径 → 命名规则推导
 */
function resolveReportPath(data) {
  if (data.reportPath) {
    const p = path.join(ROOT, data.reportPath);
    if (fs.existsSync(p)) return p;
  }

  const dir = path.join(ROOT, data.since === "monthly" ? "月总结" : "周总结");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")); } catch { return path.join(dir, "__nonexistent__.md"); }

  // ★ 严格优先：只认由 window 推导出的确定文件名，绝不“取最新”兜底。
  //   兜底会拿上一期的报告去校验本期数据，反而可能让错版报告被发出去。
  const baseName = data.since === "monthly" ? monthFileBase(data.window) : weekFileBase(data.window);
  const exact = path.join(dir, `${baseName}.md`);
  if (fs.existsSync(exact)) return exact;

  // 次选：文件名包含该窗口标识
  if (data.since === "monthly") {
    const want = `${data.window.year}年${data.window.month}月`;
    const hit = names.find((n) => n.includes(want));
    if (hit) return path.join(dir, hit);
  } else {
    const want = `${data.window.startISO}至${data.window.endISO}`;
    const hit = names.find((n) => n.includes(want));
    if (hit) return path.join(dir, hit);
  }

  return exact;
}

log(`校验报告: ${path.relative(ROOT, mdFile)}`);
log(`对照数据: ${path.relative(ROOT, dataFile)}`);

if (!fs.existsSync(mdFile)) {
  logErr(`❌ 报告文件不存在: ${mdFile}`);
  process.exit(1);
}

const md = fs.readFileSync(mdFile, "utf8");

// ---------------- 2. 非空与长度 ----------------
if (md.trim().length < 500) {
  fail(`报告内容过短（${md.trim().length} 字符），疑似生成失败`);
}
if (/(\bTODO\b|\bundefined\b|\bNaN\b|\{\{[^}]+\}\}|\[待填\]|\[占位\])/.test(md)) {
  const hits = md.match(/(\bTODO\b|\bundefined\b|\bNaN\b|\{\{[^}]+\}\}|\[待填\]|\[占位\])/g);
  fail(`报告含未填充的占位符或异常值: ${[...new Set(hits)].join(", ")}`);
}

// ---------------- 3. 条数校验 ----------------
const expected = data.items.length;
const repoPresence = data.items.map((it) => ({
  repo: it.repo,
  present: md.includes(it.repo),
  // 也接受只写仓库名不带 owner 的写法
  shortPresent: md.includes(it.repo.split("/")[1]),
}));

const missing = repoPresence.filter((r) => !r.present && !r.shortPresent);
if (missing.length > 0) {
  fail(`以下 ${missing.length} 个项目在报告中找不到: ${missing.map((m) => m.repo).join(", ")}`);
}

// ---------------- 4. 数字溯源 ----------------
// 收集数据中所有合法数字
const legalNumbers = new Set();
const tolerantNumbers = new Set();  // 允许误差的数值（issue/星标会实时变动）

/**
 * 允许"取整派生值"：模型常写「近 6000」「约 1.2 万」这类概括
 * 规则：对每个真实数字，向上/向下取整到 1/2/3 位有效数字，都视为合法
 *       例如 5,921 → 6000 / 5900 / 5920
 */
function addRounded(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 100) return;
  const digits = String(Math.floor(v)).length;
  for (let keep = 1; keep <= Math.min(3, digits - 1); keep++) {
    const mag = Math.pow(10, digits - keep);
    const down = Math.floor(v / mag) * mag;
    const up = Math.ceil(v / mag) * mag;
    for (const cand of [down, up]) {
      if (cand > 0) {
        legalNumbers.add(String(cand));
        legalNumbers.add(cand.toLocaleString("en-US"));
      }
    }
  }
  // 常见的"～万"写法
  if (v >= 10000) {
    const wan = Math.round(v / 10000 * 10) / 10;
    legalNumbers.add(String(wan));
    legalNumbers.add(String(Math.round(v / 10000)));
  }
}

function addTolerant(n) {
  const v = Number(n);
  if (!isFinite(v)) return;
  // ±2% 容差内的整数都视为合法
  const lo = Math.floor(v * 0.98);
  const hi = Math.ceil(v * 1.02);
  for (let k = lo; k <= hi; k++) {
    tolerantNumbers.add(String(k));
    tolerantNumbers.add(k.toLocaleString("en-US"));
  }
}

for (const it of data.items) {
  // ★ 期间涨星：统计窗口内的固定值，必须精确匹配
  legalNumbers.add(String(it.gain));
  legalNumbers.add(it.gain.toLocaleString("en-US"));
  addRounded(it.gain);   // 允许"近 6000"这类取整表达

  // 总星 / fork / issue：实时变动，允许 ±2% 容差
  addTolerant(it.stars);
  addTolerant(it.forks);
  addTolerant(it.openIssues);
  addRounded(it.stars);
  addRounded(it.forks);
  addRounded(it.openIssues);
  if (it.relativeHeatPct != null) {
    legalNumbers.add(String(it.relativeHeatPct));
    legalNumbers.add(`${it.relativeHeatPct}%`);
  }
  if (it.ageDays != null) legalNumbers.add(String(it.ageDays));
  // 允许由日期推导出的“距今天数”（报告会写“最近提交在 N 天前”“已停更 N 天”）
  // ★ 旧逻辑只容差 ±1 天：报告生成后每过一天，校验就失败一次，
  //   导致「重跑 deliver」永远过不了校验。必须从采集时刻到当前整体容差。
  const pushDate = it.pushedAt ? new Date(it.pushedAt) : null;
  if (pushDate) {
    const capturedMs = data.capturedAt ? new Date(data.capturedAt).getTime() : null;
    const then = capturedMs && !Number.isNaN(capturedMs) ? capturedMs : Date.now();
    const daysThen = Math.floor((then - pushDate.getTime()) / 86400000);
    // 从采集日到今天的每一天都当作合法（报告可能写当初的天数，也可能写“现在”的天数）
    const daysNow = Math.floor((Date.now() - pushDate.getTime()) / 86400000);
    const lo = Math.min(daysThen, daysNow) - 1;
    const hi = Math.max(daysThen, daysNow) + 1;
    for (let k = lo; k <= hi; k++) legalNumbers.add(String(k));
  }
  // 允许各类百分比的小数位
  if (it.relativeHeatPct != null) {
    const pct = it.relativeHeatPct;
    legalNumbers.add(pct.toFixed(1));
    legalNumbers.add(pct.toFixed(0));
  }
  // issue 数/总星 的比例（报告会写“相当于总星的 X%”）
  if (it.openIssues != null && it.stars > 0) {
    const ratio = (it.openIssues / it.stars) * 100;
    legalNumbers.add(ratio.toFixed(1));
    legalNumbers.add(ratio.toFixed(0));
  }
}
// 允许的其它数字：年份、日期、阈值、条数等
const seed = [
  String(data.threshold), String(data.totalParsed), String(data.passedCount),
  String(data.items.length), String(data.maxItems),
  ...(data.window.startISO + " " + data.window.endISO).split(/[-：: ]/).filter(Boolean),
  String(data.window.year ?? ""), String(data.window.month ?? ""),
];
seed.forEach((s) => legalNumbers.add(s));

// 提取报告中形似"大数字"的 token（≥3 位连续数字，可带逗号）
const bigNumbers = [...md.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{3,})(?![\d.])/g)]
  .map((m) => m[1]);

const suspicious = [];
for (const n of new Set(bigNumbers)) {
  const plain = n.replace(/,/g, "");
  if (legalNumbers.has(n) || legalNumbers.has(plain)) continue;
  if (tolerantNumbers.has(n) || tolerantNumbers.has(plain)) continue;  // 实时变动字段，容差内放行
  // 允许 4 位年份
  if (/^(19|20)\d{2}$/.test(plain)) continue;
  // 允许日期片段
  if (/^\d{1,2}$/.test(plain)) continue;
  suspicious.push(n);
}
if (suspicious.length > 0) {
  fail(`报告中出现无法在数据里溯源的数字: ${suspicious.slice(0, 20).join(", ")}${suspicious.length > 20 ? ` …共 ${suspicious.length} 个` : ""}`);
}

// ---------------- 5. 安装命令溯源 ----------------
const INSTALL_CMD_RE =
  /^\s*(\$ )?(npm (i|install)|npx |pip install|pipx |uv (pip|add)|cargo install|go install|brew install|docker (run|compose)|git clone|curl |wget |winget |scoop |choco |conda |python |node |make |\.\/)/gm;

const mdCommands = [...md.matchAll(/`([^`\n]{5,120})`/g)]
  .map((m) => m[1].trim())
  .filter((c) => /^(npm|npx|pip|pipx|uv|cargo|go|brew|docker|git|curl|wget|winget|scoop|choco|conda|python|node|make|bash|sh)\s/i.test(c));

// 汇总所有合法的安装命令原文片段
const legalCmdSources = data.items.map((it) => {
  const parts = [
    ...(it.install?.installCommands || []),
    it.install?.installSection || "",
    it.install?.installHeading || "",
  ];
  return parts.join("\n");
}).join("\n");

const badCommands = [];
for (const c of mdCommands) {
  // 宽松匹配：命令的前两个词能在合法源中找到
  const key = c.split(/\s+/).slice(0, 2).join(" ");
  if (legalCmdSources.includes(key)) continue;
  // 有些命令是通用说明如 "pip install -r requirements.txt"
  if (legalCmdSources.includes(c.split(/\s+/)[0])) continue;
  badCommands.push(c);
}
if (badCommands.length > 0) {
  fail(`以下命令未能在 README 安装原文中找到出处（疑似编造）: ${badCommands.slice(0, 10).join(" | ")}`);
}

// ---------------- 6. 密钥泄露扫描 ----------------
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9_\-]{16,}/g, name: "LLM API Key" },
  { re: /gh[pousr]_[A-Za-z0-9]{25,}/g, name: "GitHub Token" },
  { re: /Bearer\s+[A-Za-z0-9._\-]{20,}/g, name: "Bearer Token" },
  { re: /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9\-]{10,}/g, name: "企业微信 Webhook" },
  { re: /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9\-]{10,}/g, name: "飞书 Webhook" },
];
for (const { re, name } of SECRET_PATTERNS) {
  if (re.test(md)) fail(`报告中发现疑似${name}泄露！`);
  re.lastIndex = 0;
}

// 全仓库扫描（防止其他文件带入）
function scanDir(dir, depth = 0) {
  if (depth > 2) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (["node_modules", ".git", "logs", "snapshots", "preview"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scanDir(p, depth + 1); continue; }
    if (!/\.(mjs|js|json|md|yml|yaml|txt|bat|ps1)$/.test(e.name)) continue;
    if (e.name === "config.json") continue; // 本地配置允许（已被 gitignore）
    if (e.name === "config.example.json") continue; // 模板含示例占位符
    if (e.name === "verify.mjs") continue;  // 本文件含正则定义
    let content = "";
    try { content = fs.readFileSync(p, "utf8"); } catch { continue; }
    for (const { re, name } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(content)) {
        fail(`文件 ${path.relative(ROOT, p)} 中发现疑似${name}！绝不可提交到 public 仓库`);
      }
    }
  }
}
scanDir(ROOT);

// ---------------- 7. 内容质量警告（不阻断） ----------------
if (isMonthly) {
  const top3 = /Top\s*3|Top3|前三/i.test(md);
  if (!top3) warn("月报中未检测到 Top3 深度点评章节");
  const streak = /连续|霸榜|streak/i.test(md);
  if (!streak) warn("月报中未检测到连续霸榜相关内容");
}
const buzzwords = ["赋能", "生态闭环", "抓手", "降本增效", "全链路", "蓬勃发展", "涌现"];
const foundBuzz = buzzwords.filter((w) => md.includes(w));
if (foundBuzz.length > 0) warn(`报告含空话词汇（建议人工删改）: ${foundBuzz.join(", ")}`);

if (!/统计窗口/.test(md)) warn("报告未标注统计窗口");

// ---------------- 输出结果 ----------------
log("-".repeat(60));
if (warnings.length > 0) {
  log(`⚠️  警告 ${warnings.length} 条:`);
  warnings.forEach((w) => log(`   - ${w}`));
}

if (errors.length > 0) {
  logErr(`❌ 校验失败，共 ${errors.length} 项:`);
  errors.forEach((e) => logErr(`   - ${e}`));
  logErr("报告不可发送。");
  process.exit(1);
} else {
  log(`✅ 校验通过（数字溯源 ${bigNumbers.length} 个、命令 ${mdCommands.length} 条、密钥扫描通过）`);
  process.exit(0);
}
