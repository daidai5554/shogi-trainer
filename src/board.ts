// 将棋盤の描画とタップ操作。
import {
  Color,
  ImmutablePosition,
  Move,
  PieceType,
  Position,
  Square,
  handPieceTypes,

  pieceTypeToStringForBoard,
} from "tsshogi";
import { h } from "./ui";

export interface Arrow {
  usi: string;
  color: "best" | "played" | "pv";
}

export interface BoardOptions {
  flipped?: boolean;
  lastMoveUsi?: string | null;
  arrows?: Arrow[];
  /** 指定すると、その手番の駒を動かせる */
  interactive?: { color: Color; onMove: (m: Move) => void };
  blackName?: string;
  whiteName?: string;
}

const HAND_ORDER = handPieceTypes; // 飛角金銀桂香歩

function pieceChar(t: PieceType, color: Color): string {
  if (t === PieceType.KING) return color === Color.BLACK ? "玉" : "王";
  return pieceTypeToStringForBoard(t);
}

/** 盤上の表示位置(0..8)。左上が(0,0)。 */
function cell(sq: Square, flipped: boolean): [number, number] {
  const x = 9 - sq.file, y = sq.rank - 1;
  return flipped ? [8 - x, 8 - y] : [x, y];
}

function usiSquares(usi: string): { from: Square | null; drop: PieceType | null; to: Square } | null {
  if (!usi || usi.length < 4) return null;
  const to = Square.newByUSI(usi.slice(2, 4));
  if (!to) return null;
  if (usi[1] === "*") {
    const map: { [k: string]: PieceType } = { P: PieceType.PAWN, L: PieceType.LANCE, N: PieceType.KNIGHT, S: PieceType.SILVER, G: PieceType.GOLD, B: PieceType.BISHOP, R: PieceType.ROOK };
    return { from: null, drop: map[usi[0]] ?? null, to };
  }
  return { from: Square.newByUSI(usi.slice(0, 2)), drop: null, to };
}

export class BoardView {
  readonly el: HTMLElement;
  private pos: Position;
  private opts: BoardOptions = {};
  private selected: Square | PieceType | null = null;

  constructor(position: ImmutablePosition, opts: BoardOptions = {}) {
    this.el = h("div", { class: "board-wrap" });
    this.pos = (position as Position).clone();
    this.opts = opts;
    this.render();
  }

  update(position: ImmutablePosition, opts: BoardOptions = this.opts) {
    this.pos = (position as Position).clone();
    this.opts = opts;
    this.selected = null;
    this.render();
  }

  private render() {
    const flipped = !!this.opts.flipped;
    const top = flipped ? Color.BLACK : Color.WHITE;
    const bottom = flipped ? Color.WHITE : Color.BLACK;
    this.el.replaceChildren(
      this.renderHand(top, true),
      this.renderBoard(flipped),
      this.renderHand(bottom, false),
    );
  }

  private renderHand(color: Color, isTop: boolean): HTMLElement {
    const hand = this.pos.hand(color);
    const name = color === Color.BLACK ? this.opts.blackName : this.opts.whiteName;
    const mark = color === Color.BLACK ? "☗" : "☖";
    const row = h("div", { class: "hand" + (isTop ? " top" : "") + (this.pos.color === color ? " to-move" : "") });
    row.append(h("span", { class: "hand-name" }, `${mark}${name ?? ""}`));
    const pieces = h("span", { class: "hand-pieces" });
    let any = false;
    for (const t of HAND_ORDER) {
      const n = hand.count(t);
      if (!n) continue;
      any = true;
      const p = h("button", { class: "hand-piece" + (this.selected === t && this.pos.color === color ? " selected" : "") },
        pieceTypeToStringForBoard(t), n > 1 ? h("small", {}, String(n)) : "");
      if (this.canInteract(color)) p.addEventListener("click", () => { this.selected = this.selected === t ? null : t; this.render(); });
      else p.setAttribute("disabled", "");
      pieces.append(p);
    }
    if (!any) pieces.append(h("span", { class: "hand-empty" }, "持ち駒なし"));
    row.append(pieces);
    return row;
  }

  private canInteract(color: Color): boolean {
    const it = this.opts.interactive;
    return !!it && it.color === color && this.pos.color === color;
  }

  private targets(): Set<number> {
    const set = new Set<number>();
    if (this.selected == null) return set;
    for (const to of Square.all) {
      const m = this.pos.createMove(this.selected, to);
      if (m && (this.pos.isValidMove(m) || this.pos.isValidMove(m.withPromote()))) set.add(to.index);
    }
    return set;
  }

