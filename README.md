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

- **短链跳转**：自定义后缀或自动生成，支持停用、有效期、查询参数透传；可按原始链接批量替换目标地址。
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
| `CF_ACCOUNT_ID` | Cloudflare 账号 ID，用于后台“Cloudflare 用量”；需配合 `CF_API_TOKEN`。也可以不设置，直接在后台填写 |
| `GOOGLE_CLIENT_ID` | Google OAuth 客户端 ID，用于“站点”；需配合 `GOOGLE_CLIENT_SECRET`。也可以不设置，直接在后台填写 |

**密钥**（用 `npx wrangler secret put <名称>` 设置）：

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 否 | 初始后台密码。不设置时默认为 `admin`，首次登录强制修改 |
| `SESSION_SECRET` | 建议 | 会话签名密钥，也用于加密保存在数据库里的令牌和客户端密钥。不设置时首次运行自动生成并保存在数据库中（这时数据库被导出或泄露，加密的内容也能被解开）；更换后需要在后台重新填写客户端信息、重新连接 Google |
| `TURNSTILE_SECRET` | 否 | Turnstile 服务端密钥，与 `TURNSTILE_SITEKEY` 配套 |
| `CF_API_TOKEN` | 否 | 只读 API 令牌（Account Analytics: Read），用于后台“Cloudflare 用量”；也可以在后台填写 |
| `GOOGLE_CLIENT_SECRET` | 否 | Google OAuth 客户端密钥；也可以在后台填写 |

### 管理员密码

- 生效顺序：后台修改过的密码 > `ADMIN_PASSWORD` > 默认密码 `admin`。
- 在后台左下角“修改密码”可随时修改，新密码以 PBKDF2 加盐哈希保存在 D1 中；修改后其他设备的登录会自动失效。
- 忘记密码时，删除数据库中保存的密码即可恢复为 `ADMIN_PASSWORD`（未设置则恢复为默认密码 `admin`，登录后需重新设置）：

  ```bash
  npx wrangler d1 execute cligc-link --remote --command "DELETE FROM settings WHERE key = 'admin_password'"
  ```

### 登录防暴力破解

- 同一 IP 连续输错 5 次密码会被锁定，锁定时长从 15 分钟起逐次加倍，最长 24 小时；登录成功后清零。
- 密码以 PBKDF2（10 万次迭代）加盐哈希保存，每次输错还会延迟 0.8 秒响应。
- 配置 Turnstile 后，人机验证在核对密码之前进行，自动化脚本无法批量尝试。
- 开启两步验证后，即使密码泄露也无法登录；动态码连续输错 5 次锁定 15 分钟。
- 自己被锁定时，可以等待解锁，或执行 `npx wrangler d1 execute cligc-link --remote --command "DELETE FROM login_guard"` 立即解除。

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

### 批量替换目标地址

推广地址变了（换域名、换推广码）时，在“短链”页右上角点“批量替换”：

- **完全匹配**：地址与原始链接完全一致时，整条换成新链接。
- **包含替换**：只把地址中出现的这一段换掉，其余部分不变，如 `ref=OLD` → `ref=NEW`、`old.example.com` → `new.example.com`。

短链的默认地址和地区规则的地址都会处理。执行前会列出每一处“原地址 → 新地址”，并汇总涉及的默认地址、地区规则和短链数量；替换后的地址必须是合法的 http / https 地址，确认后才会修改，立即生效。

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
- **可疑**：满足下面任一条——
  - 命中一个强信号：没有 Accept-Language、同一 IP 1 分钟内访问同一短链 5 次以上、TLS 1.0 / 1.1；
  - 同时命中两个弱信号：自称新版 Chrome / Firefox 却缺少 `Sec-Fetch-*` 请求头、使用 HTTP/1.x、自称很旧的系统或浏览器版本（如 iOS 13、Chrome 100 以下）；
  - 来自机房 IP，并且带有上面任一机器特征。微信等 App 的链接安全检测、各类监控和爬虫通常属于这一类。
- **真人**：其余访问。

后台顶部“含机器访问”关闭时，统计、实时访问和定时报告都只算真人。概览的“真人占比”、短链详情页“设备 · 访客类型”显示构成和原因；实时访问和访问明细里，爬虫 / 可疑 / 经代理的访问带标签，鼠标停留查看原因。升级后会按已有的 IP、运营商、User-Agent 自动重新判定旧记录。

#### 机房 IP 的识别

按 ASN 编号识别常见云厂商（腾讯云、阿里云、华为云、火山引擎、百度云、AWS、Google Cloud、Azure、DigitalOcean、Vultr、Hetzner、OVH、Contabo 等），并按运营商名称补充识别其他机房和托管商。有些云厂商用公司地址登记 IP（如腾讯云新加坡登记为“6 COLLYER QUAY”），只看名称会漏掉，所以以 ASN 为准。

