/**
 * enrich.mjs — 用 GitHub API 补全项目元数据 + 自动分类 + 维护状态判定
 *
 * 输入: data/weekly|monthly/YYYY-MM-DD.json（fetch.mjs 产出）
 * 输出: 同文件，items 内每个项目增加丰富字段
 *
 * 新增字段:
 *   createdAt / pushedAt / license / archived / openIssues
 *   ageDays / isNew (是否本月新建) / isRevived (老项目二次爆发)
 *   relativeHeat (相对热度 = 期间涨星 / 现有总星)
 *   category (可运行工具/资料库/模型权重/插件技能/音视频生成/其他)
 *   maintenance (健康/一般/慎用)
 *   maintenanceNote
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log, logErr, readJSON, writeJSON, num } from "./lib/common.mjs";
import { githubAPI } from "./lib/fetcher.mjs";
import { loadConfig } from "./lib/config.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => a.startsWith("--file="))?.split("=")[1];
const file = target || pickLatest();

function pickLatest() {
  // 找 weekly 和 monthly 中最新修改的 json
  let best = null;
  let bestT = 0;
  for (const sub of ["weekly", "monthly"]) {
    const dir = path.join(ROOT, "data", sub);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      const t = fs.statSync(p).mtimeMs;
      if (t > bestT) {
        bestT = t;
        best = p;
      }
    }
  }
  return best;
}

// ---------------- 分类规则 ----------------
/**
 * 依据 repo 名 / 简介 / 语言 / topics 推断项目类型
 * 返回 { category, categoryEmoji, needDeploy }
 */
export function classify(item) {
  const repo = (item.repo || "").toLowerCase();
  const desc = (item.desc || "").toLowerCase();
  const topics = (item.topics || []).join(" ").toLowerCase();
  const blob = `${repo} ${desc} ${topics}`;

  // 1) 音视频生成类
  if (/(video|audio|render|tts|voice|speech|subtitle|animation)/.test(blob) &&
      /(generate|render|create|make|synth|edit)/.test(blob)) {
    return { category: "音视频生成", categoryEmoji: "🎬", needDeploy: false };
  }
  // 2) 插件 / 技能 / 扩展（给某个 AI 客户端/包经理加能力）
  if (/(plugin|plugins|skill|skills|extension|addon|marketplace|prompt|memory for|agent memory)/.test(blob)) {
    return { category: "插件技能", categoryEmoji: "🧩", needDeploy: false };
  }
  // 2.5) 宿主型扩展（给某个具体客户端做的增强，如 Claude Code / Cursor）
  if (/(claude-code|cursor|copilot|codex|for cli|handoff)/.test(blob) &&
      !/(server|service|api|framework|engine)/.test(blob)) {
    return { category: "插件技能", categoryEmoji: "🧩", needDeploy: false };
  }
  // 3) 资料库 / 清单 / 教程
  if (/(awesome|curated|collection|list of|resources|handbook|guide|book|course|awesome-|cheatsheet|roadmap|paper)/.test(blob)) {
    return { category: "资料合集", categoryEmoji: "📚", needDeploy: false };
  }
  // 4) 模型权重
  if (/(model weight|weights|checkpoint|safetensors|gguf|lora|finetune|foundation model)/.test(blob)) {
    return { category: "模型权重", categoryEmoji: "🧠", needDeploy: false };
  }
  // 5) 可运行工具（有明确技术栈/服务属性）
  if (item.lang || /(server|service|cli|gui|api|framework|toolkit|engine|runtime|platform|agent|app|client|database|proxy|gateway)/.test(blob)) {
    return { category: "可运行工具", categoryEmoji: "🛠", needDeploy: true };
  }
  return { category: "其他", categoryEmoji: "📦", needDeploy: true };
}

