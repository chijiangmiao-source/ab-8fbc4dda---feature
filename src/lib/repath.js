/**
 * 有向复测闭环规划（Route Inspection on a directed graph）。
 *
 * 给定当前录入的有向观测边（只能沿这些边前进）与至多 24 条被勾选的
 * 可疑边，生成一条从指定出发探针开始、回到该探针的最短有向闭环，
 * 使每条可疑边至少经过一次；其他观测边可作过渡边重复使用。
 *
 * 严格三步（不逐边贪心、不枚举路线、不用浮点）：
 *
 *   1. 有向可达的最短过渡路：以“边数”为整数距离，从每个探针做 BFS，
 *      得到全部探针间的最短距离与按录入顺序确定的唯一前驱（确定性）。
 *      可疑边端点从出发探针不可达、或可疑边之后回不到出发点时，
 *      精确定位“从何探针不能到达何处”，不产出路线。
 *
 *   2. 整数最小费用平衡：把每条可疑边视作必须出现一次的度数，
 *           b[v] = 可疑边在 v 的出度 − 入度，
 *      在“可疑边末端 → 可疑边始端”的整数最小费用运输网络上
 *      （弧费用 = 第 1 步的最短边数，容量取整数上界）用
 *      Bellman-Ford 最短路逐次增广求整数最小费用流；费用全为整数，
 *      残量反向弧为负费用，故不能用 Dijkstra 零位势以外的近似。
 *
 *   3. 展开欧拉闭环：将每单位流沿第 1 步的最短路边序展开为过渡边，
 *      与可疑边合并为平衡多重图；连通性修补后用 Hierholzer 展开为
 *      一条从出发探针回到出发探针的有向欧拉闭环（栈式迭代），
 *      记录完整边序与每条可疑边的首次到达位置。
 *
 * 说明（连通性修补）：最小费用流只对“入出度失衡”负责；当某些可疑边
 * 自身已构成与出发地断开的平衡小环时，平衡流在该分量上为零。此时用
 * 整数最短路把该平衡分量以最便宜的闭合绕行方式拼回出发地所在分量
 * （从 r 到 p 走最短路、遍历该分量、再从 p 回 r），仍不使用浮点、
 * 贪心路线或枚举。
 */

const isInt = Number.isInteger;
const INF = 0x7fffffff;

/** 取消哨兵：协作式取消时返回，调用方必须丢弃且不得上屏。 */
export const CANCELED = { ok: false, canceled: true };

/**
 * 校验规划输入。
 * @returns {{kind:string,index?:number,message:string}[]}
 */
export function validateRouteInput(input) {
  const errors = [];
  const n = input?.count;
  const edges = Array.isArray(input?.edges) ? input.edges : [];
  if (!isInt(n) || n < 1) {
    errors.push({ kind: 'count', message: `探针数量无效（收到 ${input?.count}）` });
  }
  if (!isInt(input?.start) || input.start < 0 || input.start >= (isInt(n) ? n : 1)) {
    errors.push({
      kind: 'start',
      message: `出发探针 ${input?.start} 无效：必须是 0…${isInt(n) ? n - 1 : 0} 内的探针`,
    });
  }
  edges.forEach((e, i) => {
    if (!isInt(e?.u) || e.u < 0 || e.u >= n || !isInt(e?.v) || e.v < 0 || e.v >= n) {
      errors.push({
        kind: 'edge',
        index: i,
        message: `第 ${i + 1} 条边端点无效：${e?.u}→${e?.v}，探针须在 0…${isInt(n) ? n - 1 : 0} 内`,
      });
    }
  });

  const selected = Array.isArray(input?.selected) ? input.selected : null;
  if (!selected) {
    errors.push({ kind: 'selected', message: '缺少勾选边列表' });
  } else {
    if (selected.length < 1) {
      errors.push({ kind: 'selected', message: '请至少勾选一条需要复测的可疑边' });
    }
    if (selected.length > 24) {
      errors.push({ kind: 'selected', message: `至多勾选 24 条可疑边（当前 ${selected.length} 条）` });
    }
    const seen = new Set();
    for (const idx of selected) {
      if (!isInt(idx) || idx < 0 || idx >= edges.length) {
        errors.push({ kind: 'selected', message: `勾选边序号无效：${idx}` });
      } else if (seen.has(idx)) {
        errors.push({ kind: 'selected', message: `第 ${idx + 1} 条边被重复勾选` });
      }
      seen.add(idx);
    }
  }
  return errors;
}

