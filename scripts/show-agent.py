#!/usr/bin/env python3
"""把某个项目的生成事件打印成人看的样子。用法：show-agent.py <projectId>"""
import json
import sys
import urllib.request

API = "http://127.0.0.1:8800"


def get(path):
    with urllib.request.urlopen(API + path, timeout=60) as r:
        return json.load(r)


def main():
    pid = sys.argv[1]
    d = get(f"/api/projects/{pid}/agent")
    evs = d["events"]

    tools = [e for e in evs if e["type"] == "tool"]
    verifies = [e for e in evs if e["type"] == "verify"]
    dones = [e for e in evs if e["type"] == "done"]
    errors = [e for e in evs if e["type"] == "error"]
    text = "".join(e["text"] for e in evs if e["type"] == "delta")

    print(f"running={d['running']}  事件 {len(evs)} 条")
    print(f"  工具调用 {len(tools)} · verify {len(verifies)} · error {len(errors)}")
    print()

    print("--- 工具调用序列 ---")
    for t in tools:
        print(f"  · {t['name']:<12} {t['detail'][:80]}")

    print()
    print("--- verify ---")
    if not verifies:
        print("  (没有 verify —— 说明闭环没跑起来！)")
    for v in verifies:
        flag = "通过" if v["ok"] else "失败"
        print(f"  #{v['attempt']} {flag}")
        print(f"     {v['detail'][:400]}")

    if errors:
        print()
        print("--- error ---")
        for e in errors:
            print(f"  {e['message'][:400]}")

    if dones:
        e = dones[-1]
        print()
        print(
            f"--- done: ok={e['ok']}  成本=${e['costUsd']:.4f}  "
            f"轮次={e['turns']}  耗时={e['durationMs']/1000:.1f}s"
        )

    if text:
        print()
        print("--- 助手回复 ---")
        print(text[:800])


if __name__ == "__main__":
    main()
