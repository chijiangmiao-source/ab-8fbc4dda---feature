/**
 * 整数相位面精确求解器。
 *
 * 问题：
 *   为每个探针 i 赋整数相位 x_i ∈ [lo_i, hi_i]（参考探针固定为 0），
 *   对每条有向观测边 e: u→v（目标差 t_e、正整数权 w_e）最小化
 *       Σ_e w_e · |(x_v - x_u) - t_e|，
 *   并在同成本的最优解中取按探针标识升序的相位向量字典序最小者。
 *
 * 归约（凸有序整数标签 / Ishikawa 链式最小割）：
 *   二值变量 z_{i,k} = [x_i ≥ k]，节点 (i,k) 在源侧 S ⇔ z=1，
 *   k ∈ [lo_i+1, hi_i]。
 *   - 链内 +∞ 弧 (i,k+1)→(i,k)：禁止 z_k=0 而 z_{k+1}=1，截集必为阈值；
 *   - 成对项 φ(x_u,x_v)=w·|x_v-x_u-t| 是子模凸函数：在单位方格
 *     (k,l) 上的受限二阶差分仅当 l-k=t 时为 2w，加弧 (u,k)→(v,l)；
 *   - 有限定义域边界的一阶项用源/汇弧精确补偿（A_k、B_l，
 *     正者加 (节点)→T，负者加 S→(节点)）；
 *   - 参考探针固定 0 用 +∞ 钉死弧实现。
 *
 * 字典序：所有最小割在并/交下封闭（子模格）。最大流后从源点沿
 *   残量弧可达的集合是唯一的“最小最小割”（包含于一切最小割的源侧），
 *   即 z 逐分量最少 ⇒ x 逐分量最小 ⇒ 按标识升序字典序最小。
 *   因而只需一次整数最小割，无局部传播、无浮点、无全赋值枚举、
 *   也无需逐坐标重算。
 */
import { Dinic } from './maxflow.js';

/** 大于一切有限可行总代价的容量；求和保持在 2^53 安全整数内 */
const INF = 0x1fffffffffffff;

const isInt = Number.isInteger;

/**
 * 校验输入。
 * @returns {{kind:string,index?:number,field?:string,message:string}[]}
 */
export function validateInput(input) {
  const errors = [];
  const probes = Array.isArray(input?.probes) ? input.probes : [];
  const edges = Array.isArray(input?.edges) ? input.edges : [];
  const n = probes.length;

  if (!Array.isArray(input?.probes) || n < 2 || n > 40) {
    errors.push({ kind: 'count', message: `探针数量必须在 2…40 之间（收到 ${Array.isArray(input?.probes) ? n : '无效值'}）` });
  }

  if (!isInt(input?.reference) || input.reference < 0 || input.reference >= n) {
    errors.push({
      kind: 'reference',
      field: 'index',
      message: `参考探针标识 ${input.reference} 越界：必须位于 0…${Math.max(n - 1, 0)}`,
    });
  }

  for (let i = 0; i < n; i++) {
    const p = probes[i] || {};
    if (!isInt(p.lo) || !isInt(p.hi)) {
      errors.push({
        kind: 'range',
        index: i,
        field: 'bounds',
        message: `探针 ${i} 的相位范围上下界必须是整数（收到 ${p.lo}…${p.hi}）`,
      });
    } else if (p.lo > p.hi) {
      errors.push({
        kind: 'range',
        index: i,
        field: 'range',
        message: `探针 ${i} 的范围为空：下界 ${p.lo} 大于上界 ${p.hi}`,
      });
    }
  }

  // 参考探针固定为 0；0 不在其范围内即“参考点越界”。
  if (isInt(input?.reference) && input.reference >= 0 && input.reference < n) {
    const p = probes[input.reference];
    if (p && isInt(p.lo) && isInt(p.hi) && p.lo <= p.hi && (p.lo > 0 || p.hi < 0)) {
      errors.push({
        kind: 'reference',
        index: input.reference,
        field: 'range',
        message: `参考探针 ${input.reference} 固定为 0，但 0 不在其相位范围 [${p.lo}, ${p.hi}] 内`,
      });
    }
  }

  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e] || {};
    if (!isInt(edge.u) || edge.u < 0 || edge.u >= n) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'u',
        message: `第 ${e + 1} 条边的起点标识 “${edge.u}” 不存在：须在 0…${Math.max(n - 1, 0)}`,
      });
    }
    if (!isInt(edge.v) || edge.v < 0 || edge.v >= n) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'v',
        message: `第 ${e + 1} 条边的终点标识 “${edge.v}” 不存在：须在 0…${Math.max(n - 1, 0)}`,
      });
    }
    if (!isInt(edge.weight) || edge.weight <= 0) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'weight',
        message: `第 ${e + 1} 条边的权重必须是正整数（收到 ${edge.weight}）`,
      });
    }
    if (!isInt(edge.target)) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'target',
        message: `第 ${e + 1} 条边的目标差值必须是整数（收到 ${edge.target}）`,
      });
    }
  }

  return errors;
}

