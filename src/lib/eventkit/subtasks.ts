import { webcrypto } from "node:crypto"
import type { Subtask, SubtaskProgress } from "./types.js"

const SUBTASK_START = "---SUBTASKS---"
const SUBTASK_END = "---END SUBTASKS---"

const SUBTASK_SECTION_REGEX = /---SUBTASKS---\n([\s\S]*?)---END SUBTASKS---/

const SUBTASK_LINE_REGEX = /^\[([ x])\]\s*\{([a-f0-9]+)\}\s*(.+)$/

export function generateSubtaskId(): string {
  const bytes = new Uint8Array(4)
  webcrypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function parseSubtasks(notes: string | null | undefined): Subtask[] {
  if (!notes) return []

  const match = notes.match(SUBTASK_SECTION_REGEX)
  if (!match) return []

  const subtaskContent = match[1]
  const lines = subtaskContent.split("\n").filter((line) => line.trim())
  const subtasks: Subtask[] = []

  for (const line of lines) {
    const lineMatch = line.match(SUBTASK_LINE_REGEX)
    if (lineMatch) {
      subtasks.push({
        id: lineMatch[2],
        title: lineMatch[3].trim(),
        isCompleted: lineMatch[1] === "x",
      })
    }
  }

  return subtasks
}

export function serializeSubtasks(subtasks: Subtask[]): string {
  if (!subtasks || subtasks.length === 0) return ""

  const lines = subtasks.map((subtask) => {
    const checkbox = subtask.isCompleted ? "[x]" : "[ ]"
    return `${checkbox} {${subtask.id}} ${subtask.title}`
  })

  return `${SUBTASK_START}\n${lines.join("\n")}\n${SUBTASK_END}`
}

export function stripSubtasks(notes: string | null | undefined): string {
  if (!notes) return ""

  return notes
    .replace(SUBTASK_SECTION_REGEX, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function combineSubtasksAndNotes(subtasks: Subtask[], notes: string | undefined): string {
  const cleanNotes = stripSubtasks(notes)
  const subtaskSection = serializeSubtasks(subtasks)

  if (cleanNotes && subtaskSection) {
    return `${cleanNotes}\n\n${subtaskSection}`
  } else if (subtaskSection) {
    return subtaskSection
  } else {
    return cleanNotes
  }
}

export function addSubtask(title: string, notes: string | undefined): { notes: string; subtask: Subtask } {
  const existingSubtasks = parseSubtasks(notes)

  const newSubtask: Subtask = {
    id: generateSubtaskId(),
    title: title.trim(),
    isCompleted: false,
  }

  existingSubtasks.push(newSubtask)

  return {
    notes: combineSubtasksAndNotes(existingSubtasks, notes),
    subtask: newSubtask,
  }
}

export function updateSubtask(
  subtaskId: string,
  updates: { title?: string; isCompleted?: boolean },
  notes: string | undefined,
): string {
  const subtasks = parseSubtasks(notes)
  const index = subtasks.findIndex((s) => s.id === subtaskId)

  if (index === -1) {
    throw new Error(`Subtask with ID '${subtaskId}' not found.`)
  }

  if (updates.title !== undefined) {
    subtasks[index].title = updates.title.trim()
  }
  if (updates.isCompleted !== undefined) {
    subtasks[index].isCompleted = updates.isCompleted
  }

  return combineSubtasksAndNotes(subtasks, notes)
}

export function removeSubtask(subtaskId: string, notes: string | undefined): string {
  const subtasks = parseSubtasks(notes)
  const index = subtasks.findIndex((s) => s.id === subtaskId)

  if (index === -1) {
    throw new Error(`Subtask with ID '${subtaskId}' not found.`)
  }

  subtasks.splice(index, 1)
  return combineSubtasksAndNotes(subtasks, notes)
}

export function toggleSubtask(subtaskId: string, notes: string | undefined): { notes: string; subtask: Subtask } {
  const subtasks = parseSubtasks(notes)
  const index = subtasks.findIndex((s) => s.id === subtaskId)

  if (index === -1) {
    throw new Error(`Subtask with ID '${subtaskId}' not found.`)
  }

  subtasks[index].isCompleted = !subtasks[index].isCompleted

  return {
    notes: combineSubtasksAndNotes(subtasks, notes),
    subtask: subtasks[index],
  }
}

export function reorderSubtasks(order: string[], notes: string | undefined): string {
  const subtasks = parseSubtasks(notes)

  const subtaskMap = new Map(subtasks.map((s) => [s.id, s]))

  for (const id of order) {
    if (!subtaskMap.has(id)) {
      throw new Error(`Subtask with ID '${id}' not found.`)
    }
  }

  const orderSet = new Set(order)
  for (const subtask of subtasks) {
    if (!orderSet.has(subtask.id)) {
      throw new Error(`Reorder array is missing subtask ID '${subtask.id}'. All subtask IDs must be included.`)
    }
  }

  const reorderedSubtasks = order.map((id) => {
    const subtask = subtaskMap.get(id)
    if (!subtask) {
      throw new Error(`Subtask with ID '${id}' not found.`)
    }
    return subtask
  })

  return combineSubtasksAndNotes(reorderedSubtasks, notes)
}

export function createSubtasksFromTitles(titles: string[]): Subtask[] {
  return titles.map((title) => ({
    id: generateSubtaskId(),
    title: title.trim(),
    isCompleted: false,
  }))
}

export function getSubtaskProgress(subtasks: Subtask[]): SubtaskProgress {
  if (!subtasks || subtasks.length === 0) {
    return { completed: 0, total: 0, percentage: 100 }
  }

  const completed = subtasks.filter((s) => s.isCompleted).length
  const total = subtasks.length
  const percentage = Math.round((completed / total) * 100)

  return { completed, total, percentage }
}
