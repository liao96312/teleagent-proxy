#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
scan-gateway-req.py — 从 TeleAgent 内核进程内存里 dump 真实发往云网关的请求（头 + body 片段）

原理：Go 的 http.Transport 会把出站请求序列化成原始 wire 字节（含 \r\n 分隔的头块），
      这块内存在发送后短时间内仍留在堆上，扫出来即可逐字比对。

用法:
  python scan-gateway-req.py            # 自动找内核进程（监听 4397 的那个）
  python scan-gateway-req.py <pid>
"""
import ctypes, re, sys, os
from ctypes import wintypes

k32 = ctypes.windll.kernel32
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}
TH32CS_SNAPPROCESS = 0x00000002


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260)]


SIG = re.compile(rb'\r\nX-Superagent-Signature: ([0-9a-f]{64})\r\n')
GATEWAY_HOST = b'agent.teleai.com.cn'


def find_kernel_pid():
    """找监听 4397 的进程（用 netstat，避免 ctypes 太深）"""
    import subprocess
    try:
        out = subprocess.check_output(['netstat', '-ano'], stderr=subprocess.DEVNULL).decode('utf-8', 'ignore')
        for line in out.splitlines():
            if ':4397 ' in line and 'LISTENING' in line:
                return int(line.split()[-1])
    except Exception:
        pass
    return None


def scan(pid):
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        print("[!] OpenProcess 失败（试管理员）"); return []
    addr = 0
    mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21)
    nread = ctypes.c_size_t(0)
    hits = []
    while addr < 0x7FFFFFFFFFFF:
        if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
            off = 0
            while off < size:
                chunk = min(len(buf), size - off)
                if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nread)):
                    data = buf.raw[:nread.value]
                    if GATEWAY_HOST in data or b'X-Superagent-Signature' in data:
                        for m in SIG.finditer(data):
                            a = max(0, m.start() - 3000)
                            b = min(len(data), m.end() + 1500)
                            hits.append(data[a:b])
                off += chunk
        addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return hits


def clean(blob):
    """把原始字节转成可读文本（保留 \r\n）"""
    return blob.decode('utf-8', 'replace')


def main():
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else find_kernel_pid()
    if not pid:
        print("[!] 找不到内核进程，请手动传 pid"); return 1
    print("[*] 内核 pid = %d" % pid)
    hits = scan(pid)
    print("[*] 命中 %d 处" % len(hits))
    seen = set()
    for i, blob in enumerate(hits[:6]):
        t = clean(blob)
        # 只保留可打印区（找请求起始）
        k = t.find('POST /')
        if k < 0:
            k = t.find('X-Superagent-Signature')
            k = max(0, k - 1500)
        seg = t[k:k + 4000]
        key = seg[:200]
        if key in seen:
            continue
        seen.add(key)
        print("\n" + "=" * 78)
        print("### 命中 #%d" % (i + 1))
        print("=" * 78)
        print(re.sub(r'[^\x09\x0a\x0d\x20-\x7e]', '·', seg))
    return 0


if __name__ == '__main__':
    sys.exit(main())
