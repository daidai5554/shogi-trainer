import * as db from "../db";
import { PHASE_JA, computeStats, findWeaknesses, winPct, type Record3 } from "../stats";
import type { Phase } from "../types";
import { h, pct } from "../ui";
import { emptyState } from "./common";
import { conversionCard } from "./play";
import { calendarCard, growthCard } from "./growth";

function recText(r: Record3): string {
  const w = winPct(r);
  return `${r.wins}勝${r.losses}敗` + (w != null ? `（${pct(w)}）` : "");
}

function bar(value: number, max: number, cls = ""): HTMLElement {
  const w = max > 0 ? Math.round((value / max) * 100) : 0;
  return h("div", { class: "hbar" }, h("div", { class: "hbar-fill " + cls, style: `width:${w}%` }));
}

export async function statsView(root: HTMLElement) {
  const [games, problems] = await Promise.all([db.allGames(), db.allProblems()]);
  root.append(h("h1", {}, "分析"));
  if (!games.length) {
    root.append(emptyState("対局を取り込むと、ここに成績と弱点が表示されます。", h("a", { class: "btn primary", href: "#/import" }, "棋譜を取り込む")));
    return;
  }
  const s = computeStats(games, problems);
  const weak = findWeaknesses(s);
  const phases: Phase[] = ["opening", "middle", "end"];
  const maxPhase = Math.max(...phases.map((p) => s.mistakesByPhase[p]), 0.01);
  const unknown = games.filter((g) => g.result === "unknown").length;

  root.append(
    h("section", { class: "card" },
      h("h2", {}, "成績"),
      h("div", { class: "kv" }, h("span", {}, "全体"), h("b", {}, recText(s.total))),
      ...Object.entries(s.bySource).map(([k, r]) => h("div", { class: "kv" }, h("span", {}, k === "wars" ? "将棋ウォーズ" : k === "quest" ? "将棋クエスト" : "その他"), h("span", {}, recText(r)))),
      h("div", { class: "kv" }, h("span", {}, "先手"), h("span", {}, recText(s.bySide.black))),
      h("div", { class: "kv" }, h("span", {}, "後手"), h("span", {}, recText(s.bySide.white))),
      unknown ? h("p", { class: "small muted" }, `勝敗が不明な対局が${unknown}局あります（対局画面で設定できます）`) : "",
    ),
    h("section", { class: "card" },
      h("h2", {}, "弱点と対策"),
      weak.length
        ? h("div", {}, ...weak.map((w) => h("div", { class: "weak" },
          h("div", { class: "weak-title" }, w.title),
          h("div", { class: "small muted" }, w.detail),
          h("div", { class: "small" }, w.advice),
          w.train ? h("a", { class: "btn small", href: `#/train?${w.train}` }, "この弱点を練習") : "")))
        : h("p", { class: "small muted" }, s.analyzedGames < 3 ? "解析済みの対局が増えると、弱点がはっきり見えてきます（目安: 5局以上）。" : "目立った弱点はありません。この調子で続けましょう。"),
    ),
    growthCard(games),
    calendarCard(await db.getActivity()),
    conversionCard(games),
    h("section", { class: "card" },
      h("h2", {}, "戦型別の成績"),
      h("table", { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "戦型"), h("th", {}, "成績"), h("th", {}, "悪手/局"))),
        h("tbody", {}, ...s.byLabel.map((l) => h("tr", {},
          h("td", {}, h("a", { href: `#/train?opening=${encodeURIComponent(l.label)}` }, l.label)),
          h("td", {}, recText(l.rec)),
          h("td", {}, l.label === "未解析" ? "-" : l.mistakesPerGame.toFixed(1))))),
      ),
      h("p", { class: "small muted" }, "戦型名をタップすると、その戦型の問題だけを練習できます。"),
    ),
    h("section", { class: "card" },
      h("h2", {}, "どこで悪手を指しているか"),
      h("p", { class: "small muted" }, `解析済み${s.analyzedGames}局・1局あたりの悪手＋疑問手の数`),
      ...phases.map((p) => h("div", { class: "bar-row" },
        h("span", { class: "bar-label" }, PHASE_JA[p]),
        bar(s.mistakesByPhase[p], maxPhase, p),
        h("span", { class: "bar-value" }, s.mistakesByPhase[p].toFixed(1)))),
    ),
    h("section", { class: "card" },
      h("h2", {}, "時間の使い方と終盤"),
      h("div", { class: "kv" }, h("span", {}, "2秒以内に指した悪手・疑問手"), h("span", {}, s.myMistakes ? `${s.fastMistakes}/${s.myMistakes}（${pct(s.fastMistakes / s.myMistakes)}）` : "-")),
      h("div", { class: "kv" }, h("span", {}, "残り1分未満での悪手・疑問手"), h("span", {}, s.timeTroubleMoves ? `${s.timeTroubleMistakes}/${s.timeTroubleMoves}手` : "-")),
      h("div", { class: "kv" }, h("span", {}, "詰みの見逃し"), h("span", {}, `${s.missedMates}回`)),
      h("div", { class: "kv" }, h("span", {}, "頓死"), h("span", {}, `${s.allowedMates}回`)),
    ),
    h("section", { class: "card" },
      h("h2", {}, "練習の記録"),
      h("div", { class: "kv" }, h("span", {}, "問題数"), h("span", {}, `${s.problems}問`)),
      h("div", { class: "kv" }, h("span", {}, "習得済み"), h("span", {}, `${s.mastered}問`)),
      h("div", { class: "kv" }, h("span", {}, "今日の復習"), h("span", {}, `${s.due}問`)),
      h("div", { class: "kv" }, h("span", {}, "直近50回の正答率"), h("span", {}, s.accuracy != null ? pct(s.accuracy) : "-")),
    ),
  );
}
