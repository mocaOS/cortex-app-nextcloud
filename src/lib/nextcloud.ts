/**
 * Nextcloud WebDAV client — via the Cortex platform `http` capability.
 *
 * Every call executes SERVER-side inside the Cortex instance: the app posts
 * an envelope to ./api/platform/http (method PROPFIND included), and the
 * backend performs the request with the admin-configured app password
 * injected as a Basic auth header.
 *
 * Consequences (all good):
 *  - no CORS configuration needed on Nextcloud (stock Nextcloud sends no
 *    CORS headers on remote.php/dav — browser-direct would be impossible),
 *  - the app password never exists in the browser,
 *  - the only setup is the app's Cortex config (Settings → Apps → Configure).
 *
 * The browser parses the multistatus XML itself (DOMParser) for the
 * interactive folder picker; the scheduled sync uses the platform's `webdav`
 * task step, which parses the same XML server-side.
 */

import { platform } from "./cortex";

export interface NcConfig {
  baseUrl: string;
  user: string;
}

export interface NcEntry {
  /** server-relative dav path, percent-decoded (starts /remote.php/dav/…) */
  href: string;
  /** path relative to the user's files root, e.g. "/Documents/Reports" */
  path: string;
  name: string;
  etag: string;
  lastModified: string;
  size: number;
  contentType: string;
  isDir: boolean;
}

/** The admin-configured connection values, or null if not configured yet. */
export async function getConfig(): Promise<NcConfig | null> {
  const res = await platform("config");
  if (!res.ok) return null;
  const data = await res.json();
  const baseUrl: string | undefined = data.values?.NEXTCLOUD_BASE_URL;
  const user: string | undefined = data.values?.NEXTCLOUD_USER;
  if (!baseUrl || !user) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), user };
}

