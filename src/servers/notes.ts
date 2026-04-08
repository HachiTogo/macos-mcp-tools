import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runJxa } from "../lib/jxa.js";

// ── JXA scripts ────────────────────────────────────────────────────────

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

const JXA_LIST_NOTES = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const limit = args.limit || 50;
  const offset = args.offset || 0;
  const folders = app.folders();
  const folder = folders.find(f => f.name() === args.folder);
  if (!folder) throw new Error("Folder not found: " + args.folder);
  const notes = folder.notes();
  const page = notes.slice(offset, offset + limit);
  const result = page.map(n => {
    let snippet = "";
    try {
      const pt = n.plaintext ? n.plaintext() : "";
      snippet = pt.slice(0, 100);
    } catch (e) {
      try { snippet = n.body().replace(/<[^>]+>/g, "").slice(0, 100); } catch (e2) {}
    }
    return {
      id: n.id(),
      name: n.name(),
      creationDate: n.creationDate().toISOString(),
      modificationDate: n.modificationDate().toISOString(),
      snippet,
    };
  });
  return JSON.stringify({ notes: result, total: notes.length, offset, limit });
}
`

const JXA_GET_NOTE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  let note = null;
  let folderName = null;
  if (args.folder) {
    const folders = app.folders();
    const folder = folders.find(f => f.name() === args.folder);
    if (!folder) throw new Error("Folder not found: " + args.folder);
    const notes = folder.notes();
    note = notes.find(n => n.name() === args.title);
    folderName = args.folder;
  } else {
    const folders = app.folders();
    for (const folder of folders) {
      const notes = folder.notes();
      const found = notes.find(n => n.name() === args.title);
      if (found) {
        note = found;
        folderName = folder.name();
        break;
      }
    }
  }
  if (!note) throw new Error("Note not found: " + args.title);
  return JSON.stringify({
    name: note.name(),
    folder: folderName,
    body: note.body(),
    creationDate: note.creationDate().toISOString(),
    modificationDate: note.modificationDate().toISOString(),
  });
}
`

const JXA_CREATE_NOTE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const folders = app.folders();
  const folder = folders.find(f => f.name() === args.folder);
  if (!folder) throw new Error("Folder not found: " + args.folder);
  const note = app.make({ new: "note", at: folder, withProperties: { name: args.title, body: args.body } });
  return JSON.stringify({ success: true, name: note.name(), folder: args.folder });
}
`

const JXA_UPDATE_NOTE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  let note = null;
  if (args.folder) {
    const folders = app.folders();
    const folder = folders.find(f => f.name() === args.folder);
    if (!folder) throw new Error("Folder not found: " + args.folder);
    const notes = folder.notes();
    note = notes.find(n => n.name() === args.title);
  } else {
    const folders = app.folders();
    for (const folder of folders) {
      const notes = folder.notes();
      const found = notes.find(n => n.name() === args.title);
      if (found) { note = found; break; }
    }
  }
  if (!note) throw new Error("Note not found: " + args.title);
  note.body = args.body;
  return JSON.stringify({ success: true, name: args.title });
}
`

const JXA_MOVE_NOTE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const folders = app.folders();
  const fromFolder = folders.find(f => f.name() === args.from_folder);
  if (!fromFolder) throw new Error("Source folder not found: " + args.from_folder);
  const toFolder = folders.find(f => f.name() === args.to_folder);
  if (!toFolder) throw new Error("Target folder not found: " + args.to_folder);
  const notes = fromFolder.notes();
  const note = notes.find(n => n.name() === args.title);
  if (!note) throw new Error("Note not found: " + args.title);
  app.move(note, { to: toFolder });
  return JSON.stringify({ success: true, name: args.title, from: args.from_folder, to: args.to_folder });
}
`

const JXA_APPEND_TO_NOTE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  let note = null;
  if (args.folder) {
    const folders = app.folders();
    const folder = folders.find(f => f.name() === args.folder);
    if (!folder) throw new Error("Folder not found: " + args.folder);
    const notes = folder.notes();
    note = notes.find(n => n.name() === args.title);
  } else {
    const folders = app.folders();
    for (const folder of folders) {
      const notes = folder.notes();
      const found = notes.find(n => n.name() === args.title);
      if (found) { note = found; break; }
    }
  }
  if (!note) throw new Error("Note not found: " + args.title);
  note.body = note.body() + args.content;
  return JSON.stringify({ success: true, name: args.title });
}
`

