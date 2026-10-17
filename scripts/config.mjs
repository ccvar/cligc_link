// 升级时保留用户自己的 wrangler.toml 配置：从旧文件里取出 Worker 名称、域名、D1 数据库、[vars] 和邮件绑定，
// 再填进新版本的 wrangler.toml 模板里（模板里的注释和新增的配置都保留）。
// 只认这几项；其他手改的内容不会保留，升级脚本会提示。

const unq = (v) => v.replace(/^"|"$/g, '');

// 取出某个 [section] / [[section]] 的正文（到下一个节标题为止）
function section(text, head) {
  const i = text.search(new RegExp(`^\\[{1,2}${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]{1,2}\\s*$`, 'm'));
  if (i < 0) return '';
  const rest = text.slice(i).split('\n').slice(1).join('\n');
  const j = rest.search(/^\[/m);
  return j < 0 ? rest : rest.slice(0, j);
}
// 顶层（第一个节标题之前）
const top = (text) => { const j = text.search(/^\[/m); return j < 0 ? text : text.slice(0, j); };

export function extractConfig(text) {
  const t = top(text);
  const out = { vars: {} };
  const name = /^name\s*=\s*("[^"]*")/m.exec(t);
  if (name) out.name = unq(name[1]);
  // routes：单行或多行数组，原样保留（注释掉的不算）
  const routes = /^routes\s*=\s*\[.*\]\s*$|^routes\s*=\s*\[[\s\S]*?^\s*\]/m.exec(t);
  if (routes) out.routes = routes[0].trim();
  const d1 = section(text, 'd1_databases');
  const dn = /^database_name\s*=\s*("[^"]*")/m.exec(d1), di = /^database_id\s*=\s*("[^"]*")/m.exec(d1);
  if (dn) out.databaseName = unq(dn[1]);
  if (di) out.databaseId = unq(di[1]);
  for (const m of section(text, 'vars').matchAll(/^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/gm)) out.vars[m[1]] = m[2];
  const se = /^\[\[send_email\]\]\s*\n\s*name\s*=\s*("[^"]*")/m.exec(text);
  if (se) out.sendEmail = unq(se[1]);
  return out;
}

export function applyConfig(template, c) {
  let t = template;
  if (c.name) t = t.replace(/^name\s*=\s*"[^"]*"/m, `name = "${c.name}"`);
  if (c.routes && !/^routes\s*=/m.test(top(t))) {
    // 放在模板里注释掉的 routes 示例后面；没有示例就放在 compatibility_date 后面
    const ex = /^# routes = \[[\s\S]*?^# \]\s*$/m.exec(t);
    if (ex) t = t.slice(0, ex.index + ex[0].length) + '\n' + c.routes + t.slice(ex.index + ex[0].length);
    else t = t.replace(/^(compatibility_date\s*=.*)$/m, `$1\n\n${c.routes}`);
  }
  if (c.sendEmail && !/^\[\[send_email\]\]/m.test(t)) {
    t = /^# \[\[send_email\]\]\s*\n# name = "[^"]*"/m.test(t)
      ? t.replace(/^# \[\[send_email\]\]\s*\n# name = "[^"]*"/m, `[[send_email]]\nname = "${c.sendEmail}"`)
      : `${t.trimEnd()}\n\n[[send_email]]\nname = "${c.sendEmail}"\n`;
  }
  for (const [k, v] of Object.entries(c.vars || {})) {
    const re = new RegExp(`^${k}\\s*=.*$`, 'm');
    if (re.test(section(t, 'vars'))) {
      // 只替换 [vars] 里的那一行
      const vs = section(t, 'vars'), i = t.indexOf(vs);
      t = t.slice(0, i) + vs.replace(re, `${k} = ${v}`) + t.slice(i + vs.length);
    } else if (/^\[vars\]\s*$/m.test(t)) {
      t = t.replace(/^\[vars\]\s*$/m, `[vars]\n${k} = ${v}`);
    }
  }
  if (c.databaseName) t = t.replace(/^database_name\s*=\s*"[^"]*"/m, `database_name = "${c.databaseName}"`);
  if (c.databaseId) t = t.replace(/^database_id\s*=\s*"[^"]*"/m, `database_id = "${c.databaseId}"`);
  return t;
}
