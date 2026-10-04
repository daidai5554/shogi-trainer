// 練習画面。「今日のトレーニング」(定跡確認・悪手の復習・詰将棋を少しずつ)と、テーマ別練習。
import { Color, Move, Position, Record, Square, pieceTypeToStringForMove } from "tsshogi";
import { problemKind, usiToJapanese } from "../analysis";
import { BoardView } from "../board";
import * as db from "../db";
import { engine } from "../engine";
import { askClaude } from "../explain";
import { hasLegalMove } from "../kifu";
import { negate, scoreText, winRate } from "../score";
import { buildDailySet, summarize } from "../session";
import { grade } from "../srs";
import { PHASE_JA } from "../stats";
import type { Problem, ProblemKind } from "../types";
import { fmtDate, h } from "../ui";
import { emptyState } from "./common";

const THEME_SIZE = 10;
const TAG_JA = { blunder: "悪手", mistake: "疑問手", missedMate: "詰み逃し", allowedMate: "頓死" } as const;
export const KIND_JA: { [k in ProblemKind]: string } = { book: "定跡確認", mistake: "悪手の復習", tsume: "詰将棋" };

function filterLabel(q: URLSearchParams): string {
  if (q.get("phase")) return `${PHASE_JA[q.get("phase") as keyof typeof PHASE_JA]}の問題`;
  if (q.get("tag")) return `${TAG_JA[q.get("tag") as keyof typeof TAG_JA]}の問題`;
  if (q.get("kind")) return KIND_JA[q.get("kind") as ProblemKind] ?? "";
  if (q.get("opening")) return `${q.get("opening")}の問題`;
  return "";
}

