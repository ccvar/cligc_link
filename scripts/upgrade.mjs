#!/usr/bin/env node
// 升级到上游最新发布的版本（vX.Y.Z 标签），保留自己的 wrangler.toml 配置。
//
//   npm run upgrade             命令行部署：拉取新版本 → 安装依赖 → 部署（部署前会确认）
//   npm run upgrade -- --yes    不确认，直接部署
//   npm run upgrade -- --to v1.2.0   升级到指定版本
//   npm run upgrade -- --no-deploy   只更新代码，不部署（自己检查后再 npx wrangler deploy）
//   node scripts/upgrade.mjs --ci    GitHub Actions 里用：拉取新版本 → 提交并推送（Cloudflare 会自动重新部署）
//
// 数据库不用手动迁移：新版本第一次运行时会自动补表、补列。
// 出问题时可以用 `npx wrangler rollback` 回到上一次部署的代码。

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { extractConfig, applyConfig } from './config.mjs';

// 上游仓库（测试时可以用环境变量 CLIGC_UPSTREAM 换成别的地址）
const UPSTREAM = process.env.CLIGC_UPSTREAM || 'https://github.com/ccvar/cligc_link.git';
const args = process.argv.slice(2);
const CI = args.includes('--ci'), YES = args.includes('--yes') || CI;
const TO = args.includes('--to') ? args[args.indexOf('--to') + 1] : '';
const NO_DEPLOY = args.includes('--no-deploy');

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: opts.show ? 'inherit' : ['ignore', 'pipe', 'pipe'], ...opts })?.toString().trim();
const ok = (cmd) => { try { sh(cmd); return true; } catch { return false; } };
const log = (m) => console.log(m);
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const ver = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0);
const gt = (a, b) => { const [x, y] = [ver(a), ver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

if (!ok('git rev-parse --is-inside-work-tree')) die('请在项目目录（git 仓库）里运行');

// 上游仓库：已有指向 ccvar/cligc_link 的远程就用它，否则添加一个叫 upstream 的远程
const remotes = sh('git remote -v').split('\n').map((l) => l.split(/\s+/)).filter((p) => p[2] === '(fetch)');
let remote = remotes.find(([, url]) => url === UPSTREAM || (!process.env.CLIGC_UPSTREAM && /ccvar\/cligc_link(\.git)?$/i.test(url)))?.[0];
if (!remote) { sh(`git remote add upstream ${UPSTREAM}`); remote = 'upstream'; }
log(`→ 从 ${remote} 获取新版本…`);
// 不加 --force：不覆盖你自己打的同名标签（有冲突时只给提示）
if (!ok(`git fetch ${remote} --tags`)) log('  （部分标签和本地的同名标签冲突，已跳过；不影响升级）');

const tags = sh("git tag -l 'v*'").split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
const latest = TO || tags.sort((a, b) => (gt(a, b) ? -1 : gt(b, a) ? 1 : 0))[0];
if (!latest) die('上游还没有发布版本');
if (!tags.includes(latest)) die(`没有找到版本 ${latest}`);
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!gt(latest, current) && !TO) { log(`✓ 已是最新版本 v${current}`); process.exit(0); }
log(`→ 升级 v${current} → ${latest}`);

// 未提交的修改（wrangler.toml 除外）会被覆盖，先让用户处理
const dirty = sh('git status --porcelain').split('\n').filter((l) => l && !/\swrangler\.toml$/.test(l));
if (dirty.length && !CI) die(`有未提交的修改，请先提交或暂存（git stash）：\n${dirty.join('\n')}`);

// 记下自己的配置
const mine = existsSync('wrangler.toml') ? extractConfig(readFileSync('wrangler.toml', 'utf8')) : null;

if (ok(`git merge-base --is-ancestor HEAD ${latest}`)) {
  // 直接从上游克隆的：快进到新版本
  sh('git checkout -- wrangler.toml');
  sh(`git merge --ff-only ${latest}`, { show: true });
} else {
  // 一键部署生成的仓库（和上游没有共同历史）或自己改过代码的：用新版本的文件覆盖
  sh(`git checkout ${latest} -- .`);
  // 新版本里删掉的文件也删掉（只删上游删的，自己加的文件不动）
  const from = `v${current}`;
  if (tags.includes(from)) {
    for (const f of sh(`git diff --name-only --diff-filter=D ${from} ${latest}`).split('\n').filter(Boolean)) {
      if (f !== 'wrangler.toml' && !f.startsWith('.github/')) ok(`git rm -q --ignore-unmatch -- "${f}"`);
    }
  }
  // GitHub Actions 的令牌不能修改工作流文件：.github 保持原样（包括上游新增的工作流文件也不带进来）
  if (CI) {
    ok('git reset -q HEAD -- .github');
    if (ok('git cat-file -e HEAD:.github')) ok('git checkout HEAD -- .github');
    ok('git clean -fdq -- .github');
  }
}

// 把自己的配置填回新版本的 wrangler.toml
if (mine) {
  writeFileSync('wrangler.toml', applyConfig(readFileSync('wrangler.toml', 'utf8'), mine));
  log(`→ 已保留配置：Worker ${mine.name || '—'} · 数据库 ${mine.databaseId ? `${mine.databaseId.slice(0, 8)}…` : '—'}${mine.routes ? ' · 自定义域名' : ''}${Object.values(mine.vars).some((v) => v !== '""') ? ' · [vars]' : ''}`);
  log('  （只保留 Worker 名称、域名、D1 数据库、[vars] 和邮件绑定；其他手改的 wrangler.toml 内容请对照 git diff 检查）');
}

if (CI) {
  sh('git add -A');
  if (ok('git diff --cached --quiet')) { log('✓ 没有需要提交的变化'); process.exit(0); }
  sh(`git commit -q -m "升级到 ${latest}"`);
  sh('git push', { show: true });
  log(`✓ 已升级到 ${latest} 并推送，Cloudflare 会自动重新部署`);
  process.exit(0);
}

// 命令行：不是快进的（覆盖了文件）也提交一次，方便以后再升级
// wrangler.toml 里有你的数据库 ID 和域名，不提交（仓库公开时会泄露）
if (!ok('git diff --quiet HEAD -- . ":(exclude)wrangler.toml"')) { sh('git add -A -- . ":(exclude)wrangler.toml"'); ok(`git commit -q -m "升级到 ${latest}"`); }
log('→ 安装依赖…');
if (NO_DEPLOY) { sh('npm install --no-audit --no-fund', { show: true }); log(`\n✓ 代码已更新到 ${latest}，还没部署；检查后执行 npx wrangler deploy`); process.exit(0); }
sh('npm install --no-audit --no-fund', { show: true });
if (!YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`现在部署 ${latest} 吗？[Y/n] `)).trim().toLowerCase();
  rl.close();
  if (a && a !== 'y' && a !== 'yes') { log('已取消部署；之后执行 npx wrangler deploy 即可'); process.exit(0); }
}
sh('npx wrangler deploy', { show: true });
log(`\n✓ 已升级到 ${latest}。更新内容：https://github.com/ccvar/cligc_link/releases/tag/${latest}`);
