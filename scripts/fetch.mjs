/**
 * fetch.mjs — 抓取 GitHub Trending 并解析
 *
 * 用法:
 *   node scripts/fetch.mjs --since=weekly
 *   node scripts/fetch.mjs --since=monthly
 *
 * 要点:
 *   1. GitHub 页面默认顺序 != 涨星顺序，必须解析后按 starsThisPeriod 降序自行排序
 *   2. 原始 HTML 落盘到 snapshots/，保证可复现
 *   3. 解析结果落盘到 data/weekly|monthly/YYYY-MM-DD.json
 */

import fs from "node:fs";
import path from "node:path";
import {
  ROOT, log, logErr, todayCN, weekWindowCN, monthWindowCN,
  writeJSON, writeText, num, readJSON,
} from "./lib/common.mjs";
// ★ trending HTML 在很多网络出口会直接连接超时；改用官方 Search API 作为主源
import { fetchTrendingHTML, fetchTrendingViaSearchAPI } from "./lib/fetcher.mjs";
import { loadConfig } from "./lib/config.mjs";

const args = process.argv.slice(2);
const since = (args.find((a) => a.startsWith("--since="))?.split("=")[1]) || "weekly";
const force = args.includes("--force");
if (!["daily", "weekly", "monthly"].includes(since)) {
  logErr(`不支持的 since 值: ${since}`);
  process.exit(1);
}

// 数量与阈值配置
const CONFIG = {
  weekly: { max: 10, minGain: 500, dir: "weekly" },
  monthly: { max: 20, minGain: 0, dir: "monthly" }, // 月报无阈值
};

const cfg = CONFIG[since];

// ---------------- 解析 ----------------
export function parseTrending(html, periodLabel) {
  // 先剔除 svg，避免路径里的数字干扰后续正则
  const cleaned = html.replace(/<svg[\s\S]*?<\/svg>/g, "");
  const blocks = cleaned.split(/<article class="Box-row">/).slice(1);

  const items = blocks.map((b) => {
    const repoMatch = b.match(/<h2 class="h3 lh-condensed">[\s\S]*?href="\/([^"]+)"/);
    const repo = repoMatch ? repoMatch[1].replace(/\/stargazers$/, "") : null;

    // 星标/Fork 数：跳过 svg 后的数字
    const nums = [...b.matchAll(/class="tmp-mr-3 Link Link--muted d-inline-block">\s*([\d,]+)/g)].map((m) => m[1]);

    // 本期涨星，形如 `<span class="d-inline-block float-sm-right"> 15,072 stars this week </span>`
    const gainMatch = b.match(/float-sm-right">\s*([\d,]+)\s+stars this (week|month|day)/);

    const langMatch = b.match(/itemprop="programmingLanguage">([^<]+)</);
    const descMatch = b.match(/my-1 tmp-pr-4">\s*([\s\S]*?)\s*<\/p>/);

    return {
      repo,
      lang: langMatch ? langMatch[1].trim() : "",
      desc: descMatch ? descMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "",
      stars: num(nums[0]),
      forks: num(nums[1]),
      gain: gainMatch ? num(gainMatch[1]) : 0,
      periodLabel,
      url: repo ? `https://github.com/${repo}` : null,
    };
  }).filter((x) => x.repo && x.gain > 0);

  // ★ 关键：按涨星降序（不照抄页面顺序）
  items.sort((a, b) => b.gain - a.gain);
  return items;
}

// ---------------- 上期快照（差分基线） ----------------
/**
 * 读上一期的 data/<since>/*.json，建立 repo → 当时总星 的映射。
 * 用于 Search API 模式下回算“本期涨星”。
 *
 * 注意：这里按 dateKey 排序取“上一期”（严格小于今天），不按 mtime。
 */
function loadPreviousStars(since, todayISO) {
  const dir = path.join(ROOT, "data", since);
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({ n, key: n.replace(/\.json$/, "") }))
      .filter((x) => x.key < todayISO)          // 只要更早的
      .sort((a, b) => (a.key < b.key ? 1 : -1)); // 最近的在前
  } catch {
    return map;
  }

  if (!names.length) {
    log("⚠️  没有可用上期快照（首次运行），只能用“本期新建项目”估算涨星");
    return map;
  }

  // 取最近的一期作基线（只取一期，不合并，避免跨周重复计算）
  const base = readJSON(path.join(dir, names[0].n), null);
  if (!base?.items?.length) {
    log(`⚠️  上期快照 ${names[0].n} 无有效 items，忽略`);
    return map;
  }

  for (const it of base.items) {
    if (it.repo && typeof it.stars === "number") map.set(it.repo, it.stars);
  }
  // allParsed 里的数据也一并纳入（上一期没进前 10 但这次可能进）
  for (const it of base.allParsed || []) {
    if (it.repo && typeof it.stars === "number" && !map.has(it.repo)) {
      map.set(it.repo, it.stars);
    }
  }

  log(`差分基线: ${names[0].n}（${map.size} 个仓库的总星）`);
  return map;
}

