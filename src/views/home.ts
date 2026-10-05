import * as db from "../db";
import { onGameAnalyzed } from "../jobs";
import { summarize } from "../session";
import { PHASE_JA, computeStats, currentFocus, findWeaknesses } from "../stats";
import { h } from "../ui";
import { gameRow } from "./common";
import { pickDrillSide } from "./linedrill";

export async function homeView(root: HTMLElement) {
  const draw = async () => {
    const [games, problems] = await Promise.all([db.allGames(), db.allProblems()]);
    const stats = computeStats(games, problems);
    const weak = findWeaknesses(stats).slice(0, 3);
    const drillSide = await pickDrillSide();
    const lineDone = (await db.getKV<string>("lineDrillDate")) === db.dateKey();
    const focus = currentFocus(games, problems);
    const sum = summarize(problems, drillSide, lineDone, Date.now(), focus);
    const parts = [
      sum.line || sum.book ? `定跡${sum.line + sum.book}` : "",
      sum.mistake ? `復習${sum.mistake}` : "",
      sum.punish ? `咎め${sum.punish}` : "",
      sum.tsume ? `詰将棋${sum.tsume}` : "",
    ].filter(Boolean).join("・");

    const st = db.streak(await db.getActivity());
    const lastBackup = (await db.getKV<number>("lastBackupAt")) ?? 0;
    const needBackup = games.length >= 5 && Date.now() - lastBackup > 14 * 86_400_000;
    root.replaceChildren(
      h("div", { class: "title-row" }, h("h1", {}, "将棋トレーナー"),
        st.days ? h("span", { class: "streak" + (st.today ? " done" : "") }, `連続${st.days}日`) : ""),
      h("section", { class: "card hero" },
        h("h2", {}, "今日のトレーニング"),
        problems.length === 0
          ? h("p", {}, "対局後に棋譜を取り込むと、AIが解析して、あなたの対局から問題（定跡確認・悪手の復習・詰将棋）を作ります。")
          : sum.total
            ? h("p", {}, `${parts}（${sum.total}問・約${Math.max(3, Math.round(sum.total * 0.7))}分）`,
              h("br"), h("small", { class: "muted" }, focus ? `いまの弱点（${PHASE_JA[focus]}）を多めに出します。` : "対局前のウォーミングアップにもどうぞ。"),
              sum.remainingAfter ? h("small", { class: "muted" }, `終わったあと、あと${sum.remainingAfter}問あります。`) : "")
            : h("p", {}, "今日の分は終わりました。対局を取り込むと新しい問題が増えます。"),
        h("div", { class: "row" },
          sum.total
            ? h("a", { class: "btn primary big", href: "#/train" }, "▶ 今日のトレーニング")
            : problems.length ? h("a", { class: "btn", href: "#/train?more=1" }, "おかわり（苦手な問題）") : "",
        ),
        h("div", { class: "row" }, h("a", { class: "btn" + (problems.length ? "" : " primary"), href: "#/import" }, "棋譜を取り込む")),
      ),
      needBackup
        ? h("section", { class: "card warn-card" },
          h("div", { class: "small" }, lastBackup ? "最後のバックアップから2週間以上たちました。" : "まだバックアップがありません。"),
          h("div", { class: "small muted" }, "データはこの端末の中だけにあります。機種変更や故障に備えて保存しておきましょう。"),
          h("a", { class: "btn small", href: "#/settings" }, "設定でバックアップ"))
        : "",
      h("a", { class: "card guide-link", href: "#/guide" }, h("b", {}, "上達ガイド"), h("span", { class: "small muted" }, " このアプリでの練習の進め方 →")),
      weak.length
        ? h("section", { class: "card" },
          h("h2", {}, "いまの弱点"),
          ...weak.map((w, i) => h("div", { class: "weak" },
            h("div", { class: "weak-title" }, `${i + 1}. ${w.title}`),
            h("div", { class: "small muted" }, w.detail),
            h("div", { class: "small" }, w.advice))),
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
