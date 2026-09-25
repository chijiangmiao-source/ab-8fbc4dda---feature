/**
 * 求解 Worker：主线程仅做录入与渲染，最小割计算在后台进行，
 * 不阻塞页面交互。
 *
 * 协议（主线程 → Worker）：
 *   { type: 'solve',  id, input }  发起/替换一次复核
 *   { type: 'cancel', id, silent? } 取消当前复核；silent 时不回 canceled
 * 协议（Worker → 主线程）：
 *   { type: 'done',     id, result }  求解结束（成功或输入校验失败）
 *   { type: 'canceled', id }          被显式取消中止
 *
 * 失效策略（代际令牌）：每次 solve 生成唯一 token 并替换 activeToken；
 * 正在运行的旧计算在让出点检测到令牌易主即退出，且退出后不再回传，
 * 因而草稿修改或取消之后，旧结论绝不可能覆盖当前界面状态。
 */
import { solveAsync } from '../lib/solver.js';

let activeToken = null;

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'solve') {
    const token = { id: msg.id };
    activeToken = token;
    try {
      const result = await solveAsync(msg.input, () => activeToken !== token);
      // 计算途中若已易主（新草稿 / 取消），直接丢弃，不得回传。
      if (activeToken !== token) return;
      activeToken = null;
      self.postMessage({ type: 'done', id: msg.id, result });
    } catch (err) {
      if (activeToken !== token) return;
      activeToken = null;
      self.postMessage({
        type: 'done',
        id: msg.id,
        result: {
          ok: false,
          errors: [
            {
              kind: 'internal',
              message: `求解器内部错误：${err && err.stack ? err.stack : String(err)}`,
            },
          ],
        },
      });
    }
    return;
  }

  if (msg.type === 'cancel') {
    // 置空令牌使正在运行的计算在最近的让出点停止；主循环的下一条
    // solve 消息也会同样顶掉旧令牌。草稿失效类取消为 silent，
    // 不回传以免覆盖主线程已经写好的状态。
    activeToken = null;
    if (!msg.silent) self.postMessage({ type: 'canceled', id: msg.id });
  }
};
