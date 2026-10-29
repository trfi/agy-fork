# SQLite & Protobuf Forking Gotchas

## 1. Post-Truncation `VACUUM` is Required After Deleting Steps or Replacing UUIDs
When deleting steps (`DELETE FROM steps WHERE idx > targetStepIdx`) or replacing UUIDs inside SQLite blob columns, SQLite leaves the old B-tree pages on the internal freelist without zeroing their contents.
- **Symptom**: Raw file scans still find `oldConversationId` or deleted step payloads, and the forked `.db` file retains the full file size of the source conversation.
- **Fix**: Always run `VACUUM` on the target `.db` connection immediately after `COMMIT` to rebuild the database pages and purge all freed B-tree cells.

## 2. Snapshot Active WAL Databases with `VACUUM INTO`
Active Antigravity conversations (`CASCADE_RUN_STATUS_RUNNING`) keep recent steps in `<id>.db-wal`. Copying only `<id>.db` via filesystem copy drops uncommitted WAL frames. Use `VACUUM INTO '<new_path>'` from a read-only SQLite connection to capture a consistent single-file snapshot.

## 3. Refresh Embedded Step Timestamps for Sidebar Sorting
Antigravity's background indexer derives `last_modified_time` and `last_user_input_time` from the protobuf timestamps inside `steps.metadata` (Fields `1, 6, 7, 8, 26, 32`) and `steps.step_payload` (Field `5`) of the last step and last `USER_INPUT` step. Refreshing these timestamps on fork ensures the forked conversation appears at the top of the sidebar.

