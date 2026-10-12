import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { CREATE, DESTRUCTIVE, READ, SET } from "../lib/annotations"
import { runJxa } from "../lib/jxa.js"
import { jsonResult, runTool } from "../lib/mcp-result.js"
import { offsetArg } from "../lib/paging"
import { PACKAGE_VERSION } from "../lib/version.js"

// ── JXA scripts ────────────────────────────────────────────────────────

// Shared by the scripts that act on one contact. Neither helper swallows an error: a lookup that
// fails reports its cause rather than "not found", and a field that cannot be read leaves the rest
// of the contact intact and is named in `warnings`.
export const CONTACT_HELPERS = String.raw`
function findPerson(app, id) {
  let matches;
  try {
    matches = app.people.whose({ id: id })();
  } catch (e) {
    throw new Error("Could not look up contact " + id + ": " + e.message);
  }
  if (matches.length === 0) throw new Error("Contact not found: " + id);
  return matches[0];
}

function readList(warnings, field, read) {
  try {
    return read();
  } catch (e) {
    warnings.push("Could not read " + field + ": " + e.message);
    return [];
  }
}
`

export const JXA_CONTACTS_READ = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const limit = args.limit || 100;
  const offset = args.offset || 0;
  const ids = app.people.id();
  const firstNames = app.people.firstName();
  const lastNames = app.people.lastName();
  const orgs = app.people.organization();
  const total = ids.length;
  const combined = [];
  for (let i = 0; i < total; i++) {
    combined.push({
      id: ids[i] || "",
      first_name: firstNames[i] || "",
      last_name: lastNames[i] || "",
      organization: orgs[i] || "",
    });
  }
  combined.sort((a, b) => {
    const la = (a.last_name || a.first_name || "").toLowerCase();
    const lb = (b.last_name || b.first_name || "").toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  const page = combined.slice(offset, offset + limit);
  return JSON.stringify({ contacts: page, total, offset, limit });
}
`

export const JXA_CONTACTS_SEARCH = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const limit = args.limit || 100;
  const offset = args.offset || 0;
  const query = (args.query || "").toLowerCase();
  const ids = app.people.id();
  const firstNames = app.people.firstName();
  const lastNames = app.people.lastName();
  const orgs = app.people.organization();
  const total = ids.length;
  const matches = [];
  for (let i = 0; i < total; i++) {
    const fn = (firstNames[i] || "").toLowerCase();
    const ln = (lastNames[i] || "").toLowerCase();
    const org = (orgs[i] || "").toLowerCase();
    if (fn.includes(query) || ln.includes(query) || org.includes(query) || (fn + " " + ln).includes(query)) {
      matches.push({
        id: ids[i] || "",
        first_name: firstNames[i] || "",
        last_name: lastNames[i] || "",
        organization: orgs[i] || "",
      });
    }
  }
  matches.sort((a, b) => {
    const la = (a.last_name || a.first_name || "").toLowerCase();
    const lb = (b.last_name || b.first_name || "").toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  const page = matches.slice(offset, offset + limit);
  return JSON.stringify({ contacts: page, total: matches.length, offset, limit });
}
`

export const JXA_CONTACTS_GET = String.raw`${CONTACT_HELPERS}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const p = findPerson(app, args.id);
  const warnings = [];
  const emails = readList(warnings, "emails", () =>
    p.emails().map(e => ({ label: e.label() || "", value: e.value() || "" })));
  const phones = readList(warnings, "phones", () =>
    p.phones().map(ph => ({ label: ph.label() || "", value: ph.value() || "" })));
  const addresses = readList(warnings, "addresses", () =>
    p.addresses().map(a => ({
      label: a.label() || "",
      street: a.street() || "",
      city: a.city() || "",
      state: a.state() || "",
      zip: a.zip() || "",
      country: a.country() || "",
    })));
  return JSON.stringify({
    id: p.id(),
    first_name: p.firstName() || "",
    last_name: p.lastName() || "",
    organization: p.organization() || "",
    job_title: p.jobTitle() || "",
    note: p.note() || "",
    emails,
    phones,
    addresses,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
`

const JXA_CONTACTS_CREATE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const props = {};
  if (args.first_name !== undefined) props.firstName = args.first_name;
  if (args.last_name !== undefined) props.lastName = args.last_name;
  if (args.organization !== undefined) props.organization = args.organization;
  if (args.job_title !== undefined) props.jobTitle = args.job_title;
  if (args.note !== undefined) props.note = args.note;
  const p = app.Person(props);
  app.people.push(p);
  if (args.emails && args.emails.length > 0) {
    for (const e of args.emails) {
      p.emails.push(app.Email({ label: e.label, value: e.value }));
    }
  }
  if (args.phones && args.phones.length > 0) {
    for (const ph of args.phones) {
      p.phones.push(app.Phone({ label: ph.label, value: ph.value }));
    }
  }
  app.save();
  return JSON.stringify({ success: true, id: p.id() });
}
`

export const JXA_CONTACTS_UPDATE = String.raw`${CONTACT_HELPERS}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const p = findPerson(app, args.id);
  if (args.first_name !== undefined) p.firstName = args.first_name;
  if (args.last_name !== undefined) p.lastName = args.last_name;
  if (args.organization !== undefined) p.organization = args.organization;
  if (args.job_title !== undefined) p.jobTitle = args.job_title;
  if (args.note !== undefined) p.note = args.note;
  if (args.emails && args.emails.length > 0) {
    for (const e of args.emails) {
      p.emails.push(app.Email({ label: e.label, value: e.value }));
    }
  }
  if (args.phones && args.phones.length > 0) {
    for (const ph of args.phones) {
      p.phones.push(app.Phone({ label: ph.label, value: ph.value }));
    }
  }
  app.save();
  return JSON.stringify({ success: true, id: p.id() });
}
`

export const JXA_CONTACTS_DELETE = String.raw`${CONTACT_HELPERS}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const p = findPerson(app, args.id);
  app.delete(p);
  app.save();
  return JSON.stringify({ success: true, id: args.id });
}
`

// A group is named by the id list_contact_groups returns, or by its name.
export const GROUP_LOOKUP = String.raw`
function findGroup(app, ref) {
  const byId = app.groups.whose({ id: ref });
  const found = byId.length > 0 ? byId : app.groups.whose({ name: ref });
  if (found.length === 0) throw new Error("Group not found: " + ref);
  return found[0];
}
`

export const JXA_GROUPS_READ = String.raw`
function run(argv) {
  const app = Application("Contacts");
  const groups = app.groups();
  const result = groups.map(g => ({
    name: g.name(),
    id: g.id(),
    memberCount: g.people().length,
  }));
  return JSON.stringify(result);
}
`

export const JXA_GROUPS_GET = String.raw`${GROUP_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const g = findGroup(app, args.group);
  const people = g.people();
  const members = people.map(p => ({
    id: p.id(),
    first_name: p.firstName() || "",
    last_name: p.lastName() || "",
    organization: p.organization() || "",
  }));
  return JSON.stringify({ name: g.name(), id: g.id(), members });
}
`

const JXA_GROUPS_CREATE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const g = app.Group({ name: args.name });
  app.groups.push(g);
  app.save();
  return JSON.stringify({ success: true, name: args.name, id: g.id() });
}
`

