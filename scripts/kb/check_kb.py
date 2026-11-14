"""Check KB paths and folder indexes locally. Warnings do not fail the command."""

import argparse
from pathlib import Path, PurePosixPath
import re
import subprocess


GENERATED = {"node_modules", "dist", "build", "coverage", "__pycache__", "generated", ".git"}
LINK = re.compile(r"\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)")
CODE = re.compile(r"^\*\*Code:\*\*\s*(.+)$", re.MULTILINE)


def git(root, *args):
    return subprocess.check_output(
        ["git", "-C", str(root), *args], text=True, encoding="utf-8"
    )


def skipped(path):
    return bool(set(PurePosixPath(path).parts) & GENERATED)


def code_paths(text):
    return [path for line in CODE.findall(text) for path in re.findall(r"`([^`]+)`", line)]

def prose(text):
    return re.sub(r"^(`{3,}|~{3,})[^\n]*\n.*?^\1[ \t]*$", "", text, flags=re.MULTILINE | re.DOTALL)


def covered(path, mapped):
    return any(path == item or path.startswith(item.rstrip("/") + "/") for item in mapped)


def changes(root, base):
    records = []
    for args in (
        ("diff", "--name-status", "-z", "-M", f"{base}...HEAD"),
        ("diff", "--name-status", "-z", "-M", "HEAD"),
    ):
        fields = git(root, *args).rstrip("\0").split("\0")
        index = 0
        while index < len(fields) and fields[index]:
            status = fields[index]
            count = 2 if status[0] in {"R", "C"} else 1
            paths = fields[index + 1:index + 1 + count]
            records.append((status[0], paths))
            index += 1 + count
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    records.extend(("A", [path]) for path in untracked.split("\0") if path)
    return records


def check(root, diff=None):
    errors, warnings = [], []
    tracked = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    files = sorted({path for path in tracked.split("\0") if path and not skipped(path)})
    docs = [path for path in files if path.startswith("docs/") and (root / path).is_file()]
    pages = [path for path in docs if path.endswith(".md")]
    mapped = set()
    for page in pages:
        text = prose((root / page).read_text(encoding="utf-8"))
        if not re.match(r"# [^\n]+\n", text):
            errors.append(f"{page}: missing H1 title")
        for field in ("Status", "Last Updated", "Audience", "Last verified"):
            if not re.search(rf"^\*\*{field}:\*\*\s*\S", text, re.MULTILINE):
                errors.append(f"{page}: missing {field}")
        if not re.search(r"^\*\*Status:\*\* (Implemented|Partial|Planned|Superseded)\s*$", text, re.MULTILINE):
            errors.append(f"{page}: invalid Status")
        if not re.search(r"^\*\*Last verified:\*\* \d{4}-\d{2}-\d{2} against [0-9a-f]{7,40}\s*$", text, re.MULTILINE):
            errors.append(f"{page}: invalid Last verified date or SHA")
        for line in CODE.findall(text):
            if not re.findall(r"`([^`]+)`", line):
                errors.append(f"{page}: Code paths must be in backticks")
        for path in code_paths(text):
            mapped.add(path.rstrip("/"))
            target = (root / path).resolve()
            if "\\" in path or "*" in path or not target.is_relative_to(root):
                errors.append(f"{page}: invalid Code path {path}")
            elif not target.exists():
                errors.append(f"{page}: Code path does not exist: {path}")
        for link in LINK.findall(text):
            if "://" in link or link.startswith(("#", "mailto:")):
                continue
            target = (root / page).parent / link.split("#")[0]
            if not target.exists():
                errors.append(f"{page}: dead local link {link}")

    folders = {PurePosixPath(page).parent for page in docs}
    folders |= {parent for folder in list(folders) for parent in folder.parents if str(parent).startswith("docs")}
    for folder in sorted(folders):
        readme = root / str(folder) / "README.md"
        if not readme.is_file():
            errors.append(f"{folder}: missing README.md index")
            continue
        listed = {
            (readme.parent / link.split("#")[0]).resolve()
            for link in LINK.findall(prose(readme.read_text(encoding="utf-8")))
            if "://" not in link and not link.startswith(("#", "mailto:"))
        }
        children = set()
        for file in docs:
            path = PurePosixPath(file)
            if folder not in path.parents:
                continue
            relative = path.relative_to(folder)
            child = root / str(folder) / relative.parts[0]
            if child != readme:
                children.add(child.resolve())
        for child in sorted(children):
            if child not in listed and not (child.is_dir() and (child / "README.md") in listed):
                errors.append(f"{folder}/README.md: missing index entry for {child.relative_to(root).as_posix()}")

    if diff:
        for status, paths in changes(root, diff):
            current = paths[-1]
            if not skipped(current) and not current.startswith("docs/") and not current.endswith(".md"):
                if status != "D" and not covered(current, mapped):
                    warnings.append(f"source has no Code coverage: {current}")
            if status in {"D", "R"} and paths[0] in mapped:
                warnings.append(f"deleted or renamed Code path: {paths[0]}")
    return sorted(set(errors)), sorted(set(warnings))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diff", help="Compare the branch and working tree with this Git ref")
    args = parser.parse_args()
    root = Path(git(Path(__file__).resolve().parents[2], "rev-parse", "--show-toplevel").strip()).resolve()
    try:
        errors, warnings = check(root, args.diff)
    except subprocess.CalledProcessError as error:
        parser.exit(1, f"ERROR: Git command failed: {error}\n")
    for message in errors:
        print(f"ERROR: {message}")
    for message in warnings:
        print(f"WARNING: {message}")
    print(f"KB check: {len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
