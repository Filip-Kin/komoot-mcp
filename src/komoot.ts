/**
 * Thin client for komoot's reverse-engineered mobile API (api.komoot.de).
 *
 * There is no official public komoot API for personal use; these endpoints were
 * confirmed empirically against a real account and can change without notice.
 * Auth is HTTP Basic: first with (email, password) to mint a session token, then
 * with (userId, token) for every subsequent call.
 *
 * Verified endpoints:
 *   login            GET  /v006/account/email/{email}/            -> {username, password}
 *   search trails    GET  /v007/discover_tours/from_location/?lat&lng&sport[&q]
 *   nearby spots     GET  /v006/user_highlights/?lon&lat&max_distance&items_range&srid
 *   list bookmarks   GET  /v006/users/{id}/bookmarked_user_highlights/recent/
 *   add bookmark     POST /v006/users/{id}/bookmarked_user_highlights/{highlightId}
 *   remove bookmark  DELETE  (same as add)
 * Geocoding uses komoot's public Photon service (no auth).
 */

import { config } from "./config.js";
import { log } from "./log.js";

const API = "https://api.komoot.de";
const PHOTON = "https://photon.komoot.io/api";

/** komoot sport ids, mapped from friendly names callers are likely to use. */
const SPORT_ALIASES: Record<string, string> = {
  hike: "hike", hiking: "hike", walk: "hike", walking: "hike",
  run: "jogging", running: "jogging", jog: "jogging", jogging: "jogging",
  bike: "touringbicycle", cycling: "touringbicycle", "bike touring": "touringbicycle", touring: "touringbicycle", touringbicycle: "touringbicycle",
  road: "racebike", "road bike": "racebike", roadbike: "racebike", racebike: "racebike",
  mtb: "mtb", "mountain bike": "mtb", mountainbike: "mtb", mountainbiking: "mtb",
  gravel: "mtb_easy", "gravel bike": "mtb_easy",
  mountaineering: "mountaineering", alpine: "mountaineering",
};

export function normaliseSport(input: string | undefined): string {
  if (!input) return "hike";
  const key = input.trim().toLowerCase();
  return SPORT_ALIASES[key] ?? key; // pass through unknown ids unchanged
}

export interface Trail {
  id: string;
  kind: "tour" | "highlight";
  name: string;
  sport: string;
  distanceKm?: number;
  durationMin?: number;
  elevationUpM?: number;
  start?: { lat: number; lng: number };
  imageUrl?: string;
  url: string;
  /** For tours: the highlight to bookmark (a tour is not itself bookmarkable). */
  bookmarkHighlightId?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

let session: { userId: string; token: string } | null = null;

async function login(force = false): Promise<{ userId: string; token: string }> {
  if (session && !force) return session;
  const { email, password } = config.komoot;
  if (!email || !password) throw new Error("KOMOOT_EMAIL / KOMOOT_PASSWORD are not set on the server.");
  const basic = "Basic " + Buffer.from(`${email}:${password}`).toString("base64");
  const r = await fetch(`${API}/v006/account/email/${encodeURIComponent(email)}/?hl=en`, {
    headers: { Authorization: basic, Accept: "application/json" },
  });
  if (r.status === 401) throw new Error("komoot rejected the login (check the account is email+password, not Google/Apple SSO).");
  if (!r.ok) throw new Error(`komoot login failed: HTTP ${r.status}`);
  const j = (await r.json()) as { username?: string; password?: string };
  if (!j.username || !j.password) throw new Error("komoot login returned no session token.");
  session = { userId: j.username, token: j.password };
  log("komoot session established for user", j.username);
  return session;
}

/** Authenticated fetch with one automatic re-login on 401. */
async function api(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const s = await login();
  const auth = "Basic " + Buffer.from(`${s.userId}:${s.token}`).toString("base64");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: auth, Accept: "application/hal+json,application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 401 && retry) {
    session = null;
    await login(true);
    return api(path, init, false);
  }
  return res;
}

export async function currentUserId(): Promise<string> {
  return (await login()).userId;
}

// #region geocoding
/** Resolve a place name to a coordinate via komoot's Photon geocoder. */
export async function geocode(place: string): Promise<GeoPoint | null> {
  const url = `${PHOTON}/?q=${encodeURIComponent(place)}&limit=1`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`geocoder failed: HTTP ${r.status}`);
  const j = (await r.json()) as any;
  const f = j?.features?.[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates as [number, number];
  const p = f.properties ?? {};
  const label = [p.name, p.city ?? p.county, p.state, p.country].filter(Boolean).join(", ");
  return { lat, lng, label: label || place };
}
// #endregion

