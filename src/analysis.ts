// 対局の解析: 全局面の評価 → 各指し手の判定 → 自分の悪手から問題を作成。
// 探索関数を引数で受け取るので、ブラウザでもNode(テスト)でも動く。
import { Color, Move, PieceType, Record, Square } from "tsshogi";
import { recordOf } from "./kifu";
import { negate, winRate } from "./score";
import { detectStrategy } from "./strategy";
import type { Game, MoveVerdict, Phase, PlyAnalysis, Problem, ProblemKind, ProblemTag, Side } from "./types";
import type { SearchResult } from "./engine";

export type SearchFn = (position: string, opts: { nodes: number; multipv?: number }) => Promise<SearchResult>;

const STANDARD_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

/** ply手目を指す前の局面(USI position 引数) */
export function positionArg(game: Game, record: Record, plyBefore: number): string {
  const init = record.initialPosition.sfen;
  const base = init === STANDARD_SFEN ? "startpos" : `sfen ${init}`;
  const moves = game.usiMoves.slice(0, plyBefore - 1);
  return moves.length ? `${base} moves ${moves.join(" ")}` : base;
}

export interface AnalyzeHooks {
  onProgress?: (done: number, total: number) => void;
  save?: (g: Game) => Promise<void>;
  cancelled?: () => boolean;
}

/** 未解析の局面をすべて評価する。analysis[i] は (i+1)手目を指す前の局面。最後の要素は終局図。 */
export async function analyzeGame(game: Game, search: SearchFn, nodes: number, hooks: AnalyzeHooks = {}): Promise<Game> {
  const record = recordOf(game);
  const total = game.usiMoves.length + 1;
  if (game.analysis.length !== total) {
    game.analysis = Array.from({ length: total }, (_, i) => game.analysis[i] ?? null);
  }
  let lastSave = Date.now();
  for (let i = 0; i < total; i++) {
    if (hooks.cancelled?.()) return game;
    const a = game.analysis[i];
    if (!a || a.nodes < nodes) {
      const res = await search(positionArg(game, record, i + 1), { nodes });
      game.analysis[i] = { ply: i + 1, lines: res.lines, nodes } satisfies PlyAnalysis;
    }
    hooks.onProgress?.(i + 1, total);
    if (hooks.save && Date.now() - lastSave > 3000) {
      lastSave = Date.now();
      await hooks.save(game);
    }
  }
  game.analysisNodes = nodes;
  game.verdicts = judgeMoves(game, record);
  game.strategy = detectStrategy(record, game.mySide);
  game.analysisDone = true;
  return game;
}

function phaseOf(record: Record, ply: number, inMateRange: boolean): Phase {
  record.goto(ply - 1);
  const pos = record.position;
  let handNonPawn = 0;
  for (const h of [pos.blackHand, pos.whiteHand]) {
    for (const { type, count } of h.counts) if (type !== PieceType.PAWN) handNonPawn += count;
  }
  // 玉の近く(2マス以内)にいる敵の駒
  let pressure = 0;
  for (const kc of [Color.BLACK, Color.WHITE]) {
    const k = pos.board.findKing(kc);
    if (!k) continue;
    let n = 0;
    for (const sq of pos.board.listNonEmptySquares()) {
      const p = pos.board.at(sq)!;
      if (p.color === kc || p.type === PieceType.PAWN) continue;
      if (Math.abs(sq.file - k.file) <= 2 && Math.abs(sq.rank - k.rank) <= 2) n++;
    }
    pressure = Math.max(pressure, n);
  }
  if (inMateRange || pos.checked || pressure >= 3 || handNonPawn >= 5) return "end";
  // 序盤: 角交換以外の駒の取り合いが無く、歩の交換も少ない
  const bishops = pos.blackHand.count(PieceType.BISHOP) + pos.whiteHand.count(PieceType.BISHOP);
  const pawns = pos.blackHand.count(PieceType.PAWN) + pos.whiteHand.count(PieceType.PAWN);
  if (ply <= 20 || (ply <= 40 && handNonPawn === bishops && pawns <= 2)) return "opening";
  return "middle";
}

