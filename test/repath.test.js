/**
 * 有向复测闭环规划器测试。
 *
 * 覆盖：
 *  - 反贪心验收样例（存在单向绕行，最近边优先会多走）：断言规划长度 5，
 *    最近边优先只得 7；
 *  - 数百组随机有向图上，与“允许最短路段顺带覆盖”的精确最优步行
 *    （记忆化枚举，仅小规模参照用）逐条对照长度；
 *  - 闭环闭合、逐步相接、只沿录入边正向前进、可疑边全覆盖、
 *    首次到达位置正确；
 *  - 不可达诊断（从何探针不能到达何处）、输入校验（0 / >24 勾选等）、
 *    断开平衡分量拼回、协作式取消。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planRemeasureRoute,
  planRemeasureRouteAsync,
  shortestTransitionPaths,
  validateRouteInput,
} from '../src/lib/repath.js';

const INF = 0x7fffffff;

/** 参照实现：与生产代码相同的无权 BFS（测试侧独立再写一遍）。 */
function refBfs(n, adj, s) {
  const dist = new Array(n).fill(Infinity);
  const prevV = new Array(n).fill(-1);
  const prevE = new Array(n).fill(-1);
  dist[s] = 0;
  const q = [s];
  let h = 0;
  while (h < q.length) {
    const v = q[h++];
    for (const { v: w, edge } of adj[v]) {
      if (dist[w] === Infinity) {
        dist[w] = dist[v] + 1;
        prevV[w] = v;
        prevE[w] = edge;
        q.push(w);
      }
    }
  }
  const path = (t) => {
    const es = [];
    let v = t;
    while (v !== s) {
      es.push(prevE[v]);
      v = prevV[v];
    }
    return es.reverse();
  };
  return { dist, path };
}

/**
 * 精确最优闭环长度（小规模参照）：记忆化枚举“下一条刻意走的可疑边”，
 * 段内取有向最短路，且该最短路顺带经过的可疑边也算已覆盖；
 * 最后一段最短路回 depot 同样允许顺带覆盖。
 * 生产代码不得枚举路线——这里仅作测试对照。
 */
function optimalWalk(n, edges, selected, depot) {
  const adj = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => adj[e.u].push({ v: e.v, edge: i }));
  const bfs = [];
  for (let s = 0; s < n; s++) bfs.push(refBfs(n, adj, s));
  for (const e of selected) {
    if (bfs[depot].dist[edges[e].u] === Infinity || bfs[edges[e].v].dist[depot] === Infinity) {
      return null; // 无可行闭环
    }
  }
  const full = (1 << selected.length) - 1;
  const memo = new Map();
  const coverOnPath = (edgeSeq) => {
    let mask = 0;
    for (const e of edgeSeq) {
      const j = selected.indexOf(e);
      if (j >= 0) mask |= 1 << j;
    }
    return mask;
  };
  const solve = (cur, mask) => {
    // 候选 A：直接沿最短路回 depot；若回程顺带覆盖完所有可疑边即合法。
    const back = bfs[cur].path(depot);
    let best = (mask | coverOnPath(back)) === full ? back.length : Infinity;
    // 候选 B：再刻意走向一条未覆盖可疑边（其前段最短路也可顺带覆盖）。
    for (let j = 0; j < selected.length; j++) {
      if (mask & (1 << j)) continue;
      const e = edges[selected[j]];
      const d = bfs[cur].dist[e.u];
      if (d === Infinity) continue;
      const seg = bfs[cur].path(e.u).concat(selected[j]);
      const c = seg.length + solve(e.v, mask | coverOnPath(seg));
      if (c < best) best = c;
    }
    const key = cur * (full + 1) + mask;
    memo.set(key, best);
    return best;
  };
  return solve(depot, 0);
}

