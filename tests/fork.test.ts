import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUpdatedRawSummary,
  decodePackedVarints,
  decodeProtoFields,
  encodePackedVarints,
  encodeProtoFields,
  filterGenMetadataByStep,
} from "../src/proto/codec.ts";
import { handleApiRequest } from "../src/routes/api.ts";
import { forkConversation } from "../src/services/conversation-forker.ts";
import {
  getConversationDetail,
  listConversations,
} from "../src/services/conversation-reader.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeUserStepPayload(text: string): Uint8Array {
  const inner = encodeProtoFields([
    { fieldNumber: 2, wireType: 2, value: enc.encode(text) },
  ]);
  return encodeProtoFields([
    { fieldNumber: 1, wireType: 0, value: 14n },
    { fieldNumber: 4, wireType: 0, value: 3n },
    { fieldNumber: 19, wireType: 2, value: inner },
  ]);
}

function makeAgentStepPayload(
  text: string,
  thinking?: string,
  toolName?: string
): Uint8Array {
  const subFields = [];
  if (text) {
    subFields.push({ fieldNumber: 1, wireType: 2 as const, value: enc.encode(text) });
    subFields.push({ fieldNumber: 8, wireType: 2 as const, value: enc.encode(text) });
  }
  if (thinking) {
    subFields.push({
      fieldNumber: 3,
      wireType: 2 as const,
      value: enc.encode(thinking),
    });
  }
  if (toolName) {
    const tc = encodeProtoFields([
      { fieldNumber: 1, wireType: 2, value: enc.encode("call_1") },
      { fieldNumber: 2, wireType: 2, value: enc.encode(toolName) },
      { fieldNumber: 3, wireType: 2, value: enc.encode('{"cmd":"ls"}') },
    ]);
    subFields.push({ fieldNumber: 7, wireType: 2 as const, value: tc });
  }
  const inner = encodeProtoFields(subFields);
  return encodeProtoFields([
    { fieldNumber: 1, wireType: 0, value: 15n },
    { fieldNumber: 4, wireType: 0, value: 3n },
    { fieldNumber: 20, wireType: 2, value: inner },
  ]);
}

