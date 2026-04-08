import { describe, expect, test } from "bun:test"

import {
  chooseOccurrenceTimestamp,
  compareEntriesForRecency,
  computeDurationSince,
  matchEntry,
  normalizeAliases,
  normalizeEntry,
  normalizeText,
  type NormalizedEntry,
} from "./memory"

const createEntry = (overrides: Partial<NormalizedEntry> = {}): NormalizedEntry => ({
  id: overrides.id ?? "entry-1",
  kind: overrides.kind ?? "memory",
  title: overrides.title ?? null,
  body: overrides.body ?? null,
  subject: overrides.subject ?? null,
  action: overrides.action ?? null,
  object: overrides.object ?? null,
  status: overrides.status ?? null,
  happened_at: overrides.happened_at ?? null,
  start_at: overrides.start_at ?? null,
  end_at: overrides.end_at ?? null,
  due_at: overrides.due_at ?? null,
  cost_amount: overrides.cost_amount ?? null,
  cost_currency: overrides.cost_currency ?? null,
  source: overrides.source ?? null,
  created_at: overrides.created_at ?? "2026-03-01T00:00:00.000Z",
  updated_at: overrides.updated_at ?? "2026-03-01T00:00:00.000Z",
  aliases: overrides.aliases ?? [],
})

describe("sqlite-memory pure helpers", () => {
  test("normalizeText trims, lowercases, removes accents, and collapses punctuation", () => {
    expect(normalizeText("  Café—Plan!!  ")).toBe("cafe plan")
    expect(normalizeText(null)).toBe("")
  })

  test("normalizeAliases trims, deduplicates, and sorts aliases", () => {
    expect(normalizeAliases(["Zulu", " alpha ", "", "Beta", "alpha", "Zulu"])).toEqual([
      "alpha",
      "Beta",
      "Zulu",
    ])
  })

  test("chooseOccurrenceTimestamp prefers happened_at, then start_at, then created_at", () => {
    expect(
      chooseOccurrenceTimestamp(
        createEntry({
          happened_at: "2026-03-03T12:00:00.000Z",
          start_at: "2026-03-02T12:00:00.000Z",
        }),
      ),
    ).toEqual({
      timestamp: "2026-03-03T12:00:00.000Z",
      field: "happened_at",
    })

    expect(
      chooseOccurrenceTimestamp(
        createEntry({
          happened_at: null,
          start_at: "2026-03-02T12:00:00.000Z",
        }),
      ),
    ).toEqual({
      timestamp: "2026-03-02T12:00:00.000Z",
      field: "start_at",
    })

    expect(
      chooseOccurrenceTimestamp(
        createEntry({
          happened_at: null,
          start_at: null,
          created_at: "2026-03-01T12:00:00.000Z",
        }),
      ),
    ).toEqual({
      timestamp: "2026-03-01T12:00:00.000Z",
      field: "created_at",
    })
  })

  test("computeDurationSince returns deterministic elapsed days and hours", () => {
    expect(
      computeDurationSince("2026-03-10T06:00:00.000Z", new Date("2026-03-12T12:00:00.000Z")),
    ).toEqual({
      elapsed_days: 2,
      elapsed_hours: 54,
    })
  })

  test("normalizeEntry includes structured cost fields in normalized entries", () => {
    expect(
      normalizeEntry(
        {
          id: "entry-cost",
          kind: "memory",
          title: "Driveway work",
          body: null,
          subject: null,
          action: null,
          object: null,
          status: null,
          happened_at: null,
          start_at: null,
          end_at: null,
          due_at: null,
          cost_amount: 0,
          cost_currency: "USD",
          source: "seed",
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-01T00:00:00.000Z",
        },
        ["Driveway"],
      ),
    ).toMatchObject({
      id: "entry-cost",
      cost_amount: 0,
      cost_currency: "USD",
      aliases: ["Driveway"],
    })
  })

  test("normalizeEntry represents cleared cost fields as null", () => {
    expect(
      normalizeEntry(
        {
          id: "entry-cleared-cost",
          kind: "note",
          title: null,
          body: null,
          subject: null,
          action: null,
          object: null,
          status: null,
          happened_at: null,
          start_at: null,
          end_at: null,
          due_at: null,
          cost_amount: null,
          cost_currency: null,
          source: null,
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-02T00:00:00.000Z",
        },
        [],
      ),
    ).toMatchObject({
      id: "entry-cleared-cost",
      cost_amount: null,
      cost_currency: null,
    })
  })

  test("matchEntry performs exact structured matching", () => {
    expect(
      matchEntry(
        createEntry({
          subject: "James",
          action: "met",
          object: "Alice",
        }),
        {
          subject: "james",
          action: "met",
          object: "alice",
        },
      ),
    ).toEqual({
      matched: true,
      reason: "exact",
      exactScore: 3,
      keywordScore: 0,
      queryTerms: ["james", "met", "alice"],
    })
  })

  test("matchEntry performs alias-based exact matching", () => {
    expect(
      matchEntry(
        createEntry({
          subject: "James",
          aliases: ["Jim"],
        }),
        {
          subject: "jim",
        },
      ),
    ).toEqual({
      matched: true,
      reason: "exact",
      exactScore: 1,
      keywordScore: 0,
      queryTerms: ["jim"],
    })
  })

  test("matchEntry falls back to keyword matching across searchable text", () => {
    expect(
      matchEntry(
        createEntry({
          title: "Quarterly roadmap",
          body: "Launch checklist for Seattle office",
        }),
        {
          keywords: ["launch", "seattle"],
        },
      ),
    ).toEqual({
      matched: true,
      reason: "keywords",
      exactScore: 0,
      keywordScore: 2,
      queryTerms: ["launch", "seattle"],
    })
  })

  test("compareEntriesForRecency uses timestamp priority and deterministic tie-breaking", () => {
    expect(
      compareEntriesForRecency(
        createEntry({
          id: "priority-left",
          happened_at: "2026-03-05T00:00:00.000Z",
          start_at: "2026-03-10T00:00:00.000Z",
        }),
        createEntry({
          id: "priority-right",
          happened_at: null,
          start_at: "2026-03-06T00:00:00.000Z",
        }),
      ),
    ).toBeGreaterThan(0)

    expect(
      compareEntriesForRecency(
        createEntry({
          id: "updated-newer",
          happened_at: "2026-03-05T00:00:00.000Z",
          updated_at: "2026-03-07T00:00:00.000Z",
        }),
        createEntry({
          id: "updated-older",
          happened_at: "2026-03-05T00:00:00.000Z",
          updated_at: "2026-03-06T00:00:00.000Z",
        }),
      ),
    ).toBeLessThan(0)

    expect(
      compareEntriesForRecency(
        createEntry({
          id: "created-newer",
          happened_at: "2026-03-05T00:00:00.000Z",
          updated_at: "2026-03-07T00:00:00.000Z",
          created_at: "2026-03-03T00:00:00.000Z",
        }),
        createEntry({
          id: "created-older",
          happened_at: "2026-03-05T00:00:00.000Z",
          updated_at: "2026-03-07T00:00:00.000Z",
          created_at: "2026-03-02T00:00:00.000Z",
        }),
      ),
    ).toBeLessThan(0)

    expect(
      compareEntriesForRecency(
        createEntry({
          id: "alpha",
          happened_at: "2026-03-05T00:00:00.000Z",
          updated_at: "2026-03-07T00:00:00.000Z",
          created_at: "2026-03-03T00:00:00.000Z",
        }),
        createEntry({
          id: "beta",
          happened_at: "2026-03-05T00:00:00.000Z",
          updated_at: "2026-03-07T00:00:00.000Z",
          created_at: "2026-03-03T00:00:00.000Z",
        }),
      ),
    ).toBeLessThan(0)
  })
})
