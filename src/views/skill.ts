// 実力の測定: 指し手の正確さ・局面別の力・勝負強さ・時間・推定段級と、その推移。戦型ごとの実力と弱点。
import * as db from "../db";
import {
  PHASES, allSkills, estimateRating, fitRatingModel, mainSource, ratingFine, ratingText, summarize,
  type GameSkill, type RatingModel, type Summary,
} from "../skill";
import { PHASE_JA } from "../stats";
import type { Phase } from "../types";
import { fmtDate, h, pct } from "../ui";
import { emptyState } from "./common";

const lossText = (v: number | null) => (v == null ? "-" : `${(v * 100).toFixed(1)}%`);
const rateText = (v: number | null) => (v == null ? "-" : pct(v));

/** 推移グラフで選べる指標 */
interface Metric {
  key: string;
  label: string;
  lowerIsBetter: boolean;
  fmt: (v: number) => string;
  /** 対局のまとまりから値を出す(該当なしは null) */
  of: (s: Summary, list: GameSkill[]) => number | null;
  note: string;
}

function metrics(model: RatingModel | null, src: string | null): Metric[] {
  const out: Metric[] = [
    { key: "loss", label: "1手の損失", lowerIsBetter: true, fmt: (v) => `${(v * 100).toFixed(1)}%`, of: (s) => s.loss, note: "自分の1手あたり、平均で勝率を何%損したか。低いほど正確。" },
    { key: "match", label: "AI一致率", lowerIsBetter: false, fmt: (v) => pct(v), of: (s) => s.match, note: "AIの最善手と同じ手を指した割合。高いほど良い。" },
    { key: "bad", label: "悪手/100手", lowerIsBetter: true, fmt: (v) => v.toFixed(1), of: (s) => s.badPer100, note: "100手あたりの悪手・疑問手（勝率10%以上損した手）の数。" },
    ...PHASES.map((p): Metric => ({
      key: p, label: `${PHASE_JA[p]}の損失`, lowerIsBetter: true, fmt: (v) => `${(v * 100).toFixed(1)}%`,
      of: (s) => s.phaseLoss[p], note: `${PHASE_JA[p]}の1手あたりの損失。`,
    })),
  ];
  if (model) {
    out.unshift({
      key: "est", label: "推定段級", lowerIsBetter: false, fmt: (v) => ratingFine(v, model.source),
      of: (s) => (s.loss == null ? null : estimateRating(model, s.loss)),
      note: "指し手の正確さから推定した段級。対局者の段級と正確さの関係から計算。",
    });
  }
  if (src) {
    out.push({
      key: "official", label: src === "wars" ? "公式の段級" : "公式レート", lowerIsBetter: false,
      fmt: (v) => ratingText(v, src as GameSkill["source"]),
      of: (_s, list) => {
        const r = list.filter((g) => g.source === src && g.myRating != null).map((g) => g.myRating!);
        return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
      },
      note: "対局サイトでの自分の段級・レート（棋譜に記録された値）。",
    });
  }
  return out;
}

/** 比較する2つの区間: 最近k局とその前のk局(5局以下はぶれが大きいので比較しない) */
function windows(list: GameSkill[]): { recent: GameSkill[]; prev: GameSkill[]; k: number } {
  if (list.length < 6) return { recent: list, prev: [], k: list.length };
  const k = Math.min(10, Math.floor(list.length / 2));
  return { recent: list.slice(-k), prev: list.slice(-2 * k, -k), k };
}

function delta(cur: number | null, prev: number | null, lowerIsBetter: boolean, fmt: (v: number) => string): HTMLElement | "" {
  if (cur == null || prev == null) return "";
  const d = cur - prev;
  if (fmt(cur) === fmt(prev)) return h("span", { class: "delta muted" }, "→ 変わらず");
  const better = lowerIsBetter ? d < 0 : d > 0;
  return h("span", { class: `delta ${better ? "good" : "bad"}` }, `${better ? "▲" : "▼"} 前は${fmt(prev)}`);
}

