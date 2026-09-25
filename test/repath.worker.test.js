/**
 * 复测闭环规划 Worker 端到端测试：用 worker_threads + self 垫片加载真实的
 * src/worker/repath.worker.js，验证：
 *  1) 正常 planRoute → done，闭环长度与覆盖正确；
 *  2) 新选择顶代后，旧规划结果绝不回传；
 *  3) 显式 cancel 回 canceled；silent cancel 不回执；
 *  4) 不可达时回传 {ok:false, unreachable:[...]}（含从何探针到何处）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

const workerUrl = new URL('../src/worker/repath.worker.js', import.meta.url).href;

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

// 反贪心验收样例：精确最短闭环 5 步，最近边优先 7 步。
const detour = {
  count: 5,
  edges: [
    { u: 1, v: 2 }, { u: 3, v: 2 }, { u: 0, v: 1 }, { u: 0, v: 3 },
    { u: 3, v: 0 }, { u: 1, v: 0 }, { u: 3, v: 1 }, { u: 2, v: 4 },
    { u: 4, v: 2 }, { u: 3, v: 4 }, { u: 4, v: 0 }, { u: 2, v: 3 },
  ],
  start: 0,
  selected: [3, 5, 11],
};

test('闭环 Worker：正常规划返回 done 且长度为 5、覆盖全部可疑边', async () => {
  const s = spawnWorker();
  s.post({ type: 'planRoute', id: 1, input: detour });
  const m = await s.recv();
  assert.equal(m.type, 'done');
  assert.equal(m.id, 1);
  assert.equal(m.result.ok, true);
  assert.equal(m.result.length, 5);
  assert.deepEqual(m.result.firstReach.map((f) => f.edge).sort((a, b) => a - b), [3, 5, 11]);
  assert.deepEqual(m.result.steps.map((x) => x.edge), [3, 1, 11, 6, 5]);
  await s.w.terminate();
});

test('闭环 Worker：不可达时指出从何探针不能到达何处', async () => {
  const s = spawnWorker();
  s.post({
    type: 'planRoute',
    id: 9,
    input: {
      count: 3,
      edges: [{ u: 0, v: 1 }, { u: 1, v: 2 }],
      start: 0,
      selected: [1],
    },
  });
  const m = await s.recv();
  assert.equal(m.type, 'done');
  assert.equal(m.id, 9);
  assert.equal(m.result.ok, false);
  assert.equal(m.result.unreachable[0].from, 2);
  assert.equal(m.result.unreachable[0].to, 0);
  await s.w.terminate();
});

test('闭环 Worker：选择顶代后旧规划结果绝不回传（核心失效策略）', async () => {
  const s = spawnWorker();
  // 重型输入：40 探针完全图 + 全部 BFS，迫使旧规划至少活过首个让出点。
  const denseEdges = [];
  for (let u = 0; u < 40; u++) for (let v = 0; v < 40; v++) if (u !== v) denseEdges.push({ u, v });
  const heavy = {
    count: 40,
    edges: denseEdges,
    start: 0,
    selected: [0, 1, 2, 3, 4, 5, 6, 7],
  };
  s.post({ type: 'planRoute', id: 100, input: heavy });
  s.post({ type: 'planRoute', id: 101, input: detour });
  const m = await s.recv();
  assert.equal(m.id, 101);
  assert.equal(m.type, 'done');
  assert.equal(m.result.length, 5);
  await s.quiet(500);
  await s.w.terminate();
});

test('闭环 Worker：显式 cancel 回执 canceled；silent cancel 不回执', async () => {
  const s = spawnWorker();
  s.post({ type: 'cancel', id: 200 });
  const m = await s.recv();
  assert.deepEqual(m, { type: 'canceled', id: 200 });

  s.post({ type: 'cancel', id: 201, silent: true });
  await s.quiet(400);
  await s.w.terminate();
});
