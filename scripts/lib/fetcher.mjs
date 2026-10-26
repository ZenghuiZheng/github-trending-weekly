/**
 * lib/fetcher.mjs — 带多源回退的 HTTP 抓取
 *
 * 国内直连 github.com 时常抖动（api.github.com 通、www 不通）。
 * 策略：
 *   1. 依次尝试多个镜像/源
 *   2. 每个源多次重试
 *   3. 支持 HTTP_PROXY 环境变量
 *   4. 全部失败时明确报错（不降级、不静默）
 */

import { log, logErr, sleep } from "./common.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** GitHub Trending 页面候选源（按优先级） */
export function trendingSources(since) {
  return [
    `https://github.com/trending?since=${since}`,
    `https://raw.githubusercontent.com/trending/trending/main/README.md`, // 占位，通常不可用
    `https://gh-proxy.com/https://github.com/trending?since=${since}`,
    `https://ghfast.top/https://github.com/trending?since=${since}`,
  ].filter((u) => !u.includes("raw.githubusercontent.com/trending"));
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

/** 拉取仓库 README 原文（多源回退：API → raw 镜像） */
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
