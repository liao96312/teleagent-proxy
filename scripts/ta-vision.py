#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ta-vision.py — 一键看图（把图片发给本地 shim 的 /v1/chat/completions）

用法:
  python ta-vision.py <图片路径> ["问题"]
例:
  python ta-vision.py D:\\shot.png
  python ta-vision.py D:\\shot.png "这个报错是什么意思？"

说明:
  - shim 检测到图片会自动切 model=vision-standard + X-Teleai-Run-Unit-Type: tool_call
  - 图片最小边 14 像素
  - shim 默认监听 8788，可用环境变量 TA_PORT 覆盖
"""
import sys, os, json, base64, mimetypes, urllib.request

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    path = sys.argv[1]
    question = sys.argv[2] if len(sys.argv) > 2 else "详细描述这张图片的内容。"
    port = os.environ.get("TA_PORT", "8788")

    if not os.path.exists(path):
        print("找不到文件:", path); sys.exit(1)
    mime = mimetypes.guess_type(path)[0] or "image/png"
    b64 = base64.b64encode(open(path, "rb").read()).decode()

    body = {
        "model": "chat-pro",   # shim 会自动换成 vision-standard
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": question},
            {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mime, b64)}},
        ]}],
        "max_tokens": 2000,
    }
    req = urllib.request.Request(
        "http://127.0.0.1:%s/v1/chat/completions" % port,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=600).read())
    except Exception as e:
        msg = ""
        try: msg = e.read().decode("utf-8", "replace")[:400]
        except Exception: pass
        print("调用失败: %s %s" % (e, msg)); sys.exit(2)

    ch = (d.get("choices") or [{}])[0]
    print(ch.get("message", {}).get("content", ""))
    if d.get("usage"):
        print("\n--- usage:", d["usage"])

if __name__ == "__main__":
    main()
