# Knowledge base contract

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against 9489c5e
**Code:** `.github/mcp.json`

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

## Local commands

Run these from the repository root:

```powershell
npx -y github:throndir2/repo-kb index
npx -y github:throndir2/repo-kb search "How are rooms persisted?" --top 5
npx -y github:throndir2/repo-kb read docs/kb.md --heading "Page contract"
npx -y github:throndir2/repo-kb status
```

There is no development setup script or custom include configuration.
The GitHub wiki setting is enabled, but its git remote returns Repository not found.
No wiki mirror is required for KB search.
