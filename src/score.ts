import type { Score } from "./types";

/** 評価値→勝率(手番側)。Ponanza定数600を使う一般的な換算。 */
export function winRate(s: Score): number {
  if (s.kind === "mate") return s.win ? 1 : 0;
  return 1 / (1 + Math.exp(-s.v / 600));
}

export function negate(s: Score): Score {
  return s.kind === "cp" ? { kind: "cp", v: -s.v } : { kind: "mate", v: s.v, win: !s.win };
}

/** グラフ用の数値(±3000にクリップ) */
export function scoreNum(s: Score): number {
  if (s.kind === "mate") return s.win ? 3000 : -3000;
  return Math.max(-3000, Math.min(3000, s.v));
}

export function scoreText(s: Score): string {
  if (s.kind === "mate") {
    if (s.v === 0) return s.win ? "勝ち" : "詰み";
    return s.win ? `${s.v}手詰め` : `${s.v}手で詰まされる`;
  }
  return (s.v > 0 ? "+" : "") + s.v;
}
