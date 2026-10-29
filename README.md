# ⑂ agy-fork — Google Antigravity Conversation Forker

A fast, zero-dependency local Web UI built with **Bun + TypeScript + `bun:sqlite`** to browse, inspect in rich Markdown, **fork (clone or branch from any message)**, and manage your local **Google Antigravity** conversations stored in `~/.gemini/antigravity`.

---

## ✨ Features

- **Message-Level Forking (Branch from Any Turn)**:
  - Automatically groups low-level execution steps (`USER_INPUT`, `PLANNER_RESPONSE`, and intermediate tool executions) into clean **User Messages** and **Agent Responses**.
  - Fork an entire conversation (`1:1` clone) or branch right after any specific **User** or **Agent** message while keeping all intermediate tool call states 100% intact.
- **Rich Markdown & Thinking/Tool Inspector**:
  - View conversation history in formatted GitHub-Flavored Markdown (or toggle to Raw Text).
  - Inspect collapsible **Internal Thinking** blocks and **Tool Calls** for every agent response.
- **Full Brain & Artifact Cloning**:
  - Copies `brain/<id>` artifacts (`task.md`, `implementation_plan.md`, `walkthrough.md`, `scratch/`), rewrites internal `conversation_id` links, and filters `.system_generated` transcript logs up to the exact fork point.
- **Safe SQLite WAL Snapshot & Cleanup**:
  - Uses SQLite `VACUUM INTO` to safely fork even currently running (`CASCADE_RUN_STATUS_RUNNING`) conversations in WAL mode, and runs post-truncation `VACUUM` so forked `.db` files stay compact.
- **Clean Conversation Deletion**:
  - Delete unwanted conversations across all 5 Antigravity storage locations (`conversations/<id>.db`, `conversation_summaries.db` + FTS5 index, `agyhub_summaries_proto.pb`, `annotations/<id>.pbtxt`, and `brain/<id>/`).

---

## 🚀 Quick Start

### Prerequisites
- [Bun](https://bun.sh/) v1.1+ installed (`bun --version`)
- Google Antigravity installed (default data directory: `~/.gemini/antigravity`)

### Run Locally

```bash
git clone https://github.com/trfi/agy-fork.git
cd agy-fork

# Start the local web server (default port: 3456)
bun run start
```

Then open **http://localhost:3456** in your browser.

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3456` | HTTP server port |
| `AGY_DATA_DIR` | `~/.gemini/antigravity` | Path to the Antigravity application data directory |

---

## 🧪 Running Tests

The test suite creates an isolated temporary `AGY_DATA_DIR` sandbox to test protobuf wire encoding/decoding, message grouping, message-boundary forking, and deletion without touching your real conversations:

```bash
bun test
```

---

## 🏗️ Project Structure

```text
agy-fork/
├── public/
│   ├── index.html                  # Web UI layout & modals
│   ├── styles.css                  # Dark-mode styling & Markdown typography
│   └── app.js                      # Frontend state, Markdown renderer & API client
├── src/
│   ├── proto/
│   │   └── codec.ts                # Zero-dependency Protobuf wire-format encoder/decoder
│   ├── routes/
│   │   └── api.ts                  # REST API routes (/api/conversations, /fork, DELETE)
│   ├── services/
│   │   ├── antigravity-paths.ts    # Path resolution for ~/.gemini/antigravity
│   │   ├── conversation-reader.ts  # SQLite & transcript reader + step-to-message grouping
│   │   └── conversation-forker.ts  # Atomic SQLite VACUUM INTO forker & deleter
│   ├── types/
│   │   └── conversation.ts         # Domain TypeScript interfaces
│   └── server.ts                   # Bun HTTP server entrypoint
├── docs/
│   └── architecture.md             # Deep dive into Antigravity's storage & protobuf format
└── tests/
    └── fork.test.ts                # Automated unit & integration tests
```

---

## 📄 License

[MIT](./LICENSE)
