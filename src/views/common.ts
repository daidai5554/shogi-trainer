// 画面間で共有する部品。
import type { Game } from "../types";
import { fmtDate, h } from "../ui";

export const RESULT_JA = { win: "勝ち", lose: "負け", draw: "引分", unknown: "不明" } as const;
export const SOURCE_JA = { wars: "ウォーズ", quest: "クエスト", other: "その他" } as const;

export function opponentOf(g: Game): { name: string; rating: string } {
  return g.mySide === "black" ? { name: g.white, rating: g.whiteRating } : { name: g.black, rating: g.blackRating };
}

export function myMistakeCounts(g: Game): { blunder: number; mistake: number } {
  let blunder = 0, mistake = 0;
  for (const v of g.verdicts ?? []) {
    if (v.side !== g.mySide) continue;
    if (v.kind === "blunder") blunder++;
    else if (v.kind === "mistake") mistake++;
  }
  return { blunder, mistake };
}

export function gameRow(g: Game): HTMLElement {
  const opp = opponentOf(g);
  const c = myMistakeCounts(g);
  const status = g.analysisDone
    ? h("span", { class: "muted" }, `悪手${c.blunder}・疑問手${c.mistake}`)
    : h("span", { class: "muted" }, "解析待ち");
  return h("a", { class: "game-row", href: `#/game/${g.id}` },
    h("span", { class: `result ${g.result}` }, RESULT_JA[g.result]),
    h("div", { class: "game-row-main" },
      h("div", {}, h("b", {}, `vs ${opp.name}`), opp.rating ? h("span", { class: "muted" }, ` ${opp.rating}`) : ""),
      h("div", { class: "small" },
        `${g.mySide === "black" ? "☗先手" : "☖後手"}・${SOURCE_JA[g.source]}・${fmtDate(g.playedAt)}`,
        g.strategy ? `・${g.strategy.label}` : ""),
      h("div", { class: "small" }, status),
    ),
  );
}

export function emptyState(text: string, ...actions: HTMLElement[]): HTMLElement {
  return h("div", { class: "empty" }, h("p", {}, text), ...actions);
}
