# Repository instructions

These instructions apply to all agent work in this repository.

## Always merge finished work into `main`

Do not leave finished work on a branch or in an open pull request. When a task is complete, merge it into `main`.

1. Run the local checks from the repository root:

   ```powershell
   npm run typecheck
   npm test
   npm run build
   ```

2. Fix every failure before you continue.
3. Commit the changes to the session branch, and push the branch.
4. Open a pull request to `main`, or update the existing pull request for the branch.
5. Merge the pull request with a merge commit:

   ```powershell
   gh pr merge <number> --merge
   ```

   Do not add `--delete-branch` when you work in a Git worktree. The command then tries to check out `main`, which the main checkout already uses.

6. Make sure that the merge is complete: `gh pr view <number> --json state,mergedAt` must show `MERGED`.
7. If the pull request has a merge conflict, merge `origin/main` into the branch, resolve the conflict, run the checks again, push, and merge.

Stop before the merge only when the user asks for a draft, a review, or a hold.

## No remote CI

- Do not add GitHub Actions workflows or other hosted CI. Run all checks on the local computer.
- The repository has no workflows, so a push or a merge uses no GitHub Actions minutes.

## Deployment

- The live site is `https://choicervoicer.throndir.com`. It runs on Nahida (`192.168.50.9:3090`) behind Cloudflare and Nginx Proxy Manager.
- To release `main`, run `pwsh -File scripts/deploy-nahida.ps1`. To go back to an earlier image, add `-Rollback <tag>`.
- `scripts/configure-npm.ps1` creates or updates the Nginx Proxy Manager host. It reads the login from `NPM_IDENTITY` and `NPM_SECRET` or from a prompt. Never write the login to a file, a commit or a log.
- See `docs/deployment.md` for the details.

## Project layout

- `packages/shared`: types, Zod schemas, socket event names, and the cue and caption logic.
- `apps/server`: the Fastify and Socket.IO server, the GameBanana catalog, pack processing and rooms.
- `apps/web`: the React and Vite client.
- `docs/plan.md`: the design. Keep it up to date when the behaviour changes.
