import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { decodeStepPayload } from "../proto/codec.ts";
import type {
  BrainArtifactItem,
  ConversationDetail,
  ConversationMessageItem,
  ConversationStepRaw,
  ConversationSummaryItem,
  ToolCallSummary,
} from "../types/conversation.ts";
import { resolveAntigravityPaths } from "./antigravity-paths.ts";

/**
 * Strips `<USER_REQUEST>` wrapper and trailing `<ADDITIONAL_METADATA>` blocks
 * from user prompt strings so the UI displays clean user messages.
 */
export function cleanUserMessageContent(raw: string): string {
  if (!raw) return "";
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (match) {
    const requestBody = (match[1] ?? "").trim();
    const prefix = raw.slice(0, match.index ?? 0).trim();
    if (prefix && requestBody) {
      return `${prefix}\n\n${requestBody}`;
    }
    if (requestBody) {
      return requestBody;
    }
    if (prefix) {
      return prefix;
    }
    if (raw.includes("uploaded") && raw.includes("image")) {
      return "[User attached image(s)]";
    }
  }
  const metaIdx = raw.indexOf("<ADDITIONAL_METADATA>");
  if (metaIdx !== -1) {
    return raw.slice(0, metaIdx).trim();
  }
  return raw.trim();
}

/**
 * Groups low-level execution steps (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC` tool outputs)
 * into logical chat messages (`user` message or complete `agent` turn).
 */
export function groupStepsIntoMessages(
  steps: ConversationStepRaw[]
): ConversationMessageItem[] {
  const messages: ConversationMessageItem[] = [];
  let currentAgentMsg: ConversationMessageItem | null = null;

  const flushAgentMsg = () => {
    if (currentAgentMsg) {
      messages.push(currentAgentMsg);
      currentAgentMsg = null;
    }
  };

  for (const step of steps) {
    if (step.role === "user") {
      flushAgentMsg();
      messages.push({
        messageIndex: messages.length,
        role: "user",
        startStepIdx: step.idx,
        endStepIdx: step.idx,
        content: cleanUserMessageContent(step.content),
        thinkingBlocks: [],
        toolCalls: [],
        intermediateStepCount: 1,
        createdAt: step.createdAt,
      });
    } else {
      if (!currentAgentMsg) {
        currentAgentMsg = {
          messageIndex: messages.length,
          role: "agent",
          startStepIdx: step.idx,
          endStepIdx: step.idx,
          content: "",
          thinkingBlocks: [],
          toolCalls: [],
          intermediateStepCount: 0,
          createdAt: step.createdAt,
        };
      }
      currentAgentMsg.endStepIdx = step.idx;
      currentAgentMsg.intermediateStepCount += 1;

      if (step.role === "agent" && step.content.trim()) {
        if (currentAgentMsg.content) {
          currentAgentMsg.content += "\n\n" + step.content.trim();
        } else {
          currentAgentMsg.content = step.content.trim();
        }
      }

      if (step.thinking && step.thinking.trim()) {
        currentAgentMsg.thinkingBlocks.push(step.thinking.trim());
      }

      if (step.toolCalls && step.toolCalls.length > 0) {
        currentAgentMsg.toolCalls.push(...step.toolCalls);
      }
    }
  }

  flushAgentMsg();
  return messages;
}

