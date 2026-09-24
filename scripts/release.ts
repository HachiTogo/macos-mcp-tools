// `make publish`: one command from the changelog's Unreleased entries to a live npm version.
//
// It does what CONTRIBUTING.md used to list as manual steps: open the release PR, merge it once CI
// passes, tag the merge commit, wait for the release workflow to stage the package, and approve it.
// Approval needs your 2FA code, by design, so that is the one thing you type. Every step checks
// whether it already happened, so if anything fails, fix it and run `make publish` again.
//
//   bun scripts/release.ts [version] [--dry-run] [--yes]

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"

import {
  compareVersions,
  findStageId,
  localDate,
  parseVersion,
  promoteUnreleased,
  setPackageVersion,
  suggestVersion,
  unreleasedEntries,
} from "./release-lib"

const PACKAGE = "@hachitogo/macos-mcp-tools"
const PACKAGE_PAGE = `https://www.npmjs.com/package/${PACKAGE}`
/** Staged publishing arrived in npm 11.15.0. */
const MIN_NPM = "11.15.0"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const assumeYes = args.includes("--yes")
const requested = args.find((arg) => !arg.startsWith("--"))

const fail = (message: string): never => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}
const step = (message: string) => console.log(`\n▸ ${message}`)
const done = (message: string) => console.log(`  ✓ ${message}`)

type Result = { ok: boolean; out: string; err: string }

/** Runs a command quietly and returns its output. Exits the release on failure unless told not to. */
const run = (command: string, argv: string[], options: { cwd?: string; allowFail?: boolean } = {}): Result => {
  const result = spawnSync(command, argv, { cwd: options.cwd, encoding: "utf8" })
  const outcome = { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() }
  if (!outcome.ok && !options.allowFail) {
    fail(`${command} ${argv.join(" ")} failed:\n${outcome.err || outcome.out}`)
  }
  return outcome
}

/** For steps you should watch or answer: CI progress and the 2FA prompt. */
const interactive = (command: string, argv: string[]): boolean =>
  spawnSync(command, argv, { stdio: "inherit" }).status === 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const npmVersionLive = (version: string): boolean =>
  run("npm", ["view", `${PACKAGE}@${version}`, "version"], { allowFail: true }).out === version

const confirm = async (question: string): Promise<boolean> => {
  if (assumeYes) return true
  if (!process.stdin.isTTY) fail("needs a terminal to confirm; pass --yes to skip the question")
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(`\n${question} [y/N] `)
  prompt.close()
  return /^y(es)?$/i.test(answer.trim())
}

// ── Where things stand ─────────────────────────────────────────────────

step("Checking where things stand")
run("git", ["fetch", "origin", "main", "--tags", "--quiet"])

const mainVersion = (JSON.parse(run("git", ["show", "origin/main:package.json"]).out) as { version: string }).version
const mainChangelog = run("git", ["show", "origin/main:CHANGELOG.md"]).out
const liveVersion = run("npm", ["view", PACKAGE, "version"], { allowFail: true }).out || "0.0.0"

// main ahead of npm means a release PR already merged and never finished publishing: resume it.
const resuming = compareVersions(mainVersion, liveVersion) > 0
const version = requested ?? (resuming ? mainVersion : suggestVersion(mainVersion, mainChangelog))

if (!parseVersion(version)) {
  fail(`"${version}" is not a release version. Use x.y.z; hyphenated versions are milestone tags and never publish.`)
}
if (npmVersionLive(version)) {
  done(`${version} is already live on npm. Nothing to do; update your install with \`make upgrade\`.`)
  process.exit(0)
}

const onMain = mainVersion === version
const tag = `v${version}`
const tagOnRemote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).out !== ""

if (!onMain) {
  if (compareVersions(version, mainVersion) <= 0) {
    fail(`${version} is not newer than main's ${mainVersion}.`)
  }
  if (!unreleasedEntries(mainChangelog)) {
    fail("CHANGELOG.md has nothing under ## [Unreleased], so there is nothing to release.")
  }
}

