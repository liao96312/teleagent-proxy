#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
setup.py — 一次性初始化：解出 TeleAgent safeStorage 的 AES key 并写入同目录 token.key。
用 TeleAgent 自带的 Python 运行即可，无需额外依赖（只用标准库 + ctypes）。

用法:
  <TeleAgent自带python> setup.py
"""
import os, sys, json, base64, ctypes, ctypes.wintypes
from ctypes import wintypes

HOME = os.environ.get('USERPROFILE') or os.path.expanduser('~')
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('TA_DATA_DIR') or os.path.join(HOME, '.local', 'share', 'TeleAgent')

class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_char))]

def dpapi_unprotect(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    bin_ = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    bout = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(bout)):
        raise OSError("CryptUnprotectData failed: %d" % ctypes.GetLastError())
    out = ctypes.string_at(bout.pbData, bout.cbData)
    ctypes.windll.kernel32.LocalFree(bout.pbData)
    return out

def main():
    ls_path = os.path.join(DATA, 'Local State')
    if not os.path.exists(ls_path):
        print("[!] 找不到 %s —— 请先启动一次 TeleAgent 并登录" % ls_path); sys.exit(1)
    ls = json.load(open(ls_path, encoding='utf-8'))
    ek = base64.b64decode(ls['os_crypt']['encrypted_key'])
    if ek[:5] == b'DPAPI':
        ek = ek[5:]
    key = dpapi_unprotect(ek)
    if len(key) != 32:
        print("[!] AES key 长度异常: %d (期望32)" % len(key)); sys.exit(1)
    hexkey = key.hex()
    open(os.path.join(HERE, 'token.key'), 'w').write(hexkey)
    print("[+] AES key 已写入 token.key")
    print("    key = " + hexkey)

    # 校验能否解 token.json
    users = os.path.join(DATA, 'users')
    accts = [d for d in os.listdir(users)] if os.path.isdir(users) else []
    accts = [d for d in accts if d.startswith('v1_public_')]
    if accts:
        tp = os.path.join(users, accts[0], 'app-auth', 'token.json')
        if os.path.exists(tp):
            tj = json.load(open(tp, encoding='utf-8'))
            b = base64.b64decode(tj['encryptedToken'])
            try:
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # 可选
                pt = AESGCM(key).decrypt(b[3:15], b[15:], b[-16:])
            except Exception:
                # 无 cryptography 时用 Windows CNG 兜底：这里简单跳过，只提示
                print("[i] (未装 cryptography 库，跳过 token 解密校验；shim(Node) 端会自行解密)")
                pt = None
            if pt:
                print("[+] token 解密成功 -> " + pt.decode('utf-8', 'replace')[:24] + "...")
    print("[*] 下一步：运行 start-shim.cmd")

if __name__ == '__main__':
    main()
