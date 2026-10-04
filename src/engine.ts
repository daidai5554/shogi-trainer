// やねうら王(水匠5内蔵) WASM版をブラウザで動かすラッパー。
// 1つのエンジンを全画面で共有し、解析要求は順番に処理する。
import type { PVLine, Score } from "./types";

interface YModule {
  addMessageListener(fn: (line: string) => void): void;
  postMessage(cmd: string): void;
  terminate(): void;
}
type Factory = (opts: object) => Promise<YModule>;

declare global {
  interface Window {
    YaneuraOu_HalfKP?: Factory;
  }
}

export type EngineState = "idle" | "loading" | "ready" | "error";

export interface SearchResult {
  lines: PVLine[];
  bestmove: string; // "resign" の場合は詰まされている
  nodes: number;
}

type Listener = () => void;

const ENGINE_DIR = () => new URL("engine/", document.baseURI).href;

class Engine {
  state: EngineState = "idle";
  error = "";
  progress = 0; // 0..1 ダウンロード進捗
  private mod: YModule | null = null;
  private loading: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private lineHandler: ((line: string) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private threads = 1;

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }

  get supported(): boolean {
    return typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
  }

  load(threads: number): Promise<void> {
    if (this.loading) return this.loading;
    this.threads = threads;
    this.loading = this.doLoad().catch((e) => {
      this.state = "error";
      this.error = String(e?.message ?? e);
      this.loading = null;
      this.emit();
      throw e;
    });
    return this.loading;
  }

  private async doLoad() {
    if (!this.supported) {
      throw new Error("このブラウザではAIを動かせません（ページを再読み込みすると直る場合があります）");
    }
    this.state = "loading";
    this.progress = 0;
    this.emit();

    const dir = ENGINE_DIR();
    await loadScript(dir + "yaneuraou.halfkp.js");
    const wasmBinary = await this.fetchWasm(dir + "yaneuraou.halfkp.wasm.gz");
    const factory = window.YaneuraOu_HalfKP;
    if (!factory) throw new Error("AIの読み込みに失敗しました");
    const mod = await factory({
      wasmBinary,
      locateFile: (p: string) => dir + p,
      mainScriptUrlOrBlob: dir + "yaneuraou.halfkp.js",
    });
    mod.addMessageListener((line) => this.lineHandler?.(line));
    this.mod = mod;

    await this.waitFor("usi", "usiok");
    for (const cmd of [
      `setoption name Threads value ${this.threads}`,
      "setoption name USI_Hash value 64",
      "setoption name PvInterval value 0",
      "setoption name BookFile value no_book",
      "setoption name ConsiderationMode value true",
      "setoption name OutputFailLHPV value false",
      "setoption name MultiPV value 1",
    ]) mod.postMessage(cmd);
    await this.waitFor("isready", "readyok");
    mod.postMessage("usinewgame");
    this.state = "ready";
    this.emit();
  }

  private async fetchWasm(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`AIファイルを取得できません (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 29_800_000;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      this.progress = Math.min(0.99, received / total);
      this.emit();
    }
    const blob = new Blob(chunks as BlobPart[]);
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    // サーバーが自動で展開済みの場合はそのまま使う
    if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.arrayBuffer();
    const ds = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(ds).arrayBuffer();
  }

  private waitFor(cmd: string, expect: string): Promise<void> {
    return new Promise((resolve) => {
      this.lineHandler = (line) => {
        if (line.startsWith(expect)) {
          this.lineHandler = null;
          resolve();
        }
      };
      this.mod!.postMessage(cmd);
    });
  }

  /**
   * 局面を探索する。position は "sfen ..." または "startpos moves ..." 形式。
   */
  search(position: string, opts: { nodes: number; multipv?: number }): Promise<SearchResult> {
    const run = async () => {
      if (!this.mod) throw new Error("AIが読み込まれていません");
      const mod = this.mod;
      const multipv = opts.multipv ?? 1;
      mod.postMessage(`setoption name MultiPV value ${multipv}`);
      const lines = new Map<number, PVLine>();
      let nodes = 0;
      const bestmove = await new Promise<string>((resolve) => {
        this.lineHandler = (line) => {
          if (line.startsWith("info ")) {
            const info = parseInfo(line);
            if (info) {
              if (info.nodes) nodes = info.nodes;
              if (!info.bound || !lines.has(info.multipv)) lines.set(info.multipv, { score: info.score, pv: info.pv });
            }
          } else if (line.startsWith("bestmove")) {
            this.lineHandler = null;
            resolve(line.split(/\s+/)[1] ?? "resign");
          }
        };
        mod.postMessage(`position ${position}`);
        mod.postMessage(`go nodes ${opts.nodes}`);
      });
      const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).filter((l) => l.pv.length > 0);
      if (bestmove === "resign" || bestmove === "win") {
        return { lines: [{ score: { kind: "mate", v: 0, win: bestmove === "win" } as Score, pv: [] }], bestmove, nodes };
      }
      if (sorted.length === 0) sorted.push({ score: { kind: "cp", v: 0 }, pv: [bestmove] });
      // 最善手は bestmove を優先
      if (sorted[0].pv[0] !== bestmove) {
        const i = sorted.findIndex((l) => l.pv[0] === bestmove);
        if (i > 0) sorted.unshift(...sorted.splice(i, 1));
      }
      return { lines: sorted, bestmove, nodes };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

export function parseInfo(line: string): { multipv: number; score: Score; pv: string[]; nodes: number; bound: boolean } | null {
  const t = line.split(/\s+/);
  let multipv = 1, nodes = 0, bound = false;
  let score: Score | null = null;
  let pv: string[] = [];
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "multipv": multipv = Number(t[++i]); break;
      case "nodes": nodes = Number(t[++i]); break;
      case "lowerbound": case "upperbound": bound = true; break;
      case "score": {
        const kind = t[++i];
        const raw = t[++i];
        if (kind === "cp") score = { kind: "cp", v: Number(raw) };
        else if (kind === "mate") {
          // "mate -0" や "mate +" "mate -" の表記もある
          const neg = raw.startsWith("-");
          const n = Number(raw.replace(/[+-]/, "")) || 0;
          score = { kind: "mate", v: n, win: !neg };
        }
        break;
      }
      case "pv": pv = t.slice(i + 1); i = t.length; break;
    }
  }
  if (!score) return null;
  return { multipv, score, pv, nodes, bound };
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("AIのスクリプトを読み込めません"));
    document.head.appendChild(s);
  });
}

export const engine = new Engine();
