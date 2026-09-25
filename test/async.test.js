import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveAsync } from '../src/lib/solver.js';

test('solveAsync 与同步求解结果一致', async () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: -10, hi: 10 }, { lo: -10, hi: 10 }, { lo: -10, hi: 10 }],
    edges: [
      { u: 0, v: 1, target: 3, weight: 5 },
      { u: 1, v: 2, target: 2, weight: 7 },
      { u: 0, v: 2, target: 6, weight: 1 },
      { u: 2, v: 3, target: -4, weight: 2 },
      { u: 3, v: 0, target: 1, weight: 3 },
    ],
    reference: 0,
  };
  const r = await solveAsync(input);
  assert.equal(r.ok, true);
  let direct = 0;
  for (const e of input.edges) {
    direct += e.weight * Math.abs(r.phases[e.v] - r.phases[e.u] - e.target);
  }
  assert.equal(direct, r.cost);
  assert.equal(r.phases[0], 0);
});

test('solveAsync 在取消信号置位时返回 canceled 且不产生结论', async () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, ...Array.from({ length: 39 }, () => ({ lo: -100, hi: 100 }))],
    edges: Array.from({ length: 120 }, (_, i) => ({
      u: i % 40,
      v: (i * 7 + 3) % 40 === (i % 40) ? ((i * 7 + 3) % 40) + 1 : (i * 7 + 3) % 40,
      target: (i % 7) - 3,
      weight: (i % 5) + 1,
    })),
    reference: 0,
  };
  // 立刻取消：甚至在第一次 BFS 之前就应退出。
  const r1 = await solveAsync(input, () => true);
  assert.deepEqual(r1, { ok: false, canceled: true });

  // 让出若干次后取消：用计数器模拟“草稿变更”。
  let checks = 0;
  const r2 = await solveAsync(
    { ...input, edges: input.edges.slice() },
    () => {
      checks++;
      return checks > 3;
    },
    500,
  );
  assert.equal(r2.ok, false);
  assert.equal(r2.canceled, true);
});

test('solveAsync 校验错误仍然正常返回（不被取消逻辑吞掉）', async () => {
  const r = await solveAsync({
    probes: [{ lo: 0, hi: 0 }, { lo: 3, hi: 1 }],
    edges: [{ u: 0, v: 9, target: 0, weight: -2 }],
    reference: 0,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.kind === 'range'));
  assert.ok(r.errors.some((e) => e.kind === 'edge'));
});
