# Repository instructions

## Knowledge Base First (Required)

Always use KB search when you must find, search, or move through the repository.
Call `kb_search` on the local repo-kb MCP server. Open cited sections with `kb_read_section`.
Use each page's `**Code:**` paths to locate the source. Then read only the code that you need.
Do not explore with broad grep, glob, directory listings, or file reads.
Use these tools only for an exact name or path supplied by the KB.
If the KB has no answer or a wrong answer, find the answer in code and fix the doc in the same pull request.

## Keep the KB true (Required)

Update the KB in the same pull request when code, config, scripts, commands, or behavior are added, renamed, moved, or deleted.
Update the page, its `**Code:**` and `**Last verified:**` lines, and its folder index.
A new feature gets a page or section. Delete a removed feature or mark it Superseded.
If no doc must change, the pull request body says `KB: no change needed` and gives the reason.
Run `python scripts/kb/check_kb.py --diff origin/main` before merge. Fix every error.

## Repository workflow and map

Apply all [repository workflow rules](../docs/workflow.md), including local typecheck, tests, build, commit, push, and merge.
Merge finished work into main with a merge commit. Deploy image changes to Nahida after merge.
Respect draft, review, hold, and no-deploy requests. Do not use hosted CI.
Start with [docs/README.md](../docs/README.md) for source locations.
The [KB contract](../docs/kb.md) defines page metadata and index rules.