export async function trainView(root: HTMLElement, _args: string[], q: URLSearchParams) {
  const all = await db.allProblems();
  const now = Date.now();
  const label = filterLabel(q);
  const extra = q.get("more") === "1";

  let session: Problem[];
  if (label) {
    // テーマ別練習: 期日の来たもの → 苦手な順
    const match = (p: Problem) =>
      (!q.get("phase") || p.phase === q.get("phase")) &&
      (!q.get("tag") || p.tags.includes(q.get("tag") as Problem["tags"][number])) &&
      (!q.get("kind") || problemKind(p) === q.get("kind")) &&
      (!q.get("opening") || p.opening === q.get("opening"));
    const filtered = all.filter(match);
    session = [
      ...filtered.filter((p) => p.due <= now).sort((a, b) => a.due - b.due),
      ...filtered.filter((p) => p.due > now).sort((a, b) => a.ease - b.ease || b.lapses - a.lapses),
    ].slice(0, THEME_SIZE);
  } else {
    session = buildDailySet(all, now, extra);
  }

  const title = label || (extra ? "おかわり（苦手な問題）" : "今日のトレーニング");
  if (all.length === 0) {
    root.append(h("h1", {}, "練習"), emptyState("まだ問題がありません。棋譜を取り込むと、AIの解析後にあなたの対局から問題が作られます。", h("a", { class: "btn primary", href: "#/import" }, "棋譜を取り込む")));
    return;
  }
  if (session.length === 0) {
    root.append(h("h1", {}, "練習"),
      h("section", { class: "card hero" },
        h("h2", {}, label ? `${label}はありません` : "今日の分は終わりました！"),
        h("p", { class: "small muted" }, "対局を取り込むと新しい問題が増えます。"),
        label ? "" : h("a", { class: "btn", href: "#/train?more=1" }, "おかわり（苦手な問題をもう少し）")),
      themeMenu(all));
    return;
  }

  // 別解・詰将棋の判定に使うので、AIを先に読み込んでおく
  void db.getSettings().then((st) => engine.load(st.threads)).catch(() => undefined);

  let index = 0;
  let correctCount = 0;
  const graded = new Set<string>();
  const container = h("div", {});
  const progress = h("div", { class: "progress" });
  root.append(
    h("div", { class: "title-row" }, h("h1", {}, title), label ? h("a", { class: "link", href: "#/train" }, "今日のトレーニングへ") : ""),
    progress, container);

  const drawProgress = () => {
    progress.replaceChildren(...session.map((p, i) =>
      h("span", { class: `dot k-${problemKind(p)}${i < index ? " done" : ""}${i === index ? " now" : ""}` })));
  };

  const finish = async () => {
    const rest = await db.allProblems();
    const sum = summarize(rest);
    drawProgress();
    container.replaceChildren(
      h("section", { class: "card hero" },
        h("h2", {}, "お疲れさまでした"),
        h("p", {}, `${graded.size}問中 ${correctCount}問 正解`),
        h("div", { class: "row wrap" },
          !label && sum.total > 0 ? h("a", { class: "btn primary", href: `#/train?set=${Date.now()}` }, `もう1セット（${sum.total}問）`) : "",
          !label && sum.total === 0 ? h("a", { class: "btn", href: `#/train?more=1&set=${Date.now()}` }, "おかわり（苦手な問題）") : "",
          h("a", { class: "btn" + (label || sum.total === 0 ? " primary" : ""), href: "#/" }, "ホームへ"))),
      themeMenu(rest));
  };

  const next = () => { index++; void show(); };

  const record1 = async (p: Problem, ok: boolean) => {
    if (graded.has(p.id + ":" + index)) return;
    graded.add(p.id + ":" + index);
    if (ok) correctCount++;
    await db.putProblem(grade(p, ok));
    // 間違えた問題はこのセッションの最後にもう一度
    if (!ok && !session.slice(index + 1).some((s) => s.id === p.id)) { session.push(p); drawProgress(); }
  };

  const show = async () => {
    drawProgress();
    if (index >= session.length) return finish();
    const p = (await db.getProblem(session[index].id)) ?? session[index];
    if (problemKind(p) === "tsume") await showTsume(p);
    else await showSingle(p);
  };

  /** 共通の見出し部分 */
  const header = async (p: Problem, prompt: string) => {
    const game = await db.getGame(p.gameId);
    const kind = problemKind(p);
    const isMineSide = game ? game.mySide === p.side : true;
    const tags = h("div", { class: "tags" },
      h("span", { class: `tag k-${kind}` }, KIND_JA[kind]),
      ...(kind === "tsume" ? [] : p.tags.map((t) => h("span", { class: `tag ${t === "mistake" ? "mistake" : "blunder"}` }, TAG_JA[t]))),
      kind === "mistake" ? h("span", { class: "tag" }, PHASE_JA[p.phase]) : "",
      p.opening ? h("span", { class: "tag" }, p.opening) : "",
      p.history.length ? h("span", { class: "tag" }, `復習${p.history.length + 1}回目`) : h("span", { class: "tag new" }, "新しい問題"));
    const source = game
      ? h("div", { class: "small muted" },
        `出典: vs ${game.mySide === "black" ? game.white : game.black}（${fmtDate(game.playedAt)}）${p.ply}手目`,
        kind === "tsume" ? (isMineSide ? "・あなたの攻め" : "・相手の攻め") : "", "　",
        h("a", { href: `#/game/${game.id}` }, "対局を見る"))
      : "";
    const promptEl = h("p", { class: "prompt" }, h("b", {}, `${p.side === "black" ? "☗先手" : "☖後手"}番`), "　", prompt);
    return { game, tags, source, promptEl };
  };

  // ───────── 1手で答える問題(定跡確認・悪手の復習) ─────────
  const showSingle = async (p: Problem) => {
    const record = Record.newByUSI(`sfen ${p.sfen}`);
    if (record instanceof Error) return next();
    const kind = problemKind(p);
    const color = p.side === "black" ? Color.BLACK : Color.WHITE;
    let attempted = false;
    let hintUsed = false;
    const prompt = kind === "book"
      ? "序盤の局面です。AIの推奨する手を指してください。"
      : p.tags.includes("missedMate") ? "詰みがあります。正しい手を指してください。"
        : p.tags.includes("allowedMate") ? "実戦はここで頓死しました。安全な手を指してください。"
          : "実戦ではここで形勢を損ねました。最善手を指してください。";
    const { game, tags, source, promptEl } = await header(p, prompt);
    const names = { flipped: p.side === "white", blackName: game?.black, whiteName: game?.white };
    const board = new BoardView(record.position, { ...names, interactive: { color, onMove: (m) => void onMove(m) } });
    const feedback = h("div", { class: "feedback" });
    const buttons = h("div", { class: "row" });
    container.replaceChildren(tags, promptEl, board.el, feedback, buttons, source);

    const ja = (usis: string[], n = 1) => usiToJapanese(p.sfen, usis, n);
    const showAnswer = (ok: boolean, played: string | null, note = "") => {
      const best = p.bestPv[0];
      feedback.replaceChildren(
        h("div", { class: `verdict ${ok ? "ok" : "ng"}` }, ok ? "◯ 正解" + note : "✕ 不正解"),
        played && played !== best ? h("div", {}, `あなたの手: ${ja([played])[0] ?? played}`) : "",
        h("div", {}, h("span", { class: "label best" }, "正解"), ` ${ja([best])[0]}（評価 ${scoreText(p.bestScore)}）`,
          p.answers.length > 1 ? h("span", { class: "muted" }, `　ほかに ${p.answers.filter((a) => a !== best).map((a) => ja([a])[0]).join("・")} も可`) : ""),
        h("div", {}, h("span", { class: "label played" }, "実戦"), ` ${ja([p.playedUsi])[0]}`,
          p.playedScore ? `（評価 ${scoreText(p.playedScore)}、勝率 −${Math.round(p.lossWin * 100)}%）` : ""),
        h("div", { class: "pv-moves small" }, "読み筋: " + ja(p.bestPv, 12).join(" ")),
        h("button", {
          class: "btn small ask", onclick: () => askClaude({
            sfen: p.sfen, side: p.side, mine: true,
            playedUsi: p.playedUsi, playedScore: p.playedScore,
            bestPv: p.bestPv, bestScore: p.bestScore, alternatives: p.answers,
            phase: p.phase, opening: p.opening,
            myRating: game ? (p.side === "black" ? game.blackRating : game.whiteRating) : undefined,
            missedMate: p.tags.includes("missedMate"), allowedMate: p.tags.includes("allowedMate"),
          }),
        }, "💬 Claudeに解説してもらう"),
      );
      board.update(record.position, { ...names, arrows: [{ usi: best, color: "best" }, { usi: p.playedUsi, color: "played" }] });
      buttons.replaceChildren(...pvButtons(p, board, names), nextButton());
    };

    /** 正解リストに無い手は、AIで評価して最善とほぼ同じなら正解(別解)とする */
    const isAlternative = async (usi: string): Promise<boolean | null> => {
      if (engine.state !== "ready") return null;
      feedback.replaceChildren(h("div", { class: "muted" }, "AIがあなたの手を確認中…"));
      const res = await engine.search(`sfen ${p.sfen} moves ${usi}`, { nodes: 300_000 });
      const s = res.lines[0] ? negate(res.lines[0].score) : null;
      if (!s) return null;
      if (p.bestScore.kind === "mate" && p.bestScore.win) return s.kind === "mate" && s.win;
      return winRate(p.bestScore) - winRate(s) <= 0.04;
    };

    const onMove = async (m: Move) => {
      if (attempted) return;
      attempted = true;
      const usi = m.usi;
      const after = record.position.clone();
      after.doMove(m);
      board.update(after, { ...names, lastMoveUsi: usi });
      const ok = p.answers.includes(usi) || (usi !== p.playedUsi && (await isAlternative(usi)) === true);
      const alt = ok && !p.answers.includes(usi);
      await record1(p, ok && !hintUsed);
      showAnswer(ok, usi, (alt ? "（別解）" : "") + (hintUsed && ok ? "（ヒントあり）" : ""));
    };

    buttons.replaceChildren(
      h("button", {
        class: "btn", onclick: () => {
          hintUsed = true;
          feedback.replaceChildren(h("div", { class: "muted" }, hintText(record.position as Position, p.bestPv[0]), "（ヒントを使うと、この問題は明日もう一度出ます）"));
        },
      }, "ヒント"),
      h("button", { class: "btn", onclick: async () => { attempted = true; await record1(p, false); showAnswer(false, null); } }, "答えを見る"),
    );
  };

  // ───────── 詰将棋(相手の応手はAIが指す) ─────────
  const showTsume = async (p: Problem) => {
    const start = Position.newBySFEN(p.sfen);
    if (!start) return next();
    const mateLen = p.mateLen ?? (p.bestScore.kind === "mate" ? p.bestScore.v : p.bestPv.length);
    const color = p.side === "black" ? Color.BLACK : Color.WHITE;
    const pos = start.clone();
    const moves: string[] = [];
    let busy = false;
    let finished = false;
    let hintUsed = false;
    const { game, tags, source, promptEl } = await header(p, `${mateLen}手詰めです。王手の連続でなくても、最短で詰ませればOK。`);
    const names = { flipped: p.side === "white", blackName: game?.black, whiteName: game?.white };
    const board = new BoardView(pos, { ...names, interactive: { color, onMove: (m) => void onMove(m) } });
    const feedback = h("div", { class: "feedback" });
    const buttons = h("div", { class: "row" });
    const movesEl = h("div", { class: "pv-moves small" });
    container.replaceChildren(tags, promptEl, board.el, movesEl, feedback, buttons, source);

    const redraw = (interactive: boolean) => {
      board.update(pos, { ...names, lastMoveUsi: moves[moves.length - 1] ?? null, interactive: interactive ? { color, onMove: (m) => void onMove(m) } : undefined });
      movesEl.textContent = moves.length ? usiToJapanese(p.sfen, moves).join(" ") : "";
    };

    const end = async (ok: boolean, msg: string) => {
      finished = true;
      await record1(p, ok && !hintUsed);
      redraw(false);
      feedback.replaceChildren(
        h("div", { class: `verdict ${ok ? "ok" : "ng"}` }, ok ? `◯ 詰みました${hintUsed ? "（ヒントあり）" : ""}` : "✕ 不正解"),
        msg ? h("div", { class: "small" }, msg) : "",
        h("div", {}, h("span", { class: "label best" }, "正解手順"), " " + usiToJapanese(p.sfen, p.bestPv).join(" ")),
        h("button", {
          class: "btn small ask", onclick: () => askClaude({
            sfen: p.sfen, side: p.side, mine: true, tsume: true, mateLen,
            bestPv: p.bestPv, bestScore: p.bestScore,
            myRating: game ? (game.mySide === "black" ? game.blackRating : game.whiteRating) : undefined,
          }),
        }, "💬 Claudeに解説してもらう"),
      );
      buttons.replaceChildren(...pvButtons(p, board, names), nextButton());
    };

    const onMove = async (m: Move) => {
      if (busy || finished) return;
      busy = true;
      pos.doMove(m);
      moves.push(m.usi);
      redraw(false);
      try {
        if (!hasLegalMove(pos)) {
          if (pos.checked) return await end(true, "");
          return await end(false, "相手玉に王手がかかっていません（打ち歩詰めなどの反則の可能性もあります）。");
        }
        const left = mateLen - moves.length; // 残り手数
        if (left <= 0) return await end(false, `${mateLen}手では詰んでいません。`);
        let reply: string | null = null;
        if (engine.state === "ready") {
          feedback.replaceChildren(h("div", { class: "muted" }, "AIが受けを考えています…"));
          const res = await engine.search(`sfen ${p.sfen} moves ${moves.join(" ")}`, { nodes: 300_000 });
          const s = res.lines[0]?.score;
          // 受ける側から見て「left手以内に詰まされる」なら正解の続き
          if (!s || s.kind !== "mate" || s.win || s.v > left) return await end(false, "その手では詰みません。");
          reply = res.bestmove;
        } else if (p.bestPv[moves.length - 1] === m.usi) {
          // AIが使えないときは、正解手順と同じ手だけを認める
          reply = p.bestPv[moves.length] ?? null;
        } else {
          return await end(false, "その手は正解手順と違います（AIの準備ができていないため、別の詰め方は判定できません）。");
        }
        if (!reply || reply === "resign") return await end(true, "");
        const rm = pos.createMoveByUSI(reply);
        if (!rm) return await end(false, "");
        pos.doMove(rm);
        moves.push(reply);
        feedback.replaceChildren(h("div", { class: "muted" }, `相手: ${usiToJapanese(p.sfen, moves).slice(-1)[0]}。続けて詰ませてください（残り${mateLen - moves.length}手）。`));
        redraw(true);
      } finally {
        busy = false;
      }
    };

    buttons.replaceChildren(
      h("button", {
        class: "btn", onclick: () => {
          if (finished) return;
          hintUsed = true;
          // 今の局面の1手目のヒント(正解手順どおりに進んでいる場合)
          const onTrack = moves.every((u, i) => p.bestPv[i] === u);
          const hint = onTrack ? p.bestPv[moves.length] : null;
          feedback.replaceChildren(h("div", { class: "muted" }, hint ? hintText(pos, hint) : "正解手順から外れているため、ヒントを出せません。", "（ヒントを使うと、この問題は明日もう一度出ます）"));
        },
      }, "ヒント"),
      h("button", { class: "btn", onclick: () => { if (!finished) void end(false, ""); } }, "答えを見る"),
    );
  };

  const nextButton = () =>
    h("button", { class: "btn primary", onclick: next }, index + 1 < session.length ? "次へ" : "終わる");

  await show();
}

