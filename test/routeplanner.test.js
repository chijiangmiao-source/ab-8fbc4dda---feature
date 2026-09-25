/**
 * 复测闭环规划测试：
 *  1) 验收样例：存在单向绕行，最近边优先贪心（8 步）严格长于
 *     最短过渡路 + 整数最小费用平衡 + 欧拉展开的最优闭环（5 步）；
 *  2) 闭环合法性（从出发点起止、逐步衔接、只走录入的有向边、可疑边全覆盖）；
 *  3) 不可达时指出“从何探针不能到达何处”；
 *  4) 输入校验（数量上限、重复勾选、越界）；
 *  5) 随机实例对状态空间暴力最短路（(探针, 已覆盖集合) BFS）的对照。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRoute, validateRouteInput } from '../src/lib/routeplanner.js';

// ---- 验收样例：单向绕行，最近边优先会多走 ----------------------------------
// 有向结构：1→2→3→0→3→1 是单向“洋流”；可疑边 0→3 与 3→1。
// 从探针 1 出发，可疑边 3→1 的尾（探针 3）看似最近（2 跳），
// 最近边优先贪心：1→2→3→1（抢 3→1）再 1→2→3→0→3（追 0→3）再 3→1 回家 = 8 步；
// 最优闭环顺流而下：1→2→3→0→3→1 = 5 步。
const SAMPLE = {
  n: 4,
  edges: [
    { u: 0, v: 3 }, // 0 可疑
    { u: 3, v: 1 }, // 1 可疑
    { u: 0, v: 2 }, // 2
    { u: 2, v: 3 }, // 3
    { u: 1, v: 2 }, // 4
    { u: 3, v: 0 }, // 5
  ],
  required: [0, 1],
  start: 1,
};

/** 逐边最近贪心（仅测试对照用）：反复走向最近未覆盖可疑边的尾并穿过，最后回家 */
function greedyNearestFirst(n, edges, required, start) {
  const adj = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => adj[e.u].push(i));
  const bfs = (s) => {
    const d = new Array(n).fill(Infinity);
    d[s] = 0;
    const q = [s];
    let h = 0;
    while (h < q.length) {
      const v = q[h++];
      for (const ei of adj[v]) {
        const to = edges[ei].v;
        if (d[to] === Infinity) {
          d[to] = d[v] + 1;
          q.push(to);
        }
      }
    }
    return d;
  };
  const dist = Array.from({ length: n }, (_, s) => bfs(s));
  let cur = start;
  let len = 0;
  const rem = new Set(required);
  while (rem.size) {
    let best = -1;
    let bd = Infinity;
    for (const r of rem) {
      const d = dist[cur][edges[r].u];
      if (d < bd || (d === bd && r < best)) {
        bd = d;
        best = r;
      }
    }
    if (bd === Infinity) return Infinity;
    len += bd + 1;
    cur = edges[best].v;
    rem.delete(best);
  }
  return len + dist[cur][start];
}

/** 校验规划结果是一条合法闭环并覆盖全部可疑边 */
function assertValidTour(result, input) {
  assert.equal(result.ok, true);
  const { steps, start } = result;
  assert.ok(steps.length > 0);
  assert.equal(steps[0].u, start, '闭环必须从出发探针出发');
  assert.equal(steps[steps.length - 1].v, start, '闭环必须回到出发探针');
  for (let i = 1; i < steps.length; i++) {
    assert.equal(steps[i].u, steps[i - 1].v, `第 ${i + 1} 步必须在探针处衔接`);
  }
  for (const st of steps) {
    const e = input.edges[st.edge];
    assert.equal(st.u, e.u, `第 ${st.step} 步经过的必须是录入边（起点）`);
    assert.equal(st.v, e.v, `第 ${st.step} 步经过的必须是录入边（终点）`);
    assert.equal(st.suspicious, input.required.includes(st.edge));
  }
  assert.equal(result.length, steps.length);
  // 可疑边全覆盖 + 首次到达位置准确
  const firstSeen = new Map();
  steps.forEach((st) => {
    if (st.suspicious && !firstSeen.has(st.edge)) firstSeen.set(st.edge, st.step);
  });
  assert.equal(firstSeen.size, input.required.length, '每条可疑边至少经过一次');
  assert.equal(result.requiredFirstHit.length, input.required.length);
  for (const hit of result.requiredFirstHit) {
    assert.equal(firstSeen.get(hit.edge), hit.step, `可疑边 ${hit.edge + 1} 的首次到达位置`);
    assert.equal(hit.u, input.edges[hit.edge].u);
    assert.equal(hit.v, input.edges[hit.edge].v);
  }
}

