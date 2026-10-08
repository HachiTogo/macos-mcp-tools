// The git side of the release: running commands so that a failure throws (and cleanup runs), and
// preparing the release branch. Kept apart from release.ts so it can be tested against a scratch
// repository with the same git configuration the release runs under.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A failure the release reports and stops on. Thrown, never exited, so `finally` blocks run. */
export class ReleaseError extends Error {}

export type Result = { ok: boolean; out: string; err: string }

/** Runs a command quietly and returns its output; throws a ReleaseError on failure unless allowed. */
export const run = (command: string, argv: string[], options: { cwd?: string; allowFail?: boolean } = {}): Result => {
  const result = spawnSync(command, argv, { cwd: options.cwd, encoding: "utf8" })
  const outcome = { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() }
  if (!outcome.ok && !options.allowFail) {
    throw new ReleaseError(`${command} ${argv.join(" ")} failed:\n${outcome.err || outcome.out}`)
  }
  return outcome
}

/**
 * Removes worktrees still holding `branch`, left behind when an earlier run failed partway. While
 * one exists, `git worktree add` refuses the branch, so a re-run could never get past this step.
 */
export const removeLeftoverWorktrees = (repo: string, branch: string): string[] => {
  const listing = run("git", ["worktree", "list", "--porcelain"], { cwd: repo }).out
  const removed: string[] = []
  for (const entry of listing.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(entry)?.[1]
    if (path && entry.includes(`\nbranch refs/heads/${branch}`)) {
      run("git", ["worktree", "remove", "--force", path], { cwd: repo })
      removed.push(path)
    }
  }
  run("git", ["worktree", "prune"], { cwd: repo })
  return removed
}

/**
 * Builds the release commit on a new `branch` from `base` in a throwaway worktree, so the caller's
 * checkout is never touched, and publishes it with `git push -u origin <branch>`.
 *
 * `--no-track` matters. Starting a branch from a remote-tracking ref such as origin/main makes git
 * set that ref as the branch's upstream (branch.autoSetupMerge), and under push.default=upstream
 * the push then goes to main. Without it, the branch has no upstream until `-u` gives it one.
 *
 * Nothing is forced. If origin already has the branch from an earlier run, the release stops and
 * says so rather than overwriting it.
 */
export const pushReleaseBranch = (options: {
  repo: string
  branch: string
  base: string
  message: string
  edit: (worktree: string) => void
}) => {
  const { repo, branch, base, message, edit } = options
  if (!branch.startsWith("release/")) throw new ReleaseError(`refusing to push ${branch}: not a release branch`)

  if (run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd: repo }).out) {
    throw new ReleaseError(
      `origin already has ${branch}, probably from an earlier run, and no open PR from it. Look at it, then delete it and run again:\n  git push origin --delete ${branch}`,
    )
  }

  // A local branch left by an earlier failed run may still track origin/main, and resetting it
  // keeps that upstream. Origin does not have it (checked above), so start it over instead.
  removeLeftoverWorktrees(repo, branch)
  run("git", ["branch", "-D", branch], { cwd: repo, allowFail: true })

  const worktree = mkdtempSync(join(tmpdir(), "macos-mcp-tools-release-"))
  try {
    run("git", ["worktree", "add", "--quiet", "--no-track", "-b", branch, worktree, base], { cwd: repo })
    edit(worktree)
    run("git", ["commit", "--quiet", "-am", message], { cwd: worktree })
    run("git", ["push", "--quiet", "-u", "origin", branch], { cwd: worktree })
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], { cwd: repo, allowFail: true })
    rmSync(worktree, { recursive: true, force: true })
  }
}