export async function skillView(root: HTMLElement) {
  const games = await db.allGames();
  const list = allSkills(games);
  root.append(h("div", { class: "title-row" }, h("h1", {}, "実力の測定"), h("a", { class: "link", href: "#/stats" }, "分析へ")));
  if (list.length < 3) {
    root.append(emptyState(`解析済みの対局が3局以上になると、実力を数値で表示します（いま${list.length}局）。`, h("a", { class: "btn primary", href: "#/import" }, "棋譜を取り込む")));
    return;
  }
  const all = summarize(list);
  const src = mainSource(list);
  const model = src ? fitRatingModel(list, src) : null;
  const ms = metrics(model, src);
  const { recent, prev, k } = windows(list);
  const R = summarize(recent), P = prev.length ? summarize(prev) : null;

  root.append(
    overviewCard(R, P, recent, prev, k, ms, model),
    trendCard(list, ms),
    phaseCard(all),
    clutchCard(all, R, P),
    timeCard(all),
    strategyCard(list, all),
    ratingCard(list, model, src, R),
    h("p", { class: "small muted" }, `解析済み${list.length}局・自分の指し手${all.moves}手から計算。1局ごとの数値は相手や局面の難しさでぶれるので、10局以上のまとまりで見てください。`),
  );
}

// ───────── 最近の実力(タイル) ─────────
function overviewCard(R: Summary, P: Summary | null, recent: GameSkill[], prev: GameSkill[], k: number, ms: Metric[], model: RatingModel | null): HTMLElement {
  const tile = (label: string, value: string, d: HTMLElement | "", sub = "") =>
    h("div", { class: "tile" }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value), d, sub ? h("div", { class: "tile-sub muted" }, sub) : "");
  const m = (key: string) => ms.find((x) => x.key === key)!;
  const val = (mt: Metric, s: Summary | null, l: GameSkill[]) => (s ? mt.of(s, l) : null);
  const t = (key: string) => {
    const mt = m(key);
    const cur = val(mt, R, recent);
    return tile(mt.label, cur == null ? "-" : mt.fmt(cur), delta(cur, val(mt, P, prev), mt.lowerIsBetter, mt.fmt));
  };
  const rate = (r: { chances: number; wins: number }) => (r.chances ? r.wins / r.chances : null);
  return h("section", { class: "card" },
    h("h2", {}, `最近${k}局の実力`),
    h("p", { class: "small muted" }, P ? `▲は前の${prev.length}局より良くなった指標です。` : "6局以上になると、前の対局との比較（▲▼）を表示します。"),
    h("div", { class: "tiles" },
      model ? t("est") : "",
      t("loss"), t("match"), t("bad"),
      tile("詰み発見率", rateText(R.mateRate), delta(R.mateRate, P?.mateRate ?? null, false, rateText), R.mateChances ? `${R.mateChances}回の詰みのうち` : "詰みの場面なし"),
      tile("勝ち切り率", rateText(rate(R.conversion)), delta(rate(R.conversion), P ? rate(P.conversion) : null, false, rateText), `勝率80%以上の${R.conversion.chances}局`),
    ));
}

// ───────── 推移グラフ ─────────
function trendCard(list: GameSkill[], ms: Metric[]): HTMLElement {
  const w = Math.min(10, Math.max(3, Math.floor(list.length / 3)));
  const host = h("div", {});
  const note = h("p", { class: "small muted" });
  let cur = ms[0].key;
  const segs: HTMLElement[] = [];
  const draw = () => {
    const mt = ms.find((x) => x.key === cur)!;
    segs.forEach((el) => el.classList.toggle("active", el.dataset.key === cur));
    const per = list.map((g) => mt.of(summarize([g]), [g]));
    const ma = list.map((_, i) => (i < w - 1 ? null : mt.of(summarize(list.slice(i - w + 1, i + 1)), list.slice(i - w + 1, i + 1))));
    host.replaceChildren(lineChart(list, per, ma, mt));
    note.textContent = `${mt.note} 点は1局ごと、線は直近${w}局の平均。グラフは上に行くほど良い。`;
  };
  for (const mt of ms) {
    const el = h("button", { class: "chip-btn", onclick: () => { cur = mt.key; draw(); } }, mt.label);
    el.dataset.key = mt.key;
    segs.push(el);
  }
  draw();
  return h("section", { class: "card" }, h("h2", {}, "推移"), h("div", { class: "chip-row" }, ...segs), host, note);
}

