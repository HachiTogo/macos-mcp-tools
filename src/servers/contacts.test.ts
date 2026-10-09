import { describe, expect, test } from "bun:test"

import {
  CONTACT_HELPERS,
  JXA_CONTACTS_DELETE,
  JXA_CONTACTS_GET,
  JXA_CONTACTS_UPDATE,
  JXA_GROUPS_ADD_MEMBER,
  JXA_GROUPS_REMOVE_MEMBER,
  requireArg,
} from "./contacts"

type FakeApp = { people: { whose: (query: { id: string }) => () => unknown[] } }

// The helpers are plain JavaScript that runs inside osascript; they need no Contacts app, so the same
// source the scripts embed is evaluated here.
const { findPerson, readList } = new Function(`${CONTACT_HELPERS}; return { findPerson, readList }`)() as {
  findPerson: (app: FakeApp, id: string) => unknown
  readList: (warnings: string[], field: string, read: () => unknown[]) => unknown[]
}

const appReturning = (matches: unknown[]): FakeApp => ({ people: { whose: () => () => matches } })

describe("findPerson", () => {
  test("returns the first match", () => {
    expect(findPerson(appReturning(["first", "second"]), "id-1")).toBe("first")
  })

  test("an id that matches nothing is not found", () => {
    expect(() => findPerson(appReturning([]), "id-1")).toThrow("Contact not found: id-1")
  })

  test("a failing lookup reports its cause rather than 'not found'", () => {
    const app: FakeApp = {
      people: {
        whose: () => () => {
          throw new Error("Not authorized to send Apple events to Contacts.")
        },
      },
    }
    expect(() => findPerson(app, "id-1")).toThrow(
      "Could not look up contact id-1: Not authorized to send Apple events to Contacts.",
    )
  })
})

describe("readList", () => {
  test("returns what it read and records nothing", () => {
    const warnings: string[] = []
    expect(readList(warnings, "emails", () => ["a@example.com"])).toEqual(["a@example.com"])
    expect(warnings).toEqual([])
  })

  test("a failed read leaves an empty list and a warning naming the field", () => {
    const warnings: string[] = []
    expect(
      readList(warnings, "phones", () => {
        throw new Error("Can't get object.")
      }),
    ).toEqual([])
    expect(warnings).toEqual(["Could not read phones: Can't get object."])
  })
})

describe("requireArg", () => {
  test("passes a value through and names a missing one", () => {
    expect(requireArg("id-1", "id", "get")).toBe("id-1")
    expect(() => requireArg(undefined, "id", "get")).toThrow("'id' is required for get.")
    expect(() => requireArg("", "person_id", "add_member")).toThrow("'person_id' is required for add_member.")
  })
})

describe("JXA scripts", () => {
  test("every script that uses the helpers parses as JavaScript", () => {
    for (const script of [
      JXA_CONTACTS_GET,
      JXA_CONTACTS_UPDATE,
      JXA_CONTACTS_DELETE,
      JXA_GROUPS_ADD_MEMBER,
      JXA_GROUPS_REMOVE_MEMBER,
    ]) {
      expect(() => new Function(script)).not.toThrow()
    }
  })
})
