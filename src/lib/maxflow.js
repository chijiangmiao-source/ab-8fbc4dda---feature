/**
 * Dinic 最大流算法（整数容量），迭代实现（无深递归，避免数千层
 * 残量层级在浏览器 Worker 中栈溢出）。
 *
 * 邻接表存储；addEdge(u, v, cap) 同时插入容量为 0 的反向边。
 * 所有容量均为非负整数，maxflow 返回整数最小割值，
 * 因而整条求解链路不存在浮点近似。
 *
 * 取消与让出：
 *  - shouldCancel() 返回 true 时协作式停止（结果作废，调用方丢弃）；
 *  - 异步版每扫描 budget 条弧抛出 BUDGET_EXHAUSTED，由 async 外壳
 *    await 一个宏任务后续跑（残量与当前弧游标均保持一致）。
 */

/** 异步扫描预算耗尽的内部哨兵 */
const BUDGET_EXHAUSTED = Symbol('budget-exhausted');

export class Dinic {
  constructor(n) {
    this.n = n;
    // 每条边: [to, rev(在 g[to] 中的下标), cap]
    this.g = Array.from({ length: n }, () => []);
  }

  addEdge(from, to, cap) {
    this.g[from].push([to, this.g[to].length, cap]);
    this.g[to].push([from, this.g[from].length - 1, 0]);
  }

  bfs(s, t, level) {
    level.fill(-1);
    level[s] = 0;
    const q = [s];
    let head = 0;
    while (head < q.length) {
      const v = q[head++];
      for (const [to, , cap] of this.g[v]) {
        if (cap > 0 && level[to] < 0) {
          level[to] = level[v] + 1;
          q.push(to);
        }
      }
    }
    return level[t] >= 0;
  }

  /**
   * 在一个 BFS 分层内求阻塞流（迭代，显式栈）。
   *
   * verts/edges 为当前 DFS 路径：edges[i] 是从 verts[i] 到 verts[i+1] 的边。
   * - 到达 t：沿路径取瓶颈增广，再回退到路径上第一条（最靠近 s 的）饱和边；
   * - 死端：弹出该点并令父节点的当前弧越过刚走的边；
   * - it[] 为各点当前弧，跨多次调用保持（用于异步让出后续跑）。
   */
  blockingFlow(s, t, level, it, shouldCancel, budget, acc) {
    const FLOW_INF = 0x7fffffff;
    const verts = [s];
    const edges = [];

    while (verts.length > 0) {
      if (shouldCancel && shouldCancel()) return;
      const v = verts[verts.length - 1];

      if (v === t) {
        let f = FLOW_INF;
        for (const e of edges) if (e[2] < f) f = e[2];
        let firstSaturated = edges.length;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          e[2] -= f;
          this.g[e[0]][e[1]][2] += f;
          if (e[2] === 0 && i < firstSaturated) firstSaturated = i;
        }
        acc.flow += f; // 共享累加器：预算中断时已推送的流量也不丢失
        // 回退到第一条饱和边：该边 cap 已为 0，下一轮扫描会自动越过。
        verts.length = firstSaturated + 1;
        edges.length = firstSaturated;
        continue;
      }

      const adj = this.g[v];
      let i = it[v];
      while (i < adj.length) {
        if (budget && --budget.n <= 0) throw BUDGET_EXHAUSTED;
        const e = adj[i];
        if (e[2] > 0 && level[e[0]] === level[v] + 1) break;
        i++;
      }
      it[v] = i;

      if (i === adj.length) {
        // 死端：回到父节点并把其当前弧推进到下一条边。
        verts.pop();
        edges.pop();
        if (verts.length > 0) it[verts[verts.length - 1]]++;
      } else {
        const e = adj[i];
        verts.push(e[0]);
        edges.push(e);
      }
    }
  }

  maxflow(s, t, shouldCancel = null) {
    const level = new Int32Array(this.n);
    const it = new Int32Array(this.n);
    const acc = { flow: 0 };
    while (this.bfs(s, t, level)) {
      if (shouldCancel && shouldCancel()) return acc.flow;
      it.fill(0);
      this.blockingFlow(s, t, level, it, shouldCancel, null, acc);
    }
    return acc.flow;
  }

  /**
   * 异步版：每消耗 budget 条弧的扫描就让出一次宏任务，
   * 使 Worker 能及时响应“取消 / 新草稿”。跨让出的已推送流量
   * 通过共享累加器 acc 汇总，计数不会因中断而丢失。
   */
  async maxflowAsync(s, t, shouldCancel = null, yieldEvery = 100000) {
    const level = new Int32Array(this.n);
    const it = new Int32Array(this.n);
    const acc = { flow: 0 };
    const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));
    while (this.bfs(s, t, level)) {
      if (shouldCancel && shouldCancel()) return acc.flow;
      it.fill(0);
      for (;;) {
        const budget = { n: yieldEvery };
        try {
          this.blockingFlow(s, t, level, it, shouldCancel, budget, acc);
        } catch (e) {
          if (e === BUDGET_EXHAUSTED) {
            await yieldToEventLoop();
            continue; // 残量网络、当前弧游标与 acc 均有效，直接续跑
          }
          throw e;
        }
        break; // 本分层阻塞流完成，进入下一轮 BFS
      }
    }
    return acc.flow;
  }

  /**
   * 在最大流之后做一次从源点出发的可达搜索，
   * 返回布尔数组：true 表示该节点位于源侧（最小割 S 集）。
   */
  sourceSide(s) {
    const seen = new Uint8Array(this.n);
    seen[s] = 1;
    const q = [s];
    let head = 0;
    while (head < q.length) {
      const v = q[head++];
      for (const [to, , cap] of this.g[v]) {
        if (cap > 0 && !seen[to]) {
          seen[to] = 1;
          q.push(to);
        }
      }
    }
    return seen;
  }
}
