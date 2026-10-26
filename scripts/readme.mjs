/**
 * readme.mjs — 抽取 README 中的"安装/快速开始"原文
 *
 * 设计原则（用户要求）：
 *   - 只抽取仓库里【已经存在】的安装说明原文，作为唯一事实来源
 *   - 抓不到就明确标记 README_NOT_FOUND，绝不编造
 *   - 让 LLM 只做"压缩 + 翻译成人话"，不允许新增步骤
 */

import path from "node:path";
import { ROOT, log, logErr, readJSON, writeJSON } from "./lib/common.mjs";
import { fetchReadme } from "./lib/fetcher.mjs";
import { loadConfig } from "./lib/config.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => a.startsWith("--file="))?.split("=")[1] || pickLatest();

import fs from "node:fs";
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

/**
 * 从 README 正文中截取安装/快速开始段落
 * 匹配 ## Installation / ## Quick Start / ## Getting Started / ## 安装 / ## 快速开始
 * 以及 docker compose / docker run 命令附近的上下文
 */
export function extractInstallSection(readme) {
  if (!readme) return null;
  const lines = readme.split(/\r?\n/);

  const headingRe =
    /^(#{1,4})\s*(install(ation)?|getting\s*started|quick\s*(start|started)|setup|usage|how\s*to\s*(run|install|use)|deploy(ment)?|安装|快速开始|快速上手|开始使用|部署|使用方法|使用说明)/i;

  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) { start = i; level = m[1].length; break; }
  }

  let section = "";
  if (start >= 0) {
    const buf = [lines[start]];
    for (let i = start + 1; i < lines.length; i++) {
      const h = lines[i].match(/^(#{1,6})\s+/);
      if (h && h[1].length <= level) break; // 遇到同级或更高级标题，段落结束
      buf.push(lines[i]);
      if (buf.join("\n").length > 2500) break; // 长度上限
    }
    section = buf.join("\n").trim();
  }

  // 补充：如果没找到标题，试着抓代码块里的安装命令
  const codeBlocks = [...readme.matchAll(/```[a-zA-Z]*\n([\s\S]{10,600}?)```/g)].map((m) => m[1].trim());
  const INSTALL_CMD =
    /(npm (i|install)|npx |pip install|pipx |uv (pip|add)|cargo install|go install|brew install|docker (run|compose)|git clone|curl -|wget |winget install|scoop install|choco install|conda install)/i;
  const installCmds = codeBlocks.filter((c) => INSTALL_CMD.test(c)).slice(0, 4);

  // 取 README 开头 400 字作为简介补充（LLM 判断"这是什么"用）
  const intro = lines
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^[!\[<]/.test(l.trim()))
    .slice(0, 8)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 500);

  return {
    installHeading: start >= 0 ? lines[start].trim() : null,
    installSection: section.slice(0, 2500) || null,
    installCommands: installCmds,
    intro,
    found: !!(section || installCmds.length),
  };
}

async function main() {
  const data = readJSON(file);
  if (!data) throw new Error(`无法读取 ${file}`);
  const cfg = loadConfig();

  log(`抽取 ${data.items.length} 个项目的 README 安装说明`);

  for (let i = 0; i < data.items.length; i++) {
    const it = data.items[i];
    const prefix = `  ${String(i + 1).padStart(2)}. ${it.repo}`;

    try {
      const { text, source } = await fetchReadme(it.repo, { token: cfg.githubToken });
      if (!text) {
        it.install = { found: false, reason: "README_NOT_FOUND", raw: null };
        log(`${prefix}  ⚠️  README 获取失败`);
        continue;
      }

      const ex = extractInstallSection(text);
      it.install = {
        ...ex,
        source,
        readmeLength: text.length,
        // 完整 README 不存（太大），只存关键部分
      };

      if (ex.found) {
        log(`${prefix}  ✅ 找到安装信息（标题: ${ex.installHeading || "无"}，命令 ${ex.installCommands.length} 条）`);
      } else {
        it.install.reason = "README_NOT_FOUND";
        log(`${prefix}  ⚠️  README 中未找到安装段落`);
      }
    } catch (e) {
      it.install = { found: false, reason: "FETCH_ERROR", error: e.message };
      logErr(`${prefix}  ❌ ${e.message}`);
    }
  }

  data.readmeAt = new Date().toISOString();
  writeJSON(file, data);
  log(`完成，已写回 ${path.relative(ROOT, file)}`);
}

if (process.argv[1] && process.argv[1].endsWith("readme.mjs")) {
  main().catch((e) => { logErr(e.stack || e.message); process.exit(1); });
}
