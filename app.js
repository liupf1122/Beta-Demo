(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const graphEl = byId("graph");
  const D = window.CAUSAL;
  if (!window.echarts || !D) {
    graphEl.textContent = "图表或数据加载失败，请刷新页面。";
    return;
  }

  const XMAX = 10.4, YMAX = 5.6;                       // 与 build_data.py 的 XS / ROW_Y 一致
  const LAYER_NAME = ["人口学\n生活方式", "血管\n代谢", "脑结构"];
  const nodeById = new Map(D.nodes.map((n) => [n.id, n]));
  const eid = (s, t) => `${s}>${t}`;
  const chart = echarts.init(graphEl, null, { renderer: "canvas" });
  const zr = chart.getZr();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");

  let T = {};
  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["ink", "ink2", "ink3", "line", "idle-edge", "node-idle", "node-border", "chart",
      "up", "up-1", "up-2", "up-3", "down", "down-1", "down-2", "down-3", "band-0", "band-1", "band-2", "accent"]) {
      T[k] = cs.getPropertyValue(`--${k}`).trim();
    }
  }

  // ---------- 数字格式 ----------
  function signed(x, digits) {
    const s = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (Number(s.replace(/,/g, "")) === 0) return "0";
    return (x < 0 ? "−" : "+") + s;
  }
  function fmtRaw(node, dsd) {
    const v = dsd * node.sd;
    switch (node.unit) {
      case "year": return `${signed(v, 1)} 年`;
      case "level": return `${signed(v, 2)} 级`;
      case "z": return `${signed(v, 2)} SD`;
      case "mm3": return `${signed(v, 0)} mm³`;
      case "log": return `${signed(100 * (Math.exp(v) - 1), 1)}%`;
      case "bin": return `${signed(100 * v, 1)} 百分点`;
      default: return signed(v, 2);
    }
  }
  const sdText = (dsd) => `${signed(dsd, 3)} SD`;

  // ---------- 状态 ----------
  const keys = Object.keys(D.meta.interventions);
  let key = "fu";
  const defaultLevel = (k) => {                         // 默认 = 基线（不干预）：连续变量的 0 档，二值变量的"基线"
    const lv = D.meta.interventions[k].levels;
    return Math.max(0, lv.findIndex((l) => l.v === 0 && D.meta.interventions[k].how !== "set" || l.v === "base"));
  };
  let levelIdx = defaultLevel("fu");
  let stages = [];                                      // [{nodes, values, edges, used: Map, recent: Set}]
  let n = 0;
  let zero = false;                                     // 幅度 0 = 不干预
  let index = 0;
  let playing = false;
  let timer = null;
  let dots = [];
  let rafId = 0;
  let overlay = [];
  let geom = null;
  let view = "zoom";
  let sid = D.subjects[0].id;
  const subject = () => D.subjects.find((s) => s.id === sid);
  const imgDir = () => `assets/img/${sid}/`;                                      // 当前尺寸下的节点像素位置和每条边的曲线

  const iv = () => D.meta.interventions[key];
  const level = () => iv().levels[levelIdx];

  function loadScenario() {
    const sc = D.scenarios[sid][`${key}|${level().v}`];
    n = sc.n;
    zero = Boolean(sc.zero);
    const used = new Map();
    stages = sc.steps.map((st) => {
      for (const e of st.edges || []) used.set(eid(e.s, e.t), e.local);
      return { ...st, used: new Map(used), recent: new Set((st.edges || []).map((e) => eid(e.s, e.t))) };
    });
  }

  // ---------- 几何 ----------
  function layoutBox() {
    const W = graphEl.clientWidth, H = graphEl.clientHeight;
    const narrow = W < 860;
    const size = narrow ? [100, 46] : [114, 50];
    const L = (narrow ? 104 : 118) + size[0] / 2, R = size[0] / 2 + 14, top = 40, bottom = 40;
    return { W, H, L, R, top, bottom, iw: Math.max(1, W - L - R), ih: Math.max(1, H - top - bottom), size, narrow };
  }
  const dataPos = (node, b) => [node.x / XMAX * b.iw, node.y / YMAX * b.ih];
  const cpOf = (p1, p2, c) => [(p1[0] + p2[0]) / 2 - (p1[1] - p2[1]) * c, (p1[1] + p2[1]) / 2 - (p2[0] - p1[0]) * c];
  const bez = (p1, cp, p2, t) => [
    (1 - t) ** 2 * p1[0] + 2 * (1 - t) * t * cp[0] + t * t * p2[0],
    (1 - t) ** 2 * p1[1] + 2 * (1 - t) * t * cp[1] + t * t * p2[1],
  ];
  const inRect = (p, c, size, pad) => Math.abs(p[0] - c[0]) < size[0] / 2 + pad && Math.abs(p[1] - c[1]) < size[1] / 2 + pad;

  // 每条边选一个弯曲度，让它尽量不穿过别的节点（与 ECharts graph 的二次曲线控制点公式相同）
  function computeGeom() {
    const b = layoutBox();
    const pos = new Map(D.nodes.map((nd) => [nd.id, dataPos(nd, b)]));
    const cands = [0, 0.1, -0.1, 0.18, -0.18, 0.26, -0.26, 0.34, -0.34];
    const curves = new Map();
    for (const e of D.edges) {
      const p1 = pos.get(e.source), p2 = pos.get(e.target);
      let best = null;
      for (const c of cands) {
        const cp = cpOf(p1, p2, c);
        const hit = new Set();
        for (let t = 0.04; t < 0.97; t += 0.02) {
          const p = bez(p1, cp, p2, t);
          if (p[1] < -b.top + 6 || p[1] > b.ih + b.bottom - 6 || p[0] < -b.L + 100 || p[0] > b.iw + b.R - 6) hit.add("out");
          for (const nd of D.nodes) {
            if (nd.id !== e.source && nd.id !== e.target && inRect(p, pos.get(nd.id), b.size, 5)) hit.add(nd.id);
          }
        }
        if (!best || hit.size < best.hits) best = { c, hits: hit.size };   // 出界算作穿过一个节点
        if (!hit.size) break;
      }
      const cp = cpOf(p1, p2, best.c);
      // 曲线离开源节点、进入目标节点的位置（矩形边界）
      let t0 = 0, t1 = 1;
      while (t0 < 0.5 && inRect(bez(p1, cp, p2, t0), p1, b.size, 1)) t0 += 0.004;
      while (t1 > 0.5 && inRect(bez(p1, cp, p2, t1), p2, b.size, 3)) t1 -= 0.004;
      curves.set(eid(e.source, e.target), { c: best.c, p1, p2, cp, t0, t1 });
    }
    geom = { b, pos, curves };
  }
  const toPx = (p) => [p[0] + geom.b.L, p[1] + geom.b.top];

  // ---------- 颜色 ----------
  function fillOf(d) {
    const a = Math.abs(d);
    if (a < 5e-4) return T["node-idle"];
    const s = d > 0 ? "up" : "down";
    return a < 0.05 ? T[`${s}-1`] : a < 0.25 ? T[`${s}-2`] : T[`${s}-3`];
  }
  const signColor = (d) => Math.abs(d) < 5e-4 ? T.ink3 : d > 0 ? T.up : T.down;

  // ---------- 绘制 ----------
  function tooltip(params) {
    const st = stages[index];
    if (params.dataType === "edge") {
      const e = params.data;
      const s = nodeById.get(e.source), t = nodeById.get(e.target);
      let html = `<b>${s.label} → ${t.label}</b><br><span style="color:${T.ink2}">${D.meta.edge_kinds[e.kind]}</span>`;
      const local = st.used.get(eid(e.source, e.target));
      if (local !== undefined) {
        html += `<br>只改变「${s.label}」、其余父节点不变时，<br>${t.label} 平均变化 <b>${fmtRaw(t, local)}</b>（${sdText(local)}）`;
      }
      return html;
    }
    const nd = nodeById.get(params.data.id);
    const d = st.values[nd.id] || 0;
    let html = `<b>${nd.label}</b><br>平均变化 <b>${fmtRaw(nd, d)}</b>（${sdText(d)}）`;
    if (nd.id === iv().node) html += `<br><span style="color:${T.ink2}">被干预节点</span>`;
    else if (nd.root) html += `<br><span style="color:${T.ink2}">根节点</span>`;
    return html;
  }

  function drawGraph() {
    if (!geom) computeGeom();
    const { b, pos, curves } = geom;
    const st = stages[index];
    const target = iv().node;
    const fresh = new Set(index >= 1 ? st.nodes : []);
    const fs = b.narrow ? 11 : 12.5;
    const data = D.nodes.map((nd) => {
      const d = st.values[nd.id] || 0;
      const isTarget = nd.id === target;
      const changed = Math.abs(d) >= 5e-4;
      const [x, y] = pos.get(nd.id);
      return {
        id: nd.id, name: nd.label, x, y, value: d,
        itemStyle: {
          color: fillOf(d),
          borderColor: changed ? signColor(d) : isTarget ? T.ink2 : T["node-border"],
          borderWidth: isTarget ? 2.6 : changed ? 1.6 : 1.1,
          borderType: isTarget && !changed ? "dashed" : "solid",
          shadowBlur: fresh.has(nd.id) ? 14 : 0,
          shadowColor: fresh.has(nd.id) ? signColor(d) : "transparent",
        },
      };
    });
    const links = D.edges.map((e) => {
      const id = eid(e.source, e.target);
      const local = st.used.get(id);
      const active = local !== undefined;
      const recent = st.recent.has(id) && index >= 2;
      return {
        source: e.source, target: e.target, kind: e.kind,
        lineStyle: {
          color: active ? signColor(local) : T["idle-edge"],
          width: recent ? 2.8 : active ? 1.9 : 1,
          opacity: active ? 0.95 : 0.7,
          curveness: curves.get(id).c,
        },
      };
    });
    chart.setOption({
      animation: !reducedMotion.matches,
      animationDurationUpdate: 260,
      tooltip: {
        trigger: "item", confine: true, formatter: tooltip,
        backgroundColor: T.chart, borderColor: T.line, textStyle: { color: T.ink, fontSize: 12 },
      },
      series: [{
        id: "causal", type: "graph", layout: "none",
        left: b.L, right: b.R, top: b.top, bottom: b.bottom,
        symbol: "roundRect", symbolSize: b.size,
        edgeSymbol: ["none", "none"],
        label: {
          show: true,
          formatter: ({ data: d }) => {
            const nd = nodeById.get(d.id);
            const v = Math.abs(d.value) < 5e-4 ? "0" : fmtRaw(nd, d.value);
            return `{name|${nd.label}}\n{${Math.abs(d.value) < 5e-4 ? "zero" : "val"}|${v}}`;
          },
          rich: {
            name: { color: T.ink, fontSize: fs, fontWeight: 700, lineHeight: fs + 7 },
            val: { color: T.ink, fontSize: fs - 0.5, lineHeight: fs + 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
            zero: { color: T.ink3, fontSize: fs - 0.5, lineHeight: fs + 4 },
          },
        },
        emphasis: { disabled: true },
        data, links,
      }],
    }, { replaceMerge: ["series"] });
    drawOverlay(links);
  }

  function drawOverlay(links) {
    overlay.forEach((el) => zr.remove(el));
    overlay = [];
    const { b, pos, curves } = geom;
    const add = (el) => { overlay.push(el); zr.add(el); };
    // 分层底色 + 行标签
    for (let li = 0; li < 3; li++) {
      const ys = D.nodes.filter((nd) => nd.layer === li).map((nd) => toPx(pos.get(nd.id))[1]);
      const y0 = Math.min(...ys) - b.size[1] / 2 - 10, y1 = Math.max(...ys) + b.size[1] / 2 + 10;
      add(new echarts.graphic.Rect({ shape: { x: 6, y: y0, width: b.W - 12, height: y1 - y0, r: 10 },
        style: { fill: T[`band-${li}`] }, z: 0, silent: true }));
      add(new echarts.graphic.Text({ style: { text: LAYER_NAME[li], x: 16, y: (y0 + y1) / 2, fill: T.ink2,
        fontSize: b.narrow ? 11 : 12.5, fontWeight: 700, verticalAlign: "middle", lineHeight: 18 }, z: 1, silent: true }));
      const rows = [...new Set(ys)].sort((a, c) => a - c);
      rows.forEach((y, k) => add(new echarts.graphic.Text({ style: { text: k ? "Δ" : "T0", x: b.L - b.size[0] / 2 - 26, y,
        fill: T.ink3, fontSize: 12, fontWeight: 700, verticalAlign: "middle" }, z: 1, silent: true })));
    }
    // 箭头（落在目标节点边界，方向 = 曲线切线）
    for (const ln of links) {
      const g = curves.get(eid(ln.source, ln.target));
      const t = g.t1;
      const tip = toPx(bez(g.p1, g.cp, g.p2, t));
      const dx = 2 * (1 - t) * (g.cp[0] - g.p1[0]) + 2 * t * (g.p2[0] - g.cp[0]);
      const dy = 2 * (1 - t) * (g.cp[1] - g.p1[1]) + 2 * t * (g.p2[1] - g.cp[1]);
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const s = ln.lineStyle.width > 1.5 ? 9 : 7;
      add(new echarts.graphic.Polygon({
        shape: { points: [tip,
          [tip[0] - s * ux - s * 0.42 * uy, tip[1] - s * uy + s * 0.42 * ux],
          [tip[0] - s * ux + s * 0.42 * uy, tip[1] - s * uy - s * 0.42 * ux]] },
        style: { fill: ln.lineStyle.color, opacity: ln.lineStyle.opacity }, z: 3, silent: true,
      }));
    }
  }

  // ---------- 沿边移动的小圆点 ----------
  function clearDots() {
    cancelAnimationFrame(rafId);
    dots.forEach((d) => zr.remove(d.el));
    dots = [];
  }
  function animateEdges(edges, duration) {
    clearDots();
    if (reducedMotion.matches || !edges.length) return;
    for (const e of edges) {
      const g = geom.curves.get(eid(e.s, e.t));
      const [x, y] = toPx(bez(g.p1, g.cp, g.p2, g.t0));
      const el = new echarts.graphic.Circle({ shape: { cx: x, cy: y, r: 5 },
        style: { fill: signColor(e.local), stroke: T.chart, lineWidth: 2 }, z: 10, silent: true });
      zr.add(el);
      dots.push({ el, g });
    }
    const start = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const k = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
      for (const { el, g } of dots) {
        const [x, y] = toPx(bez(g.p1, g.cp, g.p2, g.t0 + (g.t1 - g.t0) * k));
        el.attr({ shape: { cx: x, cy: y } });
      }
      if (p < 1) rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);
  }

  // ---------- 面板 ----------
  function stepLabel(i) { return i === 0 ? "基线" : stages[i].obs ? "实际随访" : i === 1 ? "干预" : `第 ${i - 1} 层`; }

  function update() {
    const st = stages[index];
    drawGraph();
    [...byId("steps").children].forEach((btn, i) => {
      if (i === index) btn.setAttribute("aria-current", "step"); else btn.removeAttribute("aria-current");
    });
    byId("step-count").textContent = `${index + 1} / ${stages.length}`;
    const tgt = nodeById.get(iv().node);
    let msg;
    if (st.obs) msg = `实际随访：${subject().short}从基线起 ${subject().interval.toFixed(1)} 年里实际发生的变化（实测值，不是模型推演）。`;
    else if (zero) msg = "不做干预，所有节点保持基线。";
    else if (n === 0) msg = `${subject().short}原本就是这个状态，这个干预不适用。`;
    else if (index === 0) msg = "基线：还没有干预，所有节点的变化量为 0。";
    else if (index === 1) msg = `do(${tgt.label} ${level().label})：先只改被干预节点，下游节点还没重算。适用 ${n} 人。`;
    else {
      const names = st.nodes.map((id) => nodeById.get(id).label).join("、");
      msg = `第 ${index - 1} 层：重算 ${names}（它们的父节点此时都已是最终值）。` + (index === stages.length - 1 ? "传播完成。" : "");
    }
    byId("status").textContent = msg;
    // 干预后的总变化 = T0 行 + Δ 行
    const hasTable = Boolean(subject().base);
    byId("vtable").hidden = !hasTable;
    byId("readout").hidden = hasTable;
    if (hasTable) renderTable(st);
    else byId("readout").replaceChildren(...D.meta.readout.map((r) => {
      const dsd = (st.values[`${r.var}_T0`] || 0) + (st.values[`${r.var}_D`] || 0);
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = r.label;
      dd.textContent = fmtRaw({ unit: r.unit, sd: r.sd }, dsd);
      dd.dataset.sign = Math.abs(dsd) < 5e-4 ? "zero" : dsd > 0 ? "up" : "down";
      div.append(dt, dd);
      return div;
    }));
    updateBrain(st);
    updatePlayback();
  }

  // ---------- 变量表（本地真人版）：基线 / 干预后 / 变化 ----------
  const fx = (x, d) => { const t = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); return (x < 0 && Number(t.replace(/,/g, "")) !== 0 ? "−" : "") + t; };
  const binTxt = (x) => Math.abs(x - Math.round(x)) < 0.005 ? (Math.round(x) ? "是" : "否") : `${x.toFixed(2)}`;
  const VROWS = [
    ["grp", "人口学 / 生活方式"],
    ["age", "年龄", "岁", "age", (x) => fx(x, 1)],
    ["sex", "性别", "", "sex", (x) => (x > 0.5 ? "男" : "女")],
    ["smoke_status", "吸烟", "", "smoke_status", binTxt],
    ["alcohol_frequency", "饮酒频率", "级", "alcohol_frequency", (x) => fx(x, 2)],
    ["processed_meat_intake", "加工肉", "级", "processed_meat_intake", (x) => fx(x, 2)],
    ["grp", "血管代谢"],
    ["bmi", "BMI", "Z", "bmi", (x) => fx(x, 2)],
    ["systolic_blood_pressure", "收缩压", "Z", "systolic_blood_pressure", (x) => fx(x, 2)],
    ["hypertension", "高血压", "", "hypertension", binTxt],
    ["grp", "脑结构"],
    ["lv", "侧脑室", "cm³", "lateral_ventricle_resid_eTIV", (x) => fx(x / 1000, 2)],
    ["hip", "海马", "mm³", "hippocampus_resid_eTIV", (x) => fx(x, 0)],
    ["wm", "大脑白质", "cm³", "cerebral_white_matter_resid_eTIV", (x) => fx(x / 1000, 1)],
    ["wmh", "白质低信号", "mm³", "wm_hypointensities_log_mm3", (x) => fx(x, 0)],
  ];
  const TARGET_ROW = { fu: "age", age: "age", smoke: "smoke_status", alcohol: "alcohol_frequency", meat: "processed_meat_intake",
    bmi: "bmi", sbp: "systolic_blood_pressure", ht: "hypertension" };
  function renderTable(st) {
    const sj = subject(), t = byId("vtable");
    const head = document.createElement("tr");
    head.innerHTML = "<th>变量</th><th>基线</th><th>干预后</th><th>变化</th>";
    const rows = [head];
    for (const row of VROWS) {
      const tr = document.createElement("tr");
      if (row[0] === "grp") { tr.className = "grp"; tr.innerHTML = `<td colspan="4">${row[1]}</td>`; rows.push(tr); continue; }
      const [k, name, unit, v, f] = row;
      const a = sj.base[k];
      let b;
      if (st.obs) b = sj.follow[k];                          // 实际随访：直接用实测值
      else if (k === "sex") b = a;
      else {
        const n0 = nodeById.get(v === "age" ? "age_T0" : `${v}_T0`);
        const dsd = (st.values[n0.id] || 0) + (st.values[v === "age" ? "age_D" : `${v}_D`] || 0);
        b = k === "wmh" ? a * Math.exp(dsd * n0.sd) : a + dsd * n0.sd;
      }
      const dv = b - a, moved = Math.abs(dv) > 1e-6 * Math.max(1, Math.abs(a)) && Math.abs(Number(f(dv).replace(/[,−]/g, ""))) > 0;
      if (k === TARGET_ROW[key] && !zero && n > 0) tr.className = "target";
      tr.innerHTML = `<td>${name}${unit ? `<small>${unit}</small>` : ""}</td><td>${f(a)}</td><td>${f(b)}</td>`
        + `<td class="${moved ? (dv > 0 ? "up" : "down") : ""}">${moved && k !== "sex" ? (dv > 0 ? "+" : "−") + f(Math.abs(dv)) : "—"}</td>`;
      rows.push(tr);
    }
    t.replaceChildren(...rows);
  }

  // ---------- 生成脑图 ----------
  function updateBrain(st) {
    if (!D.images) return;
    byId("img-fact").src = `${imgDir()}base_${view}.png`;
    byId("img-cf").src = `${imgDir()}${st.img}_${view}.png`;
    byId("img-diff").src = st.img === "base" ? blankDiff() : `${imgDir()}${st.img}_d${view}.png`;
    const hasReal = Boolean(D.images.real_dark);
    byId("fig-real").hidden = !hasReal;
    if (hasReal) {
      byId("fig-real").classList.toggle("off", !st.obs);
      byId("img-real").src = st.obs ? `${imgDir()}real_d${view}.png` : blankDiff();
    }
    const lv = (st.values.lateral_ventricle_resid_eTIV_T0 || 0) + (st.values.lateral_ventricle_resid_eTIV_D || 0);
    const lvNode = nodeById.get("lateral_ventricle_resid_eTIV_D");
    const expect = D.images.slope * lv * lvNode.sd;
    byId("brain-read").innerHTML = st.img === "base"
      ? "还没有变化传到脑结构或年龄，干预后的图与基线相同。"
      : st.obs
        ? `生成图上量得脑室暗区 <b>${signed(st.dark, 0)} mm³</b>，真实扫描上是 <b>${signed(D.images.real_dark[sid], 0)} mm³</b>。`
        : `生成图上量得脑室暗区 <b>${signed(st.dark, 0)} mm³</b>，按 SCM 的 Δ侧脑室换算应为 <b>${signed(expect, 0)} mm³</b>。`;
  }
  const blanks = {};
  function blankDiff() {                               // 差异为 0：中性灰，尺寸与当前视图一致（不出现黑边）
    if (!blanks[view]) {
      const [w, h] = { zoom: [243, 288], ax: [193, 229], cor: [193, 193] }[view];
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#f0efec"; ctx.fillRect(0, 0, w, h);
      blanks[view] = cv.toDataURL();
    }
    return blanks[view];
  }
  function preload() {
    if (!D.images) return;
    for (const st of stages) for (const v of ["zoom", "ax", "cor"]) {
      if (st.img !== "base") { new Image().src = `${imgDir()}${st.img}_${v}.png`; new Image().src = `${imgDir()}${st.img}_d${v}.png`; }
    }
  }

  function updatePlayback() {
    const btn = byId("play");
    btn.disabled = stages.length === 1;
    btn.textContent = playing ? "暂停" : stages.length > 1 && index === stages.length - 1 ? "重新播放" : "播放传播";
  }

  function stop() {
    clearTimeout(timer);
    clearDots();
    playing = false;
  }

  // ---------- 播放干预：幅度逐档往后变，因果图直接显示传播完的最后一层 ----------
  let sweeping = false;
  let sweepTimer = null;
  function stopSweep() {
    clearTimeout(sweepTimer);
    sweeping = false;
    updateSweep();
  }
  function updateSweep() {
    byId("sweep").textContent = sweeping ? "暂停" : "播放干预";
  }
  function showLevel(i) {
    levelIdx = i;
    renderLevels();
    rebuild(true);
  }
  function sweepNext() {
    if (levelIdx >= iv().levels.length - 1) { stopSweep(); return; }
    sweepTimer = setTimeout(() => { showLevel(levelIdx + 1); sweepNext(); }, 1300);
  }
  function toggleSweep() {
    if (sweeping) { stopSweep(); return; }
    stop();
    sweeping = true;
    updateSweep();
    for (const lv of iv().levels) {                     // 预加载各档最后一层的脑图
      const last = D.scenarios[sid][`${key}|${lv.v}`].steps.slice(-1)[0];
      if (last.img && last.img !== "base") new Image().src = `${imgDir()}${last.img}_${view}.png`;
    }
    showLevel(levelIdx >= iv().levels.length - 1 ? 0 : levelIdx);
    sweepNext();
  }

  function renderLevels() {
    byId("levels").replaceChildren(...iv().levels.map((lv, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(i === levelIdx));
      btn.textContent = lv.v === "obs" ? `实际随访（${subject().interval.toFixed(1)} 年）` : lv.label;
      btn.addEventListener("click", () => { stopSweep(); levelIdx = i; renderLevels(); rebuild(true); });   // 直接看传播完的最后一层
      return btn;
    }));
    byId("note").textContent = iv().note;
  }

  function rebuild(toEnd = false) {
    stop();
    loadScenario();
    index = toEnd ? stages.length - 1 : 0;
    const steps = byId("steps");
    steps.replaceChildren(...stages.map((_, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "step";
      btn.textContent = stepLabel(i);
      btn.addEventListener("click", () => { stopSweep(); stop(); index = i; update(); });
      return btn;
    }));
    steps.style.setProperty("--steps", stages.length);
    preload();
    update();
  }

  function advance() {
    if (index === stages.length - 1) { stop(); updatePlayback(); return; }
    const next = stages[index + 1];
    const moving = (next.edges || []).length && !reducedMotion.matches;
    animateEdges(next.edges || [], 700);
    timer = setTimeout(() => { clearDots(); index++; update(); advance(); }, moving ? 820 : 520);
  }

  function togglePlay() {
    stopSweep();
    if (playing) { stop(); updatePlayback(); return; }
    if (index === stages.length - 1) { index = 0; update(); }
    playing = true;
    updatePlayback();
    advance();
  }

  // ---------- 初始化 ----------
  if (D.subjects.length > 1) {
    const ss = byId("subject");
    for (const s of D.subjects) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.label;
      ss.append(o);
    }
    byId("subject-field").hidden = false;
    ss.addEventListener("change", () => { stopSweep(); sid = ss.value; setSubjectText(); renderLevels(); rebuild(); });
  }
  function setSubjectText() {
    byId("brain-subject").textContent = subject().label;
  }
  setSubjectText();
  const sel = byId("target");
  for (const k of keys) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = D.meta.interventions[k].name;
    sel.append(o);
  }
  sel.value = key;
  sel.addEventListener("change", () => {
    stopSweep();
    key = sel.value;
    levelIdx = defaultLevel(key);
    renderLevels();
    rebuild();
  });
  byId("play").addEventListener("click", togglePlay);
  byId("sweep").addEventListener("click", toggleSweep);
  byId("reset").addEventListener("click", () => { stopSweep(); key = "fu"; levelIdx = defaultLevel("fu"); sel.value = key; renderLevels(); rebuild(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest("select, input, textarea")) return;
    if (ev.key === "ArrowRight" && index < stages.length - 1) { stop(); index++; update(); }
    else if (ev.key === "ArrowLeft" && index > 0) { stop(); index--; update(); }
    else if (ev.key === " " && !ev.target.closest("button")) { ev.preventDefault(); togglePlay(); }
  });

  // 网址参数：#t=fu&l=5&s=4（干预、幅度、步骤），方便准备讲稿或直接打开某一步
  const hp = new URLSearchParams(location.hash.slice(1));
  let initStep = 0;
  if (hp.has("t") && D.meta.interventions[hp.get("t")]) {
    key = hp.get("t");
    sel.value = key;
    const li = iv().levels.findIndex((l) => String(l.v) === hp.get("l"));
    levelIdx = li >= 0 ? li : 0;
  }
  if (hp.has("p") && D.subjects.some((s) => s.id === hp.get("p"))) { sid = hp.get("p"); byId("subject").value = sid; setSubjectText(); }
  if (hp.has("s")) initStep = Number(hp.get("s")) || 0;

  if (D.images) {
    byId("brain-panel").hidden = false;
    byId("views").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-view]");
      if (!btn) return;
      view = btn.dataset.view;
      byId("brain-panel").dataset.view = view;
      for (const b of byId("views").children) b.setAttribute("aria-checked", String(b === btn));
      updateBrain(stages[index]);
    });
  }

  readTokens();
  darkQuery.addEventListener("change", () => { readTokens(); drawGraph(); });
  new ResizeObserver(() => {
    clearDots();
    chart.resize();
    computeGeom();
    drawGraph();
  }).observe(graphEl);
  renderLevels();
  rebuild();
  if (initStep) { index = Math.min(initStep, stages.length - 1); update(); }
})();
