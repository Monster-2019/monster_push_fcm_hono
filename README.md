```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

## `/send` HMAC 鉴权

`/send` 现在要求带以下请求头：

- `x-timestamp`: Unix 秒级时间戳（例如 `1712750400`）
- `x-signature`: `sha256=` 前缀可选，签名值为 64 位十六进制字符串

签名规则：

```txt
payload = `${x-timestamp}.${rawRequestBody}`
signature = HMAC_SHA256_HEX(payload, HMAC_SECRET)
```

其中 `rawRequestBody` 必须是请求发送时的原始 JSON 字符串（不能先 parse 再 stringify）。
服务端会做 5 分钟窗口校验，超时会返回 `401 Signature expired`。

本地开发请在 `.dev.vars` 里增加：

```txt
HMAC_SECRET=replace_with_your_secret
```

Node.js 调用示例：

```ts
import crypto from "node:crypto";

const body = JSON.stringify({
  message: {
    notification: { title: "Hello", body: "World" },
    webpush: {
      fcm_options: { link: "https://example.com" },
      notification: { icon: "https://example.com/icon.png" },
    },
    data: { messageId: "123" },
  },
  tokens: ["token-a"],
});

const timestamp = Math.floor(Date.now() / 1000).toString();
const payload = `${timestamp}.${body}`;
const signature = crypto
  .createHmac("sha256", process.env.HMAC_SECRET!)
  .update(payload)
  .digest("hex");

await fetch("http://127.0.0.1:8787/send", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-timestamp": timestamp,
    "x-signature": signature,
  },
  body,
});
```
