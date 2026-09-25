/**
 * 求解 Worker：主线程仅做录入与渲染，最小割计算与复测闭环规划在后台进行，
 * 不阻塞页面交互。
 *
 * 协议（主线程 → Worker）：
 *   { type: 'solve',      id, input }  发起/替换一次相位面复核
 *   { type: 'plan',       id, input }  发起/替换一次复测闭环规划
 *   { type: 'cancel',     id, silent? } 取消当前复核；silent 时不回 canceled
 *   { type: 'cancelPlan', id, silent? } 取消当前规划；silent 时不回 planCanceled
 * 协议（Worker → 主线程）：
 *   { type: 'done',         id, result }  复核结束（成功或输入校验失败）
 *   { type: 'planned',      id, result }  规划结束（成功、不可达或校验失败）
 *   { type: 'canceled',     id }          复核被显式取消中止
 *   { type: 'planCanceled', id }          规划被显式取消中止
 *
 * 失效策略（代际令牌）：复核与规划各持一枚独立令牌（activeToken /
 * activePlanToken），同类新任务顶掉旧令牌；正在运行的旧计算在让出点
 * 检测到令牌易主即退出，且退出后不再回传，因而草稿修改、勾选变更或
 * 取消之后，旧结论/旧规划绝不可能覆盖当前界面状态。
 */
import { solveAsync } from '../lib/solver.js';
import { planRouteAsync } from '../lib/routeplanner.js';

let activeToken = null;
let activePlanToken = null;

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

  if (msg.type === 'plan') {
    const token = { id: msg.id };
    activePlanToken = token;
    try {
      const result = await planRouteAsync(msg.input, () => activePlanToken !== token);
      if (activePlanToken !== token) return;
      activePlanToken = null;
      self.postMessage({ type: 'planned', id: msg.id, result });
    } catch (err) {
      if (activePlanToken !== token) return;
      activePlanToken = null;
      self.postMessage({
        type: 'planned',
        id: msg.id,
        result: {
          ok: false,
          errors: [
            {
              kind: 'internal',
              message: `规划器内部错误：${err && err.stack ? err.stack : String(err)}`,
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
    return;
  }

  if (msg.type === 'cancelPlan') {
    activePlanToken = null;
    if (!msg.silent) self.postMessage({ type: 'planCanceled', id: msg.id });
  }
};
