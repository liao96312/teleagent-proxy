#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从内核内存里提取网关请求的 body 结构（顶层 JSON 键 + 片段）"""
import ctypes, re, sys, json
from ctypes import wintypes

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


pid = int(sys.argv[1])
MARK = b'{"max_tokens":'
h = k32.OpenProcess(PQI | PVM, False, pid)
addr, mbi = 0, MBI()
buf = ctypes.create_string_buffer(1 << 21)
nr = ctypes.c_size_t(0)
best = None
while addr < 0x7FFFFFFFFFFF:
    if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
        break
    size = mbi.RegionSize
    if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
        off = 0
        while off < size:
            chunk = min(len(buf), size - off)
            if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nr)):
                d = buf.raw[:nr.value]
                i = d.find(MARK)
                if i >= 0 and (best is None or len(d) - i > len(best)):
                    best = d[i:i + 200000]
            off += chunk
    addr = mbi.BaseAddress + size
k32.CloseHandle(h)

if not best:
    print("[!] 未找到 body"); sys.exit(1)

s = best.decode('utf-8', 'replace')
print("[*] body 起始: " + s[:200].replace('\n', '\\n'))
# 顶层键：扫前若干字符里出现的 "key":  模式（粗粒度）
keys = []
for m in re.finditer(r'"([a-z_]{2,24})":', s[:300000]):
    k = m.group(1)
    if k not in keys:
        keys.append(k)
print("\n[*] 出现的字段名(前40): " + ", ".join(keys[:40]))
print("\n[*] 是否有 tools 定义: %s" % ("是" if '"tools":[' in s or '"tools": [' in s else "否"))
print("[*] 是否有 tool_choice: %s" % ("是" if '"tool_choice"' in s else "否"))
print("[*] 是否有 stream: %s" % ("是" if '"stream"' in s[:2000] else "否"))
for kw in ['"temperature"', '"top_p"', '"stream_options"', '"reasoning_effort"', '"max_tokens"', '"parallel_tool_calls"']:
    if kw in s[:5000]:
        i = s.find(kw)
        print("    %-24s -> %s" % (kw, s[i:i+60].split(',')[0]))
