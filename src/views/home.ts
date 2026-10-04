import * as db from "../db";
import { onGameAnalyzed } from "../jobs";
import { computeStats, findWeaknesses } from "../stats";
import { h } from "../ui";
import { gameRow } from "./common";

export async function homeView(root: HTMLElement) {
  const draw = async () => {
    const [games, problems] = await Promise.all([db.allGames(), db.allProblems()]);
    const stats = computeStats(games, problems);
    const weak = findWeaknesses(stats).slice(0, 3);
    const now = Date.now();
    const due = problems.filter((p) => p.due <= now);
    const fresh = due.filter((p) => p.reps === 0 && p.history.length === 0).length;

    root.replaceChildren(
      h("h1", {}, "将棋トレーナー"),
      h("section", { class: "card hero" },
        h("h2", {}, "今日の練習"),
        problems.length === 0
          ? h("p", {}, "対局後に棋譜を取り込むと、AIが解析して、あなたの悪手から問題を作ります。")
          : h("p", {}, due.length ? `復習 ${due.length - fresh}問・新しい問題 ${fresh}問` : "今日の復習はすべて終わりました。"),
        h("div", { class: "row" },
          due.length ? h("a", { class: "btn primary", href: "#/train" }, "練習を始める") : "",
          h("a", { class: "btn" + (due.length ? "" : " primary"), href: "#/import" }, "棋譜を取り込む"),
        ),
      ),
      weak.length
        ? h("section", { class: "card" },
          h("h2", {}, "いまの弱点"),
          ...weak.map((w, i) => h("div", { class: "weak" },
            h("div", { class: "weak-title" }, `${i + 1}. ${w.title}`),
            h("div", { class: "small muted" }, w.detail),
            h("div", { class: "small" }, w.advice),
            w.train ? h("a", { class: "btn small", href: `#/train?${w.train}` }, "この弱点を練習") : "",
          )),
          h("a", { class: "link", href: "#/stats" }, "詳しい分析を見る →"))
        : "",
      games.length
        ? h("section", { class: "card" },
          h("h2", {}, "最近の対局"),
          ...games.slice(0, 5).map(gameRow),
          h("a", { class: "link", href: "#/games" }, "すべての対局 →"))
        : "",
    );
  };
  await draw();
  return onGameAnalyzed(() => void draw());
}
