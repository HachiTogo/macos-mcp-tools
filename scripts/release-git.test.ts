import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pushReleaseBranch, ReleaseError, removeLeftoverWorktrees, run } from "./release-git"

// The first `make publish` force-pushed the release commit at main instead of release/v0.8.0, and
// only the repository's PR rule stopped it. The cause was git configuration, not the script's
// logic: with push.default=upstream, a bare `git push origin <branch>` goes to that branch's
// upstream, and a branch started from origin/main tracks origin/main. These tests run against a
// scratch "origin" configured the same way, so they fail if that can happen again.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A bare origin with one commit on main, and a clone configured like the release machine. */
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "release-git-"))
  dirs.push(root)
  const origin = join(root, "origin.git")
  const repo = join(root, "repo")
  run("git", ["init", "--quiet", "--bare", "-b", "main", origin])
  run("git", ["clone", "--quiet", origin, repo])
  for (const [key, value] of [
    ["user.name", "Release Test"],
    ["user.email", "release-test@example.com"],
    ["commit.gpgsign", "false"],
    ["push.default", "upstream"],
    ["branch.autoSetupMerge", "true"],
  ]) {
    run("git", ["config", key as string, value as string], { cwd: repo })
  }
  writeFileSync(join(repo, "package.json"), '{ "version": "1.0.0" }\n')
  run("git", ["add", "."], { cwd: repo })
  run("git", ["commit", "--quiet", "-m", "initial"], { cwd: repo })
  run("git", ["push", "--quiet", "origin", "HEAD:refs/heads/main"], { cwd: repo })
  run("git", ["fetch", "--quiet", "origin"], { cwd: repo })
  return { origin, repo }
}

const remoteRef = (origin: string, ref: string) =>
  run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: origin, allowFail: true }).out

const bump = (worktree: string) => writeFileSync(join(worktree, "package.json"), '{ "version": "1.1.0" }\n')

describe("pushReleaseBranch", () => {
  test("the old command would have pushed to main under this configuration", () => {
    // Pins the cause: same config, the previous way of creating and pushing the branch.
    const { repo } = scratch()
    run("git", ["branch", "-f", "release/v1.1.0", "origin/main"], { cwd: repo })
    const dryRun = run("git", ["push", "--dry-run", "--porcelain", "--force", "origin", "release/v1.1.0"], {
      cwd: repo,
    })
    expect(dryRun.out).toContain("refs/heads/release/v1.1.0:refs/heads/main")
  })

  test("pushes the release commit to the release branch and leaves main alone", () => {
    const { origin, repo } = scratch()
    const mainBefore = remoteRef(origin, "refs/heads/main")

    pushReleaseBranch({ repo, branch: "release/v1.1.0", base: "origin/main", message: "release", edit: bump })

    expect(remoteRef(origin, "refs/heads/main")).toBe(mainBefore)
    const pushed = remoteRef(origin, "refs/heads/release/v1.1.0")
    expect(pushed).not.toBe("")
    expect(run("git", ["show", `${pushed}:package.json`], { cwd: origin }).out).toContain("1.1.0")
  })

  test("leaves the caller's checkout untouched", () => {
    const { repo } = scratch()
    pushReleaseBranch({ repo, branch: "release/v1.1.0", base: "origin/main", message: "release", edit: bump })
    expect(readFileSync(join(repo, "package.json"), "utf8")).toContain("1.0.0")
    expect(run("git", ["status", "--porcelain"], { cwd: repo }).out).toBe("")
  })

  test("cleans up its worktree when a step fails, so a re-run is not blocked", () => {
    const { repo } = scratch()
    const fail = () => {
      throw new ReleaseError("edit failed")
    }
    expect(() =>
      pushReleaseBranch({ repo, branch: "release/v1.1.0", base: "origin/main", message: "x", edit: fail }),
    ).toThrow("edit failed")
    expect(run("git", ["worktree", "list"], { cwd: repo }).out.split("\n")).toHaveLength(1)

    // And the next attempt goes through.
    pushReleaseBranch({ repo, branch: "release/v1.1.0", base: "origin/main", message: "release", edit: bump })
  })

  test("clears a worktree left holding the branch by an earlier failed run", () => {
    const { origin, repo } = scratch()
    const leftover = join(mkdtempSync(join(tmpdir(), "leftover-")), "wt")
    dirs.push(leftover)
    run("git", ["worktree", "add", "--quiet", "-b", "release/v1.1.0", leftover, "origin/main"], { cwd: repo })

    // git reports resolved paths, and on macOS /var is /private/var. Resolve before it is removed.
    const resolved = realpathSync(leftover)
    expect(removeLeftoverWorktrees(repo, "release/v1.1.0")).toEqual([resolved])
    pushReleaseBranch({ repo, branch: "release/v1.1.0", base: "origin/main", message: "release", edit: bump })
    expect(remoteRef(origin, "refs/heads/release/v1.1.0")).not.toBe("")
  })

  test("refuses to force-push anything that is not a release branch", () => {
    const { repo } = scratch()
    expect(() => pushReleaseBranch({ repo, branch: "main", base: "origin/main", message: "x", edit: bump })).toThrow(
      /not a release branch/,
    )
  })
})
