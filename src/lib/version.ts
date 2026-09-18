import pkg from "../../package.json"

/** Package version from package.json, so every MCP server reports the published version. */
export const PACKAGE_VERSION: string = pkg.version
