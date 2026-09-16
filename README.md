# Monster Push FCM Hono

一个运行在 Cloudflare Workers 上的轻量级 FCM HTTP v1 推送服务，基于 [Hono](https://hono.dev/) 构建。

它支持：

- 向一个或多个 FCM registration token 发送通知
- 使用 HMAC-SHA256 校验调用方身份
- 在 Workers KV 中缓存短期 Google OAuth access token
- 通过 Upstash QStash 定时发送通知
- 校验请求参数并返回每个设备的 FCM 响应

> [!IMPORTANT]
> Fork 或克隆后不能直接部署。你需要替换 Firebase Project ID、Cloudflare KV namespace ID，以及定时任务使用的 Worker 公网地址。请勿提交 Firebase service account JSON、QStash token 或 HMAC secret。

## 工作流程

```text
客户端
  └─ POST /send + HMAC 签名
       ├─ 无 scheduledAt → Worker → FCM HTTP v1
       └─ 有 scheduledAt → QStash → POST /execute-send → FCM HTTP v1

Worker → Google OAuth 2.0 → 获取 access token → 缓存到 Workers KV
```

## 前置条件

- Node.js 18 或更高版本
- Cloudflare 账户
- 已启用 Firebase Cloud Messaging HTTP v1 API 的 Firebase 项目
- Firebase service account JSON 私钥
- Upstash QStash 账户（仅定时发送需要）

Firebase service account JSON 可以在 Firebase Console 的 **Project settings → Service accounts → Generate new private key** 中生成。请妥善保管下载的文件。

## 安装

```bash
git clone https://github.com/Monster-2019/monster_push_fcm_hono.git
cd monster_push_fcm_hono
npm install
npx wrangler login
```

## 配置

### 1. 设置 Firebase Project ID

打开 `src/index.ts`，将 `SEND_URL` 中的 `monster-push` 替换成你的 Firebase Project ID：

```ts
const SEND_URL =
  "https://fcm.googleapis.com/v1/projects/YOUR_FIREBASE_PROJECT_ID/messages:send";
```

这里需要的是 Firebase Project ID，不是项目显示名称或数字形式的 Project Number。

### 2. 创建 Workers KV

创建用于缓存 Google OAuth access token 的 KV namespace：

```bash
npx wrangler kv namespace create FCM
```

命令会返回一个 namespace ID。将 `wrangler.jsonc` 中 `FCM` binding 的 `id` 替换成你自己的值：

```jsonc
"kv_namespaces": [
  {
    "binding": "FCM",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

不要继续使用仓库中原作者的 namespace ID；KV namespace 归属于各自的 Cloudflare 账户。

### 3. 配置 secrets

部署环境需要以下 secrets：

| 名称 | 是否必需 | 用途 |
| --- | --- | --- |
| `FIREBASE_ADMINSDK` | 是 | 完整的 Firebase service account JSON，序列化为单行字符串 |
| `HMAC_SECRET` | 是 | 调用 `/send` 以及保护内部回调的共享密钥 |
| `QSTASH_TOKEN` | 定时发送时 | Upstash Console 中的 QStash token |

使用 Wrangler 写入生产 secrets：

```bash
npx wrangler secret put FIREBASE_ADMINSDK
npx wrangler secret put HMAC_SECRET
npx wrangler secret put QSTASH_TOKEN
```

每条命令执行后，按提示粘贴对应值。建议使用足够长的随机值作为 `HMAC_SECRET`。

本地开发时，在项目根目录创建不会提交到 Git 的 `.dev.vars`：

```dotenv
FIREBASE_ADMINSDK='{"type":"service_account","project_id":"YOUR_PROJECT_ID","private_key_id":"...","private_key":"YOUR_ESCAPED_PRIVATE_KEY","client_email":"..."}'
HMAC_SECRET="replace-with-a-long-random-secret"
QSTASH_TOKEN="replace-with-your-qstash-token"
```

请将 service account JSON 压缩成一行，并保留 `private_key` 中的 `\n` 转义。只使用立即发送时，可以省略 `QSTASH_TOKEN`。

### 4. 配置定时任务回调地址

只有使用 `scheduledAt` 时才需要这一步。

先部署一次以获得 Worker URL，然后打开 `src/index.ts`，将 `currentOrigin` 替换为你的 Worker 公网 origin：

```ts
const currentOrigin = "https://YOUR_WORKER.workers.dev";
```

如果绑定了自定义域名，也可以使用自定义域名。QStash 必须能够从公网访问 `${currentOrigin}/execute-send`。修改后重新部署。

## 本地开发

```bash
npm run dev
```

默认地址为 `http://127.0.0.1:8787`。立即发送可以直接在本地测试；定时发送需要一个 QStash 可访问的公网 HTTPS 地址。

如修改了 Worker bindings，可以重新生成类型：

```bash
npm run cf-typegen
```

## 部署

```bash
npm run deploy
```

部署完成后，记下 Wrangler 输出的 Worker URL。如果需要定时发送，请按上文更新 `currentOrigin` 并再次部署。

## API

### `POST /send`

发送通知或创建定时发送任务。

#### 请求头

| 请求头 | 说明 |
| --- | --- |
| `content-type` | `application/json` |
| `x-timestamp` | 当前 Unix 秒级时间戳 |
| `x-signature` | 64 位小写十六进制 HMAC-SHA256 签名，不要添加 `sha256=` 前缀 |

签名内容：

```text
payload = `${x-timestamp}.${rawRequestBody}`
signature = HMAC_SHA256_HEX(payload, HMAC_SECRET)
```

签名必须基于实际发送的原始 JSON 字符串。服务端只接受时间误差在 5 分钟以内的请求。

#### 请求体

```json
{
  "message": {
    "notification": {
      "title": "Hello",
      "body": "World"
    },
    "webpush": {
      "fcm_options": {
        "link": "https://example.com"
      },
      "notification": {
        "icon": "https://example.com/icon.png"
      }
    },
    "data": {
      "messageId": "123"
    }
  },
  "tokens": [
    "FCM_REGISTRATION_TOKEN"
  ]
}
```

字段说明：

- `message.notification.title`：必需，通知标题
- `message.notification.body`：必需，通知正文
- `message.webpush`：可选，Web Push 配置
- `message.data`：可选，值必须全部是字符串
- `tokens`：必需，至少包含一个 FCM registration token
- `scheduledAt`：可选，可被 `new Date(...)` 解析的未来时间；建议使用带时区的 ISO 8601 字符串

定时发送示例：

```json
{
  "message": {
    "notification": {
      "title": "Scheduled notification",
      "body": "Sent through QStash"
    }
  },
  "tokens": ["FCM_REGISTRATION_TOKEN"],
  "scheduledAt": "2026-10-01T09:00:00+08:00"
}
```

### Node.js 调用示例

```js
import { createHmac } from "node:crypto";

const endpoint = process.env.PUSH_ENDPOINT;
const secret = process.env.HMAC_SECRET;

if (!endpoint || !secret) {
  throw new Error("PUSH_ENDPOINT and HMAC_SECRET are required");
}

const body = JSON.stringify({
  message: {
    notification: {
      title: "Hello",
      body: "World",
    },
    data: {
      messageId: "123",
    },
  },
  tokens: ["FCM_REGISTRATION_TOKEN"],
});

const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", secret)
  .update(`${timestamp}.${body}`)
  .digest("hex");

const response = await fetch(`${endpoint}/send`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-timestamp": timestamp,
    "x-signature": signature,
  },
  body,
});

console.log(response.status, await response.json());
```

运行前设置环境变量：

```bash
PUSH_ENDPOINT="https://YOUR_WORKER.workers.dev" \
HMAC_SECRET="your-hmac-secret" \
node send.mjs
```

### 响应

立即发送成功：

```json
{
  "ok": true,
  "source": "immediate",
  "results": [
    {
      "token": "FCM_REGISTRATION_TOKEN",
      "status": 200,
      "ok": true,
      "body": {
        "name": "projects/example/messages/0:..."
      }
    }
  ]
}
```

定时任务创建成功：

```json
{
  "ok": true,
  "source": "scheduled",
  "messageId": "msg_..."
}
```

### `POST /execute-send`

这是供 QStash 调用的内部端点，不应由普通客户端直接调用。它使用 `x-custom-secret` 与 `HMAC_SECRET` 比较来保护请求。

## 安全建议

- 永远不要提交 `.dev.vars`、`.env`、Firebase service account JSON 或任何 token
- 通过 `wrangler secret put` 保存生产 secrets，不要把 secrets 写入 `wrangler.jsonc`
- 为部署该项目单独创建权限最小化的 service account
- 泄露 secret 后立即轮换，而不只是从最新提交中删除
- 不要在日志中输出 registration token、service account JSON 或 access token
- 面向不受信任的公网客户端时，建议在 HMAC 之外增加速率限制和访问控制

## 相关文档

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Workers KV](https://developers.cloudflare.com/kv/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Firebase Cloud Messaging HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
- [Upstash QStash](https://upstash.com/docs/qstash/overall/getstarted)