run("gh", ["auth", "status"])
const npmOk = compareVersions(run("npm", ["--version"]).out.replace(/-.*/, ""), MIN_NPM) >= 0
if (!npmOk) fail(`npm ${MIN_NPM} or newer is needed to approve a staged release: npm install -g npm@latest`)
const npmUser = run("npm", ["whoami"], { allowFail: true })

console.log(`  main is at ${mainVersion}; npm serves ${liveVersion}.`)
console.log(
  `  Releasing ${version}${requested ? "" : resuming ? " (resuming a release already merged to main)" : " (suggested from the changelog; pass VERSION=x.y.z to choose)"}.`,
)
console.log("\n  Plan:")
if (!onMain)
  console.log(`    1. open a PR bumping package.json to ${version} and dating the changelog, merge it once CI passes`)
console.log(
  `    ${onMain ? "1" : "2"}. ${tagOnRemote ? `${tag} already exists; reuse it` : `tag the release commit ${tag} and push it`}`,
)
console.log(`    ${onMain ? "2" : "3"}. wait for the release workflow to stage the package on npm`)
console.log(
  `    ${onMain ? "3" : "4"}. approve it: ${npmUser.ok ? `npm stage approve, which asks for your 2FA code (npm user ${npmUser.out})` : `you are not logged in to npm here, so approve on ${PACKAGE_PAGE} under Staged Packages; this waits for you`}`,
)

if (dryRun) {
  console.log("\n  --dry-run: stopping before anything changes.")
  process.exit(0)
}
if (!(await confirm(`Release ${version}?`))) fail("stopped; nothing was changed.")

// ── 1. The release PR ──────────────────────────────────────────────────

const branch = `release/${tag}`

if (!onMain) {
  step(`Release PR for ${version}`)
  let pr = run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "-q", ".[0].number"]).out

  if (pr) {
    done(`reusing open PR #${pr}`)
  } else {
    // A throwaway worktree, so your own checkout is never touched and need not be clean.
    const worktree = mkdtempSync(join(tmpdir(), "macos-mcp-tools-release-"))
    try {
      run("git", ["worktree", "add", "-B", branch, worktree, "origin/main", "--quiet"])
      const pkgPath = join(worktree, "package.json")
      const changelogPath = join(worktree, "CHANGELOG.md")
      writeFileSync(pkgPath, setPackageVersion(readFileSync(pkgPath, "utf8"), version))
      writeFileSync(changelogPath, promoteUnreleased(readFileSync(changelogPath, "utf8"), version, localDate()))
      run("git", ["commit", "--quiet", "-am", `chore(release): ${version}`], { cwd: worktree })
      // The branch name belongs to this script, so replacing a leftover from a failed run is safe.
      run("git", ["push", "--quiet", "--force", "origin", branch], { cwd: worktree })
    } finally {
      run("git", ["worktree", "remove", "--force", worktree], { allowFail: true })
      rmSync(worktree, { recursive: true, force: true })
    }

    run("gh", [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      `chore(release): ${version}`,
      "--body",
      `Bumps \`package.json\` to ${version} and dates the changelog's Unreleased entries. Opened by \`make publish\`, which merges it once CI passes and then tags ${tag}.`,
    ])
    pr = run("gh", ["pr", "view", branch, "--json", "number", "-q", ".number"]).out
    done(`opened PR #${pr}`)
  }

  // Checks take a moment to register after the PR opens; watching too early reports "no checks".
  for (let attempt = 0; attempt < 24; attempt++) {
    if (run("gh", ["pr", "checks", pr], { allowFail: true }).out) break
    await sleep(5_000)
  }
  console.log("  waiting for CI…")
  if (!interactive("gh", ["pr", "checks", pr, "--watch", "--fail-fast", "--interval", "15"])) {
    fail(`CI failed on PR #${pr}. Fix it on ${branch}, then run \`make publish\` again.`)
  }

  run("gh", ["pr", "merge", pr, "--squash", "--delete-branch"])
  done(`merged PR #${pr}`)
}