/** 按录入顺序构造邻接表：adj[u] 内每项 {v, edge}。 */
function buildAdjacency(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => adj[e.u].push({ v: e.v, edge: i }));
  return adj;
}

/**
 * 从 source 做整数无权 BFS。
 * @returns {{dist:Int32Array, prevV:Int32Array, prevE:Int32Array}}
 *   前驱按边录入顺序确定，故最短路唯一、可复现。
 */
function bfsFrom(n, adj, source) {
  const dist = new Int32Array(n).fill(-1);
  const prevV = new Int32Array(n).fill(-1);
  const prevE = new Int32Array(n).fill(-1);
  dist[source] = 0;
  const q = [source];
  let head = 0;
  while (head < q.length) {
    const v = q[head++];
    for (const { v: w, edge } of adj[v]) {
      if (dist[w] < 0) {
        dist[w] = dist[v] + 1;
        prevV[w] = v;
        prevE[w] = edge;
        q.push(w);
      }
    }
  }
  return { dist, prevV, prevE };
}

/** 沿 BFS 前驱还原 from→to 的边序号序列（from===to 时为空数组）。 */
function reconstructPath(prevV, prevE, from, to) {
  const path = [];
  let cur = to;
  while (cur !== from) {
    path.push(prevE[cur]);
    cur = prevV[cur];
  }
  path.reverse();
  return path;
}

/**
 * 全部探针间的最短过渡路（整数边数）与可展开路径表。
 * @returns {{dist:number[][], paths:number[][][]}}
 *   dist[s][t]：边数；不可达为 Infinity。paths[s][t]：边序号数组。
 */
export function shortestTransitionPaths(n, edges) {
  const adj = buildAdjacency(n, edges);
  const dist = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const paths = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let s = 0; s < n; s++) {
    const { dist: d, prevV, prevE } = bfsFrom(n, adj, s);
    for (let t = 0; t < n; t++) {
      if (d[t] < 0) continue;
      dist[s][t] = d[t];
      paths[s][t] = s === t ? [] : reconstructPath(prevV, prevE, s, t);
    }
  }
  return { dist, paths };
}

/**
 * 整数最小费用流（逐次最短路增广）。
 * 初始费用均为非负整数；增广后残量网络含负费用反向弧，
 * 故每轮用 Bellman-Ford 求最短路，容量、距离、费用全程整数。
 */
class MinCostFlow {
  constructor(n) {
    this.n = n;
    this.g = Array.from({ length: n }, () => []);
  }

  /** 插入正向弧与零容量反向弧，返回正向弧对象（增广后读 .cap 可知流量）。 */
  addEdge(u, v, cap, cost) {
    const fwd = { u, v, cap, cost, flowArc: true };
    const rev = { u: v, v: u, cap: 0, cost: -cost, flowArc: false };
    fwd.rev = rev;
    rev.rev = fwd;
    this.g[u].push(fwd);
    this.g[v].push(rev);
    return fwd;
  }

  /**
   * 从 s 向 t 推送 need 单位最小费用整数流。
   * @returns {{flow:number, cost:number, feasible:boolean}}
   */
  run(s, t, need, shouldCancel = null) {
    let flow = 0;
    let cost = 0;
    while (flow < need) {
      if (shouldCancel && shouldCancel()) return { flow, cost, feasible: false, canceled: true };
      const dist = new Array(this.n).fill(INF);
      const pv = new Int32Array(this.n).fill(-1);
      const pe = new Array(this.n).fill(null);
      dist[s] = 0;
      // Bellman-Ford（节点数 ≤ 探针数 + 2 = 42，弧数 ≤ 24² 量级，足够快）。
      for (let relaxed = true; relaxed; ) {
        relaxed = false;
        for (let v = 0; v < this.n; v++) {
          if (dist[v] === INF) continue;
          for (const e of this.g[v]) {
            if (e.cap > 0 && dist[e.v] > dist[v] + e.cost) {
              dist[e.v] = dist[v] + e.cost;
              pv[e.v] = v;
              pe[e.v] = e;
              relaxed = true;
            }
          }
        }
      }
      if (dist[t] === INF) return { flow, cost, feasible: false };
      let f = need - flow;
      for (let v = t; v !== s; v = pv[v]) f = Math.min(f, pe[v].cap);
      for (let v = t; v !== s; v = pv[v]) {
        const e = pe[v];
        e.cap -= f;
        e.rev.cap += f;
      }
      flow += f;
      cost += f * dist[t];
    }
    return { flow, cost, feasible: true };
  }
}

