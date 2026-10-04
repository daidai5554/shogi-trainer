// IndexedDB の薄いラッパー。データはすべてこの端末の中だけに保存する。
import type { Game, Problem, Settings } from "./types";

const DB_NAME = "shogi-trainer";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("games")) db.createObjectStore("games", { keyPath: "id" });
      if (!db.objectStoreNames.contains("problems")) {
        const s = db.createObjectStore("problems", { keyPath: "id" });
        s.createIndex("gameId", "gameId");
      }
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function getGame(id: string): Promise<Game | undefined> {
  return wrap((await store("games")).get(id));
}
export async function putGame(g: Game): Promise<void> {
  await wrap((await store("games", "readwrite")).put(g));
}
export async function allGames(): Promise<Game[]> {
  const gs: Game[] = await wrap((await store("games")).getAll());
  return gs.sort((a, b) => b.playedAt - a.playedAt);
}
export async function deleteGame(id: string): Promise<void> {
  await wrap((await store("games", "readwrite")).delete(id));
  for (const p of await problemsOfGame(id)) await deleteProblem(p.id);
}

export async function getProblem(id: string): Promise<Problem | undefined> {
  return wrap((await store("problems")).get(id));
}
export async function putProblem(p: Problem): Promise<void> {
  await wrap((await store("problems", "readwrite")).put(p));
}
export async function deleteProblem(id: string): Promise<void> {
  await wrap((await store("problems", "readwrite")).delete(id));
}
export async function allProblems(): Promise<Problem[]> {
  return wrap((await store("problems")).getAll());
}
export async function problemsOfGame(gameId: string): Promise<Problem[]> {
  return wrap((await store("problems")).index("gameId").getAll(gameId));
}

const DEFAULT_SETTINGS: Settings = {
  usernames: [],
  analysisNodes: 300_000,
  threads: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
};

export async function getSettings(): Promise<Settings> {
  const s = await wrap((await store("kv")).get("settings"));
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}
export async function putSettings(s: Settings): Promise<void> {
  await wrap((await store("kv", "readwrite")).put(s, "settings"));
}

/** バックアップ用に全データを書き出す。 */
export async function exportAll(): Promise<string> {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: await getSettings(),
    games: await allGames(),
    problems: await allProblems(),
  });
}

export async function importAll(json: string): Promise<{ games: number; problems: number }> {
  const data = JSON.parse(json);
  if (data.version !== 1) throw new Error("対応していないバックアップ形式です");
  if (data.settings) await putSettings(data.settings);
  for (const g of data.games ?? []) await putGame(g);
  for (const p of data.problems ?? []) await putProblem(p);
  return { games: data.games?.length ?? 0, problems: data.problems?.length ?? 0 };
}
