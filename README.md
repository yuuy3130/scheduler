# Internal Scheduler

人事チーム内で空き時間を確認し、予定を登録するための社内向け日程管理ツールです。

## 起動

```bash
node server.mjs
```

ローカルでは以下を開きます。

- 管理用: http://127.0.0.1:3100/manage
- 確認用: http://127.0.0.1:3100/view

## Render設定

Build Command は空欄または不要です。

Start Command:

```bash
node server.mjs
```

Environment Variables:

```env
APPS_SCRIPT_WEBHOOK_URL="Google Apps ScriptのウェブアプリURL"
SPREADSHEET_ID="1WJCFJmiSZoSTCu0UQK3IBFYzpWq8H-U0gksyzScU8m8"
```

## 注意

`.env` と `data/store.json` は公開しないでください。公開用の環境変数はRender側に設定します。