function hintText(pos: Position, usi: string): string {
  const sq = usi[1] === "*" ? null : Square.newByUSI(usi.slice(0, 2));
  const piece = sq ? pos.board.at(sq) : null;
  return piece ? `ヒント: ${pieceTypeToStringForMove(piece.type)}を動かします。` : "ヒント: 持ち駒を打つ手です。";
}

/** 正解の読み筋を盤上で1手ずつ再生するボタン */
function pvButtons(p: Problem, board: BoardView, names: { flipped: boolean; blackName?: string; whiteName?: string }): HTMLElement[] {
  let idx = 0;
  const rec = Record.newByUSI(`sfen ${p.sfen} moves ${p.bestPv.join(" ")}`);
  const step = (d: number) => {
    if (rec instanceof Error) return;
    idx = Math.max(0, Math.min(p.bestPv.length, idx + d));
    rec.goto(idx);
    board.update(rec.position, { ...names, lastMoveUsi: idx ? p.bestPv[idx - 1] : null, arrows: p.bestPv[idx] ? [{ usi: p.bestPv[idx], color: "pv" }] : [] });
  };
  return [
    h("button", { class: "btn", onclick: () => step(-1) }, "◀"),
    h("button", { class: "btn", onclick: () => step(1) }, "手順 ▶"),
  ];
}

