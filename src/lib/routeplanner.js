/**
 * 有向复测闭环规划（有向乡村邮路 / Route Inspection 的整数流精确解法）。
 *
 * 问题：
 *   校准员在既有相位面基础上勾选至多 24 条可疑观测边（必须至少经过一次），
 *   指定出发探针 s，规划一条只能沿当前录入的有向观测边行进、
 *   从 s 出发并回到 s 的最短有向闭环；未勾选边可作过渡边使用。
 *
 * 算法（严格按三步，不逐边贪心、不枚举路线、不使用浮点）：
 *
 *   1. 有向可达的最短过渡路：以“每条观测边经过一次代价 1”为统一整数跳数，
 *      从每个探针做一次 BFS，得到全源最短路距离 dist[][] 与前驱边，
 *      任意两探针间的过渡都取有向最短路（单向绕行天然被正确计入）。
 *
 *   2. 整数最小费用平衡：把勾选边造成的入出度失衡 d(v)=入度−出度 配平——
 *      d(v)>0 的探针需要补 d(v) 条出发过渡路（源点→v），
 *      d(v)<0 的探针需要补 −d(v) 条到达过渡路（v→汇点），
 *      探针 a→b 的过渡弧容量为 ∞、整数费用为最短路跳数 dist[a][b]。
 *      逐次最短路增广（Bellman-Ford，残量负费用同样整数精确）求得整数
 *      最小费用流，流量单位即需要插入的最短过渡路条数。
 *      出发探针在勾选边多重图中孤立时，额外强制一对“离开/回到 s”的流量，
 *      使平衡与“把 s 纳入闭环”一次性联合优化，避免“就近先走可疑边”式
 *      贪心把单向绕路的代价重复支付。
 *
 *   3. 展开欧拉闭环：勾选边 + 最小费用流配平用的最短过渡路（按前驱边展开
 *      为真实观测边序列）构成入出度平衡的有向多重图；若仍有平衡连通块
 *      未挂回 s 所在连通块，追加最便宜的成对往返过渡路挂接（保持平衡），
 *      随后从 s 做 Hierholzer（迭代）得到一条有向欧拉闭环。
 *
 * 不可达：某勾选边 u→v 无法纳入，当且仅当 s 不能沿有向边到达 u
 *   （无法抵达该边的出发端），或经过该边到达 v 后 v 不能回到 s。
 *
 * 取消：shouldCancel() 返回 true 时在阶段让出点返回 {ok:false,canceled:true}。
 */

/** 有限距离必小于此值；Int32 存储，所有运算均为整数 */
const INF_DIST = 1 << 30;
/**
 * 过渡弧容量：勾选边 ≤ 24，失衡供给合计 ≤ 24，s 孤立时再加强制 1，
 * 单弧至多承载 25 单位；取 32 留余量（容量大小不影响费用最优性）。
 */
const ARC_CAP = 32;

const isInt = Number.isInteger;

/**
 * 校验规划输入。
 * @returns {{kind:string,index?:number,message:string}[]}
 */
export function validateRouteInput(input) {
  const errors = [];
  const n = input?.n;
  const edges = Array.isArray(input?.edges) ? input.edges : null;
  const required = Array.isArray(input?.required) ? input.required : null;

  if (!isInt(n) || n < 2 || n > 40) {
    errors.push({ kind: 'count', message: `探针数量必须在 2…40 之间（收到 ${n}）` });
  }

  if (!edges) {
    errors.push({ kind: 'edge', message: '观测边列表缺失或无效' });
  } else if (isInt(n) && n >= 2 && n <= 40) {
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e] || {};
      if (!isInt(edge.u) || edge.u < 0 || edge.u >= n) {
        errors.push({ kind: 'edge', index: e, field: 'u', message: `第 ${e + 1} 条边的起点标识 “${edge.u}” 不存在：须在 0…${n - 1}` });
      }
      if (!isInt(edge.v) || edge.v < 0 || edge.v >= n) {
        errors.push({ kind: 'edge', index: e, field: 'v', message: `第 ${e + 1} 条边的终点标识 “${edge.v}” 不存在：须在 0…${n - 1}` });
      }
    }
  }

  if (!isInt(input?.start) || !isInt(n) || input.start < 0 || input.start >= n) {
    errors.push({ kind: 'start', field: 'index', message: `出发探针标识 “${input?.start}” 无效：须在 0…${isInt(n) && n > 0 ? n - 1 : 'n-1'}` });
  }

  if (!required) {
    errors.push({ kind: 'required', message: '复测勾选列表缺失或无效' });
  } else if (required.length === 0) {
    errors.push({ kind: 'required', message: '请至少勾选一条需要复测的观测边' });
  } else if (required.length > 24) {
    errors.push({ kind: 'required', message: `至多可勾选 24 条复测边（当前 ${required.length} 条）` });
  } else if (edges) {
    const seen = new Set();
    for (const r of required) {
      if (!isInt(r) || r < 0 || r >= edges.length) {
        errors.push({ kind: 'required', index: r, message: `勾选的观测边序号 “${r}” 不存在（共 ${edges.length} 条边）` });
      } else if (seen.has(r)) {
        errors.push({ kind: 'required', index: r, message: `观测边 ${r + 1} 被重复勾选` });
      }
      seen.add(r);
    }
  }

  return errors;
}

