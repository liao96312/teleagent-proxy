#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
env-probe.py — 从 TeleAgent 进程内存里捞出内核拿到的关键环境变量（取证用）。
复用 get-session-key.py 的扫内存手法。输出每条 (进程, 变量名, 值)。

用途：确认内核的 OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME / TELEAGENT_CONFIG_DIR 到底指向哪，
      判断「能不能自己注册一个 agent 来换掉系统提示词」。
"""
import ctypes, re, sys, time
from ctypes import wintypes

k32 = ctypes.windll.kernel32

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}
TH32CS_SNAPPROCESS = 0x00000002

WANT = [
    b"OPENCODE_CONFIG_DIR", b"OPENCODE_CONFIG", b"OPENCODE_CONFIG_CONTENT",
    b"XDG_CONFIG_HOME", b"XDG_DATA_HOME", b"XDG_CACHE_HOME",
    b"TELEAGENT_CONFIG_DIR", b"TELEAGENT_DATA_DIR",
    b"USER_AGENT_CONFIG_PATH", b"SUPER_AGENT_APP_CONFIG_DIR", b"SUPER_AGENT_APP_DATA_DIR",
]
PAT = re.compile(rb"(" + b"|".join(WANT) + rb")=([^\x00\r\n]{0,260})")


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


def list_pids():
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return []
    pe = PROCESSENTRY32(); pe.dwSize = ctypes.sizeof(pe)
    out = []
    ok = k32.Process32First(snap, ctypes.byref(pe))
    while ok:
        name = pe.szExeFile.decode('ascii', 'ignore').lower()
        if name in ('node.exe', 'teleagent.exe', 'electron.exe'):
            out.append((pe.th32ProcessID, name))
        ok = k32.Process32Next(snap, ctypes.byref(pe))
    k32.CloseHandle(snap)
    return out


def scan_pid(pid, budget=250 << 20, max_hits=24):
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return []
    addr = 0; mbi = MBI(); buf = ctypes.create_string_buffer(1 << 20)
    nread = ctypes.c_size_t(0); seen = set(); total = 0
    while addr < 0x7FFFFFFFFFFF and total < budget and len(seen) < max_hits:
        if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
            off = 0
            while off < size:
                chunk = min(len(buf), size - off)
                if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nread)):
                    data = buf.raw[:nread.value]; total += len(data)
                    for m in PAT.finditer(data):
                        k = m.group(1).decode('ascii', 'ignore')
                        v = m.group(2).decode('utf-8', 'replace')
                        if k == "OPENCODE_CONFIG_CONTENT":
                            v = "<%d chars>" % len(v)
                        if (k, v) in seen:
                            continue
                        seen.add((k, v))
                off += chunk
        addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return sorted(seen)


if __name__ == '__main__':
    t0 = time.time()
    for pid, name in list_pids():
        if time.time() - t0 > 200:
            sys.stderr.write("[!] 超时\n"); break
        hits = scan_pid(pid)
        if hits:
            print("### %s pid=%d" % (name, pid))
            for k, v in hits:
                print("  %-28s = %s" % (k, v[:240]))