/**
 * 构造链式最小割网络。
 * 返回 { dinic, id, S, T, cutArcs }（cutArcs 供容量复核）。
 */
function buildNetwork(probes, edges, reference) {
  const n = probes.length;

  // 节点 (i,k)，k = lo_i+1 … hi_i；在源侧 ⇔ x_i ≥ k。
  const base = new Int32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    base[i] = total;
    total += probes[i].hi - probes[i].lo;
  }
  const S = total;
  const T = total + 1;
  const dinic = new Dinic(total + 2);
  const id = (i, k) => base[i] + (k - probes[i].lo - 1);

  // 1) 阈值链 +∞ 弧：(i,k+1)∈S 而 (i,k)∈T 时被截断（罚 INF），
  //    从而禁止 z_k=0、z_{k+1}=1。
  for (let i = 0; i < n; i++) {
    for (let k = probes[i].lo + 1; k < probes[i].hi; k++) {
      dinic.addEdge(id(i, k + 1), id(i, k), INF);
    }
  }

  // 2) 成对项 w·|x_v - x_u - t|。
  for (const { u, v, target: t, weight: w } of edges) {
    const loU = probes[u].lo;
    const hiU = probes[u].hi;
    const loV = probes[v].lo;
    const hiV = probes[v].hi;

    // 受限二阶差分：C(k,l)=φ(k,l-1)+φ(k-1,l)-φ(k-1,l-1)-φ(k,l)，
    // 仅当 l-k=t 时等于 2w（其余为 0）。截弧 (u,k)→(v,l) 容量 C。
    for (let k = loU + 1; k <= hiU; k++) {
      const l = k + t;
      if (l >= loV + 1 && l <= hiV) {
        dinic.addEdge(id(u, k), id(v, l), 2 * w);
      }
    }

    // 边界一阶补偿：
    //   B_l = φ(loU,l)-φ(loU,l-1)（|·| 的离散增量恒为 ±w）
    //       = -w 当 l ≤ loU+t；+w 当 l ≥ loU+t+1。
    //   A_k = φ(k,loV)-φ(k-1,loV) - Σ_l C(k,l)
    //       一阶差 = -w 当 k ≤ loV-t；+w 当 k ≥ loV-t+1，
    //       若 (k, k+t) 处存在对角缝再减去 2w。
    // 正系数：节点→T（z=1 时付费）；负系数：S→节点（z=0 时付费）。
    for (let l = loV + 1; l <= hiV; l++) {
      const B = l <= loU + t ? -w : w;
      if (B > 0) dinic.addEdge(id(v, l), T, B);
      else dinic.addEdge(S, id(v, l), w);
    }
    for (let k = loU + 1; k <= hiU; k++) {
      let A = k <= loV - t ? -w : w;
      if (k + t >= loV + 1 && k + t <= hiV) A -= 2 * w;
      if (A > 0) dinic.addEdge(id(u, k), T, A);
      else if (A < 0) dinic.addEdge(S, id(u, k), -A);
    }
  }

  // 3) 参考探针钉死为 0：k≤0 的节点强制源侧（S→node, INF），
  //    k>0 的节点强制汇侧（node→T, INF）。
  for (let k = probes[reference].lo + 1; k <= probes[reference].hi; k++) {
    if (k <= 0) dinic.addEdge(S, id(reference, k), INF);
    else dinic.addEdge(id(reference, k), T, INF);
  }

  return { dinic, id, S, T };
}

