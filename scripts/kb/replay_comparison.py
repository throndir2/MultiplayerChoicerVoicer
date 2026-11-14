"""Replay five KB lookups using pre-task docs, with original source reads retained."""

import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
MAP = {
    1: ["apps/web/src/App.tsx", "apps/server/src/main.ts"],
    2: ["apps/server/src/packs/discover.ts", "apps/server/src/packs/godot-config.ts"],
    3: ["apps/server/src/catalog", "apps/server/src/packs/pack-service.ts", "apps/server/src/rooms/uploads.ts"],
    4: ["apps/server/src/packs", "apps/server/src/rooms/uploads.ts", "packages/shared/src/types.ts"],
    5: ["apps/server/src/rooms/room-service.ts", "apps/server/src/util/ids.ts"],
    6: ["apps/server/src/rooms/room-service.ts", "packages/shared/src/types.ts"],
    7: ["apps/web/src/room/Recorder.tsx", "apps/web/src/room/RecordingView.tsx",
        "apps/web/src/lib/audio.ts", "apps/web/src/lib/microphone.ts", "packages/shared/src/logic.ts"],
    8: ["apps/web/src/room/DubPlayer.tsx", "apps/web/src/room/PlaybackView.tsx",
        "apps/server/src/rooms/room-service.ts", "apps/server/src/util/media.ts"],
    9: ["apps/web/src/lib/assets.ts", "apps/web/src/lib/preload.ts", "apps/web/src/lib/storage.ts"],
    10: ["apps/server/src/main.ts", "packages/shared/src"],
    11: ["Dockerfile", "deploy/compose.yaml", "scripts/deploy-nahida.ps1"],
}


def run(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, encoding="utf-8", errors="strict")


def kb(npx, snapshot, *args):
    return run([npx, "-y", "github:throndir2/repo-kb", *args, "--repo", str(snapshot)])


def snapshot_docs(snapshot, before):
    sha = run(["git", "rev-parse", before]).strip()
    old = run(["git", "show", f"{sha}:docs/plan.md"])
    run(["git", "init", "-q", str(snapshot)])
    run(["git", "-C", str(snapshot), "remote", "add", "origin",
         "https://github.com/throndir2/MultiplayerChoicerVoicer.git"])
    docs = snapshot / "docs"
    docs.mkdir()
    paths = {}
    # Only restructure old chapters and add location maps. No current doc text or fix details enter the replay.
    for chapter in re.split(r"(?=^## \d+\.)", old, flags=re.MULTILINE):
        heading = re.match(r"## (\d+)\. ([^\n]+)\n", chapter)
        if not heading:
            continue
        number = int(heading[1])
        code = MAP.get(number, [])
        for path in code:
            run(["git", "cat-file", "-e", f"{sha}:{path}"])
        file = f"docs/chapter-{number}.md"
        paths[number] = file
        title = heading[2]
        header = f"# {title}\n\n"
        if code:
            header += "**Code:** " + ", ".join(f"`{path}`" for path in code) + "\n\n"
        (snapshot / file).write_text(header + chapter[heading.end():], encoding="utf-8")
    return sha, paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Generated result JSON outside the repository")
    args = parser.parse_args()
    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if not npx:
        parser.error("npx must be on PATH")
    cases = json.loads((ROOT / "docs/repo-kb-comparison.json").read_text(encoding="utf-8"))
    results = []
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="repo-kb-replay-", dir=args.output.parent) as work:
        for index, case in enumerate(cases):
            snapshot = Path(work) / str(index)
            sha, paths = snapshot_docs(snapshot, case["before"])
            kb(npx, snapshot, "index")
            search_text = kb(npx, snapshot, "search", case["query"], "--top", "3", "--json")
            search = json.loads(search_text)
            expected = paths[case["expected_chapter"]]
            found = [item["path"] for item in search["results"]]
            if expected not in found:
                raise RuntimeError(f"{case['name']}: expected historical chapter is not in top three: {found}")
            # Read the complete historical chapter, including Code paths. Charge every additional lookup.
            read_text = kb(npx, snapshot, "read", expected, "--line", "1")
            rank = found.index(expected) + 1
            other_chars = sum(len(kb(npx, snapshot, "read", path, "--line", "1"))
                              for path in found[:rank - 1])
            kb_calls = 1 + rank
            kb_chars = len(search_text) + len(read_text) + other_chars
            source_chars = case["source_chars"] or sum(case["source_char_parts"])
            routing_chars = sum(value or 0 for value in case["routing_chars"])
            routing_calls = case.get("routing_calls", len(case["routing_chars"]))
            original_calls = case["source_calls"] + routing_calls
            original_chars = source_chars + routing_chars
            proposed_calls = case["source_calls"] + kb_calls
            proposed_chars = source_chars + kb_chars
            row = {
                "name": case["name"], "before_sha": sha,
                "original_calls": original_calls, "retained_source_calls": case["source_calls"],
                "kb_calls": kb_calls, "estimated_calls": proposed_calls,
                "original_available_chars": original_chars, "retained_source_chars": source_chars,
                "measured_kb_chars": kb_chars, "estimated_chars": proposed_chars,
                "original_token_estimate": math.ceil(original_chars / 4),
                "kb_token_estimate": math.ceil(proposed_chars / 4),
                "rank": rank, "mode": search["mode"], "expected": expected,
                "missing_output_calls": sum(value is None for value in case["routing_chars"]),
            }
            results.append(row)
            print(json.dumps(row))
    totals = {
        key: sum(row[key] for row in results)
        for key in ("original_calls", "estimated_calls", "original_available_chars", "estimated_chars")
    }
    totals["call_reduction_percent"] = round(100 * (1 - totals["estimated_calls"] / totals["original_calls"]), 1)
    totals["text_reduction_percent"] = round(100 * (1 - totals["estimated_chars"] / totals["original_available_chars"]), 1)
    args.output.write_text(json.dumps({"cases": results, "totals": totals}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
