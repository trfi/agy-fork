import { Database } from "bun:sqlite";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildUpdatedRawSummary,
  encodeAgyhubMapEntry,
  extractStepIndexFromMetaBlob,
  filterGenMetadataByStep,
  removeAgyhubMapEntry,
  replaceBytesAll,
  updateStepTimestamps,
} from "../proto/codec.ts";
import type { ForkOptions, ForkResult } from "../types/conversation.ts";
import { resolveAntigravityPaths } from "./antigravity-paths.ts";

const textEncoder = new TextEncoder();

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".pbtxt",
  ".html",
  ".js",
  ".ts",
  ".py",
]);

function isTextFile(filename: string): boolean {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_EXTENSIONS.has(filename.slice(dotIdx).toLowerCase());
}

function filterJsonlByStep(
  content: string,
  targetStepIdx: number | undefined,
  oldCid: string,
  newCid: string
): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (targetStepIdx !== undefined) {
      try {
        const parsed = JSON.parse(trimmed) as { step_index?: number };
        if (
          typeof parsed.step_index === "number" &&
          parsed.step_index > targetStepIdx
        ) {
          continue;
        }
      } catch {
        // Keep unparseable lines
      }
    }
    kept.push(line.replaceAll(oldCid, newCid));
  }
  return kept.length > 0 ? kept.join("\n") + "\n" : "";
}

function copyBrainDirectory(
  sourceBrainDir: string,
  targetBrainDir: string,
  oldCid: string,
  newCid: string,
  targetStepIdx: number | undefined
): number {
  if (!existsSync(sourceBrainDir)) return 0;
  mkdirSync(targetBrainDir, { recursive: true });
  let copiedArtifactCount = 0;

  const walkCopy = (srcDir: string, dstDir: string, isSysGen = false) => {
    mkdirSync(dstDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      const dstPath = join(dstDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === ".system_generated") {
          walkCopy(srcPath, dstPath, true);
          continue;
        }
        if (isSysGen && entry.name === "tasks") {
          // Do not copy running/old task logs
          continue;
        }
        if (isSysGen && srcDir.endsWith("steps")) {
          const stepNum = Number(entry.name);
          if (
            !Number.isNaN(stepNum) &&
            targetStepIdx !== undefined &&
            stepNum > targetStepIdx
          ) {
            continue;
          }
        }
        walkCopy(srcPath, dstPath, isSysGen);
      } else if (entry.isFile()) {
        if (!isSysGen && !entry.name.endsWith(".metadata.json") && !entry.name.endsWith(".resolved")) {
          copiedArtifactCount++;
        }

        if (isSysGen && entry.name.endsWith(".jsonl")) {
          const raw = readFileSync(srcPath, "utf-8");
          const filtered = filterJsonlByStep(
            raw,
            targetStepIdx,
            oldCid,
            newCid
          );
          if (filtered || entry.name === "transcript.jsonl" || entry.name === "transcript_full.jsonl") {
            writeFileSync(dstPath, filtered, "utf-8");
          }
        } else if (isTextFile(entry.name)) {
          try {
            const raw = readFileSync(srcPath, "utf-8");
            writeFileSync(dstPath, raw.replaceAll(oldCid, newCid), "utf-8");
          } catch {
            copyFileSync(srcPath, dstPath);
          }
        } else {
          copyFileSync(srcPath, dstPath);
        }
      }
    }
  };

  walkCopy(sourceBrainDir, targetBrainDir, false);
  return copiedArtifactCount;
}