/** 从最大流后的残量网络解码字典序最小最优解，并复算明细 */
function decodeResult(probes, edges, reference, dinic, id, S, T, flow) {
  void T;
  if (flow >= INF) {
    // 理论不可达：可行赋值总是存在（范围非空、参考点合法），代价有限。
    throw new Error('求解内部错误：最小割截断了无限容量弧（问题不可行）');
  }

  // 残量可达集 = 包含于一切最小割源侧的唯一最小最小割，
  // 解码得到逐分量最小（即字典序最小）的最优赋值。
  const side = dinic.sourceSide(S);
  const phases = new Array(probes.length);
  for (let i = 0; i < probes.length; i++) {
    let val = probes[i].lo;
    for (let k = probes[i].lo + 1; k <= probes[i].hi; k++) {
      if (side[id(i, k)]) val = k;
      else break;
    }
    phases[i] = val;
  }
  phases[reference] = 0;

  // 按定义整数复算总代价与逐边明细。
  let cost = 0;
  const edgeReports = edges.map((e) => {
    const actual = phases[e.v] - phases[e.u];
    const residual = actual - e.target;
    const contribution = e.weight * Math.abs(residual);
    cost += contribution;
    return {
      u: e.u,
      v: e.v,
      target: e.target,
      weight: e.weight,
      actual,
      residual,
      contribution,
    };
  });

  // 交叉核对：残量可达割必为阈值割（z_k=1 ⇒ z_{k-1}=1），且参考点为 0。
  for (let i = 0; i < probes.length; i++) {
    for (let k = probes[i].lo + 2; k <= probes[i].hi; k++) {
      if (side[id(i, k)] && !side[id(i, k - 1)]) {
        throw new Error('求解内部错误：截集不是阈值割');
      }
    }
  }
  if (phases[reference] !== 0) throw new Error('求解内部错误：参考探针未固定为 0');

  return { ok: true, phases, cost, reference, edges: edgeReports };
}

/**
 * 同步主入口（测试/Node 侧使用）。
 * @returns 成功 {ok:true, phases, cost, reference, edges:[...]}；
 *          失败 {ok:false, errors:[...]}。
 * @param {(() => boolean)|null} [shouldCancel] 协作式取消。
 */
export function solve(input, shouldCancel = null) {
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };

  const { probes, edges, reference } = input;
  const built = buildNetwork(probes, edges, reference);
  const flow = built.dinic.maxflow(built.S, built.T, shouldCancel);
  if (shouldCancel && shouldCancel()) return { ok: false, canceled: true };
  return decodeResult(probes, edges, reference, built.dinic, built.id, built.S, built.T, flow);
}

/**
 * 异步主入口（Web Worker 使用）：计算途中周期性让出事件循环，
 * 使“取消 / 草稿已变更”能及时生效；返回 canceled 时调用方必须丢弃结果。
 */
export async function solveAsync(input, shouldCancel = null, yieldEvery = 100000) {
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };

  const { probes, edges, reference } = input;
  const built = buildNetwork(probes, edges, reference);
  const flow = await built.dinic.maxflowAsync(built.S, built.T, shouldCancel, yieldEvery);
  if (shouldCancel && shouldCancel()) return { ok: false, canceled: true };
  return decodeResult(probes, edges, reference, built.dinic, built.id, built.S, built.T, flow);
}