// ---------------- 主流程 ----------------
async function main() {
  const dateInfo = todayCN();
  const cfgAll = loadConfig();
  const token = cfgAll.githubToken;
  const window = since === "weekly" ? weekWindowCN() : monthWindowCN();

  log(`开始抓取（${dateInfo.iso}，窗口 ${window.startISO} → ${window.endISO}）`);

  // ── 主源：Search API（稳定；带 token 配额充足）──
  let all = [];
  let usedSource = "";
  let snapRel = null;

  try {
    const r = await fetchTrendingViaSearchAPI({
      since,
      startISO: window.startISO,
      token,
    });
    all = r.items;
    usedSource = r.source;
    log(`✅ 主源（Search API）成功，候选 ${all.length} 个`);
  } catch (e) {
    logErr(`主源 Search API 失败: ${e.message}`);
    log("  尝试备用源 trending HTML（成功率较低，仅当官方页面可访问时有效）...");

    const { html, source } = await fetchTrendingHTML(since);
    usedSource = source;
    const snapPath = path.join(ROOT, "snapshots", `${since}-${dateInfo.iso}.html`);
    writeText(snapPath, html);
    snapRel = path.relative(ROOT, snapPath);
    log(`原始 HTML 已留档: ${snapRel} (${(html.length / 1024).toFixed(1)} KB)`);

    const periodLabel = since === "weekly" ? "stars this week"
      : since === "monthly" ? "stars this month" : "stars today";
    all = parseTrending(html, periodLabel);
  }

  if (all.length === 0) {
    throw new Error("两个抓取源都未返回项目 —— 请检查 token / 网络 / GitHub 页面结构");
  }

  // ★ 计算“本期涨星”（Search API 不提供该字段）
  //    · 本期新建的项目：总星即本期所得
  //    · 老项目：与上一期快照差分
  const prevStars = loadPreviousStars(since, dateInfo.iso);
  for (const it of all) {
    if (it.gain > 0) continue; // HTML 源已自带涨星
    const before = prevStars.get(it.repo);
    if (before != null) {
      it.gain = Math.max(0, it.stars - before);
      it.gainMethod = "snapshot-diff";
    } else if (it.createdInWindow) {
      // 本期新建：全部 star 都是本期所得
      it.gain = it.stars;
      it.gainMethod = "new-repo";
    } else if (it._ageDays && it._ageDays > 0) {
      // 无基线时，用“总星 / 项目年龄”估算本期均值（明确标记为估算）
      const perDay = it.stars / it._ageDays;
      const winDays = since === "weekly" ? 7 : 30;
      it.gain = Math.max(0, Math.round(perDay * winDays));
      it.gainMethod = "estimated-rate";
    } else {
      it.gain = 0;
      it.gainMethod = "unknown";
    }
    it.gainEstimated = it.gainMethod === "estimated-rate" || it.gainMethod === "unknown";
  }

  const withGain = all.filter((x) => x.gain > 0);
  if (withGain.length === 0) {
    throw new Error(
      `所有候选都无法计算本期涨星（共 ${all.length} 个）。\n` +
      `  需要上一期 data/${since}/*.json 作为差分基线；若基线被删，本期算不出增量。`
    );
  }
  withGain.sort((a, b) => b.gain - a.gain);

  // 阈值过滤 + 截断
  const passed = withGain.filter((x) => x.gain >= cfg.minGain);
  const top = passed.slice(0, cfg.max);

  if (top.length === 0) {
    throw new Error(
      `没有项目达到涨星阈值 ${cfg.minGain}（本期最高 ${withGain[0]?.gain ?? 0}）。`
    );
  }

  const payload = {
    version: 1,
    since,
    capturedAt: new Date().toISOString(),
    capturedAtCN: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19),
    dateKey: dateInfo.iso,
    window,
    source: usedSource,
    snapshotFile: snapRel,
    threshold: cfg.minGain,
    maxItems: cfg.max,
    totalParsed: all.length,
    passedCount: passed.length,
    items: top,
    // 未上主榜的也留档，月报做"连续霸榜"分析时可能需要
    allParsed: all.map((x) => ({ repo: x.repo, gain: x.gain, stars: x.stars })),
  };

  const outDir = path.join(ROOT, "data", cfg.dir);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${dateInfo.iso}.json`);

  // 重跑同一天时，保留上一轮已生成的报告路径，避免 write→deliver 分离运行时丢失
  const prev = readJSON(outPath, null);
  if (prev) {
    for (const k of ["reportPath", "reportGeneratedAt", "reportCharCount", "streaks"]) {
      if (prev[k] !== undefined) payload[k] = prev[k];
    }

    // ★ 本期报告已生成 → 不再用新抓取结果覆盖（否则报告数字与快照对不上）。
    //   但绝不能静默 return 当成功：那会让人以为抓取了、实际什么也没写。
    //   需要重抓请显式 --force。
    if (prev.reportGeneratedAt && !force) {
      throw new Error(
        `本期数据已生成过报告（${path.relative(ROOT, outPath)}），已锁定，本次不覆盖。\n` +
        `  如果确实要重新抓取本期数据（会作废已有报告），请加 --force，并重新跑 write。`
      );
    }

    // 未生成报告时：保留已抽取的 install 数据，避免 enrich/readme 结果丢失
    const prevByRepo = new Map((prev.items || []).map((x) => [x.repo, x]));
    for (const it of payload.items) {
      const old = prevByRepo.get(it.repo);
      if (old && old.install) it.install = old.install;
    }
    log(`检测到同名快照，已保留历史字段: ${Object.keys(prev).filter(k => k.startsWith("report") || k === "streaks").join(", ") || "无"}`);
  }

  writeJSON(outPath, payload);

  log(`解析到 ${all.length} 个项目，达标 ${passed.length} 个，取前 ${top.length} 个`);
  log(`榜单（按涨星降序）:`);
  top.forEach((x, i) => log(`  ${String(i + 1).padStart(2)}. ${x.repo}  +${x.gain}  (总星 ${x.stars}, ${x.lang || "无语言"})`));
  log(`已写入: ${path.relative(ROOT, outPath)}`);
}

// 仅当直接运行时执行（便于被 import 复用 parseTrending）
if (process.argv[1] && process.argv[1].endsWith("fetch.mjs")) {
  main().catch((e) => {
    logErr(e.stack || e.message);
    process.exit(1);
  });
}
