/**
 * MCP tools for searching komoot trails near a location and bookmarking them to
 * the account. A "trail" is either a ready-made route (tour) or a community
 * Highlight (spot/segment). Only Highlights are bookmarkable on komoot, so the
 * bookmark tools take a highlight id (search results label which is which).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import {
  geocode, searchTours, nearbyHighlights, listBookmarks, addBookmark, removeBookmark,
  type Trail, type GeoPoint,
} from "../komoot.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** Resolve the search centre from explicit coords, a place name, or the home default. */
async function resolveCentre(near?: string, lat?: number, lng?: number): Promise<GeoPoint | { error: string }> {
  if (typeof lat === "number" && typeof lng === "number") return { lat, lng, label: `${lat}, ${lng}` };
  if (near && near.trim()) {
    const g = await geocode(near.trim());
    if (!g) return { error: `Could not find a place called "${near}". Try a more specific name.` };
    return g;
  }
  if (typeof config.komoot.homeLat === "number" && typeof config.komoot.homeLng === "number") {
    return { lat: config.komoot.homeLat, lng: config.komoot.homeLng, label: config.komoot.homeLabel };
  }
  return { error: "No location given. Pass a place name (near) or lat/lng — there's no saved home location on this server." };
}

function line(t: Trail): string {
  const bits: string[] = [];
  if (t.distanceKm !== undefined) bits.push(`${t.distanceKm} km`);
  if (t.durationMin !== undefined) bits.push(`~${Math.floor(t.durationMin / 60)}h${String(t.durationMin % 60).padStart(2, "0")}`);
  if (t.elevationUpM !== undefined) bits.push(`${t.elevationUpM} m up`);
  const meta = bits.length ? ` (${bits.join(", ")})` : "";
  const tag = t.kind === "highlight" ? " [bookmarkable]" : "";
  const bm = t.bookmarkHighlightId ? ` — highlight_id ${t.bookmarkHighlightId}` : "";
  return `- ${t.name}${meta} — ${t.sport}${tag}\n  ${t.url}${bm}`;
}

export function registerKomootTools(server: McpServer): void {
  // #region search
  server.registerTool(
    "search_trails",
    {
      title: "Search komoot trails near a location",
      description:
        "Find trails near a place. Give a place name in `near` (e.g. 'Rotorua', geocoded automatically) OR " +
        "explicit `lat`/`lng`. With neither, the server's saved home location is used if set. Returns ready-made " +
        "routes and, unless disabled, nearby Highlights (scenic spots/trailheads). Highlights are the ones you can " +
        "bookmark: note their highlight_id and pass it to bookmark_trail.",
      inputSchema: {
        near: z.string().optional().describe("Place name to search around, e.g. 'Rotorua' or 'Lake Tahoe'."),
        lat: z.number().optional().describe("Latitude, if you have exact coords instead of a place name."),
        lng: z.number().optional().describe("Longitude."),
        sport: z.string().optional().describe("hike (default), run, bike, road, mtb, gravel, or a komoot sport id."),
        query: z.string().optional().describe("Optional keyword to bias the route search, e.g. 'waterfall' or 'loop'."),
        include_highlights: z.boolean().optional().describe("Include nearby Highlights. Default true."),
      },
    },
    async ({ near, lat, lng, sport, query, include_highlights }) => {
      try {
        const centre = await resolveCentre(near, lat, lng);
        if ("error" in centre) return fail(centre.error);
        const sp = sport ?? "hike";
        const tours = await searchTours(centre.lat, centre.lng, sp, query);
        const highlights = include_highlights === false ? [] : await nearbyHighlights(centre.lat, centre.lng, sp);
        if (!tours.length && !highlights.length) {
          return text(`No ${sp} trails found near ${centre.label}. Try a wider sport or a different place.`);
        }
        const parts: string[] = [`Trails near ${centre.label} (${sp}):`];
        if (tours.length) parts.push(`\nReady-made routes:\n${tours.slice(0, 8).map(line).join("\n")}`);
        if (highlights.length) parts.push(`\nHighlights (bookmarkable spots):\n${highlights.slice(0, 12).map(line).join("\n")}`);
        parts.push(`\nTo save one, call bookmark_trail with its highlight_id.`);
        return text(parts.join("\n"));
      } catch (e) {
        return fail(`Search failed: ${(e as Error).message}`);
      }
    },
  );
  // #endregion

  // #region bookmarks
  server.registerTool(
    "bookmark_trail",
    {
      title: "Bookmark a komoot highlight",
      description:
        "Save a Highlight to the komoot account's bookmarks so it shows up in the komoot app under Saved. " +
        "Takes a highlight_id from search_trails (the [bookmarkable] entries).",
      inputSchema: {
        highlight_id: z.string().min(1).describe("The highlight_id from a search_trails result."),
      },
    },
    async ({ highlight_id }) => {
      try {
        await addBookmark(highlight_id.trim());
        return text(`Bookmarked. It's now in your komoot Saved highlights: https://www.komoot.com/highlight/${highlight_id.trim()}`);
      } catch (e) {
        return fail(`Could not bookmark: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "remove_bookmark",
    {
      title: "Remove a komoot bookmark",
      description: "Remove a previously bookmarked Highlight from the komoot account, by highlight_id.",
      inputSchema: {
        highlight_id: z.string().min(1).describe("The highlight_id to un-bookmark."),
      },
    },
    async ({ highlight_id }) => {
      try {
        await removeBookmark(highlight_id.trim());
        return text(`Removed bookmark ${highlight_id.trim()}.`);
      } catch (e) {
        return fail(`Could not remove bookmark: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "list_bookmarks",
    {
      title: "List komoot bookmarks",
      description: "List the Highlights currently bookmarked on the komoot account.",
      inputSchema: {},
    },
    async () => {
      try {
        const bm = await listBookmarks();
        if (!bm.length) return text("No bookmarks yet.");
        const body = bm.map((b) => `- ${b.name}${b.sport ? ` — ${b.sport}` : ""} (highlight_id ${b.id})\n  ${b.url}`).join("\n");
        return text(`${bm.length} bookmarked highlight(s):\n${body}`);
      } catch (e) {
        return fail(`Could not list bookmarks: ${(e as Error).message}`);
      }
    },
  );
  // #endregion
}
