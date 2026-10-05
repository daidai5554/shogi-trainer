// 定跡の手順ドリル: 自分の対局で実際に出会った手順を、相手役(アプリ)と指し進めて確認する。
// 相手の手 = 自分の対局でよく指された手(負けた手ほど出やすい)、自分の手 = AI推奨 or 実戦で損しなかった手。
import { Color, Move, Position, Record } from "tsshogi";
import { usiToJapanese } from "../analysis";
import { BoardView } from "../board";
import { buildBook, positionKey, type BookNode, type BookTree } from "../book";
import * as db from "../db";
import { engine } from "../engine";
import { winRate, negate } from "../score";
import type { Side } from "../types";
import { h } from "../ui";

export const LINE_MAX_PLY = 30;
const START_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

export interface LineResult { moves: number; correct: number }

/** 指定の側の定跡ツリーを作る(解析済みの対局のみ) */
export async function loadTree(side: Side): Promise<BookTree> {
  const games = (await db.allGames()).filter((g) => g.analysisDone);
  return buildBook(games, side, LINE_MAX_PLY);
}

/** ドリルに使える側(対局が多い方。両方あれば日替わり) */
export async function pickDrillSide(): Promise<Side | null> {
  const games = (await db.allGames()).filter((g) => g.analysisDone);
  const b = games.filter((g) => g.mySide === "black").length;
  const w = games.filter((g) => g.mySide === "white").length;
  if (!b && !w) return null;
  if (b && w && Math.min(b, w) >= 3) return new Date().getDate() % 2 ? "black" : "white";
  return w >= b ? "white" : "black";
}

function acceptable(node: BookNode): string[] {
  const set = new Set<string>();
  if (node.aiBest) set.add(node.aiBest);
  // 実戦で指して損が小さかった手(勝率3%未満。定跡ツリーの「外れた手」と同じ基準)も正解
  for (const e of node.edges.values()) {
    if (e.mine && e.lossN > 0 && e.lossSum / e.lossN < 0.03) set.add(e.usi);
  }
  return [...set];
}

function pickOpponentMove(node: BookNode): string | null {
  const edges = [...node.edges.values()].filter((e) => !e.mine);
  if (!edges.length) return null;
  // 指された回数が多い手・負けた手ほど出やすくする
  const weights = edges.map((e) => e.count + e.losses * 2);
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < edges.length; i++) { r -= weights[i]; if (r <= 0) return edges[i].usi; }
  return edges[0].usi;
}

/**
 * ドリルを container に描画する。startPath から始める(定跡ツリーの途中から始める場合)。
 */
