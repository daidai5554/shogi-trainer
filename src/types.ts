// アプリ全体で使うデータ型。IndexedDB にそのまま保存する。

export type Side = "black" | "white";
export type Result = "win" | "lose" | "draw" | "unknown";
export type Phase = "opening" | "middle" | "end";
export type Source = "wars" | "quest" | "other";

/** エンジン評価。手番側から見た値。 */
export type Score =
  | { kind: "cp"; v: number }
  | { kind: "mate"; v: number; win: boolean }; // v: 詰みまでの手数(0=詰んでいる)

export interface PVLine {
  score: Score;
  pv: string[]; // USI
}

/** 1局面ぶんの解析結果（ply手目を指す前の局面）。 */
export interface PlyAnalysis {
  ply: number; // この局面から指される手の手数(1始まり)
  lines: PVLine[]; // MultiPV。lines[0]が最善
  nodes: number;
}

export type MistakeKind = "blunder" | "mistake" | "dubious";

export interface MoveVerdict {
  ply: number;
  side: Side;
  usi: string;
  lossWin: number; // 勝率の低下(0..1)
  kind: MistakeKind | null;
  missedMate: boolean; // 詰みがあったのに逃した
  allowedMate: boolean; // 相手に詰みを与えた(頓死)
  phase: Phase;
  elapsedMs: number;
  remainingMs: number | null;
}

export interface Strategy {
  myOpening: string; // 例: 角交換四間飛車
  oppOpening: string; // 例: 居飛車
  oppCastle: string; // 例: 穴熊
  label: string; // 表示用まとめ
}

export interface Game {
  id: string; // 指し手列から作るハッシュ
  kif: string;
  source: Source;
  importedAt: number;
  playedAt: number; // 開始日時が無ければ取り込み日時
  black: string;
  white: string;
  blackRating: string;
  whiteRating: string;
  timeControl: string;
  timeLimitMs: number | null; // 切れ負けの持ち時間
  mySide: Side;
  result: Result;
  resultReason: string;
  resultAuto: boolean; // 自動判定かどうか
  moveCount: number;
  usiMoves: string[];
  strategy: Strategy | null;
  analysis: (PlyAnalysis | null)[]; // index = ply-1
  analysisNodes: number;
  analysisDone: boolean;
  verdicts: MoveVerdict[] | null;
  problemsVersion?: number; // 問題作成ロジックの版。上がったら作り直す
}

export type ProblemTag = "blunder" | "mistake" | "missedMate" | "allowedMate";

/** mistake: 自分の悪手 / book: 序盤(定跡)の確認 / tsume: 実戦の詰み局面 / punish: 相手の悪手を咎める */
export type ProblemKind = "mistake" | "book" | "tsume" | "punish";

export interface Problem {
  id: string; // gameId:ply (詰将棋は gameId:tply)
  kind?: ProblemKind; // 古いデータには無い → problemKind() で判定
  mateLen?: number; // 詰将棋の手数
  note?: string; // 問題の補足(実戦型詰将棋で駒を移した場合など)
  gameId: string;
  ply: number;
  sfen: string; // 出題局面
  side: Side; // 自分の手番
  playedUsi: string; // 実戦で指した手
  answers: string[]; // 正解とみなす手(USI)
  bestPv: string[];
  bestScore: Score;
  playedScore: Score | null; // 実戦の手を指した後の評価(自分から見た値)
  lossWin: number;
  phase: Phase;
  tags: ProblemTag[];
  opening: string;
  createdAt: number;
  // 間隔反復
  due: number;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  lastResult: "correct" | "wrong" | null;
  history: { at: number; ok: boolean }[];
}

export interface Settings {
  usernames: string[];
  analysisNodes: number;
  threads: number;
  speedMode?: boolean; // 早指しモード(1問30秒・詰将棋60秒)
}
