/**
 * lib/config.mjs — 统一配置读取
 *
 * 优先级：环境变量（GitHub Actions Secrets） > config.json（本地）
 * 这样 Actions 用 Secrets，本地用 config.json，同一份代码两处都能跑。
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log } from "./common.mjs";

let cached = null;

export function loadConfig() {
  if (cached) return cached;

  let fileCfg = {};
  const cfgPath = path.join(ROOT, "config.json");
  try {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    // 本地没有 config.json 是正常的（比如纯 CI 环境）
  }

  const env = process.env;
  const get = (envKey, fileKey) => env[envKey] ?? fileCfg[fileKey] ?? "";

  const cfg = {
    // GitHub API
    githubToken: get("GITHUB_TOKEN", "githubToken"),

    // DeepSeek / LLM
    llm: {
      apiKey: get("DEEPSEEK_API_KEY", "deepseekApiKey"),
      baseUrl: env.LLM_BASE_URL || fileCfg.llmBaseUrl || "https://api.deepseek.com",
      model: env.LLM_MODEL || fileCfg.llmModel || "deepseek-chat",
      maxTokens: Number(env.LLM_MAX_TOKENS || fileCfg.llmMaxTokens || 8000),
      temperature: Number(env.LLM_TEMPERATURE || fileCfg.llmTemperature || 0.4),
      timeoutMs: Number(env.LLM_TIMEOUT_MS || 300000),
    },

    // SMTP
    mail: {
      host: get("SMTP_HOST", "smtpHost"),
      port: Number(get("SMTP_PORT", "smtpPort") || 465),
      secure: (env.SMTP_SECURE ?? fileCfg.smtpSecure ?? "true") !== "false",
      user: get("SMTP_USER", "smtpUser"),
      pass: get("SMTP_PASS", "smtpPass"),
      from: env.MAIL_FROM || fileCfg.mailFrom || "",
      to: (env.MAIL_TO || fileCfg.mailTo || "").split(",").map((s) => s.trim()).filter(Boolean),
    },

    // 飞书
    feishu: {
      webhook: get("FEISHU_WEBHOOK", "feishuWebhook"),
      secret: get("FEISHU_SECRET", "feishuSecret"),
    },

    // 企业微信
    wecom: {
      webhook: get("WECOM_WEBHOOK", "wecomWebhook"),
    },

    // 报告配置
    report: {
      weekly: {
        maxItems: Number(env.WEEKLY_MAX_ITEMS || fileCfg.weeklyMaxItems || 10),
        minGain: Number(env.WEEKLY_MIN_GAIN ?? fileCfg.weeklyMinGain ?? 500),
      },
      monthly: {
        maxItems: Number(env.MONTHLY_MAX_ITEMS || fileCfg.monthlyMaxItems || 20),
        minGain: Number(env.MONTHLY_MIN_GAIN ?? fileCfg.monthlyMinGain ?? 0),
      },
    },
  };

  cached = cfg;
  return cfg;
}

/** 启动时打印配置体检（不打印密钥明文） */
export function reportConfigHealth(cfg) {
  const check = (name, ok, hint = "") => {
    log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : "  ← " + hint}`);
    return ok;
  };
  log("配置检查:");
  const r = [
    check("GitHub Token", !!cfg.githubToken, "本地填 config.json: githubToken；Actions 用 Secrets.GITHUB_TOKEN"),
    check("LLM API Key (DeepSeek)", !!cfg.llm.apiKey, "config.json: deepseekApiKey 或 Secrets.DEEPSEEK_API_KEY"),
    check("SMTP", !!(cfg.mail.host && cfg.mail.user && cfg.mail.pass), "config.json: smtpHost/smtpUser/smtpPass"),
    check("收件人", cfg.mail.to.length > 0, "config.json: mailTo"),
    check("飞书 Webhook", !!cfg.feishu.webhook, "config.json: feishuWebhook（可留空则不推送）"),
    check("企业微信 Webhook", !!cfg.wecom.webhook, "config.json: wecomWebhook（可留空则不推送）"),
  ];
  return r;
}
