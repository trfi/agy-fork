import { existsSync } from "node:fs";
import { join } from "node:path";
import { handleApiRequest } from "./routes/api.ts";
import { resolveAntigravityPaths } from "./services/antigravity-paths.ts";

const PORT = Number(process.env.PORT ?? 3456);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function createServer(port = PORT, customRootDir?: string) {
  return Bun.serve({
    port,
    async fetch(req) {
      const apiRes = await handleApiRequest(req, customRootDir);
      if (apiRes) return apiRes;

      const url = new URL(req.url);
      const relPath =
        url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const safePath = join(PUBLIC_DIR, relPath);

      if (safePath.startsWith(PUBLIC_DIR) && existsSync(safePath)) {
        return new Response(Bun.file(safePath), {
          headers: { "Content-Type": getMimeType(safePath) },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = createServer(PORT);
  const paths = resolveAntigravityPaths();
  console.log(`=====================================================`);
  console.log(`🚀 AGY Conversation Forker running at: http://localhost:${server.port}`);
  console.log(`📂 Antigravity Data Directory: ${paths.rootDir}`);
  console.log(`=====================================================`);
}
