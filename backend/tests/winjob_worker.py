"""Harmless synthetic worker for Windows Job Object tests. Text only; no media. Usage: MODE SCRATCH [ARG]"""
import json, os, subprocess, sys, time

mode, scratch = sys.argv[1], sys.argv[2]


def write(name, text):
    with open(os.path.join(scratch, name), "w", encoding="utf-8") as handle:
        handle.write(text)


write("started.marker", str(os.getpid()))
SLEEPER = [sys.executable, "-c", "import time; time.sleep(60)"]
BRIEF = [sys.executable, "-c", "import time; time.sleep(3)"]

if mode == "exit":
    sys.exit(int(sys.argv[3]))
elif mode == "sleep":
    time.sleep(60)
elif mode == "mem":
    chunks, total = [], 0
    try:
        while total < 1024:
            chunks.append(bytearray(32 * 1024 * 1024))
            for offset in range(0, len(chunks[-1]), 4096):
                chunks[-1][offset] = 1
            total += 32
    except MemoryError:
        write("result.json", json.dumps({"outcome": "MemoryError", "allocated_mb": total}))
        sys.exit(3)
    write("result.json", json.dumps({"outcome": "allocated_all", "allocated_mb": total}))
elif mode == "cpu":
    while True:
        pass
elif mode == "spawn":
    report = {}
    try:
        report["breakaway"] = "SUCCEEDED pid=%d" % subprocess.Popen(BRIEF, creationflags=0x01000000).pid
    except OSError as error:
        report["breakaway"] = "refused:%s" % error.winerror
    kids = []
    for number in range(3):
        try:
            kids.append(subprocess.Popen(SLEEPER))
            report["child%d" % number] = "started:%d" % kids[-1].pid
        except OSError as error:
            report["child%d" % number] = "refused:%s" % error.winerror
    write("result.json", json.dumps(report))
    time.sleep(60)
elif mode in ("tree", "orphan"):
    kids = [subprocess.Popen(SLEEPER) for _ in range(2)]
    write("pids.json", json.dumps([kid.pid for kid in kids]))
    time.sleep(60 if mode == "tree" else 1.0)
