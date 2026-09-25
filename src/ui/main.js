/**
 * 页面主控：录入探针范围与有向观测边，通过 Web Worker 发起精确复核，
 * 渲染相位面结论或定位输入错误；勾选可疑边并指定出发探针后，另由
 * 独立 Worker 生成最短有向复测闭环。
 *
 * 状态一致性（两条结论链各自带代际令牌）：
 *  - 每次“发起复核”得到新的 runId；只有携带当前 runId 的结果允许上屏，
 *    Worker 返回的过期结果直接丢弃。
 *  - 闭环规划同理使用 routeRunId，且与相位面复核互不覆盖。
 *  - 草稿一旦修改（探针数/范围/边字段/边增删），立即同时作废两条令牌、
 *    中止两个 Worker 内旧计算并清除旧结论；仅改勾选或出发探针时，
 *    只作废闭环令牌，相位面结论保留。
 */
import './styles.css';
import SolverWorker from '../worker/solver.worker.js?worker';
import RouteWorker from '../worker/repath.worker.js?worker';

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
  loadSampleC: $('#loadSampleC'),
  setAllRanges: $('#setAllRanges'),
  routeStart: $('#routeStart'),
  routeRunBtn: $('#routeRunBtn'),
  routeClearBtn: $('#routeClearBtn'),
  routeCount: $('#routeCount'),
  routeError: $('#routeError'),
  routeResult: $('#routeResult'),
};

const MAX_SUSPECTS = 24;

// ---- 草稿状态 ---------------------------------------------------------------
/** 探针范围行：[{lo, hi}]，字符串保留原始录入以便定位 */
let probeRows = [];
/** 观测边行：[{u, v, target, weight}] 均为字符串 */
let edgeRows = [];
/** 与 edgeRows 对齐：该行是否被勾选为需要复测的可疑边 */
let suspectRows = [];

/** 客户端代际令牌：自增即作废旧运行 */
let runId = 0;
let worker = null;
let computing = false;
/** 闭环规划链独立令牌：与相位面复核互不覆盖 */
let routeRunId = 0;
let routeWorker = null;
let routeComputing = false;

function workerEnsure() {
  if (!worker) {
    worker = new SolverWorker();
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      worker = null; // 允许下一次复核新建 Worker
      computing = false;
      refreshButtons();
      setStatus(`Worker 错误：${e.message}`, 'bad');
    };
  }
  return worker;
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  // 过期代际的一切回传（含 canceled）均丢弃，不允许触碰当前界面。
  if (msg.id !== runId) return;

  if (msg.type === 'canceled') {
    computing = false;
    refreshButtons();
    setStatus('计算已取消。', 'muted');
    return;
  }

  if (msg.type === 'done') {
    computing = false;
    refreshButtons();
    renderResult(msg.result);
  }
}

// ---- 闭环规划 Worker（与复核 Worker 独立） ----------------------------------
function routeWorkerEnsure() {
  if (!routeWorker) {
    routeWorker = new RouteWorker();
    routeWorker.onmessage = onRouteWorkerMessage;
    routeWorker.onerror = (e) => {
      routeWorker = null;
      routeComputing = false;
      refreshButtons();
      renderRouteError(`Worker 错误：${e.message}`);
    };
  }
  return routeWorker;
}

