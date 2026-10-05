# 国内情報漏洩タイムライン

日本の組織が公表した情報漏洩事案を、公表日順のタイムラインで閲覧するサイト。
GitHub Actions 上の Claude が毎日収集し、`data/incidents/` に JSON で commit する。

## 構成

- `data/incidents/<年>/<公表日>-<slug>.json` — 1事案1ファイル。スキーマは `src/content.config.ts`
- `.github/workflows/collect.yml` — 収集 → `pnpm build`（スキーマ検証）→ `pnpm check-urls`（出典 URL 到達確認）→ main へ push
- 配信は Cloudflare Workers Builds（main への push で自動ビルド・デプロイ）

## セットアップ

1. `claude setup-token` で発行したトークンを、リポジトリの Secret `CLAUDE_CODE_OAUTH_TOKEN` に登録する
2. Cloudflare ダッシュボードの Workers & Pages → Create → Import a repository でこのリポジトリを連携する（Build command: `pnpm build`、Deploy command: `npx wrangler deploy`）
3. 過去分は Actions → collect → Run workflow で `month` に `2026-01`〜`2026-09` を指定して1か月ずつ実行する

## 開発

```sh
pnpm install
pnpm dev
```
