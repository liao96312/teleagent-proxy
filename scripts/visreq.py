import ctypes, re, sys
k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02,0x04,0x20,0x40,0x80}
class MBI(ctypes.Structure):
    _fields_=[("BaseAddress",ctypes.c_ulonglong),("AllocationBase",ctypes.c_ulonglong),
              ("AllocationProtect",ctypes.c_ulong),("RegionSize",ctypes.c_ulonglong),
              ("State",ctypes.c_ulong),("Protect",ctypes.c_ulong),("Type",ctypes.c_ulong)]
h=k32.OpenProcess(PQI|PVM,False,26832)
addr,mbi=0,MBI(); buf=ctypes.create_string_buffer(1<<21); nr=ctypes.c_size_t(0)
best=None
while addr < 0x7FFFFFFFFFFF:
    if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)): break
    size=mbi.RegionSize
    if mbi.State==MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0<size<(1<<30):
        off=0
        while off<size:
            chunk=min(len(buf), size-off)
            if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress+off), buf, chunk, ctypes.byref(nr)):
                d=buf.raw[:nr.value]
                for m in re.finditer(rb'\{"messages":\[\{"', d):
                    seg=d[m.start():m.start()+3000]
                    if b'image' in seg or b'base64' in seg:
                        best=seg if best is None else best
            off+=chunk
    addr=mbi.BaseAddress+size
k32.CloseHandle(h)
if best:
    t=re.sub(rb'[^\x09\x0a\x0d\x20-\x7e]', b'.', best).decode()
    print(t[:2200])
else:
    print("未找到")