function lineChart(list: GameSkill[], per: (number | null)[], ma: (number | null)[], mt: Metric): HTMLElement {
  const W = 340, H = 170, L = 44, Rr = 8, T = 10, B = 22;
  const vals = [...per, ...ma].filter((v): v is number => v != null);
  const wrap = h("div", { class: "chart" });
  if (!vals.length) { wrap.append(h("p", { class: "small muted" }, "データがありません")); return wrap; }
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 0.5 * (Math.abs(lo) || 1) * 0.1; hi += 0.5 * (Math.abs(hi) || 1) * 0.1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const n = list.length;
  const x = (i: number) => L + (n === 1 ? (W - L - Rr) / 2 : (i / (n - 1)) * (W - L - Rr));
  // 良い方向を上に描く(損失は下に行くほど悪い)
  const y = (v: number) => {
    const t = (v - lo) / (hi - lo);
    return T + (mt.lowerIsBetter ? t : 1 - t) * (H - T - B);
  };
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag: string, attrs: { [k: string]: string | number }) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": `${mt.label}の推移` });
  // 目盛り(上・中・下)
  for (const f of [0, 0.5, 1]) {
    const v = lo + (hi - lo) * f;
    const yy = y(v);
    svg.append(el("line", { x1: L, x2: W - Rr, y1: yy, y2: yy, class: "grid" }));
    const tx = el("text", { x: L - 6, y: yy + 4, class: "axis", "text-anchor": "end" });
    tx.textContent = mt.fmt(v);
    svg.append(tx);
  }
  for (const [i, anchor] of [[0, "start"], [n - 1, "end"]] as const) {
    const tx = el("text", { x: x(i), y: H - 6, class: "axis", "text-anchor": anchor });
    tx.textContent = fmtDate(list[i].at);
    svg.append(tx);
  }
  per.forEach((v, i) => { if (v != null) svg.append(el("circle", { cx: x(i), cy: y(v), r: 3, class: "dot" })); });
  const pts = ma.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
  if (pts.length > 1) svg.append(el("polyline", { points: pts.join(" "), class: "ma" }));
  const cross = el("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" });
  const mark = el("circle", { r: 5, class: "mark", visibility: "hidden" });
  svg.append(cross, mark);

  const tip = h("div", { class: "chart-tip small" }, "グラフをタップすると、その対局の値が出ます");
  const show = (clientX: number) => {
    const r = svg.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - L) / (W - L - Rr)) * (n - 1))));
    const g = list[i];
    const v = per[i], m = ma[i];
    cross.setAttribute("x1", String(x(i))); cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    if (v != null) { mark.setAttribute("cx", String(x(i))); mark.setAttribute("cy", String(y(v))); mark.setAttribute("visibility", "visible"); }
    tip.replaceChildren(
      h("b", {}, `${fmtDate(g.at)} vs ${g.oppName}`), `（${g.result === "win" ? "勝" : g.result === "lose" ? "負" : "-"}・${g.label}）`, h("br", {}),
      `この対局 ${v == null ? "-" : mt.fmt(v)}`, m != null ? `　平均 ${mt.fmt(m)}` : "", "　",
      h("a", { href: `#/game/${g.id}` }, "棋譜 →"));
  };
  svg.addEventListener("pointerdown", (e) => show(e.clientX));
  svg.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) show(e.clientX); });
  wrap.append(svg, tip);
  return wrap;
}

