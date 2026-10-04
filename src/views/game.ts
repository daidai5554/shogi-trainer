// 対局の振り返り画面: 評価値グラフ・盤面・悪手一覧・AIの読み筋。
import { Color, Record } from "tsshogi";
import { extendPv, usiToJapanese } from "../analysis";
import { engine } from "../engine";
import { BoardView, type Arrow } from "../board";
import * as db from "../db";
import { enqueue, jobStatus, onGameAnalyzed, onJobChange } from "../jobs";
import { opposite, recordOf, toResult, winnerOf } from "../kifu";
import { negate, scoreText, winRate } from "../score";
import { PHASE_JA } from "../stats";
import type { Game, MoveVerdict, Score } from "../types";
import { askClaude } from "../explain";
import { confirmDialog, fmtSec, h, pct, toast } from "../ui";
import { RESULT_JA, SOURCE_JA, opponentOf } from "./common";

const MARK = { blunder: "??", mistake: "?", dubious: "?!" } as const;
const KIND_JA = { blunder: "悪手", mistake: "疑問手", dubious: "緩手" } as const;

export async function gameView(root: HTMLElement, args: string[]) {
  let game = await db.getGame(args[0] ?? "");
  if (!game) {
    root.append(h("p", {}, "対局が見つかりません。"), h("a", { class: "btn", href: "#/games" }, "棋譜一覧へ"));
    return;
  }
  let record = recordOf(game);
  let ply = 0;
  let showBest = true;
  let pv: { baseSfen: string; moves: string[]; idx: number; title: string } | null = null;

  const header = h("div", { class: "game-header" });
  const graph = h("div", { class: "graph" });
  const boardView = new BoardView(record.position);
  const controls = h("div", { class: "controls" });
  const info = h("div", { class: "card info" });
  const moveList = h("div", { class: "move-list" });
  const actions = h("div", { class: "card actions" });
  root.append(header, graph, boardView.el, controls, info, h("h2", {}, "指し手"), moveList, actions);

  const total = () => game!.usiMoves.length;
  const verdictOf = (p: number): MoveVerdict | undefined => game!.verdicts?.find((v) => v.ply === p);
  /** 局面 i(=i手目を指した後)の、自分から見た評価 */
  const myScoreAt = (i: number): Score | null => {
    const a = game!.analysis[i];
    if (!a?.lines[0]) return null;
    const sideToMove = i % 2 === 0 ? (record.initialPosition.color === Color.BLACK ? "black" : "white") : (record.initialPosition.color === Color.BLACK ? "white" : "black");
    return sideToMove === game!.mySide ? a.lines[0].score : negate(a.lines[0].score);
  };

  function drawHeader() {
    const g = game!;
    const opp = opponentOf(g);
    const resultSel = h("select", { class: `result-select ${g.result}` }) as HTMLSelectElement;
    for (const r of ["win", "lose", "draw", "unknown"] as const) resultSel.append(h("option", { value: r }, RESULT_JA[r]));
    resultSel.value = g.result;
    resultSel.addEventListener("change", async () => {
      g.result = resultSel.value as Game["result"];
      g.resultAuto = false;
      await db.putGame(g);
      drawHeader();
    });
    header.replaceChildren(
      h("div", { class: "title-row" },
        h("h1", {}, `vs ${opp.name}`, opp.rating ? h("small", { class: "muted" }, ` ${opp.rating}`) : ""),
        resultSel),
      h("div", { class: "small muted" },
        `${g.mySide === "black" ? "☗先手" : "☖後手"}・${SOURCE_JA[g.source]}`,
        g.timeControl ? `・${g.timeControl}` : "",
        `・${g.moveCount}手`, g.resultReason ? `（${g.resultReason}）` : "",
        g.result === "unknown" ? "・勝敗を選んでください" : ""),
      g.strategy ? h("div", { class: "tags" },
        h("span", { class: "tag" }, g.strategy.myOpening),
        h("span", { class: "tag" }, g.strategy.label),
        g.strategy.oppCastle !== "その他" && g.strategy.oppCastle !== "不明" ? h("span", { class: "tag" }, "相手: " + g.strategy.oppCastle) : "") : "",
    );
  }

  function drawGraph() {
    const n = total();
    const W = 360, H = 110;
    const pts: string[] = [];
    for (let i = 0; i <= n; i++) {
      const s = myScoreAt(i);
      if (!s) continue;
      const x = (i / Math.max(1, n)) * W;
      const y = H - winRate(s) * H;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const dots = (game!.verdicts ?? [])
      .filter((v) => v.kind === "blunder" || v.kind === "mistake")
      .map((v) => {
        const s = myScoreAt(v.ply);
        if (!s) return "";
        const mine = v.side === game!.mySide;
        return `<circle cx="${((v.ply / n) * W).toFixed(1)}" cy="${(H - winRate(s) * H).toFixed(1)}" r="${mine ? 4 : 3}" class="dot ${mine ? "mine" : "theirs"} ${v.kind}"/>`;
      }).join("");
    const cx = (ply / Math.max(1, n)) * W;
    const area = pts.length ? `<polygon class="area" points="0,${H} ${pts.join(" ")} ${W},${H}"/>` : "";
    graph.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <rect class="bg" x="0" y="0" width="${W}" height="${H}"/>
      <line class="mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>
      ${area}
      <polyline class="line" points="${pts.join(" ")}"/>
      ${dots}
      <line class="cursor" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>
    </svg>
    <div class="graph-label"><span>あなたの勝率</span>${pts.length < n + 1 && !game!.analysisDone ? `<span>解析中…</span>` : ""}</div>`;
    const svg = graph.querySelector("svg")!;
    const jump = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const p = Math.round(((ev.clientX - r.left) / r.width) * n);
      goto(Math.max(0, Math.min(n, p)));
    };
    svg.addEventListener("pointerdown", (e) => { jump(e); svg.setPointerCapture(e.pointerId); });
    svg.addEventListener("pointermove", (e) => { if (e.buttons) jump(e); });
  }

  function drawBoard() {
    const g = game!;
    const flipped = g.mySide === "white";
    const names = { blackName: g.black, whiteName: g.white };
    if (pv) {
      const r = Record.newByUSI(`sfen ${pv.baseSfen} moves ${pv.moves.join(" ")}`);
      if (r instanceof Error) { pv = null; return drawBoard(); }
      r.goto(pv.idx);
      const next = pv.moves[pv.idx];
      boardView.update(r.position, {
        flipped, ...names,
        lastMoveUsi: pv.idx > 0 ? pv.moves[pv.idx - 1] : null,
        arrows: next ? [{ usi: next, color: "pv" }] : [],
      });
      return;
    }
    record.goto(ply);
    // 矢印は「直前の手」について: 緑=AIが推奨した手、赤=実戦で指した手(悪手などのとき)
    const arrows: Arrow[] = [];
    if (showBest && ply > 0) {
      const best = g.analysis[ply - 1]?.lines[0]?.pv[0];
      const played = g.usiMoves[ply - 1];
      if (best && best !== played) {
        arrows.push({ usi: best, color: "best" });
        if (verdictOf(ply)?.kind) arrows.push({ usi: played, color: "played" });
      }
    }
    boardView.update(record.position, { flipped, ...names, lastMoveUsi: ply > 0 ? g.usiMoves[ply - 1] : null, arrows });
  }

  function drawControls() {
    const n = total();
    if (pv) {
      controls.replaceChildren(
        h("button", { class: "ctl", onclick: () => { pv!.idx = 0; drawAll(); } }, "⏮"),
        h("button", { class: "ctl", onclick: () => { pv!.idx = Math.max(0, pv!.idx - 1); drawAll(); } }, "◀"),
        h("span", { class: "ctl-label" }, `読み筋 ${pv.idx}/${pv.moves.length}`),
        h("button", { class: "ctl", onclick: () => { pv!.idx = Math.min(pv!.moves.length, pv!.idx + 1); drawAll(); } }, "▶"),
        h("button", { class: "ctl wide", onclick: () => { pv = null; drawAll(); } }, "実戦に戻る"),
      );
      return;
    }
    const nextMine = () => {
      const v = (game!.verdicts ?? []).find((v) => v.ply > ply && v.side === game!.mySide && (v.kind === "blunder" || v.kind === "mistake"));
      if (v) goto(v.ply); else toast("この先に自分の悪手はありません");
    };
    controls.replaceChildren(
      h("button", { class: "ctl", onclick: () => goto(0) }, "⏮"),
      h("button", { class: "ctl", onclick: () => goto(ply - 1) }, "◀"),
      h("span", { class: "ctl-label" }, `${ply}/${n}`),
      h("button", { class: "ctl", onclick: () => goto(ply + 1) }, "▶"),
      h("button", { class: "ctl", onclick: () => goto(n) }, "⏭"),
      h("button", { class: "ctl wide", onclick: nextMine }, "悪手へ ▶"),
    );
  }

  function pvLine(sfen: string, moves: string[], title: string): HTMLElement {
    const ja = usiToJapanese(sfen, moves, 12);
    return h("div", { class: "pv" },
      h("div", { class: "pv-moves" }, ja.join(" ")),
      h("button", { class: "btn small", onclick: () => { pv = { baseSfen: sfen, moves: moves.slice(0, 20), idx: 0, title }; drawAll(); } }, "盤で再生"));
  }

  function askButton(v: MoveVerdict, sfen: string, bestScore: Score, bestPv: string[]): HTMLElement {
    const g = game!;
    const mine = v.side === g.mySide;
    const after = g.analysis[v.ply]?.lines[0];
    return h("button", {
      class: "btn small ask", onclick: async () => {
        // 読み筋が短いときは、AIが使えれば続きを読ませる
        let pv = bestPv;
        const target = bestScore.kind === "mate" && bestScore.win ? bestScore.v : 8;
        if (pv.length < target && engine.state === "ready") {
          toast("読み筋を延ばしています…");
          pv = await extendPv(engine.search.bind(engine), `sfen ${sfen}`, pv, Math.min(target, 15));
        }
        await askClaude({
        sfen, side: v.side, mine,
        playedUsi: v.usi, playedScore: after ? negate(after.score) : null,
        bestPv: pv, bestScore,
        phase: v.phase, opening: g.strategy?.label,
        myRating: g.mySide === "black" ? g.blackRating : g.whiteRating,
        missedMate: v.missedMate, allowedMate: v.allowedMate,
        // 相手の悪手なら、自分がどう咎めるべきだったかも聞く
        punishPv: !mine && after ? after.pv : undefined,
        punishScore: !mine && after ? after.score : undefined,
        });
      },
    }, mine ? "💬 Claudeに解説してもらう" : "💬 咎め方をClaudeに聞く");
  }

  function drawInfo() {
    const g = game!;
    const parts: (HTMLElement | string)[] = [];
    if (pv) {
      parts.push(h("b", {}, pv.title), h("p", { class: "small" }, usiToJapanese(pv.baseSfen, pv.moves, 20).map((m, i) => (i === pv!.idx - 1 ? `【${m}】` : m)).join(" ")));
      info.replaceChildren(...parts);
      return;
    }
    // 現在局面の形勢
    const cur = myScoreAt(ply);
    if (cur) {
      parts.push(h("div", { class: "eval-row" },
        h("span", {}, "形勢（あなた）"),
        h("b", { class: winRate(cur) >= 0.5 ? "good" : "bad" }, `${pct(winRate(cur))}`),
        h("span", { class: "muted" }, `評価値 ${scoreText(cur)}`)));
    } else if (!g.analysisDone) {
      parts.push(h("p", { class: "muted" }, "この局面はまだ解析されていません。"));
    }
    // 直前の手の判定
    if (ply > 0) {
      const v = verdictOf(ply);
      const node = record.moves[ply];
      const mine = (ply % 2 === 1) === (record.initialPosition.color === Color.BLACK ? g.mySide === "black" : g.mySide === "white");
      const title = h("div", { class: "move-title" },
        h("b", {}, `${ply}手目 ${node?.displayText ?? ""}`),
        mine ? h("span", { class: "tag mine" }, "あなた") : h("span", { class: "tag" }, "相手"),
        v?.kind ? h("span", { class: `tag ${v.kind}` }, `${KIND_JA[v.kind]} ${MARK[v.kind]}`) : "",
        v?.missedMate ? h("span", { class: "tag blunder" }, "詰み逃し") : "",
        v?.allowedMate ? h("span", { class: "tag blunder" }, "頓死") : "");
      parts.push(title);
      if (v) {
        parts.push(h("div", { class: "small muted" },
          `${PHASE_JA[v.phase]}・考慮${fmtSec(v.elapsedMs)}`,
          v.remainingMs != null ? `・残り${fmtSec(v.remainingMs)}` : "",
          v.lossWin >= 0.01 ? `・勝率 −${pct(v.lossWin)}` : ""));
      }
      const before = g.analysis[ply - 1];
      const best = before?.lines[0];
      if (best && best.pv.length && best.pv[0] !== g.usiMoves[ply - 1]) {
        record.goto(ply - 1);
        const sfen = record.position.sfen;
        parts.push(h("div", { class: "best" },
          h("div", {}, h("span", { class: "label best" }, "AIの推奨"), ` ${usiToJapanese(sfen, best.pv, 1)[0] ?? ""}`, h("span", { class: "muted" }, `（${scoreText(mine ? best.score : negate(best.score))}）`)),
          pvLine(sfen, best.pv, `${ply}手目のAI推奨手順`),
          v && (v.kind || v.missedMate || v.allowedMate) ? askButton(v, sfen, best.score, best.pv) : ""));
        record.goto(ply);
      } else if (best && best.pv[0] === g.usiMoves[ply - 1]) {
        parts.push(h("div", { class: "small good" }, "AIの最善手と一致"));
      }
    }
    // 現在局面のAIの読み
    const a = g.analysis[ply];
    if (a?.lines[0]?.pv.length && ply < total()) {
      record.goto(ply);
      parts.push(h("details", { class: "small" },
        h("summary", {}, "この局面のAIの読み"),
        pvLine(record.position.sfen, a.lines[0].pv, `${ply}手目以降のAIの読み`)));
    }
    parts.push(h("label", { class: "check small" },
      h("input", { type: "checkbox", ...(showBest ? { checked: true } : {}), onchange: (e: Event) => { showBest = (e.target as HTMLInputElement).checked; drawBoard(); } }),
      " 盤に矢印を表示（直前の手について 緑: AI推奨、赤: 実戦）"));
    info.replaceChildren(...parts);
  }

  function drawMoveList() {
    const g = game!;
    moveList.replaceChildren(...record.moves.slice(1).map((node, i) => {
      const p = i + 1;
      const v = verdictOf(p);
      const mine = v ? v.side === g.mySide : false;
      const cls = ["mv", mine ? "mine" : "", v?.kind ?? "", p === ply ? "current" : ""].join(" ");
      return h("button", { class: cls, onclick: () => goto(p) }, `${p} ${node.displayText}${v?.kind ? MARK[v.kind] : ""}`);
    }));
    moveList.querySelector(".current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function drawActions() {
    const g = game!;
    const running = jobStatus().gameId === g.id;
    actions.replaceChildren(
      h("h2", {}, "この対局の操作"),
      !g.analysisDone
        ? h("p", { class: "small muted" }, running ? "解析中です。この画面を開いたままにしておくと早く終わります。" : "解析の順番待ちです。")
        : "",
      h("div", { class: "row wrap" },
        h("button", {
          class: "btn", onclick: async () => {
            const winner = winnerOf(g);
            g.mySide = opposite(g.mySide);
            g.result = toResult(winner, g.mySide);
            g.verdicts = null; g.analysisDone = false; g.strategy = null;
            await db.putGame(g);
            for (const p of await db.problemsOfGame(g.id)) await db.deleteProblem(p.id);
            enqueue(g.id, true);
            drawAll();
          },
        }, "先後を入れ替える"),
        h("button", {
          class: "btn", onclick: async () => {
            const nodes = (await db.getSettings()).analysisNodes * 3;
            g.analysis = g.analysis.map((a) => (a && a.nodes >= nodes ? a : null));
            g.analysisDone = false;
            await db.putGame(g);
            enqueue(g.id, true, nodes);
            toast("3倍の深さで解析し直します");
            drawAll();
          },
        }, "深く解析し直す"),
        h("button", {
          class: "btn danger", onclick: async () => {
            if (!confirmDialog("この対局と、そこから作った問題を削除しますか？")) return;
            await db.deleteGame(g.id);
            location.hash = "#/games";
          },
        }, "削除"),
      ),
      h("details", { class: "small" }, h("summary", {}, "元の棋譜"), h("pre", { class: "kif" }, g.kif)),
    );
  }

  function goto(p: number) {
    ply = Math.max(0, Math.min(total(), p));
    pv = null;
    drawAll(false);
  }

  function drawAll(full = true) {
    if (full) { drawHeader(); drawActions(); }
    drawGraph();
    drawBoard();
    drawControls();
    drawInfo();
    drawMoveList();
  }

  // 最初は自分の最初の悪手を表示
  const first = (game.verdicts ?? []).find((v) => v.side === game!.mySide && v.kind === "blunder") ??
    (game.verdicts ?? []).find((v) => v.side === game!.mySide && v.kind === "mistake");
  if (first) ply = first.ply;
  drawAll();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") pv ? (pv.idx = Math.max(0, pv.idx - 1), drawAll(false)) : goto(ply - 1);
    if (e.key === "ArrowRight") pv ? (pv.idx = Math.min(pv.moves.length, pv.idx + 1), drawAll(false)) : goto(ply + 1);
  };
  window.addEventListener("keydown", onKey);

  let lastDone = -1;
  const offJob = onJobChange(async () => {
    const s = jobStatus();
    if (s.gameId !== game!.id) return;
    if (s.done - lastDone < 5 && s.done !== s.total) return;
    lastDone = s.done;
    const g = await db.getGame(game!.id);
    if (g) { game = g; drawGraph(); if (!pv) drawInfo(); }
  });
  const offDone = onGameAnalyzed(async (g) => {
    if (g.id !== game!.id) return;
    game = (await db.getGame(g.id)) ?? g;
    record = recordOf(game);
    drawAll();
  });
  return () => { window.removeEventListener("keydown", onKey); offJob(); offDone(); };
}
