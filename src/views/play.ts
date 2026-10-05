// AIと指し継ぐ: 任意の局面からAIと対局する(勝ち切る練習・粘る練習)。
import { Color, Move, Position } from "tsshogi";
import { usiToJapanese } from "../analysis";
import { BoardView } from "../board";
import * as db from "../db";
import { engine } from "../engine";
import { hasLegalMove, recordOf } from "../kifu";
import { negate, scoreText, winRate } from "../score";
import type { Game, Score, Side } from "../types";
import { h, pct } from "../ui";

const LEVELS = [
  { nodes: 3_000, label: "やさしい" },
  { nodes: 30_000, label: "ふつう" },
  { nodes: 300_000, label: "本気" },
];

export interface PlayLog { at: number; from: string; result: "win" | "lose" | "resign"; moves: number }

/** 対局画面へのリンク */
export function playHref(sfen: string, side: Side, from = ""): string {
  return `#/play?sfen=${encodeURIComponent(sfen)}&side=${side}${from ? `&from=${encodeURIComponent(from)}` : ""}`;
}

export async function playView(root: HTMLElement, _args: string[], q: URLSearchParams) {
  const sfen = q.get("sfen") ?? "";
  const side = (q.get("side") as Side) || "black";
  const from = q.get("from") ?? "";
  const start = Position.newBySFEN(sfen);
  if (!start) {
    root.append(h("p", {}, "局面を読み込めませんでした。"), h("a", { class: "btn", href: "#/" }, "ホームへ"));
    return;
  }
  const userColor = side === "black" ? Color.BLACK : Color.WHITE;
  let level = (await db.getKV<number>("playLevel")) ?? LEVELS[1].nodes;
  let showEval = false;
  let lastScore: Score | null = null; // ユーザーから見た評価
  let pos = start.clone();
  let moves: string[] = [];
  let over = false;
  let thinking = false;
  let alive = true;

  const fromGame = from ? await db.getGame(from.split(":")[0]) : undefined;
  const names = fromGame ? { blackName: fromGame.black, whiteName: fromGame.white } : {};
  const board = new BoardView(pos, { flipped: side === "white", ...names });
  const status = h("p", { class: "prompt" });
  const evalEl = h("div", { class: "small muted" });
  const movesEl = h("div", { class: "pv-moves small" });
  const result = h("div", { class: "feedback" });
  const levelSel = h("select", { class: "input inline" }, ...LEVELS.map((l) => h("option", { value: l.nodes }, `AIの強さ: ${l.label}`))) as HTMLSelectElement;
  levelSel.value = String(level);
  levelSel.addEventListener("change", () => { level = Number(levelSel.value); void db.putKV("playLevel", level); });
  const evalChk = h("input", { type: "checkbox" }) as HTMLInputElement;
  evalChk.addEventListener("change", () => { showEval = evalChk.checked; drawEval(); });
  const buttons = h("div", { class: "row wrap" },
    h("button", { class: "btn", onclick: () => undo() }, "待った"),
    h("button", { class: "btn", onclick: () => restart() }, "最初から"),
    h("button", { class: "btn danger", onclick: () => end("resign") }, "投了"));

  root.append(
    h("h1", {}, "AIと指し継ぐ"),
    h("p", { class: "small muted" },
      `あなたは${side === "black" ? "☗先手" : "☖後手"}。`,
      fromGame ? `vs ${fromGame.mySide === "black" ? fromGame.white : fromGame.black} の対局 ${from.split(":")[1]}手目の局面から。` : ""),
    h("div", { class: "row wrap" }, levelSel, h("label", { class: "check small" }, evalChk, " 形勢を表示")),
    status, board.el, evalEl, movesEl, result, buttons);

  const drawEval = () => {
    evalEl.textContent = showEval && lastScore ? `形勢（あなた）: ${pct(winRate(lastScore))}（${scoreText(lastScore)}）` : "";
  };
  const draw = () => {
    const myTurn = pos.color === userColor && !over;
    board.update(pos, {
      flipped: side === "white", ...names,
      lastMoveUsi: moves[moves.length - 1] ?? null,
      interactive: myTurn && !thinking ? { color: userColor, onMove: (m) => void onUser(m) } : undefined,
    });
    movesEl.textContent = moves.length ? usiToJapanese(sfen, moves).join(" ") : "";
    if (!over) status.textContent = thinking ? "AIが考えています…" : myTurn ? "あなたの番です。" : "";
    drawEval();
  };

  const end = async (r: PlayLog["result"]) => {
    if (over) return;
    over = true;
    const text = r === "win" ? "◯ あなたの勝ち！" : r === "resign" ? "投了しました" : "✕ 詰まされました";
    status.textContent = "";
    result.replaceChildren(h("div", { class: `verdict ${r === "win" ? "ok" : "ng"}` }, text),
      r === "resign" && lastScore ? h("div", { class: "small muted" }, `投了した局面の評価（あなた）: ${scoreText(lastScore)}`) : "");
    buttons.replaceChildren(
      h("button", { class: "btn primary", onclick: () => restart() }, "同じ局面からもう一度"),
      fromGame ? h("a", { class: "btn", href: `#/game/${fromGame.id}` }, "元の対局へ") : h("a", { class: "btn", href: "#/" }, "ホームへ"));
    const log = (await db.getKV<PlayLog[]>("playLog")) ?? [];
    log.push({ at: Date.now(), from, result: r, moves: moves.length });
    await db.putKV("playLog", log.slice(-200));
    draw();
  };

  const checkEnd = (): boolean => {
    if (hasLegalMove(pos)) return false;
    // 手番側に合法手が無い = 手番側の負け
    void end(pos.color === userColor ? "lose" : "win");
    return true;
  };

  const aiMove = async () => {
    thinking = true;
    draw();
    const res = await engine.search(`sfen ${sfen}${moves.length ? " moves " + moves.join(" ") : ""}`, { nodes: level });
    if (!alive || over) return;
    thinking = false;
    if (res.lines[0]) lastScore = negate(res.lines[0].score);
    if (res.bestmove === "resign") return end("win");
    const m = pos.createMoveByUSI(res.bestmove);
    if (!m) return end("win");
    pos.doMove(m);
    moves.push(res.bestmove);
    if (!checkEnd()) draw();
  };

  const onUser = async (m: Move) => {
    if (over || thinking || pos.color !== userColor) return;
    pos.doMove(m);
    moves.push(m.usi);
    if (checkEnd()) return;
    await aiMove();
  };

  const replay = () => {
    pos = start.clone();
    for (const u of moves) { const m = pos.createMoveByUSI(u); if (m) pos.doMove(m); }
  };
  const undo = () => {
    if (over || thinking || moves.length === 0) return;
    // 自分の手まで戻す(AIの手と自分の手の2手)
    moves = moves.slice(0, Math.max(0, moves.length - (pos.color === userColor ? 2 : 1)));
    replay();
    draw();
  };
  const restart = () => {
    if (thinking) return;
    over = false;
    moves = [];
    lastScore = null;
    pos = start.clone();
    result.replaceChildren();
    buttons.replaceChildren(
      h("button", { class: "btn", onclick: () => undo() }, "待った"),
      h("button", { class: "btn", onclick: () => restart() }, "最初から"),
      h("button", { class: "btn danger", onclick: () => end("resign") }, "投了"));
    void begin();
  };

  const begin = async () => {
    if (engine.state !== "ready") {
      status.textContent = "AIを準備中…";
      await engine.load((await db.getSettings()).threads);
    }
    draw();
    if (pos.color !== userColor) await aiMove();
  };

  draw();
  void begin().catch((e) => { status.textContent = "AIを読み込めませんでした: " + (e as Error).message; });
  return () => { alive = false; };
}

