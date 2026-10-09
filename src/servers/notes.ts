import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { runJxa } from "../lib/jxa.js"
import { jsonResult, runTool } from "../lib/mcp-result.js"
import { PACKAGE_VERSION } from "../lib/version.js"

// ── JXA scripts ────────────────────────────────────────────────────────

// Shared by every script that acts on one note. Several notes can share a title, in different
// folders or in the same one, and acting on whichever came first read, overwrote or deleted a note
// the caller never meant. An id is exact; a title has to match exactly one note.
export const NOTE_LOOKUP = String.raw`
function findFolder(app, name) {
  const folder = app.folders().find(f => f.name() === name);
  if (!folder) throw new Error("Folder not found: " + name);
  return folder;
}

function pickNote(matches, title) {
  if (matches.length === 0) throw new Error("Note not found: " + title);
  if (matches.length > 1) {
    const listed = matches.map(m => m.id + " (folder: " + m.folder + ")").join("; ");
    throw new Error(matches.length + " notes are titled \"" + title + "\". Pass the id of the one you mean: " + listed);
  }
  return matches[0];
}

function findNote(app, args) {
  if (args.id) {
    const note = app.notes.byId(args.id);
    try { note.name(); } catch (e) { throw new Error("Note not found: " + args.id); }
    return note;
  }
  const folders = args.folder ? [findFolder(app, args.folder)] : app.folders();
  const matches = [];
  for (const folder of folders) {
    const ids = folder.notes.id();
    const names = folder.notes.name();
    const folderName = folder.name();
    for (let i = 0; i < names.length; i++) {
      if (names[i] === args.title) matches.push({ id: ids[i], folder: folderName });
    }
  }
  return app.notes.byId(pickNote(matches, args.title).id);
}
`

const JXA_LIST_FOLDERS = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const folders = app.folders();
  const result = folders.map(f => ({
    name: f.name(),
    noteCount: f.notes.length,
  }));
  return JSON.stringify(result);
}
`

const JXA_CREATE_FOLDER = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  app.make({ new: "folder", withProperties: { name: args.name } });
  return JSON.stringify({ success: true, name: args.name });
}
`

// A note's plain text, for snippets and search matching. A note whose text cannot be read is not
// blanked or dropped silently: it is still returned, with the reason in `warning`.
export const NOTE_TEXT = String.raw`
function readText(note) {
  try {
    return { text: note.plaintext() };
  } catch (e) {
    return { text: "", warning: "Could not read this note's text: " + e.message };
  }
}
`

export const JXA_LIST_NOTES = String.raw`${NOTE_TEXT}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const limit = args.limit || 50;
  const offset = args.offset || 0;
  const folders = app.folders();
  const folder = folders.find(f => f.name() === args.folder);
  if (!folder) throw new Error("Folder not found: " + args.folder);
  // Each property is read for the whole folder in one Apple event, as search does. Reading them note
  // by note took about ten seconds for a large folder and grew with its size.
  const notes = folder.notes;
  const ids = notes.id();
  const names = notes.name();
  const created = notes.creationDate();
  const modified = notes.modificationDate();
  const end = Math.min(ids.length, offset + limit);
  let texts;
  try {
    texts = notes.plaintext().map(text => ({ text }));
  } catch (e) {
    // One unreadable note fails the bulk read; reading the page note by note confines it to that note.
    const each = notes();
    texts = ids.map((id, i) => (i >= offset && i < end ? readText(each[i]) : { text: "" }));
  }
  const result = [];
  for (let i = offset; i < end; i++) {
    const { text, warning } = texts[i];
    result.push({
      id: ids[i],
      name: names[i],
      creationDate: created[i].toISOString(),
      modificationDate: modified[i].toISOString(),
      snippet: text.slice(0, 100),
      ...(warning ? { warning } : {}),
    });
  }
  return JSON.stringify({ notes: result, total: ids.length, offset, limit });
}
`

export const JXA_GET_NOTE = String.raw`${NOTE_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const note = findNote(app, args);
  return JSON.stringify({
    id: note.id(),
    name: note.name(),
    folder: note.container().name(),
    body: note.body(),
    creationDate: note.creationDate().toISOString(),
    modificationDate: note.modificationDate().toISOString(),
  });
}
`

export const JXA_CREATE_NOTE = String.raw`${NOTE_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const folder = findFolder(app, args.folder);
  const note = app.make({ new: "note", at: folder, withProperties: { name: args.title, body: args.body } });
  return JSON.stringify({ success: true, id: note.id(), name: note.name(), folder: args.folder });
}
`

