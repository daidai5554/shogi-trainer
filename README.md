# 将棋トレーナー

将棋ウォーズ・将棋クエストの対局を取り込み、AIで解析して**自分の悪手から問題を作り、間隔反復で練習する**スマホ向けWebアプリ（PWA）です。

## できること

| 機能 | 内容 |
|---|---|
| 棋譜取り込み | ウォーズ／クエストの「棋譜コピー」をボタン1つで取り込み。先後・勝敗・持ち時間を自動判定 |
| AI解析 | やねうら王＋水匠5（WebAssembly版）がスマホ内で全局面を評価。悪手 `??`・疑問手 `?`・緩手 `?!`・詰み逃し・頓死を検出。終わると通知 |
| 振り返り | 勝率グラフ・考慮時間グラフ・この対局のポイント・悪手へのジャンプ・AI推奨手（緑）と実戦の手（赤）の矢印・読み筋の再生 |
| 今日のトレーニング | ボタン1つで約5分。定跡（手順ドリル＋局面）・悪手の復習・咎める・詰将棋をバランスよく。いまの弱点の局面を多めに出す |
| 定跡ツリー／手順ドリル | 自分の対局を局面ごとに集計（回数・勝敗・AI評価）。外れた局面・負けが多い分岐を表示し、どの局面からでも手順ドリル |
| 悪手の復習 | 自分の悪手の局面。答えると「実戦の手だと相手にこう指される」も表示。間隔反復で定着 |
| 咎める | 相手の悪手の直後の局面で、正しく咎める練習 |
| 詰将棋 | 実戦に現れた3〜7手詰め（自分・相手とも）＋実戦型詰将棋で補充。相手の応手はAIが指す |
| AIと指し継ぐ | どの局面からでもAIと対局（強さ3段階・待ったあり）。逆転された局面を自動で集めた「勝ち切り練習」 |
| 早指しモード | 練習に制限時間（1問30秒・詰将棋60秒） |
| 分析・成長の記録 | 今週と先週の比較、上達グラフ、練習カレンダー（連続日数）、戦型別成績、弱点と対策 |
| Claudeに質問 | 局面図・AIの読み筋・評価値をまとめた質問文をコピーして Claude アプリを開く（API料金なし） |
| 上達ガイド | このアプリでの毎日・毎週の練習の進め方 |

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