// ───────── 局面ごとの力 ─────────
function phaseCard(s: Summary): HTMLElement {
  const max = Math.max(...PHASES.flatMap((p) => [s.phaseLoss[p] ?? 0, s.oppPhaseLoss[p] ?? 0]), 0.0001);
  const bar = (v: number | null, cls: string) =>
    h("div", { class: "hbar thin" }, h("div", { class: `hbar-fill ${cls}`, style: `width:${v == null ? 0 : Math.round((v / max) * 100)}%` }));
  const verdict = (me: number | null, op: number | null) => {
    if (me == null || op == null || op === 0) return "";
    const r = me / op;
    return r <= 0.85 ? h("span", { class: "good" }, "相手より正確") : r >= 1.15 ? h("span", { class: "bad" }, "相手より不正確") : h("span", { class: "muted" }, "相手と同じくらい");
  };
  return h("section", { class: "card" },
    h("h2", {}, "局面ごとの力"),
    h("p", { class: "small muted" }, "1手あたりの損失を、同じ対局の相手（ほぼ同じ棋力）と比べます。短いほど正確です。"),
    ...PHASES.map((p) => h("div", { class: "phase-cmp" },
      h("div", { class: "phase-head" }, h("b", {}, PHASE_JA[p]), verdict(s.phaseLoss[p], s.oppPhaseLoss[p])),
      h("div", { class: "bar-row" }, h("span", { class: "bar-label" }, "あなた"), bar(s.phaseLoss[p], "me"), h("span", { class: "bar-value" }, lossText(s.phaseLoss[p]))),
      h("div", { class: "bar-row" }, h("span", { class: "bar-label" }, "相手"), bar(s.oppPhaseLoss[p], "opp"), h("span", { class: "bar-value" }, lossText(s.oppPhaseLoss[p]))))),
    h("div", { class: "kv" }, h("span", {}, "全体の1手の損失（あなた / 相手）"), h("span", {}, `${lossText(s.loss)} / ${lossText(s.oppLoss)}`)),
    h("div", { class: "kv" }, h("span", {}, "AI一致率（あなた / 相手）"), h("span", {}, `${rateText(s.match)} / ${rateText(s.oppMatch)}`)),
    h("div", { class: "kv" }, h("span", {}, "詰み発見率（7手以内の詰み）"), h("span", {}, s.mateChances ? `${rateText(s.mateRate)}（${s.mateChances}回中）` : "-")),
    h("div", { class: "kv" }, h("span", {}, "頓死（1局あたり）"), h("span", {}, s.allowedMatePerGame == null ? "-" : s.allowedMatePerGame.toFixed(2))),
  );
}

// ───────── 勝負強さ ─────────
function clutchCard(s: Summary, R: Summary, P: Summary | null): HTMLElement {
  const rate = (r: { chances: number; wins: number }) => (r.chances ? `${pct(r.wins / r.chances)}（${r.wins}/${r.chances}局）` : "-");
  return h("section", { class: "card" },
    h("h2", {}, "勝負強さ"),
    h("div", { class: "kv" }, h("span", {}, "勝ち切り率"), h("b", {}, rate(s.conversion))),
    h("div", { class: "kv" }, h("span", {}, "逆転率"), h("b", {}, rate(s.comeback))),
    h("div", { class: "kv" }, h("span", {}, `最近${R.games}局の勝ち切り率`), h("span", {}, rate(R.conversion))),
    P ? h("div", { class: "kv" }, h("span", {}, `その前${P.games}局`), h("span", {}, rate(P.conversion))) : "",
    h("p", { class: "small muted" }, "勝ち切り率: 勝率80%以上になった対局を勝った割合。逆転率: 勝率20%以下になった対局を勝った割合。勝ち切り率が低いときは、分析画面の「勝ち切り練習」が効きます。"),
  );
}

// ───────── 時間の使い方 ─────────
function timeCard(s: Summary): HTMLElement {
  const cmp = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? ` ／ ${(a / b).toFixed(1)}倍` : "");
  return h("section", { class: "card" },
    h("h2", {}, "時間の使い方"),
    h("div", { class: "kv" }, h("span", {}, "残り1分未満の1手の損失"), h("span", {}, `${lossText(s.timeTroubleLoss)}${cmp(s.timeTroubleLoss, s.timeOkLoss)}`)),
    h("div", { class: "kv" }, h("span", {}, "時間があるときの1手の損失"), h("span", {}, lossText(s.timeOkLoss))),
    h("div", { class: "kv" }, h("span", {}, "2秒以内に指した手の損失"), h("span", {}, `${lossText(s.fastLoss)}${cmp(s.fastLoss, s.slowLoss)}`)),
    h("div", { class: "kv" }, h("span", {}, "10秒以上考えた手の損失"), h("span", {}, lossText(s.slowLoss))),
    h("p", { class: "small muted" }, s.timeTroubleMoves ? `残り1分未満で指した手は${s.timeTroubleMoves}手。「◯倍」は時間があるとき・よく考えたときと比べた損失の大きさ。` : "持ち時間の記録がある棋譜が増えると表示されます。"),
  );
}

