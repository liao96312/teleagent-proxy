#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
get-session-key.py — 从 TeleAgent 进程内存中取出 App 本地会话密钥 (SUPER_AGENT_LOCAL_SESSION_KEY)
输出：写入同目录 session.key（43 字符 base64url）

原理：TeleAgent 启动时由 Electron 主进程生成 32 字节随机密钥，base64url 后
      作为环境变量 SUPER_AGENT_LOCAL_SESSION_KEY 传给子进程（scheduler / im-service 等 node 进程）。
      环境块在进程内存里，扫出来即可。
"""
import ctypes, re, sys, os, time
from ctypes import wintypes

k32 = ctypes.windll.kernel32
HERE = os.path.dirname(os.path.abspath(__file__))

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

PAT = re.compile(rb'SUPER_AGENT_LOCAL_SESSION_KEY=([A-Za-z0-9_\-]{20,120})')


def list_pids():
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return []
    pe = PROCESSENTRY32()
    pe.dwSize = ctypes.sizeof(pe)
    out = []
    ok = k32.Process32First(snap, ctypes.byref(pe))
    while ok:
        name = pe.szExeFile.decode('ascii', 'ignore').lower()
        if name in ('node.exe', 'teleagent.exe', 'electron.exe'):
            out.append((pe.th32ProcessID, name))
        ok = k32.Process32Next(snap, ctypes.byref(pe))
    k32.CloseHandle(snap)
    return out


def scan_pid(pid, budget_bytes=400 << 20):
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return None
    addr = 0
    mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 20)
    nread = ctypes.c_size_t(0)
    got = None
    total = 0
    while addr < 0x7FFFFFFFFFFF and total < budget_bytes:
        if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
            off = 0
            while off < size:
                chunk = min(len(buf), size - off)
                if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nread)):
                    data = buf.raw[:nread.value]
                    total += len(data)
                    m = PAT.search(data)
                    if m:
                        got = m.group(1).decode('ascii', 'ignore')
                        break
                off += chunk
            if got:
                break
        addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return got


def main():
    t0 = time.time()
    procs = list_pids()
    sys.stderr.write("[*] 候选进程: %s\n" % (", ".join("%s(%d)" % (n, p) for p, n in procs) or "无"))
    for pid, name in procs:
        if time.time() - t0 > 240:
            sys.stderr.write("[!] 超时\n")
            break
        key = scan_pid(pid)
        if key:
            out = os.path.join(HERE, 'session.key')
            open(out, 'w').write(key)
            print(key)
            sys.stderr.write("[+] 找到 sessionKey（来自 %s pid=%d），已写入 session.key\n" % (name, pid))
            return 0
    sys.stderr.write("[!] 未找到。请确认 TeleAgent 正在运行并已登录。\n")
    return 1


if __name__ == '__main__':
    sys.exit(main())