Cloudflare 和 Akamai 的 IP 不算机房：iCloud 私密中继和 Cloudflare WARP 的真人用户也走它们。

#### VPN / 代理识别

VPN 和“机场”节点大多架在机房里，所以“来自机房 IP”本身不能说明是机器。经代理访问的真人会被单独标出，仍计入真人：

| 情况 | 判定 | 标签 |
| --- | --- | --- |
| 机房 IP，浏览器特征完整（HTTP/2 或 HTTP/3、请求头齐全、系统和浏览器版本不旧） | 真人 | 代理 · 经 VPN / 代理 |
| 机房 IP，并带有任一机器特征（如 HTTP/1.1、缺少请求头、iOS 13 之类的旧版本） | 可疑 | 可疑 |
| 中文访客（Accept-Language 为 zh）出现在中国大陆、港澳台、新加坡、马来西亚以外的地区 | 真人 | 代理 · 可能经 VPN / 代理（仅提示） |

概览的“真人占比”旁会显示其中经代理的次数，短链详情页“访客类型”显示经代理的真人占比，导出的 CSV 中 `proxy` 列为 1 表示经代理。

升级前的旧记录没有保存连接协议，无法判断浏览器特征是否完整，来自机房 IP 的旧记录仍按可疑处理；之后的新访问都会正常区分。

#### 局限

这些都是基于网络特征的推断：住宅代理、手机热点、企业网关的 IP 和普通宽带一样，无法识别为代理；通过它们运行的自动化脚本也可能被判为真人。Cloudflare 的机器人评分（Bot Management）仅企业版提供，这里没有使用。识别结果只用于统计，不会改变任何访客的跳转结果。

### 数据保留与统计汇总

每次访问都会记录一条明细。统计页面（7 天及以上的范围）不再每次扫描全部明细，而是读按小时 / 按天汇总的数据，大幅减少 D1 的读取量（免费版每天 500 万行）；最近不到一小时的访问直接读明细，统计始终实时。24 小时范围仍直接读明细。

- 汇总表：`agg_h`（每小时访问次数）、`agg_d`（每天各维度的访问次数：来源、国家、城市、设备、浏览器、系统、规则命中、访客类型等）、`agg_uv`（每天的独立访客，用 HyperLogLog 估算，误差约 4%）。
- 汇总在统计请求和每小时的定时任务里增量进行，无需手动操作；访客类型规则调整后会自动按保留的明细重建。
- 在后台“设置 → 数据保留”可以选择访问明细保留 60 / 90 / 180 / 365 天或永久（默认永久）。超过期限的明细由定时任务每小时清理；趋势、来源、地区等统计读汇总数据，不受影响。访问明细列表、导出 CSV 和定时报告只包含仍保留的明细。

### 站点：GA4 与 Search Console

后台“站点”页连接 Google 账号后，会列出账号下所有的 GA4 媒体资源和 Search Console 站点（按域名自动配对），显示用户、会话、关键事件、搜索点击、展示、点击率、平均排名及趋势；站点详情页有每日趋势、搜索词 / 页面 / 国家 / 设备排行、GA4 来源 / 媒介 / 页面排行和实时在线人数。只申请只读权限。

配置（每个部署需要自己的 OAuth 客户端）：

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 新建项目，启用 **Google Analytics Admin API**、**Google Analytics Data API**、**Google Search Console API**。
2. “OAuth 权限请求页面”：用户类型选“外部”，填写应用名称和邮箱，然后点 **发布应用**。未发布（测试状态）的应用授权 7 天后失效；个人使用无需 Google 审核，授权时出现“此应用未经验证”点“继续”即可。
3. “凭据 → 创建凭据 → OAuth 客户端 ID”，类型选 **Web 应用**，已获授权的重定向 URI 填 `https://<你的域名>/api/google/callback`。
4. 打开后台“设置 → Google 集成”，填写客户端 ID 和客户端密钥并保存（密钥加密保存在 D1，之后只显示末 4 位）。
5. 到“站点”页点“连接 Google 账号”完成授权。

也可以用环境变量配置：在 `wrangler.toml` 填写 `GOOGLE_CLIENT_ID`，执行 `npx wrangler secret put GOOGLE_CLIENT_SECRET`，重新部署。环境变量优先，此时后台只读显示。客户端可以在“设置 → Google 集成”里修改或删除；更换客户端 ID 会断开所有已连接的账号。

列表上方汇总当前筛选的站点数（及增长 / 下降的站点数）、用户、会话、关键事件、搜索点击和短链点击，表格里有每个站点的会话（或搜索点击）占比。

