/**
 * 页面主控：录入探针范围与有向观测边，通过 Web Worker 发起精确复核，
 * 渲染相位面结论或定位输入错误；并支持勾选可疑边生成有向复测闭环。
 *
 * 状态一致性：
 *  - 复核与规划各持一枚客户端代际令牌（runId / planId）；只有携带当前
 *    令牌的结果允许上屏，Worker 返回的过期结果直接丢弃。
 *  - 草稿一旦修改（探针数/范围/边字段），立即作废两枚令牌、中止 Worker
 *    内旧计算并清除屏幕上的旧结论与旧规划；
 *  - 仅修改复测勾选或出发探针时，只作废规划令牌、清除旧路线，
 *    不触碰当前复核结论——旧规划绝不覆盖新状态。
 */
import './styles.css';
import SolverWorker from '../worker/solver.worker.js?worker';

const $ = (sel) => document.querySelector(sel);

const els = {
  probeCount: $('#probeCount'),
  referenceIdx: $('#referenceIdx'),
  probeTable: $('#probeTable'),
  edgeTable: $('#edgeTable'),
  edgeCount: $('#edgeCount'),
  addEdge: $('#addEdge'),
  runBtn: $('#runBtn'),
  cancelBtn: $('#cancelBtn'),
  statusLine: $('#statusLine'),
  resultPanel: $('#resultPanel'),
  errorList: $('#errorList'),
  resultBody: $('#resultBody'),
  loadSampleA: $('#loadSampleA'),
  loadSampleB: $('#loadSampleB'),
  setAllRanges: $('#setAllRanges'),
  routeStart: $('#routeStart'),
  planBtn: $('#planBtn'),
  cancelPlanBtn: $('#cancelPlanBtn'),
  routeStatus: $('#routeStatus'),
  routeErrorList: $('#routeErrorList'),
  routeResult: $('#routeResult'),
  loadSampleC: $('#loadSampleC'),
};

/** 复测勾选的硬上限（与规划器一致） */
const MAX_RECHECK = 24;

// ---- 草稿状态 ---------------------------------------------------------------
/** 探针范围行：[{lo, hi}]，字符串保留原始录入以便定位 */
let probeRows = [];
/** 观测边行：[{u, v, target, weight, recheck}] 字符串 + 复测勾选布尔值 */
let edgeRows = [];

/** 客户端代际令牌：自增即作废旧运行 */
let runId = 0;
let worker = null;
let computing = false;

/** 复测规划代际令牌与状态 */
let planId = 0;
let planning = false;

function workerEnsure() {
  if (!worker) {
    worker = new SolverWorker();
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      worker = null; // 允许下一次复核新建 Worker
      computing = false;
      planning = false;
      refreshButtons();
      refreshPlanButtons();
      setStatus(`Worker 错误：${e.message}`, 'bad');
    };
  }
  return worker;
}

function onWorkerMessage(ev) {
  const msg = ev.data;

  // 复核回执：过期代际一律丢弃。
  if (msg.type === 'canceled' || msg.type === 'done') {
    if (msg.id !== runId) return;
    if (msg.type === 'canceled') {
      computing = false;
      refreshButtons();
      setStatus('计算已取消。', 'muted');
      return;
    }
    computing = false;
    refreshButtons();
    renderResult(msg.result);
    return;
  }

  // 规划回执：过期代际一律丢弃，旧规划不得覆盖当前状态。
  if (msg.type === 'planCanceled' || msg.type === 'planned') {
    if (msg.id !== planId) return;
    if (msg.type === 'planCanceled') {
      planning = false;
      refreshPlanButtons();
      setRouteStatus('规划已取消。', 'muted');
      return;
    }
    planning = false;
    refreshPlanButtons();
    renderPlanResult(msg.result);
  }
}

