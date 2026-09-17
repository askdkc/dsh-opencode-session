# dsh-opencode-session 修正経緯

## 目的

OpenCode Go が要求する `x-opencode-session` を、DSH の会話単位で安定して付与する。会話ごとの値を維持し、OpenCode 側のバックエンド親和性とプロンプトキャッシュを保つ。

## 確認した問題

- OpenCode Go はヘッダーがないリクエストを `400 MissingSessionID` で拒否する。
- 既存プラグインは `llm/stream` と `AsyncLocalStorage` を使い、DSH の `sessionId` をヘッダー値として保持していた。
- ただし `globalThis.fetch` のパッチは、ストアが有効な間、URLを確認せずにすべての通信へヘッダーを追加していた。
- そのため、モデル呼び出しに付随する別のHTTP通信へ `x-opencode-session` が漏れる可能性があった。
- 固定値を設定するだけの回避策は、複数の会話を同じ親和性キーにまとめ、キャッシュ効率を下げる。
- `invalid API key` はセッションヘッダーとは別の認証設定問題であり、この修正の対象外とした。

## 採用した修正

- `fetch` パッチにURL判定を追加した。
- デフォルトでは `https://opencode.ai/zen` と同じOrigin・配下パスのリクエストだけを対象にする。
- カスタムゲートウェイは `urlPrefixes` で対象URL接頭辞を追加できるようにした。
- リクエストに既存の `x-opencode-session` がある場合は、従来どおり既存値を優先する。
- 許可URLからのredirectは、許可範囲内ならヘッダーを維持し、範囲外ならヘッダーなしで追従する。
- `sessionId` がない呼び出し、対象外URL、対象外provider、`GET /models` は変更しない。

## 変更ファイル

- `lib/index.js`: URL抽出・URL接頭辞判定・redirect制御・設定適用を追加。
- `tests/test.mjs`: URL対象判定、モデル一覧、redirect、非LIFO解除を検証。
- `README.md`: `urlPrefixes` の設定と動作範囲を記載。
- `cordis.patch.yml`: 標準設定に `https://opencode.ai/zen` を追加。

## 設定例

```yaml
config:
  providers: [opencode, opencode-go]
  urlPrefixes: [https://opencode.ai/zen]
  mode: session-id
```

カスタムゲートウェイを使う場合は、実際のベースURLを `urlPrefixes` に追加する。ベースURL配下の `GET /models` はモデル一覧として対象外になる。

## 検証結果

- `npm test`: 成功。20チェックすべて通過（既存14 + AUTHガイダンス6）。
- `node --check lib/index.js`: 成功。
- `git diff --check`: 成功。

## 追加対応：AUTHガイダンスのプロセス側表示

- DSH本体のChat/Trajectoryは`AUTH`失敗の本文を空にして`API key is invalid`の定型文に置き換えるため、`FreeTierError`（OpenCode内利用制限）と`DataPolicyError`（オプトインURL）がUIから欠落する。
- 本体側の表示仕様には手を入れず、このプラグインの`llm/stream`層で下流失敗を検知し、秘密部分だけを落としたガイダンスを`dsh`プロセスのコンソールへ1回出す方式にした。
- 元エラーはそのまま再送出するため、リトライ可否やセッションログの内容は変わらない。
- `sk-...` / `Bearer ...` / `api key: ...` をマスクし、エラー種別・理由・URLは残す。`authGuidance: false`で無効化できる。
- 修正点：pi-aiはストリーム中にthrowせず、失敗を`error`の`finish`チャンクとして流すため、初期版のrejection監視では検知できなかった。yield値の`finish`/`error`チャンクも監視対象に追加（通過は不変、報告は初回のみ）。

## 追加対応：同一プロバイダのまま最新モデルを取得するスクリプト

- dsh-opencodeは別プロバイダ（`opencode-zen-live` / `opencode-go-live`）として入るため、本体の`opencode` / `opencode-go`のまま最新化したいという要望に対応。
- DSH本体・pi-aiには手を入れず、`scripts/refresh-opencode-models.mjs`で公式一覧とModels.dev突合せを行い、設定断片（`llm-pi-ai.providers`用）を生成する方式にした。
- 取得先はdsh-opencodeと同一：`https://opencode.ai/zen/v1/models`（Zen）、`https://opencode.ai/zen/go/v1/models`（Go）、メタデータは`https://models.dev/api.json`（npm→プロトコル対応表も同一）。
- 内蔵カタログ既知IDは素の`- id:`（継承維持）、未知IDは`name`・`contextWindow`・`maxTokens`・`input`付き。ルート`api`は未知ID全件が一致時のみ出力（`models`エントリに`api`欄が無いため）。
- 未知IDの判定には`--pi-ai-dir`で渡した内蔵pi-aiカタログと比較する。未指定時は全件素のエントリ＋警告のみ。
- 適用先は`$DSH_HOME/settings.yaml`の`llm-pi-ai.providers`（Modelsページ互換、ホットリロード、再起動不要）。配列は全体置換、プロバイダ辞書はキー単位マージのため`apiKeyEnv`は保持される。

## 検証結果（モデルリフレッシュ）

- 実エンドポイントで実行：109モデル取得（zen 71 + go 38）。pi-ai 0.85.1比でzen 3件・go 11件の新規IDを検出。
- 実物のDSHリゾルバ（`resolveProfiles` deferred）で検証：未知3件はモデル単位の診断に縮退し、68/71件が利用可能のまま。ルート全体は壊れない。
- `node tests/models.test.mjs`：7チェック通過。`npm test`は両スイート実行に変更。

## 残課題

- `globalThis.fetch` の差し替えは、DSH側にリクエストヘッダー用の正式な拡張点がない場合の暫定方式である。
- DSHまたは `pi-ai` が会話IDからprovider固有ヘッダーを直接生成できるようになった場合は、このプラグインの役割を見直す。
- 設定対象外へのredirectは、セッションヘッダーを付けずに通常の `fetch` として追従する。
