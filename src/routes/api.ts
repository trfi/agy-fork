import { resolveAntigravityPaths } from "../services/antigravity-paths.ts";
import {
  deleteConversation,
  forkConversation,
} from "../services/conversation-forker.ts";
import {
  getConversationDetail,
  listConversations,
} from "../services/conversation-reader.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function handleApiRequest(
  req: Request,
  customRootDir?: string
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;

  if (!pathname.startsWith("/api/")) {
    return null;
  }

  try {
    // GET /api/info
    if (req.method === "GET" && pathname === "/api/info") {
      const paths = resolveAntigravityPaths(customRootDir);
      return jsonResponse({
        rootDir: paths.rootDir,
        summariesDbPath: paths.summariesDbPath,
      });
    }

    // GET /api/conversations
    if (req.method === "GET" && pathname === "/api/conversations") {
      const search = searchParams.get("search") ?? undefined;
      const project = searchParams.get("project") ?? undefined;
      const conversations = listConversations({
        search,
        project,
        rootDir: customRootDir,
      });
      return jsonResponse({ conversations });
    }

    // Match /api/conversations/:id and /api/conversations/:id/fork
    const convMatch = pathname.match(
      /^\/api\/conversations\/([^/]+)(\/fork)?$/
    );
    if (convMatch) {
      const conversationId = decodeURIComponent(convMatch[1]!);
      const isFork = convMatch[2] === "/fork";

      if (req.method === "GET" && !isFork) {
        const detail = getConversationDetail(conversationId, customRootDir);
        if (!detail) {
          return jsonResponse(
            { error: `Conversation not found: ${conversationId}` },
            404
          );
        }
        return jsonResponse(detail);
      }

      if (req.method === "DELETE" && !isFork) {
        const result = deleteConversation(conversationId, customRootDir);
        return jsonResponse(result, 200);
      }

      if (req.method === "POST" && isFork) {
        const body = (await req.json().catch(() => ({}))) as {
          targetStepIdx?: number;
          newTitle?: string;
          copyBrain?: boolean;
        };

        const result = forkConversation(
          conversationId,
          {
            targetStepIdx:
              typeof body.targetStepIdx === "number"
                ? body.targetStepIdx
                : undefined,
            newTitle:
              typeof body.newTitle === "string" ? body.newTitle : undefined,
            copyBrain:
              typeof body.copyBrain === "boolean" ? body.copyBrain : true,
          },
          customRootDir
        );

        return jsonResponse(result, 201);
      }
    }

    return jsonResponse({ error: "Endpoint not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, 500);
  }
}
