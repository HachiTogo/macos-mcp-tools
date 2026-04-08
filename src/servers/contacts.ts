import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runJxa } from "../lib/jxa.js";

// ── JXA scripts ────────────────────────────────────────────────────────

const JXA_CONTACTS_READ = String.raw`
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

const JXA_CONTACTS_SEARCH = String.raw`
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

const JXA_CONTACTS_GET = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  let p = null;
  try {
    const found = app.people.whose({ id: args.id });
    if (found && found.length > 0) p = found[0];
  } catch (e) {}
  if (!p) throw new Error("Contact not found: " + args.id);
  const emails = [];
  try {
    const es = p.emails();
    for (const e of es) {
      emails.push({ label: e.label() || "", value: e.value() || "" });
    }
  } catch (e) {}
  const phones = [];
  try {
    const ps = p.phones();
    for (const ph of ps) {
      phones.push({ label: ph.label() || "", value: ph.value() || "" });
    }
  } catch (e) {}
  const addresses = [];
  try {
    const as = p.addresses();
    for (const a of as) {
      addresses.push({
        label: a.label() || "",
        street: a.street() || "",
        city: a.city() || "",
        state: a.state() || "",
        zip: a.zip() || "",
        country: a.country() || "",
      });
    }
  } catch (e) {}
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

const JXA_CONTACTS_UPDATE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  let p = null;
  try {
    const found = app.people.whose({ id: args.id });
    if (found && found.length > 0) p = found[0];
  } catch (e) {}
  if (!p) throw new Error("Contact not found: " + args.id);
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

const JXA_CONTACTS_DELETE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  if (!args.confirm) throw new Error("Set confirm: true to delete");
  const app = Application("Contacts");
  let p = null;
  try {
    const found = app.people.whose({ id: args.id });
    if (found && found.length > 0) p = found[0];
  } catch (e) {}
  if (!p) throw new Error("Contact not found: " + args.id);
  app.delete(p);
  app.save();
  return JSON.stringify({ success: true, id: args.id });
}
`

const JXA_GROUPS_READ = String.raw`
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

const JXA_GROUPS_GET = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  const found = app.groups.whose({ name: args.name });
  if (!found || found.length === 0) throw new Error("Group not found: " + args.name);
  const g = found[0];
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

const JXA_GROUPS_DELETE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  if (!args.confirm) throw new Error("Set confirm: true to delete");
  const app = Application("Contacts");
  const found = app.groups.whose({ name: args.name });
  if (!found || found.length === 0) throw new Error("Group not found: " + args.name);
  app.delete(found[0]);
  app.save();
  return JSON.stringify({ success: true, name: args.name });
}
`

const JXA_GROUPS_ADD_MEMBER = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  let p = null;
  try {
    const found = app.people.whose({ id: args.person_id });
    if (found && found.length > 0) p = found[0];
  } catch (e) {}
  if (!p) throw new Error("Contact not found: " + args.person_id);
  const gFound = app.groups.whose({ name: args.name });
  if (!gFound || gFound.length === 0) throw new Error("Group not found: " + args.name);
  const g = gFound[0];
  app.add(p, { to: g });
  app.save();
  return JSON.stringify({ success: true, group: args.name, person_id: args.person_id });
}
`

