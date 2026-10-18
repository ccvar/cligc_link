// 界面翻译（浏览器端）：把页面上的中文界面文字换成词典里的英文。
// 只按“整段文字”或“带占位符的模板”匹配，匹配不到的保持原样，所以用户自己填的标题、备注、搜索词不会被改动。
// 这个函数会被 toString() 后发给浏览器执行，不能引用外部变量。
export function installI18n(dict) {
  const CJK = /[　-〿一-鿿＀-￯]/;
  const exact = new Map();
  const pats = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [k, v] of Object.entries(dict)) {
    // 匹配前会把原文里的空白（含换行）合并成一个空格，词条也按同样方式处理才对得上；译文保留原来的换行
    const nk = k.replace(/\s+/g, ' ').trim();
    if (!k.includes('{}')) { exact.set(k, v); if (nk !== k) exact.set(nk, v); continue; }
    const parts = nk.split('{}');
    pats.push({ re: new RegExp('^' + parts.map(esc).join('([\\s\\S]+?)') + '$'), v, w: parts.join('').length, ml: k.includes('\n') });
  }
  pats.sort((a, b) => b.w - a.w);
  // 占位符：{} 按顺序，{0}{1} 按位置
  const fill = (v, groups) => {
    let i = 0;
    return v.replace(/\{(\d*)\}/g, (_, n) => { const g = groups[n === '' ? i++ : Number(n)]; return g === undefined ? '' : tr(g); });
  };
  const SEP = /(\s*(?:·|、|，|：|；|（|）|\n|\s\/\s|→|——)\s*)/;
  const SEPMAP = { '、': ', ', '，': ', ', '：': ': ', '；': '; ', '（': ' (', '）': ')', '——': ' — ' };
  const SING = { addresses: 'address', 'split addresses': 'split address', 'redirect rules': 'redirect rule', 'target URLs': 'target URL', 'default URLs': 'default URL', 'human clicks': 'human click', 'visit records': 'visit record', 'unique visitors': 'unique visitor', 'other devices': 'other device', 'extra variants': 'extra variant', 'active links': 'active link', 'backup websites': 'backup website', 'countries / regions': 'country / region' };
  const ONE = /(^|[^\d.,])1 (split addresses|redirect rules|target URLs|default URLs|human clicks|visit records|unique visitors|other devices|extra variants|active links|backup websites|countries \/ regions|addresses|rules|visits|links|sites|devices|accounts|visitors|days|hours|records|times|variants|steps|items|places|subscriptions|minutes|seconds)\b/g;
  const cache = new Map();
  function tr(text) {
    if (!text || !CJK.test(text)) return text;
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const lead = text.match(/^\s*/)[0], tail = text.match(/\s*$/)[0];
    const s = text.replace(/\s+/g, ' ').trim();
    let out = exact.get(text.trim()) ?? exact.get(s);
    // 多行文字（浮动提示常见）：整段对不上时先逐行翻译（不然“xx {}”这种模式会把后面几行都吞进去），保留换行
    if (out === undefined && text.trim().includes('\n')) {
      // 本身就是多行的模板词条先整段匹配
      for (const p of pats) {
        if (!p.ml) continue;
        const m = s.match(p.re);
        if (m) { out = fill(p.v, m.slice(1)); break; }
      }
    }
    if (out === undefined && text.trim().includes('\n')) {
      const lines = text.trim().split('\n'), done = lines.map((l) => tr(l));
      if (done.some((x, i) => x !== lines[i])) out = done.join('\n');
    }
    if (out === undefined) {
      for (const p of pats) {
        const m = s.match(p.re);
        if (m) { out = fill(p.v, m.slice(1)); break; }
      }
    }
    // 拼接出来的文字（如“透传参数 · 转化追踪”）：按分隔符拆开，逐段整段匹配
    if (out === undefined && SEP.test(s)) {
      const segs = s.split(SEP);
      if (segs.length > 1) {
        const done = segs.map((x, i) => (i % 2 ? (SEPMAP[x.trim()] ?? x) : tr(x)));
        if (done.some((x, i) => !(i % 2) && x !== segs[i])) out = done.join('').replace(/\s+([,;:)])/g, '$1').replace(/\(\s+/g, '(');
      }
    }
    if (out === undefined) out = s;
    // 英文单复数：“1 rules” → “1 rule”
    else out = out.replace(ONE, (m, pre, w) => pre + '1 ' + (SING[w] || w.replace(/s$/, '')));
    out = lead + out + tail;
    if (cache.size > 5000) cache.clear();
    cache.set(text, out);
    return out;
  }
  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip', 'data-tipf', 'alt', 'content'];
  // 文字跳过代码、输入框内容；属性（如占位提示）只跳过脚本和标了不翻译的
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
  const skip = (el) => !el || SKIP.has(el.nodeName) || !!el.closest?.('[translate="no"], .notranslate');
  const skipAttr = (el) => !el || el.nodeName === 'SCRIPT' || el.nodeName === 'STYLE' || !!el.closest?.('[translate="no"], .notranslate');
  const doneText = new WeakMap();
  const textNode = (n) => {
    if (doneText.get(n) === n.data || skip(n.parentElement)) return;
    const t = tr(n.data);
    if (t !== n.data) n.data = t;
    doneText.set(n, n.data);
  };
  const attr = (el, a) => {
    const v = el.getAttribute(a);
    if (!v || !CJK.test(v) || (a === 'content' && el.nodeName !== 'META')) return;
    if (el.nodeName === 'INPUT' && a === 'value') return;
    const t = tr(v);
    if (t !== v) el.setAttribute(a, t);
  };
  const walk = (root) => {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1 || skipAttr(root)) return;
    for (const a of ATTRS) if (root.hasAttribute(a)) attr(root, a);
    if (skip(root)) return;
    if (root.nodeName === 'INPUT' && (root.type === 'button' || root.type === 'submit') && CJK.test(root.value)) root.value = tr(root.value);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) textNode(n);
      else if (!skipAttr(n)) for (const a of ATTRS) if (n.hasAttribute(a)) attr(n, a);
    }
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(walk);
      else if (m.type === 'characterData') textNode(m.target);
      else if (m.type === 'attributes' && !skipAttr(m.target)) attr(m.target, m.attributeName);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // 标题
  let lastTitle = '';
  const fixTitle = () => { if (document.title !== lastTitle) { document.title = tr(document.title); lastTitle = document.title; } };
  new MutationObserver(fixTitle).observe(document.querySelector('title') || document.head, { childList: true, characterData: true, subtree: true });
  document.documentElement.lang = 'en';
  window.T = tr;
  if (document.body) walk(document.body);
  fixTitle();
  // 原生对话框
  const ac = window.alert, cf = window.confirm;
  window.alert = (m) => ac(tr(String(m)));
  window.confirm = (m) => cf(tr(String(m)));
}
