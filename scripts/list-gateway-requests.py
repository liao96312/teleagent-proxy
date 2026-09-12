import ctypes, re, sys
k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02,0x04,0x20,0x40,0x80}
class MBI(ctypes.Structure):
    _fields_=[("BaseAddress",ctypes.c_ulonglong),("AllocationBase",ctypes.c_ulonglong),
              ("AllocationProtect",ctypes.c_ulong),("RegionSize",ctypes.c_ulonglong),
              ("State",ctypes.c_ulong),("Protect",ctypes.c_ulong),("Type",ctypes.c_ulong)]
pid=int(sys.argv[1])
h=k32.OpenProcess(PQI|PVM,False,pid)
addr,mbi=0,MBI(); buf=ctypes.create_string_buffer(1<<21); nr=ctypes.c_size_t(0)
reqline=re.compile(rb'(POST|GET) (/[^\r\n ]{3,120}) HTTP/1\.1')
runpat=re.compile(rb'X-Teleai-Run-Unit-Type: ([a-z_]+)')
found={}
while addr < 0x7FFFFFFFFFFF:
    if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)): break
    size=mbi.RegionSize
    if mbi.State==MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0<size<(1<<30):
        off=0
        while off<size:
            chunk=min(len(buf), size-off)
            if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress+off), buf, chunk, ctypes.byref(nr)):
                d=buf.raw[:nr.value]
                for m in runpat.finditer(d):
                    # 往前找最近的请求行
                    seg=d[max(0,m.start()-1800):m.start()]
                    rl=None
                    for mm in reqline.finditer(seg): rl=(mm.group(1).decode(),mm.group(2).decode())
                    if not rl: continue
                    # 往后找 body
                    end=d.find(b'\r\n\r\n', m.end())
                    body=re.sub(rb'[^\x20-\x7e]', b'.', d[end+4:end+260]).decode() if end>0 else ''
                    key=(rl[1], m.group(1).decode())
                    if key not in found: found[key]=body[:200]
            off+=chunk
    addr=mbi.BaseAddress+size
k32.CloseHandle(h)
for (path,run),body in sorted(found.items()):
    print("  %-52s run=%-11s %s" % (path, run, body[:120]))
