#!/usr/bin/env python3
"""scan.py — 找出「写过、但还没登记」的脚本。

只读：不移动、不删除、不改任何被扫的文件。唯一会写的只有 store 里的 `.seen.json`
（扫描基线），而且只在 `--ack` 时写。

    scan.py                       # 基线之后新出现的脚本
    scan.py --all                 # 全列（含基线里的）
    scan.py --ack                 # 把当前看到的全部记为「看过」
    scan.py --print-roots         # 看当前生效的扫描根（JSON）
    scan.py --add-root ~/proj:3   # 临时追加一个根（可重复）
    scan.py --roots ~/a ~/b       # 只用这几个根
    scan.py --json / --md / --check / --days 7

扫描根从三处合并，同一个绝对路径只留一次（取更深的那个）：

  1. 本文件里的 DEFAULT_ROOTS（默认空，发行版不带任何机器相关路径）
  2. `--store` 目录下的 `roots.json`
  3. 命令行 `--roots` / `--add-root`

`roots.json` 长这样，`depth` 是往下扫几层：

    { "roots": [ { "path": "~/Documents/work", "depth": 2 }, "~/Downloads/x:3" ] }
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

HOME = Path.home()
HERE = Path(__file__).resolve().parent

# 发行版不带任何机器相关路径：机器自己的根目录写进 <store>/roots.json。
DEFAULT_ROOTS: list[tuple[Path, int]] = []

SUFFIXES = {".py", ".sh", ".command", ".mjs", ".js", ".ts", ".swift"}

# 路径里出现这些片段就整棵剪掉：第三方、构建产物、虚拟环境、插件源码
# （插件有自己的 registry —— plugin_manager，不归这本账管）。
PRUNE = (
    "/node_modules/", "/.git/", "/.venv/", "/venv/", "/__pycache__/",
    "/uv-", "/site-packages/", "/dist/", "/build/", "/.next/", "/.cache/",
    "/vendor/", "/plugins/", "/public/vendor/", "/ts/editor/public/",
    "/Library/", "/.dsh-plugin-cache/",
    # 第三方 Python 包 / 下载来的二进制，不是「我写的」：
    "/lib/", "/libs/", "/bin/",
)

MAX_DEPTH = 6

# 由 main() 设置：记录与基线都放在这里。
STORE = HERE.parent


def expand(value: str) -> Path:
    return Path(os.path.expanduser(str(value)))


def short(p: Path) -> str:
    try:
        return "~/" + str(Path(p).relative_to(HOME))
    except ValueError:
        return str(p)


def index_path() -> Path:
    return STORE / "INDEX.md"


def baseline_path() -> Path:
    return STORE / ".seen.json"


def pruned(path: Path) -> bool:
    s = str(path) + "/"
    return any(frag in s for frag in PRUNE)


def walk(root: Path, max_depth: int):
    root_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        cur = Path(dirpath)
        depth = len(cur.parts) - root_depth
        if depth >= max_depth:
            dirnames[:] = []
        else:
            dirnames[:] = [
                d for d in dirnames
                if not d.startswith(".") and not pruned(cur / d)
            ]
        for fn in filenames:
            if fn.startswith("."):
                continue
            p = cur / fn
            if p.suffix.lower() in SUFFIXES:
                yield p


def parse_root_spec(value, default_depth: int = 2):
    """`~/x` / `~/x:3` / {"path": "~/x", "depth": 3} → (Path, depth)。"""
    if isinstance(value, dict):
        path = value.get("path")
        depth = value.get("depth", default_depth)
        if not isinstance(path, str) or path == "":
            return None
        try:
            depth = int(depth)
        except (TypeError, ValueError):
            depth = default_depth
        return expand(path), depth

    text = str(value).strip()
    if text == "":
        return None
    if ":" in text:
        head, _, tail = text.rpartition(":")
        if head and tail.isdigit():
            return expand(head), int(tail)
    return expand(text), default_depth


def roots_from_file() -> list[tuple[Path, int]]:
    path = STORE / "roots.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("roots", []) if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        parsed = parse_root_spec(item)
        if parsed is not None:
            out.append(parsed)
    return out


def merge_roots(groups):
    """同一条绝对路径只留一份；重复时取更深的那个。"""
    merged: dict[str, tuple[Path, int]] = {}
    for group in groups:
        for path, depth in group:
            key = str(path)
            if key in merged:
                merged[key] = (path, max(merged[key][1], depth))
            else:
                merged[key] = (path, depth)
    return list(merged.values())


def load_baseline() -> set[str]:
    try:
        data = json.loads(baseline_path().read_text(encoding="utf-8"))
        return set(data.get("files", []))
    except (OSError, ValueError):
        return set()


def save_baseline(files: set[str]) -> None:
    target = baseline_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps({"updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "files": sorted(files)},
                   ensure_ascii=False, indent=0),
        encoding="utf-8",
    )


def load_index_text() -> str:
    try:
        return index_path().read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def human(n: float) -> str:
    for unit in ("B", "K", "M"):
        if n < 1024:
            return f"{n:.0f}{unit}"
        n /= 1024
    return f"{n:.0f}G"


def main(argv=None) -> int:
    global STORE

    ap = argparse.ArgumentParser(description="列出散落各处的脚本，标出还没登记的")
    ap.add_argument("--store", default=None,
                    help="记录目录（registry.json / .seen.json 所在），默认是本脚本的父目录")
    ap.add_argument("--roots", nargs="*", help="只用这几个根，忽略 roots.json")
    ap.add_argument("--add-root", action="append", default=[],
                    help="追加一个根，可写 path:depth（可重复）")
    ap.add_argument("--all", action="store_true", help="连基线里的一起列")
    ap.add_argument("--days", type=int, default=0, help="只看最近 N 天修改过的")
    ap.add_argument("--md", action="store_true", help="输出 markdown 表格行")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--ack", action="store_true", help="把当前全部记为已看过（更新基线）")
    ap.add_argument("--check", action="store_true", help="有新增时退出码 1")
    ap.add_argument("--max-depth", type=int, default=None, help="覆盖每个根各自的深度")
    ap.add_argument("--print-roots", action="store_true", help="只打印生效的根目录（JSON）")
    args = ap.parse_args(argv)

    if args.store:
        STORE = expand(args.store)

    cli_roots = [parse_root_spec(r, args.max_depth or 2) for r in args.roots] if args.roots else []
    if args.roots:
        # 显式 --roots 时忽略 roots.json 和 DEFAULT_ROOTS
        roots = merge_roots([cli_roots])
    else:
        file_roots = roots_from_file()
        if args.max_depth:
            file_roots = [(p, args.max_depth) for p, _ in file_roots]
        add_roots = [parse_root_spec(r, 2) for r in args.add_root]
        roots = merge_roots([
            DEFAULT_ROOTS,
            file_roots,
            [(p, d) for p, d in add_roots if p is not None],
        ])

    if args.print_roots:
        print(json.dumps([{"path": short(p), "abs": str(p), "depth": d} for p, d in roots],
                         ensure_ascii=False, indent=2))
        return 0

    baseline = load_baseline()
    has_baseline = bool(baseline)
    index_text = load_index_text()
    cutoff = time.time() - args.days * 86400 if args.days else 0

    rows, skipped, totals, all_paths = [], [], {}, set()
    for root, depth in roots:
        if not root.is_dir():
            skipped.append(short(root))
            continue
        seen = new = 0
        for p in walk(root, depth):
            key = short(p)
            all_paths.add(key)
            try:
                st = p.stat()
            except OSError:
                continue
            if cutoff and st.st_mtime < cutoff:
                continue
            seen += 1
            is_new = key not in baseline
            new += is_new
            if args.all or is_new:
                rows.append({
                    "path": key,
                    "root": short(root),
                    "rel": str(p.relative_to(root)),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "new": is_new,
                    "registered": p.name in index_text or str(p.relative_to(root)) in index_text,
                })
        totals[short(root)] = (seen, new)

    rows.sort(key=lambda r: r["mtime"], reverse=True)

    if args.ack:
        merged = baseline | all_paths
        save_baseline(merged)
        print(f"基线已更新：{len(merged)} 个文件 -> {short(baseline_path())}")
        return 0

    if args.json:
        print(json.dumps({"totals": totals, "skipped": skipped, "rows": rows},
                         ensure_ascii=False, indent=2))
        return 1 if (args.check and any(r["new"] for r in rows)) else 0

    print(f"STORE   {short(STORE)}")
    print(f"基线    {short(baseline_path())}  ({'有' if has_baseline else '还没有 —— 这次全部算新的'})")
    if not roots:
        print("  没有任何扫描根：写 <store>/roots.json，或用 --add-root。")
    for root, (seen, new) in totals.items():
        print(f"  {root}  {seen} 个{'，新增 %d' % new if new else ''}")
    if skipped:
        print(f"  跳过（目录不存在）: {', '.join(skipped)}")
    print()

    if args.md:
        print("| 文件 | 大小 | 最后修改 | 路径 |")
        print("|---|---|---|---|")
        for r in rows:
            print(f"| `{r['rel']}` | {human(r['size'])} | "
                  f"{time.strftime('%Y-%m-%d', time.localtime(r['mtime']))} | `{r['path']}` |")
    else:
        for r in rows:
            mark = ("❓" if not r["new"] else "✳") if not r["registered"] else " "
            date = time.strftime("%Y-%m-%d", time.localtime(r["mtime"]))
            print(f"{mark} {date}  {human(r['size']):>6}  {r['path']}")
        print()
        missing = sum(1 for r in rows if not r["registered"])
        if not has_baseline:
            print("第一次跑：上面是全部。挑值得长期留的写进 registry / INDEX.md，")
            print("然后 `scan.py --ack` 建立基线 —— 以后就只报新增了。")
        elif missing:
            print(f"{missing} 个没写进登记簿。补完再跑一遍就干净了。")
        else:
            print("都登记过了。")

    return 1 if (args.check and any(r["new"] for r in rows)) else 0


if __name__ == "__main__":
    sys.exit(main())
