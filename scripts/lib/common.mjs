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
    /(key|token|secret|pass|password|authorization)(["']?\s*[:=]\s*["']?)([^\s"',}]{6,})/gi,
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