// ───────── 戦型ごとの実力と弱点 ─────────
function strategyCard(list: GameSkill[], all: Summary): HTMLElement {
  const group = (key: (g: GameSkill) => string) => {
    const m = new Map<string, GameSkill[]>();
    for (const g of list) m.set(key(g), [...(m.get(key(g)) ?? []), g]);
    return [...m.entries()].map(([name, gs]) => ({ name, gs, s: summarize(gs) })).sort((a, b) => b.gs.length - a.gs.length);
  };
  const byLabel = group((g) => g.label);
  const byMine = group((g) => g.myOpening);
  // 問題には相手の作戦(label)が記録されているので、練習へのリンクは相手の作戦別だけ
  const trainable = new Set(byLabel.map((r) => r.name));
  const MIN = 3;

  /** その戦型で、全体と比べて一番損失が多い局面 */
  const weakPhase = (s: Summary): { p: Phase; ratio: number } | null => {
    let best: { p: Phase; ratio: number } | null = null;
    for (const p of PHASES) {
      const v = s.phaseLoss[p], base = all.phaseLoss[p];
      if (v == null || !base) continue;
      const ratio = v / base;
      if (!best || ratio > best.ratio) best = { p, ratio };
    }
    return best;
  };

  const table = (rows: typeof byLabel, title: string) => h("div", {},
    h("h3", {}, title),
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "戦型"), h("th", {}, "局"), h("th", {}, "勝率"), h("th", {}, "損失"), h("th", {}, "一致"))),
      h("tbody", {}, ...rows.map((r) => {
        const wr = r.s.wins + r.s.losses ? r.s.wins / (r.s.wins + r.s.losses) : null;
        const cls = r.gs.length < MIN || r.s.loss == null || all.loss == null ? "" : r.s.loss <= all.loss * 0.9 ? "good" : r.s.loss >= all.loss * 1.1 ? "bad" : "";
        return h("tr", {},
          h("td", {}, trainable.has(r.name) ? h("a", { href: `#/train?opening=${encodeURIComponent(r.name)}` }, r.name) : r.name),
          h("td", {}, String(r.gs.length)),
          h("td", {}, rateText(wr)),
          h("td", { class: cls }, lossText(r.s.loss)),
          h("td", {}, rateText(r.s.match)));
      }))));

  // 強み・弱点の文章
  const notes: HTMLElement[] = [];
  const enough = [...byLabel, ...(byMine.length > 1 ? byMine : [])].filter((r) => r.gs.length >= MIN && r.s.loss != null);
  if (enough.length >= 2 && all.loss) {
    const sorted = [...enough].sort((a, b) => a.s.loss! - b.s.loss!);
    const strong = sorted[0], weak = sorted[sorted.length - 1];
    if (strong.s.loss! <= all.loss * 0.92) {
      notes.push(h("div", { class: "weak good-note" }, h("div", { class: "weak-title" }, `得意: ${strong.name}`),
        h("div", { class: "small" }, `1手の損失 ${lossText(strong.s.loss)}（全体 ${lossText(all.loss)}）・${strong.s.wins}勝${strong.s.losses}敗`)));
    }
    if (weak !== strong && weak.s.loss! >= all.loss * 1.08) {
      const wp = weakPhase(weak.s);
      notes.push(h("div", { class: "weak" }, h("div", { class: "weak-title" }, `苦手: ${weak.name}`),
        h("div", { class: "small" }, `1手の損失 ${lossText(weak.s.loss)}（全体 ${lossText(all.loss)}）・${weak.s.wins}勝${weak.s.losses}敗`),
        wp && wp.ratio >= 1.1 ? h("div", { class: "small" }, `特に${PHASE_JA[wp.p]}の損失が、全体の${PHASE_JA[wp.p]}の${wp.ratio.toFixed(1)}倍。`) : "",
        trainable.has(weak.name) ? h("a", { class: "btn small", href: `#/train?opening=${encodeURIComponent(weak.name)}` }, "この戦型の問題を練習") : ""));
    }
  }
  // 戦型ごとの弱い局面
  for (const r of enough) {
    const wp = weakPhase(r.s);
    if (!wp || wp.ratio < 1.3) continue;
    if (notes.some((n) => n.textContent?.includes(`苦手: ${r.name}`))) continue;
    notes.push(h("div", { class: "weak" }, h("div", { class: "weak-title" }, `${r.name}の${PHASE_JA[wp.p]}`),
      h("div", { class: "small" }, `この戦型の${PHASE_JA[wp.p]}は、全体の${PHASE_JA[wp.p]}より損失が${wp.ratio.toFixed(1)}倍（${lossText(r.s.phaseLoss[wp.p])}）。`)));
  }

  return h("section", { class: "card" },
    h("h2", {}, "戦型ごとの実力"),
    notes.length ? h("div", {}, ...notes)
      : h("p", { class: "small muted" }, enough.length >= 2 ? "戦型による正確さの大きな差はありません。" : `同じ戦型の対局が${MIN}局以上たまると、得意・苦手を表示します。`),
    table(byLabel, "相手の作戦別"),
    byMine.length > 1 ? table(byMine, "自分の作戦別") : "",
    h("p", { class: "small muted" }, "損失が全体より10%以上少ない戦型を緑、多い戦型を赤で表示（3局以上）。相手の作戦名をタップすると、その戦型の問題を練習できます。"),
  );
}