function onRouteWorkerMessage(ev) {
  const msg = ev.data;
  // 过期代际（改勾选/改草稿/取消/重新规划）的一切回传一律丢弃。
  if (msg.id !== routeRunId) return;

  if (msg.type === 'canceled') {
    routeComputing = false;
    refreshButtons();
    renderRouteError('闭环规划已取消，旧路线已清除。', 'muted');
    return;
  }

  if (msg.type === 'done') {
    routeComputing = false;
    refreshButtons();
    renderRoute(msg.result);
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
function renderEdgeTable() {
  els.edgeCount.textContent = `共 ${edgeRows.length} 条观测边`;
  els.edgeTable.innerHTML = edgeRows
    .map(
      (e, i) => `
      <tr data-edge="${i}">
        <td class="mono dim">${i + 1}</td>
        <td><input data-field="u" inputmode="numeric" value="${escapeHtml(e.u)}" /></td>
        <td><input data-field="v" inputmode="numeric" value="${escapeHtml(e.v)}" /></td>
        <td><input data-field="target" inputmode="numeric" value="${escapeHtml(e.target)}" /></td>
        <td><input data-field="weight" inputmode="numeric" value="${escapeHtml(e.weight)}" /></td>
        <td class="check-cell">
          <input type="checkbox" data-action="suspect" title="勾选为需要复测的可疑边"
            ${suspectRows[i] ? 'checked' : ''} />
        </td>
        <td><button type="button" class="link danger-text" data-action="delEdge">删除</button></td>
      </tr>`,
    )
    .join('');
  renderRouteCount();
}

// ---- 状态条与按钮 -----------------------------------------------------------
function setStatus(text, kind = '') {
  els.statusLine.textContent = text;
  els.statusLine.className = `status ${kind}`;
}

function refreshButtons() {
  els.runBtn.disabled = computing;
  els.cancelBtn.disabled = !computing;
  els.routeRunBtn.disabled = routeComputing;
}

/**
 * 作废闭环规划链：routeRunId 自增 + 通知规划 Worker 中止 + 清除旧路线。
 * 勾选、出发探针变化与用户显式取消都走这里；不触碰相位面复核结论。
 */
function invalidateRoute(clearResult = true, statusHtml = null, silent = true) {
  routeRunId++;
  if (routeWorker) routeWorker.postMessage({ type: 'cancel', id: routeRunId, silent });
  routeComputing = false;
  refreshButtons();
  if (clearResult) {
    els.routeResult.hidden = true;
    els.routeResult.innerHTML = '';
    els.routeError.innerHTML = '';
  }
  if (statusHtml !== null) renderRouteError(escapeHtml(statusHtml), 'muted');
}

/**
 * 作废相位面复核链；草稿类修改同时连带作废闭环规划（其输入图已变）。
 * @param silent true=草稿失效类取消（Worker 静默不回执，避免覆盖此处
 *   已设置的状态）；false=用户显式取消，回执后显示“已取消”。
 */
function invalidateRunning(clearPanel = true, statusText = null, silent = true) {
  runId++;
  if (worker) worker.postMessage({ type: 'cancel', id: runId, silent });
  computing = false;
  // 草稿已变：旧规划同样失效，静默中止且清除路线，绝不允许回屏覆盖。
  invalidateRoute(true, null, true);
  refreshButtons();
  if (clearPanel) {
    els.resultPanel.hidden = true;
    els.resultBody.innerHTML = '';
    els.errorList.innerHTML = '';
    clearHighlights();
  }
  if (statusText !== null) setStatus(statusText, 'muted');
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

// ---- 结果渲染 ---------------------------------------------------------------
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
  invalidateRunning(true, '计算已取消，旧结论与旧路线已清除。', false);
}

// ---- 复测闭环规划 -----------------------------------------------------------
function selectedEdgeIndices() {
  const out = [];
  suspectRows.forEach((on, i) => {
    if (on) out.push(i);
  });
  return out;
}

function renderRouteCount() {
  const k = selectedEdgeIndices().length;
  els.routeCount.textContent = `已勾选可疑边 ${k} / ${MAX_SUSPECTS} 条`;
  els.routeCount.className = `hint ${k > MAX_SUSPECTS ? 'danger-text' : ''}`;
}

function renderRouteError(html, kind = 'bad') {
  els.routeResult.hidden = true;
  els.routeResult.innerHTML = '';
  els.routeError.innerHTML = `<div class="error-banner ${kind === 'muted' ? 'muted-banner' : ''}">${html}</div>`;
}

/**
 * 收集闭环规划输入并做主线程即时校验（Worker 侧仍会再校验一次）。
 * @returns {{input:object}|{errors:string[]}}
 */
function collectRouteInput() {
  const count = probeRows.length;
  const errors = [];
  const start = parseIntStrict(els.routeStart.value);
  if (start === null || start < 0 || start >= count) {
    errors.push(`出发探针必须是 0…${count - 1} 内的整数（收到 “${els.routeStart.value}”）`);
  }
  const parsedEdges = edgeRows.map((e) => ({
    u: parseIntStrict(e.u),
    v: parseIntStrict(e.v),
  }));
  parsedEdges.forEach((e, i) => {
    if (e.u === null || e.u < 0 || e.u >= count || e.v === null || e.v < 0 || e.v >= count) {
      errors.push(`第 ${i + 1} 条边端点 ${edgeRows[i].u}→${edgeRows[i].v} 不在探针范围 0…${count - 1} 内`);
    }
  });
  const selected = selectedEdgeIndices();
  if (selected.length === 0) errors.push('请先在上方边表勾选至少一条可疑边');
  if (selected.length > MAX_SUSPECTS) errors.push(`至多勾选 ${MAX_SUSPECTS} 条可疑边（当前 ${selected.length} 条）`);
  if (errors.length) return { errors };
  return { input: { count, edges: parsedEdges, start, selected } };
}

function runRoute() {
  const gathered = collectRouteInput();
  if (gathered.errors) {
    invalidateRoute(true, null, true);
    renderRouteError(`规划未执行：<ul class="error-items">${gathered.errors.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`);
    setStatus('闭环规划输入校验未通过。', 'bad');
    return;
  }
  const id = ++routeRunId;
  routeComputing = true;
  refreshButtons();
  els.routeResult.hidden = true;
  els.routeResult.innerHTML = '';
  els.routeError.innerHTML = '';
  setStatus('Worker 规划中：最短过渡路 → 整数最小费用平衡 → 欧拉展开……', 'pending');
  routeWorkerEnsure().postMessage({ type: 'planRoute', id, input: gathered.input });
}

function clearRoute() {
  invalidateRoute(true, '旧路线已清除；勾选与出发探针保留，可重新生成。', true);
}

function renderRoute(result) {
  els.routeError.innerHTML = '';

  if (!result.ok) {
    // 不可达 / 校验失败：不展示任何旧路线。
    els.routeResult.hidden = true;
    els.routeResult.innerHTML = '';
    if (Array.isArray(result.unreachable) && result.unreachable.length) {
      const items = result.unreachable
        .map((r) => `<li>探针 <span class="mono">${r.from}</span> ✗→ 探针 <span class="mono">${r.to}</span>：${escapeHtml(r.detail)}</li>`)
        .join('');
      els.routeError.innerHTML = `
        <div class="error-banner">无法把全部可疑边纳入同一条回到出发探针的闭环，旧路线已清除（共 ${result.unreachable.length} 处不可达）：</div>
        <ul class="error-items unreach-items">${items}</ul>`;
      setStatus('闭环规划失败：存在有向不可达的探针。', 'bad');
    } else {
      const items = (result.errors || []).map((e) => `<li>${escapeHtml(e.message)}</li>`).join('');
      els.routeError.innerHTML = `<div class="error-banner">闭环规划未执行，旧路线已清除：</div><ul class="error-items">${items}</ul>`;
      setStatus('闭环规划输入校验未通过。', 'bad');
    }
    return;
  }

  const transitionCount = result.length - result.selected.length;
  const stepsHtml = result.steps
    .map((s, i) => {
      let tag = '';
      if (s.first) tag = '<span class="tag tag-first">可疑边 · 首次到达</span>';
      else if (s.suspect) tag = '<span class="tag tag-repeat">可疑边（重复经过）</span>';
      else tag = '<span class="tag tag-transit">过渡边</span>';
      return `
        <tr>
          <td class="mono dim">${i + 1}</td>
          <td class="mono">${s.edge + 1}</td>
          <td class="mono">${s.u}</td>
          <td class="mono">${s.v}</td>
          <td>${tag}</td>
        </tr>`;
    })
    .join('');

  const firstHtml = result.firstReach
    .map(
      (f) => `
        <tr>
          <td class="mono">${f.edge + 1}</td>
          <td class="mono">第 ${f.position} 步</td>
        </tr>`,
    )
    .join('');

  els.routeResult.innerHTML = `
    <div class="summary">
      <div class="summary-card">
        <div class="summary-label">闭环总长度（有向边步数）</div>
        <div class="summary-value">${result.length}</div>
      </div>
      <div class="summary-note">
        从探针 <span class="mono">${result.start}</span> 出发并回到
        <span class="mono">${result.start}</span>；${result.selected.length} 条可疑边全部至少经过一次，
        其中过渡边经过 <span class="mono">${transitionCount}</span> 步
        （最小费用平衡 ${result.balanceCost} 步${result.repairCost ? `、断开平衡分量拼回 ${result.repairCost} 步` : ''}）。
        该长度为整数最小费用平衡 + 欧拉展开给出的精确最短闭环，非逐边贪心结果。
      </div>
    </div>
    <h3>可疑边首次到达位置</h3>
    <table class="grid route-first">
      <thead><tr><th>可疑边（录入序号）</th><th>闭环中的首次到达</th></tr></thead>
      <tbody>${firstHtml}</tbody>
    </table>
    <h3>完整边序（每步起止探针）</h3>
    <table class="grid route-steps">
      <thead>
        <tr><th>步号</th><th>观测边 #</th><th>起点探针</th><th>终点探针</th><th>性质</th></tr>
      </thead>
      <tbody>${stepsHtml}</tbody>
    </table>`;
  els.routeResult.hidden = false;
  setStatus(`闭环规划完成：总长度 ${result.length} 步，覆盖全部 ${result.selected.length} 条可疑边。`, 'good');
}

// ---- 样例 -------------------------------------------------------------------
function loadSample(kind) {
  invalidateRunning(true, '已载入样例，旧结论已清除。');
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
      { u: '0', v: '1', target: '1', weight: '10' },
      { u: '0', v: '2', target: '1', weight: '1' },
      { u: '1', v: '2', target: '1', weight: '10' },
    ];
    suspectRows = edgeRows.map(() => false);
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
      { u: '0', v: '1', target: '1', weight: '1' },
      { u: '1', v: '2', target: '1', weight: '1' },
      { u: '2', v: '3', target: '1', weight: '1' },
      { u: '3', v: '0', target: '-2', weight: '10' },
    ];
    suspectRows = edgeRows.map(() => false);
  } else {
    // 单向绕行复测样例（验收用）：勾选边 0→3、1→0、2→3，从探针 0 出发。
    // 最近边优先会先走 0→3→1→0，再绕去 2→3 后返回，共 7 步；
    // 最小费用平衡给出的精确最短闭环为 0→3→2→3→1→0，共 5 步。
    els.probeCount.value = '5';
    els.referenceIdx.value = '0';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '-5', hi: '5' },
      { lo: '-5', hi: '5' },
      { lo: '-5', hi: '5' },
      { lo: '-5', hi: '5' },
    ];
    edgeRows = [
      { u: '1', v: '2', target: '0', weight: '1' }, // 0（过渡）
      { u: '3', v: '2', target: '0', weight: '1' }, // 1（过渡）
      { u: '0', v: '1', target: '0', weight: '1' }, // 2
      { u: '0', v: '3', target: '0', weight: '1' }, // 3（可疑）
      { u: '3', v: '0', target: '0', weight: '1' }, // 4
      { u: '1', v: '0', target: '0', weight: '1' }, // 5（可疑）
      { u: '3', v: '1', target: '0', weight: '1' }, // 6（过渡）
      { u: '2', v: '4', target: '0', weight: '1' }, // 7
      { u: '4', v: '2', target: '0', weight: '1' }, // 8
      { u: '3', v: '4', target: '0', weight: '1' }, // 9
      { u: '4', v: '0', target: '0', weight: '1' }, // 10
      { u: '2', v: '3', target: '0', weight: '1' }, // 11（可疑）
    ];
    suspectRows = edgeRows.map((_, i) => i === 3 || i === 5 || i === 11);
    els.routeStart.value = '0';
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
  invalidateRunning(true, '探针数量已修改，旧结论已清除。');
  rebuildProbeRows(n);
});