// ---- 整数录入解析 -----------------------------------------------------------
function parseIntStrict(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 探针表 -----------------------------------------------------------------
function rebuildProbeRows(keepCount) {
  const next = [];
  for (let i = 0; i < keepCount; i++) {
    next.push(probeRows[i] ? { ...probeRows[i] } : { lo: '-5', hi: '5' });
  }
  probeRows = next;
  // 参考探针的默认范围始终包含 0。
  renderProbeTable();
}

function renderProbeTable() {
  const ref = parseIntStrict(els.referenceIdx.value);
  els.probeTable.innerHTML = probeRows
    .map((p, i) => {
      const isRef = i === ref;
      return `
      <tr data-probe="${i}" class="${isRef ? 'ref-row' : ''}">
        <td class="mono">${i}${isRef ? ' <span class="badge">参考 · 固定 0</span>' : ''}</td>
        <td><input data-field="lo" inputmode="numeric" value="${escapeHtml(p.lo)}" /></td>
        <td><input data-field="hi" inputmode="numeric" value="${escapeHtml(p.hi)}" /></td>
      </tr>`;
    })
    .join('');
}

// ---- 边表 -------------------------------------------------------------------
function recheckCount() {
  return edgeRows.reduce((acc, e) => acc + (e.recheck ? 1 : 0), 0);
}

function renderEdgeTable() {
  const checked = recheckCount();
  els.edgeCount.textContent = `共 ${edgeRows.length} 条观测边，已勾选 ${checked}/${MAX_RECHECK} 条复测`;
  els.edgeTable.innerHTML = edgeRows
    .map(
      (e, i) => `
      <tr data-edge="${i}">
        <td class="mono dim">${i + 1}</td>
        <td><input data-field="u" inputmode="numeric" value="${escapeHtml(e.u)}" /></td>
        <td><input data-field="v" inputmode="numeric" value="${escapeHtml(e.v)}" /></td>
        <td><input data-field="target" inputmode="numeric" value="${escapeHtml(e.target)}" /></td>
        <td><input data-field="weight" inputmode="numeric" value="${escapeHtml(e.weight)}" /></td>
        <td class="recheck-cell"><input type="checkbox" data-field="recheck" ${e.recheck ? 'checked' : ''} title="勾选后纳入复测闭环" /></td>
        <td><button type="button" class="link danger-text" data-action="delEdge">删除</button></td>
      </tr>`,
    )
    .join('');
}

// ---- 状态条与按钮 -----------------------------------------------------------
function setStatus(text, kind = '') {
  els.statusLine.textContent = text;
  els.statusLine.className = `status ${kind}`;
}

function setRouteStatus(text, kind = '') {
  els.routeStatus.textContent = text;
  els.routeStatus.className = `status ${kind}`;
}

function refreshButtons() {
  els.runBtn.disabled = computing;
  els.cancelBtn.disabled = !computing;
}

function refreshPlanButtons() {
  els.planBtn.disabled = planning;
  els.cancelPlanBtn.disabled = !planning;
}

/**
 * 作废当前复核运行：客户端代际自增 + 通知 Worker 中止 + 清除旧结论。
 * @param silent true=草稿失效类取消（Worker 静默不回执，避免覆盖此处
 *   已设置的状态）；false=用户显式取消，回执后显示“已取消”。
 */
function invalidateRunning(clearPanel = true, statusText = null, silent = true) {
  runId++;
  if (worker) worker.postMessage({ type: 'cancel', id: runId, silent });
  computing = false;
  refreshButtons();
  if (clearPanel) {
    els.resultPanel.hidden = true;
    els.resultBody.innerHTML = '';
    els.errorList.innerHTML = '';
    clearHighlights();
  }
  if (statusText !== null) setStatus(statusText, 'muted');
}

/**
 * 作废当前复测规划：代际自增 + 通知 Worker 中止 + 清除旧路线。
 * 只触碰规划面板，绝不清除当前复核结论。
 */
function invalidatePlan(statusText = null, silent = true) {
  planId++;
  if (worker) worker.postMessage({ type: 'cancelPlan', id: planId, silent });
  planning = false;
  refreshPlanButtons();
  els.routeResult.innerHTML = '';
  els.routeErrorList.innerHTML = '';
  if (statusText !== null) setRouteStatus(statusText, 'muted');
}

/** 草稿失效：复核与规划一并作废（任何录入变更都让两者过期）。 */
function invalidateAll(statusText) {
  invalidateRunning(true, statusText, true);
  invalidatePlan(null, true);
}

function clearHighlights() {
  document.querySelectorAll('tr.bad-row').forEach((tr) => tr.classList.remove('bad-row'));
  document.querySelectorAll('input.bad-input').forEach((inp) => inp.classList.remove('bad-input'));
}

// ---- 收集输入 ---------------------------------------------------------------
function collectInput() {
  const count = probeRows.length;
  const reference = parseIntStrict(els.referenceIdx.value);
  const probes = probeRows.map((p) => ({ lo: parseIntStrict(p.lo), hi: parseIntStrict(p.hi) }));
  const edges = edgeRows.map((e) => ({
    u: parseIntStrict(e.u),
    v: parseIntStrict(e.v),
    target: parseIntStrict(e.target),
    weight: parseIntStrict(e.weight),
  }));
  return { count, reference, probes, edges };
}

/** 收集规划输入：仅依赖边的拓扑（u/v）、勾选集与出发探针 */
function collectPlanInput() {
  const n = probeRows.length;
  const edges = edgeRows.map((e) => ({ u: parseIntStrict(e.u), v: parseIntStrict(e.v) }));
  const required = [];
  edgeRows.forEach((e, i) => {
    if (e.recheck) required.push(i);
  });
  const start = parseIntStrict(els.routeStart.value);
  return { n, edges, required, start };
}

// ---- 复核结果渲染 -----------------------------------------------------------
function renderResult(result) {
  clearHighlights();
  els.resultPanel.hidden = false;

  if (!result.ok) {
    // 输入错误：定位到具体探针/边并清除旧结论（面板只显示错误）。
    els.resultBody.innerHTML = '';
    highlightErrors(result.errors);
    els.errorList.innerHTML = `
      <div class="error-banner">复核未执行：发现 ${result.errors.length} 处输入问题，旧结论已清除。</div>
      <ul class="error-items">
        ${result.errors
          .map(
            (e) => `<li><span class="tag tag-${e.kind}">${errorKindLabel(e.kind)}</span> ${escapeHtml(e.message)}</li>`,
          )
          .join('')}
      </ul>`;
    setStatus('输入校验未通过。', 'bad');
    return;
  }

  els.errorList.innerHTML = '';
  const ref = result.reference;
  const phasesHtml = result.phases
    .map(
      (x, i) => `
      <tr>
        <td class="mono">${i}${i === ref ? ' <span class="badge">参考</span>' : ''}</td>
        <td class="mono phase">${x}</td>
      </tr>`,
    )
    .join('');

  const edgesHtml = result.edges
    .map(
      (e, idx) => `
      <tr>
        <td class="mono dim">${idx + 1}</td>
        <td class="mono">${e.u} → ${e.v}</td>
        <td class="mono">${e.target}</td>
        <td class="mono">${e.weight}</td>
        <td class="mono ${e.actual === e.target ? 'good' : ''}">${e.actual}</td>
        <td class="mono ${e.residual === 0 ? 'good' : 'warn'}">${formatSigned(e.residual)}</td>
        <td class="mono ${e.contribution === 0 ? 'good' : 'warn'}">${e.contribution}</td>
      </tr>`,
    )
    .join('');

  els.resultBody.innerHTML = `
    <div class="summary">
      <div class="summary-card">
        <div class="summary-label">最优总代价（加权绝对值和）</div>
        <div class="summary-value">${result.cost}</div>
      </div>
      <div class="summary-note">
        该赋值为所有范围内整数赋值中的精确最优；同成本下已按探针标识升序
        取字典序最小的相位向量。
      </div>
    </div>
    <h3>各探针整数相位</h3>
    <table class="grid result-phases">
      <thead><tr><th>探针标识</th><th>相位 x<sub>i</sub></th></tr></thead>
      <tbody>${phasesHtml}</tbody>
    </table>
    <h3>各观测边复核明细</h3>
    <table class="grid result-edges">
      <thead>
        <tr>
          <th>#</th><th>有向边</th><th>目标差值</th><th>权重</th>
          <th>实际差 x<sub>v</sub>−x<sub>u</sub></th>
          <th>残差（实际−目标）</th><th>贡献 w·|残差|</th>
        </tr>
      </thead>
      <tbody>${edgesHtml}</tbody>
    </table>`;
  setStatus(`复核完成：最优总代价 ${result.cost}。`, 'good');
}

// ---- 规划结果渲染 -----------------------------------------------------------
function renderPlanResult(result) {
  els.routeResult.innerHTML = '';
  els.routeErrorList.innerHTML = '';

  if (!result.ok) {
    // 校验失败与不可达：指出具体位置并清除旧路线（面板只显示问题）。
    const items = result.unreachable || result.errors || [];
    const isReach = Boolean(result.unreachable);
    if (!isReach) highlightPlanErrors(items);
    els.routeErrorList.innerHTML = `
      <div class="error-banner">${
        isReach
          ? `无法生成复测闭环：${items.length} 处可达性问题，旧路线已清除。`
          : `规划未执行：发现 ${items.length} 处输入问题，旧路线已清除。`
      }</div>
      <ul class="error-items">
        ${items
          .map(
            (e) =>
              `<li><span class="tag ${isReach ? 'tag-unreachable' : `tag-${e.kind}`}">${isReach ? '不可达' : planErrorKindLabel(e.kind)}</span> ${escapeHtml(e.message)}</li>`,
          )
          .join('')}
      </ul>`;
    setRouteStatus(isReach ? '存在无法纳入闭环的可疑边。' : '规划输入校验未通过。', 'bad');
    return;
  }

  const suspiciousSteps = result.steps.filter((s) => s.suspicious).length;
  const transitionSteps = result.length - suspiciousSteps;

  const firstHitHtml = result.requiredFirstHit
    .map(
      (h) => `
      <tr>
        <td class="mono dim">${h.edge + 1}</td>
        <td class="mono">${h.u} → ${h.v}</td>
        <td class="mono good">第 ${h.step} 步</td>
      </tr>`,
    )
    .join('');

  const stepsHtml = result.steps
    .map(
      (s) => `
      <tr class="${s.suspicious ? 'suspicious-row' : ''}">
        <td class="mono dim">${s.step}</td>
        <td class="mono">边 ${s.edge + 1}</td>
        <td class="mono">${s.u} → ${s.v}</td>
        <td>${s.suspicious ? '<span class="badge badge-warn">可疑边·复测</span>' : '<span class="dim">过渡</span>'}</td>
      </tr>`,
    )
    .join('');

  els.routeResult.innerHTML = `
    <div class="summary">
      <div class="summary-card">
        <div class="summary-label">闭环长度（经过边总数）</div>
        <div class="summary-value">${result.length}</div>
      </div>
      <div class="summary-note">
        从探针 ${result.start} 出发并回到 ${result.start}：覆盖 ${result.requiredFirstHit.length} 条可疑边
        （每边至少一次），其中复测 ${suspiciousSteps} 步、过渡 ${transitionSteps} 步；
        整数最小费用平衡的过渡代价为 ${result.balanceCost}。
      </div>
    </div>
    <h3>可疑边首次到达位置</h3>
    <table class="grid">
      <thead><tr><th>边 #</th><th>有向边</th><th>首次到达</th></tr></thead>
      <tbody>${firstHitHtml}</tbody>
    </table>
    <h3>完整边序（${result.length} 步）</h3>
    <table class="grid">
      <thead><tr><th>步</th><th>经过边</th><th>起 → 止</th><th>类型</th></tr></thead>
      <tbody>${stepsHtml}</tbody>
    </table>`;
  setRouteStatus(
    `规划完成：闭环长度 ${result.length}，覆盖 ${result.requiredFirstHit.length} 条可疑边并回到探针 ${result.start}。`,
    'good',
  );
}

function formatSigned(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function errorKindLabel(kind) {
  return (
    {
      count: '探针数',
      reference: '参考点',
      range: '范围',
      edge: '观测边',
      internal: '内部错误',
    }[kind] || '输入'
  );
}

function planErrorKindLabel(kind) {
  return (
    {
      count: '探针数',
      start: '出发探针',
      required: '复测勾选',
      edge: '观测边',
      internal: '内部错误',
    }[kind] || '输入'
  );
}

function highlightErrors(errors) {
  for (const e of errors) {
    if ((e.kind === 'range' || (e.kind === 'reference' && e.field === 'range')) && Number.isInteger(e.index)) {
      const tr = els.probeTable.querySelector(`tr[data-probe="${e.index}"]`);
      if (tr) {
        tr.classList.add('bad-row');
        if (e.field === 'bounds') {
          tr.querySelector('input[data-field="lo"]')?.classList.add('bad-input');
          tr.querySelector('input[data-field="hi"]')?.classList.add('bad-input');
        } else {
          // 空范围或 0 越界：上下界同时标红
          tr.querySelector('input[data-field="lo"]')?.classList.add('bad-input');
          tr.querySelector('input[data-field="hi"]')?.classList.add('bad-input');
        }
      }
    }
    if (e.kind === 'edge' && Number.isInteger(e.index)) {
      const tr = els.edgeTable.querySelector(`tr[data-edge="${e.index}"]`);
      if (tr && e.field) {
        tr.classList.add('bad-row');
        tr.querySelector(`input[data-field="${e.field}"]`)?.classList.add('bad-input');
      }
    }
    if (e.kind === 'reference' && e.field === 'index') {
      els.referenceIdx.classList.add('bad-input');
    }
    if (e.kind === 'count') {
      els.probeCount.classList.add('bad-input');
    }
  }
}

/** 规划输入错误的定位高亮（出发探针 / 问题边行 / 复测勾选框） */
function highlightPlanErrors(errors) {
  for (const e of errors) {
    if (e.kind === 'start') {
      els.routeStart.classList.add('bad-input');
    }
    if (e.kind === 'edge' && Number.isInteger(e.index)) {
      const tr = els.edgeTable.querySelector(`tr[data-edge="${e.index}"]`);
      if (tr && e.field) {
        tr.classList.add('bad-row');
        tr.querySelector(`input[data-field="${e.field}"]`)?.classList.add('bad-input');
      }
    }
    if (e.kind === 'required' && Number.isInteger(e.index)) {
      const tr = els.edgeTable.querySelector(`tr[data-edge="${e.index}"]`);
      if (tr) {
        tr.classList.add('bad-row');
        tr.querySelector('input[data-field="recheck"]')?.classList.add('bad-input');
      }
    }
  }
}

// ---- 发起复核 / 取消 --------------------------------------------------------
function runReview() {
  const input = collectInput();
  const id = ++runId;
  computing = true;
  refreshButtons();
  clearHighlights();
  // 发起新复核即撤下旧结论，避免计算期间展示过期补偿面。
  els.resultPanel.hidden = true;
  els.resultBody.innerHTML = '';
  els.errorList.innerHTML = '';
  setStatus('Worker 计算中：整数最小割求解，请稍候……', 'pending');
  workerEnsure().postMessage({ type: 'solve', id, input });
}

function cancelReview() {
  invalidateRunning(true, '计算已取消，旧结论已清除。', false);
}

// ---- 发起规划 / 取消 --------------------------------------------------------
function runPlan() {
  const input = collectPlanInput();

  // 主线程先做轻量预检（Worker 内仍做权威校验），尽早定位到具体控件。
  if (input.required.length === 0) {
    invalidatePlan();
    setRouteStatus('请先在观测边表中勾选至少一条需要复测的可疑边。', 'bad');
    return;
  }
  if (input.required.length > MAX_RECHECK) {
    invalidatePlan();
    setRouteStatus(`至多勾选 ${MAX_RECHECK} 条复测边（当前 ${input.required.length} 条）。`, 'bad');
    return;
  }
  if (input.start === null || input.start < 0 || input.start >= input.n) {
    invalidatePlan();
    els.routeStart.classList.add('bad-input');
    setRouteStatus(`出发探针标识无效：须在 0…${input.n - 1}。`, 'bad');
    return;
  }
  els.routeStart.classList.remove('bad-input');

  const id = ++planId;
  planning = true;
  refreshPlanButtons();
  clearHighlights();
  // 发起新规划即撤下旧路线，避免计算期间展示过期闭环。
  els.routeResult.innerHTML = '';
  els.routeErrorList.innerHTML = '';
  setRouteStatus('Worker 规划中：最短过渡路 → 整数最小费用平衡 → 欧拉闭环……', 'pending');
  workerEnsure().postMessage({ type: 'plan', id, input });
}

function cancelPlan() {
  invalidatePlan('规划已取消，旧路线已清除。', false);
}

// ---- 样例 -------------------------------------------------------------------
function loadSample(kind) {
  invalidateAll('已载入样例，旧结论与旧规划已清除。');
  els.routeStart.value = '0';
  if (kind === 'A') {
    // 闭环矛盾三角形。按边录入顺序贪心选生成树 {0→1, 0→2} 做局部累加：
    // x=(0,1,1)，高权边 1→2（w=10）残差 -1，代价 10；
    // 精确最优 x=(0,1,2)：仅低权弦 0→2（w=1）残差 1，代价 1。
    els.probeCount.value = '3';
    els.referenceIdx.value = '0';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '0', hi: '3' },
      { lo: '0', hi: '3' },
    ];
    edgeRows = [
      { u: '0', v: '1', target: '1', weight: '10', recheck: false },
      { u: '0', v: '2', target: '1', weight: '1', recheck: false },
      { u: '1', v: '2', target: '1', weight: '10', recheck: false },
    ];
  } else if (kind === 'B') {
    // 四环：沿生成树 0→1→2→3 局部累加得 (0,1,2,3)，违背高权闭合边，
    // 代价 10；精确最优 (0,1,2,2)，代价 1。
    els.probeCount.value = '4';
    els.referenceIdx.value = '0';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '-3', hi: '5' },
      { lo: '-3', hi: '5' },
      { lo: '-3', hi: '5' },
    ];
    edgeRows = [
      { u: '0', v: '1', target: '1', weight: '1', recheck: false },
      { u: '1', v: '2', target: '1', weight: '1', recheck: false },
      { u: '2', v: '3', target: '1', weight: '1', recheck: false },
      { u: '3', v: '0', target: '-2', weight: '10', recheck: false },
    ];
  } else {
    // 复测规划样例（单向绕行，最近边优先会多走）：
    // 可疑边 0→3 与 3→1，出发探针 1。最近边优先贪心先抢 3→1 需 8 步；
    // 最小费用平衡闭环顺单向洋流 1→2→3→0→3→1 仅 5 步。
    els.probeCount.value = '4';
    els.referenceIdx.value = '0';
    els.routeStart.value = '1';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '-3', hi: '3' },
      { lo: '-3', hi: '3' },
      { lo: '-3', hi: '3' },
    ];
    edgeRows = [
      { u: '0', v: '3', target: '1', weight: '1', recheck: true },
      { u: '3', v: '1', target: '1', weight: '1', recheck: true },
      { u: '0', v: '2', target: '1', weight: '1', recheck: false },
      { u: '2', v: '3', target: '0', weight: '1', recheck: false },
      { u: '1', v: '2', target: '-1', weight: '1', recheck: false },
      { u: '3', v: '0', target: '-1', weight: '1', recheck: false },
    ];
  }
  renderProbeTable();
  renderEdgeTable();
}

