// 定时任务的外部请求预算：Workers 每次调用最多发约 1000 个子请求，超了会直接报错。
// runCron 开始时设上限，各处发请求前调用 spend()；用完时抛出带 budget 标记的错误，调用方据此停下（不当作普通错误写进数据库）。
export const subreq = { left: Infinity };
export function spend(n = 1) {
  if (subreq.left < n) throw Object.assign(new Error('本次定时任务的外部请求数已到上限，剩下的下次再做'), { budget: true });
  subreq.left -= n;
}
