// 定跡ツリー画面: 自分の対局を局面ごとにたどり、勝率・AI評価・外れた手を見る。
import { Record } from "tsshogi";
import { usiToJapanese } from "../analysis";
import { BoardView, type Arrow } from "../board";
import { buildBook, edgeMark, positionKey, type BookNode, type BookTree } from "../book";
import * as db from "../db";
import { BOOK_MAX_PLY } from "../analysis";
import { negate, scoreText } from "../score";
import type { Game, Side } from "../types";
import { h, pct } from "../ui";
import { emptyState } from "./common";

// 角交換四間飛車から向かい飛車などに振り直す対局も含める
const isMain = (g: Game) => !!g.strategy?.myOpening.startsWith("角交換");
const MAIN_LABEL = "角交換系のみ";

export async function bookView(root: HTMLElement, _args: string[], q: URLSearchParams) {
  const games = (await db.allGames()).filter((g) => g.analysisDone);
  if (!games.length) {
    root.append(h("h1", {}, "定跡ツリー"), emptyState("解析済みの対局がありません。棋譜を取り込むと、ここに自分の定跡ツリーができます。", h("a", { class: "btn primary", href: "#/import" }, "棋譜を取り込む")));
    return;
  }
  const countSide = (s: Side) => games.filter((g) => g.mySide === s).length;
  let side: Side = (q.get("side") as Side) || (countSide("white") > countSide("black") ? "white" : "black");
  const hasMain = games.some((g) => isMain(g));
  let onlyMain = q.get("all") !== "1" && hasMain;
  let path: string[] = (q.get("path") ?? "").split(",").filter(Boolean);

  let tree: BookTree;
  const rebuild = () => {
    const src: Game[] = onlyMain ? games.filter((g) => isMain(g)) : games;
    tree = buildBook(src, side);
  };
  rebuild();

  const controls = h("div", {});
  const lists = h("div", {});
  const explorer = h("section", { class: "card" });
  root.append(h("h1", {}, "定跡ツリー"), controls, lists, explorer);

  const sfenOf = (p: string[]): string | null => {
    const r = Record.newByUSI(`startpos${p.length ? " moves " + p.join(" ") : ""}`);
    if (r instanceof Error) return null;
    r.goto(r.length);
    return r.position.sfen;
  };
  const nodeOfPath = (p: string[]): BookNode | undefined => {
    const s = sfenOf(p);
    return s ? tree.nodes.get(positionKey(s)) : undefined;
  };
  const go = (p: string[]) => { path = p; drawExplorer(); explorer.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const ja1 = (sfen: string, usi: string) => usiToJapanese(sfen, [usi])[0] ?? usi;

  const drawControls = () => {
    const seg = (label: string, active: boolean, onclick: () => void) => h("button", { class: "seg" + (active ? " active" : ""), onclick }, label);
    controls.replaceChildren(
      h("div", { class: "segs" },
        seg(`☗先手の対局 ${countSide("black")}`, side === "black", () => { side = "black"; path = []; rebuild(); drawAll(); }),
        seg(`☖後手の対局 ${countSide("white")}`, side === "white", () => { side = "white"; path = []; rebuild(); drawAll(); })),
      hasMain ? h("div", { class: "segs" },
        seg(MAIN_LABEL, onlyMain, () => { onlyMain = true; path = []; rebuild(); drawAll(); }),
        seg("すべての戦型", !onlyMain, () => { onlyMain = false; path = []; rebuild(); drawAll(); })) : "",
      h("p", { class: "small muted" }, `${tree.games}局をまとめています（${BOOK_MAX_PLY}手目まで）。`),
    );
  };

  const drawLists = () => {
    const devs = tree.deviations.slice(0, 5);
    const weak = tree.weakBranches.slice(0, 5);
    lists.replaceChildren(
      h("section", { class: "card" },
        h("h2", {}, "定跡（AI推奨）から外れた局面"),
        devs.length
          ? h("div", {}, ...devs.map((d) => {
            const n = tree.nodes.get(d.nodeKey)!;
            return h("button", { class: "list-btn", onclick: () => go(n.path) },
              h("div", {}, h("b", {}, `${n.ply + 1}手目 `), "実戦 ", h("span", { class: "bad" }, ja1(n.sfen, d.usi)),
                d.aiBest ? [" → AI ", h("span", { class: "good" }, ja1(n.sfen, d.aiBest))] : ""),
              h("div", { class: "small muted" }, `${d.count}回（うち負け${d.lost}）・平均 勝率−${pct(d.avgLoss)}`));
          }))
          : h("p", { class: "small muted" }, "序盤はAIの推奨どおりに指せています。"),
        h("p", { class: "small muted" }, "各対局で、序盤に初めて勝率を3%以上損した手を集計しています。"),
      ),
      h("section", { class: "card" },
        h("h2", {}, "負けが多い分岐"),
        weak.length
          ? h("div", {}, ...weak.map((w) => {
            const n = tree.nodes.get(w.nodeKey)!;
            return h("button", { class: "list-btn", onclick: () => go([...n.path, w.usi]) },
              h("div", {}, h("b", {}, `${n.ply + 1}手目 `), ja1(n.sfen, w.usi), w.mine ? h("span", { class: "tag mine" }, "あなた") : h("span", { class: "tag" }, "相手")),
              h("div", { class: "small muted" }, `${w.wins}勝${w.losses}敗`));
          }))
          : h("p", { class: "small muted" }, "2局以上で負け越している分岐はまだありません。"),
      ),
    );
  };

  const drawExplorer = () => {
    const node = nodeOfPath(path);
    const crumbs = usiToJapanese(sfenOf([])!, path);
    const head = h("div", {},
      h("h2", {}, "ツリーをたどる"),
      h("div", { class: "crumbs small" }, crumbs.length ? crumbs.join(" ") : "初期局面"),
      h("div", { class: "row" },
        h("button", { class: "btn small", onclick: () => go([]) }, "最初から"),
        h("button", { class: "btn small", onclick: () => go(path.slice(0, -1)), ...(path.length ? {} : { disabled: true }) }, "1手戻る"),
        h("a", { class: "btn small primary", href: `#/train?line=1&side=${side}&path=${path.join(",")}` }, "ここから手順ドリル")));
    if (!node) {
      explorer.replaceChildren(head, h("p", { class: "muted" }, "この局面はあなたの対局（この絞り込み）にありません。"));
      return;
    }
    const pos = Record.newByUSI(`sfen ${node.sfen}`);
    const arrows: Arrow[] = node.aiBest ? [{ usi: node.aiBest, color: "best" }] : [];
    const board = new BoardView(pos instanceof Error ? (Record.newByUSI("startpos") as Record).position : pos.position, {
      flipped: side === "white", lastMoveUsi: path[path.length - 1] ?? null, arrows,
    });
    const edges = [...node.edges.values()].sort((a, b) => b.count - a.count);
    const aiPlayed = node.aiBest && node.edges.has(node.aiBest);
    explorer.replaceChildren(
      head,
      board.el,
      h("div", { class: "eval-row" },
        h("span", {}, `${node.myTurn ? "あなた" : "相手"}の手番`),
        h("b", {}, `${node.count}局 ${node.wins}勝${node.losses}敗`),
        node.aiScore ? h("span", { class: "muted" }, `評価値 ${scoreText(node.myTurn ? node.aiScore : negate(node.aiScore))}（あなたから見て）`) : ""),
      node.aiBest ? h("div", { class: "small" }, h("span", { class: "label best" }, "AI推奨"), ` ${ja1(node.sfen, node.aiBest)}`, aiPlayed ? "" : h("span", { class: "muted" }, node.myTurn ? "（まだ指したことがない手）" : "（この手を指された対局はまだありません）")) : "",
      edges.length
        ? h("table", { class: "table book-table" },
          h("thead", {}, h("tr", {}, h("th", {}, "次の手"), h("th", {}, "回数"), h("th", {}, "成績"), h("th", {}, "AI"))),
          h("tbody", {}, ...edges.map((e) => {
            const m = edgeMark(e);
            const wr = e.wins + e.losses ? e.wins / (e.wins + e.losses) : null;
            return h("tr", { class: "clickable", onclick: () => go([...path, e.usi]) },
              h("td", {}, ja1(node.sfen, e.usi), e.usi === node.aiBest ? h("span", { class: "tag k-book" }, "推奨") : ""),
              h("td", {}, String(e.count)),
              h("td", {}, `${e.wins}勝${e.losses}敗`, wr != null ? h("div", { class: "hbar" }, h("div", { class: "hbar-fill " + (wr >= 0.5 ? "good-bg" : "bad-bg"), style: `width:${Math.round(wr * 100)}%` })) : ""),
              h("td", {}, m ? h("b", { class: m.cls }, m.mark) : ""));
          })))
        : h("p", { class: "small muted" }, `この先は記録がありません（${BOOK_MAX_PLY}手目まで集計）。`),
      h("p", { class: "small muted" }, "AI列: ✓ AI推奨とほぼ同じ / △ 少し損 / ✕ 損（自分の手のみ）。行をタップすると進みます。"),
    );
  };

  const drawAll = () => { drawControls(); drawLists(); drawExplorer(); };
  drawAll();
}
