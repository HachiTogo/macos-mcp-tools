const BRACKET_TAG_REGEX = /\[#([^\]]+)\]/g

// Must be preceded by start-of-string or whitespace.
// Uses negative lookahead to exclude purely numeric tags (e.g. #42)
// while allowing digit-starting mixed tags (e.g. #1st, #2024q1).
const BARE_TAG_REGEX = /(?:^|(?<=\s))#(?![0-9]+\b)([a-zA-Z0-9_-]+)/gm

function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").trim().toLowerCase()
}

function normalizeTags(tags: string[]): string[] {
  return tags.map(normalizeTag)
}

export function extractTags(notes: string | null | undefined): string[] {
  if (!notes) return []

  const tags = new Set<string>()

  for (const match of notes.matchAll(BRACKET_TAG_REGEX)) {
    const tag = match[1].trim().toLowerCase()
    if (tag) tags.add(tag)
  }

  for (const match of notes.matchAll(BARE_TAG_REGEX)) {
    const tag = match[1].trim().toLowerCase()
    if (tag) tags.add(tag)
  }

  return Array.from(tags)
}

export function stripTags(notes: string | null | undefined): string {
  if (!notes) return ""

  return notes
    .replace(BRACKET_TAG_REGEX, "")
    .replace(BARE_TAG_REGEX, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "")
    .replace(/\n{3,}/g, "\n\n")
}

export function formatTags(tags: string[]): string {
  if (!tags || tags.length === 0) return ""

  return tags
    .map((tag) => {
      const cleanTag = normalizeTag(tag)
      return cleanTag ? `#${cleanTag}` : ""
    })
    .filter(Boolean)
    .join(" ")
}

export function combineTagsAndNotes(tags: string[] | undefined, notes: string | undefined): string {
  const existingTags = extractTags(notes)
  const cleanNotes = stripTags(notes)

  const mergedTags = tags ? [...tags, ...existingTags] : existingTags
  const allTags = [...new Set(normalizeTags(mergedTags))]

  const formattedTags = formatTags(allTags)

  if (formattedTags && cleanNotes) {
    return `${formattedTags}\n${cleanNotes}`
  } else if (formattedTags) {
    return formattedTags
  } else {
    return cleanNotes
  }
}

export function addTagsToNotes(tagsToAdd: string[], notes: string | undefined): string {
  const existingTags = extractTags(notes)
  const cleanNotes = stripTags(notes)

  const normalizedNewTags = normalizeTags(tagsToAdd)
  const allTags = [...new Set([...existingTags, ...normalizedNewTags])]

  const formattedTags = formatTags(allTags)

  if (formattedTags && cleanNotes) {
    return `${formattedTags}\n${cleanNotes}`
  } else if (formattedTags) {
    return formattedTags
  } else {
    return cleanNotes
  }
}

export function removeTagsFromNotes(tagsToRemove: string[], notes: string | undefined): string {
  const existingTags = extractTags(notes)
  const cleanNotes = stripTags(notes)

  const normalizedRemove = normalizeTags(tagsToRemove)

  const remainingTags = existingTags.filter((tag) => !normalizedRemove.includes(tag))

  const formattedTags = formatTags(remainingTags)

  if (formattedTags && cleanNotes) {
    return `${formattedTags}\n${cleanNotes}`
  } else if (formattedTags) {
    return formattedTags
  } else {
    return cleanNotes
  }
}

export function hasAllTags(reminderTags: string[] | undefined, filterTags: string[]): boolean {
  if (!filterTags || filterTags.length === 0) return true
  if (!reminderTags || reminderTags.length === 0) return false

  const normalizedReminderTags = normalizeTags(reminderTags)
  const normalizedFilterTags = normalizeTags(filterTags)

  return normalizedFilterTags.every((tag) => normalizedReminderTags.includes(tag))
}
