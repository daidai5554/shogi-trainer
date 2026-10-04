// 成績と弱点の集計。
import { isMastered } from "./srs";
import type { Game, Phase, Problem } from "./types";

export interface Record3 { games: number; wins: number; losses: number }

export interface Stats {
  total: Record3;
  bySource: { [k: string]: Record3 };
  bySide: { black: Record3; white: Record3 };
  byLabel: { label: string; rec: Record3; mistakesPerGame: number }[];
  analyzedGames: number;
  mistakesByPhase: { [p in Phase]: number }; // 1局あたり(自分の悪手+疑問手)
  myMistakes: number;
  fastMistakes: number; // 2秒以内に指した悪手・疑問手
  timeTroubleMistakes: number; // 残り60秒未満での悪手・疑問手
  timeTroubleMoves: number;
  missedMates: number;
  allowedMates: number;
  avgLossByPhase: { [p in Phase]: number };
  problems: number;
  mastered: number;
  due: number;
  accuracy: number | null; // 直近の正答率
}

function rec(): Record3 { return { games: 0, wins: 0, losses: 0 }; }
function add(r: Record3, g: Game) {
  if (g.result === "unknown") return;
  r.games++;
  if (g.result === "win") r.wins++;
  if (g.result === "lose") r.losses++;
}
export function winPct(r: Record3): number | null {
  const d = r.wins + r.losses;
  return d ? r.wins / d : null;
}

export function computeStats(games: Game[], problems: Problem[], now = Date.now()): Stats {
  const s: Stats = {
    total: rec(), bySource: {}, bySide: { black: rec(), white: rec() }, byLabel: [],
    analyzedGames: 0, mistakesByPhase: { opening: 0, middle: 0, end: 0 }, myMistakes: 0,
    fastMistakes: 0, timeTroubleMistakes: 0, timeTroubleMoves: 0, missedMates: 0, allowedMates: 0,
    avgLossByPhase: { opening: 0, middle: 0, end: 0 },
    problems: problems.length, mastered: problems.filter(isMastered).length,
    due: problems.filter((p) => p.due <= now).length, accuracy: null,
  };
  const labels = new Map<string, { rec: Record3; mistakes: number; analyzed: number }>();
  const lossSum = { opening: 0, middle: 0, end: 0 };
  const lossN = { opening: 0, middle: 0, end: 0 };

  for (const g of games) {
    add(s.total, g);
    add((s.bySource[g.source] ??= rec()), g);
    add(s.bySide[g.mySide], g);
    const label = g.strategy?.label ?? "未解析";
    const L = labels.get(label) ?? { rec: rec(), mistakes: 0, analyzed: 0 };
    add(L.rec, g);
    labels.set(label, L);
    if (!g.verdicts) continue;
    s.analyzedGames++;
    L.analyzed++;
    for (const v of g.verdicts) {
      if (v.side !== g.mySide) continue;
      lossSum[v.phase] += v.lossWin;
      lossN[v.phase]++;
      const bad = v.kind === "blunder" || v.kind === "mistake";
      if (v.remainingMs != null && v.remainingMs < 60_000) s.timeTroubleMoves++;
      if (v.missedMate) s.missedMates++;
      if (v.allowedMate) s.allowedMates++;
      if (!bad) continue;
      s.myMistakes++;
      L.mistakes++;
      s.mistakesByPhase[v.phase]++;
      if (v.elapsedMs <= 2000) s.fastMistakes++;
      if (v.remainingMs != null && v.remainingMs < 60_000) s.timeTroubleMistakes++;
    }
  }
  if (s.analyzedGames) {
    for (const p of ["opening", "middle", "end"] as Phase[]) s.mistakesByPhase[p] /= s.analyzedGames;
  }
  for (const p of ["opening", "middle", "end"] as Phase[]) s.avgLossByPhase[p] = lossN[p] ? lossSum[p] / lossN[p] : 0;
  s.byLabel = [...labels.entries()]
    .map(([label, v]) => ({ label, rec: v.rec, mistakesPerGame: v.analyzed ? v.mistakes / v.analyzed : 0 }))
    .sort((a, b) => b.rec.games - a.rec.games);

  const recent = problems.flatMap((p) => p.history).sort((a, b) => b.at - a.at).slice(0, 50);
  if (recent.length) s.accuracy = recent.filter((x) => x.ok).length / recent.length;
  return s;
}

export interface Weakness {
  title: string;
  detail: string;
  advice: string;
  train?: string; // 練習画面のクエリ
  severity: number;
}