const JXA_GROUPS_REMOVE_MEMBER = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Contacts");
  let p = null;
  try {
    const found = app.people.whose({ id: args.person_id });
    if (found && found.length > 0) p = found[0];
  } catch (e) {}
  if (!p) throw new Error("Contact not found: " + args.person_id);
  const gFound = app.groups.whose({ name: args.name });
  if (!gFound || gFound.length === 0) throw new Error("Group not found: " + args.name);
  const g = gFound[0];
  app.remove(p, { from: g });
  app.save();
  return JSON.stringify({ success: true, group: args.name, person_id: args.person_id });
}
`

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-contacts",
  version: "0.0.1",
});

server.registerTool(
  "contacts_people",
  {
    description: "Manage Apple Contacts people. Actions: read (list), search, get (full detail), create, update, delete.",
    inputSchema: {
      action: z.enum(["read", "search", "get", "create", "update", "delete"]).describe("Operation to perform"),
      limit: z.number().int().min(1).max(500).default(100).optional().describe("Max contacts to return (read/search)"),
      offset: z.number().int().min(0).default(0).optional().describe("Pagination offset (read/search)"),
      query: z.string().optional().describe("Search query (search action)"),
      id: z.string().optional().describe("Contact ID (get/update/delete)"),
      first_name: z.string().optional().describe("First name (create/update)"),
      last_name: z.string().optional().describe("Last name (create/update)"),
      organization: z.string().optional().describe("Organization (create/update)"),
      job_title: z.string().optional().describe("Job title (create/update)"),
      emails: z.array(z.object({ label: z.string(), value: z.string() })).optional().describe("Email addresses (create/update — adds, does not remove)"),
      phones: z.array(z.object({ label: z.string(), value: z.string() })).optional().describe("Phone numbers (create/update — adds, does not remove)"),
      note: z.string().optional().describe("Note text (create/update)"),
      confirm: z.boolean().optional().describe("Must be true to confirm delete"),
    },
  },
  async (args) => {
    try {
      let raw: string;
      switch (args.action) {
        case "read":
          raw = runJxa(JXA_CONTACTS_READ, { limit: args.limit, offset: args.offset });
          break;
        case "search":
          raw = runJxa(JXA_CONTACTS_SEARCH, { query: args.query, limit: args.limit, offset: args.offset });
          break;
        case "get":
          raw = runJxa(JXA_CONTACTS_GET, { id: args.id });
          break;
        case "create":
          raw = runJxa(JXA_CONTACTS_CREATE, {
            first_name: args.first_name,
            last_name: args.last_name,
            organization: args.organization,
            job_title: args.job_title,
            emails: args.emails,
            phones: args.phones,
            note: args.note,
          });
          break;
        case "update":
          raw = runJxa(JXA_CONTACTS_UPDATE, {
            id: args.id,
            first_name: args.first_name,
            last_name: args.last_name,
            organization: args.organization,
            job_title: args.job_title,
            emails: args.emails,
            phones: args.phones,
            note: args.note,
          });
          break;
        case "delete":
          raw = runJxa(JXA_CONTACTS_DELETE, { id: args.id, confirm: args.confirm });
          break;
        default:
          return { content: [{ type: "text" as const, text: "Unknown action" }], isError: true };
      }
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "contacts_groups",
  {
    description: "Manage Apple Contacts groups. Actions: read (list all), get (members of a group), create, delete, add_member, remove_member.",
    inputSchema: {
      action: z.enum(["read", "get", "create", "delete", "add_member", "remove_member"]).describe("Operation to perform"),
      name: z.string().optional().describe("Group name (get/create/delete/add_member/remove_member)"),
      person_id: z.string().optional().describe("Contact ID for add_member/remove_member"),
      confirm: z.boolean().optional().describe("Must be true to confirm delete"),
    },
  },
  async (args) => {
    try {
      let raw: string;
      switch (args.action) {
        case "read":
          raw = runJxa(JXA_GROUPS_READ, {});
          break;
        case "get":
          raw = runJxa(JXA_GROUPS_GET, { name: args.name });
          break;
        case "create":
          raw = runJxa(JXA_GROUPS_CREATE, { name: args.name });
          break;
        case "delete":
          raw = runJxa(JXA_GROUPS_DELETE, { name: args.name, confirm: args.confirm });
          break;
        case "add_member":
          raw = runJxa(JXA_GROUPS_ADD_MEMBER, { name: args.name, person_id: args.person_id });
          break;
        case "remove_member":
          raw = runJxa(JXA_GROUPS_REMOVE_MEMBER, { name: args.name, person_id: args.person_id });
          break;
        default:
          return { content: [{ type: "text" as const, text: "Unknown action" }], isError: true };
      }
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

// ── Entry point ────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
