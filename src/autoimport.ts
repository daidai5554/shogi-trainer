// 棋譜の保存と、アプリを開いたときのクリップボードからの自動取り込み。
// ウォーズ／クエストで棋譜をコピーしてからアプリを開くと、新しい対局なら自動で取り込んで解析を始める。
import * as db from "./db";
import { enqueue } from "./jobs";
import { importGame, opposite, toResult } from "./kifu";
import type { Game } from "./types";
import { h } from "./ui";

/** 取り込んだ対局を保存して解析を予約する。side が自動判定と違えば先後と勝敗を入れ替える */
export async function storeGame(game: Game, side: Game["mySide"], remember = false): Promise<void> {
  if (remember) {
    // 選んだ名前を覚えて、次回から自動で先後を判定する
    const name = side === "black" ? game.black : game.white;
    const st = await db.getSettings();
    if (name && !st.usernames.includes(name)) await db.putSettings({ ...st, usernames: [...st.usernames, name] });
  }
  if (side !== game.mySide) {
    const winner = game.result === "win" ? game.mySide : game.result === "lose" ? opposite(game.mySide) : game.result === "draw" ? "draw" : null;
    game.mySide = side;
    game.result = toResult(winner, side);
  }
  await db.putGame(game);
  enqueue(game.id, true);
}

export type ClipboardPermission = "granted" | "prompt" | "denied" | "unsupported";

export async function clipboardPermission(): Promise<ClipboardPermission> {
  try {
    if (!navigator.clipboard?.readText || !navigator.permissions?.query) return "unsupported";
    const r = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
    return r.state;
  } catch {
    return "unsupported";
  }
}

/** 棋譜らしい文章か(関係ない文章を毎回解析しないための簡単な確認) */
function looksLikeKifu(text: string): boolean {
  if (text.length < 40 || text.length > 300_000) return false;
  return /手数|先手|後手|▲|△|開始日時|^PI|^P1|^[+-]\d{4}[A-Z]{2}/m.test(text);
}

function textKey(text: string): string {
  let x = 0;
  for (let i = 0; i < text.length; i++) x = (x * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${x}`;
}

let running = false;

/**
 * クリップボードを確認して、新しい棋譜なら取り込む。
 * 許可が済んでいるときだけ読む(許可の確認画面を勝手に出さない)。同じ内容は2回確認しない。
 */
export async function checkClipboard(): Promise<void> {
  if (running || document.visibilityState !== "visible" || !document.hasFocus()) return;
  running = true;
  try {
    const settings = await db.getSettings();
    if (settings.autoClipboard === false) return;
    if ((await clipboardPermission()) !== "granted") return;
    let text: string;
    try { text = await navigator.clipboard.readText(); } catch { return; }
    if (!looksLikeKifu(text)) return;
    const key = textKey(text);
    if ((await db.getKV<string>("lastClipboardKey")) === key) return;
    await db.putKV("lastClipboardKey", key);

    let parsed;
    try { parsed = importGame(text, settings.usernames); } catch { return; }
    const { game, mySideKnown } = parsed;
    if (game.usiMoves.length < 10) return;
    if (await db.getGame(game.id)) return; // 取り込み済み
    if (!mySideKnown) {
      // どちらが自分か分からないときは、取り込み画面で選んでもらう
      sessionStorage.setItem("sharedKifu", text);
      location.hash = "#/import";
      return;
    }
    await storeGame(game, game.mySide);
    const opp = game.mySide === "black" ? game.white : game.black;
    const t = h("a", { class: "toast show link-toast", href: `#/game/${game.id}` }, `コピーした棋譜（vs ${opp}）を取り込みました。AIが解析を始めます　見る →`);
    document.body.append(t);
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 6000);
    if (location.hash === "" || location.hash === "#/" || location.hash.startsWith("#/games")) window.dispatchEvent(new HashChangeEvent("hashchange"));
  } finally {
    running = false;
  }
}

/** アプリを開いたとき・アプリに戻ってきたときに確認する */
export function setupAutoImport() {
  window.addEventListener("focus", () => void checkClipboard());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") setTimeout(() => void checkClipboard(), 300);
  });
  setTimeout(() => void checkClipboard(), 800);
}
