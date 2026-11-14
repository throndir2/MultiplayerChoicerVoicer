# Historical KB lookup comparison

**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors and coding agents
**Last verified:** 2026-11-14 against c961fe4
**Code:** `scripts/kb/replay_comparison.py`, `docs/repo-kb-comparison.json`

## Result

Five earlier tasks used 110 initial lookup calls. The historical KB replay estimates 82 calls, or 25.5% fewer.
Available retrieved text falls from 535,785 to 452,367 characters, or 15.6% less.
At four characters per token, this is approximately 133,947 versus 113,092 new-text tokens.
These are lookup estimates, not measured whole-session tokens, billing, or proof of faster implementation.

| Earlier task | Original calls | Estimated KB-first calls | Original token estimate | KB-first token estimate |
| --- | ---: | ---: | ---: | ---: |
| Voice order | 13 | 11 | 12,142 | 12,491 |
| Pack versions | 33 | 26 | 46,383 | 36,617 |
| Instant record start | 14 | 14 | 18,298 | 18,509 |
| Waveform jitter | 17 | 9 | 14,090 | 13,884 |
| Recording downloads | 33 | 22 | 43,034 | 31,594 |
| Combined | 110 | 82 | 133,947 | 113,092 |

Totals use combined character counts. Rounding each row can produce a small difference.
Voice order and instant record start use slightly more retrieved text in this conservative replay.
The instant-record task already supplied exact source locations. A KB cannot save much source discovery in that case.
Pack versions and recording downloads have the largest text savings because their original sessions read large design sections.
This sample does not establish the 55% token reduction reported for WitchyWitchCo.

## Measured history

The input file identifies five sessions, their first-edit cutoffs, and their pre-task Git revisions.
The baseline includes view, grep, and glob results before the first edit.
It excludes shell commands, edits, tests, browser actions, deployment, later investigation, and conversation text.
The counts and character lengths came from stored session tool results, not from reading today's source files.
One recording-download grep result is unavailable. Its call is counted, but its text length is unknown.
The combined original text count is therefore a lower bound. The replay does not invent the missing text.

The baseline retains 65 source, script, and test reads in both scenarios.
It also retains reads of the external Pack Creator project.
Failed source reads remain charged. The model assumes no reduction in source reads, even if some were unnecessary.
Only 45 search, directory, and documentation calls are replaced with 17 measured KB calls.

## Preventing later-documentation bias

The replay reads `docs/plan.md` from the parent of each task's first implementation commit:

| Task | Pre-task revision | Expected historical chapter | Search rank |
| --- | --- | --- | ---: |
| Voice order | `8dcaa23b` | Recording | 3 |
| Pack versions | `8ca5cf7` | Pack processing on the server | 2 |
| Instant record start | `05e4e30` | Recording | 3 |
| Waveform jitter | `233e27e` | Recording | 1 |
| Recording downloads | `5e20a35` | Playback | 3 |

The script splits existing numbered chapters into temporary Markdown pages.
It adds only Code paths for the corresponding existing areas. Git verifies that every mapped path exists at that revision.
It does not copy today's KB, the completed fixes, new function descriptions, or documentation written during the selected task.
All old numbered chapters remain searchable, including the old work plan and known limits.
These temporary documents are historical inputs, not verified current implementation documentation.

The added maps represent a hypothetical KB prepared before each task.
They still require author judgement, so this is not a randomized trial or an exact alternate session.
Expected chapters and queries are selected by hand. The script charges every higher-ranked chapter read before the expected chapter.
It reads complete chapters, including their Code paths, rather than assuming perfect section selection.
All five expected chapters appear in the top three. Only one ranks first.

## Reproducing the replay

Use Python 3.9 or later, Node.js 20 or later, git, and npx.
Run the following command from the repository root:

```powershell
python scripts\kb\replay_comparison.py --output "$env:TEMP\mcv-kb-comparison.json"
```

The script creates separate temporary repositories with the same remote identity and different historical documentation.
It indexes each snapshot locally, runs one hybrid search, and measures the returned search and chapter text.
It writes result JSON to the selected output path and removes the temporary repositories.
The tool keeps its normal external index cache. No source checkout, product service, or remote CI is started.
The script uses the current public repo-kb version. Future versions can change rankings and output sizes.

The result combines measured KB text with retained historical source text.
Historical tool results and CLI output have different formatting. Character counts are not exact tokenizer measurements.
The four-character token estimate ignores context reuse, caching, tool arguments, reasoning, and model output.
Using three to five characters per token gives approximately 107,157 to 178,595 original tokens and 90,474 to 150,789 replay tokens.
This range is a conversion sensitivity range, not a statistical confidence interval.
The sample contains mostly recording tasks and does not represent all repository work.