export function forkConversation(
  sourceConversationId: string,
  options: ForkOptions = {},
  customRootDir?: string
): ForkResult {
  const paths = resolveAntigravityPaths(customRootDir);
  const sourceDbPath = paths.conversationDbPath(sourceConversationId);
  if (!existsSync(sourceDbPath)) {
    throw new Error(
      `Source conversation database not found: ${sourceConversationId}`
    );
  }
  if (!existsSync(paths.summariesDbPath)) {
    throw new Error(
      `conversation_summaries.db not found at: ${paths.summariesDbPath}`
    );
  }

  const newConversationId = crypto.randomUUID();
  const newTrajectoryId = crypto.randomUUID();
  const targetDbPath = paths.conversationDbPath(newConversationId);

  mkdirSync(paths.conversationsDir, { recursive: true });
  mkdirSync(paths.annotationsDir, { recursive: true });
  mkdirSync(paths.brainDir, { recursive: true });

  // 1. Snapshot the source conversation SQLite DB safely using VACUUM INTO
  // (This cleanly captures uncommitted WAL frames even if the conversation is currently open).
  if (existsSync(targetDbPath)) {
    rmSync(targetDbPath, { force: true });
  }
  const srcDb = new Database(sourceDbPath, { readonly: true });
  try {
    const escapedPath = targetDbPath.replace(/'/g, "''");
    srcDb.exec(`VACUUM INTO '${escapedPath}'`);
  } finally {
    srcDb.close();
  }

  // 2. Transform the newly created conversation DB
  const newDb = new Database(targetDbPath);
  let oldTrajectoryId = "";
  let keptStepCount = 0;
  let lastUserInputStepIdx = -1;
  let effectiveTargetStepIdx: number | undefined = options.targetStepIdx;

  try {
    newDb.exec("BEGIN TRANSACTION");

    const tmeta = newDb
      .query(`SELECT trajectory_id FROM trajectory_meta LIMIT 1`)
      .get() as { trajectory_id?: string } | null;
    oldTrajectoryId = String(tmeta?.trajectory_id ?? "");

    const maxRow = newDb
      .query(`SELECT MAX(idx) as max_idx FROM steps`)
      .get() as { max_idx: number | null };
    const maxStepIdx = maxRow?.max_idx ?? -1;

    if (
      effectiveTargetStepIdx !== undefined &&
      effectiveTargetStepIdx >= 0 &&
      effectiveTargetStepIdx < maxStepIdx
    ) {
      newDb
        .query(`DELETE FROM steps WHERE idx > ?`)
        .run(effectiveTargetStepIdx);
      newDb
        .query(`DELETE FROM battle_mode_infos WHERE idx > ?`)
        .run(effectiveTargetStepIdx);

      // Filter gen_metadata rows by step index
      const genRows = newDb
        .query(`SELECT idx, data FROM gen_metadata ORDER BY idx ASC`)
        .all() as Array<{ idx: number; data: Uint8Array }>;
      newDb.exec(`DELETE FROM gen_metadata`);
      let newGenIdx = 0;
      const insertGen = newDb.query(
        `INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)`
      );
      for (const r of genRows) {
        const filtered = filterGenMetadataByStep(
          new Uint8Array(r.data),
          effectiveTargetStepIdx
        );
        if (filtered) {
          insertGen.run(newGenIdx++, filtered, filtered.byteLength);
        }
      }

      // Filter executor_metadata rows (field 3 = step index)
      const execRows = newDb
        .query(`SELECT idx, data FROM executor_metadata ORDER BY idx ASC`)
        .all() as Array<{ idx: number; data: Uint8Array }>;
      newDb.exec(`DELETE FROM executor_metadata`);
      let newExecIdx = 0;
      const insertExec = newDb.query(
        `INSERT INTO executor_metadata (idx, data) VALUES (?, ?)`
      );
      for (const r of execRows) {
        const raw = new Uint8Array(r.data);
        const stepIdx = extractStepIndexFromMetaBlob(raw, 3);
        if (stepIdx === null || stepIdx <= effectiveTargetStepIdx) {
          insertExec.run(newExecIdx++, raw);
        }
      }

      // Filter parent_references rows (field 2 = step index)
      const parentRows = newDb
        .query(`SELECT idx, data FROM parent_references ORDER BY idx ASC`)
        .all() as Array<{ idx: number; data: Uint8Array }>;
      newDb.exec(`DELETE FROM parent_references`);
      let newParentIdx = 0;
      const insertParent = newDb.query(
        `INSERT INTO parent_references (idx, data) VALUES (?, ?)`
      );
      for (const r of parentRows) {
        const raw = new Uint8Array(r.data);
        const stepIdx = extractStepIndexFromMetaBlob(raw, 2);
        if (stepIdx === null || stepIdx <= effectiveTargetStepIdx) {
          insertParent.run(newParentIdx++, raw);
        }
      }
    }

    // Ensure no step remains in RUNNING (2) status in the forked conversation
    newDb.exec(`UPDATE steps SET status = 3 WHERE status = 2`);

    // Replace oldConversationId -> newConversationId and oldTrajectoryId -> newTrajectoryId
    const oldCidBytes = textEncoder.encode(sourceConversationId);
    const newCidBytes = textEncoder.encode(newConversationId);
    const oldTidBytes = oldTrajectoryId
      ? textEncoder.encode(oldTrajectoryId)
      : new Uint8Array(0);
    const newTidBytes = textEncoder.encode(newTrajectoryId);

    const replaceIds = (blob: Uint8Array | null): Uint8Array | null => {
      if (!blob) return null;
      let out = replaceBytesAll(new Uint8Array(blob), oldCidBytes, newCidBytes);
      if (oldTidBytes.length > 0) {
        out = replaceBytesAll(out, oldTidBytes, newTidBytes);
      }
      return out;
    };

    newDb
      .query(`UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?`)
      .run(newTrajectoryId, newConversationId);

    const tblobRows = newDb
      .query(`SELECT id, data FROM trajectory_metadata_blob`)
      .all() as Array<{ id: string; data: Uint8Array | null }>;
    const updateTblob = newDb.query(
      `UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?`
    );
    for (const r of tblobRows) {
      updateTblob.run(replaceIds(r.data), r.id);
    }

    const stepRows = newDb
      .query(
        `SELECT idx, metadata, error_details, permissions, task_details, render_info, step_payload FROM steps`
      )
      .all() as Array<{
      idx: number;
      metadata: Uint8Array | null;
      error_details: Uint8Array | null;
      permissions: Uint8Array | null;
      task_details: Uint8Array | null;
      render_info: Uint8Array | null;
      step_payload: Uint8Array | null;
    }>;
    const updateStep = newDb.query(
      `UPDATE steps
       SET metadata = ?, error_details = ?, permissions = ?, task_details = ?, render_info = ?, step_payload = ?
       WHERE idx = ?`
    );
    for (const r of stepRows) {
      updateStep.run(
        replaceIds(r.metadata),
        replaceIds(r.error_details),
        replaceIds(r.permissions),
        replaceIds(r.task_details),
        replaceIds(r.render_info),
        replaceIds(r.step_payload),
        r.idx
      );
    }

    for (const table of [
      "gen_metadata",
      "executor_metadata",
      "parent_references",
      "battle_mode_infos",
    ]) {
      const rows = newDb
        .query(`SELECT idx, data FROM ${table}`)
        .all() as Array<{ idx: number; data: Uint8Array | null }>;
      const upd =
        table === "gen_metadata"
          ? newDb.query(
              `UPDATE gen_metadata SET data = ?, size = ? WHERE idx = ?`
            )
          : newDb.query(`UPDATE ${table} SET data = ? WHERE idx = ?`);
      for (const r of rows) {
        const replaced = replaceIds(r.data);
        if (table === "gen_metadata") {
          upd.run(replaced, replaced ? replaced.byteLength : 0, r.idx);
        } else {
          upd.run(replaced, r.idx);
        }
      }
    }

    const cntRow = newDb
      .query(`SELECT COUNT(*) as cnt FROM steps`)
      .get() as { cnt: number };
    keptStepCount = cntRow.cnt;

    const lastUserRow = newDb
      .query(
        `SELECT COALESCE(MAX(idx), -1) as last_idx FROM steps WHERE step_type = 14`
      )
      .get() as { last_idx: number };
    lastUserInputStepIdx = lastUserRow.last_idx;

    const maxKeptRow = newDb
      .query(`SELECT COALESCE(MAX(idx), -1) as max_idx FROM steps`)
      .get() as { max_idx: number };
    const maxKeptStepIdx = maxKeptRow.max_idx;

    const nowForSteps = new Date();
    const updateStepMetaAndPayload = newDb.query(
      `UPDATE steps SET metadata = ?, step_payload = ? WHERE idx = ?`
    );

    // Update timestamps on last user input step and last overall step so Antigravity
    // places the forked conversation at the very top of the conversation list.
    const stepIndicesToTouch = Array.from(
      new Set([lastUserInputStepIdx, maxKeptStepIdx].filter((i) => i >= 0))
    );
    for (const idxToTouch of stepIndicesToTouch) {
      const sRow = newDb
        .query(`SELECT metadata, step_payload FROM steps WHERE idx = ?`)
        .get(idxToTouch) as {
        metadata: Uint8Array | null;
        step_payload: Uint8Array | null;
      } | null;
      if (sRow) {
        const touched = updateStepTimestamps(
          sRow.metadata ? new Uint8Array(sRow.metadata) : null,
          sRow.step_payload ? new Uint8Array(sRow.step_payload) : null,
          nowForSteps
        );
        updateStepMetaAndPayload.run(
          touched.metadata,
          touched.stepPayload,
          idxToTouch
        );
      }
    }

    newDb.exec("COMMIT");
    newDb.exec("VACUUM");
  } catch (err) {
    try {
      newDb.exec("ROLLBACK");
    } catch {
      // Ignore rollback error if transaction already closed
    }
    throw err;
  } finally {
    newDb.close();
  }

  // 3. Update conversation_summaries.db, annotations/<id>.pbtxt, and agyhub_summaries_proto.pb
  const now = new Date();
  const nowIso = now.toISOString().replace("Z", "+00:00");
  const nowSec = Math.floor(now.getTime() / 1000);
  const nowNanos = (now.getTime() % 1000) * 1_000_000;

  const sumDb = new Database(paths.summariesDbPath);
  let finalTitle = options.newTitle?.trim() || "";
  let newRawSummary: Uint8Array;

  try {
    const srcSum = sumDb
      .query(`SELECT * FROM conversation_summaries WHERE conversation_id = ?`)
      .get(sourceConversationId) as Record<string, unknown> | null;

    const baseTitle = String(srcSum?.title || "Conversation");
    if (!finalTitle) {
      finalTitle =
        effectiveTargetStepIdx !== undefined
          ? `[Fork #${effectiveTargetStepIdx}] ${baseTitle}`
          : `[Fork] ${baseTitle}`;
    }

    const srcRaw =
      srcSum?.raw_summary instanceof Uint8Array
        ? new Uint8Array(srcSum.raw_summary)
        : new Uint8Array(0);

    newRawSummary = buildUpdatedRawSummary(srcRaw, {
      oldConversationId: sourceConversationId,
      newConversationId,
      oldTrajectoryId: oldTrajectoryId || sourceConversationId,
      newTrajectoryId,
      newTitle: finalTitle,
      newStepCount: keptStepCount,
      lastUserInputStepIndex: lastUserInputStepIdx,
      now,
    });

    sumDb
      .query(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, project_id, agent_name,
          parent_conversation_id, nesting_depth, battle_id, winning_conversation_id,
          not_fully_idle, killed, last_user_input_time, last_user_input_step_index,
          app_data_dir, raw_summary, group_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newConversationId,
        finalTitle,
        finalTitle,
        keptStepCount,
        nowIso,
        String(srcSum?.workspace_uris ?? ""),
        "CASCADE_RUN_STATUS_IDLE",
        String(srcSum?.source ?? ""),
        String(srcSum?.project_id ?? "outside-of-project"),
        String(srcSum?.agent_name ?? ""),
        "",
        0,
        "",
        "",
        0,
        0,
        nowIso,
        lastUserInputStepIdx,
        String(srcSum?.app_data_dir ?? "antigravity"),
        newRawSummary,
        String(srcSum?.group_id ?? "")
      );

    // Copy FTS5 entries so search works on the forked conversation
    try {
      const ftsRows = sumDb
        .query(`SELECT * FROM conversations_fts WHERE conversation_id = ?`)
        .all(sourceConversationId) as Array<Record<string, unknown>>;

      const insertFts = sumDb.query(
        `INSERT INTO conversations_fts (
          conversation_id, chunk_index, chunk_first_step, chunk_last_step,
          last_modified_time, step_count, last_step_created_at, archived,
          user_step_byte_offsets, agent_step_byte_offsets,
          title, workspace, project, user_body, agent_body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const fr of ftsRows) {
        const chunkIdx = Number(fr.chunk_index ?? -1);
        const firstStep = Number(fr.chunk_first_step ?? 0);
        if (
          chunkIdx >= 0 &&
          effectiveTargetStepIdx !== undefined &&
          firstStep > effectiveTargetStepIdx
        ) {
          continue;
        }
        insertFts.run(
          newConversationId,
          chunkIdx,
          firstStep,
          effectiveTargetStepIdx !== undefined && chunkIdx >= 0
            ? Math.min(Number(fr.chunk_last_step ?? 0), effectiveTargetStepIdx)
            : Number(fr.chunk_last_step ?? 0),
          Number(fr.last_modified_time ?? 0),
          chunkIdx === -1 ? keptStepCount : Number(fr.step_count ?? 0),
          Number(fr.last_step_created_at ?? 0),
          0,
          (fr.user_step_byte_offsets as Uint8Array | string | null) ?? "",
          (fr.agent_step_byte_offsets as Uint8Array | string | null) ?? "",
          chunkIdx === -1 ? finalTitle : String(fr.title ?? ""),
          String(fr.workspace ?? ""),
          String(fr.project ?? ""),
          String(fr.user_body ?? ""),
          String(fr.agent_body ?? "")
        );
      }
    } catch {
      // Ignore if FTS table is unavailable in custom environments
    }
  } finally {
    sumDb.close();
  }

  // 4. Write annotations/<newConversationId>.pbtxt
  const escapedPbtxtTitle = finalTitle
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const pbtxtContent = `title:"${escapedPbtxtTitle}"  last_user_view_time:{seconds:${nowSec}  nanos:${nowNanos}}\n`;
  writeFileSync(paths.annotationPath(newConversationId), pbtxtContent, "utf-8");

  // 5. Append to agyhub_summaries_proto.pb if present
  if (existsSync(paths.agyhubProtoPath)) {
    const mapEntry = encodeAgyhubMapEntry(newConversationId, newRawSummary);
    appendFileSync(paths.agyhubProtoPath, mapEntry);
  }

  // 6. Copy & filter brain/<id> directory
  let copiedArtifactCount = 0;
  if (options.copyBrain !== false) {
    copiedArtifactCount = copyBrainDirectory(
      paths.conversationBrainDir(sourceConversationId),
      paths.conversationBrainDir(newConversationId),
      sourceConversationId,
      newConversationId,
      effectiveTargetStepIdx
    );
  }

  return {
    newConversationId,
    newTrajectoryId,
    sourceConversationId,
    title: finalTitle,
    keptStepCount,
    copiedArtifactCount,
  };
}

export function deleteConversation(
  conversationId: string,
  customRootDir?: string
): { deletedConversationId: string } {
  if (!conversationId || /[\\/]/.test(conversationId)) {
    throw new Error("Invalid conversation ID");
  }

  const paths = resolveAntigravityPaths(customRootDir);
  const convDbPath = paths.conversationDbPath(conversationId);

  // 1. Delete from conversation_summaries.db (both conversation_summaries & conversations_fts)
  if (existsSync(paths.summariesDbPath)) {
    const sumDb = new Database(paths.summariesDbPath);
    try {
      sumDb
        .query(`DELETE FROM conversation_summaries WHERE conversation_id = ?`)
        .run(conversationId);
      try {
        sumDb
          .query(`DELETE FROM conversations_fts WHERE conversation_id = ?`)
          .run(conversationId);
      } catch {
        // Ignore if FTS table is absent
      }
    } finally {
      sumDb.close();
    }
  }

  // 2. Remove entry from agyhub_summaries_proto.pb
  if (existsSync(paths.agyhubProtoPath)) {
    try {
      const currentPb = new Uint8Array(readFileSync(paths.agyhubProtoPath));
      const updatedPb = removeAgyhubMapEntry(currentPb, conversationId);
      if (updatedPb.byteLength !== currentPb.byteLength) {
        writeFileSync(paths.agyhubProtoPath, updatedPb);
      }
    } catch {
      // Ignore proto rewrite error
    }
  }

  // 3. Remove conversations/<id>.db (+ -wal / -shm if present)
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${convDbPath}${suffix}`;
    if (existsSync(p)) {
      rmSync(p, { force: true });
    }
  }

  // 4. Remove annotations/<id>.pbtxt
  const annotPath = paths.annotationPath(conversationId);
  if (existsSync(annotPath)) {
    rmSync(annotPath, { force: true });
  }

  // 5. Remove brain/<id> directory
  const brainConvDir = paths.conversationBrainDir(conversationId);
  if (existsSync(brainConvDir)) {
    rmSync(brainConvDir, { recursive: true, force: true });
  }

  return { deletedConversationId: conversationId };
}

