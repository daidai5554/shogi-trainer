// GitHub Pages 相当(COOP/COEPヘッダー無し・サブパス配信)で dist を確認するための簡易サーバー
import http from "http";
import fs from "fs";
import path from "path";

const PREFIX = "/shogi-trainer/";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".gz": "application/gzip", ".md": "text/markdown" };
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith(PREFIX)) { res.writeHead(302, { Location: PREFIX }); return res.end(); }
  let p = path.join(process.env.DIST || "dist", decodeURIComponent(url.pathname.slice(PREFIX.length)));
  if (p.endsWith(path.sep) || p === (process.env.DIST || "dist")) p = path.join(p, "index.html");
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream" });
    res.end(data);
  });
}).listen(4174, () => console.log("http://localhost:4174" + PREFIX));
