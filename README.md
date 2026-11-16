# GitHub 每周 / 每月开源热榜

自动抓取 GitHub Trending，由 AI 撰写成便于快速学习的中文报告，通过邮件 + 飞书 + 企业微信推送，并归档到本地与 GitHub。

---

## 它做什么

```
GitHub Actions
├── 每周一 00:00（北京）  抓取 Trending since=weekly，按"本周新增 Star"降序
├── 每周一 07:00          调用 DeepSeek 撰写报告
├── 每周一 09:00          校验 → 生成 PDF → 发邮件 → 推飞书/企微 → 提交回仓库
├── 每月末 00:00          抓取 since=monthly（过去 30 日）
├── 每月末 07:00          撰写月报 + 连续霸榜统计
└── 次月 1 日 09:00       推送
        ↓ git push
本地（Windows 计划任务：登录时 + 每日 09:05 自动 git pull）
```

## 目录结构

```
工作地址\
├── 周总结\
│   └── Github每周开源热榜—2026-10-19至2026-10-25.md
├── 月总结\
│   └── Github每月开源热榜—2026年10月.md
├── data\                    # 结构化快照（月报累加、数字校验的依据）
│   ├── weekly\2026-10-26.json
│   └── monthly\2026-10-31.json
├── snapshots\               # 原始 HTML 留档，可复现
├── preview\                 # 邮件 HTML / PDF / IM 卡片预览
├── logs\                    # 每次运行日志（密钥已脱敏）
├── scripts\                 # 全部可执行脚本
├── SKILL.md                 # ★ 写作方法论（周报/月报/多平台改写）
├── config.example.json      # 配置模板
├── config.json              # 你的密钥（已 gitignore，不会提交）
└── sync.bat                 # 本地同步脚本
```

---

## 首次部署

### 1. 建 GitHub 仓库并推送

```bash
git init
git add .
git commit -m "初始化"
gh repo create github-trending-weekly --public --source=. --push
```

> 用 **public** 仓库：Actions 完全免费，且不需要消耗私有仓库分钟数。
> 密钥全部放在 Actions Secrets 里，不会出现在代码中（推送前有专门步骤扫描拦截）。

### 2. 申请密钥

| 用途 | 在哪申请 | 说明 |
|---|---|---|
| **DeepSeek** | platform.deepseek.com | 用于撰写报告 |
| **GitHub Token** | github.com/settings/tokens | 只勾 `repo` + `public_repo` 即可；用于读取仓库元数据 |
| **SMTP 授权码** | 各邮箱设置里开启 SMTP | QQ/163 需开"SMTP 服务"拿授权码，**不是登录密码** |
| **飞书机器人** | 群设置 → 群机器人 → 添加 → 自定义机器人 | 复制 Webhook；如开启"签名校验"，再记下密钥 |
| **企业微信机器人** | 群设置 → 群机器人 → 添加 | 复制 Webhook URL |

### 3. 填 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret 名称 | 值 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 密钥 |
| `GH_PAT` | 你的 GitHub Token（用这个而不是默认 GITHUB_TOKEN，避免限流） |
| `SMTP_HOST` | `smtp.qq.com` / `smtp.163.com` / `smtp.gmail.com` |
| `SMTP_PORT` | `465`（SSL）。Gmail 也可用 `587` + `SMTP_SECURE=false` |
| `SMTP_SECURE` | `true`（465 端口）或 `false`（587 端口） |
| `SMTP_USER` | 你的完整邮箱地址 |
| `SMTP_PASS` | 授权码 |
| `MAIL_FROM` | 发件人（一般同 SMTP_USER） |
| `MAIL_TO` | 收件人，多个用英文逗号分隔 |
| `FEISHU_WEBHOOK` | 飞书 Webhook（不需要可留空） |
| `FEISHU_SECRET` | 飞书签名密钥（没开签名校验就留空） |
| `WECOM_WEBHOOK` | 企业微信 Webhook（不需要可留空） |

### 4. 本地配置（可选，用于本地调试）

```bash
cp config.example.json config.json
# 编辑 config.json 填入同样的值
```

### 5. 手动触发一次测试

仓库 → Actions → 「周报生成与推送」→ Run workflow → stage 选 `all`

观察日志，确认每一步通过。产物可在 Actions 页面底部 Artifacts 下载（含 logs / preview / 周总结）。

### 6. 设置本地自动同步

以**管理员身份**打开 PowerShell：

