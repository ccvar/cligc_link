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
- **打不开自动回退**：地区链接在访客网络中连不上时（如被拦截），自动改去默认地址，并统计回退次数。
- **定时报告**：日报 / 周报 / 月报按设定时间推送到 Telegram 或邮件（Resend / Cloudflare 邮件路由）。
- **来源追踪**：自动记录 Referer；可选的推广页追踪代码能识别访客来自哪个搜索引擎；为每个投放渠道生成带 `?src=` 的链接，即使对方不发送 Referer 也能分清来源。同时支持 `utm_source` / `utm_campaign`。
- **访问分析**：访问趋势（含上一周期对比）、独立访客、今日访问、来源、国家 / 城市、设备 / 系统 / 浏览器、星期 × 小时热力图、实时访问流、规则命中统计、真人 / 爬虫 / 可疑访问识别，支持导出 CSV。
- **管理后台**：单页应用，支持深色模式和手机访问；签名 Cookie 会话、TOTP 两步验证，可选 Cloudflare Turnstile 人机验证防暴力破解；自动识别爬虫。
- **零运维**：无需服务器，表结构在首次请求时自动创建。

## 快速部署

### 方式一：一键部署

点击上方 **Deploy to Cloudflare** 按钮，按提示授权即可自动创建 Worker 和 D1 数据库。部署完成后访问 `https://<worker 地址>/admin`，用默认密码 **`admin`** 登录，按提示设置新密码即可。

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

# 部署
npx wrangler deploy
```

部署后访问 `https://<worker 地址>/admin`，用默认密码 **`admin`** 登录。首次登录会要求设置新密码，设置前后台其他功能都不可用，设置后默认密码立即失效。

> 部署后请尽快登录并修改密码。也可以在部署前用 `npx wrangler secret put ADMIN_PASSWORD` 直接指定初始密码，这样就不会出现默认密码。

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
| `ADMIN_PASSWORD` | 否 | 初始后台密码。不设置时默认为 `admin`，首次登录强制修改 |
| `SESSION_SECRET` | 否 | 会话签名密钥。不设置时首次运行自动生成并保存在数据库中 |
| `TURNSTILE_SECRET` | 否 | Turnstile 服务端密钥，与 `TURNSTILE_SITEKEY` 配套 |

### 管理员密码

- 生效顺序：后台修改过的密码 > `ADMIN_PASSWORD` > 默认密码 `admin`。
- 在后台左下角“修改密码”可随时修改，新密码以 PBKDF2 加盐哈希保存在 D1 中；修改后其他设备的登录会自动失效。
- 忘记密码时，删除数据库中保存的密码即可恢复为 `ADMIN_PASSWORD`（未设置则恢复为默认密码 `admin`，登录后需重新设置）：

  ```bash
  npx wrangler d1 execute cligc-link --remote --command "DELETE FROM settings WHERE key = 'admin_password'"
  ```

### 启用 Turnstile（推荐）

1. 在 Cloudflare 控制台 → Turnstile 创建一个组件，域名填你的短链域名。
2. 把站点密钥填到 `wrangler.toml` 的 `TURNSTILE_SITEKEY`。
3. `npx wrangler secret put TURNSTILE_SECRET` 填入服务端密钥，然后重新部署。

### 两步验证（推荐开启）

在后台左下角“两步验证”中开启：输入当前密码，用验证器 App（Google Authenticator、Microsoft Authenticator、1Password 等）扫码，再输入一次 6 位动态码确认。开启后登录需要密码 + 动态码，即使密码泄露也无法登录后台、篡改跳转地址。

- 动态码连续输错 5 次锁定 15 分钟；每个动态码只能使用一次。
- 开启或关闭两步验证后，其他设备上的登录会自动失效。
- 手机丢失、无法获取动态码时，在你的 Cloudflare 账号下执行以下命令关闭两步验证，然后用密码登录并重新绑定：

  ```bash
  npx wrangler d1 execute cligc-link --remote --command "DELETE FROM settings WHERE key IN ('totp', 'mfa_fail')"
  ```

### 统计通知（日报 / 周报 / 月报）

在后台“通知”页面设置，支持推送到 **Telegram** 和 **邮件**，每个渠道都可以“发送测试”，也可以直接预览报告内容。

- **日报**：每天发送前一天的数据；**周报**：每周一发送上周（周一至周日）的数据；**月报**：每月 1 号发送上个月的数据。
- 报告包含访问次数、独立访客、与上一周期对比、新建短链数、热门短链、主要来源和国家 / 地区。
- 发送时间按后台设置的时区（跟随浏览器）选择整点；由 `wrangler.toml` 中的定时任务每小时检查一次，同一份报告不会重复发送。

**Telegram**：在 Telegram 找 @BotFather 发送 `/newbot` 创建机器人获得 Bot Token；给机器人发一条消息后，访问 `https://api.telegram.org/bot<Token>/getUpdates`，返回中的 `chat.id` 即 Chat ID（群组需先把机器人拉进群并在群里发言）。

**邮件**，二选一：

