"""Snapshot the current source plus both data roots before a library migration."""
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
import zipfile

project = Path(sys.argv[1]).resolve(strict=True)
destination = Path(sys.argv[2]).resolve()
if destination == project or project not in destination.parents or any((project / name) == destination or (project / name) in destination.parents for name in ("资料库", "文章库")):
    raise RuntimeError("Backup must stay inside the project, outside both data roots")
destination.mkdir(parents=True, exist_ok=False)
token = str(uuid.uuid4())
lock = project / "资料库" / "worker.lock"
with lock.open("x", encoding="utf-8") as handle:
    json.dump({"pid": os.getpid(), "token": token}, handle)

def entries(roots):
    result = []
    for root in roots:
        if not root.exists():
            continue
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        for file in paths:
            if file.is_symlink() or file.is_junction():
                raise RuntimeError(f"Refusing linked backup input: {file}")
            if file.is_file() and file != lock:
                if project not in file.resolve(strict=True).parents:
                    raise RuntimeError("Backup input outside project")
                result.append(file)
    return sorted(set(result))

def snapshot(name, files):
    output = destination / name
    records = []
    with zipfile.ZipFile(output, "x", allowZip64=True) as archive:
        for number, file in enumerate(files, 1):
            before = file.stat()
            relative = file.relative_to(project).as_posix()
            digest = hashlib.sha256()
            info = zipfile.ZipInfo.from_file(file, relative)
            info.compress_type = zipfile.ZIP_STORED if file.suffix.lower() in {".mp4", ".mov", ".mp3", ".m4a", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".zip", ".heic"} else zipfile.ZIP_DEFLATED
            with file.open("rb") as source, archive.open(info, "w", force_zip64=True) as target:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    target.write(chunk)
            after = file.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise RuntimeError("Source changed during backup")
            records.append({"path": relative, "bytes": before.st_size, "mtimeNs": before.st_mtime_ns, "sha256": digest.hexdigest()})
            if number % 150 == 0:
                print(f"BACKUP {name}: {number}/{len(files)}", flush=True)
    with zipfile.ZipFile(output) as archive:
        if len(archive.infolist()) != len(records):
            raise RuntimeError("Backup inventory count mismatch")
        for record in records:
            digest = hashlib.sha256()
            with archive.open(record["path"]) as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != record["sha256"]:
                raise RuntimeError("Backup readback hash mismatch")
    (destination / f"{Path(name).stem}-清单.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"path": str(output), "files": len(records), "bytes": sum(r["bytes"] for r in records), "verified": True}

try:
    program = project / "程序文件"
    source_roots = [program / name for name in ("src", "tests", "scripts", "docs", "launcher", "legacy", "dist")]
    source_roots += [p for p in program.iterdir() if p.is_file() and p.suffix.lower() in {".json", ".ps1", ".md", ".cmd"} and not p.name.startswith(".")]
    source_roots += [project / name for name in ("README.md", "README.en.md", "CHANGELOG.md", "多平台资料库.exe", "启动多平台资料库.cmd", ".gitignore", ".gitattributes")]
    source = snapshot("整理前源码.zip", entries(source_roots))
    print("SOURCE_SNAPSHOT_READY " + json.dumps(source), flush=True)
    files = entries([project / "资料库", project / "文章库"])
    data = snapshot("整理前完整资料.zip", files)
    inventory = json.loads((destination / "整理前完整资料-清单.json").read_text(encoding="utf-8"))
    for record in inventory:
        stat = (project / record["path"]).stat()
        if (stat.st_size, stat.st_mtime_ns) != (record["bytes"], record["mtimeNs"]):
            raise RuntimeError("A data source changed while the backup was running")
    report = {"project": str(project), "source": source, "data": data, "complete": True}
    (destination / "备份核验.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("BACKUP_VERIFIED " + json.dumps(report), flush=True)
finally:
    if lock.exists() and json.loads(lock.read_text(encoding="utf-8")).get("token") == token:
        lock.unlink()