/** 对规划结果做结构性校验，返回 {len, covered}。 */
function assertWellFormed(input, r) {
  assert.equal(r.ok, true);
  assert.equal(r.start, input.start);
  let cur = input.start;
  const count = new Map();
  for (const s of r.steps) {
    assert.equal(s.u, cur, '每步必须从上一步终点出发');
    assert.equal(s.v, input.edges[s.edge].v, '只能沿录入边的正向前进');
    assert.equal(s.u, input.edges[s.edge].u);
    count.set(s.edge, (count.get(s.edge) || 0) + 1);
    cur = s.v;
  }
  assert.equal(cur, input.start, '闭环必须回到出发探针');
  assert.equal(r.length, r.steps.length);
  for (const idx of input.selected) {
    assert.ok((count.get(idx) || 0) >= 1, `可疑边 ${idx + 1} 至少经过一次`);
  }
  // 首次到达位置与边序一致。
  for (const f of r.firstReach) {
    const step = r.steps[f.position - 1];
    assert.equal(step.edge, f.edge);
    assert.ok(step.first);
    assert.ok(!r.steps.slice(0, f.position - 1).some((s) => s.edge === f.edge));
  }
  assert.equal(r.length - input.selected.length, r.balanceCost + r.repairCost);
  return count;
}

// 固定的“存在单向绕行且最近边优先会多走”验收样例。
const DETOUR = {
  count: 5,
  edges: [
    { u: 1, v: 2 }, { u: 3, v: 2 }, { u: 0, v: 1 }, { u: 0, v: 3 },
    { u: 3, v: 0 }, { u: 1, v: 0 }, { u: 3, v: 1 }, { u: 2, v: 4 },
    { u: 4, v: 2 }, { u: 3, v: 4 }, { u: 4, v: 0 }, { u: 2, v: 3 },
  ],
  start: 0,
  selected: [3, 5, 11], // 0→3、1→0、2→3
};

test('反贪心验收：单向绕行样例上规划长度为精确最短 5', () => {
  const r = planRemeasureRoute(DETOUR);
  assertWellFormed(DETOUR, r);
  assert.equal(r.length, 5);
  assert.deepEqual(
    r.steps.map((s) => s.edge),
    [3, 1, 11, 6, 5],
  );
  // 三条可疑边的首次到达位置。
  assert.deepEqual(
    r.firstReach.sort((a, b) => a.position - b.position).map((f) => f.edge),
    [3, 11, 5],
  );
  assert.deepEqual(r.firstReach.map((f) => f.position).sort((a, b) => a - b), [1, 3, 5]);
});

test('同一样例上“最近边优先”只能走出 7 步（证明非逐边贪心可达）', () => {
  const { dist } = shortestTransitionPaths(DETOUR.count, DETOUR.edges);
  // 在测试侧如实现一个最近边优先策略：每步走向“起点离当前探针最近”的
  // 未覆盖可疑边（距离并列取录入序号较小者），走完后再最短路回出发点。
  const remaining = new Set(DETOUR.selected);
  let cur = DETOUR.start;
  let len = 0;
  const order = [];
  while (remaining.size) {
    let pick = null;
    for (const e of remaining) {
      const d = dist[cur][DETOUR.edges[e].u];
      if (pick === null || d < pick.d || (d === pick.d && e < pick.e)) pick = { e, d };
    }
    order.push(pick.e);
    len += pick.d + 1;
    cur = DETOUR.edges[pick.e].v;
    remaining.delete(pick.e);
  }
  len += dist[cur][DETOUR.start];
  assert.deepEqual(order, [3, 5, 11]);
  assert.equal(len, 7);
  assert.ok(len > 5, '最近边优先多走两步，恰是验收要排除的行为');
});

/** 可疑边（忽略方向）的弱连通分量；返回 分量代表 → 顶点集。 */
function requiredComponents(n, edges, selected) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  };
  for (const idx of selected) {
    const a = find(edges[idx].u);
    const b = find(edges[idx].v);
    if (a !== b) p[b] = a;
  }
  const comps = new Map();
  for (const idx of selected) {
    for (const v of [edges[idx].u, edges[idx].v]) {
      const r = find(v);
      if (!comps.has(r)) comps.set(r, new Set());
      comps.get(r).add(v);
    }
  }
  return comps;
}

