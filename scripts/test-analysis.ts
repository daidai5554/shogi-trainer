// Node上で解析パイプラインを検証する: npx tsx scripts/test-analysis.ts samples/wars1.kif
import fs from "fs";
import { createRequire } from "module";
import { importGame } from "../src/kifu";
import { analyzeGame, buildExtraTsume, buildProblems, buildPunish, buildTsume, usiToJapanese, type SearchFn } from "../src/analysis";
import { parseInfo } from "../src/engine";
import { scoreText } from "../src/score";
import type { PVLine } from "../src/types";

const require = createRequire(import.meta.url);
const Y = require("@mizarjp/yaneuraou.halfkp");

const file = process.argv[2] ?? "samples/wars1.kif";
const nodes = Number(process.argv[3] ?? 200000);
const mod = await Y();
let handler: ((l: string) => void) | null = null;
mod.addMessageListener((l: string) => handler?.(l));
const wait = (cmd: string, exp: string) => new Promise<void>((r) => { handler = (l) => { if (l.startsWith(exp)) r(); }; mod.postMessage(cmd); });
await wait("usi", "usiok");
for (const c of ["setoption name Threads value 4", "setoption name USI_Hash value 64", "setoption name PvInterval value 0", "setoption name BookFile value no_book"]) mod.postMessage(c);
await wait("isready", "readyok");

const search: SearchFn = (position, opts) => new Promise((resolve) => {
  mod.postMessage(`setoption name MultiPV value ${opts.multipv ?? 1}`);
  const lines = new Map<number, PVLine>();
  handler = (l) => {
    if (l.startsWith("info ")) { const i = parseInfo(l); if (i) lines.set(i.multipv, { score: i.score, pv: i.pv }); }
    else if (l.startsWith("bestmove")) {
      const bm = l.split(/\s+/)[1];
      if (bm === "resign") return resolve({ lines: [{ score: { kind: "mate", v: 0, win: false }, pv: [] }], bestmove: bm, nodes: 0 });
      resolve({ lines: [...lines.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]), bestmove: bm, nodes: 0 });
    }
  };
  mod.postMessage(`position ${position}`);
  mod.postMessage(`go nodes ${opts.nodes}`);
});

const { game, mySideKnown } = importGame(fs.readFileSync(file, "utf8"), (process.env.USERNAMES ?? "").split(","));
console.log({ source: game.source, black: game.black, white: game.white, mySide: game.mySide, mySideKnown, result: game.result, reason: game.resultReason, limit: game.timeLimitMs, rate: [game.blackRating, game.whiteRating] });
const t0 = Date.now();
await analyzeGame(game, search, nodes, { onProgress: (d, t) => { if (d % 20 === 0) process.stdout.write(`${d}/${t} `); } });
console.log(`\nanalysis ${(Date.now() - t0) / 1000}s`, game.strategy);
const marks = { blunder: "??", mistake: "?", dubious: "?!" } as const;
for (const v of game.verdicts!) {
  if (!v.kind && !v.missedMate && !v.allowedMate) continue;
  const a = game.analysis[v.ply - 1]!;
  console.log(`${v.ply}${v.side === game.mySide ? "(自)" : "(相)"} ${v.usi} ${v.kind ? marks[v.kind] : ""} loss=${(v.lossWin * 100).toFixed(0)}% ${v.phase} best=${a.lines[0].pv[0]} ${scoreText(a.lines[0].score)}${v.missedMate ? " 詰み逃し" : ""}${v.allowedMate ? " 頓死" : ""} 残${v.remainingMs != null ? Math.round(v.remainingMs / 1000) + "s" : "-"} 考${v.elapsedMs / 1000}s`);
}
const probs = await buildProblems(game, search, nodes, new Map());
for (const p of probs) console.log("問題", p.ply, p.tags.join(","), "正解:", usiToJapanese(p.sfen, p.answers.slice(0, 1)).join(), "候補", p.answers.length, "読み:", usiToJapanese(p.sfen, p.bestPv, 6).join(" "));
const ts = await buildTsume(game, search, new Map());
const pu = await buildPunish(game, search, new Map());
const ex = await buildExtraTsume(game, search, new Map(), 3);
console.log("kinds", JSON.stringify(probs.reduce((a: any, p) => (a[p.kind ?? "-"] = (a[p.kind ?? "-"] ?? 0) + 1, a), {})));
for (const p of [...ts, ...pu, ...ex]) console.log(p.kind, p.ply, p.mateLen ?? "", p.note ?? "", usiToJapanese(p.sfen, p.bestPv, 7).join(" "));
mod.terminate();
process.exit(0);