// ---- 事件绑定 ---------------------------------------------------------------
els.probeCount.addEventListener('change', () => {
  let n = parseIntStrict(els.probeCount.value);
  if (n === null || n < 2) n = 2;
  if (n > 40) n = 40;
  els.probeCount.value = String(n);
  invalidateAll('探针数量已修改，旧结论与旧规划已清除。');
  rebuildProbeRows(n);
});

els.referenceIdx.addEventListener('change', () => {
  invalidateAll('参考探针已修改，旧结论与旧规划已清除。');
  renderProbeTable();
});

els.probeTable.addEventListener('input', (ev) => {
  const tr = ev.target.closest('tr[data-probe]');
  if (!tr) return;
  const i = Number(tr.dataset.probe);
  probeRows[i][ev.target.dataset.field] = ev.target.value;
  invalidateAll('草稿已修改，上一次计算与旧结论、旧规划已作废。');
});

els.addEdge.addEventListener('click', () => {
  edgeRows.push({ u: '0', v: '1', target: '0', weight: '1', recheck: false });
  invalidateAll('已新增观测边，上一次计算与旧结论、旧规划已作废。');
  renderEdgeTable();
});

els.edgeTable.addEventListener('input', (ev) => {
  const tr = ev.target.closest('tr[data-edge]');
  if (!tr) return;
  const field = ev.target.dataset.field;
  if (field === 'recheck') return; // 勾选走 change 事件
  const i = Number(tr.dataset.edge);
  edgeRows[i][field] = ev.target.value;
  invalidateAll('草稿已修改，上一次计算与旧结论、旧规划已作废。');
});

