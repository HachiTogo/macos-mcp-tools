import crypto from 'node:crypto';
import type { ExecFileException } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_SYSTEM } from './constants.js';
import { CliUserError, bufferToString } from './helpers.js';

// --- Project root discovery ---

function getCurrentModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function isCorrectProjectRoot(dir: string): boolean {
  const packageJsonPath = path.join(dir, FILE_SYSTEM.PACKAGE_JSON_FILENAME);
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageContent = fs.readFileSync(packageJsonPath, 'utf8');
    const packageData = JSON.parse(packageContent);
    return typeof packageData.name === 'string' && packageData.name.length > 0;
  } catch {
    return false;
  }
}

function locateProjectRoot(
  startDir: string,
  maxDepth = FILE_SYSTEM.MAX_DIRECTORY_SEARCH_DEPTH,
): string | undefined {
  let currentDir = startDir;
  let depth = 0;

  while (depth < maxDepth) {
    if (isCorrectProjectRoot(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
    depth++;
  }

  return undefined;
}

export function findProjectRoot(
  maxDepth = FILE_SYSTEM.MAX_DIRECTORY_SEARCH_DEPTH,
): string {
  const currentDir = getCurrentModuleDir();
  const root = locateProjectRoot(currentDir, maxDepth);

  if (root) {
    return root;
  }

  throw new Error(`Project root not found within ${maxDepth} directory levels`);
}

// --- Binary validation ---

interface BinarySecurityConfig {
  expectedHash?: string;
  maxFileSize: number;
  allowedPaths: string[];
  requireAbsolutePath: boolean;
}

const DEFAULT_CONFIG: BinarySecurityConfig = {
  maxFileSize: 50 * 1024 * 1024,
  allowedPaths: ['/bin/', '/dist/swift/bin/', '/src/swift/bin/', '/swift/bin/'],
  requireAbsolutePath: true,
};

export class BinaryValidationError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'BinaryValidationError';
  }
}

