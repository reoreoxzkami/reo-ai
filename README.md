# ✦ Reo AI

日常の相談からコーディングまでこなす、**無料で動く**パーソナルAIアシスタント。Cloudflare Workers 1本で動きます。

## できること
- 💬 **日常モード** — 相談・調べもの。必要なら自分でWeb検索してページを読み、出典つきで回答
- ⌨ **コードモード** — 実用的なコードを生成。HTML/JSは「▶ 実行」でその場でプレビュー
- 🖼 **画像で質問** — 📎・貼り付け・ドラッグ&ドロップで画像を添付（自動で縮小して送信）
- 📅✉️ **Googleカレンダー・Gmail連携** — 予定の確認/追加、メール検索/本文読み取り/下書き作成（送信はしません）
- 🧠 **記憶** — 名前や好みを会話から自動保存。設定画面で確認・削除
- ⚡ **ストリーミング** — 文字が流れるように表示
- 🎤 音声入力 / 📱 ホーム画面に追加できるPWA / 🔒 合言葉で保護

## AIモデル（すべて無料枠で利用可）
| 用途 | モデル |
|---|---|
| 通常・コード | Cloudflare Workers AI `@cf/qwen/qwen3-30b-a3b-fp8`（キー不要） |
| 画像つき | Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct` |
| 任意 | Gemini 2.5 Flash（設定画面に自分のGoogle AI Studioキーを入れると切替。キーはブラウザにのみ保存） |

## 構成
```
src/worker.js   Worker本体（ルーティング、ツール、Workers AI / Gemini、KV保存）
web/index.html  フロントエンド（1ファイル）
gas/Code.gs     Googleカレンダー/Gmail連携用 Apps Script
build.py        web/ と gas/ を src/assets.js にまとめる
```
検索は Bing（HTML）＋ Yahoo!ニュースのトピックスRSS ＋ Wikipedia で、APIキー不要です。

## 自分でデプロイ
```bash
npx wrangler kv namespace create reo-ai-brain   # 出たIDを wrangler.toml に記入
python3 build.py
npx wrangler deploy
npx wrangler secret put APP_PASSCODE            # 好きな合言葉
```

## Google連携のつなぎ方
1. アプリの ⚙設定 →「スクリプトをコピー」（合言葉トークン入り）
2. https://script.google.com で新しいプロジェクトに貼り付けて保存
3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」／実行ユーザー「自分」／アクセス「全員」→ 承認
4. 表示された `…/exec` のURLを設定画面に貼って「接続テスト」

## 無料枠の目安
- Workers AI: 1日の無料枠（neurons）を超えるとその日は応答が止まります
- Workers KV: 書き込み 1日1,000回（会話の保存1回で約2回）

MIT License