els.edgeTable.addEventListener('change', (ev) => {
  if (ev.target.dataset.field !== 'recheck') return;
  const tr = ev.target.closest('tr[data-edge]');
  const i = Number(tr.dataset.edge);
  // 勾选变更只作废规划（旧路线），绝不动当前复核结论。
  if (ev.target.checked && recheckCount() >= MAX_RECHECK) {
    ev.target.checked = false;
    invalidatePlan();
    setRouteStatus(`至多勾选 ${MAX_RECHECK} 条复测边。`, 'bad');
    return;
  }
  edgeRows[i].recheck = ev.target.checked;
  invalidatePlan('复测勾选已修改，旧路线已清除。');
  renderEdgeTable();
});

els.edgeTable.addEventListener('click', (ev) => {
  if (ev.target.dataset.action !== 'delEdge') return;
  const tr = ev.target.closest('tr[data-edge]');
  const i = Number(tr.dataset.edge);
  edgeRows.splice(i, 1);
  invalidateAll('观测边已删除，旧结论与旧规划已清除。');
  renderEdgeTable();
});

els.routeStart.addEventListener('input', () => {
  // 出发探针属于规划参数：只作废规划，不动复核结论。
  invalidatePlan('出发探针已修改，旧路线已清除。');
});

els.setAllRanges.addEventListener('click', () => {
  const lo = window.prompt('批量设置所有非参考探针的整数下界：', '-5');
  if (lo === null) return;
  const hi = window.prompt('批量设置所有非参考探针的整数上界：', '5');
  if (hi === null) return;
  if (parseIntStrict(lo) === null || parseIntStrict(hi) === null) {
    setStatus('批量设置失败：上下界必须是整数。', 'bad');
    return;
  }
  const ref = parseIntStrict(els.referenceIdx.value);
  for (let i = 0; i < probeRows.length; i++) {
    if (i !== ref) probeRows[i] = { lo, hi };
  }
  invalidateAll('范围已批量修改，旧结论与旧规划已清除。');
  renderProbeTable();
});

els.runBtn.addEventListener('click', runReview);
els.cancelBtn.addEventListener('click', cancelReview);
els.planBtn.addEventListener('click', runPlan);
els.cancelPlanBtn.addEventListener('click', cancelPlan);
els.loadSampleA.addEventListener('click', () => loadSample('A'));
els.loadSampleB.addEventListener('click', () => loadSample('B'));
els.loadSampleC.addEventListener('click', () => loadSample('C'));

// ---- 初始状态：闭环矛盾样例 -------------------------------------------------
loadSample('A');
setStatus('已载入示例数据，可直接发起复核。', 'muted');
setRouteStatus('勾选可疑边并指定出发探针后，可生成复测闭环。', 'muted');
