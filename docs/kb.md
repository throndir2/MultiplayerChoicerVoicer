# Knowledge base contract

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against 1a5bee6
**Code:** `.github/mcp.json`, `AGENTS.md`, `.github/copilot-instructions.md`, `scripts/kb/check_kb.py`, `scripts/kb/test_check_kb.py`

## Knowledge Base First

The knowledge base (KB) is the Markdown documentation under `docs/`.
Start with [the map](README.md).
Call `kb_search` on the local repo-kb MCP server before repository exploration.
Open the cited sections with `kb_read_section`. Follow their Code paths to the source.
Use an exact-name search only when the page supplies the name or path.
If search has no correct answer, read the necessary source and fix the KB in the same pull request.

The checked-in `.github/mcp.json` starts the existing tool with `npx`.
Node.js 20 or later and git are required. No repository dependency or product service is added.
The default indexed paths include these docs, the root README, and the agent instructions.
The index stays outside the checkout. Keyword search works while local embeddings are prepared.
Select the current worktree explicitly when another checkout has different docs.

## Page contract

Every KB Markdown page starts with one H1 title and these fields:

```text
**Status:** Implemented
**Last Updated:** YYYY-MM-DD
**Audience:** Contributors and coding agents
**Last verified:** YYYY-MM-DD against <short sha>
**Code:** `path/to/file`, `path/to/folder`
```

Status is Implemented, Partial, Planned, or Superseded.
Last Updated records the last document change.
Last verified records the code revision that the author actually checked.
It does not claim verification against a future merge commit.
A page about built code must list its main source paths on the Code line.
Use repository-relative paths in backticks. Use `/` in Markdown paths and links.
Use `\` for Windows shell paths.
A folder path covers its descendants. Do not use globs or line numbers in Code paths.

Describe what the code does today. Put unbuilt design only under a heading named Planned.
A Superseded page points to its replacement and does not repeat stale behavior.
Each folder README lists every page and immediate subfolder.
Each entry says which question that page or subfolder answers.
Include non-Markdown support files, such as evaluation JSON, in that index too.

## Keep the KB true

Update the page, Code paths, verification field, and folder index when a pull request changes documented behavior.
Add a page or section for a new feature. Delete a removed feature's page or mark it Superseded.
If the KB needs no change, write `KB: no change needed` and the reason in the pull request body.
Report code defects as issues; do not change product code during a documentation audit.

## Generated pages

There are no generated KB pages at this revision.
When a generator is added, its page must name the script and its complete regeneration command.
Regenerate that page with the script. Never edit generated pages by hand.

## Local KB check

Python 3.9 or later is required. Run `python scripts/kb/check_kb.py --diff origin/main` before merge.
The script checks all KB Markdown metadata, Code paths, local file links, and folder indexes.
It also lists source changes without Code coverage and named paths that were deleted or renamed.
Errors fail the command. Warnings do not fail it.
The diff includes committed branch changes, staged and unstaged changes, and untracked source files.
Generated folders named generated, dist, build, coverage, node_modules, or __pycache__ are skipped.
There is no generated KB folder at this revision.
Folder indexes cover Markdown pages, supporting files, and immediate subfolders under docs.
Root and agent READMEs outside docs are not KB folder indexes.
Run `python -m unittest discover -s scripts/kb -p "test_*.py"` for the checker fixtures.
No checked-in Git hooks or configured hooksPath exist, so no pre-push hook is changed.

## Local commands

Run these from the repository root:

```powershell
npx -y github:throndir2/repo-kb index
npx -y github:throndir2/repo-kb search "How are rooms persisted?" --top 5
npx -y github:throndir2/repo-kb read docs/kb.md --heading "Page contract"
npx -y github:throndir2/repo-kb status
```

## Retrieval evaluation

`repo-kb-eval.json` contains 30 repository questions with expected Markdown paths.
The tool's format is an array of objects with `q` and `expect` fields.
Run `npx -y github:throndir2/repo-kb eval docs/repo-kb-eval.json --json` after indexing.
Evaluation measures retrieval, not implementation correctness or whole-session token cost.

On 2026-11-14, the local hybrid index contained 14 Markdown files and 73 embedded sections.
The 30-question evaluation returned hit@1 93.3% (28/30), hit@3 100% (30/30), and hit@5 100% (30/30).
Mean reciprocal rank was 0.961. Median query time was 7 ms; maximum was 240 ms.
These timings exclude process startup, indexing, and embedding preparation.
The two non-first results were missing-ffmpeg startup (rank 2) and caption/cue construction (rank 3).
Every expected page was in the top three without changing questions to match results.

There is no development setup script or custom include configuration.
The GitHub wiki setting is enabled, but its git remote returns Repository not found.
No wiki mirror is required for KB search.
