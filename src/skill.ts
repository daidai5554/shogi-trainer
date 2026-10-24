// 実力の測定: 解析済みの対局から、指し手の正確さ・局面別の力・勝負強さ・時間の使い方・推定段級を数値にする。
// 画面に依存しないので Node でも検証できる。
import { bestLine } from "./analysis";
import { negate, winRate } from "./score";
import type { Game, Phase, Side, Source } from "./types";

export const PHASES: Phase[] = ["opening", "middle", "end"];

interface Acc { n: number; loss: number; }
const acc = (): Acc => ({ n: 0, loss: 0 });
const add = (a: Acc, loss: number) => { a.n++; a.loss += loss; };
export const avg = (a: Acc): number | null => (a.n ? a.loss / a.n : null);

/** 1局ぶんの集計(自分の手と相手の手) */
export interface GameSkill {
  id: string;
  at: number;
  source: Source;
  oppName: string;
  label: string; // 戦型(相手の作戦を含む)
  myOpening: string;
  side: Side;
  result: Game["result"];
  myRating: number | null;
  oppRating: number | null;
  me: Acc;
  match: number; // AIの最善手と同じ手を指した数
  bad: number; // 悪手+疑問手
  dubious: number;
  phase: { [p in Phase]: Acc & { bad: number } };
  opp: Acc;
  oppMatch: number;
  oppPhase: { [p in Phase]: Acc };
  mateChances: number; // 7手以内の詰みがあった場面(連続する詰み手順は1回と数える)
  mateFound: number; // そのうち詰みを続けた(正しく指した)回数
  allowedMate: number;
  timeTrouble: Acc; // 残り60秒未満
  timeOk: Acc;
  fast: Acc; // 2秒以内に指した手
  slow: Acc; // 10秒以上考えた手
  maxWr: number; // 対局中の自分の勝率の最大・最小
  minWr: number;
}

const KANJI = ["初", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 段級・レートを数値にする。ウォーズは 1級=0・初段=1・二段=2…、クエストなどはレートそのまま */
export function ratingValue(text: string, source: Source): number | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (/^\d{3,4}$/.test(t)) return source === "wars" ? null : Number(t);
  const kyu = t.match(/^(\d+)級$/);
  if (kyu) return 1 - Number(kyu[1]);
  const dan = t.match(/^(初|[二三四五六七八九])段$/);
  if (dan) return KANJI.indexOf(dan[1]) + 1;
  return null;
}

export function ratingText(v: number, source: Source): string {
  if (source !== "wars") return String(Math.round(v));
  const r = Math.round(v);
  return r >= 1 ? `${KANJI[Math.min(8, r - 1)]}段` : `${1 - r}級`;
}

/** 推定値の表示用: ウォーズは段級の中の位置(上位・下位)まで出す */
export function ratingFine(v: number, source: Source): string {
  if (source !== "wars") return String(Math.round(v / 5) * 5);
  const r = Math.round(v);
  const d = v - r;
  return ratingText(r, source) + (d >= 0.2 ? "上位" : d <= -0.2 ? "下位" : "");
}

export function gameSkill(g: Game): GameSkill | null {
  if (!g.analysisDone || !g.verdicts?.length) return null;
  const myR = g.mySide === "black" ? g.blackRating : g.whiteRating;
  const oppR = g.mySide === "black" ? g.whiteRating : g.blackRating;
  const s: GameSkill = {
    id: g.id, at: g.playedAt, source: g.source, oppName: g.mySide === "black" ? g.white : g.black, label: g.strategy?.label ?? "不明", myOpening: g.strategy?.myOpening ?? "不明",
    side: g.mySide, result: g.result,
    myRating: ratingValue(myR, g.source), oppRating: ratingValue(oppR, g.source),
    me: acc(), match: 0, bad: 0, dubious: 0,
    phase: { opening: { ...acc(), bad: 0 }, middle: { ...acc(), bad: 0 }, end: { ...acc(), bad: 0 } },
    opp: acc(), oppMatch: 0, oppPhase: { opening: acc(), middle: acc(), end: acc() },
    mateChances: 0, mateFound: 0, allowedMate: 0,
    timeTrouble: acc(), timeOk: acc(), fast: acc(), slow: acc(),
    maxWr: 0.5, minWr: 0.5,
  };
  let lastMateChancePly = -10;
  for (const v of g.verdicts) {
    const before = g.analysis[v.ply - 1];
    const after = g.analysis[v.ply];
    const best = bestLine(before);
    const isBest = best?.pv[0] === v.usi;
    const mine = v.side === g.mySide;
    if (!mine) {
      add(s.opp, v.lossWin);
      add(s.oppPhase[v.phase], v.lossWin);
      if (isBest) s.oppMatch++;
      continue;
    }
    add(s.me, v.lossWin);
    add(s.phase[v.phase], v.lossWin);
    if (isBest) s.match++;
    if (v.kind === "blunder" || v.kind === "mistake") { s.bad++; s.phase[v.phase].bad++; }
    if (v.kind === "dubious") s.dubious++;
    if (v.allowedMate) s.allowedMate++;
    add(v.remainingMs != null && v.remainingMs < 60_000 ? s.timeTrouble : s.timeOk, v.lossWin);
    if (v.elapsedMs > 0 && v.elapsedMs <= 2000) add(s.fast, v.lossWin);
    if (v.elapsedMs >= 10_000) add(s.slow, v.lossWin);

    const sc = before?.lines[0]?.score;
    if (sc) {
      const wr = winRate(sc);
      s.maxWr = Math.max(s.maxWr, wr);
      s.minWr = Math.min(s.minWr, wr);
      if (sc.kind === "mate" && sc.win && sc.v <= 7) {
        // 2手前(前の自分の手番)も詰みがあったなら、同じ詰み手順の続き
        if (v.ply - lastMateChancePly > 2) {
          s.mateChances++;
          const a = after?.lines[0]?.score;
          const kept = isBest || (a ? (() => { const m = negate(a); return m.kind === "mate" && m.win; })() : false);
          if (kept) s.mateFound++;
        }
        lastMateChancePly = v.ply;
      }
    }
  }
  return s.me.n ? s : null;
}