export function judgeMoves(game: Game, record: Record = recordOf(game)): MoveVerdict[] {
  const out: MoveVerdict[] = [];
  const nodes = record.moves; // nodes[ply] = ply手目
  for (let ply = 1; ply <= game.usiMoves.length; ply++) {
    const before = game.analysis[ply - 1];
    const after = game.analysis[ply];
    if (!before || !after || !before.lines[0] || !after.lines[0]) continue;
    const side: Side = ply % 2 === 1 ? sideToMoveAtStart(record) : opp(sideToMoveAtStart(record));
    const usi = game.usiMoves[ply - 1];
    const sBefore = before.lines[0].score;
    const sAfter = negate(after.lines[0].score);
    const wrB = winRate(sBefore);
    const wrA = winRate(sAfter);
    const isBest = before.lines[0].pv[0] === usi;
    let loss = isBest ? 0 : Math.max(0, wrB - wrA);

    const missedMate = !isBest && sBefore.kind === "mate" && sBefore.win && sBefore.v <= 11 && !(sAfter.kind === "mate" && sAfter.win);
    const allowedMate = sAfter.kind === "mate" && !sAfter.win && !(sBefore.kind === "mate" && !sBefore.win);

    let kind: MoveVerdict["kind"] = null;
    const hopeless = wrB < 0.03;
    const stillWinning = wrA > 0.93;
    if (!hopeless && !stillWinning) {
      if (loss >= 0.2) kind = "blunder";
      else if (loss >= 0.1) kind = "mistake";
      else if (loss >= 0.05) kind = "dubious";
    }
    if (allowedMate && !hopeless) kind = "blunder";

    const node = nodes[ply];
    const limit = game.timeLimitMs;
    const remainingMs = limit != null && node ? limit - (node.totalElapsedMs - node.elapsedMs) : null;
    const inMate = sBefore.kind === "mate" || sAfter.kind === "mate";
    out.push({
      ply, side, usi, lossWin: loss, kind, missedMate, allowedMate,
      phase: phaseOf(record, ply, inMate),
      elapsedMs: node?.elapsedMs ?? 0,
      remainingMs,
    });
  }
  return out;
}

function sideToMoveAtStart(record: Record): Side {
  return record.initialPosition.color === Color.BLACK ? "black" : "white";
}
function opp(s: Side): Side {
  return s === "black" ? "white" : "black";
}

/**
 * 自分の悪手から問題を作る。MultiPV で深く読み直して、
 * ほぼ同じくらい良い手も正解として認める。
 */
export async function buildProblems(game: Game, search: SearchFn, nodes: number, existing: Map<string, Problem>, onProgress?: (d: number, t: number) => void): Promise<Problem[]> {
  if (!game.verdicts) return [];
  const record = recordOf(game);
  // 中盤以降は悪手・疑問手。序盤は小さな損(勝率3%以上)も「定跡確認」の問題にする
  const targets = game.verdicts.filter((v) =>
    v.side === game.mySide && (v.kind === "blunder" || v.kind === "mistake" || v.missedMate || v.allowedMate ||
      (v.phase === "opening" && v.ply <= BOOK_MAX_PLY && v.lossWin >= 0.03)));
  const out: Problem[] = [];
  let done = 0;
  for (const v of targets) {
    const id = `${game.id}:${v.ply}`;
    const prev = existing.get(id);
    if (prev) { out.push(prev); onProgress?.(++done, targets.length); continue; }

    const res = await search(positionArg(game, record, v.ply), { nodes: Math.max(nodes * 2, 600_000), multipv: 3 });
    onProgress?.(++done, targets.length);
    const best = res.lines[0];
    if (!best || best.pv.length === 0) continue;
    const bestWr = winRate(best.score);
    const answers = res.lines
      .filter((l) => l.pv.length > 0 && (best.score.kind === "mate" && best.score.win
        ? l.score.kind === "mate" && l.score.win
        : bestWr - winRate(l.score) <= 0.04))
      .map((l) => l.pv[0]);
    // 深く読むと実戦の手も十分だった場合は問題にしない
    if (answers.includes(v.usi)) continue;

    // 読み筋が途中で切れていたら続きを読ませる(詰みは最後まで、それ以外は8手程度)
    const target = best.score.kind === "mate" && best.score.win ? best.score.v : 8;
    best.pv = await extendPv(search, positionArg(game, record, v.ply), best.pv, Math.min(target, 15));

    const tags: ProblemTag[] = [];
    if (v.kind === "blunder") tags.push("blunder");
    else if (v.kind === "mistake") tags.push("mistake");
    if (v.missedMate) tags.push("missedMate");
    if (v.allowedMate) tags.push("allowedMate");

    record.goto(v.ply - 1);
    const after = game.analysis[v.ply];
    const now = Date.now();
    out.push({
      id, gameId: game.id, ply: v.ply,
      kind: v.phase === "opening" ? "book" : "mistake",
      sfen: record.position.sfen,
      side: v.side,
      playedUsi: v.usi,
      answers: [...new Set(answers)],
      bestPv: best.pv.slice(0, 15),
      bestScore: best.score,
      playedScore: after?.lines[0] ? negate(after.lines[0].score) : null,
      lossWin: v.lossWin,
      phase: v.phase,
      tags,
      opening: game.strategy?.label ?? "",
      createdAt: now,
      due: now, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, lastResult: null, history: [],
    });
  }
  return out;
}