/** 建有向邻接表（保持录入顺序，用于确定性的最短路 tie-break） */
function buildAdjacency(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  edges.forEach((e, idx) => {
    adj[e.u].push({ to: e.v, edge: idx });
  });
  return adj;
}

/**
 * 全源 BFS：整数跳数最短路 + 前驱顶点/前驱边。
 * 返回 {dist, prevV, prevE}，不可达距离为 INF_DIST。
 */
function allPairsShortest(n, adj, shouldCancel) {
  const dist = Array.from({ length: n }, () => new Int32Array(n).fill(INF_DIST));
  const prevV = Array.from({ length: n }, () => new Int32Array(n).fill(-1));
  const prevE = Array.from({ length: n }, () => new Int32Array(n).fill(-1));

  for (let s = 0; s < n; s++) {
    if (shouldCancel && shouldCancel()) return null;
    const ds = dist[s];
    const pv = prevV[s];
    const pe = prevE[s];
    ds[s] = 0;
    const queue = [s];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      const nd = ds[v] + 1;
      for (const { to, edge } of adj[v]) {
        if (ds[to] === INF_DIST) {
          ds[to] = nd;
          pv[to] = v;
          pe[to] = edge;
          queue.push(to);
        }
      }
    }
  }
  return { dist, prevV, prevE };
}

/** 由前驱表还原 a→b 的最短路边下标序列（调用方须保证可达） */
function reconstructPath(prevV, prevE, a, b) {
  const es = [];
  let cur = b;
  while (cur !== a) {
    const e = prevE[a][cur];
    if (e < 0) return null; // 理论不可达：调用方已筛过
    es.push(e);
    cur = prevV[a][cur];
  }
  es.reverse();
  return es;
}

/**
 * 整数最小费用流（逐次最短路增广，Bellman-Ford 处理残量负费用）。
 * 网络规模 ≤ 42 节点 / ≤ n²+2n 弧，增广次数 ≤ 24，整数费用精确，
 * 不使用任何浮点运算。
 */
class MinCostFlow {
  constructor(n) {
    this.n = n;
    /** 每条弧：{to, cap, cost, rev} */
    this.g = Array.from({ length: n }, () => []);
  }

  addArc(from, to, cap, cost) {
    this.g[from].push({ to, cap, cost, rev: this.g[to].length });
    this.g[to].push({ to: from, cap: 0, cost: -cost, rev: this.g[from].length - 1 });
    return this.g[from][this.g[from].length - 1];
  }

