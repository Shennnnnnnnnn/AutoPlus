# AutoPlus

自动订阅 Plus 后台。输入 `/api/auth/session` 的 JSON 应答后，后台会：

1. 直接从用户粘贴的 JSON 中读取 `accessToken`，不会再通过浏览器或后台请求 `/api/auth/session`。
2. 调用 `https://chatgpt.com/backend-api/payments/checkout` 创建 hosted PayPal checkout。
3. 参照 `PayPalAutoFiller.js` 自动选择 PayPal、填写美国账单地址、游客卡支付资料、电话和 PayPal 验证码。
4. 如果 PayPal 出现 DataDome/滑块验证码，可选择人工弹窗提示或仅任务日志提示；完成后自动继续。
5. 轮询验证码接收链接，检测到 ChatGPT 支付成功回跳后标记任务完成。

## 启动

```bash
npm start
```

默认地址：`http://127.0.0.1:3217`

## 配置

可通过界面填写，页面会把手机号、卡信息、验证码接收链接等表单项缓存到当前浏览器。也可用环境变量设置本机默认值：

```bash
SMS_URL="https://a.62-us.com/api/get_sms?key=..." \
PAYPAL_PHONE="你的 PayPal 手机号" \
PAYPAL_CARD_NUMBER="你的卡号" \
PAYPAL_CARD_EXPIRY="MM / YY" \
PAYPAL_CARD_CVV="CVV" \
npm start
```

验证码接收链接参考应答：

```text
yes|PayPal: 394662 is your security code. Don't share it.|(PayPal)|到期时间：2026-06-29 00:00:00
```

如 Chrome 不在默认路径，设置 `CHROME_PATH`。设置 `HEADLESS=1` 可使用无头模式。

## API

- `POST /api/jobs`：创建自动订阅任务。
- `POST /api/convert-session`：把 `/api/auth/session` JSON 转换为 Codex session JSON。
- `GET /api/jobs`：查看任务列表。
- `GET /api/jobs/:id`：查看单个任务日志与结果。

`POST /api/jobs` 请求示例：

```json
{
  "gptSession": "{\"accessToken\":\"从 /api/auth/session 应答中取得的 token\"}",
  "smsUrl": "https://a.62-us.com/api/get_sms?key=...",
  "phone": "你的 PayPal 手机号",
  "cardNumber": "你的卡号",
  "cardExpiry": "MM / YY",
  "cardCvv": "CVV",
  "captchaMode": "manual_prompt"
}
```

`captchaMode` 可选值：

- `manual_prompt`：默认。页面弹窗提示并等待人工完成验证码。
- `manual_silent`：仅任务日志提示并等待人工完成验证码。
- `test_assume_solved`：测试模式 `.slider` / `[data-autoplus-test-slider]`

`POST /api/convert-session` 请求示例：

```json
{
  "gptSession": "{\"user\":{\"email\":\"user@example.com\"},\"expires\":\"2026-08-18T10:26:13.095Z\",\"account\":{\"id\":\"acct_123\",\"planType\":\"plus\"},\"accessToken\":\"...\",\"sessionToken\":\"...\"}"
}
```

返回的 `session` 字段会包含 `type: "codex"`、账号信息、原始 `access_token` / `session_token`，以及本地生成的 synthetic `id_token`。
