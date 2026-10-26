/**
 * send-im.mjs — 飞书 / 企业微信 群机器人 Webhook 推送
 *
 * 设计说明：直接用 fetch POST webhook，不引入 MCP。
 * 理由：webhook 本质就是一次 HTTP 请求，MCP 是给交互式 AI 用的，
 *      无人值守定时任务里起 MCP 进程只会增加故障点。
 *
 * 官方限制（已核实）：
 *   飞书：  100 次/分钟，5 次/秒，单条 ≤20KB
 *   企业微信：20 条/分钟，单条 markdown ≤4096 字节
 */

import crypto from "node:crypto";
import { log, logErr, retry } from "./lib/common.mjs";
import { loadConfig } from "./lib/config.mjs";
import { buildDigest } from "./render.mjs";

// ---------------- 飞书 ----------------
/**
 * 飞书自定义机器人签名校验
 * 算法：以 "timestamp\nsecret" 为密钥，对空串做 HmacSHA256，结果 base64
 */
export function feishuSign(secret, timestamp) {
  if (!secret) return null;
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac("sha256", stringToSign);
  hmac.update("");
  return hmac.digest("base64");
}

/**
 * 发送飞书互动卡片
 * @param {string} webhook  机器人 webhook URL
 * @param {string} secret   签名密钥（可选）
 * @param {object} card     卡片 JSON
 */
export async function sendFeishu(webhook, secret, card) {
  const payload = { msg_type: "interactive", card };

  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = feishuSign(secret, timestamp);
  }

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}

  // 飞书返回：{"code":0,"msg":"success"} 或旧版 {"StatusCode":0}
  const ok = j.code === 0 || j.StatusCode === 0 || j.msg === "success";
  if (!res.ok || !ok) {
    throw new Error(`飞书推送失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return j;
}

/**
 * 构造飞书卡片：标题 + 趋势 + 项目列表
 */
export function buildFeishuCard(data, trendText, report = null) {
  const isMonthly = data.since === "monthly";
  const W = data.window;
  const dateOf = (iso) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  const dateLabel = isMonthly ? `${W.year}年${W.month}月` : `${W.startISO} ~ ${dateOf(W.endISO)}`;
  const totalGain = data.items.reduce((s, x) => s + x.gain, 0);

  const trend = (trendText || "").replace(/\*\*/g, "").replace(/\n+/g, " ").trim();
  const trendShort = trend.length > 260 ? trend.slice(0, 258) + "…" : trend;

  const digest = report ? buildDigest(report, data) : [];
  const esc = (t) => String(t || "").replace(/[<>]/g, "");

  const listElements = [];
  data.items.forEach((it, i) => {
    const d = digest[i];
    const what = d ? esc(d.what) : "（报告未给出介绍）";
    const problem = d ? esc(d.problem) : "（报告未给出说明）";
    const status = d ? esc(d.status) : "（未获取）";

    listElements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          `**${i + 1}. [${it.repo}](https://github.com/${it.repo})**　<font color='red'>★ +${it.gain.toLocaleString()}</font>\n` +
          `<font color='grey'>介绍：</font>${what}\n` +
          `<font color='grey'>解决：</font>${problem}\n` +
          `<font color='grey'>状态：</font>${status}`,
      },
    });
    if (i < data.items.length - 1) listElements.push({ tag: "hr" });
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: `📊 GitHub ${isMonthly ? "月" : "周"}度开源热榜 · ${dateLabel}`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            `**统计区间**：${W.startISO} 00:00 — ${W.endISO} 00:00（北京时间）\n` +
            `**本期收录**：${data.items.length} 个项目，合计新增 **${totalGain.toLocaleString()}** Star\n` +
            `**排序依据**：按本期新增 Star 降序`,
        },
      },
      ...(trendShort ? [
        { tag: "hr" },
        { tag: "div", text: { tag: "lark_md", content: `🔥 **本期趋势**\n${trendShort}` } },
      ] : []),
      { tag: "hr" },
      ...listElements,
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          { tag: "plain_text", content: `完整报告（含上手方式、应用边界、许可）见邮件附件 PDF` },
        ],
      },
    ],
  };
}

// ---------------- 企业微信 ----------------
/** 企业微信 markdown 单条上限 4096 字节，需分条发送 */
export function buildWecomMarkdown(data, trendText, report = null) {
  const isMonthly = data.since === "monthly";
  const W = data.window;
  const dateOf = (iso) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  const dateLabel = isMonthly ? `${W.year}年${W.month}月` : `${W.startISO} ~ ${dateOf(W.endISO)}`;
  const totalGain = data.items.reduce((s, x) => s + x.gain, 0);

  const trend = (trendText || "").replace(/\*\*/g, "").replace(/\n+/g, " ").trim();
  const trendShort = trend.length > 180 ? trend.slice(0, 178) + "…" : trend;

  const digest = report ? buildDigest(report, data) : [];

  const head = [
    `## 📊 GitHub ${isMonthly ? "月" : "周"}度开源热榜 · ${dateLabel}`,
    `**统计区间**：${W.startISO} 00:00 — ${W.endISO} 00:00（北京时间）`,
    `**本期收录**：${data.items.length} 个项目，合计新增 **${totalGain.toLocaleString()}** Star`,
  ];
  if (trendShort) {
    head.push("");
    head.push(`🔥 **本期趋势**`);
    head.push(trendShort);
  }

  const itemBlocks = data.items.map((it, i) => {
    const d = digest[i];
    return [
      `**${i + 1}. [${it.repo}](${it.url})** <font color="warning">★ +${it.gain.toLocaleString()}</font>`,
      `> 介绍：${d ? d.what : "（报告未给出介绍）"}`,
      `> 解决：${d ? d.problem : "（报告未给出说明）"}`,
      `> 状态：${d ? d.status : "（未获取）"}`,
    ].join("\n");
  });

  const tail = `完整报告（含上手方式、应用边界、许可）见邮件附件 PDF`;

  // 企业微信 markdown 单条上限 4096 字节，按块分条
  const HEAD = head.join("\n");
  const chunks = [];
  let cur = HEAD;
  for (const blk of itemBlocks) {
    const candidate = cur + "\n\n" + blk;
    if (Buffer.byteLength(candidate, "utf8") > 3600) {
      chunks.push(cur);
      cur = blk;
    } else {
      cur = candidate;
    }
  }
  const last = cur + "\n\n" + tail;
  if (Buffer.byteLength(last, "utf8") > 4000) {
    chunks.push(cur);
    chunks.push(tail);
  } else {
    chunks.push(last);
  }

  return chunks;
}

