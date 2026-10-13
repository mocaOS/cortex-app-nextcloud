/**
 * The sync, as a Cortex platform task.
 *
 * Instead of a browser-side loop, the whole Nextcloud → Cortex pipeline is a
 * declarative step-queue that Cortex executes server-side:
 *
 *   setup    one `webdav` PROPFIND (depth 1, files only) per synced folder —
 *            the folder list is expanded from the user's selection at submit
 *            time (roots + all descendant folders, capped at 40)
 *   items    all listings concatenated (`fromEach`), deduped against storage
 *            keys synced/{fileId}:{etag} — the ETag IS the change cursor, so
 *            unchanged files never transfer twice and edited files re-sync
 *   steps    skip non-document types / oversized files → binary passthrough
 *            upload (server-side WebDAV GET → Cortex upload, bytes never touch
 *            the browser or the step context) that REPLACES the file's
 *            existing Cortex document in place (source_key +
 *            replace_document_id from docmap — same document id, only the
 *            changed parts are re-extracted) → record docmap + synced marker
 *
 * Submit it once with a schedule and the sync runs forever, headless —
 * the browser tab is just a dashboard.
 *
 * v1 limitations (documented in README): deletions in Nextcloud do not
 * delete in Cortex; folders created under a synced root are picked up on the
 * next re-submit (Sync now), not mid-schedule; files over ~19 MB are skipped
 * (platform transfer cap).
 */

import { storageGet, storagePut } from "./platform";

export const SYNC_TASK_NAME = "nextcloud-sync";

/** MIME types Cortex ingestion handles well — the "documents only" filter.
 * Matching is substring (DSL `contains`), so full types are listed. */
const DOC_TYPES_LIST = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/epub+zip",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
];
const DOC_TYPES = DOC_TYPES_LIST.join(" ");

/** Files above this are skipped — the platform's server-side fetch caps
 * responses at 20 MB; leave headroom. */
const MAX_FILE_BYTES = 19_000_000;

/** Client-side mirror of the task's per-item skip rules — drives the "~N
 * files will sync" projection so it matches what a run would actually do.
 * Empty contentType passes (the task only skips a NON-empty non-doc type). */
export function wouldSync(
  entry: { contentType: string; size: number },
  docsOnly: boolean,
): boolean {
  if (entry.size > MAX_FILE_BYTES) return false;
  if (!docsOnly || !entry.contentType) return true;
  return DOC_TYPES_LIST.includes(entry.contentType);
}

export interface SyncTaskOptions {
  /** Nextcloud base URL (already trailing-slash-stripped) */
  baseUrl: string;
  /** WebDAV root, e.g. /remote.php/dav/files/rene */
  davRootPath: string;
  /** expanded folder list (paths relative to the files root, "" = root) */
  folders: string[];
  /** Cortex collection to upload into ("" = instance default) */
  collectionId?: string;
  /** re-run interval; omit for a one-shot run */
  everyMinutes?: number;
  /** restrict to document/image MIME types (default true) */
  docsOnly?: boolean;
}

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Old backends (no in-place replace) answer an upload without a "replaced"
 * field and mint a new document — then remove the superseded one, exactly
 * like the pre-replace delete-then-upload flow did. */
const REPLACE_FALLBACK_STEPS = [
  {
    cortex: { method: "DELETE", path: "documents/{prev.value.docId}" },
    when: {
      and: [
        { notEmpty: "$prev.value.docId" },
        { eq: ["{up.body.replaced}", ""] },
        { neq: ["{up.body.document_id}", "{prev.value.docId}"] },
      ],
    },
  },
];

export function buildSyncTask(opts: SyncTaskOptions): Record<string, unknown> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const uploadParams = new URLSearchParams({
    start_processing: "true",
    source: "nextcloud-sync",
  });
  if (opts.collectionId) uploadParams.set("collection_id", opts.collectionId);
  // stable per-server identity: fileIds are only unique within one server
  const sourceKeyPrefix = encodeURIComponent(`nextcloud:${base}${opts.davRootPath}:`);
  const uploadPath =
    `upload?${uploadParams.toString()}` +
    `&source_key=${sourceKeyPrefix}{vars.fileId|urlencode}` +
    `&replace_document_id={prev.value.docId|urlencode}`;

  const listingSteps = opts.folders.map((folder, i) => ({
    id: `f${i}`,
    webdav: {
      url:
        `${base}${opts.davRootPath}` +
        (encodePath(folder) ? `/${encodePath(folder)}` : ""),
      depth: 1,
      filter: "files",
    },
  }));

  return {
    name: SYNC_TASK_NAME,
    ...(opts.everyMinutes ? { schedule: { everyMinutes: opts.everyMinutes } } : {}),
    concurrency: 2,
    setup: listingSteps,
    items: {
      fromEach: listingSteps.map((step) => `$${step.id}.items`),
      vars: {
        fileId: "{item.fileId}",
        name: "{item.name}",
        href: "{item.href}",
        etag: "{item.etag}",
        contentType: "{item.contentType}",
        size: "{item.size}",
      },
      skipIfStored: "synced/{item.fileId}:{item.etag}",
    },
    steps: [
      ...(opts.docsOnly !== false
        ? [
            {
              skipItem: {
                when: {
                  and: [
                    { notEmpty: "$vars.contentType" },
                    { not: { contains: [DOC_TYPES, "{vars.contentType}"] } },
                  ],
                },
                reason: "not a document type ({vars.contentType})",
              },
            },
          ]
        : []),
      {
        skipItem: {
          when: { gt: ["{vars.size}", MAX_FILE_BYTES] },
          reason: "larger than the 19 MB transfer cap",
        },
      },
      // previous sync state for this file (rename/edit tracking by fileId)
      { id: "prev", store: { get: "docmap/{vars.fileId}" } },
      // binary passthrough: server-side WebDAV GET → Cortex upload. A changed
      // file REPLACES its document in place (same id — Cortex re-extracts
      // only what changed): source_key finds it, replace_document_id adopts
      // documents synced before source keys existed. Empty when new.
      {
        id: "up",
        cortex: {
          method: "POST",
          path: uploadPath,
          multipart: {
            fromUrl: "{config.NEXTCLOUD_BASE_URL}{vars.href}",
            filename: "nextcloud-{vars.fileId}-{vars.name}",
          },
        },
      },
      // compatibility: a Cortex backend without in-place replace ignores the
      // replace params and creates a new document (its response has no
      // "replaced" field) — delete the previous one as older app versions did
      ...REPLACE_FALLBACK_STEPS,
      {
        store: {
          put: "docmap/{vars.fileId}",
          value: {
            etag: "{vars.etag}",
            docId: "{up.body.document_id}",
            name: "{vars.name}",
            at: "{run.startedAt}",
          },
        },
      },
      {
        store: {
          put: "synced/{vars.fileId}:{vars.etag}",
          value: { at: "{run.startedAt}" },
        },
      },
    ],
  };
}

// UI preferences, persisted server-side so every device sees the same setup.
export interface SyncPrefs {
  /** selected root folders (paths relative to the files root) */
  roots?: string[];
  collectionId?: string;
  everyMinutes?: number;
  docsOnly?: boolean;
}

const PREFS_KEY = "settings/prefs";

export async function loadPrefs(): Promise<SyncPrefs> {
  return (await storageGet<SyncPrefs>(PREFS_KEY)) ?? {};
}

export async function savePrefs(prefs: SyncPrefs): Promise<void> {
  await storagePut(PREFS_KEY, prefs);
}
