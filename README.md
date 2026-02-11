
# Orchestrator (Node.js + TypeScript)

**日本語 README** — SSE 対応のオーケストレータ API と簡易ワークフロー実行エンジンのスターター一式です。

- すべての REST 風エンドポイントは `/v1/orchestrator` を起点にしています。
- 入力定義: `/v1/orchestrator/inputs` (CRUD + enable/disable)
- 入力イベント: `/v1/orchestrator/input-events` (POST でイベント投入、GET で最新 1000 件まで参照、GET /stream で SSE)
- 出力: `/v1/orchestrator/outputs` (GET で最新 1000 件まで参照、GET /stream で SSE)
- ワークフロー: `/v1/orchestrator/workflows` (CRUD + enable/disable、GET /stream で SSE)
- 静的デモ UI: `/v1/orchestrator/` (public/ を配信)。OpenAPI は `public/openapi.yaml` で提供します。
- 入出力は **1000 件のリングバッファ**で保持し、SSE による状態確認が可能です。
- ワークフローは RxJS ベースの非同期・並列パイプラインで、`filterEquals`, `mapFields`, `debounce`, `throttle`, `delay`, `aggregateCount`, `branch`, `setTopic`, `mergeWithTopics`, `raceTopics`, `tapLog` などの**よく使うロジック**を同梱。出力から入力への **ループバック**も対応。
- 外部データを取得して補完する `enrich` ステップを同梱（GET + キャッシュ + 事前定義プロバイダ）。

> ⚠️ 本実装はまずは**メモリ内ストア**で構成しています。プロダクションでは永続化、認可、レート制限、スキーマバリデーション、監視、テスト等を追加してください。

## 動かし方

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# 起動
npm start
# or 開発モード (ホットリロード)
npm run dev
```

サーバーはデフォルトで `http://localhost:3000` で待受します（環境変数 `PORT` で変更可）。

### 例: 入力イベント投入
```bash
curl -X POST http://localhost:3000/v1/orchestrator/input-events   -H 'Content-Type: application/json'   -d '{
    "source":"demo-cli",
    "topic":"sensors/temperature",
    "type":"reading",
    "payload":{"value": 22.8, "unit":"C"}
  }'
```

### 例: 入力定義の作成 (webhook / udp / tail)
```bash
curl -X POST http://localhost:3000/v1/orchestrator/inputs   -H 'Content-Type: application/json'   -d '{
  "name": "webhook-orders",
  "type": "webhook",
  "enabled": true,
  "workflowId": "wf-orders",
  "config": { "path": "/hooks/orders", "method": "POST" }
}'

curl -X POST http://localhost:3000/v1/orchestrator/inputs   -H 'Content-Type: application/json'   -d '{
  "name": "udp-sensors",
  "type": "udp",
  "enabled": true,
  "topic": "sensors/udp",
  "config": { "port": 40123, "codec": "json" }
}'

curl -X POST http://localhost:3000/v1/orchestrator/inputs   -H 'Content-Type: application/json'   -d '{
  "name": "tail-log",
  "type": "tail",
  "enabled": true,
  "topic": "logs/app",
  "config": { "path": "/var/log/app.log", "from": "end", "codec": "utf8" }
}'
```

### ワークフロー例 (debounce → 条件分岐 → 出力)
```bash
curl -X POST http://localhost:3000/v1/orchestrator/workflows   -H 'Content-Type: application/json'   -d '{
    "name":"Temp Guard",
    "enabled": true,
    "description":"温度アラート (300ms デバウンス)",
    "sourceTopics":["sensors/temperature"],
    "steps":[
      {"type":"debounce", "ms":300},
      {"type":"filterEquals","field":"payload.unit","value":"C"},
      {"type":"branch","branches":[
         {"when":{"field":"payload.value","equals":30},
          "set":{"alert":"HI"},
          "outputTopic":"alerts/temperature"}
      ], "else":{"set":{"note":"ok"}}}
    ],
    "outputTopic":"processed/temperature",
    "loopbackToInput": false
  }'
```

### 補完 (enrich) の例
`enrich` はイベント内の値を使って外部 GET を行い、結果を payload に書き込みます。

```bash
curl -X POST http://localhost:3000/v1/orchestrator/workflows   -H 'Content-Type: application/json'   -d '{
    "name":"Enrich Demo",
    "enabled": true,
    "sourceTopics":["demo/topic"],
    "steps":[
      {"type":"enrich","sourceId":"prefectures","params":{"code":"payload.prefCode"},"targetField":"payload.enriched.pref"},
      {"type":"enrich","sourceId":"jsonplaceholder-user","params":{"id":"payload.userId"},"targetField":"payload.enriched.user","cacheTtlMs":300000}
    ],
    "outputTopic":"demo/output"
  }'
```

対応する入力イベント例:
```bash
curl -X POST http://localhost:3000/v1/orchestrator/input-events   -H 'Content-Type: application/json'   -d '{
    "source":"demo-cli",
    "topic":"demo/topic",
    "type":"demo",
    "payload":{"message":"hello","prefCode":13,"userId":1}
  }'
```

#### デフォルトの補完ソース
- `prefectures`: 静的リスト (北海道 / 東京都 / 大阪府 のサンプル)
- `jsonplaceholder-user`: https://jsonplaceholder.typicode.com/users/{id}

追加の補完ソースは [src/enrichment.ts](src/enrichment.ts) の `createDefaultEnrichmentService()` にハードコードで登録できます。

### SSE でモニタリング
- 入力: `GET /v1/orchestrator/inputs/stream` または `GET /v1/orchestrator/input-events/stream`
- 出力: `GET /v1/orchestrator/outputs/stream`
- ワークフロー: `GET /v1/orchestrator/workflows/stream`

ブラウザで `/v1/orchestrator/` を開けば、テーブルベースの CRUD とモニタが使えます。

### 補完ソースの管理 (REST 風)
補完ソース一覧の取得・リフレッシュ・キャッシュ消去を REST 風に実行できます。

- 一覧: `GET /v1/orchestrator/enrichments`
- 全キャッシュ消去: `POST /v1/orchestrator/enrichments/cache`
- ソースのリフレッシュ: `POST /v1/orchestrator/enrichments/{id}/refresh`
- ソース単位キャッシュ消去: `POST /v1/orchestrator/enrichments/{id}/cache/clear`

デモ UI では「Enrichment」セクションから操作できます。

## 設計メモ
- **リングバッファ**: `src/ringbuffer.ts` — O(1) で追記・参照。
- **イベントバス**: `src/eventBus.ts` — トピックごとに `Subject` を保持。グローバル入力ストリームも提供。
- **ワークフローエンジン**: `src/workflowEngine.ts` — 定義(JSON)から RxJS パイプラインを生成。
- **SSE**: `src/sse.ts` — チャネルごとの接続管理、心拍(keep-alive)送信。
- **API**: `src/api.ts` — REST 風 CRUD と SSE エンドポイント。

## OpenAPI
`public/openapi.yaml` を参照してください。デモ UI のヘッダからもリンクしています。

## 将来拡張のヒント
- 認証/認可 (e.g., OAuth2/JWT)
- スキーマバリデーション (e.g., zod, ajv)
- ワークフロー永続化 (DB)
- バックプレッシャーと再試行戦略
- 分散デプロイ（複数インスタンス間のイベントブローカー: Kafka, NATS 等）
- GUI エディタ (現 UI を差し替え可能な静的配信)

---
MIT License
