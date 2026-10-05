// 「今日のトレーニング」: 定跡・悪手の復習・咎め・詰将棋をバランスよく少しずつ。
// 1セット約5分(8問)。対局前のウォーミングアップにもそのまま使う。
import { problemKind } from "./analysis";
import type { Phase, Problem, ProblemKind, Side } from "./types";

export const SET_SIZE = 8;

/** セットの1項目: 保存済みの問題 か 定跡の手順ドリル */
export type SessionItem = { type: "problem"; p: Problem } | { type: "line"; side: Side; startPath?: string[] };

/** 1セットの内訳(目安)。足りない種類は他で埋める。いまの弱点(focus)で少し配分を変える */
function planFor(focus: Phase | null): { kind: ProblemKind; n: number }[] {
  const n = { book: 1, mistake: 3, punish: 1, tsume: 2 };
  if (focus === "end") { n.mistake = 2; n.tsume = 3; }
  if (focus === "opening") { n.book = 2; n.mistake = 2; }
  return (["book", "mistake", "punish", "tsume"] as ProblemKind[]).map((kind) => ({ kind, n: n[kind] }));
}
/** 1日に新しく出す問題の上限(復習が溜まりすぎないように) */
const NEW_PER_DAY: { [k in ProblemKind]: number } = { book: 4, mistake: 6, punish: 3, tsume: 6 };
const ORDER: ProblemKind[] = ["book", "mistake", "punish", "tsume"];
const FILL: ProblemKind[] = ["mistake", "tsume", "punish", "book"];

const isNew = (p: Problem) => p.history.length === 0;

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(4, 0, 0, 0);
  return d.getTime() > now ? d.getTime() - 86_400_000 : d.getTime();
}

/** 期日の来ている問題から1セット分の問題を選ぶ。extra=true なら期日前の問題も使う(おかわり) */
export function buildDailySet(all: Problem[], now = Date.now(), extra = false, size = SET_SIZE, focus: Phase | null = null): Problem[] {
  const today = startOfToday(now);
  const introducedToday = (k: ProblemKind) =>
    all.filter((p) => problemKind(p) === k && p.history.length > 0 && p.history[0].at >= today).length;

  const pool = (k: ProblemKind): Problem[] => {
    const ofKind = all.filter((p) => problemKind(p) === k);
    const due = ofKind.filter((p) => p.due <= now);
    // 弱点の局面(focus)の問題を優先
    const pri = (p: Problem) => (focus && p.phase === focus ? 0 : 1);
    const reviews = due.filter((p) => !isNew(p)).sort((a, b) => pri(a) - pri(b) || a.due - b.due);
    const newLeft = Math.max(0, NEW_PER_DAY[k] - introducedToday(k));
    // 新しい問題は損の大きいもの(=大事なもの)から
    const fresh = due.filter(isNew).sort((a, b) => pri(a) - pri(b) || b.lossWin - a.lossWin || a.createdAt - b.createdAt).slice(0, newLeft);
    let list = [...reviews, ...fresh];
    if (extra && list.length === 0) {
      // おかわり: 期日前の問題を、苦手な順に
      list = ofKind.filter((p) => p.due > now).sort((a, b) => a.ease - b.ease || b.lapses - a.lapses);
    }
    return list;
  };

  const pools = new Map(ORDER.map((k) => [k, pool(k)]));
  const picked: Problem[] = [];
  const scale = size === Infinity ? Infinity : size / SET_SIZE;
  for (const { kind, n } of planFor(focus)) picked.push(...pools.get(kind)!.splice(0, Math.round(n * scale)));
  for (const kind of FILL) {
    while (picked.length < size && pools.get(kind)!.length) picked.push(pools.get(kind)!.shift()!);
  }
  return picked.sort((a, b) => ORDER.indexOf(problemKind(a)) - ORDER.indexOf(problemKind(b)));
}

/**
 * 今日のトレーニングの1セット: 定跡の手順ドリル(1回) + 問題。
 * 手順ドリルは1日1回まで(lineDoneToday)。
 */
export function buildSessionItems(all: Problem[], drillSide: Side | null, lineDoneToday: boolean, now = Date.now(), extra = false, focus: Phase | null = null): SessionItem[] {
  const withLine = !!drillSide && !lineDoneToday && !extra;
  const probs = buildDailySet(all, now, extra, withLine ? SET_SIZE - 1 : SET_SIZE, focus);
  const items: SessionItem[] = probs.map((p) => ({ type: "problem", p }));
  if (withLine) items.unshift({ type: "line", side: drillSide! });
  return items;
}

export interface DailySummary {
  book: number;
  line: number;
  mistake: number;
  punish: number;
  tsume: number;
  total: number;
  remainingAfter: number; // このセットの後に残る期日の問題
}

export function summarize(all: Problem[], drillSide: Side | null = null, lineDoneToday = true, now = Date.now(), focus: Phase | null = null): DailySummary {
  const items = buildSessionItems(all, drillSide, lineDoneToday, now, false, focus);
  const count = (k: ProblemKind) => items.filter((i) => i.type === "problem" && problemKind(i.p) === k).length;
  const eligible = buildDailySet(all, now, false, Infinity).length;
  const nProb = items.filter((i) => i.type === "problem").length;
  return {
    book: count("book"), line: items.length - nProb, mistake: count("mistake"), punish: count("punish"), tsume: count("tsume"),
    total: items.length, remainingAfter: Math.max(0, eligible - nProb),
  };
}
