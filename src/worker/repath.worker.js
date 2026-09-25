/**
 * 复测闭环规划 Worker：最短过渡路、整数最小费用平衡与欧拉展开均在后台
 * 完成，不阻塞页面交互；与相位面复核 Worker 相互独立，互不覆盖结论。
 *
 * 协议（主线程 → Worker）：
 *   { type: 'planRoute', id, input }  发起/替换一次闭环规划
 *   { type: 'cancel',    id, silent? } 取消当前规划；silent 时不回执
 * 协议（Worker → 主线程）：
 *   { type: 'done',     id, result }  规划结束（成功 / 不可达 / 校验失败）
 *   { type: 'canceled', id }          被显式取消中止
 *
 * 失效策略（代际令牌）：每次 planRoute 生成唯一 token 并替换 activeToken；
 * 旧规划在让出点检测到令牌易主即退出且不再回传。修改勾选、修改草稿或
 * 取消之后，旧规划绝不可能覆盖当前闭环结论（更不会触碰相位面复核面板）。
 */
import { planRemeasureRouteAsync } from '../lib/repath.js';

let activeToken = null;

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'planRoute') {
    const token = { id: msg.id };
    activeToken = token;
    try {
      const result = await planRemeasureRouteAsync(msg.input, () => activeToken !== token);
      // 规划途中若已易主（新勾选 / 新草稿 / 取消），直接丢弃，不得回传。
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
              message: `闭环规划内部错误：${err && err.stack ? err.stack : String(err)}`,
            },
          ],
        },
      });
    }
    return;
  }

  if (msg.type === 'cancel') {
    activeToken = null;
    if (!msg.silent) self.postMessage({ type: 'canceled', id: msg.id });
  }
};
