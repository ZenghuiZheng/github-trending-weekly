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
  writeJSON, writeText, httpFetch, retry, num, readJSON,
} from "./lib/common.mjs";

const args = process.argv.slice(2);
const since = (args.find((a) => a.startsWith("--since="))?.split("=")[1]) || "weekly";
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
const URL_TRENDING = `https://github.com/trending?since=${since}`;

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

// ---------------- 主流程 ----------------
async function main() {
  const dateInfo = todayCN();
  log(`开始抓取 ${URL_TRENDING}（${dateInfo.iso}）`);

  const html = await retry(async () => {
    const res = await httpFetch(URL_TRENDING, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 10000) throw new Error(`返回内容过短: ${text.length}`);
    return text;
  }, { label: "抓取 trending" });

  // 原始 HTML 留档
  const snapPath = path.join(ROOT, "snapshots", `${since}-${dateInfo.iso}.html`);
  writeText(snapPath, html);
  log(`原始 HTML 已留档: ${path.relative(ROOT, snapPath)} (${(html.length / 1024).toFixed(1)} KB)`);

  const periodLabel = since === "weekly" ? "stars this week" : since === "monthly" ? "stars this month" : "stars today";
  const all = parseTrending(html, periodLabel);

  if (all.length === 0) {
    throw new Error("解析出 0 个项目 —— GitHub 页面结构可能已变更，请检查 parseTrending()");
  }

  // 阈值过滤 + 截断
  const passed = all.filter((x) => x.gain >= cfg.minGain);
  const top = passed.slice(0, cfg.max);

  const window = since === "weekly" ? weekWindowCN() : monthWindowCN();

  const payload = {
    version: 1,
    since,
    capturedAt: new Date().toISOString(),
    capturedAtCN: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19),
    dateKey: dateInfo.iso,
    window,
    source: URL_TRENDING,
    snapshotFile: path.relative(ROOT, snapPath),
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

    // ★ 关键：报告已生成过时，锁定数据，禁止用新抓取的数值覆盖
    //   否则报告里的数字会与快照对不上（校验失败），且违背"统计窗口固定"原则
    if (prev.reportGeneratedAt) {
      log("⚠️  本期报告已生成，锁定数据快照，不使用本次抓取结果覆盖");
      log("   （如需重新生成，请先删除 reportGeneratedAt 字段）");
      return;
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
