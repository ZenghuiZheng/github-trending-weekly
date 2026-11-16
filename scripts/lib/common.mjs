/**
 * lib/common.mjs — 公共工具：日志（含密钥脱敏）、日期、重试、文件写入
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), "../..");

// ---------------- 日志 ----------------
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);

/** 密钥脱敏：任何形似密钥的串都替换掉，防止日志泄露到 public 仓库 */
export function redact(text) {
  if (text == null) return "";
  let s = typeof text === "string" ? text : String(text);
  const patterns = [
    /sk-[A-Za-z0-9_\-]{8,}/g,                   // OpenAI / DeepSeek 风格
    /gh[pousr]_[A-Za-z0-9]{20,}/g,              // GitHub token
    /Bearer\s+[A-Za-z0-9._\-]{10,}/gi,          // Bearer token
    // 通用 key=value：值里必须含字母，避免把 dateKey=2026-10-26 这类日期误伤
    /\b([A-Za-z0-9_-]{0,20}(?:api[_-]?key|apikey|token|secret|pass(?:word|wd)?|auth))\b\s*[:=]\s*["']?([A-Za-z0-9._\-+\/]{8,})/gi,
    /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9\-]{10,}/g,
    /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9\-]{10,}/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, (m) => m.slice(0, 4) + "***REDACTED***");
  }
  return s;
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(...args) {
  const line = `[${ts()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  const safe = redact(line);
  console.log(safe);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, safe + "\n", "utf8");
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

export function logErr(...args) {
  log("[ERROR]", ...args);
}

/**
 * 不可恢复错误：可读输出 + 退出码 1（不打堆栈，方便在 Actions 日志里一眼看到原因）
 * 堆栈仅在 DEBUG=1 时输出。
 */
export function die(e) {
  const msg = e instanceof Error ? (e.message || String(e)) : String(e);
  for (const line of msg.split("\n")) logErr(line);
  if (process.env.DEBUG && e?.stack) logErr(e.stack);
  process.exit(1);
}

// ---------------- 日期 ----------------
/** 以 UTC+8 为准的今天（返回 {y,m,d,iso}） */
export function todayCN(date = new Date()) {
  const cn = new Date(date.getTime() + 8 * 3600 * 1000);
  const y = cn.getUTCFullYear();
  const m = cn.getUTCMonth() + 1;
  const d = cn.getUTCDate();
  return { y, m, d, iso: `${y}-${pad(m)}-${pad(d)}` };
}

/** 窗口结束日是"下周一 0 点"，文件名应写最后一天（结束日减一天） */
export function lastDayOf(endISO) {
  const d = new Date(endISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * 本周窗口：上一周（刚结束的那一周）
 * 定义：若今天是周一，则窗口为【上个周一 00:00 → 今天(周一) 00:00】
 *       若今天不是周一，则窗口为【本周一 00:00 → 下周一 00:00】
 * 目的：抓取时刻恰好等于窗口结束时刻，保证滚动 7 天口径一致
 */
export function weekWindowCN(date = new Date()) {
  const cn = new Date(date.getTime() + 8 * 3600 * 1000);
  const dow = cn.getUTCDay(); // 0=周日, 1=周一 ...
  const daysSinceMonday = (dow + 6) % 7;

  // 本周一 00:00 (CN)
  const thisMondayCN = new Date(cn);
  thisMondayCN.setUTCHours(0, 0, 0, 0);
  thisMondayCN.setUTCDate(cn.getUTCDate() - daysSinceMonday);

  // 窗口起点 = 本周一之前 7 天（即上个周一）
  const startCN = new Date(thisMondayCN.getTime() - 7 * 24 * 3600 * 1000);
  const endCN = thisMondayCN;

  const startISO = `${startCN.getUTCFullYear()}-${pad(startCN.getUTCMonth() + 1)}-${pad(startCN.getUTCDate())}`;
  const endISO = `${endCN.getUTCFullYear()}-${pad(endCN.getUTCMonth() + 1)}-${pad(endCN.getUTCDate())}`;
  return { startISO, endISO, label: `${startISO}至${endISO}` };
}

/**
 * 月度窗口：截至 今天 0 点 的过去 30 日
 *
 * ★ 时间链路（必须记清）：
 *   monthly.yml 的 cron "0 16 27-31 * *" = 北京“当月最后一日 24:00”出发
 *   → 脚本看到的北京今天已经是【下一月 1 日】。
 *   → 所以窗口结束日 = 今天 - 1 天 = 当月最后一日；归属月 = 今天的月份。
 *
 * ★ 旧 bug（月度总结/推送直接失败的原因）：
 *   旧实现把窗口结束日当成“今天”（= 下一月 1 日），于是：
 *     · 10-02~10-31 的窗口被算成 10-03~11-01（跨月错位，写进报告里）；
 *     · 文件名被算成 “2026年11月.md”，而 write.mjs 落盘叫 “10 月”，
 *       verify/render 找不到报告 → deliver 第一步校验就退出 1，邮件/PDF/IM 全部没发。
 *
 * ★ 手工重跑兼容：若在“当月某一天”（非 1 号）手动跑，直接把今天当窗口结束日。
 */
export function monthWindowCN(date = new Date()) {
  const t = todayCN(date);

  // 定时触发（北京 1 号）→ 统计上一个自然月的最后 30 日；
  // 手工触发（非 1 号）→ 统计截至今天的过去 30 日。
  const end = t.d === 1
    ? new Date(Date.UTC(t.y, t.m - 1, 1) - 24 * 3600 * 1000)   // 上个月最后一天
    : new Date(Date.UTC(t.y, t.m - 1, t.d));                     // 今天

  const start = new Date(end.getTime() - 29 * 24 * 3600 * 1000);
  const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  // 归属月 = 窗口结束日所在月（10-31 → 10 月）
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() + 1;

  return {
    startISO: fmt(start),
    endISO: fmt(end),
    year,
    month,
    label: `${fmt(start)} 至 ${fmt(end)}（过去 30 日）`,
  };
}

/** 月报/月数据集的统一文件名底层（write/verify/render 必须完全一致） */
export function monthFileBase(window) {
  return `Github每月开源热榜—${window.year}年${window.month}月`;
}

/** 周报/周数据集的统一文件名底层 */
export function weekFileBase(window) {
  return `Github每周开源热榜—${window.startISO}至${lastDayOf(window.endISO)}`;
}

// ---------------- 本期数据的唯一定位（禁止 mtime 兜底） ----------------
/**
 * 计算「本期」的数据文件路径。
 *
 * 设计原则（用户明确要求）：**没有兜底**。
 *   每周/每月就是要拿当期结果；当期数据不存在 → 直接失败，绝不回退到上一期。
 *
 * ★ 旧 bug：各脚本（write/deliver/enrich/readme/render/verify）都用
 *   `pickLatest()` 按 mtime 在 data/weekly|monthly 里挑“最新”文件。
 *   一旦 capture 阶段失败没产出本期 JSON，pickLatest 就会捡到上一期的旧文件，
 *   于是 write 覆盖旧报告、deliver 把旧报告再推一遍 —— 用户看到的就是
 *   “每周都在推以前的内容”。更糟的是 write 每次都会刷新旧文件的 mtime，
 *   让它在下一轮依然是“最新”，形成自我强化的死循环。
 *
 * 现在改为按 dateKey（= 抓取当天北京日期）精确定位：
 *   周四抓取 → data/weekly/YYYY-MM-DD.json（当天）
 *   只要这个文件不在，就抛错。
 *
 * @param {"weekly"|"monthly"} since
 * @param {Date} [date]
 * @returns {{path:string, dateKey:string, window:object}}
 */
export function currentPeriodPaths(since, date = new Date()) {
  if (since !== "weekly" && since !== "monthly") {
    throw new Error(`currentPeriodPaths: 不支持的 since=${since}`);
  }
  const dateKey = todayCN(date).iso;
  const window = since === "weekly" ? weekWindowCN(date) : monthWindowCN(date);
  const relPath = `data/${since}/${dateKey}.json`;
  return {
    path: path.join(ROOT, relPath),
    relPath,
    dateKey,
    window,
  };
}

/**
 * 定位「本期」数据文件；不存在则抛错（不回退）。
 * @param {"weekly"|"monthly"} since
 * @param {Date} [date]
 */
export function requireCurrentData(since, date = new Date()) {
  const p = currentPeriodPaths(since, date);
  if (!fs.existsSync(p.path)) {
    throw new Error(
      `本期数据不存在：${p.relPath}\n` +
      `  期望统计窗口：${p.window.startISO} → ${p.window.endISO}\n` +
      `  原因：capture 阶段（fetch.mjs）没有成功产出本期 JSON，通常是抓取失败。\n` +
      `  处理：先看抓取日志找失败源，重跑 capture 阶段；**不要复用上一期数据推送**。`
    );
  }
  return p;
}

/**
 * 校验一个数据文件确实是「本期」的，而不是上一期被误用。
 * write / deliver / verify 进入时必须调用。
 * @param {object} data 已读取的 JSON
 * @param {string} relPath 数据文件相对路径（用于报错）
 */
export function assertCurrentPeriod(data, relPath = "") {
  const since = data?.since;
  if (since !== "weekly" && since !== "monthly") {
    throw new Error(`数据文件的 since 非法: ${since}（${relPath}）`);
  }
  const expect = since === "weekly" ? weekWindowCN() : monthWindowCN();
  const got = data.window || {};

  const sameStart = got.startISO === expect.startISO;
  const sameEnd = got.endISO === expect.endISO;
  if (!sameStart || !sameEnd) {
    throw new Error(
      `❌ 数据不是本期，已拒绝处理（${relPath}）\n` +
      `  文件窗口: ${got.startISO} → ${got.endISO}\n` +
      `  本期窗口: ${expect.startISO} → ${expect.endISO}\n` +
      `  该文件 dateKey=${data.dateKey}，capturedAtCN=${data.capturedAtCN}\n` +
      `  这是上一期数据的残留。请重新抓取本期数据，禁止用旧数据生成/推送报告。`
    );
  }
  return true;
}

// ---------------- 重试 ----------------
export async function retry(fn, { times = 3, delayMs = 1500, label = "op" } = {}) {
  let lastErr;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      logErr(`${label} 第 ${i}/${times} 次失败: ${e.message}`);
      if (i < times) await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- 文件 ----------------
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

export function writeText(p, text) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, text, "utf8");
  return p;
}

// ---------------- HTTP ----------------
export async function httpFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "github-trending-report/1.0 (+https://github.com)",
      ...(opts.headers || {}),
    },
  });
  return res;
}

export async function httpJSON(url, opts = {}) {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export function num(n) {
  return Number(String(n ?? 0).replace(/,/g, "")) || 0;
}
