# Architecture & Internals (`agy-fork`)

## 1. Why Message-Boundary Forking Instead of Raw Step Truncation?

In Google Antigravity's SQLite trajectory storage (`conversations/<id>.db`), a single conversational turn between the user and the agent is decomposed into multiple low-level rows in the `steps` table:
- `step_type = 14` (`USER_INPUT`): The user prompt.
- `step_type = 15` (`PLANNER_RESPONSE`): Model thinking, tool call invocations (`tool_calls`), or visible markdown responses.
- `step_type = 132` / `101` (`GENERIC`): Tool execution outputs returned to the model.

Truncating a conversation at an arbitrary intermediate `step` (for example, immediately after a `PLANNER_RESPONSE` emits a tool call at `step 1` before its corresponding tool output arrives at `step 2`) leaves the trajectory in an inconsistent state with a dangling tool invocation.

To guarantee consistency, `agy-fork` aggregates consecutive non-user steps following each `USER_INPUT` into a single logical **`ConversationMessageItem`**. When a user clicks **"Fork from Message #N"**, the fork engine always snapshots up to `endStepIdx` (the final step of that complete message/turn), ensuring:
1. Every intermediate tool call within an agent turn is paired with its completed output.
2. The forked conversation always starts in `CASCADE_RUN_STATUS_IDLE` state, ready for the next prompt.

---

## 2. Maintaining Integrity Across All 5 Storage Locations

An Antigravity conversation spans 5 distinct files/directories inside `~/.gemini/antigravity`:

| Component | Technical Decision & Rationale |
| :--- | :--- |
| **`conversations/<id>.db`** | Active conversations (`CASCADE_RUN_STATUS_RUNNING`) operate in SQLite WAL mode (`<id>.db-wal`). Copying raw files directly drops uncommitted WAL frames. `agy-fork` executes `VACUUM INTO '<new_id>.db'` to capture an atomic snapshot, deletes rows `> targetStepIdx`, rewrites UUIDs, and runs `VACUUM` after commit to purge freed B-tree pages. |
| **UUID Replacement in Protobuf Blobs** | Standard UUIDv4 strings are fixed at `36` ASCII bytes (`0x24`). Replacing `oldConversationId -> newConversationId` and `oldTrajectoryId -> newTrajectoryId` across `steps`, `gen_metadata`, `executor_metadata`, and `trajectory_metadata_blob` preserves all nested Protobuf wire length prefixes without requiring original `.proto` schemas. |
| **`gen_metadata` & `executor_metadata`** | `gen_metadata` stores generated step indices per model call as *packed varints* in Field `2`, while `executor_metadata` stores step indices in Field `3`. When branching mid-conversation, [codec.ts](file:///C:/Users/Truong/.gemini/antigravity/scratch/agy-fork/src/proto/codec.ts) decodes and filters out any step indices `> targetStepIdx`. |
| **`conversation_summaries.db` & `agyhub_summaries_proto.pb`** | Because `raw_summary` embeds variable-length `title` (Fields `1`, `15`) and `step_count` (Field `2`), `buildUpdatedRawSummary()` decodes top-level wire fields, updates modified fields, and re-serializes the binary protobuf, while also inserting matching rows into the FTS5 index `conversations_fts`. |
| **`annotations/<id>.pbtxt` & `brain/<id>/`** | Writes a new `.pbtxt` title annotation and copies `brain/<id>/`, filtering `transcript.jsonl`, `transcript_full.jsonl`, and `.system_generated/steps/<idx>` to `step_index <= targetStepIdx` while rewriting embedded `conversation_id` links. |

---

## 3. Atomic Deletion (`deleteConversation`)

When deleting a conversation via `DELETE /api/conversations/:id`, `agy-fork` cleans up all 5 locations:
1. Deletes rows from `conversation_summaries` and `conversations_fts` in `conversation_summaries.db`.
2. Removes the corresponding map entry from `agyhub_summaries_proto.pb` via `removeAgyhubMapEntry()`.
3. Removes `conversations/<id>.db` (including `-wal` / `-shm`), `annotations/<id>.pbtxt`, and `brain/<id>/`.
