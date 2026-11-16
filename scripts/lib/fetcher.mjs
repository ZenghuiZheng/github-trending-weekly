/**
 * lib/fetcher.mjs — HTTP 抓取
 *
 * ★ 重要教训（2026-11 实际踩坑）：
 *   `github.com/trending` HTML 页面在很多网络环境（包括 GitHub Actions 的某些出口）
 *   会直接 UND_ERR_CONNECT_TIMEOUT；而 `api.github.com` 完全正常。
 *   此前的镜像源（gh-proxy.com 等）是给 raw 文件/git clone 用的，不代理 HTML：
 *   gh-proxy.com 对 trending 路径直接返回 404，ghfast.top 也超时。
 *   于是“名义上 4 个源”实际全不可用 → 一周都抓不到内容。
 *
 *   现在改为：**官方 Search API 为主源**（稳定、带 token 配额充足），
 *   trending HTML 仅作补充尝试。任何源失败都明确报错，不静默降级。
 */

import { log, logErr, sleep } from "./common.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 只保留真实可用的 HTML 源（线上实测：镜像不代理 trending，已移除） */
export function trendingSources(since) {
  return [`https://github.com/trending?since=${since}`];
}

async function fetchOnce(url, { timeoutMs = 45000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取 trending HTML，多源多试
 * @returns {{html:string, source:string}}
 */
export async function fetchTrendingHTML(since, { attemptsPerSource = 2 } = {}) {
  const sources = trendingSources(since);
  const errors = [];

  for (const src of sources) {
    for (let i = 1; i <= attemptsPerSource; i++) {
      try {
        log(`  尝试源 [${i}/${attemptsPerSource}] ${src}`);
        const html = await fetchOnce(src);
        if (html.length < 10000) throw new Error(`内容过短 (${html.length} bytes)`);
        if (!html.includes("Box-row")) throw new Error("未找到 Box-row 结构，可能不是有效页面");
        log(`  ✅ 成功，长度 ${(html.length / 1024).toFixed(1)} KB，来源 ${src}`);
        return { html, source: src };
      } catch (e) {
        const msg = e.cause?.code || e.name === "AbortError" ? `超时/中断 (${e.cause?.code || "abort"})` : e.message;
        logErr(`  源失败: ${msg}`);
        errors.push(`${src} → ${msg}`);
        if (i < attemptsPerSource) await sleep(2000 * i);
      }
    }
  }

  throw new Error(
    `所有抓取源均失败（共 ${sources.length} 个源）：\n  ` + errors.join("\n  ") +
    `\n提示：可在环境变量设置 HTTPS_PROXY=http://127.0.0.1:端口 使用本地代理后重试。`
  );
}

/** GitHub API 调用（带 token 可选，支持重试） */
export async function githubAPI(pathOrUrl, { token, times = 3 } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastErr;
  for (let i = 1; i <= times; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);

      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        throw new Error(`限流 (剩余 ${remaining})，请检查 token 或稍后重试`);
      }
      if (res.status === 404) throw new Error(`404 Not Found`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < times) await sleep(1500 * i);
    }
  }
  throw lastErr;
}

/**
 * 用 Search API 抓取“本期涨星最多”的仓库（主源，不依赖 trending HTML）
 *
 * 思路：Search API 不支持“涨星速度”排序，但 trending weekly 的主力本来就是
 *   「近期新建 + 快速涨星」的项目。所以按创建时间分层查询：
 *     周报：近 1 周 / 近 1 月 / 近 3 月新建
 *     月报：近 1 月 / 近 3 月 / 近 6 月新建
 *   每层用逐层提高的总星门槛，保证都是该年龄段里的头部项目。
 *
 * 抓回来的 item 结构与 fetch.mjs 的 parseTrending 输出**完全一致**，
 * 因此 enrich / readme / write / render 全链路无需改动。
 *
 * @param {object} opt
 * @param {"weekly"|"monthly"} opt.since
 * @param {string} opt.startISO  统计窗口起始日（YYYY-MM-DD）
 * @param {string} [opt.token]
 * @param {number} [opt.minStars] 总星下限
 * @returns {Promise<{items:Array, source:string}>}
 */
