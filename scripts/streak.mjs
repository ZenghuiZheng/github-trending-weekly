/**
 * streak.mjs — 计算"连续霸榜"项目（月报用）
 *
 * 逻辑：
 *   1. 扫描 data/weekly/ 下所有周快照
 *   2. 只取当月窗口内的（窗口开始日期 >= 月初）
 *   3. 统计每个 repo 在多少个周快照中出现
 *   4. 连续 >=2 周上榜的，标记为"连续霸榜"，附带每次的涨星数
 *
 * 用法: node scripts/streak.mjs --year=2026 --month=10
 *      或：node scripts/streak.mjs --data=data/monthly/2026-10-31.json  （结果写回该文件）
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log, readJSON, writeJSON } from "./lib/common.mjs";

const args = process.argv.slice(2);
const year = Number(args.find((a) => a.startsWith("--year="))?.split("=")[1] || 0);
const month = Number(args.find((a) => a.startsWith("--month="))?.split("=")[1] || 0);
const dataFile = args.find((a) => a.startsWith("--data="))?.split("=")[1];

function listWeeklySnapshots() {
  const dir = path.join(ROOT, "data", "weekly");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  } catch {
    return [];
  }
  return names.sort().map((n) => path.join(dir, n));
}

/** 判断某个周窗口是否与指定年月有重叠 */
function overlapsMonth(window, y, m) {
  if (!window?.startISO || !window?.endISO) return false;
  const start = new Date(window.startISO + "T00:00:00Z");
  const end = new Date(window.endISO + "T00:00:00Z");
  const monthStart = new Date(Date.UTC(y, m - 1, 1));
  const monthEnd = new Date(Date.UTC(y, m, 1));
  return start < monthEnd && end > monthStart;
}

export function computeStreaks(y, m) {
  const snapshots = listWeeklySnapshots();
  const relevant = [];

  for (const p of snapshots) {
    const d = readJSON(p);
    if (!d) continue;
    if (overlapsMonth(d.window, y, m)) {
      relevant.push({ file: path.basename(p), date: d.dateKey, window: d.window, items: d.items || [] });
    }
  }

  // repo -> [{week, gain, stars}]
  const map = new Map();
  for (const s of relevant) {
    for (const it of s.items) {
      if (!map.has(it.repo)) map.set(it.repo, []);
      map.get(it.repo).push({
        week: s.window?.endISO || s.date,
        gain: it.gain,
        stars: it.stars,
        rank: s.items.indexOf(it) + 1,
      });
    }
  }

  const streaks = [];
  for (const [repo, appearances] of map.entries()) {
    if (appearances.length < 2) continue;
    const totalGain = appearances.reduce((a, b) => a + b.gain, 0);
    streaks.push({
      repo,
      weeks: appearances.length,
      totalGain,
      detail: appearances,
      bestRank: Math.min(...appearances.map((a) => a.rank)),
    });
  }

  streaks.sort((a, b) => b.weeks - a.weeks || b.totalGain - a.totalGain);

  return {
    year: y,
    month: m,
    snapshotCount: relevant.length,
    snapshotsUsed: relevant.map((r) => ({ file: r.file, window: r.window })),
    streaks,
    // 被覆盖的周全部项目涨星累加（供参考，不用于主榜排序）
    accumulated: [...map.entries()]
      .map(([repo, arr]) => ({
        repo,
        weeks: arr.length,
        accumulatedGain: arr.reduce((a, b) => a + b.gain, 0),
      }))
      .sort((a, b) => b.accumulatedGain - a.accumulatedGain),
  };
}

function main() {
  if (!year || !month) {
    // 尝试从 data 文件推断
    if (dataFile) {
      const d = readJSON(path.join(ROOT, dataFile));
      if (d?.window) {
        const end = new Date(d.window.endISO + "T00:00:00Z");
        return run(end.getUTCFullYear(), end.getUTCMonth() + 1, dataFile);
      }
    }
    throw new Error("请指定 --year 和 --month，或提供带 window 的 --data 文件");
  }
  run(year, month, dataFile);
}

function run(y, m, dataFile) {
  const r = computeStreaks(y, m);
  log(`连续霸榜统计（${y}年${m}月）：使用 ${r.snapshotCount} 个周快照`);
  r.snapshotsUsed.forEach((s) => log(`  - ${s.file} (${s.window?.startISO} ~ ${s.window?.endISO})`));

  if (r.streaks.length === 0) {
    log("  本月没有连续 ≥2 周上榜的项目");
  } else {
    for (const s of r.streaks) {
      log(`  🔥 ${s.repo}  连续 ${s.weeks} 周上榜，累计 +${s.totalGain}，最好排名 #${s.bestRank}`);
    }
  }

  if (dataFile) {
    const p = path.join(ROOT, dataFile);
    const d = readJSON(p);
    if (d) {
      d.streaks = r.streaks;
      writeJSON(p, d);
      log(`已写入 ${dataFile}`);
    }
  }
  return r;
}

if (process.argv[1] && process.argv[1].endsWith("streak.mjs")) {
  try { main(); } catch (e) { log(`[ERROR] ${e.message}`); process.exit(1); }
}
