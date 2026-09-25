import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, validateInput } from '../src/lib/solver.js';

/** 暴力枚举：在所有可行整数赋值中求最小代价，再取字典序最小 */
function bruteForce({ probes, edges, reference }) {
  const n = probes.length;
  const domains = probes.map((p) => {
    const a = [];
    for (let v = p.lo; v <= p.hi; v++) a.push(v);
    return a;
  });
  domains[reference] = [0];

  let best = Infinity;
  let bestX = null;
  const x = new Array(n);
  const rec = (i) => {
    if (i === n) {
      let c = 0;
      for (const e of edges) c += e.weight * Math.abs(x[e.v] - x[e.u] - e.target);
      if (c < best || (c === best && lexLess(x, bestX))) {
        best = c;
        bestX = x.slice();
      }
      return;
    }
    for (const v of domains[i]) {
      x[i] = v;
      rec(i + 1);
    }
  };
  rec(0);
  return { phases: bestX, cost: best };
}

function lexLess(a, b) {
  if (b === null) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function mk(probes, edges, reference = 0) {
  return { probes: probes.map(([lo, hi]) => ({ lo, hi })), edges, reference };
}

test('无矛盾树：代价为 0 且目标差全部满足', () => {
  const input = mk(
    [[0, 0], [-2, 2], [-2, 2]],
    [
      { u: 0, v: 1, target: 1, weight: 1 },
      { u: 0, v: 2, target: -1, weight: 2 },
      { u: 1, v: 2, target: -2, weight: 3 },
    ],
  );
  const r = solve(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases, [0, 1, -1]);
  assert.equal(r.cost, 0);
  for (const e of r.edges) assert.equal(e.contribution, 0);
});

test('闭环矛盾：高权闭环边决定最优，生成树局部累加不是最优', () => {
  // 三角形 0-1-2。按边录入顺序贪心选生成树 {0→1,0→2} 局部累加：
  // x=(0,1,1)，高权边 1→2（w=10）残差 -1，代价 10；
  // 精确最优 x=(0,1,2)：仅低权弦 0→2（w=1）残差 1，代价 1。
  const input = mk(
    [[0, 0], [0, 3], [0, 3]],
    [
      { u: 0, v: 1, target: 1, weight: 10 },
      { u: 0, v: 2, target: 1, weight: 1 },
      { u: 1, v: 2, target: 1, weight: 10 },
    ],
  );
  const r = solve(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases, [0, 1, 2]);
  assert.equal(r.cost, 1);
  assert.deepEqual(
    r.edges.map((e) => [e.actual, e.residual, e.contribution]),
    [
      [1, 0, 0],
      [2, 1, 1],
      [1, 0, 0],
    ],
  );

  // 显式对照：按录入顺序选生成树 {0→1,0→2} 逐边累加（参考点为根）。
  const x = [0, 0, 0];
  const used = new Set([0]);
  for (const e of input.edges) {
    if (used.has(e.u) && !used.has(e.v)) {
      x[e.v] = x[e.u] + e.target;
      used.add(e.v);
    }
  }
  const naiveCost = input.edges.reduce((s, e) => s + e.weight * Math.abs(x[e.v] - x[e.u] - e.target), 0);
  assert.deepEqual(x, [0, 1, 1]);
  assert.ok(naiveCost > r.cost, `局部累加代价 ${naiveCost} 应劣于精确最优 ${r.cost}`);
});

test('同成本时取按标识升序字典序最小：无边时所有探针取最小相位', () => {
  const input = mk(
    [
      [0, 0],
      [-2, 2],
      [-2, 2],
    ],
    [],
  );
  const r = solve(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases, [0, -2, -2]);
  assert.equal(r.cost, 0);
});

test('同成本时多个最优取字典序最小（平局链）', () => {
  // x1=x2 时代价 0，(0,0) 与 (1,1) 等价 → 取 (0,0)
  const input = mk(
    [
      [0, 0],
      [0, 1],
      [0, 1],
    ],
    [{ u: 1, v: 2, target: 0, weight: 1 }],
  );
  const r = solve(input);
  assert.deepEqual(r.phases, [0, 0, 0]);
  assert.equal(r.cost, 0);
});

test('权重改变最优解：与低权边相比更愿意违背高权边更少', () => {
  // 两个冲突观测 0→1：目标 0(w1) 与目标 2(w5)，x1∈[0,2]
  const input = mk(
    [
      [0, 0],
      [0, 2],
    ],
    [
      { u: 0, v: 1, target: 0, weight: 1 },
      { u: 0, v: 1, target: 2, weight: 5 },
    ],
  );
  const r = solve(input);
  // x1=2: |2|·1+0 = 2；x1=1: 1+5=6；x1=0: 0+10=10
  assert.deepEqual(r.phases, [0, 2]);
  assert.equal(r.cost, 2);
});

test('参考探针不在 0 号位置也正确钉零', () => {
  const input = mk(
    [
      [-3, 3],
      [0, 0],
      [-3, 3],
    ],
    [{ u: 1, v: 0, target: 2, weight: 3 }, { u: 1, v: 2, target: -1, weight: 4 }],
    1,
  );
  const r = solve(input);
  assert.equal(r.phases[1], 0);
  assert.deepEqual(r.phases, [2, 0, -1]);
  assert.equal(r.cost, 0);
});

test('自环边 u=v 只贡献常数代价 |t|·w，不改变最优位置', () => {
  const input = mk(
    [[0, 0], [-3, 3]],
    [
      { u: 0, v: 1, target: 2, weight: 5 },
      { u: 1, v: 1, target: 1, weight: 9 },
    ],
  );
  const r = solve(input);
  assert.deepEqual(r.phases, [0, 2]);
  assert.equal(r.cost, 9); // 0 + |1|·9
});

test('平行边（同向重复、双向都有）代价正确叠加', () => {
  const input = mk(
    [[0, 0], [-3, 3]],
    [
      { u: 0, v: 1, target: 2, weight: 1 },
      { u: 0, v: 1, target: 2, weight: 1 },
      { u: 1, v: 0, target: -2, weight: 1 },
    ],
  );
  const r = solve(input);
  assert.deepEqual(r.phases, [0, 2]);
  assert.equal(r.cost, 0);
});

test('负目标差与反向有向边：方向被严格区分', () => {
  const fwd = mk([[0, 0], [-2, 2]], [{ u: 0, v: 1, target: -2, weight: 1 }]);
  assert.deepEqual(solve(fwd).phases, [0, -2]);
  const rev = mk([[0, 0], [-2, 2]], [{ u: 1, v: 0, target: -2, weight: 1 }]);
  // x0 - x1 = -2 → x1 = 2
  assert.deepEqual(solve(rev).phases, [0, 2]);
});

test('随机小规模实例：与暴力枚举（含字典序）完全一致', () => {
  let seed = 20260924;
  const rnd = () => {
    // 确定性 LCG
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  for (let trial = 0; trial < 400; trial++) {
    const n = ri(2, 4);
    const reference = ri(0, n - 1);
    const probes = [];
    for (let i = 0; i < n; i++) {
      if (i === reference) {
        probes.push({ lo: ri(-2, 0), hi: ri(0, 2) });
      } else {
        const lo = ri(-2, 1);
        probes.push({ lo, hi: lo + ri(0, 3) });
      }
    }
    const m = ri(0, Math.min(6, n * (n - 1)));
    const edges = [];
    for (let e = 0; e < m; e++) {
      const u = ri(0, n - 1);
      let v = ri(0, n - 1);
      if (v === u) v = (v + 1) % n;
      edges.push({ u, v, target: ri(-3, 3), weight: ri(1, 4) });
    }
    const input = { probes, edges, reference };
    const got = solve(input);
    const want = bruteForce(input);
    assert.deepEqual(got.phases, want.phases, `trial ${trial} 赋值不一致: ${JSON.stringify(input)}`);
    assert.equal(got.cost, want.cost, `trial ${trial} 代价不一致`);
    let direct = 0;
    for (const e of edges) direct += e.weight * Math.abs(got.phases[e.v] - got.phases[e.u] - e.target);
    assert.equal(direct, want.cost);
  }
});

test('错误定位：范围为空', () => {
  const input = mk(
    [
      [0, 0],
      [2, 1],
    ],
    [],
  );
  const r = solve(input);
  assert.equal(r.ok, false);
  const err = r.errors.find((e) => e.kind === 'range' && e.index === 1);
  assert.ok(err, '应定位到 1 号探针的空范围');
});

test('错误定位：参考点越界（0 不在范围）', () => {
  const input = mk(
    [
      [1, 5],
      [-2, 2],
    ],
    [],
    0,
  );
  const r = solve(input);
  assert.equal(r.ok, false);
  const err = r.errors.find((e) => e.kind === 'reference' && e.field === 'range');
  assert.ok(err);
  assert.match(err.message, /参考探针 0/);
});

test('错误定位：边端点不存在', () => {
  const input = mk(
    [
      [0, 0],
      [-2, 2],
    ],
    [
      { u: 0, v: 7, target: 1, weight: 1 },
      { u: 3, v: 1, target: 0, weight: 2 },
    ],
  );
  const r = solve(input);
  assert.equal(r.ok, false);
  const ep = r.errors.filter((e) => e.kind === 'edge' && (e.field === 'u' || e.field === 'v'));
  assert.equal(ep.length, 2);
  assert.equal(ep[0].index, 0);
  assert.equal(ep[1].index, 1);
});

test('错误定位：权重非正整数、目标非整数、参考下标越界', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: -1, hi: 1 }],
    edges: [
      { u: 0, v: 1, target: 1, weight: 0 },
      { u: 0, v: 1, target: 0.5, weight: 2 },
    ],
    reference: 9,
  };
  const errors = validateInput(input);
  assert.ok(errors.some((e) => e.kind === 'edge' && e.field === 'weight'));
  assert.ok(errors.some((e) => e.kind === 'edge' && e.field === 'target'));
  assert.ok(errors.some((e) => e.kind === 'reference'));
});

