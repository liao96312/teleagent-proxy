#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
randomize-fingerprint.py — 随机化 TeleAgent 的设备指纹

背景（实测结论）：
  deviceId / installId 存在 app-auth/device-meta.json，**不是硬件派生**，
  App 与内核都直接信任这个文件的值，并把它放进每个请求的
  X-Superagent-Device-Id / X-Superagent-Install-Id 头里。

  实测：改掉后重启 App，文件不会被改回，内核内存里旧 deviceId 彻底消失。

用法:
  python randomize-fingerprint.py            # 随机生成新指纹（会自动备份）
  python randomize-fingerprint.py --show     # 只看当前值
  python randomize-fingerprint.py --restore  # 从备份恢复
  python randomize-fingerprint.py --rotate-generation   # 连 install generation 一起换（会强制重新登录）

注意:
  1. 改完必须**重启 TeleAgent** 才生效（内核启动时读取一次）。
  2. 也要重启 shim（它读同一个文件）。
  3. 同一台机器上的多个账号如果共用指纹，平台侧就能把它们关联起来；
     换号时建议一并换指纹。
  4. 这只改 deviceId/installId。MAC / Windows 序列号 / hostname 等
     本地采集项无法用本脚本改（目前未观测到它们被上传）。
"""
import os, sys, json, uuid, shutil, random, datetime

DATA = os.path.join(os.environ.get('USERPROFILE') or os.path.expanduser('~'),
                    '.local', 'share', 'TeleAgent')
META = os.path.join(DATA, 'app-auth', 'device-meta.json')
RECEIPT = os.path.join(DATA, 'app-auth', 'install-receipt.json')


def show():
    try:
        print("当前 device-meta.json:")
        print(open(META, encoding='utf-8').read())
    except Exception as e:
        print("读取失败:", e)
    try:
        r = json.load(open(RECEIPT, encoding='utf-8'))
        print("install-receipt generation:", r.get('generation'), "| updatedAt:", r.get('updatedAt'))
    except Exception:
        pass


def backup():
    if not os.path.exists(META):
        return None
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    dst = META + '.bak-' + ts
    shutil.copy2(META, dst)
    return dst


def randomize():
    if not os.path.exists(META):
        print("[!] 找不到", META, "—— 请先运行一次 TeleAgent 并登录")
        return 1
    bk = backup()
    if bk:
        print("[+] 已备份 ->", os.path.basename(bk))

    device_id = ''.join(random.choice('0123456789abcdef') for _ in range(12))  # 12 位 hex，与内核同形
    install_id = str(uuid.uuid4())
    payload = {"deviceId": device_id, "installId": install_id}
    os.makedirs(os.path.dirname(META), exist_ok=True)
    with open(META, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    print("[+] 新指纹已写入:", META)
    print("    deviceId  =", device_id)
    print("    installId =", install_id)

    # install-receipt 的 generation 轮换是**可选**的：
    # 日志实测 [InstallGeneration] "Install generation changed, forcing re-login"
    # —— 轮换会触发强制重新登录，所以默认不动。
    if '--rotate-generation' not in sys.argv:
        print("[i] install generation 未改动（加 --rotate-generation 才会轮换，注意会强制重新登录）")
        print()
        print("!! 现在请重启 TeleAgent（内核启动时只读一次），以及重启 shim。")
        return 0
    try:
        r = json.load(open(RECEIPT, encoding='utf-8'))
        old = r.get('generation')
        r['generation'] = 'fresh:{%s}' % str(uuid.uuid4()).upper()
        r['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        with open(RECEIPT, 'w', encoding='utf-8') as f:
            json.dump(r, f, indent=2)
        print("[+] install generation 已轮换:", old, "->", r['generation'])
    except Exception as e:
        print("[i] install-receipt 未改动:", e)

    print()
    print("!! 现在请重启 TeleAgent（内核启动时只读一次），以及重启 shim。")
    return 0


def restore():
    cands = [f for f in os.listdir(os.path.dirname(META)) if f.startswith('device-meta.json.bak-')]
    if not cands:
        print("[!] 没有备份")
        return 1
    latest = sorted(cands)[-1]
    shutil.copy2(os.path.join(os.path.dirname(META), latest), META)
    print("[+] 已从", latest, "恢复")
    return 0


if __name__ == '__main__':
    if '--show' in sys.argv:
        show()
    elif '--restore' in sys.argv:
        sys.exit(restore())
    else:
        sys.exit(randomize())