export const JXA_UPDATE_NOTE = String.raw`${NOTE_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const note = findNote(app, args);
  note.body = args.body;
  return JSON.stringify({ success: true, id: note.id(), name: note.name() });
}
`

export const JXA_MOVE_NOTE = String.raw`${NOTE_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const note = findNote(app, { id: args.id, title: args.title, folder: args.from_folder });
  const toFolder = findFolder(app, args.to_folder);
  const result = { success: true, id: note.id(), name: note.name(), from: note.container().name(), to: args.to_folder };
  app.move(note, { to: toFolder });
  return JSON.stringify(result);
}
`

export const JXA_APPEND_TO_NOTE = String.raw`${NOTE_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const note = findNote(app, args);
  note.body = note.body() + args.content;
  return JSON.stringify({ success: true, id: note.id(), name: note.name() });
}
`

export const JXA_DELETE_NOTE = String.raw`${NOTE_LOOKUP}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const note = findNote(app, args);
  const result = { success: true, id: note.id(), name: note.name() };
  app.delete(note);
  return JSON.stringify(result);
}
`

const JXA_DELETE_FOLDER = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const folders = app.folders();
  const folder = folders.find(f => f.name() === args.name);
  if (!folder) throw new Error("Folder not found: " + args.name);
  app.delete(folder);
  return JSON.stringify({ success: true, name: args.name });
}
`

export const JXA_SEARCH_NOTES = String.raw`${NOTE_TEXT}
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const query = args.query.toLowerCase();
  const limit = args.limit || 20;
  let foldersToSearch = [];
  if (args.folder) {
    const allFolders = app.folders();
    const folder = allFolders.find(f => f.name() === args.folder);
    if (!folder) throw new Error("Folder not found: " + args.folder);
    foldersToSearch = [folder];
  } else {
    foldersToSearch = app.folders();
  }
  const results = [];
  for (const folder of foldersToSearch) {
    if (results.length >= limit) break;
    const folderName = folder.name();
    // Each property is read for the whole folder in one Apple event. Reading them note by note made
    // a full search take tens of seconds, and common words ran past the 30 s limit.
    const names = folder.notes.name();
    let texts;
    try {
      texts = folder.notes.plaintext().map(text => ({ text }));
    } catch (e) {
      // One unreadable note fails the bulk read; reading this folder note by note confines it to that note.
      texts = folder.notes().map(readText);
    }
    let ids = null;
    let modificationDates = null;
    for (let i = 0; i < names.length; i++) {
      if (results.length >= limit) break;
      const { text, warning } = texts[i];
      // An unreadable note might match, so it is returned with its warning rather than skipped.
      if (warning || names[i].toLowerCase().includes(query) || text.toLowerCase().includes(query)) {
        if (!ids) {
          ids = folder.notes.id();
          modificationDates = folder.notes.modificationDate();
        }
        const start = Math.max(0, text.toLowerCase().indexOf(query) - 40);
        results.push({
          id: ids[i],
          name: names[i],
          folder: folderName,
          snippet: text.slice(start, start + 120),
          modificationDate: modificationDates[i].toISOString(),
          ...(warning ? { warning } : {}),
        });
      }
    }
  }
  return JSON.stringify(results);
}
`

// ── Note references ────────────────────────────────────────────────────

/** A single-note tool needs an id or a title. `registerTool` takes a shape, so the rule lives here. */
export const requireNoteRef = ({ id, title }: { id?: string; title?: string }) => {
  if (!id && !title) throw new Error("Pass the note's id or its title.")
}

const noteId = z
  .string()
  .optional()
  .describe("Note id from list_notes, search_notes, get_note or create_note. Exact; use it when titles repeat.")

const noteTitle = z
  .string()
  .optional()
  .describe("Note title. Must match exactly one note (in folder, if given); otherwise the error lists each match's id.")

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-notes",
  version: PACKAGE_VERSION,
})

server.registerTool(
  "list_folders",
  {
    description: "List all folders in Apple Notes",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => runTool("list_folders", () => jsonResult(JSON.parse(runJxa(JXA_LIST_FOLDERS)))),
)

server.registerTool(
  "create_folder",
  {
    description: "Create a new folder in Apple Notes",
    inputSchema: {
      name: z.string().describe("Folder name"),
    },
  },
  async ({ name }) => runTool("create_folder", () => jsonResult(JSON.parse(runJxa(JXA_CREATE_FOLDER, { name })))),
)

server.registerTool(
  "list_notes",
  {
    description: "List all notes in a specified Apple Notes folder",
    inputSchema: {
      folder: z.string().describe("Folder name"),
      limit: z.number().int().min(1).max(500).default(50).describe("Max notes to return"),
      offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ folder, limit, offset }) =>
    runTool("list_notes", () => jsonResult(JSON.parse(runJxa(JXA_LIST_NOTES, { folder, limit, offset })))),
)

server.registerTool(
  "get_note",
  {
    description:
      "Get the full content of one note, by id or by title. A title shared by several notes is an error listing their ids.",
    inputSchema: {
      id: noteId,
      title: noteTitle,
      folder: z.string().optional().describe("Folder name (optional); narrows a title lookup"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, title, folder }) =>
    runTool("get_note", () => {
      requireNoteRef({ id, title })
      return jsonResult(JSON.parse(runJxa(JXA_GET_NOTE, { id, title, folder })))
    }),
)

server.registerTool(
  "create_note",
  {
    description: "Create a new note in a specified Apple Notes folder. Returns the new note's id.",
    inputSchema: {
      title: z.string().describe("Note title"),
      body: z.string().describe("HTML body content"),
      folder: z.string().describe("Folder name"),
    },
  },
  async ({ title, body, folder }) =>
    runTool("create_note", () => jsonResult(JSON.parse(runJxa(JXA_CREATE_NOTE, { title, body, folder })))),
)

server.registerTool(
  "update_note",
  {
    description:
      "Replace the body of one note, by id or by title. A title shared by several notes is refused, listing their ids.",
    inputSchema: {
      id: noteId,
      title: noteTitle,
      body: z.string().describe("New HTML body content"),
      folder: z.string().optional().describe("Folder name (optional); narrows a title lookup"),
    },
  },
  async ({ id, title, body, folder }) =>
    runTool("update_note", () => {
      requireNoteRef({ id, title })
      return jsonResult(JSON.parse(runJxa(JXA_UPDATE_NOTE, { id, title, body, folder })))
    }),
)

server.registerTool(
  "move_note",
  {
    description:
      "Move one note to another folder, by id or by title. A title shared by several notes is refused, listing their ids.",
    inputSchema: {
      id: noteId,
      title: noteTitle,
      from_folder: z.string().optional().describe("Source folder name (optional); narrows a title lookup"),
      to_folder: z.string().describe("Target folder name"),
    },
  },
  async ({ id, title, from_folder, to_folder }) =>
    runTool("move_note", () => {
      requireNoteRef({ id, title })
      return jsonResult(JSON.parse(runJxa(JXA_MOVE_NOTE, { id, title, from_folder, to_folder })))
    }),
)

server.registerTool(
  "append_to_note",
  {
    description:
      "Append HTML content to one note without replacing its body, by id or by title. A title shared by several notes is refused, listing their ids.",
    inputSchema: {
      id: noteId,
      title: noteTitle,
      content: z.string().describe("HTML content to append"),
      folder: z.string().optional().describe("Folder name (optional); narrows a title lookup"),
    },
  },
  async ({ id, title, content, folder }) =>
    runTool("append_to_note", () => {
      requireNoteRef({ id, title })
      return jsonResult(JSON.parse(runJxa(JXA_APPEND_TO_NOTE, { id, title, content, folder })))
    }),
)

server.registerTool(
  "delete_note",
  {
    description: "Delete one note, by id or by title. A title shared by several notes is refused, listing their ids.",
    inputSchema: {
      id: noteId,
      title: noteTitle,
      folder: z.string().optional().describe("Folder name (optional); narrows a title lookup"),
    },
  },
  async ({ id, title, folder }) =>
    runTool("delete_note", () => {
      requireNoteRef({ id, title })
      return jsonResult(JSON.parse(runJxa(JXA_DELETE_NOTE, { id, title, folder })))
    }),
)

server.registerTool(
  "delete_folder",
  {
    description: "Delete a folder and all its notes from Apple Notes",
    inputSchema: {
      name: z.string().describe("Folder name"),
    },
  },
  async ({ name }) => runTool("delete_folder", () => jsonResult(JSON.parse(runJxa(JXA_DELETE_FOLDER, { name })))),
)

server.registerTool(
  "search_notes",
  {
    description:
      "Search notes by keyword across all folders or within a specific folder. Searches both titles and body content. Results carry each note's id.",
    inputSchema: {
      query: z.string().describe("Search query"),
      folder: z.string().optional().describe("Folder name to scope search (optional)"),
      limit: z.number().int().min(1).max(200).default(20).describe("Max results to return"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, folder, limit }) =>
    runTool("search_notes", () => jsonResult(JSON.parse(runJxa(JXA_SEARCH_NOTES, { query, limit, folder })))),
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
