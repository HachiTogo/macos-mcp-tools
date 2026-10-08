import { describe, expect, test } from "bun:test"

import {
  JXA_APPEND_TO_NOTE,
  JXA_CREATE_NOTE,
  JXA_DELETE_NOTE,
  JXA_GET_NOTE,
  JXA_MOVE_NOTE,
  JXA_SEARCH_NOTES,
  JXA_UPDATE_NOTE,
  NOTE_LOOKUP,
  requireNoteRef,
} from "./notes"

type Match = { id: string; folder: string }

// The lookup prelude is plain JavaScript that runs inside osascript. Its matching rule needs no Notes
// app, so it is evaluated here directly: the same source the scripts embed.
const pickNote = new Function(`${NOTE_LOOKUP}; return pickNote`)() as (matches: Match[], title: string) => Match

describe("pickNote", () => {
  test("a single match is the note", () => {
    expect(pickNote([{ id: "x-coredata://a/ICNote/p1", folder: "Work" }], "Plan")).toEqual({
      id: "x-coredata://a/ICNote/p1",
      folder: "Work",
    })
  })

  test("no match is not found", () => {
    expect(() => pickNote([], "Plan")).toThrow("Note not found: Plan")
  })

  test("a title shared by several notes is refused, listing every id and folder", () => {
    const matches = [
      { id: "x-coredata://a/ICNote/p1", folder: "Work" },
      { id: "x-coredata://a/ICNote/p2", folder: "Personal" },
      { id: "x-coredata://a/ICNote/p3", folder: "Personal" },
    ]
    let message = ""
    try {
      pickNote(matches, "Plan")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toStartWith('3 notes are titled "Plan"')
    for (const match of matches) expect(message).toContain(`${match.id} (folder: ${match.folder})`)
  })
})

describe("requireNoteRef", () => {
  test("needs an id or a title", () => {
    expect(() => requireNoteRef({})).toThrow("Pass the note's id or its title.")
    expect(() => requireNoteRef({ title: "" })).toThrow()
    expect(() => requireNoteRef({ id: "x-coredata://a/ICNote/p1" })).not.toThrow()
    expect(() => requireNoteRef({ title: "Plan" })).not.toThrow()
  })
})

describe("JXA scripts", () => {
  const singleNote = { JXA_GET_NOTE, JXA_UPDATE_NOTE, JXA_MOVE_NOTE, JXA_APPEND_TO_NOTE, JXA_DELETE_NOTE }

  test("every script parses as JavaScript", () => {
    for (const script of [...Object.values(singleNote), JXA_CREATE_NOTE, JXA_SEARCH_NOTES]) {
      expect(() => new Function(script)).not.toThrow()
    }
  })

  test("every single-note script resolves its note through the shared lookup", () => {
    for (const [name, script] of Object.entries(singleNote)) {
      expect({ name, usesLookup: script.includes("findNote(app,") }).toEqual({ name, usesLookup: true })
      expect({ name, firstMatch: /notes\.find\(/.test(script) }).toEqual({ name, firstMatch: false })
    }
  })
})
