"""Let registered third-party viewers (ONLYOFFICE) receive docx/xlsx/pptx.

dsh-better-sidebar 0.24.1 hard-codes HOST_OWNED_EXTS and refuses these formats
so DSH's built-in read-only preview takes them. Drop the three editable Office
formats from that set. Verified against dsh-better-sidebar 0.24.1 only.
"""
import re, sys, pathlib
lib = pathlib.Path(sys.argv[1])
for name in ("client.js", "client-registry.js"):
    f = lib / name
    src = f.read_text(encoding="utf-8")
    m = re.search(r"const HOST_OWNED_EXTS = /\* @__PURE__ \*/ new Set\(\[(.*?)\]\)", src, re.S)
    if not m:
        sys.exit(f"{name}: HOST_OWNED_EXTS not found; plugin version changed")
    body = m.group(1)
    new_body = body
    for ext in ("xlsx", "docx", "pptx"):
        new_body, n = re.subn(rf'\s*"{ext}",?', "", new_body, count=1)
        if n != 1:
            sys.exit(f"{name}: {ext} not in HOST_OWNED_EXTS")
    out = src.replace(body, new_body, 1)
    f.unlink()  # break the pnpm store hard link before writing
    f.write_text(out, encoding="utf-8")
    print(f"patched {name}")
