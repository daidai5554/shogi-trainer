# 将棋トレーナー

将棋ウォーズ・将棋クエストの対局を取り込み、AIで解析して**自分の悪手から問題を作り、間隔反復で練習する**スマホ向けWebアプリ（PWA）です。

## できること

| 機能 | 内容 |
|---|---|
| 棋譜取り込み | ウォーズ／クエストの「棋譜コピー」をボタン1つで取り込み。先後・勝敗・持ち時間を自動判定（クエストの持ち時間は消費時間から推定） |
| AI解析 | やねうら王＋水匠5（WebAssembly版）がスマホ内で全局面を評価。悪手 `??`・疑問手 `?`・緩手 `?!`・詰み逃し・頓死を検出 |
| 振り返り | 勝率グラフ、悪手へのジャンプ、AI推奨手（緑）と実戦の手（赤）の矢印、読み筋の盤上再生 |
| 問題集 | 自分の悪手・疑問手・詰み逃し・頓死の局面が自動で問題になる。ほぼ同等の別解はAIが判定して正解扱い |
| 間隔反復 | 正解すると 1日→3日→約1週間…と間隔が伸び、間違えると翌日（同じセッションの最後にも再出題） |
| 弱点分析 | 戦型別の勝率、序盤・中盤・終盤の悪手数、ノータイム悪手、時間切迫時の崩れ、詰み逃し・頓死を集計し、対策つきで表示 |
| Claudeに質問 | 局面図・AIの読み筋・評価値をまとめた質問文をコピーして Claude アプリを開く（API料金なし、プランの利用枠で解説） |
| テーマ練習 | 「終盤だけ」「詰み逃しだけ」「対 居飛車穴熊だけ」のように絞り込んで練習 |

データ（棋譜・問題・成績）はすべて**スマホの中だけ**（IndexedDB）に保存されます。設定画面からバックアップ・復元ができます。

## 使い方（スマホ）

1. Android の Chrome で公開URLを開き、メニューの「ホーム画面に追加」でアプリとして追加
2. 設定 →「AIを今すぐ読み込む」（初回のみ約30MB。Wi-Fi推奨）
3. ウォーズ／クエストで対局後、棋譜をコピー → 棋譜タブ →「クリップボードから取り込む」
4. 解析が終わると問題が作られる。ホームの「練習を始める」で毎日解く

## 開発

```bash
npm install        # AIファイルを public/engine にコピーする
npm run dev        # http://localhost:5173
npm run build      # dist/ に出力
```

解析ロジックをPC上で確認する:

```bash
USERNAMES=自分の名前 npm run test:analysis -- 棋譜ファイル.kif 200000
```

### 公開（GitHub Pages）

`main` ブランチに push すると `.github/workflows/deploy.yml` が `dist/` を GitHub Pages に公開します。
リポジトリの Settings → Pages → Source を「GitHub Actions」にしてください。

GitHub Pages では HTTP ヘッダーを設定できないため、AIのマルチスレッドに必要な COOP/COEP ヘッダーは `public/sw.js`（Service Worker）が付けます。

## 構成

```
src/
  kifu.ts       棋譜の読み込み（ウォーズ/クエスト判定、先後、勝敗、持ち時間）
  engine.ts     やねうら王WASMのラッパー（USIプロトコル）
  analysis.ts   全局面解析 → 指し手の判定 → 問題の作成
  strategy.ts   戦型の簡易判定（飛車の位置・角交換・玉の位置）
  stats.ts      成績と弱点の集計
  srs.ts        間隔反復
  board.ts      将棋盤の描画とタップ操作
  jobs.ts       解析の順番待ち（裏で1局ずつ）
  db.ts         IndexedDB
  views/        各画面
public/sw.js    Service Worker（オフライン対応・COOP/COEP付与）
```

## ライセンス

- 将棋AI: [やねうら王](https://github.com/yaneurao/YaneuraOu)（GPLv3）、評価関数 水匠5、WebAssembly版は [mizar/YaneuraOu.wasm](https://github.com/mizar/YaneuraOu.wasm)（`@mizarjp/yaneuraou.halfkp@7.6.2-alpha.2`）
- 棋譜処理: [tsshogi](https://github.com/sunfish-shogi/tsshogi)（MIT）
