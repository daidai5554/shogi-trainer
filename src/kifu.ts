// クリップボードの棋譜(ウォーズ/クエスト/一般のKIF・KI2・CSA)を Game に変換する。
import {
  Color,
  ImmutablePosition,
  Move,
  PieceType,
  Record,
  RecordFormatType,
  RecordMetadataKey,
  SpecialMoveType,
  Square,
  detectRecordFormat,
  handPieceTypes,
  importCSA,
  importKI2,
  importKIF,
  Position,
} from "tsshogi";
import type { Game, Result, Side, Source } from "./types";

export interface ParsedGame {
  game: Game;
  mySideKnown: boolean;
}

export function parseRecord(text: string): Record {
  const data = text.replace(/\r\n?/g, "\n").trim();
  const fmt = detectRecordFormat(data);
  let r: Record | Error;
  if (fmt === RecordFormatType.CSA) r = importCSA(data);
  else if (fmt === RecordFormatType.KI2) r = importKI2(data);
  else r = importKIF(data);
  if (r instanceof Error) {
    // 判定に失敗したときは順に試す
    for (const f of [importKIF, importKI2, importCSA]) {
      const r2 = f(data);
      if (!(r2 instanceof Error) && r2.moves.length > 1) return r2;
    }
    throw new Error("棋譜を読み込めませんでした: " + r.message);
  }
  if (r.moves.length <= 1) throw new Error("指し手が見つかりませんでした");
  return r;
}

function hash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** "korenaga220(1592)" → ["korenaga220", "1592"] */
function splitName(raw: string | undefined): [string, string] {
  const s = (raw ?? "").trim();
  const m = s.match(/^(.*?)\s*[(（]\s*([0-9]+)\s*[)）]\s*$/);
  return m ? [m[1], m[2]] : [s, ""];
}

function parseTimeLimit(s: string): number | null {
  // 例: 10分切れ負け / 3分切れ負け / 1手10秒
  const m = s.match(/(\d+)\s*分\s*切れ負け/);
  if (m) return Number(m[1]) * 60_000;
  return null;
}

function parseDate(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
}

/** 合法手が1つでもあるか(詰み判定用)。 */
export function hasLegalMove(pos: ImmutablePosition): boolean {
  const p = pos as Position;
  const color = p.color;
  for (const from of Square.all) {
    const piece = p.board.at(from);
    if (!piece || piece.color !== color) continue;
    for (const to of Square.all) {
      const m = p.createMove(from, to);
      if (!m) continue;
      if (p.isValidMove(m)) return true;
      if (p.isValidMove(m.withPromote())) return true;
    }
  }
  const hand = p.hand(color);
  for (const t of handPieceTypes) {
    if (hand.count(t) === 0) continue;
    for (const to of Square.all) {
      if (p.board.at(to)) continue;
      const m = p.createMove(t as PieceType, to);
      if (m && p.isValidMove(m)) return true;
    }
  }
  return false;
}

function sideOf(c: Color): Side {
  return c === Color.BLACK ? "black" : "white";
}

export function opposite(s: Side): Side {
  return s === "black" ? "white" : "black";
}

/** 終局情報から勝敗(先手から見た勝者)を決める。 */
function decideWinner(record: Record): { winner: Side | "draw" | null; reason: string } {
  const moves = record.moves;
  const last = moves[moves.length - 1];
  record.goto(record.length);
  const toMove = sideOf(record.position.color);
  if (!(last.move instanceof Move)) {
    const t = (last.move as { type: string }).type;
    switch (t) {
      case SpecialMoveType.RESIGN:
        return { winner: opposite(toMove), reason: "投了" };
      case SpecialMoveType.TIMEOUT:
        return { winner: opposite(toMove), reason: "時間切れ" };
      case SpecialMoveType.MATE:
        return { winner: opposite(toMove), reason: "詰み" };
      case SpecialMoveType.FOUL_LOSE:
        return { winner: opposite(toMove), reason: "反則" };
      case SpecialMoveType.FOUL_WIN:
        return { winner: toMove, reason: "反則" };
      case SpecialMoveType.ENTERING_OF_KING:
        return { winner: toMove, reason: "入玉宣言" };
      case SpecialMoveType.REPETITION_DRAW:
        return { winner: "draw", reason: "千日手" };
      case SpecialMoveType.DRAW:
      case SpecialMoveType.IMPASS:
      case SpecialMoveType.MAX_MOVES:
        return { winner: "draw", reason: "引き分け" };
    }
  }
  // クエストなど終局行が無い場合: 最終局面が詰みなら手番側の負け
  if (record.position.checked && !hasLegalMove(record.position)) {
    return { winner: opposite(toMove), reason: "詰み" };
  }
  return { winner: null, reason: "" };
}

