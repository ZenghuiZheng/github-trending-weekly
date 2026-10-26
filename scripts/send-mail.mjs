/**
 * send-mail.mjs — 直连 SMTP 发送邮件
 *
 * 支持：QQ / 163 / Gmail / 企业邮箱 / 自建 SMTP
 * 授权码在 config.json 或环境变量中，绝不写入代码。
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log, logErr } from "./lib/common.mjs";
import { loadConfig } from "./lib/config.mjs";

/** 常见邮箱服务商默认参数（用户只需填授权码即可） */
export const SMTP_PRESETS = {
  "qq.com": { host: "smtp.qq.com", port: 465, secure: true },
  "foxmail.com": { host: "smtp.qq.com", port: 465, secure: true },
  "163.com": { host: "smtp.163.com", port: 465, secure: true },
  "126.com": { host: "smtp.126.com", port: 465, secure: true },
  "gmail.com": { host: "smtp.gmail.com", port: 465, secure: true },
  "outlook.com": { host: "smtp-mail.outlook.com", port: 587, secure: false },
  "hotmail.com": { host: "smtp-mail.outlook.com", port: 587, secure: false },
  "yeah.net": { host: "smtp.yeah.net", port: 465, secure: true },
  "sina.com": { host: "smtp.sina.com", port: 465, secure: true },
};

export function guessSMTP(email) {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (SMTP_PRESETS[domain]) return SMTP_PRESETS[domain];
  return { host: `smtp.${domain}`, port: 465, secure: true };
}

/**
 * 发送邮件
 * @param {{subject,html,text,attachments}} opts
 */
export async function sendMail(opts) {
  const cfg = loadConfig();
  const m = cfg.mail;

  if (!m.host || !m.user || !m.pass) {
    throw new Error("SMTP 未配置完整（需要 smtpHost / smtpUser / smtpPass）");
  }
  if (m.to.length === 0) {
    throw new Error("未配置收件人 mailTo");
  }

  const nodemailer = await import("nodemailer");
  const transport = nodemailer.default.createTransport({
    host: m.host,
    port: m.port,
    secure: m.secure,
    auth: { user: m.user, pass: m.pass },
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });

  const from = m.from || m.user;

  const info = await transport.sendMail({
    from: `"GitHub 热榜" <${from}>`,
    to: m.to.join(", "),
    subject: opts.subject,
    text: opts.text || "",
    html: opts.html || "",
    attachments: (opts.attachments || []).filter((a) => a && a.path && fs.existsSync(a.path)),
  });

  log(`✅ 邮件已发送: ${info.messageId}（收件人 ${m.to.length} 个，附件 ${(opts.attachments || []).length} 个）`);
  return info;
}

/** 发送失败告警（用于 verify 失败、LLM 失败等场景） */
export async function sendAlert(subject, message) {
  const cfg = loadConfig();
  if (!cfg.mail.host || cfg.mail.to.length === 0) {
    logErr("无法发送告警邮件（SMTP 未配置），告警内容如下：");
    logErr(message);
    return null;
  }
  try {
    return await sendMail({
      subject: `[⚠️ 告警] ${subject}`,
      text: message,
      html: `<div style="font-family:-apple-system,sans-serif;padding:20px;">
        <h2 style="color:#dc2626;">⚠️ GitHub 热榜任务告警</h2>
        <p style="color:#334155;">${subject}</p>
        <pre style="background:#f1f5f9;padding:14px;border-radius:6px;font-size:12px;white-space:pre-wrap;">${String(message).replace(/</g, "&lt;")}</pre>
        <p style="color:#94a3b8;font-size:12px;">时间：${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19)}（北京时间）</p>
      </div>`,
    });
  } catch (e) {
    logErr(`告警邮件也发送失败: ${e.message}`);
    return null;
  }
}
