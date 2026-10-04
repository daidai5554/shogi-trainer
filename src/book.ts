// 定跡ツリー: 自分の対局を局面ごとにまとめる(手順が違っても同じ局面なら合流)。
import { Color } from "tsshogi";
import { recordOf } from "./kifu";
import { BOOK_MAX_PLY } from "./analysis";
import type { Game, Score, Side } from "./types";

export interface BookEdge {
  usi: string;
  mine: boolean; // 自分の指し手か
  count: number;
  wins: number;
  losses: number;
  lossSum: number; // 自分の手のときの勝率低下の合計(AI評価)
  lossN: number;
  childKey: string;
  gameIds: string[];
}

export interface BookNode {
  key: string;
  sfen: string;
  path: string[]; // 初期局面からの手順(最初に見つかったもの)
  ply: number;
  count: number;
  wins: number;
  losses: number;
  myTurn: boolean;
  edges: Map<string, BookEdge>;
  aiBest: string | null;
  aiScore: Score | null; // 手番側から見た評価
}

export interface Deviation {
  nodeKey: string;
  usi: string; // 自分が指した手
  aiBest: string | null;
  count: number;
  avgLoss: number;
  lost: number; // そのうち負けた対局数
}

export interface WeakBranch {
  nodeKey: string;
  usi: string;
  mine: boolean;
  count: number;
  wins: number;
  losses: number;
}

export interface BookTree {
  rootKey: string | null;
  nodes: Map<string, BookNode>;
  games: number;
  deviations: Deviation[];
  weakBranches: WeakBranch[];
}

/** 手数を除いたSFEN(同一局面の判定用) */
export function positionKey(sfen: string): string {
  return sfen.split(" ").slice(0, 3).join(" ");
}

export function buildBook(games: Game[], side: Side, maxPly = BOOK_MAX_PLY): BookTree {
  const nodes = new Map<string, BookNode>();
  const devs = new Map<string, Deviation>();
  let rootKey: string | null = null;
  let count = 0;

  for (const g of games) {
    if (g.mySide !== side) continue;
    let record;
    try { record = recordOf(g); } catch { continue; }
    count++;
    const win = g.result === "win" ? 1 : 0;
    const loss = g.result === "lose" ? 1 : 0;
    const limit = Math.min(maxPly, g.usiMoves.length);
    const path: string[] = [];
    let deviated = false;
    for (let ply = 0; ply <= limit; ply++) {
      record.goto(ply);
      const sfen = record.position.sfen;
      const key = positionKey(sfen);
      if (ply === 0) rootKey ??= key;
      let node = nodes.get(key);
      const myTurn = (ply % 2 === 0) === (record.initialPosition.color === Color.BLACK ? side === "black" : side === "white");
      if (!node) {
        node = { key, sfen, path: [...path], ply, count: 0, wins: 0, losses: 0, myTurn, edges: new Map(), aiBest: null, aiScore: null };
        nodes.set(key, node);
      }
      node.count++;
      node.wins += win;
      node.losses += loss;
      const a = g.analysis[ply]?.lines[0];
      if (!node.aiBest && a?.pv[0]) { node.aiBest = a.pv[0]; node.aiScore = a.score; }
      if (ply === limit) break;

      const usi = g.usiMoves[ply];
      record.goto(ply + 1);
      const childKey = positionKey(record.position.sfen);
      let e = node.edges.get(usi);
      if (!e) {
        e = { usi, mine: myTurn, count: 0, wins: 0, losses: 0, lossSum: 0, lossN: 0, childKey, gameIds: [] };
        node.edges.set(usi, e);
      }
      e.count++;
      e.wins += win;
      e.losses += loss;
      e.gameIds.push(g.id);
      const v = g.verdicts?.find((x) => x.ply === ply + 1);
      if (myTurn && v) {
        e.lossSum += v.lossWin;
        e.lossN++;
        // その対局で最初に定跡(AI推奨)から外れた手
        if (!deviated && v.lossWin >= 0.03) {
          deviated = true;
          const dk = key + "|" + usi;
          const d = devs.get(dk) ?? { nodeKey: key, usi, aiBest: node.aiBest, count: 0, avgLoss: 0, lost: 0 };
          d.avgLoss = (d.avgLoss * d.count + v.lossWin) / (d.count + 1);
          d.count++;
          d.lost += loss;
          devs.set(dk, d);
        }
      }
      path.push(usi);
    }
  }

  // 負けが多い分岐: 2局以上あって負け越している手(序盤の数手は除く)
  const weak: WeakBranch[] = [];
  for (const n of nodes.values()) {
    if (n.ply < 4) continue;
    for (const e of n.edges.values()) {
      if (e.count >= 2 && e.losses > e.wins) weak.push({ nodeKey: n.key, usi: e.usi, mine: e.mine, count: e.count, wins: e.wins, losses: e.losses });
    }
  }
  weak.sort((a, b) => (a.wins / (a.wins + a.losses || 1)) - (b.wins / (b.wins + b.losses || 1)) || b.count - a.count);

  // 同じ負け筋が親子で重複しないよう、浅い局面を優先して上位だけ使う
  const deviations = [...devs.values()].sort((a, b) => b.count - a.count || b.avgLoss - a.avgLoss);
  return { rootKey, nodes, games: count, deviations, weakBranches: weak };
}

/** 自分の手の評価記号: ✓ AIと同等 / △ 少し損 / ✕ 損 */
export function edgeMark(e: BookEdge): { mark: string; cls: string } | null {
  if (!e.mine || e.lossN === 0) return null;
  const avg = e.lossSum / e.lossN;
  if (avg < 0.02) return { mark: "✓", cls: "good" };
  if (avg < 0.05) return { mark: "△", cls: "warn" };
  return { mark: "✕", cls: "bad" };
}