/** 并查集（连通性修补用）。 */
class DSU {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a, b) {
    a = this.find(a);
    b = this.find(b);
    if (a !== b) this.p[b] = a;
  }
}

/**
 * 主入口：求有向复测闭环。
 *
 * @param {{count:number, edges:{u:number,v:number}[], start:number,
 *          selected:number[]}} input
 * @param {(() => boolean)|null} [shouldCancel] 协作式取消
 * @returns 成功
 *   {ok:true, start, length, selected:[...],
 *    steps:[{edge,u,v,suspect,first}], firstReach:[{edge,position}],
 *    balanceCost, repairCost}
 *   失败（可达性）
 *   {ok:false, unreachable:[{edge, from, to, detail}]}
 *   校验失败 {ok:false, errors:[...]}
 */
export function planRemeasureRoute(input, shouldCancel = null) {
  const errors = validateRouteInput(input);
  if (errors.length) return { ok: false, errors };

  const n = input.count;
  const edges = input.edges;
  const start = input.start;
  // 去重已在校验中保证；保持用户勾选顺序用于输出排序。
  const selected = [...input.selected];
  const selectedSet = new Set(selected);

  if (shouldCancel && shouldCancel()) return { ...CANCELED };

  const { dist, paths } = shortestTransitionPaths(n, edges);

  // ---- 第 1 步的可行性诊断：可疑边与出发点必须能纳入同一闭环 -----------
  const unreachable = [];
  for (const idx of selected) {
    const e = edges[idx];
    if (dist[start][e.u] === Infinity) {
      unreachable.push({
        edge: idx,
        from: start,
        to: e.u,
        detail: `出发探针 ${start} 无法沿有向边到达可疑边 ${idx + 1}（${e.u}→${e.v}）的起点 ${e.u}`,
      });
    }
    if (dist[e.v][start] === Infinity) {
      unreachable.push({
        edge: idx,
        from: e.v,
        to: start,
        detail: `可疑边 ${idx + 1}（${e.u}→${e.v}）到达探针 ${e.v} 后，无法沿有向边回到出发探针 ${start}`,
      });
    }
  }
  if (unreachable.length) return { ok: false, unreachable };

  if (shouldCancel && shouldCancel()) return { ...CANCELED };

  // ---- 第 2 步：按可疑边入出度失衡做整数最小费用平衡 -------------------
  const balance = new Int32Array(n); // b[v] = 出度 − 入度
  for (const idx of selected) {
    balance[edges[idx].u]++;
    balance[edges[idx].v]--;
  }

  const S = n;
  const T = n + 1;
  const mcf = new MinCostFlow(n + 2);
  // 可疑边 b[v]=出−入：b>0 表示出多入少，需要过渡流“进入”该点
  // （运输需求 v→T）；b<0 表示入多出少，需要过渡流“离开”该点
  // （供应 S→v）。配平后可疑边与过渡边合并即为入出度平衡多重图。
  let totalSupply = 0;
  for (let v = 0; v < n; v++) {
    if (balance[v] > 0) {
      mcf.addEdge(v, T, balance[v], 0);
    } else if (balance[v] < 0) {
      mcf.addEdge(S, v, -balance[v], 0);
      totalSupply += -balance[v];
    }
  }
  // 过渡弧：供应探针（可疑边入多于出）→ 需求探针（出多于入），
  // 费用为第 1 步求出的最短有向边数。可疑边端点对出发地可达且能回到
  // 出发地，故任意供应/需求端点间经出发地总有有限最短路，运输必可行。
  const transitArcs = [];
  if (totalSupply > 0) {
    for (let v = 0; v < n; v++) {
      if (balance[v] >= 0) continue;
      for (let u = 0; u < n; u++) {
        if (balance[u] <= 0 || v === u) continue;
        if (dist[v][u] === Infinity) continue;
        transitArcs.push({ from: v, to: u, arc: mcf.addEdge(v, u, INF, dist[v][u]) });
      }
    }
    const mc = mcf.run(S, T, totalSupply, shouldCancel);
    if (mc.canceled) return { ...CANCELED };
    if (!mc.feasible) {
      // 理论不可达：前置可达性诊断通过后必为可行运输。
      return {
        ok: false,
        errors: [{ kind: 'internal', message: '最小费用平衡无可行解（内部错误）' }],
      };
    }
  }

  if (shouldCancel && shouldCancel()) return { ...CANCELED };

  // ---- 第 3 步：平衡流展开为过渡边多重集，与可疑边合并 -----------------
  /** 每条出现：{edge, required}（同一条边可出现多次） */
  const occurrences = [];
  for (const idx of selected) occurrences.push({ edge: idx, required: true });

  let balanceCost = 0;
  for (const { from, to, arc } of transitArcs) {
    const used = arc.rev.cap; // 正向弧已推送的整数流量
    if (used <= 0) continue;
    const path = paths[from][to];
    balanceCost += used * path.length;
    for (let k = 0; k < used; k++) {
      for (const edge of path) occurrences.push({ edge, required: false });
    }
  }

  // ---- 连通性修补：平衡流之后，把仍与出发地断开的平衡分量用一条最短
  // “访问闭环”一次性拼回。平衡流展开路径经过的分量已并入 root；
  // 剩余断开分量自身入出度平衡（否则平衡流必有弧出入其端点），
  // 每个至少含两条可疑边，故分量数 c ≤ 12（2^c 规模可承受）。
  //
  // 精确做法（整数子集 DP，非路线枚举）：把每个断开分量中可疑边的端点
  // 作为该分量的“门户”，求从 start 出发、每个分量至少触达一个门户、
  // 再回 start 的最短有向步行：
  //   dp[S][w] = 已触达分量集合恰为 S、当前停在门户 w 的最短边数；
  // 沿最短路三角不等式，路径途中顺带穿过其他分量不会更便宜地漏算，
  // 故 DP 值即最短访问步行的精确长度。
  let repairCost = 0;
  const repairSegments = []; // 展开用：{from,to}
  {
    const dsu = new DSU(n);
    for (const occ of occurrences) {
      dsu.union(edges[occ.edge].u, edges[occ.edge].v);
    }
    const root = dsu.find(start);
    const compOf = new Map(); // 分量代表 → 编号
    const portals = []; // compId → 门户探针数组
    for (const idx of selected) {
      for (const v of [edges[idx].u, edges[idx].v]) {
        const r = dsu.find(v);
        if (r === root) continue;
        let cid = compOf.get(r);
        if (cid === undefined) {
          cid = portals.length;
          compOf.set(r, cid);
          portals.push([]);
        }
        if (!portals[cid].includes(v)) portals[cid].push(v);
      }
    }
    const c = portals.length;
    if (c > 0) {
      const DP_INF = INF;
      const size = 1 << c;
      // dp[mask]：长度 n 的 Int32Array，值为停在该门户的最短长度。
      const dp = Array.from({ length: size }, () => new Int32Array(n).fill(DP_INF));
      // 回溯：prevMask[mask][v] / prevV[mask][v]。
      const prevMask = Array.from({ length: size }, () => new Int32Array(n).fill(-1));
      const prevV = Array.from({ length: size }, () => new Int32Array(n).fill(-1));
      for (let j = 0; j < c; j++) {
        for (const w of portals[j]) dp[1 << j][w] = dist[start][w];
      }
      for (let mask = 1; mask < size; mask++) {
        if (shouldCancel && (mask & 255) === 0 && shouldCancel()) return { ...CANCELED };
        for (let j = 0; j < c; j++) {
          if (mask & (1 << j)) continue;
          const nmask = mask | (1 << j);
          for (let v = 0; v < n; v++) {
            const base = dp[mask][v];
            if (base === DP_INF) continue;
            for (const w of portals[j]) {
              const cand = base + dist[v][w];
              if (cand < dp[nmask][w]) {
                dp[nmask][w] = cand;
                prevMask[nmask][w] = mask;
                prevV[nmask][w] = v;
              }
            }
          }
        }
      }
      const full = size - 1;
      let endV = -1;
      let best = DP_INF;
      for (let v = 0; v < n; v++) {
        if (dp[full][v] === DP_INF) continue;
        const cand = dp[full][v] + dist[v][start];
        if (cand < best) {
          best = cand;
          endV = v;
        }
      }
      if (endV < 0) {
        return {
          ok: false,
          errors: [{ kind: 'internal', message: '连通性修补失败：断开平衡分量无法拼回出发地' }],
        };
      }
      repairCost = best;
      // 回溯门户访问顺序 p1 … pc；单分量门户直接自 start 到达，无前驱。
      const chain = [];
      let mask = full;
      let v = endV;
      while (mask !== 0) {
        chain.push(v);
        if ((mask & (mask - 1)) === 0) break; // 仅剩一个分量：其门户自 start 到达
        const pm = prevMask[mask][v];
        const pv = prevV[mask][v];
        mask = pm;
        v = pv;
      }
      chain.reverse(); // p1（自 start 到达）… pc（自其回 start）
      let from = start;
      for (const p of chain) {
        repairSegments.push({ from, to: p });
        from = p;
      }
      repairSegments.push({ from, to: start });
      for (const { from: a, to: b } of repairSegments) {
        for (const edge of paths[a][b]) occurrences.push({ edge, required: false });
      }
    }
  }

  if (shouldCancel && shouldCancel()) return { ...CANCELED };

  // ---- 展开欧拉闭环（Hierholzer，迭代栈，确定性边序） ------------------
  const adj = Array.from({ length: n }, () => []);
  occurrences.forEach((occ, id) => adj[edges[occ.edge].u].push(id));
  // 边序号升序：同长度闭环的输出唯一可复现（绝不影响长度最优性）。
  for (let v = 0; v < n; v++) {
    adj[v].sort((a, b) => occurrences[a].edge - occurrences[b].edge || Number(occurrences[a].required) - Number(occurrences[b].required));
  }

  const vStack = [start];
  const eStack = [];
  const reversed = [];
  while (vStack.length) {
    const v = vStack[vStack.length - 1];
    if (adj[v].length) {
      const id = adj[v].pop();
      vStack.push(edges[occurrences[id].edge].v);
      eStack.push(id);
    } else {
      vStack.pop();
      if (eStack.length) reversed.push(eStack.pop());
    }
  }
  const walk = reversed.reverse();

  // ---- 整数复核：边全部消费、首尾闭合、逐步相接、度数平衡 --------------
  if (walk.length !== occurrences.length) {
    return {
      ok: false,
      errors: [{ kind: 'internal', message: '欧拉展开未覆盖全部边：平衡流多重图不连通' }],
    };
  }
  const checkBalance = new Int32Array(n);
  let prev = start;
  for (const id of walk) {
    const e = edges[occurrences[id].edge];
    if (e.u !== prev) {
      return { ok: false, errors: [{ kind: 'internal', message: '欧拉闭环在展开处断接' }] };
    }
    checkBalance[e.u]++;
    checkBalance[e.v]--;
    prev = e.v;
  }
  if (prev !== start) {
    return { ok: false, errors: [{ kind: 'internal', message: '欧拉闭环未回到出发探针' }] };
  }
  for (let v = 0; v < n; v++) {
    if (checkBalance[v] !== 0) {
      return { ok: false, errors: [{ kind: 'internal', message: `探针 ${v} 入出度不平衡` }] };
    }
  }

  // 首次到达位置（1 基步号）。
  const firstPos = new Map();
  const steps = walk.map((id, i) => {
    const occ = occurrences[id];
    const e = edges[occ.edge];
    const suspect = selectedSet.has(occ.edge);
    let first = false;
    if (suspect && !firstPos.has(occ.edge)) {
      firstPos.set(occ.edge, i + 1);
      first = true;
    }
    return { edge: occ.edge, u: e.u, v: e.v, suspect, first };
  });

  const missing = selected.filter((idx) => !firstPos.has(idx));
  if (missing.length) {
    return { ok: false, errors: [{ kind: 'internal', message: `可疑边未被闭环覆盖：${missing.map((i) => i + 1).join('、')}` }] };
  }

  return {
    ok: true,
    start,
    selected,
    length: steps.length,
    steps,
    firstReach: selected
      .map((edge) => ({ edge, position: firstPos.get(edge) }))
      .sort((a, b) => a.edge - b.edge),
    balanceCost,
    repairCost,
  };
}

/**
 * 异步外壳（Web Worker 使用）：开算前后各让出一次事件循环，
 * 使“取消 / 新选择顶代”在重输入下也能及时生效。
 */
export async function planRemeasureRouteAsync(input, shouldCancel = null) {
  if (shouldCancel && shouldCancel()) return { ...CANCELED };
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (shouldCancel && shouldCancel()) return { ...CANCELED };
  return planRemeasureRoute(input, shouldCancel);
}
