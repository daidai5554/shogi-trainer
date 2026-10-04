// 「今日のトレーニング」: 定跡確認・悪手の復習・詰将棋をバランスよく少しずつ。
// 1セット約5分(8問)。対局前のウォーミングアップにもそのまま使う。
import { problemKind } from "./analysis";
import type { Problem, ProblemKind } from "./types";

export const SET_SIZE = 8;
/** 1セットの内訳(目安)。足りない種類は他で埋める */
const PLAN: { kind: ProblemKind; n: number }[] = [
  { kind: "book", n: 2 }, // 序盤: 定跡の確認
  { kind: "mistake", n: 4 }, // 中盤・終盤: 自分の悪手の復習
  { kind: "tsume", n: 2 }, // 終盤: 詰将棋
];
/** 1日に新しく出す問題の上限(復習が溜まりすぎないように) */
const NEW_PER_DAY = { book: 4, mistake: 8, tsume: 6 } as const;

const isNew = (p: Problem) => p.history.length === 0;

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(4, 0, 0, 0);
  return d.getTime() > now ? d.getTime() - 86_400_000 : d.getTime();
}

/** 期日の来ている問題から1セットを作る。extra=true なら期日前の問題も使う(おかわり) */
export function buildDailySet(all: Problem[], now = Date.now(), extra = false, size = SET_SIZE): Problem[] {
  const today = startOfToday(now);
  const introducedToday = (k: ProblemKind) =>
    all.filter((p) => problemKind(p) === k && p.history.length > 0 && p.history[0].at >= today).length;

  const pool = (k: ProblemKind): Problem[] => {
    const ofKind = all.filter((p) => problemKind(p) === k);
    const due = ofKind.filter((p) => p.due <= now);
    const reviews = due.filter((p) => !isNew(p)).sort((a, b) => a.due - b.due);
    const newLeft = Math.max(0, NEW_PER_DAY[k] - introducedToday(k));
    // 新しい問題は損の大きいもの(=大事なもの)から
    const fresh = due.filter(isNew).sort((a, b) => b.lossWin - a.lossWin || a.createdAt - b.createdAt).slice(0, newLeft);
    let list = [...reviews, ...fresh];
    if (extra && list.length === 0) {
      // おかわり: 期日前の問題を、苦手な順に
      list = ofKind.filter((p) => p.due > now).sort((a, b) => a.ease - b.ease || b.lapses - a.lapses);
    }
    return list;
  };

  const pools = new Map(PLAN.map((x) => [x.kind, pool(x.kind)]));
  const picked: Problem[] = [];
  const scale = size === Infinity ? Infinity : size / SET_SIZE;
  for (const { kind, n } of PLAN) picked.push(...pools.get(kind)!.splice(0, Math.round(n * scale)));
  // 足りない分は、残っている問題で埋める(復習→詰将棋→定跡の順)
  for (const kind of ["mistake", "tsume", "book"] as ProblemKind[]) {
    while (picked.length < size && pools.get(kind)!.length) picked.push(pools.get(kind)!.shift()!);
  }
  // 出題順: 定跡 → 復習 → 詰将棋(対局前に読みの感覚を戻して終わる)
  const order: ProblemKind[] = ["book", "mistake", "tsume"];
  return picked.sort((a, b) => order.indexOf(problemKind(a)) - order.indexOf(problemKind(b)));
}

export interface DailySummary {
  book: number;
  mistake: number;
  tsume: number;
  total: number;
  remainingAfter: number; // このセットの後に残る期日の問題
}

export function summarize(all: Problem[], now = Date.now()): DailySummary {
  const set = buildDailySet(all, now);
  const count = (k: ProblemKind) => set.filter((p) => problemKind(p) === k).length;
  const eligible = buildDailySet(all, now, false, Infinity).length;
  return { book: count("book"), mistake: count("mistake"), tsume: count("tsume"), total: set.length, remainingAfter: Math.max(0, eligible - set.length) };
}
