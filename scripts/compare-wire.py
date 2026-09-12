#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
compare-wire.py — 从两个进程内存里各 dump 一条真实网关请求，逐字段对比头
用法: python compare-wire.py <pidA> <pidB>   # A=内核(基准), B=自己的 shim
"""
import ctypes, re, sys
from ctypes import wintypes

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


MARK = re.compile(rb'POST /superCowork/sapi/api/v1/chat/completions HTTP/1\.1\r\n')


def dump_request(pid):
    """返回内存里最新(isolated 靠后)的一段完整请求头块"""
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        return None
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
                    for m in MARK.finditer(d):
                        blk = d[m.start():m.start() + 6000]
                        end = blk.find(b'\r\n\r\n')
                        if end > 0:
                            blk = blk[:end]
                        if b'X-Superagent-Signature' in blk:
                            best = blk  # 取最后一个命中的
                off += chunk
        addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return best


def parse(blk):
    """-> (request_line, [(name, value), ...]) 保持出现顺序"""
    if not blk:
        return None, []
    txt = blk.decode('utf-8', 'replace')
    lines = txt.split('\r\n')
    req = lines[0]
    out = []
    for ln in lines[1:]:
        if not ln.strip():
            break
        if ':' in ln:
            k, v = ln.split(':', 1)
            out.append((k.strip(), v.strip()))
    return req, out


def main():
    pidA, pidB = int(sys.argv[1]), int(sys.argv[2])
    ra, ha = parse(dump_request(pidA))
    rb, hb = parse(dump_request(pidB))
    if ra is None:
        print("[!] A(内核) 没抓到请求"); return 1
    if rb is None:
        print("[!] B(shim) 没抓到请求"); return 1
    print("A 请求行:", ra)
    print("B 请求行:", rb)
    print("请求行一致:", ra == rb)

    na = [k for k, _ in ha]
    nb = [k for k, _ in hb]
    print("\nA 头顺序(%d): %s" % (len(na), ", ".join(na)))
    print("B 头顺序(%d): %s" % (len(nb), ", ".join(nb)))
    print("\n【顺序完全一致】:", na == nb)

    sa, sb = set(na), set(nb)
    onlyA = [k for k in na if k not in sb]
    onlyB = [k for k in nb if k not in sa]
    print("\n只有 A(内核) 有:", onlyA or "无")
    print("只有 B(shim) 有:", onlyB or "无")

    print("\n--- 逐字段 ---")
    mb = dict(hb)
    for k, v in ha:
        vb = mb.get(k)
        if vb is None:
            print("  [MISS] %-34s A=%s | B=<missing>" % (k, v[:40]))
        else:
            dyn = k in ('X-Superagent-Signature', 'X-Superagent-Timestamp', 'X-Superagent-Nonce',
                        'X-Message-Id', 'X-Request-Id', 'X-Session-Id', 'X-Token',
                        'X-Teleai-Root-Session-Id', 'X-Teleai-Upstream-Request-Id', 'Content-Length')
            if dyn and v != vb:
                print("  [OK  ] %-34s A=%s\n         %-34s B=%s" % (k, v[:64], "", vb[:64]))
            elif v == vb:
                print("  [OK  ] %-34s %s" % (k, v[:60]))
            else:
                print("  [DIFF] %-34s A=%s | B=%s" % (k, v[:30], vb[:30]))
    ma = dict(ha)
    for k, v in hb:
        if k not in ma:
            print("  [EXTRA] %-32s B=%s" % (k, v[:40]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