const JXA_DELETE_NOTE = String.raw`
function run(argv) {
  const args = JSON.parse(argv[0] || "{}");
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  let note = null;
  if (args.folder) {
    const folders = app.folders();
    const folder = folders.find(f => f.name() === args.folder);
    if (!folder) throw new Error("Folder not found: " + args.folder);
    const notes = folder.notes();
    note = notes.find(n => n.name() === args.title);
  } else {
    const folders = app.folders();
    for (const folder of folders) {
      const notes = folder.notes();
      const found = notes.find(n => n.name() === args.title);
      if (found) { note = found; break; }
    }
  }
  if (!note) throw new Error("Note not found: " + args.title);
  app.delete(note);
  return JSON.stringify({ success: true, name: args.title });
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

const JXA_SEARCH_NOTES = String.raw`
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
    const notes = folder.notes();
    for (const note of notes) {
      if (results.length >= limit) break;
      const title = note.name().toLowerCase();
      let bodyText = "";
      try {
        bodyText = note.plaintext ? note.plaintext().toLowerCase() : note.body().replace(/<[^>]+>/g, "").toLowerCase();
      } catch (e) {
        try { bodyText = note.body().replace(/<[^>]+>/g, "").toLowerCase(); } catch (e2) {}
      }
      if (title.includes(query) || bodyText.includes(query)) {
        let snippet = "";
        try {
          const pt = note.plaintext ? note.plaintext() : note.body().replace(/<[^>]+>/g, "");
          const idx = pt.toLowerCase().indexOf(query);
          const start = Math.max(0, idx - 40);
          snippet = pt.slice(start, start + 120);
        } catch (e) {}
        results.push({
          name: note.name(),
          folder: folderName,
          snippet,
          modificationDate: note.modificationDate().toISOString(),
        });
      }
    }
  }
  return JSON.stringify(results);
}
`

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "apple-notes",
  version: "0.0.1",
});

server.registerTool(
  "list_folders",
  {
    description: "List all folders in Apple Notes",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const raw = runJxa(JXA_LIST_FOLDERS);
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "create_folder",
  {
    description: "Create a new folder in Apple Notes",
    inputSchema: {
      name: z.string().describe("Folder name"),
    },
  },
  async ({ name }) => {
    try {
      const raw = runJxa(JXA_CREATE_FOLDER, { name });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

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
  async ({ folder, limit, offset }) => {
    try {
      const raw = runJxa(JXA_LIST_NOTES, { folder, limit, offset });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "get_note",
  {
    description: "Get the full content of a specific note by title",
    inputSchema: {
      title: z.string().describe("Note title"),
      folder: z.string().optional().describe("Folder name (optional)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ title, folder }) => {
    try {
      const raw = runJxa(JXA_GET_NOTE, { title, ...(folder !== undefined ? { folder } : {}) });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "create_note",
  {
    description: "Create a new note in a specified Apple Notes folder",
    inputSchema: {
      title: z.string().describe("Note title"),
      body: z.string().describe("HTML body content"),
      folder: z.string().describe("Folder name"),
    },
  },
  async ({ title, body, folder }) => {
    try {
      const raw = runJxa(JXA_CREATE_NOTE, { title, body, folder });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "update_note",
  {
    description: "Update the body of an existing note",
    inputSchema: {
      title: z.string().describe("Note title"),
      body: z.string().describe("New HTML body content"),
      folder: z.string().optional().describe("Folder name (optional)"),
    },
  },
  async ({ title, body, folder }) => {
    try {
      const raw = runJxa(JXA_UPDATE_NOTE, { title, body, ...(folder !== undefined ? { folder } : {}) });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "move_note",
  {
    description: "Move a note from one folder to another",
    inputSchema: {
      title: z.string().describe("Note title"),
      from_folder: z.string().describe("Source folder name"),
      to_folder: z.string().describe("Target folder name"),
    },
  },
  async ({ title, from_folder, to_folder }) => {
    try {
      const raw = runJxa(JXA_MOVE_NOTE, { title, from_folder, to_folder });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "append_to_note",
  {
    description: "Append HTML content to an existing note without replacing its body",
    inputSchema: {
      title: z.string().describe("Note title"),
      content: z.string().describe("HTML content to append"),
      folder: z.string().optional().describe("Folder name (optional)"),
    },
  },
  async ({ title, content, folder }) => {
    try {
      const raw = runJxa(JXA_APPEND_TO_NOTE, { title, content, ...(folder !== undefined ? { folder } : {}) });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "delete_note",
  {
    description: "Delete a note from Apple Notes",
    inputSchema: {
      title: z.string().describe("Note title"),
      folder: z.string().optional().describe("Folder name (optional)"),
    },
  },
  async ({ title, folder }) => {
    try {
      const raw = runJxa(JXA_DELETE_NOTE, { title, ...(folder !== undefined ? { folder } : {}) });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "delete_folder",
  {
    description: "Delete a folder and all its notes from Apple Notes",
    inputSchema: {
      name: z.string().describe("Folder name"),
    },
  },
  async ({ name }) => {
    try {
      const raw = runJxa(JXA_DELETE_FOLDER, { name });
      const result = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
);

server.registerTool(
  "search_notes",
  {
    description: "Search notes by keyword across all folders or within a specific folder. Searches both titles and body content.",
    inputSchema: {
      query: z.string().describe("Search query"),
      folder: z.string().optional().describe("Folder name to scope search (optional)"),
      limit: z.number().int().min(1).max(200).default(20).describe("Max results to return"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, folder, limit }) => {
    try {
      const raw = runJxa(JXA_SEARCH_NOTES, { query, limit, ...(folder !== undefined ? { folder } : {}) });
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