/** 勝ち切り練習の一覧カード */
export function conversionCard(games: Game[], max = 5): HTMLElement | "" {
  const list = findConversionPositions(games).slice(0, max);
  if (!list.length) return "";
  // AIと指し継いだ成績(非同期で読み込んで表示)
  const playRecord = h("div", { class: "small" });
  void db.getKV<PlayLog[]>("playLog").then((log) => {
    const l = log ?? [];
    if (!l.length) return;
    const w = l.filter((x) => x.result === "win").length;
    playRecord.textContent = `AIと指し継いだ成績: ${w}勝${l.length - w}敗`;
  });
  return h("section", { class: "card" },
    h("h2", {}, "勝ち切り練習"),
    h("p", { class: "small muted" }, "勝率85%以上あったのに逆転された局面です。AIを相手に、今度こそ勝ち切りましょう。"),
    playRecord,
    ...list.map((c) => h("a", { class: "list-btn", href: playHref(c.sfen, c.game.mySide, `${c.game.id}:${c.ply}`) },
      h("div", {}, h("b", {}, `vs ${c.game.mySide === "black" ? c.game.white : c.game.black}`), ` ${c.ply}手目の局面`),
      h("div", { class: "small muted" }, `その時の勝率 ${pct(c.wr)}`))));
}

/**
 * 勝ち切り練習の局面: 自分の勝率が85%以上あったのに、その後40%未満まで落ちた対局の、
 * 崩れる直前で自分の手番の局面。
 */
export function findConversionPositions(games: Game[]): { game: Game; ply: number; sfen: string; wr: number }[] {
  const out: { game: Game; ply: number; sfen: string; wr: number }[] = [];
  for (const g of games) {
    if (!g.analysisDone) continue;
    const myWr = (i: number): number | null => {
      const s = g.analysis[i]?.lines[0]?.score;
      if (!s) return null;
      const blackToMove = i % 2 === 0; // 平手は先手から
      const mine = (g.mySide === "black") === blackToMove;
      return mine ? winRate(s) : 1 - winRate(s);
    };
    let best: { i: number; wr: number } | null = null;
    for (let i = 0; i < g.analysis.length; i++) {
      const wr = myWr(i);
      if (wr == null) continue;
      const myTurn = (g.mySide === "black") === (i % 2 === 0);
      if (myTurn && wr >= 0.85) best = { i, wr };
      if (best && wr < 0.4) {
        const r = recordOf(g);
        r.goto(best.i);
        out.push({ game: g, ply: best.i, sfen: r.position.sfen, wr: best.wr });
        break;
      }
    }
  }
  return out;
}
