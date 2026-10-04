// やねうら王(水匠5内蔵)のWASM版を public/engine にコピーする。
// wasm本体(約62MB)はgzip版(約30MB)だけを置き、ブラウザ側で展開する。
import fs from "fs";
import path from "path";

const src = "node_modules/@mizarjp/yaneuraou.halfkp/lib";
const dst = "public/engine";
fs.mkdirSync(dst, { recursive: true });
for (const f of ["yaneuraou.halfkp.js", "yaneuraou.halfkp.worker.js", "yaneuraou.halfkp.wasm.gz"]) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
fs.copyFileSync("node_modules/@mizarjp/yaneuraou.halfkp/LICENSE.md", path.join(dst, "LICENSE.md"));
console.log("engine copied to", dst);