const JXA_GROUPS_DELETE = String.raw`${GROUP_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const g = findGroup(app, args.group);
  const name = g.name();
  app.delete(g);
  app.save();
  return JSON.stringify({ success: true, name });
}
`

export const JXA_GROUPS_ADD_MEMBER = String.raw`${CONTACT_HELPERS}${GROUP_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const p = findPerson(app, args.person_id);
  const g = findGroup(app, args.group);
  app.add(p, { to: g });
  app.save();
  return JSON.stringify({ success: true, group: g.name(), person_id: args.person_id });
}
`

export const JXA_GROUPS_REMOVE_MEMBER = String.raw`${CONTACT_HELPERS}${GROUP_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const p = findPerson(app, args.person_id);
  const g = findGroup(app, args.group);
  app.remove(p, { from: g });
  app.save();
  return JSON.stringify({ success: true, group: g.name(), person_id: args.person_id });
}
`

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-contacts",
  version: PACKAGE_VERSION,
})

// The structuredContent each read tool declares. Objects are loose, so a field present only
// sometimes, or added later, never fails a call that worked; nested items detail only what agents
// pass back. Lists come back wrapped as { result }, as jsonResult wraps every array.
const withId = z.looseObject({ id: z.string() })
export const contactsPageOutput = z.looseObject({
  contacts: z.array(withId),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
})
export const contactOutput = withId
export const contactGroupsOutput = z.looseObject({
  result: z.array(z.looseObject({ id: z.string(), name: z.string() })),
})
export const contactGroupOutput = z.looseObject({ id: z.string(), name: z.string(), members: z.array(withId) })

/** Every contacts tool runs one JXA script and returns its JSON. */
const runScript = (operation: string, script: string, args: Record<string, unknown>) =>
  runTool(operation, () => jsonResult(JSON.parse(runJxa(script, args))))