  /** 从 s 到 t 逐单位整数最短路增广，返回 {flow, cost} */
  minCostFlow(s, t, shouldCancel) {
    let flow = 0;
    let cost = 0;
    const N = this.n;
    const d = new Array(N);
    const parV = new Int32Array(N);
    const parA = new Int32Array(N);

    for (;;) {
      if (shouldCancel && shouldCancel()) return null;
      d.fill(INF_DIST);
      d[s] = 0;
      // Bellman-Ford：按节点、弧的固定顺序松弛，strict < 保证确定性 tie-break。
      let updated = true;
      for (let pass = 0; pass < N - 1 && updated; pass++) {
        updated = false;
        for (let v = 0; v < N; v++) {
          if (d[v] === INF_DIST) continue;
          const arcs = this.g[v];
          for (let ai = 0; ai < arcs.length; ai++) {
            const a = arcs[ai];
            if (a.cap > 0 && d[v] + a.cost < d[a.to]) {
              d[a.to] = d[v] + a.cost;
              parV[a.to] = v;
              parA[a.to] = ai;
              updated = true;
            }
          }
        }
      }
      if (d[t] === INF_DIST) break;

      // 回溯增广（瓶颈容量；本问题中各单位费用相同，逐次/瓶颈增广等价）。
      let f = ARC_CAP;
      for (let v = t; v !== s; v = parV[v]) f = Math.min(f, this.g[parV[v]][parA[v]].cap);
      for (let v = t; v !== s; v = parV[v]) {
        const a = this.g[parV[v]][parA[v]];
        a.cap -= f;
        this.g[v][a.rev].cap += f;
      }
      flow += f;
      cost += f * d[t];
    }
    return { flow, cost };
  }
}

/** 并查集（多重图弱连通块挂接用） */
class DSU {
  constructor(n) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }

  find(x) {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // 固定把编号大的根挂到编号小的根下，保证确定性。
      if (ra < rb) this.p[rb] = ra;
      else this.p[ra] = rb;
    }
  }
}

/**
 * 规划主入口（同步，测试/Node 侧使用）。
 * @param {{n:number, edges:{u:number,v:number}[], required:number[], start:number}} input
 * @returns 成功
 *   {ok:true, start, length, balanceCost,
 *    steps:[{step,edge,u,v,suspicious}], requiredFirstHit:[{edge,u,v,step}]}
 *   不可达/校验失败
 *   {ok:false, errors?|unreachable?:[{from,to,edge?,message}]}
 *   取消 {ok:false,canceled:true}
 */