export function toResult(winner: Side | "draw" | null, my: Side): Result {
  if (winner === null) return "unknown";
  if (winner === "draw") return "draw";
  return winner === my ? "win" : "lose";
}

export function importGame(text: string, usernames: string[]): ParsedGame {
  const record = parseRecord(text);
  const md = record.metadata;
  const place = md.getStandardMetadata(RecordMetadataKey.PLACE) ?? "";
  const tournament = md.getStandardMetadata(RecordMetadataKey.TOURNAMENT) ?? "";
  let source: Source = "other";
  if (/ウォーズ|wars/i.test(place + tournament)) source = "wars";
  else if (/quest|クエスト/i.test(place + tournament)) source = "quest";

  const [black, bRate0] = splitName(md.getStandardMetadata(RecordMetadataKey.BLACK_NAME));
  const [white, wRate0] = splitName(md.getStandardMetadata(RecordMetadataKey.WHITE_NAME));
  const blackRating = md.getCustomMetadata("先手段級") ?? bRate0;
  const whiteRating = md.getCustomMetadata("後手段級") ?? wRate0;

  const lower = usernames.map((u) => u.trim().toLowerCase()).filter(Boolean);
  let mySide: Side = "black";
  let mySideKnown = false;
  if (lower.includes(white.toLowerCase())) { mySide = "white"; mySideKnown = true; }
  else if (lower.includes(black.toLowerCase())) { mySide = "black"; mySideKnown = true; }

  const usiMoves: string[] = [];
  for (const n of record.moves) if (n.move instanceof Move) usiMoves.push(n.move.usi);

  let timeControl = md.getStandardMetadata(RecordMetadataKey.TIME_LIMIT) ?? "";
  let timeLimitMs = parseTimeLimit(timeControl);
  if (source === "quest" && timeLimitMs == null) {
    // クエストの棋譜には持ち時間が無いので、消費時間から 2分/5分/10分 を推定する
    const used = Math.max(0, ...record.moves.map((n) => n.totalElapsedMs || 0));
    const guess = [120_000, 300_000, 600_000].find((t) => used <= t);
    if (guess) { timeLimitMs = guess; timeControl = `${guess / 60_000}分切れ負け（推定）`; }
  }
  const startedAt = parseDate(md.getStandardMetadata(RecordMetadataKey.START_DATETIME));
  const { winner, reason } = decideWinner(record);
  const now = Date.now();

  const game: Game = {
    id: hash([black, white, record.initialPosition.sfen, usiMoves.join(" ")].join("|")),
    kif: text,
    source,
    importedAt: now,
    playedAt: startedAt ?? now,
    black,
    white,
    blackRating,
    whiteRating,
    timeControl,
    timeLimitMs,
    mySide,
    result: toResult(winner, mySide),
    resultReason: reason,
    resultAuto: winner !== null,
    moveCount: usiMoves.length,
    usiMoves,
    strategy: null,
    analysis: new Array(usiMoves.length).fill(null),
    analysisNodes: 0,
    analysisDone: false,
    verdicts: null,
  };
  return { game, mySideKnown };
}

/** 保存済みの Game から Record を復元する。 */
export function recordOf(game: Game): Record {
  return parseRecord(game.kif);
}

/** 先後の勝者(手動設定用) */
export function winnerOf(game: Game): Side | "draw" | null {
  if (game.result === "unknown") return null;
  if (game.result === "draw") return "draw";
  return game.result === "win" ? game.mySide : opposite(game.mySide);
}
