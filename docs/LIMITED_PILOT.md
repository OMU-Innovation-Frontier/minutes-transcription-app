# サークル向け限定公開（Render Free + Supabase Free）

参加者が必要なのは公開URLと合言葉だけです。AIキーを渡したり、GitHubのアカウントを共有したりする必要はありません。公開前に下記の設定と実機確認が必要です。設定ファイルを追加しただけでは公開されません。

## 管理者が最初に行う設定

1. Supabaseの無料プロジェクトを用意し、SQL Editorで `deploy/supabase-quota.sql` を実行します。既存の会議履歴DBを変更するSQLではありません。専用のプロジェクトを推奨します。
2. Project URLとSettings → API Keysのサーバー用Secret keyを確認します。値はチャット・GitHub・手順書へ貼らず、次のRenderの環境変数欄へ直接入力します。Publishable keyでは動作しません。
3. Renderから公式リポジトリを接続し、Blueprintでこのリポジトリの `render.yaml` を指定します。プランが **Free** であることを確認します。Webサービス1つ・インスタンス1つで運用します。有料ディスクは不要です。
4. 入力を求められる設定を埋めます。

| 設定名 | 入れるもの |
| --- | --- |
| APP_ACCESS_PASSPHRASE | 20〜256文字の推測しにくい合言葉 |
| APP_QUOTA_SUPABASE_URL | SupabaseのProject URL（末尾のスラッシュなし） |
| APP_QUOTA_SUPABASE_SECRET_KEY | サーバー用Secret key |
| GROQ_API_KEY | 文字起こし用Groqキー |
| GROQ_SUMMARY_API_KEY | 要約用Groqキー（同じアカウントのキーも指定可能） |

5. デプロイ完了を待ち、Renderの公開URLを開きます。公開URLは `RENDER_EXTERNAL_URL` から自動設定されます。独自ドメインを使う場合だけ `APP_PUBLIC_ORIGIN` をそのHTTPSオリジンに設定します。

ビルドは `pnpm install --frozen-lockfile` と `pnpm run build`、起動は `pnpm start` です。Renderでは `PORT` を使い、ホストは `0.0.0.0` です。ローカルの `.env` をアップロードしないでください。`VITE_SERVER_HTTP_URL` と `VITE_TRANSCRIPTION_WEBSOCKET_URL` はRenderに設定しません。HTTPSと同じ公開先へ自動接続します。

初期設定はGroqで文字起こし・要約、AI整文はOFFです。要約入力の上限は既定12,000 UTF-8バイトで、長時間の会議全文を要約できる保証はありません。詳しくは [Groqの要約手順](GROQ_SUMMARY.md) を参照してください。APIの利用条件・残量・課金設定は提供元の管理画面でも確認してください。アプリの回数制限は請求額の保証ではありません。

## 公開前の動作確認

1. 非公開ウィンドウで公開URLを開き、合言葉が必要なことを確認します。
2. 入室して短い架空の会議を開始し、マイクの許可・文字起こし・手動の途中要約・終了後の最終要約・PDF出力・再読み込み後の履歴を確認します。AIへ送信される説明を読んで同意してください。
3. 別のウィンドウで入室し、同時録音の上限が働くことを確認します。
4. 退出後に再読み込みし、再入室が必要なことを確認します。終了前には退出できません。
5. 友人1人にURLと合言葉を個別に送り、同じ手順を試してもらいます。APIキーは送りません。

## 参加者向け手順

1. 管理者から届いたURLをChromeまたはEdgeで開き、合言葉で入室します。
2. 会議を準備し、送信先の説明を確認します。録音する人は1人に決めます。
3. 録音開始後にマイクを許可します。必要なときに途中要約ボタンを押します。
4. 会議を終了して最終要約を確認し、PDFを保存します。履歴はその端末・ブラウザーに保存されます。
5. 操作が終わったら退出します。共有端末では履歴・ダウンロード済みPDFの扱いにも注意してください。

認証切れの場合は録音を終了してから再読み込みし、再入室します。サーバー再起動でも再入室が必要です。管理者が参加者の起動状況を確認する機能はありません。

## 制限と保存内容

全員合計・UTC日付（日本時間9時切り替え）の既定上限です。

| 対象 | 上限 | 変更する環境変数 |
| --- | --- | --- |
| 同時録音 | 1件 | APP_MAX_RECORDINGS |
| 1録音 | 2時間 | APP_MAX_RECORDING_SECONDS |
| 録音開始 | 1日10回 | APP_DAILY_RECORDING_STARTS |
| 音声受信 | 1日4時間分 | APP_DAILY_AUDIO_SECONDS |
| 要約 | 1日30リクエスト | APP_DAILY_SUMMARY_REQUESTS |
| AI整文 | 1日2,000リクエスト | APP_DAILY_CORRECTION_REQUESTS |

失敗した送信も送信前に数えます。音声は10秒分ずつ先に枠を確保するため、終了・再起動で未使用分が残っても返却しません。無音も受信したPCM音声として数えます。再接続は同じ入室状態の同じ録音だけに認め、録音時間の締切を延長しません。

Supabaseに保存するのは日付・種類・累計値だけです。音声・会議本文・要約・ログイン情報は保存しません。この仕組みは履歴のクラウド共有ではありません。Supabase停止・通信失敗時はAIへの送信を止め、ローカル記録へ切り替えて上限をリセットすることもありません。復旧・再デプロイ後もカウンターを削除しないでください。

Renderの無料サービスは一定時間アクセスがないと停止し、次回アクセスの起動に時間がかかります。無料サービスは再起動もあり、録音が中断する可能性があります。Supabase無料プロジェクトも非アクティブ状態で一時停止し得るため、会議前に両方の状態を確認してください。接続確認だけでAIの内容品質・長時間安定性を保証できません。

一時停止するにはRenderでサービスを停止するかGroq側でキーを無効化します。合言葉変更後は必ず再起動し、既存の入室状態を無効にします。

## ローカルで認証だけ確認する場合

既存の開発設定に `APP_ACCESS_ENABLED=true`、`APP_ALLOW_LOCAL_HTTP=true`、`APP_PUBLIC_ORIGIN=http://127.0.0.1:8787`、合言葉、`APP_QUOTA_BACKEND=file` と `APP_QUOTA_FILE` を設定します。AIはmockで確認できます。ビルド後に `pnpm start` で起動し、開発用ViteのURLではなくサーバーのURLを開きます。既存の開発プロセスとポートが重ならないようにしてください。

## 公式資料

- [Render Free](https://render.com/docs/free)
- [Render Blueprint](https://render.com/docs/blueprint-spec)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions)
