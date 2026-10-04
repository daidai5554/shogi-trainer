import * as db from "../db";
import { onGameAnalyzed, onJobChange } from "../jobs";
import { h } from "../ui";
import { emptyState, gameRow } from "./common";

export async function gamesView(root: HTMLElement) {
  const list = h("div", { class: "list" });
  const filter = h("select", { class: "filter" }) as HTMLSelectElement;
  root.append(
    h("div", { class: "title-row" }, h("h1", {}, "棋譜"), h("a", { class: "btn primary", href: "#/import" }, "＋ 取り込む")),
    filter,
    list,
  );
  let selected = "";
  filter.addEventListener("change", () => { selected = filter.value; void draw(); });

  const draw = async () => {
    const games = await db.allGames();
    const labels = [...new Set(games.map((g) => g.strategy?.label).filter(Boolean))] as string[];
    filter.replaceChildren(
      h("option", { value: "" }, `すべての対局（${games.length}）`),
      h("option", { value: "lose" }, "負けた対局のみ"),
      ...labels.map((l) => h("option", { value: "L:" + l }, l)),
    );
    filter.value = selected;
    const shown = games.filter((g) => !selected || (selected === "lose" ? g.result === "lose" : g.strategy?.label === selected.slice(2)));
    list.replaceChildren(...(shown.length ? shown.map(gameRow) : [emptyState("まだ対局がありません。", h("a", { class: "btn primary", href: "#/import" }, "棋譜を取り込む"))]));
  };
  await draw();
  const off1 = onGameAnalyzed(() => void draw());
  const off2 = onJobChange(() => undefined);
  return () => { off1(); off2(); };
}