export function planRoute(input, shouldCancel = null) {
  const errors = validateRouteInput(input);
  if (errors.length) return { ok: false, errors };

  const { n, edges, start } = input;
  const required = [...new Set(input.required)].sort((a, b) => a - b);
  const requiredSet = new Set(required);
  const adj = buildAdjacency(n, edges);

  // ---- 第 1 步：有向全源最短过渡路 -----------------------------------------
  const shortest = allPairsShortest(n, adj, shouldCancel);
  if (!shortest) return { ok: false, canceled: true };
  const { dist, prevV, prevE } = shortest;

  // ---- 可行性：每条勾选边必须能“从 s 抵达其尾、经其头回到 s” --------------
  const unreachable = [];
  for (const r of required) {
    const { u, v } = edges[r];
    if (dist[start][u] === INF_DIST) {
      unreachable.push({
        kind: 'unreachable',
        from: start,
        to: u,
        edge: r,
        message: `从探针 ${start} 无法沿有向观测边到达探针 ${u}（可疑边 ${r + 1}：${u}→${v} 的出发端），该边不能纳入闭环`,
      });
    }
    if (dist[v][start] === INF_DIST) {
      unreachable.push({
        kind: 'unreachable',
        from: v,
        to: start,
        edge: r,
        message: `经过可疑边 ${r + 1}（${u}→${v}）到达探针 ${v} 后，无法沿有向观测边回到出发探针 ${start}`,
      });
    }
  }
  if (unreachable.length) return { ok: false, unreachable };

  // ---- 第 2 步：整数最小费用平衡 -------------------------------------------
  // d(v) = 勾选边入度 − 出度；>0 需补出发路（供给），<0 需补到达路（需求）。
  const balance = new Int32Array(n);
  for (const r of required) {
    balance[edges[r].u] -= 1;
    balance[edges[r].v] += 1;
  }
  // 出发探针 s 是否在勾选边多重图中出现；若完全不相邻，需要额外强制
  // “一条过渡路离开 s、一条过渡路回到 s”，否则 s 不会进入平衡多重图。
  let depotIncident = false;
  for (const r of required) {
    if (edges[r].u === start || edges[r].v === start) {
      depotIncident = true;
      break;
    }
  }

  // 强制 s 出入时用节点拆分（sOut/sIn）：若直接用 S→s→T，流量会走
  // 零费用直通而形同未强制。拆分后供给必须经真实过渡弧离开 sOut、
  // 需求必须经真实过渡弧到达 sIn，与失衡配平联合取最小费用。
  const forced = !depotIncident;
  const sOut = forced ? n : -1;
  const sIn = forced ? n + 1 : -1;
  const S = forced ? n + 2 : n;
  const T = S + 1;
  const mcf = new MinCostFlow(T + 1);
  let totalSupply = 0;
  for (let v = 0; v < n; v++) {
    if (balance[v] > 0) {
      mcf.addArc(S, v, balance[v], 0);
      totalSupply += balance[v];
    } else if (balance[v] < 0) {
      mcf.addArc(v, T, -balance[v], 0);
    }
  }
  // 过渡弧 a→b：费用 = 有向最短跳数（整数）；自环过渡无益，不加入。
  const transitionArcs = [];
  const addTransition = (a, b, fromNode, toNode) => {
    const arc = mcf.addArc(fromNode, toNode, ARC_CAP, dist[a][b]);
    transitionArcs.push({ a, b, arc });
  };
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a !== b && dist[a][b] < INF_DIST) addTransition(a, b, a, b);
    }
  }
  if (forced) {
    mcf.addArc(S, sOut, 1, 0);
    mcf.addArc(sIn, T, 1, 0);
    totalSupply += 1;
    for (let b = 0; b < n; b++) {
      if (b !== start && dist[start][b] < INF_DIST) addTransition(start, b, sOut, b);
    }
    for (let a = 0; a < n; a++) {
      if (a !== start && dist[a][start] < INF_DIST) addTransition(a, start, a, sIn);
    }
  }

  const mcfResult = mcf.minCostFlow(S, T, shouldCancel);
  if (!mcfResult) return { ok: false, canceled: true };
  if (mcfResult.flow !== totalSupply) {
    // 理论不可达：逐边可行性已保证过渡路存在，配平流必然满流。
    throw new Error(`规划内部错误：配平流 ${mcfResult.flow}/${totalSupply} 未满流`);
  }

  // ---- 第 3 步：展开为观测边多重图 ------------------------------------------
  /** copies: [{edge, u, v}]，欧拉展开的全部边实例；是否可疑按 requiredSet 判定 */
  const copies = [];
  const pushPath = (pathEdges) => {
    for (const e of pathEdges) {
      copies.push({ edge: e, u: edges[e].u, v: edges[e].v });
    }
  };
  // 勾选边本身（按录入顺序，确定性）。
  for (const r of required) copies.push({ edge: r, u: edges[r].u, v: edges[r].v });
  // 配平流的每一单位流量 = 一条 a→b 最短过渡路，按前驱边展开。
  for (const { a, b, arc } of transitionArcs) {
    const used = ARC_CAP - arc.cap; // 残量反推实流流量
    if (used <= 0) continue;
    const pathEdges = reconstructPath(prevV, prevE, a, b);
    for (let k = 0; k < used; k++) pushPath(pathEdges);
  }

  // 挂接残余的平衡连通块（自身平衡但未与 s 连通的可疑边块）：
  // 每轮追加一对最便宜的“s 块→外挂块、外挂块→s 块”最短往返路，
  // 往返路保持入出度平衡，展开后可能顺带穿过其他外挂块而一并挂接。
  const componentsOf = (copiesList) => {
    const dsu = new DSU(n);
    const active = new Uint8Array(n);
    active[start] = 1; // s 即使暂无边也属于主块
    for (const c of copiesList) {
      dsu.union(c.u, c.v);
      active[c.u] = 1;
      active[c.v] = 1;
    }
    return { dsu, active };
  };

  for (;;) {
    if (shouldCancel && shouldCancel()) return { ok: false, canceled: true };
    const { dsu, active } = componentsOf(copies);
    const rootS = dsu.find(start);
    const mainVerts = [];
    for (let v = 0; v < n; v++) if (active[v] && dsu.find(v) === rootS) mainVerts.push(v);

    // 收集外挂块：root → 顶点列表。
    const outside = new Map();
    for (let v = 0; v < n; v++) {
      if (!active[v]) continue;
      const root = dsu.find(v);
      if (root === rootS) continue;
      if (!outside.has(root)) outside.set(root, []);
      outside.get(root).push(v);
    }
    if (outside.size === 0) break;

    // 最便宜挂接对 (a,c)：同一对顶点间往返 dist[a][c]+dist[c][a] 最小，
    // 往返路在 a、c 上各添一对出入度，严格保持整体平衡。
    // tie-break：块代表顶点、再到 (a,c)，全确定性。
    let best = null;
    for (const [root, verts] of outside) {
      let pair = null;
      let pairCost = INF_DIST;
      for (const a of mainVerts) {
        for (const c of verts) {
          const cost = dist[a][c] + dist[c][a];
          if (
            cost < pairCost ||
            (cost === pairCost && (a < pair[0] || (a === pair[0] && c < pair[1])))
          ) {
            pairCost = cost;
            pair = [a, c];
          }
        }
      }
      if (!best || pairCost < best.total || (pairCost === best.total && root < best.root)) {
        best = { root, total: pairCost, pair };
      }
    }
    pushPath(reconstructPath(prevV, prevE, best.pair[0], best.pair[1]));
    pushPath(reconstructPath(prevV, prevE, best.pair[1], best.pair[0]));
  }

  // ---- Hierholzer 展开欧拉闭环（迭代，确定性边序） -------------------------
  const eulerAdj = Array.from({ length: n }, () => []);
  copies.forEach((c, idx) => eulerAdj[c.u].push({ idx, v: c.v }));
  // 按下标升序消费：先反转，使 pop() 取到最小下标。
  for (const list of eulerAdj) list.reverse();

  const stackV = [start];
  const stackIdx = [];
  const edgeOrder = [];
  while (stackV.length > 0) {
    if (shouldCancel && shouldCancel()) return { ok: false, canceled: true };
    const v = stackV[stackV.length - 1];
    if (eulerAdj[v].length > 0) {
      const { idx, v: w } = eulerAdj[v].pop();
      stackV.push(w);
      stackIdx.push(idx);
    } else {
      stackV.pop();
      if (stackIdx.length > 0) edgeOrder.push(stackIdx.pop());
    }
  }
  edgeOrder.reverse();

  if (edgeOrder.length !== copies.length) {
    throw new Error('规划内部错误：平衡多重图未展开为单一欧拉闭环（存在孤立平衡块）');
  }

  // ---- 组装步序与可疑边首次到达位置 ----------------------------------------
  const steps = edgeOrder.map((idx, position) => {
    const c = copies[idx];
    return { step: position + 1, edge: c.edge, u: c.u, v: c.v, suspicious: requiredSet.has(c.edge) };
  });
  if (steps.length === 0 || steps[0].u !== start || steps[steps.length - 1].v !== start) {
    throw new Error('规划内部错误：闭环未从出发探针起止');
  }
  for (let i = 1; i < steps.length; i++) {
    if (steps[i - 1].v !== steps[i].u) throw new Error('规划内部错误：闭环步序在探针处不衔接');
  }

  const seenFirst = new Set();
  const requiredFirstHit = [];
  steps.forEach((st) => {
    if (requiredSet.has(st.edge) && !seenFirst.has(st.edge)) {
      seenFirst.add(st.edge);
      requiredFirstHit.push({ edge: st.edge, u: st.u, v: st.v, step: st.step });
    }
  });
  // 按可疑边录入序号输出，便于核对。
  requiredFirstHit.sort((a, b) => a.edge - b.edge);
  if (requiredFirstHit.length !== required.length) {
    throw new Error('规划内部错误：存在可疑边未被闭环覆盖');
  }

  return {
    ok: true,
    start,
    length: steps.length,
    balanceCost: mcfResult.cost,
    steps,
    requiredFirstHit,
  };
}

/**
 * 异步主入口（Web Worker 使用）。本问题规模（n≤40、勾选边 ≤24）极小，
 * 仍保留 shouldCancel 协作式取消与阶段让出点，以遵守代际令牌协议：
 * 选择/草稿变更或取消后，旧规划结果永不回传。
 */
export async function planRouteAsync(input, shouldCancel = null) {
  // await 一个宏任务，使 Worker 在真正计算前能接收“顶掉旧令牌”的消息。
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (shouldCancel && shouldCancel()) return { ok: false, canceled: true };
  return planRoute(input, shouldCancel);
}
