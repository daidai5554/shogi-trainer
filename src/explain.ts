// 「Claudeに質問」: 局面とAI解析をまとめた質問文を作り、コピーしてClaudeアプリを開く。
// API は使わず、ユーザーが自分のClaudeアプリに貼り付ける。
import { Record, exportBOD } from "tsshogi";
import { usiToJapanese } from "./analysis";
import { scoreText } from "./score";
import { PHASE_JA } from "./stats";
import type { Phase, Score, Side } from "./types";
import { h, toast } from "./ui";

export interface ExplainInput {
  sfen: string; // 問題の局面(悪手を指す前)
  side: Side; // この局面で指す側
  mine: boolean; // 指したのが自分か
  playedUsi: string;
  playedScore: Score | null; // 指した側から見た、指した後の評価
  bestPv: string[];
  bestScore: Score; // 指した側から見た評価
  alternatives?: string[]; // 最善手以外の正解手(USI)
  phase?: Phase;
  opening?: string;
  myRating?: string;
  missedMate?: boolean;
  allowedMate?: boolean;
  /** 相手の悪手のとき: 次に自分が指すべき手順(悪手の後の局面から) */
  punishPv?: string[];
  punishScore?: Score; // 自分から見た評価
}

function bod(sfen: string, moves: string[] = []): string {
  const r = Record.newByUSI(`sfen ${sfen}${moves.length ? " moves " + moves.join(" ") : ""}`);
  if (r instanceof Error) return sfen;
  r.goto(r.length);
  // 末尾の「手数＝」行は紛らわしいので除く
  return exportBOD(r).split(/\r?\n/).filter((l) => !l.startsWith("手数＝")).join("\n").trim();
}

export function buildPrompt(x: ExplainInput): string {
  const ja = (usis: string[], n = 1) => usiToJapanese(x.sfen, usis, n);
  const sideJa = x.side === "black" ? "☗先手" : "☖後手";
  const who = x.mine ? `${sideJa}（私）` : `${sideJa}（相手）`;
  const played = ja([x.playedUsi])[0] ?? x.playedUsi;
  const best = ja(x.bestPv)[0] ?? x.bestPv[0];
  const lines: string[] = [];

  const level = !x.myRating ? "初段〜二段くらい"
    : /^\d+$/.test(x.myRating) ? `将棋クエストのレート${x.myRating}くらい` : `将棋ウォーズ${x.myRating}くらい`;
  lines.push(`あなたは将棋の指導者です。私は${level}で、主に角交換四間飛車を指しています。`);
  lines.push("以下は私の対局の局面と、将棋AI（やねうら王＋水匠5）の解析結果です。AIの解析結果を根拠にして、言葉で解説してください。");
  lines.push("");
  lines.push("【局面】（この局面から次の手を指す）");
  lines.push(bod(x.sfen));
  lines.push("");
  lines.push(`【手番】${who}`);
  const ctx = [x.opening, x.phase ? PHASE_JA[x.phase] : ""].filter(Boolean).join("・");
  if (ctx) lines.push(`【戦型・局面】${ctx}`);
  lines.push(`【実戦の手】${played}${x.playedScore ? `（指した後の評価値 ${scoreText(x.playedScore)}、${who}から見た値）` : ""}`);
  lines.push(`【AIの最善手】${best}（評価値 ${scoreText(x.bestScore)}）`);
  lines.push(`【AIの読み筋】${ja(x.bestPv, 12).join(" ")}`);
  const alts = (x.alternatives ?? []).filter((a) => a !== x.bestPv[0]);
  if (alts.length) lines.push(`【ほぼ同じくらい良い手】${alts.map((a) => ja([a])[0]).join("・")}`);
  if (x.punishPv?.length) {
    const after = usiToJapanese(x.sfen, [x.playedUsi, ...x.punishPv], 13).slice(1);
    lines.push(`【実戦の手の後、私の最善の応手】${after.join(" ")}${x.punishScore ? `（私から見た評価値 ${scoreText(x.punishScore)}）` : ""}`);
  }
  if (x.missedMate) lines.push("※ この局面には詰みがありましたが、実戦では見逃しました。");
  if (x.allowedMate) lines.push("※ 実戦の手で、相手に詰みが生じました（頓死）。");
  lines.push("");
  lines.push("【お願い】");
  if (x.mine) {
    if (x.missedMate) {
      lines.push("1. 詰み手順を1手ずつ、なぜその手なのか（玉の逃げ道・捨て駒の意味）を説明してください");
      lines.push("2. 実戦で詰みに気づくための着眼点を教えてください");
    } else {
      lines.push("1. 実戦の手の何がまずかったのか（相手のどんな狙いが通ってしまうか）を具体的に");
      lines.push("2. 最善手の意味と、その後どういう方針で指せばよいか");
    }
    lines.push("3. 似た局面で使える考え方・手筋・格言を1つ");
  } else {
    lines.push("1. 相手の手のどこが悪かったのか");
    lines.push("2. 私はどう咎めればよかったか（上の「私の最善の応手」の意味）");
    lines.push("3. 似た局面で使える考え方・手筋・格言を1つ");
  }
  lines.push("");
  lines.push("AIの読み筋に無い変化を推測で説明するときは「推測ですが」と明記してください。盤面の駒の位置は上の局面図を正としてください。初段〜二段向けに、簡潔にお願いします。");
  return lines.join("\n");
}

/**
 * 質問文を表示するダイアログを開く。
 * コピーは「コピーしてClaudeを開く」を押した瞬間に同期的に行う
 * （待ち時間をはさむと、ブラウザがコピーを拒否することがあるため）。
 */
export function askClaude(x: ExplainInput) {
  const text = buildPrompt(x);
  const ta = h("textarea", { class: "ask-text", readonly: true, rows: 12 }) as HTMLTextAreaElement;
  ta.value = text;
  const status = h("p", { class: "small muted" }, "下のボタンでコピーし、開いた Claude の入力欄に貼り付けて送信してください。");
  const close = () => overlay.remove();

  const copyAndOpen = async () => {
    const ok = await copyText(text, ta);
    if (ok) {
      toast("コピーしました。Claude に貼り付けてください", 3500);
      window.open("https://claude.ai/new", "_blank", "noopener");
      close();
    } else {
      // 自動コピーできない端末では、選択状態にして手動コピーしてもらう
      ta.focus();
      ta.select();
      status.textContent = "自動でコピーできませんでした。上の文章を長押しして「すべて選択」→「コピー」してから、Claude を開いてください。";
      status.className = "small error";
    }
  };

  const overlay = h("div", { class: "modal-overlay", onclick: (e: Event) => { if (e.target === overlay) close(); } },
    h("div", { class: "modal" },
      h("h2", {}, "Claudeに解説してもらう"),
      status,
      ta,
      h("div", { class: "row wrap" },
        h("button", { class: "btn primary", onclick: () => void copyAndOpen() }, "コピーしてClaudeを開く"),
        h("a", { class: "btn", href: "https://claude.ai/new", target: "_blank", rel: "noopener" }, "Claudeを開くだけ"),
        h("button", { class: "btn", onclick: close }, "閉じる"),
      ),
    ),
  );
  document.body.append(overlay);
}

/** クリップボードにコピーする。成功したかを返す。 */
async function copyText(text: string, ta: HTMLTextAreaElement): Promise<boolean> {
  // 1. 選択してコピー(ボタンを押した直後に同期で実行するので確実性が高い)
  let ok = false;
  try {
    ta.focus();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch { ok = false; }
  // 2. Clipboard API でも書き込む
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch { /* 1 が成功していればよい */ }
  return ok;
}
