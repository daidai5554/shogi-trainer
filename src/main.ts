import "./style.css";
import { engine } from "./engine";
import { jobStatus, onGameAnalyzed, onJobChange, resumePending } from "./jobs";
import { h } from "./ui";
import { requestPersistence } from "./db";
import { homeView } from "./views/home";
import { importView } from "./views/import";
import { gamesView } from "./views/games";
import { gameView } from "./views/game";
import { trainView } from "./views/train";
import { statsView } from "./views/stats";
import { settingsView } from "./views/settings";
import { bookView } from "./views/book";
import { playView } from "./views/play";
import { guideView } from "./views/guide";

export type View = (root: HTMLElement, args: string[], query: URLSearchParams) => void | (() => void) | Promise<void | (() => void)>;

const routes: { [k: string]: { view: View; tab: string } } = {
  "": { view: homeView, tab: "home" },
  import: { view: importView, tab: "games" },
  games: { view: gamesView, tab: "games" },
  game: { view: gameView, tab: "games" },
  book: { view: bookView, tab: "book" },
  play: { view: playView, tab: "train" },
  guide: { view: guideView, tab: "home" },
  train: { view: trainView, tab: "train" },
  stats: { view: statsView, tab: "stats" },
  settings: { view: settingsView, tab: "settings" },
};

const TABS = [
  { id: "home", href: "#/", icon: "⌂", label: "ホーム" },
  { id: "games", href: "#/games", icon: "☗", label: "棋譜" },
  { id: "book", href: "#/book", icon: "⋔", label: "定跡" },
  { id: "train", href: "#/train", icon: "✎", label: "練習" },
  { id: "stats", href: "#/stats", icon: "▤", label: "分析" },
  { id: "settings", href: "#/settings", icon: "⚙", label: "設定" },
];

const app = document.getElementById("app")!;
const banner = h("div", { class: "job-banner hidden" });
const main = h("main", { class: "view" });
const nav = h("nav", { class: "tabbar" });
app.append(banner, main, nav);

let cleanup: (() => void) | void = undefined;
let renderSeq = 0;

async function render() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const route = routes[parts[0] ?? ""] ?? routes[""];
  const seq = ++renderSeq;
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  main.replaceChildren();
  window.scrollTo(0, 0);
  nav.replaceChildren(...TABS.map((t) =>
    h("a", { href: t.href, class: "tab" + (t.id === route.tab ? " active" : "") }, h("span", { class: "tab-icon" }, t.icon), h("span", {}, t.label))));
  const c = await route.view(main, parts.slice(1), new URLSearchParams(qs ?? ""));
  if (seq === renderSeq) cleanup = c;
  else if (typeof c === "function") c();
}

function renderBanner() {
  const s = jobStatus();
  const loading = engine.state === "loading";
  if (!s.gameId && !loading) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  let text: string;
  let ratio: number;
  if (loading) {
    text = `AIを準備中… ${Math.round(engine.progress * 100)}%（初回のみ約30MBをダウンロード）`;
    ratio = engine.progress;
  } else {
    text = `${s.label} ${s.done}/${s.total}` + (s.queued ? `（あと${s.queued}局）` : "");
    ratio = s.total ? s.done / s.total : 0;
  }
  banner.replaceChildren(h("span", {}, text), h("div", { class: "bar" }, h("div", { class: "fill", style: `width:${Math.round(ratio * 100)}%` })));
}

onJobChange(renderBanner);

// 解析が終わったら結果をお知らせ(タップで対局へ)
onGameAnalyzed((g, fresh) => {
  if (!fresh) return;
  const mine = (g.verdicts ?? []).filter((v) => v.side === g.mySide);
  const bad = mine.filter((v) => v.kind === "blunder").length;
  const dub = mine.filter((v) => v.kind === "mistake").length;
  const mates = mine.filter((v) => v.missedMate).length;
  const opp = g.mySide === "black" ? g.white : g.black;
  const t = h("a", { class: "toast show link-toast", href: `#/game/${g.id}` },
    `vs ${opp} の解析が完了：悪手${bad}・疑問手${dub}${mates ? `・詰み逃し${mates}` : ""}　見る →`);
  document.body.append(t);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 6000);
});
engine.onChange(renderBanner);
window.addEventListener("hashchange", render);

// Android の共有メニューから棋譜を受け取った場合
const sp = new URLSearchParams(location.search);
const shared = sp.get("text") || sp.get("title") || sp.get("url");
if (shared) {
  sessionStorage.setItem("sharedKifu", shared);
  history.replaceState(null, "", location.pathname + "#/import");
}

async function setupServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.register("./sw.js");
  // SharedArrayBuffer を使うため、Service Worker が付けるヘッダーが効くよう一度だけ再読み込みする
  if (!self.crossOriginIsolated) {
    if (sessionStorage.getItem("coiReloaded")) return;
    const reload = () => { sessionStorage.setItem("coiReloaded", "1"); location.reload(); };
    if (navigator.serviceWorker.controller) reload();
    else navigator.serviceWorker.addEventListener("controllerchange", reload);
  } else {
    sessionStorage.removeItem("coiReloaded");
  }
  reg.update().catch(() => undefined);
}

void setupServiceWorker();
void requestPersistence();
void render();
void resumePending();