export function davRoot(cfg: NcConfig): string {
  return `/remote.php/dav/files/${encodeURIComponent(cfg.user)}`;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>' +
  "<d:getetag/><d:getlastmodified/><d:getcontentlength/>" +
  "<d:getcontenttype/><d:resourcetype/><oc:fileid/>" +
  "</d:prop></d:propfind>";

/** PROPFIND via the platform http envelope. `folderPath` is relative to the
 * user's files root ("" = root). */
export async function propfind(
  cfg: NcConfig,
  folderPath: string,
  depth: 0 | 1 = 1,
): Promise<{ status: number; entries: NcEntry[] }> {
  const encodedPath = folderPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const url =
    `${cfg.baseUrl}${davRoot(cfg)}` + (encodedPath ? `/${encodedPath}` : "");
  const res = await platform("http", {
    method: "POST",
    body: JSON.stringify({
      method: "PROPFIND",
      url,
      body: PROPFIND_BODY,
      content_type: 'application/xml; charset="utf-8"',
      headers: { Depth: String(depth) },
    }),
  });
  if (!res.ok && res.status !== 207) {
    return { status: res.status, entries: [] };
  }
  const text = await res.text();
  return { status: res.status, entries: parseMultistatus(text, cfg) };
}

function parseMultistatus(xml: string, cfg: NcConfig): NcEntry[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = davRoot(cfg);
  const entries: NcEntry[] = [];
  for (const response of Array.from(
    doc.getElementsByTagNameNS("DAV:", "response"),
  )) {
    const hrefRaw =
      response.getElementsByTagNameNS("DAV:", "href")[0]?.textContent ?? "";
    const href = decodeURIComponent(hrefRaw);
    // find the 200-status propstat
    let prop: Element | null = null;
    for (const propstat of Array.from(
      response.getElementsByTagNameNS("DAV:", "propstat"),
    )) {
      const status =
        propstat.getElementsByTagNameNS("DAV:", "status")[0]?.textContent ?? "";
      if (status.includes(" 200 ")) {
        prop = propstat.getElementsByTagNameNS("DAV:", "prop")[0] ?? null;
        break;
      }
    }
    if (!prop || !href.startsWith(root)) continue;
    const relative = href.slice(root.length).replace(/\/+$/, "");
    const get = (ns: string, tag: string) =>
      prop!.getElementsByTagNameNS(ns, tag)[0]?.textContent ?? "";
    let etag = get("DAV:", "getetag").trim();
    if (etag.startsWith("W/")) etag = etag.slice(2);
    etag = etag.replace(/^"|"$/g, "");
    const isDir =
      prop.getElementsByTagNameNS("DAV:", "resourcetype")[0]
        ?.getElementsByTagNameNS("DAV:", "collection").length > 0;
    entries.push({
      href: href.replace(/\/+$/, ""),
      path: relative,
      name: relative.split("/").pop() ?? "",
      etag,
      lastModified: get("DAV:", "getlastmodified"),
      size: Number(get("DAV:", "getcontentlength") || 0),
      contentType: get("DAV:", "getcontenttype"),
      isDir,
    });
  }
  return entries;
}

/** Connectivity + auth check. Returns the root entry count. Throws a
 * human-oriented message. */
export async function testConnection(cfg: NcConfig): Promise<number> {
  const res = await platform("http", {
    method: "POST",
    body: JSON.stringify({
      method: "PROPFIND",
      url: `${cfg.baseUrl}${davRoot(cfg)}`,
      body: PROPFIND_BODY,
      content_type: 'application/xml; charset="utf-8"',
      headers: { Depth: "1" },
    }),
  });
  if (res.status === 503) {
    throw new Error(
      "This app isn't configured yet — an admin must set NEXTCLOUD_BASE_URL, " +
        "NEXTCLOUD_USER and NEXTCLOUD_APP_PASSWORD under Settings → Apps → Nextcloud Sync → Configure.",
    );
  }
  if (res.status === 401 || res.status === 403) {
    const detail = (await res.json().catch(() => null))?.detail ?? "";
    throw new Error(
      typeof detail === "string" && (detail.includes("Blocked") || detail.includes("hosts"))
        ? `Cortex refused the target: ${detail}`
        : "Nextcloud rejected the credentials (401/403). Check that " +
          "NEXTCLOUD_USER is the login name and NEXTCLOUD_APP_PASSWORD is an " +
          "app password pasted as-is (Settings → Security → Devices & sessions " +
          "in Nextcloud) — not your account password. Note that Nextcloud " +
          "throttles repeated failures for a few minutes.",
    );
  }
  if (res.status === 502) {
    throw new Error("Cortex could not reach Nextcloud — check NEXTCLOUD_BASE_URL.");
  }
  if (res.status === 404) {
    throw new Error(
      "WebDAV path not found (404) — check NEXTCLOUD_USER (it must be the " +
        "login name, which can differ from the display name).",
    );
  }
  if (!res.ok && res.status !== 207) {
    throw new Error(`Nextcloud answered ${res.status}`);
  }
  const text = await res.text();
  return parseMultistatus(text, cfg).filter((e) => e.path !== "").length;
}

/** List a folder's children for the picker: sub-folders (selectable) and
 * files (context — a folders-only listing looks broken to humans). */
export async function listEntries(
  cfg: NcConfig,
  folderPath: string,
): Promise<{ folders: NcEntry[]; files: NcEntry[] }> {
  const { entries } = await propfind(cfg, folderPath, 1);
  const children = entries.filter(
    (e) => e.path !== folderPath.replace(/\/+$/, ""),
  );
  const byName = (a: NcEntry, b: NcEntry) => a.name.localeCompare(b.name);
  return {
    folders: children.filter((e) => e.isDir).sort(byName),
    files: children.filter((e) => !e.isDir).sort(byName),
  };
}

/** List sub-folders of a folder (submit-time expansion). */
export async function listFolders(cfg: NcConfig, folderPath: string): Promise<NcEntry[]> {
  return (await listEntries(cfg, folderPath)).folders;
}

export interface SelectionSurvey {
  /** the expanded folder list (roots + descendants, capped) */
  folders: string[];
  /** files the sync would pick up (after the caller's filter) */
  fileCount: number;
  truncated: boolean;
}

/**
 * Walk selected roots + all descendant folders (BFS, capped — the task gets
 * one webdav listing step per folder and the platform caps setup steps at
 * 50), counting the files the sync would pick up along the way. Used both
 * for the live projection in the UI and for submit-time expansion, so the
 * number shown is derived from exactly the folder set the task will get.
 */
export async function surveySelection(
  cfg: NcConfig,
  roots: string[],
  opts: { cap?: number; fileFilter?: (entry: NcEntry) => boolean } = {},
): Promise<SelectionSurvey> {
  const cap = opts.cap ?? 40;
  const keep = opts.fileFilter ?? (() => true);
  const seen = new Set<string>();
  const queue = [...roots.map((r) => r.replace(/\/+$/, ""))];
  const folders: string[] = [];
  let fileCount = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (folders.length >= cap) return { folders, fileCount, truncated: true };
    folders.push(current);
    const entries = await listEntries(cfg, current);
    fileCount += entries.files.filter(keep).length;
    for (const sub of entries.folders) queue.push(sub.path);
  }
  return { folders, fileCount, truncated: false };
}