  private renderBoard(flipped: boolean): HTMLElement {
    const board = h("div", { class: "board" });
    const grid = h("div", { class: "grid" });
    const last = usiSquares(this.opts.lastMoveUsi ?? "");
    const targets = this.targets();
    const cells: HTMLElement[] = new Array(81);
    for (const sq of Square.all) {
      const [x, y] = cell(sq, flipped);
      const piece = this.pos.board.at(sq);
      const c = h("div", { class: "cell" });
      c.style.gridColumn = String(x + 1);
      c.style.gridRow = String(y + 1);
      // 盤の端の線は外枠と重なるので消す(表示上の位置で判定。反転時に左右が入れ替わるため)
      if (x === 8) c.classList.add("edge-r");
      if (y === 8) c.classList.add("edge-b");
      if (last && last.to.equals(sq)) c.classList.add("last");
      if (this.selected instanceof Square && this.selected.equals(sq)) c.classList.add("selected");
      if (targets.has(sq.index)) c.classList.add("target");
      if (piece) {
        const rotated = (piece.color === Color.WHITE) !== flipped;
        const promoted = [PieceType.PROM_PAWN, PieceType.PROM_LANCE, PieceType.PROM_KNIGHT, PieceType.PROM_SILVER, PieceType.HORSE, PieceType.DRAGON].includes(piece.type);
        c.append(h("span", { class: "piece" + (rotated ? " rot" : "") + (promoted ? " prom" : "") }, pieceChar(piece.type, piece.color)));
      }
      c.addEventListener("click", () => this.onCellClick(sq));
      cells[sq.index] = c;
      grid.append(c);
    }
    board.append(grid);
    board.append(this.renderCoords(flipped));
    const arrows = this.opts.arrows ?? [];
    if (arrows.length) board.append(this.renderArrows(arrows, flipped));
    return board;
  }

  private renderCoords(flipped: boolean): HTMLElement {
    const files = h("div", { class: "coords files" });
    for (let i = 0; i < 9; i++) files.append(h("span", {}, String(flipped ? i + 1 : 9 - i)));
    const ranks = h("div", { class: "coords ranks" });
    const kanji = "一二三四五六七八九";
    for (let i = 0; i < 9; i++) ranks.append(h("span", {}, kanji[flipped ? 8 - i : i]));
    const frag = h("div", { class: "coords-wrap" });
    frag.append(files, ranks);
    return frag;
  }

  private renderArrows(arrows: Arrow[], flipped: boolean): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 9 9");
    svg.setAttribute("class", "arrows");
    const defs = document.createElementNS(ns, "defs");
    for (const c of ["best", "played", "pv"]) {
      const marker = document.createElementNS(ns, "marker");
      marker.setAttribute("id", "ah-" + c);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "5");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "3");
      marker.setAttribute("markerHeight", "3");
      marker.setAttribute("orient", "auto-start-reverse");
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      path.setAttribute("class", "arrow-head " + c);
      marker.append(path);
      defs.append(marker);
    }
    svg.append(defs);
    for (const a of arrows) {
      const s = usiSquares(a.usi);
      if (!s) continue;
      const [tx, ty] = cell(s.to, flipped);
      let fx: number, fy: number;
      if (s.from) [fx, fy] = cell(s.from, flipped);
      else {
        // 持ち駒から: 自分側の駒台(下)または相手側(上)から伸ばす
        const bottom = (this.pos.color === Color.BLACK) !== flipped;
        fx = tx; fy = bottom ? 9.3 : -1.3;
      }
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", String(fx + 0.5));
      line.setAttribute("y1", String(fy + 0.5));
      line.setAttribute("x2", String(tx + 0.5));
      line.setAttribute("y2", String(ty + 0.5));
      line.setAttribute("class", "arrow " + a.color);
      line.setAttribute("marker-end", `url(#ah-${a.color})`);
      svg.append(line);
    }
    return svg;
  }

  private onCellClick(sq: Square) {
    const it = this.opts.interactive;
    if (!it || this.pos.color !== it.color) return;
    const piece = this.pos.board.at(sq);
    if (this.selected != null) {
      const m = this.pos.createMove(this.selected, sq);
      if (m) {
        const normal = this.pos.isValidMove(m);
        const promo = this.pos.isValidMove(m.withPromote());
        if (normal || promo) {
          if (normal && promo) {
            this.askPromotion(m);
          } else {
            this.commit(promo ? m.withPromote() : m);
          }
          return;
        }
      }
    }
    if (piece && piece.color === it.color) {
      this.selected = this.selected instanceof Square && this.selected.equals(sq) ? null : sq;
    } else {
      this.selected = null;
    }
    this.render();
  }

  private askPromotion(m: Move) {
    const dlg = h("div", { class: "promo-dialog" },
      h("p", {}, "成りますか？"),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: () => { dlg.remove(); this.commit(m.withPromote()); } }, "成る"),
        h("button", { class: "btn", onclick: () => { dlg.remove(); this.commit(m); } }, "成らない"),
      ));
    this.el.append(dlg);
  }

  private commit(m: Move) {
    this.selected = null;
    this.opts.interactive?.onMove(m);
  }
}