describe("agy-fork core & message-level forking", () => {
  let sandboxDir: string;
  const sourceCid = "11111111-2222-3333-4444-555555555555";
  const sourceTid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "agy-fork-test-"));
    mkdirSync(join(sandboxDir, "conversations"), { recursive: true });
    mkdirSync(join(sandboxDir, "annotations"), { recursive: true });
    mkdirSync(
      join(sandboxDir, "brain", sourceCid, ".system_generated", "logs"),
      { recursive: true }
    );
    mkdirSync(
      join(sandboxDir, "brain", sourceCid, ".system_generated", "steps", "2"),
      { recursive: true }
    );
    mkdirSync(
      join(sandboxDir, "brain", sourceCid, ".system_generated", "steps", "5"),
      { recursive: true }
    );

    // 1. Create conversation_summaries.db
    const sumDb = new Database(join(sandboxDir, "conversation_summaries.db"));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT "",
        preview text NOT NULL DEFAULT "",
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        status text NOT NULL DEFAULT "",
        source text NOT NULL DEFAULT "",
        project_id text NOT NULL DEFAULT "",
        agent_name text NOT NULL DEFAULT "",
        parent_conversation_id text NOT NULL DEFAULT "",
        nesting_depth integer NOT NULL DEFAULT 0,
        battle_id text NOT NULL DEFAULT "",
        winning_conversation_id text NOT NULL DEFAULT "",
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL,
        last_user_input_step_index integer NOT NULL DEFAULT -1,
        app_data_dir text NOT NULL DEFAULT "",
        raw_summary blob,
        group_id text NOT NULL DEFAULT ""
      );
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        conversation_id UNINDEXED,
        chunk_index UNINDEXED,
        chunk_first_step UNINDEXED,
        chunk_last_step UNINDEXED,
        last_modified_time UNINDEXED,
        step_count UNINDEXED,
        last_step_created_at UNINDEXED,
        archived UNINDEXED,
        user_step_byte_offsets UNINDEXED,
        agent_step_byte_offsets UNINDEXED,
        title,
        workspace,
        project,
        user_body,
        agent_body
      );
    `);

    const rawSummary = buildUpdatedRawSummary(new Uint8Array(0), {
      oldConversationId: sourceCid,
      newConversationId: sourceCid,
      oldTrajectoryId: sourceTid,
      newTrajectoryId: sourceTid,
      newTitle: "Original Test Conversation",
      newStepCount: 6,
      lastUserInputStepIndex: 4,
      now: new Date(),
    });

    sumDb
      .query(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, project_id, last_user_input_time,
          last_user_input_step_index, app_data_dir, raw_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sourceCid,
        "Original Test Conversation",
        "Original Test Conversation",
        6,
        "2026-10-29 03:00:00+00:00",
        "",
        "CASCADE_RUN_STATUS_RUNNING",
        "test-project",
        "2026-10-29 03:00:00+00:00",
        4,
        "antigravity",
        rawSummary
      );
    sumDb.close();

    // 2. Create agyhub_summaries_proto.pb
    writeFileSync(join(sandboxDir, "agyhub_summaries_proto.pb"), new Uint8Array(0));

    // 3. Create conversations/<sourceCid>.db with 2 User messages and 2 Agent turns (6 steps total: 0..5)
    // Message #1 (User): step 0
    // Message #2 (Agent): step 1 (tool call), step 2 (tool output), step 3 (final answer)
    // Message #3 (User): step 4
    // Message #4 (Agent): step 5 (final answer)
    const convDb = new Database(
      join(sandboxDir, "conversations", `${sourceCid}.db`)
    );
    convDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
      CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
      CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
      CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
      CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob);
      CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main" PRIMARY KEY, data blob);
      CREATE TABLE battle_mode_infos (idx integer PRIMARY KEY, data blob);
    `);

    convDb
      .query(
        `INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 4, 1)`
      )
      .run(sourceTid, sourceCid);

    const tblob = encodeProtoFields([
      { fieldNumber: 6, wireType: 2, value: enc.encode(sourceCid) },
    ]);
    convDb
      .query(`INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)`)
      .run(tblob);

    const stepMeta = encodeProtoFields([
      {
        fieldNumber: 20,
        wireType: 2,
        value: enc.encode(`\n$${sourceTid}"$${sourceCid}`),
      },
    ]);

    const insertStep = convDb.query(
      `INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)`
    );
    insertStep.run(
      0,
      14,
      3,
      stepMeta,
      makeUserStepPayload("<USER_REQUEST>\nHello turn 1\n</USER_REQUEST>")
    );
    insertStep.run(
      1,
      15,
      3,
      stepMeta,
      makeAgentStepPayload("", "Thinking step 1", "run_command")
    );
    insertStep.run(2, 132, 3, stepMeta, new Uint8Array(0));
    insertStep.run(
      3,
      15,
      3,
      stepMeta,
      makeAgentStepPayload("Complete answer for turn 1")
    );
    insertStep.run(
      4,
      14,
      3,
      stepMeta,
      makeUserStepPayload("<USER_REQUEST>\nQuestion turn 2\n</USER_REQUEST>")
    );
    insertStep.run(
      5,
      15,
      2,
      stepMeta,
      makeAgentStepPayload("Answer for turn 2")
    );

    // gen_metadata: row 0 covers steps [1, 2, 3], row 1 covers step [5]
    const gen0 = encodeProtoFields([
      { fieldNumber: 2, wireType: 2, value: encodePackedVarints([1, 2, 3]) },
      { fieldNumber: 4, wireType: 2, value: enc.encode(sourceCid) },
    ]);
    const gen1 = encodeProtoFields([
      { fieldNumber: 2, wireType: 2, value: encodePackedVarints([5]) },
      { fieldNumber: 4, wireType: 2, value: enc.encode(sourceTid) },
    ]);
    convDb
      .query(`INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?), (1, ?, ?)`)
      .run(gen0, gen0.byteLength, gen1, gen1.byteLength);

    convDb.close();

    // 4. Brain files
    writeFileSync(
      join(sandboxDir, "brain", sourceCid, "plan.md"),
      `Link to [plan](file:///brain/${sourceCid}/plan.md)`,
      "utf-8"
    );
    writeFileSync(
      join(
        sandboxDir,
        "brain",
        sourceCid,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      ),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Hello turn 1" }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", content: "Complete answer for turn 1" }),
        JSON.stringify({ step_index: 4, type: "USER_INPUT", content: "Question turn 2" }),
        JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", content: "Answer for turn 2" }),
      ].join("\n") + "\n",
      "utf-8"
    );
    writeFileSync(
      join(
        sandboxDir,
        "brain",
        sourceCid,
        ".system_generated",
        "steps",
        "2",
        "output.txt"
      ),
      "step 2 output",
      "utf-8"
    );
    writeFileSync(
      join(
        sandboxDir,
        "brain",
        sourceCid,
        ".system_generated",
        "steps",
        "5",
        "output.txt"
      ),
      "step 5 output",
      "utf-8"
    );
  });

  afterEach(() => {
    try {
      rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore Windows temp file lock delay
    }
  });

  test("groups raw steps into clean User and Agent Messages", () => {
    const detail = getConversationDetail(sourceCid, sandboxDir);
    expect(detail).not.toBeNull();
    expect(detail!.totalSteps).toBe(6);
    expect(detail!.messages.length).toBe(4);

    // Message #1: User (step 0)
    expect(detail!.messages[0]!.role).toBe("user");
    expect(detail!.messages[0]!.content).toBe("Hello turn 1");
    expect(detail!.messages[0]!.startStepIdx).toBe(0);
    expect(detail!.messages[0]!.endStepIdx).toBe(0);

    // Message #2: Agent (aggregates steps 1, 2, 3!)
    expect(detail!.messages[1]!.role).toBe("agent");
    expect(detail!.messages[1]!.startStepIdx).toBe(1);
    expect(detail!.messages[1]!.endStepIdx).toBe(3);
    expect(detail!.messages[1]!.intermediateStepCount).toBe(3);
    expect(detail!.messages[1]!.content).toBe("Complete answer for turn 1");
    expect(detail!.messages[1]!.toolCalls.length).toBe(1);
    expect(detail!.messages[1]!.toolCalls[0]!.toolName).toBe("run_command");

    // Message #3: User (step 4)
    expect(detail!.messages[2]!.role).toBe("user");
    expect(detail!.messages[2]!.endStepIdx).toBe(4);

    // Message #4: Agent (step 5)
    expect(detail!.messages[3]!.role).toBe("agent");
    expect(detail!.messages[3]!.endStepIdx).toBe(5);
  });

  test("forks at a specific Message boundary (Message #2, endStepIdx = 3) cleanly", () => {
    const detail = getConversationDetail(sourceCid, sandboxDir)!;
    const msg2 = detail.messages[1]!; // Agent response #1 ending at step 3

    const forkRes = forkConversation(
      sourceCid,
      {
        targetStepIdx: msg2.endStepIdx,
        newTitle: "Branched After Message 2",
        copyBrain: true,
      },
      sandboxDir
    );

    expect(forkRes.keptStepCount).toBe(4); // steps 0, 1, 2, 3
    expect(forkRes.title).toBe("Branched After Message 2");
    expect(forkRes.copiedArtifactCount).toBe(1);

    // Verify forked conversation detail
    const forkedDetail = getConversationDetail(
      forkRes.newConversationId,
      sandboxDir
    );
    expect(forkedDetail).not.toBeNull();
    expect(forkedDetail!.messages.length).toBe(2);
    expect(forkedDetail!.totalSteps).toBe(4);
    expect(forkedDetail!.summary.status).toBe("CASCADE_RUN_STATUS_IDLE");

    // Verify no old UUIDs remain in the forked .db
    const rawDbBytes = readFileSync(
      join(sandboxDir, "conversations", `${forkRes.newConversationId}.db`)
    );
    expect(dec.decode(rawDbBytes).includes(sourceCid)).toBe(false);
    expect(dec.decode(rawDbBytes).includes(sourceTid)).toBe(false);

    // Verify gen_metadata was filtered to only row 0 ([1, 2, 3])
    const fDb = new Database(
      join(sandboxDir, "conversations", `${forkRes.newConversationId}.db`),
      { readonly: true }
    );
    const genCount = fDb
      .query(`SELECT COUNT(*) as c FROM gen_metadata`)
      .get() as { c: number };
    expect(genCount.c).toBe(1);
    fDb.close();

    // Verify brain artifacts and transcript filtering
    const forkedPlan = readFileSync(
      join(sandboxDir, "brain", forkRes.newConversationId, "plan.md"),
      "utf-8"
    );
    expect(forkedPlan.includes(forkRes.newConversationId)).toBe(true);
    expect(forkedPlan.includes(sourceCid)).toBe(false);

    const forkedTranscript = readFileSync(
      join(
        sandboxDir,
        "brain",
        forkRes.newConversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      ),
      "utf-8"
    );
    expect(forkedTranscript.includes('"step_index":5')).toBe(false);
    expect(forkedTranscript.includes('"step_index":3')).toBe(true);

    // Step 2 output dir should exist, step 5 output dir should be excluded
    expect(
      existsSync(
        join(
          sandboxDir,
          "brain",
          forkRes.newConversationId,
          ".system_generated",
          "steps",
          "2",
          "output.txt"
        )
      )
    ).toBe(true);
    expect(
      existsSync(
        join(
          sandboxDir,
          "brain",
          forkRes.newConversationId,
          ".system_generated",
          "steps",
          "5"
        )
      )
    ).toBe(false);
  });

  test("HTTP API endpoints list, inspect, and fork conversations", async () => {
    const listRes = await handleApiRequest(
      new Request("http://localhost/api/conversations"),
      sandboxDir
    );
    expect(listRes?.status).toBe(200);
    const listJson = (await listRes!.json()) as { conversations: unknown[] };
    expect(listJson.conversations.length).toBe(1);

    const forkRes = await handleApiRequest(
      new Request(`http://localhost/api/conversations/${sourceCid}/fork`, {
        method: "POST",
        body: JSON.stringify({ newTitle: "Full Clone via API" }),
      }),
      sandboxDir
    );
    expect(forkRes?.status).toBe(201);
    const forkJson = (await forkRes!.json()) as {
      newConversationId: string;
      keptStepCount: number;
    };
    expect(forkJson.keptStepCount).toBe(6);

    const listAfter = listConversations({ rootDir: sandboxDir });
    expect(listAfter.length).toBe(2);

    // Delete the newly forked conversation via DELETE API
    const delRes = await handleApiRequest(
      new Request(
        `http://localhost/api/conversations/${forkJson.newConversationId}`,
        { method: "DELETE" }
      ),
      sandboxDir
    );
    expect(delRes?.status).toBe(200);

    const listAfterDelete = listConversations({ rootDir: sandboxDir });
    expect(listAfterDelete.length).toBe(1);
    expect(
      existsSync(
        join(sandboxDir, "conversations", `${forkJson.newConversationId}.db`)
      )
    ).toBe(false);
    expect(
      existsSync(join(sandboxDir, "brain", forkJson.newConversationId))
    ).toBe(false);
  });

  test("filterGenMetadataByStep filters packed varints accurately", () => {
    const blob = encodeProtoFields([
      { fieldNumber: 2, wireType: 2, value: encodePackedVarints([2, 3, 4, 5]) },
    ]);
    const filtered = filterGenMetadataByStep(blob, 3);
    expect(filtered).not.toBeNull();
    const decoded = decodeProtoFields(filtered!)!;
    const indices = decodePackedVarints(decoded[0]!.value as Uint8Array);
    expect(indices).toEqual([2, 3]);

    const empty = filterGenMetadataByStep(blob, 1);
    expect(empty).toBeNull();
  });
});
