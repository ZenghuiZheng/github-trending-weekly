/**
 * pdf.mjs — 生成 PDF 附件（手机可直接查看）
 *
 * 方案优先级：
 *   1. Chrome / Edge headless（已实测可用，中文正常）
 *   2. 失败则跳过 PDF，不阻断主流程（邮件正文已含全部内容）
 *
 * 用法: node scripts/pdf.mjs --html=preview/email-2026-11-01.html
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT, log, logErr, ensureDir } from "./lib/common.mjs";

const execFileP = promisify(execFile);

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * HTML 文件 → PDF
 * @returns {Promise<string|null>} 生成的 PDF 绝对路径；失败返回 null
 */
export async function htmlToPDF(htmlPath, pdfPath, { timeoutMs = 90000 } = {}) {
  const browser = findBrowser();
  if (!browser) {
    logErr("未找到 Chrome/Edge，跳过 PDF 生成");
    return null;
  }

  // 中文环境自检：无中文字体时 PDF 会全部渲染成方块
  if (process.platform === "linux") {
    try {
      const { execSync } = await import("node:child_process");
      const zh = execSync("fc-list :lang=zh 2>/dev/null | wc -l", { encoding: "utf8" }).trim();
      if (Number(zh) < 1) {
        logErr("⚠️  未检测到中文字体！PDF 中的中文会显示为方块。请安装：sudo apt-get install -y fonts-noto-cjk");
      } else {
        log(`  中文字体检查通过（共 ${zh} 个）`);
      }
    } catch {
      /* 忽略检测失败 */
    }
  }

  ensureDir(path.dirname(pdfPath));
  // Windows 路径需要绝对路径 + 反斜杠
  const absHtml = path.resolve(htmlPath);
  const absPdf = path.resolve(pdfPath);
  const fileUrl = "file:///" + absHtml.replace(/\\/g, "/");

  try {
    // 去掉已有文件避免误判
    try { fs.unlinkSync(absPdf); } catch {}

    await execFileP(
      browser,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--no-pdf-header-footer",
        "--print-to-pdf-no-header",
        `--print-to-pdf=${absPdf}`,
        fileUrl,
      ],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
    );

    if (!fs.existsSync(absPdf)) throw new Error("PDF 未生成");
    const buf = fs.readFileSync(absPdf);
    if (buf.slice(0, 5).toString() !== "%PDF-") throw new Error("生成的文件不是合法 PDF");
    log(`✅ PDF 已生成: ${path.relative(ROOT, absPdf)} (${(buf.length / 1024).toFixed(0)} KB)`);
    return absPdf;
  } catch (e) {
    logErr(`PDF 生成失败（不影响邮件发送）: ${e.message}`);
    return null;
  }
}

// CLI
const args = process.argv.slice(2);
const htmlArg = args.find((a) => a.startsWith("--html="))?.split("=")[1];
if (htmlArg) {
  const htmlPath = path.join(ROOT, htmlArg);
  const out = htmlPath.replace(/\.html$/, ".pdf");
  htmlToPDF(htmlPath, out).then((p) => {
    if (!p) process.exit(1);
  });
}
