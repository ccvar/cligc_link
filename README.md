<p align="center">
  <img src="logo.svg" width="64" height="64" alt="cligc link">
</p>

<h1 align="center">cligc link</h1>

<p align="center">
  免费开源、可自托管的短链接与访问分析服务，运行在 Cloudflare Workers + D1 上。<br>
  按国家 / 地区分流 · 来源追踪 · 实时访问分析 · 免费额度内零成本运行
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ccvar/cligc_link"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020.svg" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/database-D1-F38020.svg" alt="Cloudflare D1">
</p>

---

## 功能

- **短链跳转**：自定义后缀或自动生成，支持停用、有效期、查询参数透传。
- **按国家 / 地区分流**：同一个短链接，不同国家的访客跳到不同落地页；未命中规则的走默认地址。香港、澳门、台湾可单独设置。
- **来源追踪**：自动记录 Referer；为每个投放渠道生成带 `?src=` 的链接，即使对方不发送 Referer 也能分清来源。同时支持 `utm_source` / `utm_campaign`。
- **访问分析**：访问趋势（含上一周期对比）、独立访客、今日访问、来源、国家 / 城市、设备 / 系统 / 浏览器、星期 × 小时热力图、实时访问流、规则命中统计，支持导出 CSV。
- **管理后台**：单页应用，支持深色模式和手机访问；签名 Cookie 会话，可选 Cloudflare Turnstile 人机验证防暴力破解；自动识别爬虫。
- **零运维**：无需服务器，表结构在首次请求时自动创建。

## 快速部署

### 方式一：一键部署

点击上方 **Deploy to Cloudflare** 按钮，按提示授权即可自动创建 Worker 和 D1 数据库。部署完成后，在 Cloudflare 控制台的 Worker 设置里添加两个密钥（见下方[配置](#配置)），然后访问 `https://你的域名/admin`。

### 方式二：命令行部署

需要 Node.js 18+ 和一个 Cloudflare 账号。

```bash
git clone https://github.com/ccvar/cligc_link.git
cd cligc_link
npm install

# 登录 Cloudflare
npx wrangler login

# 创建 D1 数据库，把输出的 database_id 填到 wrangler.toml
npx wrangler d1 create cligc-link

# 设置后台密码和会话密钥
npx wrangler secret put ADMIN_PASSWORD
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET

# 部署
npx wrangler deploy
```

部署后访问 `https://<worker 地址>/admin` 登录后台。

### 绑定自己的域名

域名需要托管在 Cloudflare。在 `wrangler.toml` 中添加：

```toml
routes = [
  { pattern = "go.example.com", custom_domain = true },
]
```

重新执行 `npx wrangler deploy` 即可。

## 配置

**变量**（写在 `wrangler.toml` 的 `[vars]` 中）：

| 名称 | 说明 |
| --- | --- |
| `HOME_URL` | 访问根路径 `/` 时跳转到的地址；留空则显示内置的产品首页 |
| `ADMIN_HOST` | 后台只允许通过这个域名访问；留空则任意域名的 `/admin` 都可访问 |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile 站点密钥；留空则登录不做人机验证 |

**密钥**（用 `npx wrangler secret put <名称>` 设置）：

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 后台登录密码 |
| `SESSION_SECRET` | 是 | 会话签名密钥，任意长随机字符串 |
| `TURNSTILE_SECRET` | 否 | Turnstile 服务端密钥，与 `TURNSTILE_SITEKEY` 配套 |

### 启用 Turnstile（推荐）

1. 在 Cloudflare 控制台 → Turnstile 创建一个组件，域名填你的短链域名。
2. 把站点密钥填到 `wrangler.toml` 的 `TURNSTILE_SITEKEY`。
3. `npx wrangler secret put TURNSTILE_SECRET` 填入服务端密钥，然后重新部署。

## 使用说明

### 跳转规则

每个短链可以先创建、后配置目标地址：

- **默认地址**：没有命中任何地区规则的访问跳到这里。留空时，这些访问会看到“链接暂不可用”页面。
- **地区规则**：按访问者所在国家 / 地区（Cloudflare 提供的 `request.cf.country`）跳到不同地址。同一个国家只能属于一条规则。

详情页的“如果访客来自 … 会跳到 …”可以检查任意国家的跳转结果。

### 来源统计

来源的判定优先级：`src` 参数 > `utm_source` > Referer 域名 > `(direct)`。很多网站和 App 不发送 Referer，建议投放时使用详情页“高级设置”里生成的带 `?src=` 的链接。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 按需修改本地密码
npm run dev                      # http://localhost:8787/admin
```

本地开发使用 Cloudflare 提供的 Turnstile 测试密钥，验证总会通过。

## 项目结构

```
src/index.js      Worker：跳转、访问记录、后台 API、自动建表
src/admin.html    管理后台（单文件，无构建步骤）
src/home.html     根路径产品首页
schema.sql        数据库表结构（首次请求时自动执行）
migrations/       旧版本数据库的升级脚本
wrangler.toml     Cloudflare 配置模板
```

## 免费额度

只使用 Workers 和 D1。Cloudflare 免费版每天 10 万次 Worker 请求、D1 每天 500 万行读取 / 10 万行写入、5 GB 存储，个人和小团队通常用不完。每次跳转会写入一条访问记录。

## 许可证

[MIT](LICENSE)
