#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ta-image.py — 一键生图（走本地 shim 的 /v1/images/generations）

用法:
  python ta-image.py "提示词" [输出文件] [尺寸]
例:
  python ta-image.py "一只熊猫在敲代码，扁平插画" D:\\panda.jpg
  python ta-image.py "极简科技风封面" cover.jpg 2048x2048

注意:
  - 平台要求尺寸 >= 3686400 像素（约 1920x1920），默认 2048x2048
  - 返回的是 b64_json（JPEG），脚本会解码后写盘
  - shim 默认监听 8788，可用环境变量 TA_PORT 覆盖
"""
import sys, os, json, base64, urllib.request

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    prompt = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "image.jpg"
    size = sys.argv[3] if len(sys.argv) > 3 else "2048x2048"
    port = os.environ.get("TA_PORT", "8788")

    body = {"prompt": prompt, "size": size}
    req = urllib.request.Request(
        "http://127.0.0.1:%s/v1/images/generations" % port,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        raw = urllib.request.urlopen(req, timeout=600).read()
    except Exception as e:
        msg = ""
        try: msg = e.read().decode("utf-8", "replace")[:400]
        except Exception: pass
        print("生成失败: %s %s" % (e, msg)); sys.exit(2)

    d = json.loads(raw)
    data = d.get("data") or []
    if not data:
        print("返回里没有图片:", json.dumps(d, ensure_ascii=False)[:300]); sys.exit(3)
    b64 = data[0].get("b64_json")
    if not b64:
        print("返回的不是 b64_json:", json.dumps(data[0], ensure_ascii=False)[:300]); sys.exit(3)

    blob = base64.b64decode(b64)
    open(out, "wb").write(blob)
    print("saved: %s (%.2f MB, %s)" % (os.path.abspath(out), len(blob) / 1048576, size))
    u = d.get("usage") or {}
    if u:
        print("usage:", u)

if __name__ == "__main__":
    main()