els.referenceIdx.addEventListener('change', () => {
  invalidateRunning(true, '参考探针已修改，旧结论已清除。');
  renderProbeTable();
});

els.probeTable.addEventListener('input', (ev) => {
  const tr = ev.target.closest('tr[data-probe]');
  if (!tr) return;
  const i = Number(tr.dataset.probe);
  probeRows[i][ev.target.dataset.field] = ev.target.value;
  invalidateRunning(true, '草稿已修改，上一次计算与旧结论已作废。');
});

els.addEdge.addEventListener('click', () => {
  edgeRows.push({ u: '0', v: '1', target: '0', weight: '1' });
  suspectRows.push(false);
  invalidateRunning(true, '已新增观测边，上一次计算与旧结论已作废。');
  renderEdgeTable();
});

els.edgeTable.addEventListener('input', (ev) => {
  const field = ev.target.dataset.field;
  if (!field) return; // 复选框走 click 分支，不得按字段修改处理
  const tr = ev.target.closest('tr[data-edge]');
  if (!tr) return;
  const i = Number(tr.dataset.edge);
  edgeRows[i][field] = ev.target.value;
  invalidateRunning(true, '草稿已修改，上一次计算与旧结论已作废。');
});

els.edgeTable.addEventListener('click', (ev) => {
  if (ev.target.dataset.action === 'suspect') {
    const tr = ev.target.closest('tr[data-edge]');
    const i = Number(tr.dataset.edge);
    if (ev.target.checked && selectedEdgeIndices().length >= MAX_SUSPECTS) {
      // 超过 24 条：拒绝勾选（恢复为未选）；不动现有路线与相位面结论。
      ev.target.checked = false;
      setStatus(`至多勾选 ${MAX_SUSPECTS} 条可疑边，请先取消其他勾选。`, 'bad');
      return;
    }
    suspectRows[i] = ev.target.checked;
    renderRouteCount();
    // 勾选只影响闭环规划：仅作废路线令牌，相位面复核结论照常保留。
    invalidateRoute(true, ev.target.checked ? null : '已取消勾选，旧路线已清除，请重新生成。', true);
    if (ev.target.checked) setStatus('已更新可疑边选择，点击“生成复测闭环”。', 'muted');
    return;
  }
  if (ev.target.dataset.action !== 'delEdge') return;
  const tr = ev.target.closest('tr[data-edge]');
  const i = Number(tr.dataset.edge);
  edgeRows.splice(i, 1);
  suspectRows.splice(i, 1);
  invalidateRunning(true, '观测边已删除，旧结论已清除。');
  renderEdgeTable();
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
  invalidateRunning(true, '范围已批量修改，旧结论已清除。');
  renderProbeTable();
});

els.runBtn.addEventListener('click', runReview);
els.cancelBtn.addEventListener('click', cancelReview);
els.loadSampleA.addEventListener('click', () => loadSample('A'));
els.loadSampleB.addEventListener('click', () => loadSample('B'));
els.loadSampleC.addEventListener('click', () => loadSample('C'));

els.routeStart.addEventListener('change', () => {
  invalidateRoute(true, '出发探针已修改，旧路线已清除，请重新生成。', true);
});
els.routeRunBtn.addEventListener('click', runRoute);
els.routeClearBtn.addEventListener('click', clearRoute);

// ---- 初始状态：闭环矛盾样例 -------------------------------------------------
loadSample('A');
renderRouteCount();
setStatus('已载入示例数据，可直接发起复核；勾选可疑边后可生成复测闭环。', 'muted');