export async function sendWecom(webhook, markdown, { attempt = 1 } = {}) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } }),
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}

  if (j.errcode !== 0) {
    throw new Error(`企业微信推送失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return j;
}


// ---------------- 企业微信：发送文件（PDF） ----------------
/**
 * 企业微信 webhook 支持 file 类型，但需先 upload_media 换 media_id
 * 官方限制：文件 ≤ 20MB，media_id 3 天内有效，key 必须与发送时的 webhook key 一致
 */
export async function uploadWecomMedia(webhook, buffer, filename) {
  const key = new URL(webhook).searchParams.get("key");
  if (!key) throw new Error("webhook URL 中缺少 key 参数");

  const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${key}&type=file`;

  const form = new FormData();
  form.append("media", new Blob([buffer]), filename);

  const res = await fetch(url, { method: "POST", body: form });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}

  if (j.errcode !== 0 || !j.media_id) {
    throw new Error(`upload_media 失败: ${text.slice(0, 300)}`);
  }
  return j.media_id;
}

export async function sendWecomFile(webhook, pdfPath, { maxMB = 20 } = {}) {
  const fs = await import("node:fs");
  const path = await import("node:path");

  if (!fs.existsSync(pdfPath)) throw new Error(`文件不存在: ${pdfPath}`);
  const stat = fs.statSync(pdfPath);
  const sizeMB = stat.size / 1024 / 1024;

  if (sizeMB > maxMB) {
    throw new Error(`文件 ${sizeMB.toFixed(1)}MB 超过企业微信上限 ${maxMB}MB，已跳过`);
  }

  const buffer = fs.readFileSync(pdfPath);
  const filename = path.basename(pdfPath);

  const mediaId = await uploadWecomMedia(webhook, buffer, filename);

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "file", file: { media_id: mediaId } }),
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}
  if (j.errcode !== 0) throw new Error(`发送文件失败: ${text.slice(0, 300)}`);
  return { ok: true, filename, sizeMB: sizeMB.toFixed(1) };
}

// ---------------- 统一入口 ----------------
/**
 * 推送到所有已配置的 IM 渠道
 * 某个渠道失败不影响其他渠道，但全部失败会抛错
 */
export async function pushToIM({ data, trendText, pdfPath = null, report = null }) {
  const cfg = loadConfig();
  const results = [];
  let attempted = 0;

  // 飞书
  if (cfg.feishu.webhook) {
    attempted++;
    try {
      const card = buildFeishuCard(data, trendText, report);
      await retry(() => sendFeishu(cfg.feishu.webhook, cfg.feishu.secret, card), {
        times: 3, delayMs: 2000, label: "飞书推送",
      });
      log("✅ 飞书推送成功");
      results.push({ channel: "feishu", ok: true });
    } catch (e) {
      logErr(`飞书推送失败: ${e.message}`);
      results.push({ channel: "feishu", ok: false, error: e.message });
    }
  } else {
    log("⏭  未配置飞书 webhook，跳过");
  }

  // 企业微信
  if (cfg.wecom.webhook) {
    attempted++;
    try {
      const chunks = buildWecomMarkdown(data, trendText, report);
      for (let i = 0; i < chunks.length; i++) {
        await retry(() => sendWecom(cfg.wecom.webhook, chunks[i]), {
          times: 3, delayMs: 3000, label: `企业微信推送[${i + 1}/${chunks.length}]`,
        });
        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 3000)); // 避开 20 条/分钟
      }
      log(`✅ 企业微信推送成功（分 ${chunks.length} 条）`);

      // 追加发送 PDF 文件（企业微信支持，飞书自定义机器人不支持）
      if (pdfPath) {
        try {
          await new Promise((r) => setTimeout(r, 3000)); // 避开 20 条/分钟限流
          const f = await sendWecomFile(cfg.wecom.webhook, pdfPath);
          log(`✅ 企业微信 PDF 已发送: ${f.filename} (${f.sizeMB}MB)`);
          results.push({ channel: "wecom-file", ok: true });
        } catch (e) {
          logErr(`企业微信发送 PDF 失败: ${e.message}`);
          results.push({ channel: "wecom-file", ok: false, error: e.message });
        }
      }

      results.push({ channel: "wecom", ok: true, chunks: chunks.length });
    } catch (e) {
      logErr(`企业微信推送失败: ${e.message}`);
      results.push({ channel: "wecom", ok: false, error: e.message });
    }
  } else {
    log("⏭  未配置企业微信 webhook，跳过");
  }

  if (attempted === 0) return { skipped: true, results };
  const allFailed = results.every((r) => !r.ok);
  return { skipped: false, allFailed, results };
}
