// Limits and fixed values shared across the mail modules. DEFAULT_LIMIT and MAX_LIMIT bound what
// a tool will return; BODY_MAX_CHARS and MAX_LINKS bound what one message can contribute.

import { homedir } from "node:os"
import { join } from "node:path"

export const MAIL_DB_PATH = join(homedir(), "Library/Mail/V10/MailData/Envelope Index")
export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100
export const BODY_MAX_CHARS = 8_000
export const MAX_LINKS = 500
export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
export const MAX_EMAIL_BODY_LENGTH = 1_000_000