- **Resend**（推荐）：在 [resend.com](https://resend.com) 验证发件域名并创建 API Key，后台填写 Key、发件人和收件人即可，免费额度每月 3000 封。
- **Cloudflare 邮件路由**：不依赖第三方。先在域名上开通 Email Routing 并验证收件地址，然后在 `wrangler.toml` 中添加绑定并重新部署：

  ```toml
  [[send_email]]
  name = "EMAIL"
  ```

  发件人必须是已开通邮件路由的域名下的地址，收件人必须是已验证的地址。

Bot Token、API Key 保存在 D1 中，后台只显示末 4 位。

## 使用说明

### 跳转规则

每个短链可以先创建、后配置目标地址：

- **默认地址**：没有命中任何地区规则的访问跳到这里。留空时，这些访问会看到“链接暂不可用”页面。
- **地区规则**：按访问者所在国家 / 地区（Cloudflare 提供的 `request.cf.country`）跳到不同地址。同一个国家只能属于一条规则。

详情页的“如果访客来自 … 会跳到 …”可以检查任意国家的跳转结果。

### 来源统计

来源的判定优先级：`src` 参数 > `utm_source` > Referer 域名 > `(direct)`。

**推荐用 `?src=` 区分渠道。** 在详情页“高级设置 · 按站点生成投放链接”里输入站点名，会为每个渠道生成形如 `https://go.example.com/spring?src=zhihu` 的链接。`src` 写在链接本身里，不受对方网站或 App 的任何设置影响，是最可靠的来源标记。

**放到网页上时，不要给链接加 `rel="noreferrer"`。** Referer 是浏览器在跳转时告诉短链“访客从哪个网站来”的请求头，链接加了 `noreferrer` 就不会发送，Referer 统计会记成直接访问。推荐写法（每条投放链接旁的 `<>` 按钮可一键复制）：

```html
<a href="https://go.example.com/spring?src=zhihu" target="_blank" rel="noopener">活动详情</a>
```

`rel="noopener"` 防止新打开的页面操控原页面，可以保留；只是不要再加 `noreferrer`。

即使不加 `noreferrer`，以下情况浏览器也不会发送 Referer，统计会记为 `(direct)`：

- 对方页面或整站设置了 `referrerpolicy="no-referrer"` / `Referrer-Policy: no-referrer`；
- 在微信、QQ、微博等 App 内打开，或从邮件客户端、文档中点击；
- 从 https 页面跳到 http 页面。

另外，出于隐私保护，浏览器跨站跳转时默认只发送来源网站的域名（如 `www.zhihu.com`），不包含具体页面路径。所以 Referer 适合看“来自哪个网站”，要区分同一网站上的不同投放位置，请使用不同的 `src`，例如 `?src=zhihu-answer`、`?src=zhihu-column`。

### 来源追踪（可选）

访客先从搜索引擎进入你的推广页，再点页面上的短链时，短链只能看到“来自推广页”。在后台“设置 → 来源追踪”开启后，把代码放到推广页上，它会识别访客来自哪个搜索引擎（Google、Bing、百度、搜狗、360、神马等）或广告点击（`gclid` / `msclkid`），并给指向短链的链接加上 `utm_source`：

```html
<script src="https://go.example.com/t.js" async></script>
```

- 只处理指向短链域名的链接；链接上已有的 `src`、`utm_source` 不会被改动。
- 记住访客首次进入时的来源（sessionStorage），在站内翻页后再点短链也不会丢。
- 在短链详情页“来源 · utm_source”查看；链接没有 `src` 时，`utm_source` 也会直接计入“来源”。
- 也可以在后台复制完整代码直接粘贴到页面里。关闭开关后 `/t.js` 不再生效，已粘贴的完整代码不受影响。
- 搜索引擎都不再传递搜索关键词，因此只能知道是哪个搜索引擎，看不到具体关键词。

### 真人 / 机器访问识别

每次访问都会被标记为 **真人**、**爬虫** 或 **可疑**，并记录判定原因：

- **爬虫**：User-Agent 自报身份，如 Googlebot、百度蜘蛛、微信 / Telegram 链接预览、curl、Python 脚本。
- **可疑**：命中任一强信号——机房 IP（按 ASN 和运营商名称识别 AWS、Google Cloud、Azure、阿里云、腾讯云、华为云、火山引擎、DigitalOcean、Hetzner 等云厂商；微信等 App 的链接安全检测通常来自这些机房）、没有 Accept-Language、同一 IP 1 分钟内访问同一短链 5 次以上、TLS 1.0/1.1；或同时命中两个弱信号——自称新版 Chrome / Firefox 却缺少 `Sec-Fetch-*` 请求头、使用 HTTP/1.x、自称很旧的系统或浏览器版本（如 iOS 13、Chrome 100 以下）。
- Cloudflare 和 Akamai 的 IP 不算机房：iCloud 私密中继和 WARP 的真人用户也走它们。

后台顶部“含机器访问”关闭时，统计和报告只算真人；概览显示真人占比，短链详情页“设备 · 访客类型”显示构成和原因，访问明细里爬虫 / 可疑访问带标签（鼠标停留查看原因）。升级后会按已有的 IP、运营商、User-Agent 自动补算旧记录。

这是基于网络特征的推断：通过住宅代理或手机网络运行的自动化脚本可能被判为真人；Cloudflare 的机器人评分（Bot Management）仅企业版提供，这里没有使用。

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
