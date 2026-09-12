# 生图 / 视觉（内核工具，可独立调用）

内核自带三个相关工具：**`ImageGen`**（文生图）、**`ImageGenWithRef`**（图生图）、**`image_understanding`**（视觉）。

它们**都走同一个云网关、用同一套 `X-Superagent-*` 签名**，所以本仓库的 shim 可以直接把它们暴露出来。
不需要任何新密钥 —— 还是同一个账号、同一套签名。

---

## 1. 生图 / 图生图

### 1.1 内核真实请求（进程内存 dump）

```
POST /superCowork/sapi/api/v1/images/generations HTTP/1.1
Host: agent.teleai.com.cn
User-Agent: Go-http-client/1.1                 ← 默认 Go UA（不是 super-agent/1.0）
Content-Length: 305
Content-Type: application/json
X-App-Version: 2.5.0
X-Message-Id / X-Request-Id / X-Route-Target / X-Session-Id
X-Superagent-Device-Id / Install-Id / Nonce / Sign-Version / Signature / Timestamp
X-Teleai-Client-Type: desktop
X-Teleai-Root-Session-Id
X-Teleai-Run-Unit-Type: tool_call              ← 关键差异
X-Teleai-Upstream-Request-Id
X-Token: <tenant>:<JWT>
Accept-Encoding: gzip

{"model":"image-generation-pro","prompt":"...","response_format":"b64_json","seed":-1,
 "sequential_image_generation":"disabled","size":"2048x2048","stream":false,"watermark":false}
```

**注意**：这个端点**没有** `Authorization: Bearer sk-...`，也**没有** `Accept` / `Cache-Control` / `Connection`。
（与聊天端点不同，别照抄聊天那套头。）

### 1.2 返回值
```jsonc
{
  "created": 1789181672,
  "data": [ { "b64_json": "/9j/4AAQ...", "size": "2048x2048" } ],
  "model": "image-generation-pro",
  "usage": { "generated_images": 1, "output_tokens": 16384, "total_tokens": 16384 }
}
```
`b64_json` 解出来是 **JPEG**（以 `/9j/` 开头）。

### 1.3 限制
- **尺寸下限：3686400 像素**（≈1920×1920）。`1024x1024` 会被拒：
  `The parameter 'size' ... must be at least 3686400 pixels`。用 `2048x2048` 最稳。
- 参数 `sequential_image_generation`（火山 Seedream 的连续生图）默认 `disabled`。
- `watermark: false` —— 但平台仍会加 **C2PA 元数据**（图里能看到 `c2pa` 段），所以生成图仍可溯源为 AI 生成。

### 1.4 图生图
内核用 `ImageGenWithRef`（工具名），端点相同。本仓库 shim 的做法是**保留客户端传来的额外字段**，
所以只要把参考图按平台字段塞进 body 就能走图生图（字段名以真机抓包为准）。

---

## 2. 视觉（图片理解）

### 2.1 内核真实请求

端点就是**聊天端点**，靠 `Run-Unit-Type` 和 **model** 区分：

```
POST /superCowork/sapi/api/v1/chat/completions
X-Teleai-Run-Unit-Type: tool_call

{"messages":[{"content":[
    {"text":"...","type":"text"},
    {"image_url":{"url":"data:image/png;base64,iVBORw0..."},"type":"image_url"}
  ],"role":"user"}],
 "model":"vision-standard",          ← 关键：不是 chat-pro
 "temperature":0.2}
```

**两个关键点**：
1. `model` = **`vision-standard`**（内核的 `image_understanding` 专用模型）
2. `X-Teleai-Run-Unit-Type` = **`tool_call`**

> 实测：只把 run-unit-type 改成 tool_call、模型仍用 chat-pro → 模型回答"我看不到图片"。
> 必须同时换成 `vision-standard` 才生效。

### 2.2 限制
- **图片最小边 14 像素**（8×8 会被拒：`Image dimensions are too small`）。
- 图片以 `data:image/png;base64,...` 形式内联。

---

## 3. 本仓库 shim 的实现

Go 版（`scripts/go/main.go`）：

| 能力 | 路由 | 行为 |
|---|---|---|
| 生图 | `POST /v1/images/generations` | 保留客户端字段 → 强制 `model=image-generation-pro` / `response_format=b64_json` / `seed=-1` / `sequential_image_generation=disabled` / `stream=false` / `watermark=false` / 默认 `size=2048x2048` → 转发到平台端点 |
| 视觉 | `POST /v1/chat/completions` 且 messages 里含 `image_url` | 自动 `model=vision-standard`（temperature 缺省补 0.2）+ `X-Teleai-Run-Unit-Type: tool_call` |
| 普通聊天 | 同上，无图 | 原样转发，`agent_loop` |

### 用法
```bash
# 生图
curl -X POST http://127.0.0.1:8788/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一只熊猫在敲代码，扁平插画","size":"2048x2048"}'

# 视觉（标准 OpenAI 多模态格式）
curl http://127.0.0.1:8788/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model":"chat-pro",
  "messages":[{"role":"user","content":[
     {"type":"text","text":"这张图是什么？"},
     {"type":"image_url","image_url":{"url":"data:image/png;base64,<BASE64>"}}]}],
  "max_tokens":200}'
```

Python（OpenAI SDK）：
```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="teleagent")

r = c.images.generate(prompt="一只熊猫在敲代码", size="2048x2048", response_format="b64_json")
open("out.jpg","wb").write(__import__("base64").b64decode(r.data[0].b64_json))

import base64
b64 = base64.b64encode(open("out.jpg","rb").read()).decode()
print(c.chat.completions.create(model="chat-pro", messages=[{"role":"user","content":[
    {"type":"text","text":"描述这张图"},
    {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+b64}}]}]).choices[0].message.content)
```

### 模型清单（`/v1/models` 会一起返回）
`chat-pro` / `chat-lite` / `chat-flash` / `image-generation-pro`（生图）/ `vision-standard`（视觉，内部使用）

---

## 4. 说明

- 这三个能力和聊天**共用同一个账号与签名**，所以**风控风险性质相同**（不多不少）。
- 平台侧仍能在网关看到：`X-Teleai-Run-Unit-Type: tool_call` + `model=image-generation-pro`/`vision-standard`
  —— 这些都是**真实内核也会发的值**，所以不构成额外特征。