export function listConversations(
  options: { search?: string; project?: string; rootDir?: string } = {}
): ConversationSummaryItem[] {
  const paths = resolveAntigravityPaths(options.rootDir);
  if (!existsSync(paths.summariesDbPath)) {
    return [];
  }

  const db = new Database(paths.summariesDbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT
          conversation_id,
          title,
          preview,
          step_count,
          last_modified_time,
          last_user_input_time,
          workspace_uris,
          status,
          project_id,
          parent_conversation_id
        FROM conversation_summaries
        WHERE parent_conversation_id = ''
        ORDER BY last_modified_time DESC`
      )
      .all() as Array<Record<string, unknown>>;

    const searchLower = options.search?.trim().toLowerCase() ?? "";
    const projectFilter = options.project?.trim() ?? "";

    const results: ConversationSummaryItem[] = [];
    for (const r of rows) {
      const cid = String(r.conversation_id ?? "");
      // Only include conversations that have a SQLite .db file
      if (!existsSync(paths.conversationDbPath(cid))) {
        continue;
      }

      const item: ConversationSummaryItem = {
        conversationId: cid,
        title: String(r.title || "(Untitled)"),
        preview: String(r.preview || ""),
        stepCount: Number(r.step_count ?? 0),
        lastModifiedTime: String(r.last_modified_time ?? ""),
        lastUserInputTime: String(r.last_user_input_time ?? ""),
        workspaceUris: String(r.workspace_uris ?? ""),
        status: String(r.status ?? ""),
        projectId: String(r.project_id ?? ""),
        parentConversationId: String(r.parent_conversation_id ?? ""),
      };

      if (projectFilter && item.projectId !== projectFilter) {
        continue;
      }

      if (searchLower) {
        const hay =
          `${item.title} ${item.preview} ${item.conversationId} ${item.projectId} ${item.workspaceUris}`.toLowerCase();
        if (!hay.includes(searchLower)) {
          continue;
        }
      }

      results.push(item);
    }

    return results;
  } finally {
    db.close();
  }
}

function readTranscriptMap(
  brainConvDir: string
): Map<
  number,
  {
    content?: string;
    thinking?: string;
    toolCalls?: ToolCallSummary[];
    createdAt?: string;
  }
> {
  const map = new Map<
    number,
    {
      content?: string;
      thinking?: string;
      toolCalls?: ToolCallSummary[];
      createdAt?: string;
    }
  >();

  const transcriptPath = join(
    brainConvDir,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );
  if (!existsSync(transcriptPath)) {
    return map;
  }

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const idx = typeof obj.step_index === "number" ? obj.step_index : -1;
      if (idx < 0) continue;

      let toolCalls: ToolCallSummary[] | undefined;
      if (Array.isArray(obj.tool_calls)) {
        toolCalls = obj.tool_calls.map((tc: Record<string, unknown>) => ({
          callId: String(tc.id ?? ""),
          toolName: String(tc.name ?? "tool"),
          argsPreview: JSON.stringify(tc.args ?? {}).slice(0, 160),
        }));
      }

      map.set(idx, {
        content: typeof obj.content === "string" ? obj.content : undefined,
        thinking: typeof obj.thinking === "string" ? obj.thinking : undefined,
        toolCalls,
        createdAt:
          typeof obj.created_at === "string" ? obj.created_at : undefined,
      });
    }
  } catch {
    // Fallback to protobuf payload decoding
  }

  return map;
}

function listBrainArtifacts(brainConvDir: string): BrainArtifactItem[] {
  if (!existsSync(brainConvDir)) return [];
  const artifacts: BrainArtifactItem[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".system_generated") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(brainConvDir, fullPath).replace(/\\/g, "/");
        if (rel.endsWith(".metadata.json") || rel.endsWith(".resolved")) {
          continue;
        }
        artifacts.push({
          relativePath: rel,
          sizeBytes: statSync(fullPath).size,
        });
      }
    }
  };

  walk(brainConvDir);
  return artifacts;
}

export function getConversationDetail(
  conversationId: string,
  rootDir?: string
): ConversationDetail | null {
  const paths = resolveAntigravityPaths(rootDir);
  const convDbPath = paths.conversationDbPath(conversationId);
  if (!existsSync(convDbPath)) {
    return null;
  }

  let summary: ConversationSummaryItem = {
    conversationId,
    title: conversationId,
    preview: "",
    stepCount: 0,
    lastModifiedTime: "",
    lastUserInputTime: "",
    workspaceUris: "",
    status: "CASCADE_RUN_STATUS_IDLE",
    projectId: "",
    parentConversationId: "",
  };

  if (existsSync(paths.summariesDbPath)) {
    const sumDb = new Database(paths.summariesDbPath, { readonly: true });
    try {
      const row = sumDb
        .query(
          `SELECT
            conversation_id, title, preview, step_count,
            last_modified_time, last_user_input_time,
            workspace_uris, status, project_id, parent_conversation_id
          FROM conversation_summaries
          WHERE conversation_id = ?`
        )
        .get(conversationId) as Record<string, unknown> | null;

      if (row) {
        summary = {
          conversationId,
          title: String(row.title || "(Untitled)"),
          preview: String(row.preview || ""),
          stepCount: Number(row.step_count ?? 0),
          lastModifiedTime: String(row.last_modified_time ?? ""),
          lastUserInputTime: String(row.last_user_input_time ?? ""),
          workspaceUris: String(row.workspace_uris ?? ""),
          status: String(row.status ?? ""),
          projectId: String(row.project_id ?? ""),
          parentConversationId: String(row.parent_conversation_id ?? ""),
        };
      }
    } finally {
      sumDb.close();
    }
  }

  const transcriptMap = readTranscriptMap(
    paths.conversationBrainDir(conversationId)
  );
  const convDb = new Database(convDbPath, { readonly: true });
  try {
    const tmeta = convDb
      .query(`SELECT trajectory_id FROM trajectory_meta LIMIT 1`)
      .get() as { trajectory_id?: string } | null;
    const trajectoryId = String(tmeta?.trajectory_id ?? "");

    const stepRows = convDb
      .query(
        `SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx ASC`
      )
      .all() as Array<{
      idx: number;
      step_type: number;
      status: number;
      step_payload: Uint8Array | null;
    }>;

    const rawSteps: ConversationStepRaw[] = stepRows.map((row) => {
      const decoded = row.step_payload
        ? decodeStepPayload(row.step_type, new Uint8Array(row.step_payload))
        : { role: "system" as const, content: "" };

      const fromTranscript = transcriptMap.get(row.idx);
      const role =
        row.step_type === 14
          ? "user"
          : row.step_type === 15
            ? "agent"
            : decoded.role;

      return {
        idx: row.idx,
        stepType: row.step_type,
        status: row.status,
        role,
        content: decoded.content || fromTranscript?.content || "",
        thinking: decoded.thinking || fromTranscript?.thinking,
        toolCalls: decoded.toolCalls ?? fromTranscript?.toolCalls,
        createdAt: fromTranscript?.createdAt,
      };
    });

    const messages = groupStepsIntoMessages(rawSteps);
    const artifacts = listBrainArtifacts(
      paths.conversationBrainDir(conversationId)
    );

    return {
      summary: {
        ...summary,
        stepCount: rawSteps.length,
      },
      trajectoryId,
      messages,
      totalSteps: rawSteps.length,
      artifacts,
    };
  } finally {
    convDb.close();
  }
}
