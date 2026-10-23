// 解析ジョブの順番待ち。アプリを開いている間、裏で1局ずつ解析する。
import { PROBLEMS_VERSION, type SearchFn, analyzeGame, buildExtraTsume, buildProblems, buildPunish, buildTsume } from "./analysis";
import { isMastered } from "./srs";
import * as db from "./db";
import { engine } from "./engine";
import type { Game, Settings } from "./types";

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
  // 未解析の対局と、問題作成のルール・戦法の設定が変わった対局(解析結果は再利用するので速い)
  const style = styleOf(await db.getSettings());
  for (const g of await db.allGames()) {
    if (!g.analysisDone || (g.problemsVersion ?? 1) < PROBLEMS_VERSION || (g.problemsStyle ?? "any") !== style) enqueue(g.id);
  }
}

/**
 * 読んだ結果を端末に保存しておく探索。同じ局面・同じ条件を同じ深さ以上で読んだことがあれば読み直さない。
 * アップデートで問題を作り直すときや、途中で閉じて再開したときに速くなる。
 */
function cachedSearch(gameId: string, search: SearchFn): SearchFn {
  return async (position, opts) => {
    const key = `${opts.multipv ?? 1}|${[...(opts.searchmoves ?? [])].sort().join(",")}|${position}`;
    const hit = await db.getSearchCache(key).catch(() => undefined);
    if (hit && hit.nodes >= opts.nodes) return structuredClone(hit.res);
    const res = await search(position, opts);
    await db.putSearchCache(key, { gameId, nodes: opts.nodes, res: structuredClone(res) }).catch(() => {});
    return res;
  };
}

function styleOf(s: Settings): "furibisha" | "any" {
  return s.furibisha ? "furibisha" : "any";
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
      }, !!settings.furibisha);
      await db.putGame(game);

      status = { ...status, label: `vs ${opp} の問題を作成中`, done: 0, total: 1 };
      emit();
      const existing = new Map((await db.problemsOfGame(id)).map((p) => [p.id, p]));
      const cached = cachedSearch(id, search);
      const probs = await buildProblems(game, cached, nodes, existing, (d, t) => { status = { ...status, done: d, total: t }; emit(); });
      status = { ...status, label: `vs ${opp} から詰将棋を探し中`, done: 0, total: 1 };
      emit();
      probs.push(...await buildTsume(game, cached, existing));
      probs.push(...await buildPunish(game, cached, existing));
      // 詰将棋が少ないときは、実戦型詰将棋で補充する
      const tsumeLeft = (await db.allProblems()).filter((p) => p.kind === "tsume" && p.gameId !== id && !isMastered(p)).length
        + probs.filter((p) => p.kind === "tsume").length;
      if (tsumeLeft < 15 || [...existing.keys()].some((k) => k.includes(":x"))) {
        status = { ...status, label: `vs ${opp} から実戦型詰将棋を作成中` };
        emit();
        probs.push(...await buildExtraTsume(game, cached, existing));
      }
      const keep = new Set(probs.map((p) => p.id));
      for (const p of probs) await db.putProblem(p);
      for (const old of existing.values()) if (!keep.has(old.id)) await db.deleteProblem(old.id);
      game.problemsVersion = PROBLEMS_VERSION;
      game.problemsStyle = styleOf(settings);
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
