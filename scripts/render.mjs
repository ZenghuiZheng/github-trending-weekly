/**
 * render.mjs — 把 Markdown 报告渲染成三平台版本
 *
 * 输出:
 *   preview/email-{date}.html   邮件 HTML（内联样式，手机友好）
 *   preview/im-{date}.txt       IM 精简卡片文本
 *   （MD 版本已由 write.mjs 生成）
 *
 * 说明：为降低复杂度与依赖，这里不做 LLM 二次改写，
 * 而是从已生成的高质量 MD 中结构化提取，保证三端事实完全一致。
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log, logErr, readJSON, writeText, ensureDir, monthFileBase, weekFileBase } from "./lib/common.mjs";

const args = process.argv.slice(2);
const dataArg = args.find((a) => a.startsWith("--data="))?.split("=")[1];
const quiet = args.includes("--quiet");

const dataFile = dataArg ? path.join(ROOT, dataArg) : pickLatest();

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

// ---------------- Markdown 解析 ----------------
/**
 * 把报告 MD 拆成结构：
 * { title, meta: [], trendText, items: [{index,title,repo,body}] }
 */
export function parseReport(md) {
  const lines = md.split(/\r?\n/);
  const out = { title: "", meta: [], trendText: "", items: [], raw: md };

  let i = 0;
  // 标题
  while (i < lines.length && !lines[i].startsWith("# ")) i++;
  if (i < lines.length) out.title = lines[i].replace(/^#\s*/, "").trim();
  i++;

  // 引用块（统计窗口等）
  while (i < lines.length && lines[i].trim() === "") i++;
  while (i < lines.length && lines[i].startsWith(">")) {
    out.meta.push(lines[i].replace(/^>\s?/, "").trim());
    i++;
  }

  // 逐段解析项目
  let cur = null;
  let buf = [];
  const flushBuf = () => {
    if (cur && buf.length) {
      cur.body = buf.join("\n").trim();
    }
    buf = [];
  };

  // ★ 趋势区状态机：只采集第一个一级小节（本期趋势 / 本月趋势）的正文。
  //   旧逻辑会把 Top3 深度点评 / 连续霸榜 / 完整榜单的正文也拼进趋势里，
  //   导致 IM 卡片和邮件里的「本期趋势」混入无关文字。
  let trendHeadingSeen = false;

  for (; i < lines.length; i++) {
    const line = lines[i];

    // "### 1. repo/name"
    const itemStart = line.match(/^###\s+(\d+)[.、]\s+(.+?)\s*$/);
    if (itemStart) {
      flushBuf();
      if (cur) out.items.push(cur);
      const namePart = itemStart[2];
      const repoMatch = namePart.match(/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)/);
      cur = {
        index: Number(itemStart[1]),
        title: namePart,
        repo: repoMatch ? repoMatch[1] : null,
        body: "",
      };
      continue;
    }

    if (cur) {
      buf.push(line);
      continue;
    }

    // ---- 以下为“前文区”（还没遇到第一个 ### 编号小节） ----
    if (line.startsWith("## ")) {
      const heading = line.replace(/^##\s*/, "").trim();
      if (!trendHeadingSeen && !/完整榜单|Top\s*3|深度点评|连续霸榜/i.test(heading)) {
        // 第一个一级小节 = 趋势点评，采集它
        trendHeadingSeen = true;
        out.trendHeading = heading;
      } else {
        // 后续小节（Top3 / 连续霸榜 / 完整榜单…）一律停止采集
        out.trendHeading = out.trendHeading || heading;
        trendHeadingSeen = true;
        out.trendDone = true;
      }
      continue;
    }
    if (!trendHeadingSeen || out.trendDone) continue;
    if (line.startsWith("#") || line.startsWith(">") || /^-{3,}$/.test(line.trim())) continue;
    if (line.trim()) out.trendText += line + "\n";
  }
  flushBuf();
  if (cur) out.items.push(cur);

  out.trendText = out.trendText.trim();

  // 若上面的状态机没抽到内容，回退到正则抓取
  if (!out.trendText) {
    const tm = md.match(/##\s*(本期趋势|本月趋势|月度趋势)\s*\n+([\s\S]*?)(?=\n##\s|\n###\s|$)/);
    if (tm) out.trendText = tm[2].trim();
  }

  return out;
}

/** 从项目 body 中提取字段（按“**字段名**”分段） */
function extractFields(item) {
  const b = item.body || "";

  // 先找出所有字段标题的位置
  // 已知字段名白名单（只有这些才算字段标题，避免正文里的加粗被误判）
  const KNOWN = [
    "它是什么", "是什么", "解决什么问题", "解决什么", "为什么本周火", "为什么本月火", "为什么火", "为什么突然火",
    "时间与成熟度", "时间", "快速上手", "如何快速体验", "快速体验", "应用边界", "边界",
    "许可与状态", "许可",
  ];
  const isKnown = (label) => KNOWN.some((k) => label === k || label.startsWith(k));

  const headingRe = /\*\*([^*\n]{2,20})\*\*/g;
  const marks = [];
  let m;
  while ((m = headingRe.exec(b)) !== null) {
    const label = m[1].trim();
    if (!isKnown(label)) continue;          // 不在白名单，不算标题
    marks.push({ label, start: m.index, end: m.index + m[0].length });
  }
  // 若没有任何字段标题，整段归入 what
  if (marks.length === 0) {
    return { what: b.trim(), problem: "", why: "", time: "", install: "", boundary: "", license: "" };
  }

  // 将正文按字段标题切段
  const sections = {};
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const nextStart = i + 1 < marks.length ? marks[i + 1].start : b.length;
    let content = b.slice(cur.end, nextStart).trim();
    // 去掉末尾的分隔线
    content = content.replace(/\n*-{3,}\s*$/, "").trim();
    // 同名只保留第一个
    if (!(cur.label in sections)) sections[cur.label] = content;
  }

  // 按别名取字段
  const pick = (...aliases) => {
    for (const a of aliases) {
      for (const [label, val] of Object.entries(sections)) {
        if (label === a || label.includes(a)) return val;
      }
    }
    return "";
  };

  return {
    what: pick("它是什么", "是什么"),
    problem: pick("解决什么问题", "解决什么"),
    why: pick("为什么本周火", "为什么本月火", "为什么火", "为什么突然火"),
    time: pick("时间与成熟度", "时间"),
    install: pick("快速上手", "如何快速体验", "快速体验"),
    boundary: pick("应用边界", "边界"),
    license: pick("许可与状态", "许可"),
  };
}

/**
 * 提取"精简卡片"所需的四个字段，全部来自报告的中文正文。
 * 用户要求：推送内容 = 项目名 + 涨星 + 项目介绍 + 解决什么问题 + 状态
 * 拿不到中文时明确提示，绝不回退到英文 desc。
 */
export function buildDigest(report, data) {
  return data.items.map((it, i) => {
    const item = report.items.find((x) => x.repo === it.repo) || report.items[i];
    const f = item ? extractFields(item) : {};

    const clean = (t) => (t || "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // markdown 链接转纯文本
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const what = clean(f.what);
    const problem = clean(f.problem);
    // 状态：优先用结构化数据，中文表述
    let status = "";
    if (it.archived) status = "⚠️ 慎用（仓库已归档）";
    else if (it.maintenance === "慎用") status = `⚠️ 慎用（${it.maintenanceNote || "维护状态不佳"}）`;
    else if (it.maintenance === "未知") status = "维护状态未知";
    else status = `✅ ${it.maintenance}${it.maintenanceNote ? "（" + it.maintenanceNote + "）" : ""}`;

    return {
      index: i + 1,
      repo: it.repo,
      url: it.url,
      gain: it.gain,
      gainText: it.gain.toLocaleString(),
      what: what || "（报告未给出介绍）",
      problem: problem || "（报告未给出说明）",
      status,
    };
  });
}

/** 从项目标题/正文提取统计信息 */
function extractStats(item) {
  const t = item.title || "";
  const b = item.body || "";
  // ★ 统计行优先从 body 找（"**🧩 插件技能** ｜ ★ 本期 **+15072** ｜ 总星 47721 ｜ 相对热度 **31.6%**"），
  //   找不到再退回 title。旧实现只看 title，月报里多半拿不到涨星/总星，卡片头部空白。
  const src = /\+\s*[\d,]/.test(b) ? b : t;
  const gain = (src.match(/\+\s*([\d,]+)/) || [])[1] || null;
  const total = (src.match(/总星\s*([\d,]+)/) || [])[1] || null;
  const heat = (src.match(/([\d.]+)\s*%/) || [])[1] || null;
  const catMatch = b.match(/\*\*([\u4e00-\u9fa5A-Za-z]+)\*\*\s*｜/);
  return { gain, total, heat, category: catMatch ? catMatch[1] : null };
}

// ---------------- 邮件 HTML ----------------
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 极简 markdown → html（先处理代码块，再处理行内标记） */
/** 修复 LLM 输出里畸形的 markdown（如 `*发布主体**：` 少一个星号） */
function fixMarkdown(s) {
  let t = String(s ?? "");
  t = t.replace(/(^|[^\*])\*([^*\n]{1,30})\*\*/g, "$1**$2**");
  t = t.replace(/\*\*([^*\n]{1,30})\*(?!\*)/g, "**$1**");
  t = t.replace(/\*{3,}/g, "**");
  return t;
}

function mdInline(s) {
  if (!s) return "";
  let h = fixMarkdown(s);

  // 1) 先提取代码块（```lang ... ```），占位保留，避免内部被行内规则破坏
  const blocks = [];
  h = h.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const idx = blocks.length;
    blocks.push(
      `<pre style="background:#eef2f7;color:#1e3a5f;border:1px solid #dde5ee;padding:14px 16px;border-radius:8px;overflow-x:auto;font-family:Consolas,Monaco,'Courier New','DejaVu Sans Mono','Noto Sans Mono CJK SC',monospace;font-size:15px;line-height:1.7;margin:10px 0;white-space:pre-wrap;word-break:break-all;">${esc(code.replace(/\n+$/, ""))}</pre>`
    );
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  // 2) 普通文本转义
  h = esc(h);

  // 3) 行内代码
  h = h.replace(/`([^`\n]+)`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-family:Consolas,Monaco,DejaVu Sans Mono,Noto Sans Mono CJK SC,monospace;font-size:15px;color:#be185d;">$1</code>');
  // 4) 加粗
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 5) 链接
  h = h.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" style="color:#2563eb;text-decoration:none;">$1</a>');
  h = h.replace(/(?<!\()(https?:\/\/[^\s<)]+)/g, '<a href="$1" style="color:#2563eb;text-decoration:none;word-break:break-all;">$1</a>');

  // 6) 回填代码块
  h = h.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (m, i) => blocks[Number(i)] || "");

  // 7) 换行（代码块已自带块级格式，避免重复）
  h = h.replace(/\n/g, "<br>");
  h = h.replace(/<br>(<pre)/g, "$1").replace(/(<\/pre>)<br>/g, "$1");

  return h;
}

export function renderEmailHTML(report, data, { variant = "email" } = {}) {
  const isMonthly = data.since === "monthly";
  const W = data.window;
  const dateLabel = isMonthly ? `${W.year}年${W.month}月` : `${W.startISO} ~ ${W.endISO}`;
  const title = isMonthly ? `GitHub 每月开源热榜 · ${dateLabel}` : `GitHub 每周开源热榜 · ${dateLabel}`;

  const totalGain = data.items.reduce((s, x) => s + x.gain, 0);

  const itemsHTML = report.items.map((item) => {
    const f = extractFields(item);
    const st = extractStats(item);
    const url = item.repo ? `https://github.com/${item.repo}` : "#";
    // 清洗：剔除任何形似安装命令的句子片段（用户要求 PDF 不留安装内容）
    const stripInstallCmds = (text) => {
      if (!text) return text;
      const CMD = /\b(npm|npx|pnpm|yarn|pip|pipx|uv|cargo|go|brew|apt|apt-get|yum|dnf|docker|docker-compose|git clone|curl|wget|winget|scoop|choco|conda|make|bash|sh)\b[^。；;\n]{0,80}/gi;
      return text
        .split(/(?<=[。；;])/)
        .filter((seg) => !CMD.test(seg))
        .join("")
        .trim();
    };

    // 邮件（email）四项：是什么 / 解决什么 / 边界 / 状态
    // PDF（pdf）四项 + 为什么火 + 时间，共六项，保持完整
    const isPdf = variant === "pdf";
    const fields = (isPdf
      ? [
          ["是什么", stripInstallCmds(f.what)],
          ["解决什么", stripInstallCmds(f.problem)],
          ["为什么火", stripInstallCmds(f.why)],
          ["时间", f.time],
          ["边界", stripInstallCmds(f.boundary)],
          ["状态", stripInstallCmds(f.license)],
        ]
      : [
          ["是什么", stripInstallCmds(f.what)],
          ["解决什么", stripInstallCmds(f.problem)],
          ["边界", stripInstallCmds(f.boundary)],
          ["状态", stripInstallCmds(f.license)],
        ]
    ).filter(([, v]) => v);

    // 每个字段独立成块（不用 table，避免 PDF 分页时整块被推到下页造成大片空白）
    const blocks = fields.map(([k, v]) => `
      <div class="card-field" style="padding:12px 20px 4px;">
        <div style="font-size:14px;font-weight:700;color:#64748b;margin:0 0 6px;letter-spacing:0.02em;">${esc(k)}</div>
        <div style="font-size:16px;line-height:1.85;color:#1e293b;text-align:justify;word-break:normal;overflow-wrap:anywhere;">${mdInline(v)}</div>
      </div>`).join("");

    return `
    <div class="card" style="margin:0 0 18px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#fff;page-break-inside:auto;">
      <div style="background:#f8fafc;padding:13px 20px;border-bottom:1px solid #e2e8f0;page-break-after:avoid;">
        <div style="font-size:17px;font-weight:700;color:#0f172a;">
          <span style="color:#94a3b8;margin-right:6px;">${item.index}.</span>
          <a href="${url}" style="color:#0f172a;text-decoration:none;">${esc(item.repo || item.title)}</a>
        </div>
        <div style="margin-top:6px;font-size:14px;color:#64748b;">
          ${st.category ? `<span style="background:#eff6ff;color:#1d4ed8;padding:1px 7px;border-radius:10px;margin-right:8px;">${esc(st.category)}</span>` : ""}
          ${st.gain ? `<span style="color:#dc2626;font-weight:700;">★ +${esc(st.gain)}</span>&nbsp;${isMonthly ? "本期" : "本周"}&nbsp;&nbsp;` : ""}
          ${st.total ? `总星 ${esc(st.total)}&nbsp;&nbsp;` : ""}
          ${st.heat ? `相对热度 ${esc(st.heat)}%` : ""}
        </div>
      </div>
      ${blocks}
      <div style="padding:0 20px 12px;"></div>
    </div>`;
  }).join("");

  // 目录
  const toc = data.items.map((it, i) => {
    const url = `https://github.com/${it.repo}`;
    return `<div style="padding:5px 0;font-size:15px;">
      <a href="${url}" style="color:#2563eb;text-decoration:none;">${i + 1}. ${esc(it.repo)}</a>
      <span style="color:#dc2626;font-weight:600;"> +${it.gain.toLocaleString()}</span>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  @media print{
    body{background:#fff !important;padding:0 !important;}
    .card{page-break-inside:auto;break-inside:auto;}
    .card-field{page-break-inside:avoid;break-inside:avoid;}
    h2,h3{page-break-after:avoid;break-after:avoid;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans SC','WenQuanYi Micro Hei',sans-serif;">
<div style="max-width:780px;margin:0 auto;padding:24px 18px;">

  <div style="background:linear-gradient(135deg,#1e293b,#334155);border-radius:12px;padding:22px 20px;color:#fff;margin-bottom:18px;">
    <div style="font-size:22px;font-weight:700;margin-bottom:8px;">${esc(title)}</div>
    <div style="font-size:14px;color:#cbd5e1;line-height:1.85;">
      统计窗口：${esc(W.startISO)} 00:00 — ${esc(W.endISO)} 24:00（北京时间）<br>
      ${isMonthly ? "口径说明：截至上列结束日（含）的过去 30 日，非自然月首尾" : "口径说明：过去 7 天"}<br>
      数据来源：GitHub Trending（since=${data.since}）｜按期间新增 Star 降序<br>
      收录 ${data.items.length} 个项目，合计新增 ${totalGain.toLocaleString()} Star
    </div>
  </div>

  ${report.trendText ? `
  <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:6px;padding:14px 16px;margin-bottom:18px;">
    <div style="font-size:15px;font-weight:700;color:#92400e;margin-bottom:8px;">📈 本期趋势</div>
    <div style="font-size:16px;color:#451a03;line-height:1.8;">${mdInline(report.trendText)}</div>
  </div>` : ""}

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:18px;">
    <div style="font-size:15px;font-weight:700;color:#334155;margin-bottom:10px;">📋 本期目录</div>
    ${toc}
  </div>

  ${itemsHTML}

  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;font-size:14px;color:#64748b;line-height:1.9;">
    <div style="font-weight:700;color:#334155;margin-bottom:6px;">说明</div>
    · 本报告由脚本自动抓取 GitHub Trending 并生成，数据为生成时刻快照<br>
    · 「相对热度」= 本期新增 Star ÷ 当前总 Star，数值越高说明越依赖近期爆发<br>
    · 「慎用」表示仓库归档、长期停更或 issue 积压严重，选用前请自行评估<br>
    · 完整版见邮件附件 PDF
  </div>

  <div style="text-align:center;font-size:13px;color:#94a3b8;padding:20px 0;">
    生成于 ${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16)}（北京时间）
  </div>
</div>
</body>
</html>`;
}

// ---------------- IM 精简卡片 ----------------
export function renderIMText(report, data) {
  const isMonthly = data.since === "monthly";
  const W = data.window;
  const dateLabel = isMonthly ? `${W.year}年${W.month}月` : `${W.startISO}~${W.endISO}`;

  const trend = (report.trendText || "").replace(/\*\*/g, "").replace(/\n+/g, " ").trim();

  const lines = [];
  lines.push(`📊 **GitHub ${isMonthly ? "月" : "周"}度开源热榜 · ${dateLabel}**`);
  lines.push(`共 ${data.items.length} 个项目 ｜ 按本期新增 Star 排序`);
  lines.push("");
  if (trend) {
    lines.push(`🔥 **本期趋势**`);
    lines.push(trend);
    lines.push("");
  }

  buildDigest(report, data).forEach((d) => {
    lines.push(`**${d.index}. [${d.repo}](${d.url})**　★ +${d.gainText}`);
    lines.push(`　▸ 介绍：${d.what}`);
    lines.push(`　▸ 解决：${d.problem}`);
    lines.push(`　▸ 状态：${d.status}`);
    lines.push("");
  });

  lines.push(`—— 完整报告见邮件附件 PDF`);
  return lines.join("\n");
}

// ---------------- 主流程 ----------------
function main() {
  if (!dataFile) throw new Error("未找到数据文件");
  const data = readJSON(dataFile);
  const mdPath = path.join(ROOT, data.reportPath || "");
  if (!data.reportPath || !fs.existsSync(mdPath)) {
    throw new Error(`找不到报告 md: ${data.reportPath}，请先运行 write.mjs`);
  }

  const md = fs.readFileSync(mdPath, "utf8");
  const report = parseReport(md);

  if (report.items.length === 0) {
    logErr(`解析出 0 个项目（报告格式可能不符合约定）。items 应为 "### 1. owner/repo" 形式`);
  } else {
    log(`解析到 ${report.items.length} 个项目章节`);
  }

  // 文件名与本地 md 完全一致，只是扩展名不同（统一走 common 的同一函数，禁止各自拼）
  // 周报: Github每周开源热榜—2026-10-19至2026-10-25.{md|html|pdf|txt}
  // 月报: Github每月开源热榜—2026年10月.{md|html|pdf|txt}
  const baseName = data.since === "monthly"
    ? monthFileBase(data.window)
    : weekFileBase(data.window);

  const previewDir = ensureDir(path.join(ROOT, "preview"));
  const htmlPath = path.join(previewDir, `${baseName}.html`);          // 邮件正文（四项）
  const pdfHtmlPath = path.join(previewDir, `.pdf-${baseName}.html`);  // PDF 专用（六项，临时）
  const imPath = path.join(previewDir, `${baseName}.txt`);

  // 供 deliver.mjs 使用
  data._baseName = baseName;
  data._pdfHtmlName = `.pdf-${baseName}.html`;

  writeText(htmlPath, renderEmailHTML(report, data, { variant: "email" }));
  writeText(pdfHtmlPath, renderEmailHTML(report, data, { variant: "pdf" }));
  writeText(imPath, renderIMText(report, data));

  if (!quiet) {
    log(`✅ 邮件 HTML（四项）: ${path.relative(ROOT, htmlPath)}`);
    log(`✅ PDF HTML（六项）: ${path.relative(ROOT, pdfHtmlPath)}`);
    log(`✅ IM 卡片: ${path.relative(ROOT, imPath)}`);
  }

  return { htmlPath, imPath, report, data };
}

if (process.argv[1] && process.argv[1].endsWith("render.mjs")) {
  try {
    main();
  } catch (e) {
    logErr(e.message);
    process.exit(1);
  }
}

export { main as renderAll };