// ───────── 推定段級 ─────────
function ratingCard(list: GameSkill[], model: RatingModel | null, src: string | null, R: Summary): HTMLElement {
  const card = h("section", { class: "card" }, h("h2", {}, "推定段級"));
  if (!src) {
    card.append(h("p", { class: "small muted" }, "棋譜に段級・レートが記録されている対局が増えると推定できます。"));
    return card;
  }
  const source = src as GameSkill["source"];
  const site = source === "wars" ? "将棋ウォーズ" : source === "quest" ? "将棋クエスト" : "このサイト";
  const mine = list.filter((g) => g.source === source && g.myRating != null);
  const official = mine.length ? mine[mine.length - 1].myRating! : null;
  if (!model) {
    const n = list.filter((g) => g.source === source).length;
    card.append(h("p", { class: "small muted" }, `${site}の対局がもう少し増えると（目安: 段級の違う相手と10局以上）、指し手の正確さから段級を推定します（いま${n}局）。`));
    if (official != null) card.append(h("div", { class: "kv" }, h("span", {}, "いまの公式の段級"), h("b", {}, ratingText(official, source))));
    return card;
  }
  const est = R.loss == null ? null : estimateRating(model, R.loss);
  card.append(
    h("div", { class: "kv" }, h("span", {}, "指し手の正確さから見た段級（最近）"), h("b", {}, est == null ? "-" : ratingFine(est, source))),
    official != null ? h("div", { class: "kv" }, h("span", {}, "いまの公式の段級"), h("span", {}, ratingText(official, source))) : "",
    est != null && official != null
      ? h("p", { class: "small" }, est - official >= (source === "wars" ? 0.5 : 50)
        ? "正確さは公式の段級より上です。勝ち切りや時間の使い方を直せば、段級が上がる余地があります。"
        : official - est >= (source === "wars" ? 0.5 : 50)
          ? "正確さは公式の段級より少し下です。悪手の復習で、まず大きな損を減らしましょう。"
          : "正確さと公式の段級はほぼ釣り合っています。")
      : "",
    h("p", { class: "small muted" }, `${site}の対局者のべ${model.points}人分（あなたと相手）の「段級」と「1手の損失」の関係から推定しています。目安として見てください。`),
  );
  return card;
}