function themeMenu(all: Problem[]): HTMLElement {
  const count = (f: (p: Problem) => boolean) => all.filter(f).length;
  const item = (label: string, q: string, n: number) =>
    n ? h("a", { class: "chip", href: `#/train?${q}` }, `${label} ${n}`) : "";
  return h("details", { class: "card" },
    h("summary", {}, "テーマ別に練習する"),
    h("div", { class: "chips", style: "margin-top:10px" },
      item("定跡確認", "kind=book", count((p) => problemKind(p) === "book")),
      item("悪手の復習", "kind=mistake", count((p) => problemKind(p) === "mistake")),
      item("詰将棋", "kind=tsume", count((p) => problemKind(p) === "tsume")),
      item("中盤", "phase=middle", count((p) => problemKind(p) === "mistake" && p.phase === "middle")),
      item("終盤", "phase=end", count((p) => problemKind(p) === "mistake" && p.phase === "end")),
      item("詰み逃し", "tag=missedMate", count((p) => p.tags.includes("missedMate"))),
      item("頓死", "tag=allowedMate", count((p) => p.tags.includes("allowedMate"))),
      ...[...new Set(all.map((p) => p.opening).filter(Boolean))].map((o) => item(o, `opening=${encodeURIComponent(o)}`, count((p) => p.opening === o))),
    ),
    h("p", { class: "small muted" }, `問題 全${all.length}問`),
  );
}