const PHASE_JA: { [p in Phase]: string } = { opening: "序盤", middle: "中盤", end: "終盤" };
export { PHASE_JA };

/** 集計から弱点を見つけて、重い順に並べる。 */
export function findWeaknesses(s: Stats): Weakness[] {
  const out: Weakness[] = [];
  const overall = winPct(s.total);

  // 戦型別
  for (const l of s.byLabel) {
    const w = winPct(l.rec);
    if (l.label === "未解析" || w == null || l.rec.wins + l.rec.losses < 2) continue;
    if (overall != null && w < overall - 0.1) {
      out.push({
        title: `${l.label}の勝率が低い`,
        detail: `${l.rec.wins}勝${l.rec.losses}敗（勝率${Math.round(w * 100)}%、全体は${Math.round(overall * 100)}%）`,
        advice: "この戦型の対局から作った問題を重点的に解き、負けた対局を棋譜画面で見直しましょう。",
        train: `opening=${encodeURIComponent(l.label)}`,
        severity: (overall - w) * 10 * Math.min(1, l.rec.games / 4) + 1,
      });
    }
  }

  if (s.analyzedGames >= 1) {
    // 局面別
    const phases = (["opening", "middle", "end"] as Phase[]).sort((a, b) => s.mistakesByPhase[b] - s.mistakesByPhase[a]);
    const worst = phases[0];
    if (s.mistakesByPhase[worst] >= 0.5) {
      const advice = {
        opening: "角交換四間飛車の定跡手順と、仕掛けられたときの受け方を確認しましょう。序盤の問題を繰り返すのが近道です。",
        middle: "駒がぶつかったら「相手の一番の狙い」を1つ言葉にしてから指す習慣を。中盤の問題で、候補手を2つ比べる練習をしましょう。",
        end: "終盤は速度計算が鍵です。「詰めろ」「必至」「王手」のどれを掛けるか、相手玉と自玉の手数を数えてから指しましょう。",
      }[worst];
      out.push({
        title: `${PHASE_JA[worst]}の悪手が多い`,
        detail: `1局あたり 序盤${s.mistakesByPhase.opening.toFixed(1)}・中盤${s.mistakesByPhase.middle.toFixed(1)}・終盤${s.mistakesByPhase.end.toFixed(1)} 回`,
        advice,
        train: `phase=${worst}`,
        severity: s.mistakesByPhase[worst] * 1.5,
      });
    }
    // ノータイム悪手
    if (s.myMistakes >= 3 && s.fastMistakes / s.myMistakes >= 0.35) {
      out.push({
        title: "ノータイムの悪手が多い",
        detail: `悪手・疑問手${s.myMistakes}回のうち${s.fastMistakes}回が2秒以内`,
        advice: "駒を取られる・王手される手の後は、1〜2秒でいいので「相手の狙いは？」と確認してから指しましょう。",
        severity: (s.fastMistakes / s.myMistakes) * 3,
      });
    }
    // 時間切迫
    if (s.timeTroubleMoves >= 10 && s.timeTroubleMistakes / s.timeTroubleMoves >= 0.15) {
      out.push({
        title: "残り1分を切ると崩れやすい",
        detail: `残り60秒未満の${s.timeTroubleMoves}手のうち${s.timeTroubleMistakes}手が悪手・疑問手`,
        advice: "序盤の定跡部分は速く指して時間を残しましょう。切れ負けでは、終盤に2分以上残すのが目安です。",
        severity: (s.timeTroubleMistakes / s.timeTroubleMoves) * 6,
      });
    }
    if (s.missedMates > 0) {
      out.push({
        title: "詰みの見逃しがある",
        detail: `${s.analyzedGames}局で${s.missedMates}回`,
        advice: "毎日3〜7手詰めを解きましょう。王手を掛ける前に、捨て駒から入る詰み筋を1度探す習慣が効きます。",
        train: "tag=missedMate",
        severity: (s.missedMates / s.analyzedGames) * 4,
      });
    }
    if (s.allowedMates > 0) {
      out.push({
        title: "頓死（受け間違いで詰まされる）がある",
        detail: `${s.analyzedGames}局で${s.allowedMates}回`,
        advice: "王手を受けるときは「逃げる・合駒・取る」の全てを比べ、玉の逃げ道を広げる方向を優先しましょう。",
        train: "tag=allowedMate",
        severity: (s.allowedMates / s.analyzedGames) * 5,
      });
    }
  }
  return out.sort((a, b) => b.severity - a.severity);
}