test('随机有向图：单一可疑边分量时规划长度与精确最优步行一致', () => {
  // 规格规定的“最短过渡路 → 最小费用平衡 → 欧拉展开”管线在可疑边弱连通
  // （且出发探针位于该分量顶点集）时给出精确最短闭环：平衡流的过渡弧端点
  // 全部落在同一分量，合并后的平衡多重图必连通，无需事后拼回。
  let seed = 20260925;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let checked = 0;
  for (let trial = 0; trial < 2000 && checked < 200; trial++) {
    const n = 3 + Math.floor(rnd() * 5);
    const edges = [];
    const seen = new Set();
    const m = Math.min(n * (n - 1), n + Math.floor(rnd() * n * 2));
    let guard = 0;
    while (edges.length < m && guard++ < m * 12) {
      const u = Math.floor(rnd() * n);
      const v = Math.floor(rnd() * n);
      if (u === v || seen.has(u * n + v)) continue;
      seen.add(u * n + v);
      edges.push({ u, v });
    }
    const k = 2 + Math.floor(rnd() * (Math.min(5, edges.length) - 1));
    const pool = edges.map((_, i) => i);
    const selected = [];
    for (let i = 0; i < k; i++) {
      selected.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
    // 出发探针取可疑边端点，保证其位于可疑边弱分量内。
    const endpoints = [...new Set(selected.flatMap((i) => [edges[i].u, edges[i].v]))];
    const start = endpoints[Math.floor(rnd() * endpoints.length)];
    const comps = requiredComponents(n, edges, selected);
    if (comps.size !== 1) continue; // 仅在管线精确成立的连通类上对照
    const input = { count: n, edges, start, selected };
    const opt = optimalWalk(n, edges, selected, start);
    const r = planRemeasureRoute(input);
    if (opt === null) {
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.unreachable) && r.unreachable.length > 0);
      continue;
    }
    assertWellFormed(input, r);
    assert.equal(r.repairCost, 0, '单一可疑边分量不应触发拼回');
    assert.equal(r.length, opt, `trial ${trial}：${JSON.stringify({ n, edges, selected, start })}`);
    checked++;
  }
  assert.ok(checked >= 100, `随机可行实例数量不足：${checked}`);
});

test('随机有向图（任意分量结构）：闭环结构合法、不短于精确最优、覆盖全部可疑边', () => {
  let seed = 424242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rnd() * 5);
    const edges = [];
    const seen = new Set();
    const m = Math.min(n * (n - 1), 1 + Math.floor(rnd() * n * 2));
    let guard = 0;
    while (edges.length < m && guard++ < m * 12) {
      const u = Math.floor(rnd() * n);
      const v = Math.floor(rnd() * n);
      if (u === v || seen.has(u * n + v)) continue;
      seen.add(u * n + v);
      edges.push({ u, v });
    }
    if (!edges.length) continue;
    const k = 1 + Math.floor(rnd() * Math.min(5, edges.length));
    const pool = edges.map((_, i) => i);
    const selected = [];
    for (let i = 0; i < k; i++) {
      selected.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
    const start = Math.floor(rnd() * n);
    const input = { count: n, edges, start, selected };
    const opt = optimalWalk(n, edges, selected, start);
    const r = planRemeasureRoute(input);
    if (opt === null) {
      assert.equal(r.ok, false);
      assert.ok(r.unreachable.length > 0);
    } else {
      assertWellFormed(input, r);
      // 管线输出始终合法且不短于真正最优（任何合法闭环长度 ≥ 最优）。
      assert.ok(r.length >= opt, `trial ${trial}：输出比最优还短，计算有误`);
    }
  }
});

