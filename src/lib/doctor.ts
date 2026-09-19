// Pure logic for the `doctor` subcommand: version comparison, host-config analysis, binary
// architecture checks and report formatting. No I/O here so every branch is unit-testable;
// src/doctor.ts gathers the facts and feeds them in.

export type CheckStatus = "ok" | "warn" | "fail" | "skip"

export type CheckResult = {
  name: string
  status: CheckStatus
  detail: string
  /** What the user should do about a warn/fail. */
  fix?: string
}

export const PACKAGE_NAME = "@hachitogo/macos-mcp-tools"
export const LAUNCHER_NAME = "macos-mcp-tools"

// ── Versions ───────────────────────────────────────────────────────────

const parseVersion = (value: string): number[] | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export const compareVersions = (installed: string, latest: string): "current" | "behind" | "ahead" | "unknown" => {
  const a = parseVersion(installed)
  const b = parseVersion(latest)
  if (!a || !b) return "unknown"
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return "behind"
    if (a[i] > b[i]) return "ahead"
  }
  return "current"
}

export const versionCheck = (installed: string, latest: string | undefined): CheckResult => {
  if (!latest) {
    return { name: "Package version", status: "skip", detail: `${installed} installed; could not reach npm to compare` }
  }
  switch (compareVersions(installed, latest)) {
    case "current":
      return { name: "Package version", status: "ok", detail: `${installed} (latest on npm)` }
    case "behind":
      return {
        name: "Package version",
        status: "warn",
        detail: `${installed} installed, ${latest} is latest on npm`,
        fix: `bun pm cache rm && bun install -g ${PACKAGE_NAME}@latest, then restart your MCP host`,
      }
    case "ahead":
      return {
        name: "Package version",
        status: "ok",
        detail: `${installed} installed (newer than npm latest ${latest}; local build)`,
      }
    default:
      return {
        name: "Package version",
        status: "warn",
        detail: `cannot parse versions: installed ${installed}, latest ${latest}`,
      }
  }
}

// ── Binary architecture ────────────────────────────────────────────────

/** Map Node/Bun process.arch to the names `lipo -archs` prints. */
export const lipoArchFor = (processArch: string): string => (processArch === "x64" ? "x86_64" : processArch)

export const binaryArchCheck = (archs: string[] | undefined, processArch: string): CheckResult => {
  const name = "EventKitCLI architecture"
  if (!archs || archs.length === 0) {
    return { name, status: "warn", detail: "could not determine binary architectures" }
  }
  const wanted = lipoArchFor(processArch)
  if (archs.includes(wanted)) {
    return { name, status: "ok", detail: `${archs.join(", ")} (this Mac is ${wanted})` }
  }
  return {
    name,
    status: "fail",
    detail: `binary is ${archs.join(", ")} but this Mac is ${wanted}; events and reminders will fail to start`,
    fix: "bun run build:swift (requires Xcode Command Line Tools)",
  }
}

// ── MCP host configuration ─────────────────────────────────────────────

type HostServerEntry = { command?: unknown; args?: unknown }

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

const mentionsPackage = (parts: string[]): boolean =>
  parts.some((p) => p.includes(PACKAGE_NAME) || p.includes(LAUNCHER_NAME) || p.endsWith("/src/cli.ts"))

/**
 * Inspect one host's MCP config (Claude Desktop `mcpServers` shape, also used by Claude Code's
 * ~/.claude.json). Flags the launch patterns that break under simultaneous multi-server startup.
 */
export const analyzeHostConfig = (
  hostLabel: string,
  config: unknown,
  fileExists: (path: string) => boolean,
): CheckResult[] => {
  const servers =
    typeof config === "object" && config !== null && "mcpServers" in config
      ? ((config as { mcpServers?: Record<string, HostServerEntry> }).mcpServers ?? {})
      : {}
  const results: CheckResult[] = []

  for (const [serverName, entry] of Object.entries(servers)) {
    const command = typeof entry?.command === "string" ? entry.command : ""
    const args = asStringArray(entry?.args)
    if (!mentionsPackage([command, ...args])) continue

    const name = `${hostLabel}: ${serverName}`
    const launcher = command.split("/").pop() ?? command
    if (launcher === "bunx" || launcher === "npx") {
      results.push({
        name,
        status: "fail",
        detail: `launches through ${launcher}; concurrent server startup corrupts its shared temp install`,
        fix: `bun install -g ${PACKAGE_NAME}@latest and set "command" to the absolute path from \`bun pm bin -g\`/${LAUNCHER_NAME}`,
      })
      continue
    }
    if (!command.startsWith("/")) {
      results.push({
        name,
        status: "fail",
        detail: `"${command}" is not an absolute path; GUI hosts do not inherit your shell PATH`,
        fix: `set "command" to the absolute path from \`bun pm bin -g\`/${LAUNCHER_NAME}`,
      })
      continue
    }
    if (!fileExists(command)) {
      results.push({
        name,
        status: "fail",
        detail: `${command} does not exist`,
        fix: `bun install -g ${PACKAGE_NAME}@latest, then point "command" at \`bun pm bin -g\`/${LAUNCHER_NAME}`,
      })
      continue
    }
    results.push({ name, status: "ok", detail: `${command} ${args.join(" ")}`.trim() })
  }

  if (results.length === 0) {
    results.push({ name: hostLabel, status: "skip", detail: `no ${LAUNCHER_NAME} servers configured` })
  }
  return results
}

// ── Report ─────────────────────────────────────────────────────────────

const ICON: Record<CheckStatus, string> = { ok: "✔", warn: "▲", fail: "✖", skip: "–" }

export const formatReport = (results: CheckResult[]): string => {
  const width = Math.max(...results.map((r) => r.name.length))
  const lines = results.map((r) => {
    const head = `${ICON[r.status]} ${r.name.padEnd(width)}  ${r.detail}`
    return r.fix && r.status !== "ok" ? `${head}\n  ${" ".repeat(width)}  fix: ${r.fix}` : head
  })
  const counts = results.reduce<Record<CheckStatus, number>>(
    (acc, r) => {
      acc[r.status]++
      return acc
    },
    { ok: 0, warn: 0, fail: 0, skip: 0 },
  )
  lines.push("", `${counts.ok} ok, ${counts.warn} warnings, ${counts.fail} failures, ${counts.skip} skipped`)
  return lines.join("\n")
}

export const exitCodeFor = (results: CheckResult[]): number => (results.some((r) => r.status === "fail") ? 1 : 0)