/** 複数局をまとめた指標 */
export interface Summary {
  games: number;
  moves: number;
  loss: number | null; // 1手あたりの勝率の損失(0..1)
  match: number | null; // AI一致率
  badPer100: number | null;
  badPerGame: number | null;
  phaseLoss: { [p in Phase]: number | null };
  oppPhaseLoss: { [p in Phase]: number | null };
  oppLoss: number | null;
  oppMatch: number | null;
  mateRate: number | null; mateChances: number;
  allowedMatePerGame: number | null;
  conversion: { chances: number; wins: number }; // 勝率80%以上になった対局を勝てたか
  comeback: { chances: number; wins: number }; // 勝率20%以下になった対局を勝てたか
  timeTroubleLoss: number | null; timeOkLoss: number | null; timeTroubleMoves: number;
  fastLoss: number | null; slowLoss: number | null;
  wins: number; losses: number;
}

export function summarize(list: GameSkill[]): Summary {
  const me = acc(), opp = acc(), tt = acc(), ok = acc(), fast = acc(), slow = acc();
  const ph = { opening: acc(), middle: acc(), end: acc() };
  const oph = { opening: acc(), middle: acc(), end: acc() };
  let match = 0, oppMatch = 0, bad = 0, mc = 0, mf = 0, am = 0, wins = 0, losses = 0;
  const conversion = { chances: 0, wins: 0 }, comeback = { chances: 0, wins: 0 };
  const merge = (a: Acc, b: Acc) => { a.n += b.n; a.loss += b.loss; };
  for (const g of list) {
    merge(me, g.me); merge(opp, g.opp); merge(tt, g.timeTrouble); merge(ok, g.timeOk); merge(fast, g.fast); merge(slow, g.slow);
    for (const p of PHASES) { merge(ph[p], g.phase[p]); merge(oph[p], g.oppPhase[p]); }
    match += g.match; oppMatch += g.oppMatch; bad += g.bad; mc += g.mateChances; mf += g.mateFound; am += g.allowedMate;
    if (g.result === "win") wins++;
    if (g.result === "lose") losses++;
    if (g.result === "win" || g.result === "lose") {
      if (g.maxWr >= 0.8) { conversion.chances++; if (g.result === "win") conversion.wins++; }
      if (g.minWr <= 0.2) { comeback.chances++; if (g.result === "win") comeback.wins++; }
    }
  }
  const n = list.length;
  return {
    games: n, moves: me.n,
    loss: avg(me), match: me.n ? match / me.n : null,
    badPer100: me.n ? (bad / me.n) * 100 : null, badPerGame: n ? bad / n : null,
    phaseLoss: { opening: avg(ph.opening), middle: avg(ph.middle), end: avg(ph.end) },
    oppPhaseLoss: { opening: avg(oph.opening), middle: avg(oph.middle), end: avg(oph.end) },
    oppLoss: avg(opp), oppMatch: opp.n ? oppMatch / opp.n : null,
    mateRate: mc ? mf / mc : null, mateChances: mc,
    allowedMatePerGame: n ? am / n : null,
    conversion, comeback,
    timeTroubleLoss: avg(tt), timeOkLoss: avg(ok), timeTroubleMoves: tt.n,
    fastLoss: avg(fast), slowLoss: avg(slow),
    wins, losses,
  };
}

export function allSkills(games: Game[]): GameSkill[] {
  return games.map(gameSkill).filter((x): x is GameSkill => !!x).sort((a, b) => a.at - b.at);
}

/**
 * 推定段級: 同じ対局サイトの対局で、対局者(自分と相手)の「段級・レート」と「1手の損失」の関係を
 * 直線で当てはめ、自分の損失がどの段級に当たるかを求める。データが少ない・関係が見えないときは null。
 */
export interface RatingModel { source: Source; a: number; b: number; points: number; min: number; max: number; }

export function fitRatingModel(list: GameSkill[], source: Source): RatingModel | null {
  const xs: number[] = [], ys: number[] = [];
  for (const g of list) {
    if (g.source !== source) continue;
    if (g.myRating != null && g.me.n >= 15) { xs.push(g.me.loss / g.me.n); ys.push(g.myRating); }
    if (g.oppRating != null && g.opp.n >= 15) { xs.push(g.opp.loss / g.opp.n); ys.push(g.oppRating); }
  }
  if (xs.length < 16) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  if (b >= 0) return null; // 損失が多いほど段級が低い、という関係が見えない
  const min = Math.min(...ys), max = Math.max(...ys);
  if (max - min < (source === "wars" ? 2 : 150)) return null; // 相手の段級に幅が無いと推定できない
  return { source, a: my - b * mx, b, points: xs.length, min, max };
}

/** 損失から段級を推定(当てはめに使った段級の範囲から大きくはみ出さないようにする) */
export function estimateRating(m: RatingModel, loss: number): number {
  const margin = (m.max - m.min) * 0.25;
  return Math.max(m.min - margin, Math.min(m.max + margin, m.a + m.b * loss));
}

/** 一番多く指しているサイト(推定段級・公式段級の推移に使う) */
export function mainSource(list: GameSkill[]): Source | null {
  const c = new Map<Source, number>();
  for (const g of list) if (g.myRating != null) c.set(g.source, (c.get(g.source) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
