import { exec } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execAsync = promisify(exec)

async function main() {
  console.log("Building Swift binary for macos-mcp-tools...")

  if (process.platform !== "darwin") {
    console.error("Error: This project requires macOS to compile Swift binaries.")
    process.exit(1)
  }

  try {
    await execAsync("which swiftc")
  } catch (_error) {
    console.error("Error: Swift compiler (swiftc) not found.")
    console.error("Please install Xcode or Xcode Command Line Tools: xcode-select --install")
    process.exit(1)
  }

  // Resolve paths relative to script location, not process.cwd()
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const projectRoot = path.resolve(__dirname, "..")
  const swiftDir = __dirname
  const sourceFile = path.join(swiftDir, "EventKitCLI.swift")
  const infoPlistFile = path.join(swiftDir, "Info.plist")
  const entitlementsFile = path.join(swiftDir, "EventKitCLI.entitlements")
  const binDir = path.join(projectRoot, "bin")
  const outputFile = path.join(binDir, "EventKitCLI")

  try {
    await fs.access(sourceFile)
  } catch (_error) {
    console.error(`Error: Source file not found: ${sourceFile}`)
    process.exit(1)
  }

  try {
    await fs.access(infoPlistFile)
  } catch (_error) {
    console.error(`Error: Info.plist not found: ${infoPlistFile}`)
    console.error("Info.plist is required for EventKit permissions to work properly.")
    process.exit(1)
  }

  try {
    await fs.access(entitlementsFile)
  } catch (_error) {
    console.error(`Error: Entitlements file not found: ${entitlementsFile}`)
    console.error("Entitlements file is required for TCC permission dialogs on macOS 26+.")
    process.exit(1)
  }

  await fs.mkdir(binDir, { recursive: true })

  // Use -Xlinker to embed Info.plist into the binary
  // This is required for macOS to show permission dialogs for EventKit access
  const compileCommand = `swiftc -o "${outputFile}" "${sourceFile}" -framework EventKit -framework Foundation -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "${infoPlistFile}"`

  console.log(`Compiling ${sourceFile}...`)

  try {
    const { stdout, stderr } = await execAsync(compileCommand)
    if (stderr) {
      console.warn(`Swift compiler warnings:\n${stderr}`)
    }
    if (stdout) {
      console.log(stdout)
    }

    console.log(`Compilation successful! Binary saved to ${outputFile}`)

    await fs.chmod(outputFile, "755")
    console.log("Binary is now executable.")

    // --options runtime enables Hardened Runtime, required on macOS 26+ for
    // the TCC system to show calendar permission dialogs when the binary
    // runs as a subprocess of a GUI application (e.g. Claude Desktop).
    const codesignCommand = `codesign --force --sign - --options runtime --entitlements "${entitlementsFile}" "${outputFile}"`
    const { stdout: csOut, stderr: csErr } = await execAsync(codesignCommand)
    if (csErr) {
      console.warn(`codesign warnings:\n${csErr}`)
    }
    if (csOut) {
      console.log(csOut)
    }
    console.log("Binary signed with hardened runtime and entitlements.")
  } catch (error) {
    console.error("Compilation failed!")
    console.error(error)
    process.exit(1)
  }

  // Verify the artifact rather than run it: every code path in EventKitCLI goes through an
  // EventKit permission check, which CI runners cannot grant, so "does it launch" is not a
  // question a workflow can ask. These checks do catch what actually breaks a release build:
  // a corrupt signature, or a binary compiled for the wrong architecture.
  try {
    await execAsync(`codesign --verify --strict "${outputFile}"`)
    const { stdout: archOut } = await execAsync(`lipo -archs "${outputFile}"`)
    const architectures = archOut.trim()
    if (architectures.length === 0) {
      throw new Error("lipo reported no architectures")
    }
    console.log(`Signature verified. Architectures: ${architectures}`)
    console.log("Swift binary build complete!")
  } catch (error) {
    console.error("The binary was built but failed verification!")
    console.error(error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("An unexpected error occurred during the build process:", error)
  process.exit(1)
})