test('验收样例：单向绕行下最优闭环 5 步，最近边优先贪心 8 步', () => {
  const r = planRoute(SAMPLE);
  assertValidTour(r, SAMPLE);
  assert.equal(r.length, 5);
  assert.equal(r.balanceCost, 3); // 过渡路 1→2→3→0 共 3 跳
  // 完整边序：1→2, 2→3, 3→0, 0→3(可疑), 3→1(可疑)
  assert.deepEqual(
    r.steps.map((s) => s.edge),
    [4, 3, 5, 0, 1],
  );
  assert.deepEqual(
    r.requiredFirstHit.map((h) => [h.edge, h.step]),
    [
      [0, 4],
      [1, 5],
    ],
  );
  // 对照：最近边优先贪心在该样例上必然多走（8 > 5）。
  assert.equal(greedyNearestFirst(SAMPLE.n, SAMPLE.edges, SAMPLE.required, SAMPLE.start), 8);
});

test('确定性：同一输入两次规划结果完全一致', () => {
  assert.deepEqual(planRoute(SAMPLE), planRoute(SAMPLE));
});

test('简单有向环：全部边可疑时闭环即环本身', () => {
  const input = {
    n: 3,
    edges: [
      { u: 0, v: 1 },
      { u: 1, v: 2 },
      { u: 2, v: 0 },
    ],
    required: [0, 1, 2],
    start: 0,
  };
  const r = planRoute(input);
  assertValidTour(r, input);
  assert.equal(r.length, 3);
  assert.equal(r.balanceCost, 0); // 已平衡，无需任何过渡
});

test('单条可疑自环边', () => {
  const input = { n: 2, edges: [{ u: 0, v: 0 }], required: [0], start: 0 };
  const r = planRoute(input);
  assertValidTour(r, input);
  assert.equal(r.length, 1);
  assert.deepEqual(r.requiredFirstHit, [{ edge: 0, u: 0, v: 0, step: 1 }]);
});

test('出发点不与可疑边相邻时仍被纳入闭环（联合配平）', () => {
  // 可疑边在 1→2→3→1 环上，出发点 0 经 0→1 单向连接、3→0 回家。
  const input = {
    n: 4,
    edges: [
      { u: 0, v: 1 },
      { u: 1, v: 2 },
      { u: 2, v: 3 },
      { u: 3, v: 0 },
    ],
    required: [1, 2],
    start: 0,
  };
  const r = planRoute(input);
  assertValidTour(r, input);
  assert.equal(r.length, 4); // 0→1→2→3→0
});

test('两个平衡块经单向桥挂接为一条闭环', () => {
  // 块 A：0⇄1；块 B：2⇄3；桥 1→2 与 3→0。可疑边 0→1 与 2→3。
  const input = {
    n: 4,
    edges: [
      { u: 0, v: 1 },
      { u: 1, v: 0 },
      { u: 2, v: 3 },
      { u: 3, v: 2 },
      { u: 1, v: 2 },
      { u: 3, v: 0 },
    ],
    required: [0, 2],
    start: 0,
  };
  const r = planRoute(input);
  assertValidTour(r, input);
  assert.equal(r.length, 4); // 0→1→2→3→0
});

