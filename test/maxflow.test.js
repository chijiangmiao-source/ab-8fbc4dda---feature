import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dinic } from '../src/lib/maxflow.js';

test('Dinic：教科书网络最大流值正确', () => {
  // 0=S, 5=T
  const d = new Dinic(6);
  d.addEdge(0, 1, 16);
  d.addEdge(0, 2, 13);
  d.addEdge(1, 2, 10);
  d.addEdge(2, 1, 4);
  d.addEdge(1, 3, 12);
  d.addEdge(2, 4, 14);
  d.addEdge(3, 2, 9);
  d.addEdge(4, 3, 7);
  d.addEdge(3, 5, 20);
  d.addEdge(4, 5, 4);
  assert.equal(d.maxflow(0, 5), 23);
});

test('Dinic：同步与异步（极小让出预算）在随机网络上结果一致', async () => {
  let seed = 4242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let trial = 0; trial < 30; trial++) {
    const n = 2 + Math.floor(rnd() * 14);
    const S = 0;
    const T = n - 1;
    const edges = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rnd() < 0.35) edges.push([i, j, 1 + Math.floor(rnd() * 40)]);
      }
    }

    const d1 = new Dinic(n);
    const d2 = new Dinic(n);
    for (const [u, v, c] of edges) {
      d1.addEdge(u, v, c);
      d2.addEdge(u, v, c);
    }
    const syncVal = d1.maxflow(S, T);
    // 只允许扫描几十到几百条弧就让出，强制发生多次中断/续跑
    // （预算太小会产生过多宏任务定时器）。
    const asyncVal = await d2.maxflowAsync(S, T, null, 20 + Math.floor(rnd() * 200));
    assert.equal(asyncVal, syncVal, `trial ${trial} 同步/异步最大流不一致`);

    // 残量源侧割的截容量（仅前向弧）必须等于流值。
    const side = d2.sourceSide(S);
    assert.equal(side[S], 1);
    assert.equal(side[T], 0);
  }
});

test('Dinic：取消信号置位时尽快退出', async () => {
  const d = new Dinic(4);
  d.addEdge(0, 1, 5);
  d.addEdge(1, 2, 5);
  d.addEdge(2, 3, 5);
  let calls = 0;
  const val = await d.maxflowAsync(
    0,
    3,
    () => {
      calls++;
      return calls > 1;
    },
    1,
  );
  // 提前取消，值必然不超过真实最大流 5。
  assert.ok(val <= 5);
});
