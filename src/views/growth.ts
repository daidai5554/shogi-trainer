// 成長の記録: 対局ごとの精度の推移と、練習カレンダー。
import { dateKey, streak, type ActivityLog } from "../db";
import type { Game } from "../types";
import { h } from "../ui";

export interface GameMetric { at: number; avgLoss: number; bad: number }

/** 対局ごとの「1手あたりの平均損失(勝率)」と「悪手・疑問手の数」(古い順) */
export function gameMetrics(games: Game[]): GameMetric[] {
  return games
    .filter((g) => g.verdicts?.length)
    .map((g) => {
      const mine = g.verdicts!.filter((v) => v.side === g.mySide);
      const avgLoss = mine.length ? mine.reduce((a, v) => a + v.lossWin, 0) / mine.length : 0;
      const bad = mine.filter((v) => v.kind === "blunder" || v.kind === "mistake").length;
      return { at: g.playedAt, avgLoss, bad };
    })
    .sort((a, b) => a.at - b.at);
}

function movingAvg(xs: number[], n: number): number[] {
  return xs.map((_, i) => {
    const s = xs.slice(Math.max(0, i - n + 1), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
}

function sparkline(values: number[], fmt: (v: number) => string, lowerIsBetter = true): HTMLElement {
  const W = 300, H = 60, P = 4;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(P + (i / Math.max(1, values.length - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - (v - min) / span) * (H - 2 * P)).toFixed(1)}`);
  const first = values[0], last = values[values.length - 1];
  const improved = lowerIsBetter ? last < first : last > first;
  const el = h("div", { class: "spark" });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts.join(" ")}" class="spark-line ${improved ? "up" : "down"}"/></svg>`;
  el.append(h("div", { class: "spark-label small" }, h("span", { class: "muted" }, `最初 ${fmt(first)}`), h("b", { class: improved ? "good" : "bad" }, `最近 ${fmt(last)}`)));
  return el;
}

export function growthCard(games: Game[]): HTMLElement {
  const m = gameMetrics(games);
  const card = h("section", { class: "card" }, h("h2", {}, "成長の記録"));
  if (m.length < 3) {
    card.append(h("p", { class: "small muted" }, `解析済みの対局が3局以上になると、上達の推移をグラフで表示します（いま${m.length}局）。`));
    return card;
  }
  const n = Math.min(5, Math.max(2, Math.floor(m.length / 3)));
  card.append(
    h("p", { class: "small muted" }, `${m.length}局・直近${n}局の移動平均。どちらも下がっていれば上達しています。`),
    h("div", { class: "small" }, "1手あたりの損失（勝率）"),
    sparkline(movingAvg(m.map((x) => x.avgLoss * 100), n), (v) => `${v.toFixed(1)}%`),
    h("div", { class: "small" }, "1局あたりの悪手・疑問手"),
    sparkline(movingAvg(m.map((x) => x.bad), n), (v) => `${v.toFixed(1)}回`),
  );
  return card;
}

/** 今週(直近7日)と先週(その前の7日)の比較 */
export function weeklyCard(games: Game[], log: ActivityLog, now = Date.now()): HTMLElement {
  const DAY = 86_400_000;
  const range = (from: number, to: number) => {
    const gs = games.filter((g) => g.playedAt >= from && g.playedAt < to);
    const wins = gs.filter((g) => g.result === "win").length;
    const losses = gs.filter((g) => g.result === "lose").length;
    const m = gameMetrics(gs);
    const loss = m.length ? m.reduce((a, x) => a + x.avgLoss, 0) / m.length : null;
    let days = 0, solved = 0;
    for (let t = from; t < to; t += DAY) { const d = log[dateKey(t)]; if (d) { days++; solved += d.solved; } }
    return { n: gs.length, wins, losses, loss, days, solved };
  };
  const cur = range(now - 7 * DAY, now + 1);
  const prev = range(now - 14 * DAY, now - 7 * DAY);
  const wr = (r: typeof cur) => (r.wins + r.losses ? `${Math.round((r.wins / (r.wins + r.losses)) * 100)}%` : "-");
  const ls = (r: typeof cur) => (r.loss != null ? `${(r.loss * 100).toFixed(1)}%` : "-");
  const better = cur.loss != null && prev.loss != null ? (cur.loss < prev.loss ? "good" : "bad") : "";
  return h("section", { class: "card" },
    h("h2", {}, "今週と先週"),
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "今週"), h("th", {}, "先週"))),
      h("tbody", {},
        h("tr", {}, h("td", {}, "対局"), h("td", {}, `${cur.n}局`), h("td", {}, `${prev.n}局`)),
        h("tr", {}, h("td", {}, "勝率"), h("td", {}, wr(cur)), h("td", {}, wr(prev))),
        h("tr", {}, h("td", {}, "1手の損失"), h("td", { class: better }, ls(cur)), h("td", {}, ls(prev))),
        h("tr", {}, h("td", {}, "練習した日"), h("td", {}, `${cur.days}日（${cur.solved}問）`), h("td", {}, `${prev.days}日（${prev.solved}問）`)))),
    h("p", { class: "small muted" }, "「1手の損失」は自分の指し手1手あたり、平均で勝率を何%損したか（低いほど良い）。"));
}

/** 直近4週間の練習カレンダー */
export function calendarCard(log: ActivityLog, now = Date.now()): HTMLElement {
  const st = streak(log, now);
  const cells: HTMLElement[] = [];
  for (let i = 27; i >= 0; i--) {
    const t = now - i * 86_400_000;
    const d = log[dateKey(t)];
    const lv = !d ? 0 : d.solved >= 16 ? 3 : d.solved >= 8 ? 2 : 1;
    cells.push(h("span", { class: `cal lv${lv}${i === 0 ? " today" : ""}`, title: `${dateKey(t)} ${d ? d.solved + "問" : ""}` }));
  }
  const total = Object.values(log).reduce((a, d) => a + d.solved, 0);
  return h("section", { class: "card" },
    h("h2", {}, "練習カレンダー"),
    h("div", { class: "kv" }, h("span", {}, "連続練習日数"), h("b", {}, `${st.days}日${st.today ? "" : "（今日はまだ）"}`)),
    h("div", { class: "cal-grid" }, ...cells),
    h("p", { class: "small muted" }, `直近4週間（右下が今日）・これまでに解いた数 ${total}問`));
}
