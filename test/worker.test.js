/**
 * Worker 协议端到端测试：用 worker_threads + self 垫片加载真实的
 * src/worker/solver.worker.js，验证：
 *  1) 正常 solve → done，结果正确；
 *  2) 草稿替换（新 solve 顶掉旧 run）后，旧 run 的结果永不回传；
 *  3) 显式 cancel 回 canceled；silent cancel 不回执。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

const workerUrl = new URL('../src/worker/solver.worker.js', import.meta.url).href;

const BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
let handler = null;
const queue = [];
parentPort.on('message', (data) => {
  if (handler) handler({ data });
  else queue.push(data);
});
globalThis.self = {
  postMessage: (m) => parentPort.postMessage(m),
  set onmessage(fn) {
    handler = fn;
    while (queue.length) fn({ data: queue.shift() });
  },
  get onmessage() { return handler; },
};
import(${JSON.stringify(workerUrl)});
`;

function spawnWorker() {
  const w = new Worker(BOOTSTRAP, { eval: true });
  const inbox = [];
  const waiters = [];
  w.on('message', (m) => {
    if (waiters.length) waiters.shift()(m);
    else inbox.push(m);
  });
  const recv = (timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift());
      const timer = setTimeout(() => reject(new Error('等待 Worker 消息超时')), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  const quiet = (ms = 400) =>
    new Promise((resolve) => setTimeout(resolve, ms)).then(() => {
      if (inbox.length) throw new Error(`预期无消息，但收到：${JSON.stringify(inbox)}`);
    });
  return { w, recv, quiet, post: (m) => w.postMessage(m) };
}

const sampleA = {
  probes: [{ lo: 0, hi: 0 }, { lo: 0, hi: 3 }, { lo: 0, hi: 3 }],
  edges: [
    { u: 0, v: 1, target: 1, weight: 10 },
    { u: 0, v: 2, target: 1, weight: 1 },
    { u: 1, v: 2, target: 1, weight: 10 },
  ],
  reference: 0,
};

test('Worker：正常复核返回 done 且结论精确', async () => {
  const s = spawnWorker();
  s.post({ type: 'solve', id: 1, input: sampleA });
  const m = await s.recv();
  assert.equal(m.type, 'done');
  assert.equal(m.id, 1);
  assert.equal(m.result.ok, true);
  assert.deepEqual(m.result.phases, [0, 1, 2]);
  assert.equal(m.result.cost, 1);
  await s.w.terminate();
});

test('Worker：校验失败以 done 返回错误而不崩溃', async () => {
  const s = spawnWorker();
  s.post({
    type: 'solve',
    id: 7,
    input: { probes: [{ lo: 1, hi: 0 }, { lo: 0, hi: 0 }], edges: [], reference: 0 },
  });
  const m = await s.recv();
  assert.equal(m.type, 'done');
  assert.equal(m.id, 7);
  assert.equal(m.result.ok, false);
  assert.ok(m.result.errors.length > 0);
  await s.w.terminate();
});

test('Worker：草稿替换后旧 run 结果绝不回传（核心失效策略）', async () => {
  const s = spawnWorker();

  // 重型输入：40 探针 × 宽范围 × 大量边，确保旧计算在让出点之前仍在运行。
  const heavy = {
    probes: [{ lo: 0, hi: 0 }, ...Array.from({ length: 39 }, () => ({ lo: -200, hi: 200 }))],
    edges: (() => {
      const es = [];
      let seed = 7;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let k = 0; k < 200; k++) {
        const u = Math.floor(rnd() * 40);
        let v = Math.floor(rnd() * 40);
        if (v === u) v = (v + 1) % 40;
        es.push({ u, v, target: Math.floor(rnd() * 11) - 5, weight: 1 + Math.floor(rnd() * 8) });
      }
      return es;
    })(),
    reference: 0,
  };

  s.post({ type: 'solve', id: 100, input: heavy });
  // 立即用新草稿顶掉（模拟用户在计算中修改输入）。
  s.post({ type: 'solve', id: 101, input: sampleA });

  // 唯一允许到达的结论是 id=101；id=100 的 done 永远不能出现。
  const m = await s.recv();
  assert.equal(m.id, 101);
  assert.equal(m.type, 'done');
  assert.deepEqual(m.result.phases, [0, 1, 2]);

  // 等足够久确认旧计算没有迟到的回传。
  await s.quiet(600);
  await s.w.terminate();
});

test('Worker：显式 cancel 回执 canceled；silent cancel 不回执', async () => {
  const s = spawnWorker();
  s.post({ type: 'cancel', id: 200 });
  const m = await s.recv();
  assert.deepEqual(m, { type: 'canceled', id: 200 });

  s.post({ type: 'cancel', id: 201, silent: true });
  await s.quiet(400);
  await s.w.terminate();
});
