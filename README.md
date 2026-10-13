# Nextcloud Sync — a Cortex App

Sync selected [Nextcloud](https://nextcloud.com/) folders into the
[Cortex](https://github.com/mocaOS/cortex-app) knowledge graph — on demand
or on a schedule, fully server-side via WebDAV.

Pick folders in a built-in browser; Cortex lists them with PROPFIND, detects
new and edited files by ETag, downloads the originals (PDF, Office, markdown,
images, …) server-side and runs its normal ingestion pipeline on each. Edited
files replace their previous Cortex document instead of duplicating it.

Built from [cortex-app-template](https://github.com/mocaOS/cortex-app-template).
Type: `platform` — the sync itself runs **inside Cortex** as a declarative
platform task, not in your browser. Close the tab and it keeps going; give
it a schedule and it becomes a standing sync daemon with no browser anywhere.

> Requires a Cortex instance with the `webdav` task step and binary
> passthrough upload (cortex-app ≥ 2.1 / July 2026 platform extensions).

## Install

1. `npm install && npm run package` → `nextcloud-sync-{version}.zip`
2. Cortex admin → **Settings → Apps → Install**, upload the zip.
   (Requires `ENABLE_APPS=true` on the instance.)
3. Configure the app (Settings → Apps → Configure):
   - `NEXTCLOUD_BASE_URL` — your Nextcloud URL, e.g. `https://cloud.example.com`
   - `NEXTCLOUD_USER` — the **login name** (WebDAV paths are per-user)
   - `NEXTCLOUD_APP_PASSWORD` — the app password, pasted as-is. Create it
     under *Settings → Security → Devices & sessions* in Nextcloud. Basic auth
     is assembled and base64-encoded server-side — no manual encoding.
     Stored encrypted in Cortex, injected server-side on every call — it
     never reaches the browser, and Nextcloud needs **no CORS setup**
     (stock Nextcloud sends no CORS headers on WebDAV anyway).
4. Open the app (`/apps` → Nextcloud Sync), select folders, pick a schedule
   (or stay manual) and a target collection, and hit **Sync**.

## How the sync works

The app submits one declarative task (`tasks` capability) that Cortex
executes in its own async loop:

- **setup** — one `webdav` PROPFIND (depth 1, files only) per synced folder.
  The folder list is your selected roots plus all their sub-folders,
  discovered at submit time (capped at 40 folders).
- **per file** (2 in flight, per-item error isolation) — the listings are
  concatenated and deduped against app storage: `synced/{fileId}:{etag}`
  means the ETag *is* the change cursor. For each new or changed file:
  skip non-document MIME types (optional) and files over ~19 MB →
  **binary passthrough upload**: Cortex fetches the file from WebDAV and
  streams it straight into `POST /api/upload` (`source=nextcloud-sync`) —
  the bytes never touch a browser → record the new state in storage.
  Edited files **replace their Cortex document in place**: the upload
  carries a stable `source_key` plus the previous document id
  (`docmap/{fileId}`), so the document keeps its id and Cortex re-extracts
  only the parts that changed. On a Cortex backend without in-place
  replace, the app falls back to the old behaviour (new document, then
  the previous one is deleted).

With a schedule (`every hour` / `6 hours` / `daily`), Cortex re-runs the
task on its own. The app UI is just a dashboard: live progress, pause /
cancel / retry-failed, and per-file errors. Runs survive Cortex restarts.

Cortex then runs its normal pipeline (Docling parsing, chunking, embeddings,
entity extraction) on each file — watch progress on the Documents page.

### v1 limitations

- Deleting a file in Nextcloud does **not** delete it in Cortex.
- Renames re-sync under the new name (same content); the existing document
  is replaced in place, not duplicated.
- New sub-folders under a synced root are discovered when the task is
  re-submitted (any **Sync now** / settings change), not mid-schedule.
- Files larger than ~19 MB are skipped (platform transfer cap).
- Filenames containing `#` or `?` can fail the WebDAV fetch (URL parsing).

## Manifest notes

- `keyScope: read_write` — uploads (and the old-backend replace fallback's
  deletes) need MANAGE
- `endpoints: ["upload", "documents", "collections"]` — everything else 403s
- `capabilities: http` (WebDAV calls, host-allowlisted to
  `${NEXTCLOUD_BASE_URL}`, Basic auth injected server-side), `tasks` (the
  sync engine), `storage` (ETag state + docmap + shared UI preferences)

## Dev loop

```
cp .env.example .env   # CORTEX_DEV_URL + a cortex_rw_… key
npm run dev
```

The Vite proxy plays the hosting proxy's role in dev; platform calls hit
your configured dev instance.
