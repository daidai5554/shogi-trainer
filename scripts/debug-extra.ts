import fs from "fs";
import { Color, PieceType, Position } from "tsshogi";
import { importGame, recordOf } from "../src/kifu";
const { game } = importGame(fs.readFileSync("samples/quest1.kif", "utf8"), ["daidai5554"]);
const r = recordOf(game);
for (const ply of [100, 104, 108, 112]) {
  r.goto(ply - 1);
  const base = r.position;
  const atk = base.color, def = atk === Color.BLACK ? Color.WHITE : Color.BLACK;
  const pos = (base as Position).clone();
  const before = pos.sfen;
  const n = pos.hand(def).count(PieceType.GOLD) + pos.hand(def).count(PieceType.SILVER);
  if (pos.hand(def).count(PieceType.SILVER)) { pos.hand(def).reduce(PieceType.SILVER, 1); pos.hand(atk).add(PieceType.SILVER, 1); }
  console.log(ply, atk, "defGS", n, "\n ", before, "\n ", pos.sfen);
}
