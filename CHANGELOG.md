# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-04-08

### Added
- Initial release of `@hachitogo/macos-mcp-tools`
- **Mail Server**: Apple Mail MCP server with read/search/mutate capabilities
  - `unread_emails`, `mark_emails_read`, `fetch_email_body`, `mark_emails_junk`
  - `mark_emails_not_junk`, `list_email_attachments`, `fetch_email_attachment`, `search_emails`
- **Contacts Server**: Apple Contacts CRUD via JXA
  - `contacts_people`, `contacts_groups`
- **Notes Server**: Apple Notes full CRUD with search
  - `list_folders`, `create_folder`, `list_notes`, `get_note`, `create_note`
  - `update_note`, `move_note`, `append_to_note`, `delete_note`, `delete_folder`, `search_notes`
- **Tasks Server**: SQLite-backed task manager with projects, tags, and flags
  - `list_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`
  - `drop_task`, `reopen_task`, `list_projects`
- **Memory Server**: Structured memory store with SAO triples
  - `create_entry`, `update_entry`, `get_entry`, `search_entries`
  - `query_last_occurrence`, `query_duration_since`
- Configuration via `MACOS_TOOLS_DATA_DIR` environment variable
- Support for Claude Desktop, Cursor, and opencode MCP configurations

### Known Issues
- Read-only smoke tests exist for Mail, Contacts, and Notes, but broader mutation coverage still requires manual verification
