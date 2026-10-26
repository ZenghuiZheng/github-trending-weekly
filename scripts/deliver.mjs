/**
 * deliver.mjs — 总调度：校验 → 渲染 → 生成PDF → 发邮件 → 推IM
 *
 * 严格策略（用户要求）：
 *   - 校验不通过 → 不发送，发告警邮件，退出码 1
 *   - 邮件失败   → 退出码 1（发告警）
 *   - IM 失败    → 记录警告，不视为整体失败（邮件是主渠道）
 *   - 任何环节都不降级、不发出未经验证的内容
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, log, logErr, readJSON, writeText } from "./lib/common.mjs";
import { loadConfig, reportConfigHealth } from "./lib/config.mjs";
import { renderAll } from "./render.mjs";
import { htmlToPDF } from "./pdf.mjs";
import { sendMail, sendAlert } from "./send-mail.mjs";
import { pushToIM } from "./send-im.mjs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dataArg = args.find((a) => a.startsWith("--data="))?.split("=")[1];
const skipIM = args.includes("--no-im");
const dryRun = args.includes("--dry-run");

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

async function main() {
  const dataFile = dataArg ? path.join(ROOT, dataArg) : pickLatest();
  if (!dataFile) throw new Error("未找到数据文件");

  const data = readJSON(dataFile);
  const cfg = loadConfig();
  const isMonthly = data.since === "monthly";

  log("=".repeat(64));
  log(`开始发送流程（${isMonthly ? "月报" : "周报"} · ${path.basename(dataFile)}）`);
  reportConfigHealth(cfg);
  log("=".repeat(64));

  // ---------- 步骤1：校验 ----------
  log("[1/5] 校验报告...");
  const relData = path.relative(ROOT, dataFile);
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify.mjs"), `--data=${relData}`], {
      stdio: "inherit",
      cwd: ROOT,
    });
    log("  校验通过");
  } catch (e) {
    logErr("校验失败，终止发送");
    await sendAlert(
      "报告校验未通过，本期报告未发送",
      `数据文件: ${relData}\n\n详见日志: logs/${new Date().toISOString().slice(0, 10)}.log\n\n可能原因：\n` +
      `· 报告中出现了数据里没有的数字（LLM 编造）\n` +
      `· 安装命令不在 README 原文中\n` +
      `· 有项目缺失或占位符未填充\n` +
      `· 检测到疑似密钥泄露`
    );
    process.exit(1);
  }

  // ---------- 步骤2：渲染 ----------
  log("[2/5] 渲染三平台版本...");
  const { htmlPath, report } = renderAll();
  log(`  邮件 HTML: ${path.relative(ROOT, htmlPath)}`);

  // ---------- 步骤3：PDF ----------
  log("[3/5] 生成 PDF 附件...");
  const pdfPath = htmlPath.replace(/\.html$/, ".pdf");
  const pdf = await htmlToPDF(htmlPath, pdfPath);
  if (!pdf) logErr("  PDF 生成失败，邮件将不含附件（正文内容完整）");

  // ---------- 步骤4：邮件 ----------
  log("[4/5] 发送邮件...");
  const dateKey = isMonthly ? `${data.window.year}年${data.window.month}月` : `${data.window.startISO} ~ ${data.window.endISO}`;
  const subject = `[GitHub ${isMonthly ? "月" : "周"}榜] ${dateKey} · ${data.items.length} 个项目`;

  const mdText = (() => {
    try { return fs.readFileSync(path.join(ROOT, data.reportPath), "utf8"); } catch { return ""; }
  })();

  const html = fs.readFileSync(htmlPath, "utf8");

  if (dryRun) {
    log("  --dry-run：跳过实际发送");
    log(`  主题会是: ${subject}`);
  } else {
    try {
      await sendMail({
        subject,
        html,
        text: mdText.slice(0, 20000),
        attachments: pdf ? [{ filename: path.basename(pdf), path: pdf }] : [],
      });
    } catch (e) {
      logErr(`邮件发送失败: ${e.message}`);
      await sendAlert("邮件发送失败", `错误: ${e.message}\n\n报告已生成但未送达：${data.reportPath}`);
      process.exit(1);
    }
  }

  // ---------- 步骤5：IM ----------
  if (skipIM) {
    log("[5/5] 跳过 IM 推送（--no-im）");
  } else {
    log("[5/5] 推送 IM...");
    if (dryRun) {
      log("  --dry-run：跳过 IM 推送");
    } else {
      const r = await pushToIM({ data, trendText: report.trendText, pdfPath: pdf });
      if (r.skipped) {
        log("  未配置任何 IM 渠道");
      } else if (r.allFailed) {
        logErr("  所有 IM 渠道均失败（邮件已发送成功，不视为整体失败）");
      }
    }
  }

  log("=".repeat(64));
  log("✅ 发送流程完成");
  log("=".repeat(64));
}

main().catch(async (e) => {
  logErr(e.stack || e.message);
  try {
    await sendAlert("发送流程异常终止", e.stack || e.message);
  } catch {}
  process.exit(1);
});
