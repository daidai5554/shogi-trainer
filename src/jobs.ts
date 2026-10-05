// 解析ジョブの順番待ち。アプリを開いている間、裏で1局ずつ解析する。
import { PROBLEMS_VERSION, analyzeGame, buildExtraTsume, buildProblems, buildPunish, buildTsume } from "./analysis";
import { isMastered } from "./srs";
import * as db from "./db";
import { engine } from "./engine";
import type { Game } from "./types";

export interface JobStatus {
  gameId: string | null;
  label: string;
  done: number;
  total: number;
  queued: number;
}

const queue: string[] = [];
const nodesOverride = new Map<string, number>();
let running = false;
let status: JobStatus = { gameId: null, label: "", done: 0, total: 0, queued: 0 };
const listeners = new Set<() => void>();
/** fresh: 新しく解析した対局(問題の作り直しだけの場合は false) */
const finishListeners = new Set<(g: Game, fresh: boolean) => void>();
let wakeLock: { release(): Promise<void> } | null = null;

export function jobStatus(): JobStatus {
  return { ...status, queued: queue.length };
}
export function onJobChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function onGameAnalyzed(fn: (g: Game, fresh: boolean) => void): () => void {
  finishListeners.add(fn);
  return () => finishListeners.delete(fn);
}
function emit() {
  listeners.forEach((f) => f());
}

/** nodes を指定すると、その対局だけ設定より深く解析する */
export function enqueue(gameId: string, front = false, nodes?: number) {
  if (nodes) nodesOverride.set(gameId, nodes);
  if (queue.includes(gameId) || status.gameId === gameId) return;
  if (front) queue.unshift(gameId); else queue.push(gameId);
  emit();
  void run();
}

/** 未解析の対局をすべて順番待ちに入れる(起動時) */
export async function resumePending() {
  // 未解析の対局と、問題作成のルールが古い対局(解析結果は再利用するので速い)
  for (const g of await db.allGames()) {
    if (!g.analysisDone || (g.problemsVersion ?? 1) < PROBLEMS_VERSION) enqueue(g.id);
  }
}

async function acquireWakeLock() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (wl && !wakeLock) wakeLock = await wl.request("screen");
  } catch { /* 取得できなくても続行 */ }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* noop */ }
  wakeLock = null;
}

async function run() {
  if (running) return;
  running = true;
  try {
    await engine.load((await db.getSettings()).threads);
    await acquireWakeLock();
    while (queue.length) {
      const id = queue.shift()!;
      const settings = await db.getSettings();
      let game = await db.getGame(id);
      if (!game) continue;
      const fresh = !game.analysisDone;
      const opp = game.mySide === "black" ? game.white : game.black;
      status = { gameId: id, label: `vs ${opp} を解析中`, done: 0, total: game.usiMoves.length + 1, queued: queue.length };
      emit();
      const search = engine.search.bind(engine);
      const nodes = nodesOverride.get(id) ?? settings.analysisNodes;
      nodesOverride.delete(id);
      game = await analyzeGame(game, search, nodes, {
        onProgress: (d, t) => { status = { ...status, done: d, total: t }; emit(); },
        save: (g) => db.putGame(g),
      });
      await db.putGame(game);

      status = { ...status, label: `vs ${opp} の問題を作成中`, done: 0, total: 1 };
      emit();
      const existing = new Map((await db.problemsOfGame(id)).map((p) => [p.id, p]));
      const probs = await buildProblems(game, search, nodes, existing, (d, t) => { status = { ...status, done: d, total: t }; emit(); });
      status = { ...status, label: `vs ${opp} から詰将棋を探し中`, done: 0, total: 1 };
      emit();
      probs.push(...await buildTsume(game, search, existing));
      probs.push(...await buildPunish(game, search, existing));
      // 詰将棋が少ないときは、実戦型詰将棋で補充する
      const tsumeLeft = (await db.allProblems()).filter((p) => p.kind === "tsume" && p.gameId !== id && !isMastered(p)).length
        + probs.filter((p) => p.kind === "tsume").length;
      if (tsumeLeft < 15 || [...existing.keys()].some((k) => k.includes(":x"))) {
        status = { ...status, label: `vs ${opp} から実戦型詰将棋を作成中` };
        emit();
        probs.push(...await buildExtraTsume(game, search, existing));
      }
      const keep = new Set(probs.map((p) => p.id));
      for (const p of probs) await db.putProblem(p);
      for (const old of existing.values()) if (!keep.has(old.id)) await db.deleteProblem(old.id);
      game.problemsVersion = PROBLEMS_VERSION;
      await db.putGame(game);
      const g2 = game;
      finishListeners.forEach((f) => f(g2, fresh));
    }
  } catch (e) {
    console.error(e);
  } finally {
    status = { gameId: null, label: "", done: 0, total: 0, queued: queue.length };
    running = false;
    await releaseWakeLock();
    emit();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) void acquireWakeLock();
});