test('不可达：可疑边出发端到不了 / 终点回不来，均指明起止探针', () => {
  // 0 与 {1,2} 完全不连通。
  const r1 = planRoute({
    n: 3,
    edges: [
      { u: 1, v: 2 },
      { u: 2, v: 1 },
    ],
    required: [0],
    start: 0,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.unreachable.length, 2);
  assert.ok(r1.unreachable.some((e) => e.from === 0 && e.to === 1 && /从探针 0 无法.*到达探针 1/.test(e.message)));
  assert.ok(r1.unreachable.some((e) => e.from === 2 && e.to === 0 && /无法.*回到出发探针 0/.test(e.message)));

  // 能到尾、但头回不来（单向死胡同）。
  const r2 = planRoute({
    n: 3,
    edges: [
      { u: 0, v: 1 },
      { u: 1, v: 2 },
    ],
    required: [1],
    start: 0,
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.unreachable.length, 1);
  assert.equal(r2.unreachable[0].from, 2);
  assert.equal(r2.unreachable[0].to, 0);
  assert.match(r2.unreachable[0].message, /可疑边 2（1→2）/);
});

test('输入校验：上限 24 条、重复勾选、越界、空选择', () => {
  const edges = Array.from({ length: 30 }, () => ({ u: 0, v: 1 }));
  assert.ok(validateRouteInput({ n: 2, edges, required: edges.map((_, i) => i), start: 0 }).some((e) => /24/.test(e.message)));
  assert.ok(validateRouteInput({ n: 2, edges, required: [], start: 0 }).some((e) => /至少/.test(e.message)));
  assert.ok(validateRouteInput({ n: 2, edges, required: [0, 0], start: 0 }).some((e) => /重复/.test(e.message)));
  assert.ok(validateRouteInput({ n: 2, edges, required: [99], start: 0 }).some((e) => /不存在/.test(e.message)));
  assert.ok(validateRouteInput({ n: 2, edges, required: [0], start: 5 }).some((e) => e.kind === 'start'));
  assert.ok(validateRouteInput({ n: 2, edges: [{ u: 0, v: 9 }], required: [0], start: 0 }).some((e) => e.kind === 'edge'));
  assert.ok(validateRouteInput({ n: 1, edges, required: [0], start: 0 }).some((e) => e.kind === 'count'));
});

test('协作式取消：取消信号置位时返回 canceled', () => {
  const r = planRoute(SAMPLE, () => true);
  assert.deepEqual(r, { ok: false, canceled: true });
});

// ---- 随机对照：状态空间 (探针, 覆盖集合) 暴力最短路 -------------------------
/** 暴力最优：在 (顶点, 已覆盖可疑边掩码) 状态空间 BFS 求最短闭环 */
function bruteForceOptimal(n, edges, required, start) {
  const bit = new Map(required.map((r, i) => [r, 1 << i]));
  const full = (1 << required.length) - 1;
  const adj = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => adj[e.u].push(i));
  const seen = new Set([`${start},0`]);
  let frontier = [[start, 0]];
  let depth = 0;
  while (frontier.length) {
    const next = [];
    for (const [v, mask] of frontier) {
      for (const ei of adj[v]) {
        const w = edges[ei].v;
        const m = bit.has(ei) ? mask | bit.get(ei) : mask;
        if (w === start && m === full) return depth + 1;
        const key = `${w},${m}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push([w, m]);
        }
      }
    }
    frontier = next;
    depth++;
  }
  return Infinity;
}

test('随机实例对照暴力最优：结果合法且长度不差于暴力下界', () => {
  let seed = 20260925;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let feasible = 0;
  let infeasible = 0;
  let exactOptimal = 0;
  // 随机稀疏小图多数不连通，按可行性筛选，凑足可行样本。
  for (let iter = 0; iter < 6000 && feasible < 300; iter++) {
    const n = 2 + Math.floor(rnd() * 6); // 2..7
    const m = n + Math.floor(rnd() * (2 * n));
    const edges = [];
    for (let i = 0; i < m; i++) {
      const u = Math.floor(rnd() * n);
      let v = Math.floor(rnd() * n);
      if (v === u && rnd() < 0.8) v = (v + 1) % n; // 少量自环
      edges.push({ u, v });
    }
    const k = 1 + Math.floor(rnd() * Math.min(4, m));
    const reqSet = new Set();
    while (reqSet.size < k) reqSet.add(Math.floor(rnd() * m));
    const required = [...reqSet];
    const start = Math.floor(rnd() * n);
    const input = { n, edges, required, start };

    const brute = bruteForceOptimal(n, edges, required, start);
    const r = planRoute(input);
    if (brute === Infinity) {
      assert.equal(r.ok, false, `实例 ${iter}：暴力判定不可行，规划必须报告不可达`);
      assert.ok(r.unreachable.length > 0);
      infeasible++;
      continue;
    }
    assertValidTour(r, input);
    assert.ok(r.length >= brute, `实例 ${iter}：闭环长度不得优于暴力最优下界`);
    // 未发生平衡块挂接时，最小费用平衡闭环即精确最优。
    if (r.length === required.length + r.balanceCost) {
      assert.equal(r.length, brute, `实例 ${iter}：无挂接时必须等于暴力最优`);
      exactOptimal++;
    }
    feasible++;
  }
  assert.ok(feasible >= 300, `可行随机实例数量不足（${feasible}），对照无效`);
  assert.ok(infeasible >= 20, '不可行随机实例样本不足');
  assert.ok(exactOptimal >= 150, '精确最优对照样本不足');
});
