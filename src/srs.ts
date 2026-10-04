// 間隔反復(SM-2を簡略化)。正解するたびに出題間隔を伸ばし、間違えたら翌日に戻す。
import type { Problem } from "./types";

const DAY = 24 * 60 * 60 * 1000;

export function grade(p: Problem, ok: boolean, now = Date.now()): Problem {
  const q = { ...p, history: [...p.history, { at: now, ok }] };
  if (ok) {
    q.reps += 1;
    q.intervalDays = q.reps === 1 ? 1 : q.reps === 2 ? 3 : Math.round(q.intervalDays * q.ease);
    q.ease = Math.min(3.0, q.ease + 0.1);
    q.lastResult = "correct";
  } else {
    q.lapses += 1;
    q.reps = 0;
    q.intervalDays = 0;
    q.ease = Math.max(1.3, q.ease - 0.2);
    q.lastResult = "wrong";
  }
  // 間違えた問題は同じセッションの最後にもう一度出すため10分後
  q.due = ok ? startOfDay(now) + q.intervalDays * DAY : now + 10 * 60 * 1000;
  return q;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(4, 0, 0, 0); // 朝4時を日付の区切りにする
  return d.getTime() > t ? d.getTime() - DAY : d.getTime();
}

export function isDue(p: Problem, now = Date.now()): boolean {
  return p.due <= now;
}

/** 習得済み: 3回以上連続正解で間隔が2週間以上 */
export function isMastered(p: Problem): boolean {
  return p.reps >= 3 && p.intervalDays >= 14;
}
