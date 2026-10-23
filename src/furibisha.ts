// 振り飛車党向けの絞り込み。序盤はAIが居飛車(飛車先の歩を突く手)を勧めがちなので、
// 飛車を振る前の局面では「振り飛車の範囲での最善手」を基準にする。
import { Color, ImmutablePosition, PieceType, Square } from "tsshogi";
import { legalUsiMoves } from "./kifu";

/** 手番側から見た筋・段(先手視点に揃える) */
function norm(c: Color, sq: Square): [number, number] {
  return c === Color.BLACK ? [sq.file, sq.rank] : [10 - sq.file, 10 - sq.rank];
}

/** 手番側の飛車が初期位置(2八)にあるか = まだ飛車を振っていない */
export function rookUnswung(pos: ImmutablePosition): boolean {
  for (const sq of Square.all) {
    const p = pos.board.at(sq);
    if (!p || p.color !== pos.color || p.type !== PieceType.ROOK) continue;
    const [f, r] = norm(pos.color, sq);
    if (f === 2 && r === 8) return true;
  }
  return false;
}

function parse(pos: ImmutablePosition, usi: string) {
  if (!usi || usi[1] === "*") return null;
  const from = Square.newByUSI(usi.slice(0, 2));
  const to = Square.newByUSI(usi.slice(2, 4));
  const piece = from ? pos.board.at(from) : null;
  if (!from || !to || !piece || piece.color !== pos.color) return null;
  return { type: piece.type, from: norm(pos.color, from), to: norm(pos.color, to) };
}

/** 2八の飛車を横に動かす手(飛車を振る手) */
export function isRookSwing(pos: ImmutablePosition, usi: string): boolean {
  const m = parse(pos, usi);
  return !!m && m.type === PieceType.ROOK && m.from[0] === 2 && m.from[1] === 8 && m.to[1] === 8 && m.to[0] !== 2;
}

/** 居飛車の手: 飛車先(2筋)の歩を突く・2八の飛車を縦に動かす */
export function isIbishaMove(pos: ImmutablePosition, usi: string): boolean {
  const m = parse(pos, usi);
  if (!m) return false;
  if (m.type === PieceType.PAWN && m.from[0] === 2) return true;
  return m.type === PieceType.ROOK && m.from[0] === 2 && m.from[1] === 8 && m.to[0] === 2;
}

/**
 * 実戦の手を評価するときの候補手(AIにこの中から最善を選ばせる)。絞り込みが要らなければ null。
 * - 飛車を振った手 → 振る手の中での最善と比べる(どこに振るのが良かったか)
 * - 振る前の手で、AIが居飛車の手を勧めている → 居飛車の手を除いた最善と比べる
 */
export function furibishaCandidates(pos: ImmutablePosition, played: string, aiBest: string | undefined): string[] | null {
  if (!rookUnswung(pos)) return null;
  let keep: ((u: string) => boolean) | null = null;
  if (isRookSwing(pos, played)) keep = (u) => isRookSwing(pos, u);
  else if (!isIbishaMove(pos, played) && aiBest && isIbishaMove(pos, aiBest)) keep = (u) => !isIbishaMove(pos, u);
  // AIの最善手がすでに候補に入っていれば、絞り込んでも結果は同じ
  if (!keep || (aiBest && keep(aiBest))) return null;
  const moves = legalUsiMoves(pos).filter(keep);
  return moves.length ? moves : null;
}
