import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerKomootTools } from "./tools/komoot.js";

/** One MCP server instance per session (transport lifecycle owns it). */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "komoot", version: "0.1.0" },
    {
      instructions:
        "Search komoot for trails near a location and bookmark them to Filip's komoot account. " +
        "Use search_trails with a place name (near) or lat/lng; it returns ready-made routes and nearby " +
        "Highlights. Only Highlights are bookmarkable — pass a highlight_id to bookmark_trail. " +
        "list_bookmarks and remove_bookmark manage saved highlights.",
    },
  );
  registerKomootTools(server);
  return server;
}