// #region discovery
function tourUrl(id: string): string {
  return `https://www.komoot.com/smarttour/${id}`;
}
function highlightUrl(id: string): string {
  return `https://www.komoot.com/highlight/${id}`;
}

/** Ready-made routes near a coordinate (komoot's "Discover" tour search). */
export async function searchTours(lat: number, lng: number, sport: string, query?: string): Promise<Trail[]> {
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng), sport: normaliseSport(sport) });
  if (query) qs.set("q", query);
  const r = await api(`/v007/discover_tours/from_location/?${qs}`);
  if (!r.ok) throw new Error(`trail search failed: HTTP ${r.status}`);
  const j = (await r.json()) as any;
  const items: any[] = j?._embedded?.items ?? [];
  return items.map((t) => ({
    id: String(t.id),
    kind: "tour" as const,
    name: t.name ?? "Unnamed route",
    sport: t.sport ?? sport,
    distanceKm: typeof t.distance === "number" ? round(t.distance / 1000, 1) : undefined,
    durationMin: typeof t.duration === "number" ? Math.round(t.duration / 60) : undefined,
    elevationUpM: typeof t.elevation_up === "number" ? Math.round(t.elevation_up) : undefined,
    start: t.start_point ? { lat: t.start_point.lat, lng: t.start_point.lng } : undefined,
    url: tourUrl(String(t.id)),
  }));
}

/** Community "Highlights" (scenic spots, trailheads, segments) near a coordinate. */
export async function nearbyHighlights(lat: number, lng: number, sport: string, maxDistanceM = 30000): Promise<Trail[]> {
  const qs = new URLSearchParams({
    lon: String(lng), lat: String(lat), max_distance: String(maxDistanceM),
    items_range: "0-24", srid: "4326",
  });
  const wantedSport = normaliseSport(sport);
  const r = await api(`/v006/user_highlights/?${qs}`);
  if (!r.ok) throw new Error(`nearby highlights failed: HTTP ${r.status}`);
  const list = (await r.json()) as any[];
  return (Array.isArray(list) ? list : [])
    .filter((h) => !sport || h.sport === wantedSport)
    .map((h) => ({
      id: String(h.id),
      kind: "highlight" as const,
      name: h.name ?? "Unnamed highlight",
      sport: h.sport ?? wantedSport,
      distanceKm: typeof h.distance === "number" && h.distance > 0 ? round(h.distance / 1000, 1) : undefined,
      elevationUpM: typeof h.elevationUp === "number" && h.elevationUp > 0 ? Math.round(h.elevationUp) : undefined,
      start: h.startPoint ? { lat: h.startPoint.y, lng: h.startPoint.x } : undefined,
      imageUrl: h.frontImageUrl,
      url: highlightUrl(String(h.id)),
      bookmarkHighlightId: String(h.id),
    }));
}
// #endregion

// #region bookmarks
export interface Bookmark {
  id: string;
  name: string;
  sport: string;
  url: string;
  imageUrl?: string;
}

export async function listBookmarks(): Promise<Bookmark[]> {
  const uid = await currentUserId();
  const r = await api(`/v006/users/${uid}/bookmarked_user_highlights/recent/?srid=4326&items_range=0-99&fields=start_point,mid_point,images`);
  if (!r.ok) throw new Error(`listing bookmarks failed: HTTP ${r.status}`);
  const list = (await r.json()) as any[];
  return (Array.isArray(list) ? list : []).map((h) => ({
    id: String(h.id),
    name: h.name ?? "Unnamed highlight",
    sport: h.sport ?? "",
    url: highlightUrl(String(h.id)),
    imageUrl: h.frontImageUrl ?? h.images?.[0]?.imageUrl,
  }));
}

/** Save a highlight to the account's bookmarks. Idempotent from the caller's view. */
export async function addBookmark(highlightId: string): Promise<void> {
  const uid = await currentUserId();
  const r = await api(`/v006/users/${uid}/bookmarked_user_highlights/${highlightId}`, { method: "POST" });
  if (!r.ok && r.status !== 409) throw new Error(`bookmark failed: HTTP ${r.status}`);
}

export async function removeBookmark(highlightId: string): Promise<void> {
  const uid = await currentUserId();
  const r = await api(`/v006/users/${uid}/bookmarked_user_highlights/${highlightId}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error(`remove bookmark failed: HTTP ${r.status}`);
}
// #endregion

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
