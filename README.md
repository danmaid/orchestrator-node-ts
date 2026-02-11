
# Orchestrator (Node.js + TypeScript)

**日本語 README** — SSE 対応のオーケストレータ API と簡易ワークフロー実行エンジンのスターター一式です。

- すべての REST 風エンドポイントは `/v1/orchestrator` を起点にしています。
- 入力: `/v1/orchestrator/inputs` (POST でイベント投入、GET で最新 1000 件まで参照、GET /stream で SSE)
- 出力: `/v1/orchestrator/outputs` (GET で最新 1000 件まで参照、GET /stream で SSE)
- ワークフロー: `/v1/orchestrator/workflows` (CRUD + enable/disable、GET /stream で SSE)
- 静的デモ UI: `/v1/orchestrator/` (public/ を配信)。OpenAPI は `public/openapi.yaml` で提供します。
- 入出力は **1000 件のリングバッファ**で保持し、SSE による状態確認が可能です。
- ワークフローは RxJS ベースの非同期・並列パイプラインで、`filterEquals`, `mapFields`, `debounce`, `throttle`, `delay`, `branch`, `setTopic`, `mergeWithTopics`, `raceTopics`, `tapLog` などの**よく使うロジック**を同梱。出力から入力への **ループバック**も対応。

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
curl -X POST http://localhost:3000/v1/orchestrator/inputs   -H 'Content-Type: application/json'   -d '{
    "source":"demo-cli",
    "topic":"sensors/temperature",
    "type":"reading",
    "payload":{"value": 22.8, "unit":"C"}
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

### SSE でモニタリング
- 入力: `GET /v1/orchestrator/inputs/stream`
- 出力: `GET /v1/orchestrator/outputs/stream`
- ワークフロー: `GET /v1/orchestrator/workflows/stream`

ブラウザで `/v1/orchestrator/` を開けば、テーブルベースの CRUD とモニタが使えます。

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
