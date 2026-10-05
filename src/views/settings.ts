import * as db from "../db";
import { engine } from "../engine";
import { h, toast } from "../ui";

const DEPTHS = [
  { nodes: 150_000, label: "速い（1局 約1〜2分）" },
  { nodes: 300_000, label: "標準（1局 約2〜4分）" },
  { nodes: 800_000, label: "詳しい（1局 約5〜10分）" },
];

export async function settingsView(root: HTMLElement) {
  const s = await db.getSettings();
  const names = h("input", { type: "text", value: s.usernames.join(", "), class: "input" }) as HTMLInputElement;
  const depth = h("select", { class: "input" }, ...DEPTHS.map((d) => h("option", { value: d.nodes }, d.label))) as HTMLSelectElement;
  depth.value = String(DEPTHS.some((d) => d.nodes === s.analysisNodes) ? s.analysisNodes : 300_000);
  const maxThreads = Math.max(1, navigator.hardwareConcurrency || 2);
  const threads = h("select", { class: "input" }, ...Array.from({ length: Math.min(8, maxThreads) }, (_, i) => h("option", { value: i + 1 }, `${i + 1}`))) as HTMLSelectElement;
  threads.value = String(Math.min(s.threads, maxThreads));

  const speedChk = h("input", { type: "checkbox", ...(s.speedMode ? { checked: true } : {}) }) as HTMLInputElement;

  const save = async () => {
    await db.putSettings({
      usernames: names.value.split(/[,、\s]+/).map((x) => x.trim()).filter(Boolean),
      analysisNodes: Number(depth.value),
      threads: Number(threads.value),
      speedMode: speedChk.checked,
    });
    toast("保存しました（スレッド数はアプリの再起動後に反映）");
  };

  const engineInfo = h("div", { class: "small muted" });
  const drawEngine = () => {
    const st = { idle: "未読み込み", loading: `読み込み中 ${Math.round(engine.progress * 100)}%`, ready: "準備完了", error: "エラー: " + engine.error }[engine.state];
    engineInfo.textContent = `AI（やねうら王＋水匠5）: ${st}${engine.supported ? "" : "（このブラウザは非対応の可能性）"}`;
  };
  drawEngine();
  const off = engine.onChange(drawEngine);

  const fileInput = h("input", { type: "file", accept: "application/json,.json", class: "hidden" }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const r = await db.importAll(await f.text());
      toast(`復元しました（対局${r.games}・問題${r.problems}）`);
    } catch (e) {
      toast("復元できませんでした: " + (e as Error).message);
    }
  });

  root.append(
    h("h1", {}, "設定"),
    h("section", { class: "card" },
      h("label", { class: "field" }, h("span", {}, "あなたのユーザー名（カンマ区切り）"), names,
        h("small", { class: "muted" }, "ウォーズ・クエストの名前。棋譜の先後を自動で判定します。")),
      h("label", { class: "field" }, h("span", {}, "解析の深さ"), depth),
      h("label", { class: "check field" }, speedChk, h("span", {}, "早指しモード（練習に制限時間：1問30秒・詰将棋60秒）")),
      h("label", { class: "field" }, h("span", {}, "AIのスレッド数"), threads,
        h("small", { class: "muted" }, "多いほど速いですが、スマホが熱くなりやすくなります。")),
      h("button", { class: "btn primary", onclick: () => void save() }, "保存"),
    ),
    h("section", { class: "card" },
      h("h2", {}, "AI"),
      engineInfo,
      h("button", { class: "btn", onclick: () => void engine.load(s.threads).catch(() => undefined) }, "AIを今すぐ読み込む"),
      h("p", { class: "small muted" }, "初回のみ約30MBをダウンロードします（Wi-Fi推奨）。2回目以降は端末に保存されたものを使います。"),
    ),
    h("section", { class: "card" },
      h("h2", {}, "バックアップ"),
      h("p", { class: "small muted" }, "データはこの端末の中だけに保存されています。機種変更の前や、念のため定期的にバックアップしてください。"),
      h("div", { class: "row wrap" },
        h("button", {
          class: "btn", onclick: async () => {
            const blob = new Blob([await db.exportAll()], { type: "application/json" });
            const a = h("a", { href: URL.createObjectURL(blob), download: `shogi-trainer-${new Date().toISOString().slice(0, 10)}.json` });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
          },
        }, "バックアップを保存"),
        h("button", { class: "btn", onclick: () => fileInput.click() }, "バックアップから復元"),
        fileInput,
      ),
    ),
    h("section", { class: "card small muted" },
      h("h2", {}, "このアプリについて"),
      h("p", {}, "将棋AI: やねうら王（GPLv3）と評価関数 水匠5 を、Mizar氏の WebAssembly版 で動かしています。"),
      h("p", {}, h("a", { href: "https://github.com/yaneurao/YaneuraOu", target: "_blank", rel: "noopener" }, "やねうら王 ソースコード"), "　",
        h("a", { href: "https://github.com/mizar/YaneuraOu.wasm", target: "_blank", rel: "noopener" }, "WebAssembly版 ソースコード"), "　",
        h("a", { href: "engine/LICENSE.md", target: "_blank" }, "ライセンス")),
      h("p", {}, "棋譜の読み込み: tsshogi（MIT License）"),
    ),
  );
  return off;
}