**与短链打通**（两个方向）：
- **站点上的推广短链**（主要）：按短链访问的来源匹配站点——`?src=` / `utm_source` 优先，其次 Referer 域名；来源是域名时按域名（含子域名、忽略 www.）匹配，是不带点的名字（如 `?src=gaterar`）时与站点主名称相同才算。站点列表、汇总卡片和站点详情页显示从站点点出的短链真人点击和**点出率**（短链点击 ÷ 会话）；短链详情页的“来源站点”列出这个短链从哪些站点被点进来。
- **跳转到这个站点的短链**：按短链的跳转地址（默认地址和每条地区规则）的域名匹配站点，在站点详情页和短链详情页的“目标站点”显示。
- 站点列表可以按短链筛选（两个方向都算）。

可以连接多个 Google 账号：在“站点”页右上角点“添加账号”，授权时选择另一个账号即可；已连接的账号在“设置 → Google 集成”里查看、断开或重新连接。所有账号的站点按域名合并显示（同一个域名可以 GA4 来自一个账号、Search Console 来自另一个账号；多个账号都能看到同一个站点时用最早连接的账号），列表可以按账号筛选。每个账号可以单独断开，只来自这个账号的站点和数据会删除；某个账号授权失效时只影响它自己，点“重新连接”即可。

刷新令牌用会话密钥加密后保存在 D1。每日数据由定时任务每小时分批同步（每个站点最多 6 小时同步一次，首次回填 16 个月，即 Search Console 保留数据的上限）；详情页的排行和实时在线人数打开时现查，缓存 1 小时。时间范围可选最近 7 / 14 / 28 天、3 / 6 / 12 个月，截至昨天，和上一周期对比（12 个月不做对比）；Search Console 数据通常延迟 2–3 天。

### AI 分析链接

在“站点”页（或站点详情页）右上角点“AI 分析”，选择站点（一个或多个，最多 100 个；超过 30 个时报告自动使用精简格式，每个站点只保留核心指标和搜索机会）、时间范围（28 天 / 3 个月 / 6 个月）和包含的内容，生成一个只读链接，发给 ChatGPT、Claude 等 AI，让它分析这些站点的 SEO。

- 链接返回给 AI 读的 Markdown 报告（`?format=json` 为结构化数据，`?download=1` 下载文件）：概览、站点对比、核心指标与环比、趋势、搜索词 / 页面、国家 / 设备，以及预先算好的**机会**——排名 4–20 的高展示词、点击率明显低于该排名常见水平的词、点击下滑的词和页面、新出现的词；GA4 的渠道、来源 / 媒介、着陆页和互动率；跳转到这些站点的短链。
- 生成后可以一键复制“给 AI 的提示词”（已带上链接）。有些 AI 不能打开链接，可以下载 Markdown 文件后上传。
- 安全：链接用 128 位随机 token，只读、只包含选中的站点；默认 7 天后过期（可选 30 天 / 永久），默认隐藏 Google 账号邮箱、GA4 媒体资源 ID 和 Search Console 资源名；每个链接每小时最多打开 60 次；响应带 `X-Robots-Tag: noindex`，不会被搜索引擎收录（`robots.txt` 允许抓取 `/r/`，否则 AI 工具打不开）。
- 报告缓存 1 小时，创建链接后会先在后台生成一次，AI 第一次打开就很快。
- 在“设置 → AI 分析链接”查看所有链接的打开次数，可随时撤销。

### Cloudflare 用量

后台“设置 → Cloudflare 用量”显示整个账户的 D1 读写行数、Worker 请求数和 D1 存储，并单独列出本项目的用量（`D1_DATABASE_ID`、`WORKER_NAME`）。免费版对比每天的额度（UTC 0 点重置），付费版对比本月累计与每月包含额度；套餐可自动识别，也可在面板里手动指定。需要：

1. 在 Cloudflare 控制台创建自定义 API 令牌，权限 **账户 · Account Analytics · 读取**（可选 **账户 · 账单 · 读取**，用于显示是否为付费版）。
2. 在面板里填写账户 ID 和令牌（可选填 D1 数据库 ID、Worker 名称，用于单独显示本项目用量），点“验证并保存”。保存前会先请求一次 Cloudflare 接口确认令牌有效；令牌加密保存在 D1，之后只显示末 4 位。

也可以用环境变量：`npx wrangler secret put CF_API_TOKEN`，并在 `wrangler.toml` 的 `[vars]` 里填写 `CF_ACCOUNT_ID`（以及 `D1_DATABASE_ID`、`WORKER_NAME`），重新部署。环境变量优先，此时面板只读显示。

面板会按目前速度推算到期末的用量（付费版按最近 7 天日均推算到月底，免费版推算到今天结束），显示是否够用、预计哪天用完包含额度。

**用量预警**：在“通知”页开启“Cloudflare 用量预警”，选择阈值（已用 70% / 80% / 90%）。定时任务每小时检查一次，已用达到阈值、已超出包含额度，或按目前速度到期末会超出时，推送到已开启的 Telegram / 邮件渠道；同一计费周期里每项指标的每种情况只提醒一次。

结果缓存 5 分钟，可手动刷新。

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