export function runLineDrill(container: HTMLElement, tree: BookTree, side: Side, opts: { startPath?: string[]; onDone: (r: LineResult) => void }) {
  const myColor = side === "black" ? Color.BLACK : Color.WHITE;
  const path: string[] = [...(opts.startPath ?? [])];
  let correct = 0;
  let asked = 0;
  let waiting = false;

  const board = new BoardView(Position.newBySFEN(START_SFEN)!, { flipped: side === "white" });
  const info = h("p", { class: "prompt" });
  const movesEl = h("div", { class: "pv-moves small" });
  const feedback = h("div", { class: "feedback" });
  const buttons = h("div", { class: "row" });
  container.replaceChildren(
    h("div", { class: "tags" }, h("span", { class: "tag k-book" }, "定跡ドリル"), h("span", { class: "tag" }, side === "black" ? "☗先手" : "☖後手")),
    info, board.el, movesEl, feedback, buttons);

  const record = () => {
    const r = Record.newByUSI(`startpos${path.length ? " moves " + path.join(" ") : ""}`);
    if (r instanceof Error) throw r;
    r.goto(r.length);
    return r;
  };
  const nodeNow = (): BookNode | undefined => tree.nodes.get(positionKey(record().position.sfen));

  const draw = (interactive: boolean, arrows: { usi: string; color: "best" | "played" | "pv" }[] = []) => {
    const r = record();
    board.update(r.position, {
      flipped: side === "white", lastMoveUsi: path[path.length - 1] ?? null, arrows,
      interactive: interactive ? { color: myColor, onMove: (m) => void onMove(m) } : undefined,
    });
    movesEl.textContent = path.length ? usiToJapanese(START_SFEN, path).join(" ") : "";
  };

  const finish = (reason: string) => {
    draw(false);
    info.textContent = reason;
    feedback.replaceChildren(h("div", { class: `verdict ${asked && correct === asked ? "ok" : ""}` }, asked ? `${asked}手中 ${correct}手 正解` : "確認する手がありませんでした"));
    buttons.replaceChildren(
      h("button", { class: "btn", onclick: () => runLineDrill(container, tree, side, opts) }, "もう一度（別の手順）"),
      h("button", { class: "btn primary", onclick: () => opts.onDone({ moves: asked, correct }) }, "次へ"));
  };

  const step = () => {
    const r = record();
    if (path.length >= LINE_MAX_PLY) return finish(`${LINE_MAX_PLY}手目まで確認しました。`);
    const node = nodeNow();
    if (!node) return finish("ここから先は、あなたの対局に記録がありません。");
    if (r.position.color === myColor) {
      const acc = acceptable(node);
      if (!acc.length) return finish("ここから先は、AIの解析がありません。");
      info.textContent = `${path.length + 1}手目：あなたの番です。いつもの局面で、AI推奨の手を指してください。`;
      draw(true);
    } else {
      const usi = pickOpponentMove(node);
      if (!usi) return finish("ここから先は、相手の手の記録がありません。");
      info.textContent = "相手の番…";
      draw(false);
      waiting = true;
      setTimeout(() => { path.push(usi); waiting = false; step(); }, 450);
    }
  };

  const onMove = async (m: Move) => {
    if (waiting) return;
    waiting = true;
    const node = nodeNow()!;
    const acc = acceptable(node);
    const usi = m.usi;
    const sfen = record().position.sfen;
    const ja = (u: string) => usiToJapanese(sfen, [u])[0] ?? u;
    asked++;
    if (acc.includes(usi)) {
      correct++;
      void db.logPractice(true);
      feedback.replaceChildren(h("div", { class: "small good" }, `◯ ${ja(usi)}`));
      path.push(usi);
      waiting = false;
      step();
      return;
    }
    // 記録に無い手は、AIが使えれば評価して、十分良ければ認める(その先は記録が無いので終了)
    if (engine.state === "ready" && node.aiScore) {
      feedback.replaceChildren(h("div", { class: "muted" }, "AIが確認中…"));
      const res = await engine.search(`sfen ${sfen} moves ${usi}`, { nodes: 200_000 });
      const s = res.lines[0] ? negate(res.lines[0].score) : null;
      if (s && winRate(node.aiScore) - winRate(s) <= 0.03) {
        correct++;
        void db.logPractice(true);
        path.push(usi);
        waiting = false;
        // 実戦で指したことのある手なら、その先の記録で続ける
        if (node.edges.has(usi)) {
          feedback.replaceChildren(h("div", { class: "small good" }, `◯ ${ja(usi)}（AI判定で良い手）`));
          return step();
        }
        return finish(`◯ ${ja(usi)} も良い手です（AI判定）。ただ、この先はあなたの対局に記録がないので、ここで終わります。`);
      }
    }
    void db.logPractice(false);
    const edge = node.edges.get(usi);
    const loss = edge && edge.lossN ? `（実戦でも指して 平均 勝率−${Math.round((edge.lossSum / edge.lossN) * 100)}%）` : "";
    feedback.replaceChildren(
      h("div", { class: "small bad" }, `✕ ${ja(usi)}${loss}`),
      h("div", { class: "small" }, h("span", { class: "label best" }, "推奨"), " ", acc.map(ja).join("・")));
    draw(false, [{ usi: acc[0], color: "best" }, { usi, color: "played" }]);
    buttons.replaceChildren(h("button", {
      class: "btn primary", onclick: () => { buttons.replaceChildren(); path.push(acc[0]); waiting = false; feedback.replaceChildren(); step(); },
    }, "推奨手で続ける"));
  };

  buttons.replaceChildren();
  step();
}