const contactId = z.string().min(1).describe("Contact id, as returned by list_contacts or search_contacts")
const groupRef = z.string().min(1).describe("Group id or name, as returned by list_contact_groups")
const limit = z.number().int().min(1).max(500).default(100).optional().describe("Max contacts to return")
const offset = offsetArg("contacts")
const contactFields = {
  first_name: z.string().optional().describe("First name"),
  last_name: z.string().optional().describe("Last name"),
  organization: z.string().optional().describe("Organization"),
  job_title: z.string().optional().describe("Job title"),
  emails: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe("Email addresses to add (existing ones are kept)"),
  phones: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe("Phone numbers to add (existing ones are kept)"),
  note: z.string().optional().describe("Note text"),
}

server.registerTool(
  "list_contacts",
  {
    description: "List Apple Contacts people, sorted by last name.",
    inputSchema: { limit, offset },
    outputSchema: contactsPageOutput,
    annotations: READ,
  },
  async (args) => runScript("list_contacts", JXA_CONTACTS_READ, args),
)

server.registerTool(
  "search_contacts",
  {
    description: "Search Apple Contacts people by name or organization.",
    inputSchema: { query: z.string().min(1).describe("Text to match in names or organization"), limit, offset },
    outputSchema: contactsPageOutput,
    annotations: READ,
  },
  async (args) => runScript("search_contacts", JXA_CONTACTS_SEARCH, args),
)

server.registerTool(
  "get_contact",
  {
    description: "Get one contact's full details: emails, phones, addresses, note.",
    inputSchema: { id: contactId },
    outputSchema: contactOutput,
    annotations: READ,
  },
  async ({ id }) => runScript("get_contact", JXA_CONTACTS_GET, { id }),
)

server.registerTool(
  "create_contact",
  { description: "Create a contact.", inputSchema: contactFields, annotations: CREATE },
  async (args) => runScript("create_contact", JXA_CONTACTS_CREATE, args),
)

server.registerTool(
  "update_contact",
  {
    description: "Update a contact. Only the fields given change; emails and phones are added, never removed.",
    inputSchema: { id: contactId, ...contactFields },
    annotations: DESTRUCTIVE,
  },
  async (args) => runScript("update_contact", JXA_CONTACTS_UPDATE, args),
)

server.registerTool(
  "delete_contact",
  { description: "Delete a contact.", inputSchema: { id: contactId }, annotations: DESTRUCTIVE },
  async ({ id }) => runScript("delete_contact", JXA_CONTACTS_DELETE, { id }),
)

server.registerTool(
  "list_contact_groups",
  {
    description: "List Apple Contacts groups with their member counts.",
    inputSchema: {},
    outputSchema: contactGroupsOutput,
    annotations: READ,
  },
  async () => runScript("list_contact_groups", JXA_GROUPS_READ, {}),
)

server.registerTool(
  "get_contact_group",
  {
    description: "List the members of a contact group.",
    inputSchema: { group: groupRef },
    outputSchema: contactGroupOutput,
    annotations: READ,
  },
  async ({ group }) => runScript("get_contact_group", JXA_GROUPS_GET, { group }),
)

server.registerTool(
  "create_contact_group",
  {
    description: "Create a contact group.",
    inputSchema: { name: z.string().min(1).describe("Group name") },
    annotations: CREATE,
  },
  async ({ name }) => runScript("create_contact_group", JXA_GROUPS_CREATE, { name }),
)

server.registerTool(
  "delete_contact_group",
  {
    description: "Delete a contact group. Its members are not deleted.",
    inputSchema: { group: groupRef },
    annotations: DESTRUCTIVE,
  },
  async ({ group }) => runScript("delete_contact_group", JXA_GROUPS_DELETE, { group }),
)

server.registerTool(
  "add_contact_to_group",
  {
    description: "Add a contact to a group.",
    inputSchema: { group: groupRef, contact_id: contactId },
    annotations: SET,
  },
  async ({ group, contact_id }) =>
    runScript("add_contact_to_group", JXA_GROUPS_ADD_MEMBER, { group, person_id: contact_id }),
)

server.registerTool(
  "remove_contact_from_group",
  {
    description: "Remove a contact from a group. The contact itself is kept.",
    inputSchema: { group: groupRef, contact_id: contactId },
    annotations: DESTRUCTIVE,
  },
  async ({ group, contact_id }) =>
    runScript("remove_contact_from_group", JXA_GROUPS_REMOVE_MEMBER, { group, person_id: contact_id }),
)

// ── Entry point ────────────────────────────────────────────────────────

export const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Boot only when executed directly; cli.ts and tests import this module without starting a server.
if (import.meta.main) {
  await main()
}
