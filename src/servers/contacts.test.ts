import { describe, expect, test } from "bun:test"

import { jsonResult } from "../lib/mcp-result"
import {
  CONTACT_HELPERS,
  contactGroupOutput,
  contactGroupsOutput,
  contactOutput,
  contactsPageOutput,
  GROUP_LOOKUP,
  JXA_CONTACTS_DELETE,
  JXA_CONTACTS_GET,
  JXA_CONTACTS_READ,
  JXA_CONTACTS_SEARCH,
  JXA_CONTACTS_UPDATE,
  JXA_GROUPS_ADD_MEMBER,
  JXA_GROUPS_GET,
  JXA_GROUPS_READ,
  JXA_GROUPS_REMOVE_MEMBER,
  readableLabel,
  relabel,
  storedLabel,
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

type Group = { id: string; name: string }
const groupsApp = (groups: Group[]) => ({
  groups: {
    whose: (query: Partial<Group>) =>
      groups.filter((g) => (query.id !== undefined ? g.id === query.id : g.name === query.name)),
  },
})
const { findGroup } = new Function(`${GROUP_LOOKUP}; return { findGroup }`)() as {
  findGroup: (app: ReturnType<typeof groupsApp>, ref: string) => Group
}

describe("findGroup", () => {
  const app = groupsApp([
    { id: "A1:ABGroup", name: "Family" },
    { id: "B2:ABGroup", name: "Work" },
  ])

  test("accepts the id list_contact_groups returns, or the name", () => {
    expect(findGroup(app, "B2:ABGroup").name).toBe("Work")
    expect(findGroup(app, "Family").id).toBe("A1:ABGroup")
  })

  test("an unknown group is not found", () => {
    expect(() => findGroup(app, "Friends")).toThrow("Group not found: Friends")
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

/** Runs a script's run() against a fake app, as osascript runs it against Contacts. */
const runAgainst = (script: string, app: unknown, args: object = {}) =>
  JSON.parse(new Function("Application", `${script}; return run`)(() => app)([JSON.stringify(args)]))

describe("read tools' declared output schemas", () => {
  const person = (id: string, first: string, last: string, emails: () => unknown[]) => ({
    id: () => id,
    firstName: () => first,
    lastName: () => last,
    organization: () => "",
    jobTitle: () => "",
    note: () => "",
    emails,
    phones: () => [],
    addresses: () => [],
  })
  const people = [
    person("p1", "Ada", "Lovelace", () => [{ label: () => "work", value: () => "ada@example.com" }]),
    person("p2", "Alan", "Turing", () => {
      throw new Error("Can't get object.")
    }),
  ]
  const friends = { id: () => "g1:ABGroup", name: () => "Friends", people: () => people }
  const app = {
    people: Object.assign(() => people, {
      id: () => people.map((p) => p.id()),
      firstName: () => people.map((p) => p.firstName()),
      lastName: () => people.map((p) => p.lastName()),
      organization: () => people.map((p) => p.organization()),
      whose: (query: { id: string }) => () => people.filter((p) => p.id() === query.id),
    }),
    groups: Object.assign(() => [friends], {
      whose: (query: Partial<Group>) =>
        [friends].filter((g) => (query.id !== undefined ? g.id() === query.id : g.name() === query.name)),
    }),
  }
  // Each handler returns jsonResult of the script's output; the SDK checks that against the schema.
  const structured = (script: string, args?: object) => jsonResult(runAgainst(script, app, args)).structuredContent

  test("every read script's result matches its tool's schema", () => {
    expect(contactsPageOutput.parse(structured(JXA_CONTACTS_READ, { limit: 10 }))).toBeTruthy()
    expect(contactsPageOutput.parse(structured(JXA_CONTACTS_SEARCH, { query: "zz-nobody" }))).toBeTruthy()
    expect(contactOutput.parse(structured(JXA_CONTACTS_GET, { id: "p1" }))).toBeTruthy()
    expect(contactGroupsOutput.parse(structured(JXA_GROUPS_READ))).toBeTruthy()
    expect(contactGroupOutput.parse(structured(JXA_GROUPS_GET, { group: "g1:ABGroup" }))).toBeTruthy()
  })

  test("a contact read with warnings still matches", () => {
    const contact = structured(JXA_CONTACTS_GET, { id: "p2" })
    expect(contact?.warnings).toEqual(["Could not read emails: Can't get object."])
    expect(contactOutput.parse(contact)).toBeTruthy()
  })
})

// Contacts returned its built-in labels as raw codes, `_$!<Work>!$_`, and saved a plain "work" as a
// custom label rather than its own Work.
describe("contact labels", () => {
  test("reads give the word Contacts shows", () => {
    expect(readableLabel("_$!<Work>!$_")).toBe("work")
    expect(readableLabel("_$!<WorkFAX>!$_")).toBe("work fax")
    expect(readableLabel("_$!<HomePage>!$_")).toBe("homepage")
  })

  test("custom labels and unlisted codes pass through", () => {
    expect(readableLabel("rentals")).toBe("rentals")
    expect(readableLabel("_$!<Anniversary>!$_")).toBe("_$!<Anniversary>!$_")
    expect(storedLabel("rentals")).toBe("rentals")
    expect(storedLabel("_$!<Home>!$_")).toBe("_$!<Home>!$_")
  })

  test("writes turn a built-in word back into its code, in any case", () => {
    expect(storedLabel("Work")).toBe("_$!<Work>!$_")
    expect(storedLabel("work fax")).toBe("_$!<WorkFAX>!$_")
    expect(storedLabel(readableLabel("_$!<Mobile>!$_"))).toBe("_$!<Mobile>!$_")
  })

  test("a contact's emails, phones and addresses are all mapped, and nothing else", () => {
    const contact = {
      id: "1",
      note: "_$!<Work>!$_ stays in a note",
      emails: [{ label: "_$!<Work>!$_", value: "a@example.com" }],
      phones: [{ label: "_$!<Mobile>!$_", value: "555-0100" }],
      addresses: [{ label: "_$!<Home>!$_", city: "Springfield" }],
    }
    expect(relabel(contact, readableLabel)).toEqual({
      id: "1",
      note: "_$!<Work>!$_ stays in a note",
      emails: [{ label: "work", value: "a@example.com" }],
      phones: [{ label: "mobile", value: "555-0100" }],
      addresses: [{ label: "home", city: "Springfield" }],
    })
    expect(relabel({ first_name: "A" }, storedLabel)).toEqual({ first_name: "A" })
  })
})