// ── 2. The tag ─────────────────────────────────────────────────────────

step(`Tag ${tag}`)
run("git", ["fetch", "origin", "main", "--tags", "--quiet"])

const versionAt = (ref: string) =>
  (JSON.parse(run("git", ["show", `${ref}:package.json`]).out) as { version: string }).version

if (tagOnRemote) {
  if (versionAt(tag) !== version) {
    fail(
      `${tag} exists but points at a commit whose package.json is not ${version}. Delete it and run again:\n  git push origin :refs/tags/${tag} && git tag -d ${tag}`,
    )
  }
  done(`${tag} already exists`)
} else {
  // Tag the release commit itself, not whatever main has moved on to since.
  const releaseCommit =
    run("git", ["log", "origin/main", "-1", "--format=%H", `--grep=^chore(release): ${version}`]).out ||
    run("git", ["rev-parse", "origin/main"]).out
  if (versionAt(releaseCommit) !== version) fail(`main does not have package.json at ${version} yet.`)
  run("git", ["tag", "-f", "-a", tag, releaseCommit, "-m", tag])
  run("git", ["push", "--quiet", "origin", `refs/tags/${tag}`])
  done(`tagged ${releaseCommit.slice(0, 7)} as ${tag} and pushed it`)
}

// ── 3. The release workflow ────────────────────────────────────────────

step("Release workflow")
let runId = ""
for (let attempt = 0; attempt < 24 && !runId; attempt++) {
  const runs = JSON.parse(
    run("gh", ["run", "list", "--workflow=release.yml", "--limit", "20", "--json", "databaseId,headBranch"]).out,
  ) as { databaseId: number; headBranch: string }[]
  runId = String(runs.find((candidate) => candidate.headBranch === tag)?.databaseId ?? "")
  if (!runId) await sleep(5_000)
}
if (!runId) fail(`no release workflow run appeared for ${tag}. Check the Actions tab.`)

if (!interactive("gh", ["run", "watch", runId, "--exit-status", "--interval", "10"])) {
  fail(
    `the release workflow failed: gh run view ${runId} --log-failed\nFix it, delete the tag, and run \`make publish\` again:\n  git push origin :refs/tags/${tag} && git tag -d ${tag}`,
  )
}

const stageId = findStageId(run("gh", ["run", "view", runId, "--log"]).out)
if (!stageId && !npmVersionLive(version)) {
  fail(`the workflow succeeded but its log has no stage id. Check ${PACKAGE_PAGE} under Staged Packages.`)
}

// ── 4. Approval ────────────────────────────────────────────────────────

step(`Approve ${version}`)
const waitUntilLive = async (minutes: number) => {
  for (let elapsed = 0; elapsed < minutes * 12; elapsed++) {
    if (npmVersionLive(version)) return true
    if (elapsed % 12 === 0 && elapsed > 0) console.log(`  still waiting for ${version} to go live…`)
    await sleep(5_000)
  }
  return false
}

if (npmVersionLive(version)) {
  done("already approved")
} else if (npmUser.ok && stageId && interactive("npm", ["stage", "approve", stageId])) {
  if (!(await waitUntilLive(5))) fail(`approved, but ${version} is not visible on npm yet. Check ${PACKAGE_PAGE}.`)
} else {
  console.log(
    `  Approve ${version} on ${PACKAGE_PAGE} under Staged Packages${stageId ? ` (stage id ${stageId})` : ""}.`,
  )
  console.log("  Waiting for it to go live…")
  if (!(await waitUntilLive(30)))
    fail(`${version} did not go live within 30 minutes. Run \`make publish\` again once it is approved.`)
}

console.log(`\n✓ ${PACKAGE}@${version} is live. Update your install with \`make upgrade\`.`)