export async function fetchTrendingViaSearchAPI({ since, startISO, token, minStars = 200 }) {
  if (!token) {
    throw new Error("Search API 必须提供 GitHub token（否则限流极低，且无法保证稳定）");
  }

  const isWeekly = since === "weekly";
  const days = isWeekly ? 7 : 30;
  const perPage = 100; // Search API 单页上限

  /**
   * ★ 核心思路：Search API 拿不到“本期涨星”，但 trending weekly 的主力
   *   本来就是「近期新建 + 快速涨星」的项目。所以按创建时间分层查询：
   *     近 1 周 / 近 1 月 / 近 3 月（周报）
   *     近 1 月 / 近 3 月 / 近 6 月（月报）
   *   总星门槛逐层提高，保证每层都是该年龄段里的头部项目。
   *   这样既覆盖“本周新爆款”，也覆盖“最近 1~3 个月持续走热”的项目。
   *
   *   历史超级大仓库（几十万星）不会被纳入 —— 它们涨星慢，
   *   本来就不会出现在 trending weekly 上，收进来反而污染榜单。
   */
  const tiers = isWeekly
    ? [
        { agoDays: 7,   minStars: 1000, label: "近 1 周新建" },
        { agoDays: 30,  minStars: 3000, label: "近 1 月新建" },
        { agoDays: 90,  minStars: 8000, label: "近 3 月新建" },
      ]
    : [
        { agoDays: 30,  minStars: 2000, label: "近 1 月新建" },
        { agoDays: 90,  minStars: 6000, label: "近 3 月新建" },
        { agoDays: 180, minStars: 15000, label: "近 6 月新建" },
      ];

  const collected = new Map(); // repo -> {api item, tier}
  const errors = [];

  for (const tier of tiers) {
    const createdAfter = new Date(Date.now() - tier.agoDays * 86400000)
      .toISOString().slice(0, 10);
    const q = `created:>${createdAfter} stars:>=${Math.max(tier.minStars, minStars)}`;
    const url =
      `https://api.github.com/search/repositories` +
      `?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;

    try {
      log(`  Search API [${tier.label}]: ${q}`);
      const j = await githubAPI(url, { token, times: 3 });
      const items = j.items || [];
      log(`    -> ${j.total_count ?? "?"} 个匹配，返回 ${items.length} 个`);
      for (const it of items) {
        const prev = collected.get(it.full_name);
        // 同一仓库若在多层出现，保留更“新”的那一层（agoDays 更小）
        if (!prev || tier.agoDays < prev.tier.agoDays) {
          collected.set(it.full_name, { item: it, tier });
        }
      }
    } catch (e) {
      logErr(`  Search 查询失败 [${tier.label}]: ${e.message}`);
      errors.push(`${q} → ${e.message}`);
    }
    await sleep(1200); // 温和限速，避免触发 secondary rate limit
  }

  if (collected.size === 0) {
    throw new Error(
      `Search API 未返回任何项目（全部查询失败）：\n  ${errors.join("\n  ")}\n` +
      `  提示：确认 token 有效且未耗尽 search 配额（每小时 30 次）。`
    );
  }

  const now = Date.now();
  const parsed = [...collected.values()].map(({ item: it, tier }) => {
    const createdMs = it.created_at ? new Date(it.created_at).getTime() : now;
    const ageDays = Math.max(1, Math.round((now - createdMs) / 86400000));
    const stars = it.stargazers_count || 0;

    return {
      repo: it.full_name,
      lang: it.language || "",
      desc: it.description || "",
      stars,
      forks: it.forks_count || 0,
      gain: 0,             // ← 由 fetch.mjs 用基线差分 / 新建项目回填
      periodLabel: isWeekly ? "stars this week" : "stars this month",
      url: it.html_url,
      createdAt: it.created_at || null,
      pushedAt: it.pushed_at || null,
      license: it.license?.spdx_id || null,
      archived: !!it.archived,
      openIssues: it.open_issues_count ?? 0,
      topics: it.topics || [],
      homepage: it.homepage || "",
      defaultBranch: it.default_branch || "main",
      // 供 fetch.mjs 判断“本期新建”口径
      createdInWindow: ageDays <= days,
      _tier: tier.label,
      _ageDays: ageDays,
    };
  });

  // 新项目优先、其次按总星（真正的 gain 排序在 fetch.mjs 完成）
  parsed.sort((a, b) => {
    if (a.createdInWindow !== b.createdInWindow) return a.createdInWindow ? -1 : 1;
    return b.stars - a.stars;
  });

  log(`  ✅ Search API 汇总 ${parsed.length} 个候选（去重后）`);
  return {
    items: parsed,
    source: `https://api.github.com/search/repositories（分层查询：${tiers.map((t) => t.label).join(" / ")}）`,
  };
}

/** 拉取仓库 README 原文（API 优先，raw 仅作补充） */
export async function fetchReadme(repo, { token } = {}) {
  // 1) 官方 API（返回 base64）
  try {
    const j = await githubAPI(`/repos/${repo}/readme`, { token, times: 2 });
    if (j?.content) {
      const text = Buffer.from(j.content, "base64").toString("utf8");
      return { text, source: "api" };
    }
  } catch (e) {
    log(`    README via API 失败: ${e.message}`);
  }
  // 2) raw.githubusercontent
  for (const branch of ["main", "master"]) {
    for (const name of ["README.md", "readme.md", "README.MD"]) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${name}`, {
          headers: { "User-Agent": UA },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const text = await res.text();
          if (text.length > 50) return { text, source: "raw" };
        }
      } catch {
        /* continue */
      }
    }
  }
  return { text: null, source: null };
}