/** 维护状态判定 */
export function judgeMaintenance(repo, now = new Date()) {
  const pushT = repo.pushedAt ? new Date(repo.pushedAt) : null;
  const daysSincePush = pushT ? Math.floor((now - pushT) / 86400000) : null;
  const issues = num(repo.openIssues);
  const stars = num(repo.stars);

  const issuesRatio = stars > 0 ? issues / stars : 0;

  if (repo.archived) {
    return { maintenance: "慎用", maintenanceNote: "仓库已归档（archived），官方不再更新" };
  }
  if (daysSincePush === null) {
    return { maintenance: "未知", maintenanceNote: "无法获取最近提交时间" };
  }
  if (daysSincePush > 180) {
    return { maintenance: "慎用", maintenanceNote: `已 ${daysSincePush} 天无提交，可能已停更` };
  }
  if (issues > 5000 || issuesRatio > 0.15) {
    return {
      maintenance: "慎用",
      maintenanceNote: `未处理 issue ${issues} 个${issuesRatio > 0.15 ? `（相当于总星的 ${(issuesRatio * 100).toFixed(0)}%，维护压力大）` : ""}`,
    };
  }
  if (daysSincePush <= 14) {
    return { maintenance: "正在维护", maintenanceNote: `${daysSincePush} 天内有提交` };
  }
  if (daysSincePush <= 90) {
    return { maintenance: "维护中", maintenanceNote: `最近提交在 ${daysSincePush} 天前` };
  }
  return { maintenance: "维护较慢", maintenanceNote: `最近提交在 ${daysSincePush} 天前` };
}

function ageInDays(iso, now = new Date()) {
  if (!iso) return null;
  return Math.floor((now - new Date(iso)) / 86400000);
}

async function main() {
  if (!file) throw new Error("未找到待 enrich 的数据文件，请先运行 fetch.mjs");

  const data = readJSON(file);
  if (!data) throw new Error(`无法读取 ${file}`);

  const token = loadConfig().githubToken;
  if (!token) logErr("未设置 GITHUB_TOKEN，API 限流可能较严（60 次/小时）");

  log(`开始补全 ${data.items.length} 个项目（token: ${token ? "已提供" : "无"}）`);

  const now = new Date();
  for (let i = 0; i < data.items.length; i++) {
    const it = data.items[i];
    const prefix = `  ${String(i + 1).padStart(2)}. ${it.repo}`;
    try {
      const r = await githubAPI(`/repos/${it.repo}`, { token });

      it.createdAt = r.created_at;
      it.pushedAt = r.pushed_at;
      it.license = r.license?.spdx_id || (r.license?.name ?? "未声明");
      it.archived = !!r.archived;
      it.openIssues = r.open_issues_count ?? 0;
      it.topics = r.topics || [];
      it.homepage = r.homepage || "";
      it.defaultBranch = r.default_branch || "main";
      it.topicsLine = (r.topics || []).slice(0, 6).join(", ");

      it.ageDays = ageInDays(r.created_at, now);
      // 新项目：创建距今 <= 90 天
      it.isNew = it.ageDays !== null && it.ageDays <= 90;
      // 老项目二次爆发：创建超过 1 年，但本次涨星占比很高
      it.relativeHeatPct = it.stars > 0 ? +((it.gain / it.stars) * 100).toFixed(1) : null;

      const cls = classify(it);
      Object.assign(it, cls);

      // 若已抽取过 README，不要在 enrich 重跑时丢失（install 由 readme.mjs 负责）
      if (!it.install) {
        // 保持为空，等 readme.mjs 处理
      }

      const mt = judgeMaintenance(it, now);
      Object.assign(it, mt);

      log(`${prefix}  ✅ ${it.category} | 创建 ${it.createdAt.slice(0, 10)} | 相对热度 ${it.relativeHeatPct}% | ${mt.maintenance}`);
    } catch (e) {
      logErr(`${prefix}  ❌ ${e.message}`);
      it.enrichError = e.message;
      // 分类仍可基于页面信息做
      Object.assign(it, classify(it));
      it.maintenance = "未知";
      it.maintenanceNote = "API 查询失败";
      it.license = "未知";
    }
  }

  data.enrichedAt = new Date().toISOString();
  writeJSON(file, data);
  log(`补全完成，已写回 ${path.relative(ROOT, file)}`);
}

if (process.argv[1] && process.argv[1].endsWith("enrich.mjs")) {
  main().catch((e) => {
    logErr(e.stack || e.message);
    process.exit(1);
  });
}