export function validateBinaryPath(
  binaryPath: string,
  config: Partial<BinarySecurityConfig> = {},
): void {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  if (fullConfig.requireAbsolutePath && !path.isAbsolute(binaryPath)) {
    throw new BinaryValidationError(
      'Binary path must be absolute',
      'INVALID_PATH',
    );
  }

  const normalizedPath = path.normalize(binaryPath);
  if (normalizedPath.includes('..')) {
    throw new BinaryValidationError(
      'Path traversal detected in binary path',
      'PATH_TRAVERSAL',
    );
  }

  const isInAllowedPath = fullConfig.allowedPaths.some((allowedPath) => {
    const normalizedAllowedPath = path.normalize(allowedPath);
    const pathSegments = normalizedPath.split(path.sep).filter(Boolean);
    const allowedSegments = normalizedAllowedPath
      .split(path.sep)
      .filter(Boolean);

    for (let i = 0; i <= pathSegments.length - allowedSegments.length; i++) {
      let match = true;
      for (let j = 0; j < allowedSegments.length; j++) {
        if (pathSegments[i + j] !== allowedSegments[j]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }

    return false;
  });

  if (!isInAllowedPath) {
    throw new BinaryValidationError(
      'Binary path not in allowed directories',
      'FORBIDDEN_PATH',
    );
  }

  if (!fs.existsSync(normalizedPath)) {
    throw new BinaryValidationError(
      `Binary file not found: ${normalizedPath}`,
      'FILE_NOT_FOUND',
    );
  }

  const stats = fs.statSync(normalizedPath);
  if (!stats.isFile()) {
    throw new BinaryValidationError(
      'Binary path does not point to a file',
      'NOT_A_FILE',
    );
  }

  if (stats.size > fullConfig.maxFileSize) {
    throw new BinaryValidationError(
      `Binary file too large: ${stats.size} bytes`,
      'FILE_TOO_LARGE',
    );
  }

  try {
    fs.accessSync(normalizedPath, fs.constants.X_OK);
  } catch (_error) {
    throw new BinaryValidationError(
      'Binary file is not executable',
      'NOT_EXECUTABLE',
    );
  }
}

export function calculateBinaryHash(binaryPath: string): string {
  try {
    const fileBuffer = fs.readFileSync(binaryPath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  } catch (error) {
    throw new BinaryValidationError(
      `Failed to calculate binary hash: ${(error as Error).message}`,
      'HASH_CALCULATION_FAILED',
    );
  }
}

export function validateBinaryIntegrity(
  binaryPath: string,
  expectedHash: string,
): boolean {
  try {
    const actualHash = calculateBinaryHash(binaryPath);
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}

export function validateBinarySecurity(
  binaryPath: string,
  config: Partial<BinarySecurityConfig> = {},
): {
  isValid: boolean;
  hash?: string;
  errors: string[];
} {
  const errors: string[] = [];
  let hash: string | undefined;

  try {
    validateBinaryPath(binaryPath, config);
    hash = calculateBinaryHash(binaryPath);

    if (config.expectedHash) {
      const integrityValid = validateBinaryIntegrity(
        binaryPath,
        config.expectedHash,
      );
      if (!integrityValid) {
        errors.push('Binary integrity check failed - hash mismatch');
      }
    }
  } catch (error) {
    if (error instanceof BinaryValidationError) {
      errors.push(`${error.code}: ${error.message}`);
    } else {
      errors.push(`Unexpected validation error: ${(error as Error).message}`);
    }
  }

  return {
    isValid: errors.length === 0,
    hash,
    errors,
  };
}

export function findSecureBinaryPath(
  possiblePaths: string[],
  config: Partial<BinarySecurityConfig> = {},
): {
  path: string | null;
  validationResult?: ReturnType<typeof validateBinarySecurity>;
} {
  for (const binaryPath of possiblePaths) {
    const validationResult = validateBinarySecurity(binaryPath, config);

    if (validationResult.isValid) {
      return { path: binaryPath, validationResult };
    }
  }

  return { path: null };
}

export function getEnvironmentBinaryConfig(): Partial<BinarySecurityConfig> {
  if (process.env.NODE_ENV === 'test') {
    return {
      requireAbsolutePath: false,
      maxFileSize: 100 * 1024 * 1024,
    };
  }

  if (process.env.NODE_ENV === 'development') {
    return {
      maxFileSize: 100 * 1024 * 1024,
    };
  }

  return {
    expectedHash: process.env.SWIFT_BINARY_HASH,
    maxFileSize: 50 * 1024 * 1024,
    requireAbsolutePath: true,
  };
}

// --- CLI execution ---

let cachedBinaryPath: string | null = null;

export function clearBinaryPathCache(): void {
  cachedBinaryPath = null;
}

const execFilePromise = (
  cliPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      cliPath,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const execError = error as ExecFileException & {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
          };
          execError.stdout = stdout;
          execError.stderr = stderr;
          reject(execError);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

interface CliSuccessResponse<T> {
  status: 'success';
  result: T;
}

interface CliErrorResponse {
  status: 'error';
  message: string;
}

type CliResponse<T> = CliSuccessResponse<T> | CliErrorResponse;

export type PermissionDomain = 'reminders' | 'calendars';

const PERMISSION_ERROR_PATTERNS: Record<PermissionDomain, RegExp[]> = {
  reminders: [
    /reminder permission denied/i,
    /reminders access denied/i,
    /not authorized.*reminders/i,
    /reminder permission is write-only/i,
  ],
  calendars: [
    /calendar permission denied/i,
    /calendar access denied/i,
    /not authorized.*calendar/i,
    /calendar permission is write-only/i,
  ],
};

function detectPermissionError(message: string): PermissionDomain | null {
  for (const [domain, patterns] of Object.entries(PERMISSION_ERROR_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(message))) {
      return domain as PermissionDomain;
    }
  }
  return null;
}

export class CliPermissionError extends Error {
  constructor(
    message: string,
    public readonly domain: PermissionDomain,
  ) {
    super(message);
    this.name = 'CliPermissionError';
  }
}

const parseCliOutput = <T>(output: string): T => {
  let parsed: CliResponse<T>;
  try {
    parsed = JSON.parse(output) as CliResponse<T>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `EventKitCLI execution failed: Invalid CLI output - ${detail}`,
    );
  }

  if (parsed.status === 'success') {
    return parsed.result;
  }

  const permissionDomain = detectPermissionError(parsed.message);
  if (permissionDomain) {
    throw new CliPermissionError(parsed.message, permissionDomain);
  }

  throw new CliUserError(parsed.message);
};

const runCli = async <T>(cliPath: string, args: string[]): Promise<T> => {
  try {
    const { stdout } = await execFilePromise(cliPath, args);
    const normalized = bufferToString(stdout);
    if (!normalized) {
      throw new Error('EventKitCLI execution failed: Empty CLI output');
    }
    return parseCliOutput(normalized);
  } catch (error) {
    if (error instanceof CliPermissionError || error instanceof CliUserError) {
      throw error;
    }
    const execError = error as ExecFileException & {
      stdout?: string | Buffer;
    };
    const normalized = bufferToString(execError?.stdout);
    if (normalized) {
      return parseCliOutput(normalized);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`EventKitCLI execution failed: ${errorMessage}`);
  }
};

export async function executeCli<T>(args: string[]): Promise<T> {
  if (cachedBinaryPath) {
    return await runCli<T>(cachedBinaryPath, args);
  }

  const projectRoot = findProjectRoot();
  const binaryName = FILE_SYSTEM.SWIFT_BINARY_NAME;
  const possiblePaths = [path.join(projectRoot, 'bin', binaryName)];

  const config = {
    ...getEnvironmentBinaryConfig(),
    allowedPaths: [
      '/bin/',
      '/dist/swift/bin/',
      '/src/swift/bin/',
      '/swift/bin/',
    ],
  };

  const { path: cliPath } = findSecureBinaryPath(possiblePaths, config);

  if (!cliPath) {
    throw new CliUserError(
      `EventKitCLI binary not found. Searched: ${possiblePaths.join(', ')}`,
    );
  }

  cachedBinaryPath = cliPath;

  return await runCli<T>(cliPath, args);
}
