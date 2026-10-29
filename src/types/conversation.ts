export interface ConversationSummaryItem {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  lastUserInputTime: string;
  workspaceUris: string;
  status: string;
  projectId: string;
  parentConversationId: string;
}

export interface ToolCallSummary {
  callId: string;
  toolName: string;
  argsPreview: string;
}

export interface ConversationStepRaw {
  idx: number;
  stepType: number;
  status: number;
  role: "user" | "agent" | "tool" | "system";
  content: string;
  thinking?: string;
  toolCalls?: ToolCallSummary[];
  createdAt?: string;
}

/**
 * Represents a logical conversation message (either a User message or a complete Agent reply turn
 * that aggregates intermediate tool calls and thinking steps up to the next User message).
 */
export interface ConversationMessageItem {
  messageIndex: number;
  role: "user" | "agent";
  startStepIdx: number;
  endStepIdx: number;
  content: string;
  thinkingBlocks: string[];
  toolCalls: ToolCallSummary[];
  intermediateStepCount: number;
  createdAt?: string;
}

export interface BrainArtifactItem {
  relativePath: string;
  sizeBytes: number;
}

export interface ConversationDetail {
  summary: ConversationSummaryItem;
  trajectoryId: string;
  messages: ConversationMessageItem[];
  totalSteps: number;
  artifacts: BrainArtifactItem[];
}

export interface ForkOptions {
  /**
   * Inclusive step index to keep up to (usually the `endStepIdx` of the chosen Message).
   * If omitted, forks the entire conversation.
   */
  targetStepIdx?: number;
  /**
   * Custom title for the forked conversation.
   */
  newTitle?: string;
  /**
   * Whether to copy the `brain/<id>` directory (artifacts & filtered transcript logs). Defaults to true.
   */
  copyBrain?: boolean;
}

export interface ForkResult {
  newConversationId: string;
  newTrajectoryId: string;
  sourceConversationId: string;
  title: string;
  keptStepCount: number;
  copiedArtifactCount: number;
}