test('探针数量越界（少于 2 或多于 40）被拒绝', () => {
  const one = { probes: [{ lo: 0, hi: 0 }], edges: [], reference: 0 };
  assert.equal(validateInput(one).some((e) => e.kind === 'count'), true);
  const many = {
    probes: Array.from({ length: 41 }, () => ({ lo: 0, hi: 1 })),
    edges: [],
    reference: 0,
  };
  assert.equal(validateInput(many).some((e) => e.kind === 'count'), true);
});

test('超宽整数范围：单探针 20 万个阈值层，迭代 Dinic 不栈溢出且结论精确', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: -100000, hi: 100000 }],
    edges: [
      { u: 0, v: 1, target: 50000, weight: 3 },
      { u: 0, v: 1, target: 50002, weight: 1 },
    ],
    reference: 0,
  };
  const t0 = Date.now();
  const r = solve(input);
  assert.ok(Date.now() - t0 < 15000, `求解耗时过长：${Date.now() - t0}ms`);
  assert.equal(r.ok, true);
  // x=50000: 0 + 2·1 = 2；x=50001: 3 + 1 = 4；x=50002: 6 + 0 = 6
  assert.equal(r.phases[1], 50000);
  assert.equal(r.cost, 2);
});

test('较大实例：40 探针、宽范围、多边仍快速精确求解', () => {
  const n = 40;
  const probes = [{ lo: 0, hi: 0 }, ...Array.from({ length: n - 1 }, () => ({ lo: -50, hi: 50 }))];
  const edges = [];
  let seed = 99;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 1; i < n; i++) {
    edges.push({ u: i - 1, v: i, target: 1, weight: 3 });
  }
  for (let k = 0; k < 60; k++) {
    const u = Math.floor(rnd() * n);
    const v = Math.floor(rnd() * n);
    if (u !== v) edges.push({ u, v, target: Math.floor(rnd() * 7) - 3, weight: 1 + Math.floor(rnd() * 5) });
  }
  const t0 = Date.now();
  const r = solve({ probes, edges, reference: 0 });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 10000, '应在合理时间内完成');
  assert.equal(r.phases[0], 0);
  let direct = 0;
  for (const e of r.edges) direct += e.contribution;
  assert.equal(direct, r.cost);
});
