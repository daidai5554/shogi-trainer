import * as db from "../db";
import { enqueue } from "../jobs";
import { importGame, opposite, toResult } from "../kifu";
import type { Game } from "../types";
import { h, toast } from "../ui";

export async function importView(root: HTMLElement) {
  const settings = await db.getSettings();
  const ta = h("textarea", { class: "kifu-input", placeholder: "ここに棋譜を貼り付け（ウォーズ・クエストの「棋譜コピー」の内容）", rows: 8 }) as HTMLTextAreaElement;
  const shared = sessionStorage.getItem("sharedKifu");
  if (shared) { ta.value = shared; sessionStorage.removeItem("sharedKifu"); }
  const msg = h("div", { class: "import-msg" });

  const doImport = async (text: string) => {
    msg.replaceChildren();
    let parsed;
    try {
      parsed = importGame(text, settings.usernames);
    } catch (e) {
      msg.append(h("p", { class: "error" }, String((e as Error).message)));
      return;
    }
    const { game, mySideKnown } = parsed;
    const exists = await db.getGame(game.id);
    if (exists) {
      msg.append(h("p", {}, "この対局はすでに取り込み済みです。"), h("a", { class: "btn", href: `#/game/${game.id}` }, "対局を開く"));
      return;
    }
    if (!mySideKnown) {
      msg.append(
        h("p", {}, "どちらがあなたですか？（選んだ名前を覚えて、次からは自動で判定します）"),
        h("div", { class: "row" },
          h("button", { class: "btn", onclick: () => void save(game, "black", true) }, `☗ ${game.black}`),
          h("button", { class: "btn", onclick: () => void save(game, "white", true) }, `☖ ${game.white}`),
        ),
      );
      return;
    }
    await save(game, game.mySide);
  };

  const save = async (game: Game, side: Game["mySide"], remember = false) => {
    if (remember) {
      // 選んだ名前を覚えて、次回から自動で先後を判定する
      const name = side === "black" ? game.black : game.white;
      const st = await db.getSettings();
      if (name && !st.usernames.includes(name)) await db.putSettings({ ...st, usernames: [...st.usernames, name] });
    }
    if (side !== game.mySide) {
      // 先後を入れ替えたら勝敗も入れ替える
      const winner = game.result === "win" ? game.mySide : game.result === "lose" ? opposite(game.mySide) : game.result === "draw" ? "draw" : null;
      game.mySide = side;
      game.result = toResult(winner, side);
    }
    await db.putGame(game);
    enqueue(game.id, true);
    toast("取り込みました。AIが解析を始めます");
    location.hash = `#/game/${game.id}`;
  };

  const pasteBtn = h("button", { class: "btn primary big" }, "クリップボードから取り込む");
  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast("クリップボードが空です"); return; }
      ta.value = text;
      await doImport(text);
    } catch {
      toast("クリップボードを読めませんでした。下の欄に貼り付けてください");
      ta.focus();
    }
  });

  root.append(
    h("h1", {}, "棋譜を取り込む"),
    h("section", { class: "card" },
      h("ol", { class: "steps" },
        h("li", {}, "ウォーズ／クエストで対局後、棋譜をコピー"),
        h("li", {}, "このボタンを押す（初回はクリップボードの許可が必要）"),
      ),
      pasteBtn,
      msg,
    ),
    h("section", { class: "card" },
      h("h2", {}, "手動で貼り付け"),
      ta,
      h("button", { class: "btn", onclick: () => void doImport(ta.value) }, "この棋譜を取り込む"),
    ),
  );
  if (shared) void doImport(ta.value);
}
