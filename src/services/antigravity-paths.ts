import { homedir } from "node:os";
import { join } from "node:path";

export interface AntigravityPaths {
  rootDir: string;
  summariesDbPath: string;
  agyhubProtoPath: string;
  conversationsDir: string;
  annotationsDir: string;
  brainDir: string;
  conversationDbPath: (id: string) => string;
  annotationPath: (id: string) => string;
  conversationBrainDir: (id: string) => string;
}

export function resolveAntigravityPaths(customRootDir?: string): AntigravityPaths {
  const rootDir =
    customRootDir ||
    process.env.AGY_DATA_DIR ||
    join(homedir(), ".gemini", "antigravity");

  return {
    rootDir,
    summariesDbPath: join(rootDir, "conversation_summaries.db"),
    agyhubProtoPath: join(rootDir, "agyhub_summaries_proto.pb"),
    conversationsDir: join(rootDir, "conversations"),
    annotationsDir: join(rootDir, "annotations"),
    brainDir: join(rootDir, "brain"),
    conversationDbPath: (id: string) => join(rootDir, "conversations", `${id}.db`),
    annotationPath: (id: string) => join(rootDir, "annotations", `${id}.pbtxt`),
    conversationBrainDir: (id: string) => join(rootDir, "brain", id),
  };
}
