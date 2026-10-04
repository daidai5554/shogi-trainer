// 自分の悪手から作った問題を、間隔反復で解く画面。
import { Color, Move, Record, Square, pieceTypeToStringForMove } from "tsshogi";
import { usiToJapanese } from "../analysis";
import { BoardView } from "../board";
import * as db from "../db";
import { engine } from "../engine";
import { negate, scoreText, winRate } from "../score";
import { grade } from "../srs";
import { PHASE_JA } from "../stats";
import type { Problem } from "../types";
import { askClaude } from "../explain";
import { fmtDate, h } from "../ui";
import { emptyState } from "./common";

const SESSION_SIZE = 15;
const TAG_JA = { blunder: "悪手", mistake: "疑問手", missedMate: "詰み逃し", allowedMate: "頓死" } as const;

function filterLabel(q: URLSearchParams): string {
  if (q.get("phase")) return `${PHASE_JA[q.get("phase") as keyof typeof PHASE_JA]}の問題`;
  if (q.get("tag")) return `${TAG_JA[q.get("tag") as keyof typeof TAG_JA]}の問題`;
  if (q.get("opening")) return `${q.get("opening")}の問題`;
  return "";
}

export async function trainView(root: HTMLElement, _args: string[], q: URLSearchParams) {
  const all = await db.allProblems();
  const now = Date.now();
  const match = (p: Problem) =>
    (!q.get("phase") || p.phase === q.get("phase")) &&
    (!q.get("tag") || p.tags.includes(q.get("tag") as Problem["tags"][number])) &&
    (!q.get("opening") || p.opening === q.get("opening"));
  const filtered = all.filter(match);
  const label = filterLabel(q);
  let session = filtered.filter((p) => p.due <= now).sort((a, b) => a.due - b.due);
  // 絞り込み練習では、期日前の問題も苦手な順に出す
  if (label && session.length < SESSION_SIZE) {
    const rest = filtered.filter((p) => p.due > now).sort((a, b) => b.lapses - a.lapses || a.reps - b.reps);
    session = session.concat(rest);
  }
  session = session.slice(0, SESSION_SIZE);

  if (all.length === 0) {
    root.append(h("h1", {}, "練習"), emptyState("まだ問題がありません。棋譜を取り込むと、AIの解析後にあなたの悪手から問題が作られます。", h("a", { class: "btn primary", href: "#/import" }, "棋譜を取り込む")));
    return;
  }
  if (session.length === 0) {
    root.append(h("h1", {}, "練習"), menu(all, now),
      emptyState(label ? `${label}はありません。` : "今日の復習はすべて終わりました！ 新しい対局を取り込むと問題が増えます。"));
    return;
  }

  // 別解の判定に使うので、AIを先に読み込んでおく
  void db.getSettings().then((st) => engine.load(st.threads)).catch(() => undefined);

  let index = 0;
  let correctCount = 0;
  const container = h("div", {});
  root.append(h("div", { class: "title-row" }, h("h1", {}, label || "今日の練習"), label ? h("a", { class: "link", href: "#/train" }, "絞り込み解除") : ""), container);

  const showProblem = async () => {
    if (index >= session.length) {
      container.replaceChildren(
        h("section", { class: "card hero" },
          h("h2", {}, "お疲れさまでした"),
          h("p", {}, `${session.length}問中 ${correctCount}問 正解`),
          h("div", { class: "row" }, h("a", { class: "btn primary", href: "#/" }, "ホームへ"), h("a", { class: "btn", href: "#/stats" }, "分析を見る"))),
        menu(await db.allProblems(), Date.now()));
      return;
    }
    const p = (await db.getProblem(session[index].id)) ?? session[index];
    const game = await db.getGame(p.gameId);
    const record = Record.newByUSI(`sfen ${p.sfen}`);
    if (record instanceof Error) { index++; return showProblem(); }
    const color = p.side === "black" ? Color.BLACK : Color.WHITE;
    const opp = game ? (p.side === "black" ? game.white : game.black) : "";
    let attempted = false;
    let hintUsed = false;
    let gradedOk: boolean | null = null;

    const board = new BoardView(record.position, {
      flipped: p.side === "white",
      blackName: game?.black, whiteName: game?.white,
      interactive: { color, onMove: (m) => void onMove(m) },
    });
    const feedback = h("div", { class: "feedback" });
    const buttons = h("div", { class: "row" });
    const prompt = p.tags.includes("missedMate")
      ? "詰みがあります。正しい手を指してください。"
      : p.tags.includes("allowedMate")
        ? "ここで実戦は頓死しました。安全な手を指してください。"
        : "実戦ではここで形勢を損ねました。最善手を指してください。";

    container.replaceChildren(
      h("div", { class: "small muted" }, `${index + 1} / ${session.length}`),
      h("div", { class: "tags" },
        ...p.tags.map((t) => h("span", { class: `tag ${t === "missedMate" || t === "allowedMate" || t === "blunder" ? "blunder" : "mistake"}` }, TAG_JA[t])),
        h("span", { class: "tag" }, PHASE_JA[p.phase]),
        p.opening ? h("span", { class: "tag" }, p.opening) : "",
        p.reps > 0 || p.lapses > 0 ? h("span", { class: "tag" }, `復習${p.history.length + 1}回目`) : h("span", { class: "tag new" }, "新しい問題")),
      h("p", { class: "prompt" }, h("b", {}, `${p.side === "black" ? "☗先手" : "☖後手"}番`), "　", prompt),
      board.el,
      feedback,
      buttons,
      game ? h("div", { class: "small muted" }, `出典: vs ${opp}（${fmtDate(game.playedAt)}）${p.ply}手目　`, h("a", { href: `#/game/${game.id}` }, "対局を見る")) : "",
    );

    const ja = (usis: string[], n = 1) => usiToJapanese(p.sfen, usis, n);
    const showAnswer = (ok: boolean, played: string | null, note = "") => {
      const best = p.bestPv[0];
      const myBest = p.bestScore;
      feedback.replaceChildren(
        h("div", { class: `verdict ${ok ? "ok" : "ng"}` }, ok ? "◯ 正解" + note : "✕ 不正解"),
        played && played !== best ? h("div", {}, `あなたの手: ${ja([played])[0] ?? played}`) : "",
        h("div", {}, h("span", { class: "label best" }, "正解"), ` ${ja([best])[0]}（評価 ${scoreText(myBest)}）`,
          p.answers.length > 1 ? h("span", { class: "muted" }, `　ほかに ${p.answers.filter((a) => a !== best).map((a) => ja([a])[0]).join("・")} も可`) : ""),
        h("div", {}, h("span", { class: "label played" }, "実戦"), ` ${ja([p.playedUsi])[0]}`,
          p.playedScore ? `（評価 ${scoreText(p.playedScore)}、勝率 −${Math.round(p.lossWin * 100)}%）` : ""),
        h("div", { class: "pv-moves small" }, "読み筋: " + ja(p.bestPv, 12).join(" ")),
      );
      board.update(record.position, { flipped: p.side === "white", blackName: game?.black, whiteName: game?.white, arrows: [{ usi: best, color: "best" }, { usi: p.playedUsi, color: "played" }] });
      let pvIdx = 0;
      const pvRecord = Record.newByUSI(`sfen ${p.sfen} moves ${p.bestPv.join(" ")}`);
      const stepPv = (d: number) => {
        if (pvRecord instanceof Error) return;
        pvIdx = Math.max(0, Math.min(p.bestPv.length, pvIdx + d));
        pvRecord.goto(pvIdx);
        board.update(pvRecord.position, { flipped: p.side === "white", blackName: game?.black, whiteName: game?.white, lastMoveUsi: pvIdx ? p.bestPv[pvIdx - 1] : null, arrows: p.bestPv[pvIdx] ? [{ usi: p.bestPv[pvIdx], color: "pv" }] : [] });
      };
      buttons.replaceChildren(
        h("button", { class: "btn", onclick: () => stepPv(-1) }, "◀"),
        h("button", { class: "btn", onclick: () => stepPv(1) }, "読み筋 ▶"),
        h("button", { class: "btn primary", onclick: () => { index++; void showProblem(); } }, index + 1 < session.length ? "次の問題" : "終わる"),
      );
      feedback.append(h("button", {
        class: "btn small ask", onclick: () => void askClaude({
          sfen: p.sfen, side: p.side, mine: true,
          playedUsi: p.playedUsi, playedScore: p.playedScore,
          bestPv: p.bestPv, bestScore: p.bestScore, alternatives: p.answers,
          phase: p.phase, opening: p.opening,
          myRating: game ? (p.side === "black" ? game.blackRating : game.whiteRating) : undefined,
          missedMate: p.tags.includes("missedMate"), allowedMate: p.tags.includes("allowedMate"),
        }),
      }, "💬 Claudeに解説してもらう"));
    };

    const record1 = async (ok: boolean) => {
      if (gradedOk !== null) return;
      gradedOk = ok;
      if (ok) correctCount++;
      await db.putProblem(grade(p, ok));
      // 間違えた問題はこのセッションの最後にもう一度
      if (!ok && !session.slice(index + 1).some((s) => s.id === p.id)) session.push(p);
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
      record.goto(0);
      const after = record.position.clone();
      after.doMove(m);
      board.update(after, { flipped: p.side === "white", blackName: game?.black, whiteName: game?.white, lastMoveUsi: usi });
      if (p.answers.includes(usi)) {
        await record1(!hintUsed);
        showAnswer(true, usi, hintUsed ? "（ヒントあり）" : "");
        return;
      }
      const alt = usi === p.playedUsi ? false : await isAlternative(usi);
      if (alt) {
        await record1(!hintUsed);
        showAnswer(true, usi, hintUsed ? "（別解・ヒントあり）" : "（別解）");
      } else {
        await record1(false);
        showAnswer(false, usi);
      }
    };

    buttons.replaceChildren(
      h("button", {
        class: "btn", onclick: () => {
          // ヒント: 動かす駒を示す。ヒントを使った問題は「もう一度」扱い
          hintUsed = true;
          const best = p.bestPv[0];
          const sq = best[1] === "*" ? null : Square.newByUSI(best.slice(0, 2));
          const piece = sq ? record.position.board.at(sq) : null;
          feedback.replaceChildren(h("div", { class: "muted" },
            piece ? `ヒント: ${pieceTypeToStringForMove(piece.type)}を動かします。` : "ヒント: 持ち駒を打つ手です。",
            "（ヒントを使うと、この問題は明日もう一度出ます）"));
        },
      }, "ヒント"),
      h("button", { class: "btn", onclick: async () => { attempted = true; await record1(false); showAnswer(false, null); } }, "答えを見る"),
    );
  };

  await showProblem();
}

function menu(all: Problem[], now: number): HTMLElement {
  const count = (f: (p: Problem) => boolean) => all.filter(f).length;
  const item = (label: string, q: string, n: number) =>
    n ? h("a", { class: "chip", href: `#/train?${q}` }, `${label} ${n}`) : "";
  return h("section", { class: "card" },
    h("h2", {}, "テーマ別に練習"),
    h("div", { class: "chips" },
      item("序盤", "phase=opening", count((p) => p.phase === "opening")),
      item("中盤", "phase=middle", count((p) => p.phase === "middle")),
      item("終盤", "phase=end", count((p) => p.phase === "end")),
      item("詰み逃し", "tag=missedMate", count((p) => p.tags.includes("missedMate"))),
      item("頓死", "tag=allowedMate", count((p) => p.tags.includes("allowedMate"))),
      ...[...new Set(all.map((p) => p.opening).filter(Boolean))].map((o) => item(o, `opening=${encodeURIComponent(o)}`, count((p) => p.opening === o))),
    ),
    h("p", { class: "small muted" }, `問題 全${all.length}問・今日の期日 ${count((p) => p.due <= now)}問`),
  );
}