```powershell
# 每天 09:05 同步
schtasks /create /tn "GitHub热榜-同步" /tr "D:\汇报\sync.bat" /sc daily /st 09:05 /f

# 登录时也同步一次（补上错过的）
schtasks /create /tn "GitHub热榜-登录同步" /tr "D:\汇报\sync.bat" /sc onlogon /f
```

这样你一周内任意时刻开过机，本地就会自动是最新的。

---

## 本地手动运行（调试用）

```bash
# 全流程
node scripts/fetch.mjs --since=weekly     # 抓取
node scripts/enrich.mjs                   # 补全元数据
node scripts/readme.mjs                   # 抽 README 安装原文
node scripts/write.mjs                    # 调 LLM 撰写
node scripts/verify.mjs                   # 校验（防编造）
node scripts/deliver.mjs --dry-run        # 渲染+PDF，不发邮件
node scripts/deliver.mjs                  # 真正发送

# 只看 prompt 不调 LLM
node scripts/write.mjs --dry-run

# 月报
node scripts/fetch.mjs --since=monthly
node scripts/enrich.mjs
node scripts/readme.mjs
node scripts/streak.mjs --year=2026 --month=10
node scripts/write.mjs
```

---

## 质量保障机制

| 机制 | 说明 |
|---|---|
| **数字溯源** | 报告里每个数字必须能在 `data/*.json` 中找到；找不到就拒绝发送 |
| **命令溯源** | 「快速上手」里的命令必须来自 README 原文；编造的命令会被拦截 |
| **密钥扫描** | 推送前扫描全仓库，发现密钥模式直接失败 |
| **失败即告警** | LLM 失败、校验失败、邮件失败都会发告警邮件，**不生成降级内容** |
| **原始快照** | 每次抓取的 HTML 都存进 `snapshots/`，结果可复现、可回溯 |

---

## 常见问题

**Q：Actions 定时任务不准时？**
A：GitHub 官方承认 schedule 最多延迟约 1 小时（高负载时）。9:00 的推送可能 9:00–10:00 到达，属正常。

**Q：某周没有收到报告？**
A：三种可能——① 电脑关机不影响 Actions，但请检查 Actions 运行记录；② 校验未通过（会收到告警邮件）；③ GitHub 改版导致解析失败（日志会显示"解析出 0 个项目"）。

**Q：为什么抓不到内容？`github.com/trending` 一直超时。**

A：这是实测确认过的问题：`github.com` 整个域名在很多网络出口（包括部分 CI 环境）**直接连接超时**，
而 `api.github.com` 完全正常。早期的镜像源（`gh-proxy.com`、`ghfast.top`）是给 raw 文件 / git clone 用的，
**不代理 HTML 页面**，对 trending 路径会返回 404 或超时。于是"名义上 4 个源"实际全不可用。

现在已改为 **官方 Search API 作为主源**，不再依赖 trending HTML：

- 按创建时间分层查询（近 1 周 / 1 月 / 3 月），逐层提高总星门槛
- 这样拿到的是「近期新建 + 快速涨星」的项目，正好是 trending weekly 的主力
- 历史超级大仓库（几十万星）不会进来，因为它们涨星慢，本来就不上周榜
- 备用：如果 Search API 也失败，才会尝试 trending HTML（成功率较低）

**注意本地挂 VPN 对 Actions 没有帮助**：抓取发生在 GitHub 的服务器上，用的是机房的网络出口，
和你本地网络无关。本地挂 VPN 只影响你在本机手动跑 `node scripts/fetch.mjs` 调试。

**Q：报告里的"本周涨星"准确吗？**

A：取决于有没有历史基线，数据里会用 `涨星口径` 字段标明：

| 口径 | 含义 |
|---|---|
| `new-repo` | 本期新建的项目，总星即本期所得（**精确**） |
| `snapshot-diff` | 与上期快照差分的实测值（**精确**） |
| `estimated-rate` | 无历史基线时按日均速率推算（**估算，仅供参考**） |

首次运行（或删掉了上期数据）只能拿到 `estimated-rate`。保留 `data/` 下的历史文件，
从第二期起就是真实的差分值。

**Q：想改成月初 1 日统计自然月？**
A：改 `scripts/fetch.mjs` 里的时间窗口函数，或在月报 workflow 里调整 cron 与 `monthWindowCN()`。

**Q：不想发到某个渠道？**
A：把对应的 Secret 留空即可，脚本会自动跳过。

**Q：ComfyUI 的 GPL 许可要特别注意什么？**
A：报告里会自动标注 License。GPL-3.0 是传染性许可，集成进闭源商业产品前需咨询法务。

---

## 许可

本仓库脚本代码可自由使用。报告内容由 AI 根据公开数据生成，仅供参考。
