// 戦型の簡易判定。飛車の位置・角交換の有無・玉の位置から判定する。
import { Color, PieceType, Record } from "tsshogi";
import type { Side, Strategy } from "./types";

function color(s: Side): Color {
  return s === "black" ? Color.BLACK : Color.WHITE;
}

/** 自分から見た筋・段に直す(先手視点に揃える) */
function norm(side: Side, file: number, rank: number): [number, number] {
  return side === "black" ? [file, rank] : [10 - file, 10 - rank];
}

function rookFile(record: Record, side: Side, maxPly: number): number {
  const c = color(side);
  const counts = new Map<number, number>();
  let moved = false;
  for (let ply = 0; ply <= Math.min(maxPly, record.length); ply++) {
    record.goto(ply);
    const sq = record.position.board.listNonEmptySquares().find((s) => {
      const p = record.position.board.at(s)!;
      return p.color === c && p.type === PieceType.ROOK;
    });
    if (!sq) continue;
    const [f, r] = norm(side, sq.file, sq.rank);
    if (f !== 2) moved = true;
    if (moved && r >= 6) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  if (!moved || counts.size === 0) return 2;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function bishopExchanged(record: Record, maxPly: number): boolean {
  for (let ply = 0; ply <= Math.min(maxPly, record.length); ply++) {
    record.goto(ply);
    const p = record.position;
    if (p.blackHand.count(PieceType.BISHOP) > 0 || p.whiteHand.count(PieceType.BISHOP) > 0) return true;
  }
  return false;
}

function castle(record: Record, side: Side, ply: number, ibisha: boolean): string {
  record.goto(Math.min(ply, record.length));
  const king = record.position.board.findKing(color(side));
  if (!king) return "不明";
  const [f, r] = norm(side, king.file, king.rank);
  const key = `${f}${r}`;
  if (["99", "19", "98", "18"].includes(key) && r >= 8) {
    return f === 9 || f === 1 ? "穴熊" : "その他";
  }
  if (["88", "87", "28", "27", "86", "26"].includes(key)) return ibisha ? "左美濃・銀冠" : "美濃囲い";
  if (["78", "68", "79", "69", "77"].includes(key)) return ibisha ? "舟囲い・急戦" : "その他";
  if (["38", "39", "48", "49"].includes(key)) return ibisha ? "その他" : "居玉に近い";
  if (["59", "58", "57"].includes(key)) return "居玉";
  return "その他";
}

const FILE_NAME: { [f: number]: string } = {
  1: "居飛車", 2: "居飛車", 3: "袖飛車", 4: "右四間飛車", 5: "中飛車", 6: "四間飛車", 7: "三間飛車", 8: "向かい飛車", 9: "向かい飛車",
};

export function detectStrategy(record: Record, mySide: Side): Strategy {
  const opp: Side = mySide === "black" ? "white" : "black";
  const myFile = rookFile(record, mySide, 40);
  const oppFile = rookFile(record, opp, 40);
  const exchanged = bishopExchanged(record, 24);
  const myFuri = myFile >= 5;
  const oppFuri = oppFile >= 5;

  let myOpening = FILE_NAME[myFile] ?? "居飛車";
  if (myFile === 6) myOpening = exchanged ? "角交換四間飛車" : "ノーマル四間飛車";
  else if (myFuri && exchanged) myOpening = "角交換" + myOpening;

  let oppOpening = oppFuri ? FILE_NAME[oppFile] : oppFile === 4 ? "右四間飛車" : "居飛車";
  const oppCastle = castle(record, opp, 50, !oppFuri);

  let label: string;
  if (myFuri && oppFuri) label = "相振り飛車";
  else if (!myFuri && !oppFuri) label = "相居飛車";
  else if (oppFuri) label = "対 " + oppOpening;
  else if (oppFile === 4) label = "対 右四間飛車";
  else label = "対 居飛車" + (oppCastle === "穴熊" ? "穴熊" : oppCastle === "左美濃・銀冠" ? "（左美濃・銀冠）" : oppCastle === "舟囲い・急戦" ? "（急戦・舟囲い）" : oppCastle === "居玉" ? "（居玉・速攻）" : "");
  if (myFile === 6 && !exchanged && !oppFuri) label += "・角交換なし";

  return { myOpening, oppOpening, oppCastle, label };
}