export const BOOK_MAX_PLY = 40;
export const PROBLEMS_VERSION = 3;

/** 問題の種類(古いデータは種類が無いので局面から判定) */
export function problemKind(p: Problem): ProblemKind {
  return p.kind ?? (p.phase === "opening" ? "book" : "mistake");
}

/**
 * 実戦詰将棋: 対局中(自分・相手どちらでも)に 3〜7手詰めがあった局面を集める。
 * 詰み手順の途中ではなく、詰みが始まった局面だけを使う。
 */
export async function buildTsume(game: Game, search: SearchFn, existing: Map<string, Problem>, maxPerGame = 3): Promise<Problem[]> {
  const record = recordOf(game);
  const candidates: { i: number; v: number }[] = [];
  for (let i = 0; i < game.analysis.length; i++) {
    const s = game.analysis[i]?.lines[0]?.score;
    if (!s || s.kind !== "mate" || !s.win || s.v < 3 || s.v > 7) continue;
    // 2手前(同じ側の手番)も7手以内の詰みなら、詰み手順の途中なので除く
    // (長い詰みが7手以内になった最初の局面は使う)
    const prev = game.analysis[i - 2]?.lines[0]?.score;
    if (prev && prev.kind === "mate" && prev.win && prev.v <= 7) continue;
    // 自分の詰み逃しは「悪手」の問題として既にあるので除く
    if (game.verdicts?.some((v) => v.ply === i + 1 && v.missedMate && v.side === game.mySide)) continue;
    candidates.push({ i, v: s.v });
  }
  // 長い詰みを優先(5手・7手のほうが練習になる)
  candidates.sort((a, b) => b.v - a.v);
  const out: Problem[] = [];
  for (const c of candidates) {
    if (out.length >= maxPerGame) break;
    const id = `${game.id}:t${c.i + 1}`;
    const prev = existing.get(id);
    if (prev) { out.push(prev); continue; }
    const pos = positionArg(game, record, c.i + 1);
    // 深く読み直して詰み手数を確定する
    const res = await search(pos, { nodes: 800_000 });
    const best = res.lines[0];
    if (!best || best.score.kind !== "mate" || !best.score.win || best.score.v < 3 || best.score.v > 7) continue;
    const pv = await extendPv(search, pos, best.pv, best.score.v);
    record.goto(c.i);
    const side: Side = record.position.color === Color.BLACK ? "black" : "white";
    const now = Date.now();
    out.push({
      id, kind: "tsume", mateLen: best.score.v, gameId: game.id, ply: c.i + 1,
      sfen: record.position.sfen, side,
      playedUsi: game.usiMoves[c.i] ?? "",
      answers: [best.pv[0]], bestPv: pv.slice(0, best.score.v), bestScore: best.score,
      playedScore: null, lossWin: 0, phase: "end", tags: [],
      opening: game.strategy?.label ?? "", createdAt: now,
      due: now, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, lastResult: null, history: [],
    });
  }
  return out;
}

/** 読み筋が target 手より短いとき、末尾の局面を読み直して延ばす */
export async function extendPv(search: SearchFn, position: string, pv: string[], target: number): Promise<string[]> {
  const out = [...pv];
  for (let i = 0; i < 4 && out.length < target && out.length > 0; i++) {
    const base = position.includes(" moves ") ? position : position + " moves";
    const res = await search(`${base} ${out.join(" ")}`, { nodes: 200_000 });
    const more = res.lines[0]?.pv ?? [];
    if (!more.length) break; // 詰み・終局
    out.push(...more);
  }
  return out.slice(0, Math.max(target, pv.length));
}

/** USI の指し手を日本語表記(▲７六歩 など)の配列にする */
export function usiToJapanese(sfen: string, usis: string[], max = 99): string[] {
  const r = Record.newByUSI(`sfen ${sfen} moves ${usis.slice(0, max).join(" ")}`);
  if (r instanceof Error) return usis.slice(0, max);
  return r.moves.slice(1).map((n) => n.displayText);
}

export function isMove(m: unknown): m is Move {
  return m instanceof Move;
}

export function squareOfUsi(usi: string): { from: Square | null; to: Square } | null {
  const to = Square.newByUSI(usi.slice(2, 4));
  if (!to) return null;
  const from = usi[1] === "*" ? null : Square.newByUSI(usi.slice(0, 2));
  return { from, to };
}