test('不可达：精确指出从何探针不能到达何处，且不产出路线', () => {
  // 0→1→2 是单向链：可疑边 1→2 走完后无法从 2 回到 0。
  let r = planRemeasureRoute({
    count: 3,
    edges: [{ u: 0, v: 1 }, { u: 1, v: 2 }],
    start: 0,
    selected: [1],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unreachable, [
    {
      edge: 1,
      from: 2,
      to: 0,
      detail: '可疑边 2（1→2）到达探针 2 后，无法沿有向边回到出发探针 0',
    },
  ]);

  // 出发探针根本到不了可疑边起点。
  r = planRemeasureRoute({
    count: 3,
    edges: [{ u: 2, v: 1 }, { u: 1, v: 2 }, { u: 2, v: 0 }],
    start: 0,
    selected: [0],
  });
  assert.equal(r.ok, false);
  assert.equal(r.unreachable[0].from, 0);
  assert.equal(r.unreachable[0].to, 2);
});

test('校验：空勾选、超过 24 条、重复勾选、出发探针越界', () => {
  const base = {
    count: 2,
    edges: [{ u: 0, v: 1 }, { u: 1, v: 0 }],
    start: 0,
  };
  assert.ok(validateRouteInput({ ...base, selected: [] }).some((e) => e.kind === 'selected'));
  assert.ok(
    validateRouteInput({ ...base, selected: Array.from({ length: 25 }, () => 0) }).some(
      (e) => e.kind === 'selected',
    ),
  );
  assert.ok(validateRouteInput({ ...base, selected: [0, 0] }).some((e) => e.kind === 'selected'));
  assert.ok(validateRouteInput({ ...base, selected: [0], start: 5 }).some((e) => e.kind === 'start'));
  assert.ok(
    validateRouteInput({ ...base, selected: [9] }).some((e) => e.kind === 'selected'),
  );
});

test('断开的自平衡可疑环经由最短访问步行拼回（子集 DP 修补）', () => {
  // 可疑边 2→3、3→2 自身入出度平衡；只能经 0→2 去、3→0 回。
  const input = {
    count: 4,
    edges: [
      { u: 0, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 2 },
      { u: 2, v: 3 }, { u: 3, v: 2 }, { u: 3, v: 0 },
    ],
    start: 0,
    selected: [3, 4],
  };
  const r = planRemeasureRoute(input);
  assertWellFormed(input, r);
  assert.equal(r.length, 5); // 0→2→3→2→3→0
  assert.equal(r.balanceCost, 0);
  assert.equal(r.repairCost, 3);
});

test('多个断开平衡分量：一次访问步行顺路覆盖，不各自往返', () => {
  // 可疑边：环 2↔3 与环 4↔5；去程走廊 0→1→2→4，回程 3→5→0。
  const input = {
    count: 6,
    edges: [
      { u: 0, v: 1 }, { u: 1, v: 2 }, { u: 2, v: 4 },
      { u: 2, v: 3 }, { u: 3, v: 2 }, // 环 A（可疑）
      { u: 4, v: 5 }, { u: 5, v: 4 }, // 环 B（可疑）
      { u: 3, v: 5 }, { u: 5, v: 0 },
    ],
    start: 0,
    selected: [3, 4, 5, 6],
  };
  const opt = optimalWalk(input.count, input.edges, input.selected, 0);
  const r = planRemeasureRoute(input);
  assertWellFormed(input, r);
  assert.equal(r.length, opt);
  // 分别独立往返需要 (0→…→2…→0)×2，必比一次顺访长：
  assert.ok(r.length < 2 * (input.edges.length));
});

test('可疑边可在闭环中重复经过，首次到达位置只标记第一次', () => {
  const input = {
    count: 3,
    edges: [
      { u: 0, v: 1 }, { u: 1, v: 2 }, { u: 2, v: 1 }, { u: 1, v: 0 },
    ],
    start: 0,
    selected: [0, 1],
  };
  const r = planRemeasureRoute(input);
  assertWellFormed(input, r);
  assert.equal(r.length, 4);
  const e0Steps = r.steps.filter((s) => s.edge === 0);
  assert.equal(e0Steps.length, 1);
  assert.equal(e0Steps[0].first, true);
});

test('取消信号置位时返回 canceled 且不产生结论', async () => {
  const input = {
    count: 40,
    edges: (() => {
      const es = [];
      for (let u = 0; u < 40; u++) for (let v = 0; v < 40; v++) if (u !== v) es.push({ u, v });
      return es;
    })(),
    start: 0,
    selected: [0, 1, 2, 3],
  };
  const r = await planRemeasureRouteAsync(input, () => true);
  assert.deepEqual(r, { ok: false, canceled: true });
});
