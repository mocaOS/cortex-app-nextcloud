import { useCallback, useEffect, useState } from "react";
import { listEntries, type NcConfig, type NcEntry } from "../lib/nextcloud";

export function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Minimal folder browser: breadcrumb navigation + checkbox selection.
 * Selecting a folder means "sync it including all sub-folders" (expansion
 * happens at task-submit time). Files are listed too — read-only context,
 * so the browser reflects what the sync will actually pick up.
 */
export default function FolderPicker({
  cfg,
  selected,
  onChange,
  disabled,
}: {
  cfg: NcConfig;
  selected: string[];
  onChange: (roots: string[]) => void;
  disabled: boolean;
}) {
  const [path, setPath] = useState("");
  const [folders, setFolders] = useState<NcEntry[]>([]);
  const [files, setFiles] = useState<NcEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (folderPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const entries = await listEntries(cfg, folderPath);
      setFolders(entries.folders);
      setFiles(entries.files);
      setPath(folderPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cfg]);

  useEffect(() => {
    void load("");
  }, [load]);

  function toggle(folderPath: string) {
    if (selected.includes(folderPath)) {
      onChange(selected.filter((p) => p !== folderPath));
    } else {
      // drop descendants of the new root — they're covered by it
      onChange([
        ...selected.filter((p) => !p.startsWith(`${folderPath}/`)),
        folderPath,
      ]);
    }
  }

  const crumbs = path.split("/").filter(Boolean);
  const coveredBy = (folderPath: string) =>
    selected.find((root) => folderPath === root || folderPath.startsWith(`${root}/`));

  return (
    <div className="border border-[var(--color-line)] bg-[var(--color-card)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-muted)]">
          Folders
        </span>
        <button
          onClick={() => void load("")}
          className="font-mono text-xs text-[var(--color-accent)] hover:underline"
        >
          root
        </button>
        {crumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-2 font-mono text-xs">
            <span className="text-[var(--color-faint)]">/</span>
            <button
              onClick={() => void load(crumbs.slice(0, i + 1).join("/"))}
              className="hover:text-[var(--color-accent)]"
            >
              {crumb}
            </button>
          </span>
        ))}
      </div>

      {error && <p className="px-4 py-3 font-mono text-xs text-red-400">{error}</p>}
      {loading && (
        <p className="px-4 py-3 font-mono text-xs uppercase tracking-[0.1em] text-[var(--color-faint)]">
          loading…
        </p>
      )}

      {!loading && !error && (
        <ul className="max-h-72 overflow-y-auto">
          {folders.length === 0 && files.length === 0 && (
            <li className="px-4 py-3 font-mono text-xs text-[var(--color-faint)]">
              this folder is empty
            </li>
          )}
          {folders.map((folder) => {
            const root = coveredBy(folder.path);
            const checked = root !== undefined;
            const inherited = checked && root !== folder.path;
            return (
              <li
                key={folder.path}
                className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-2"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || inherited}
                  onChange={() => toggle(folder.path)}
                  className="accent-[var(--color-accent)]"
                  title={inherited ? `covered by "${root}"` : undefined}
                />
                <button
                  onClick={() => void load(folder.path)}
                  className="min-w-0 flex-1 truncate text-left text-sm hover:text-[var(--color-accent)]"
                >
                  {folder.name}
                  <span className="ml-2 font-mono text-xs text-[var(--color-faint)]">›</span>
                </button>
                {inherited && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
                    inherited
                  </span>
                )}
              </li>
            );
          })}
          {files.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-2 opacity-60"
            >
              <span className="w-[13px] shrink-0 text-center font-mono text-xs text-[var(--color-faint)]">
                ·
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-muted)]">
                {file.name}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">
                {formatSize(file.size)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-[var(--color-line)] px-4 py-3">
          {selected.map((root) => (
            <span
              key={root}
              className="flex items-center gap-2 border border-[var(--color-line)] px-2 py-1 font-mono text-xs"
            >
              /{root || "(entire files root)"}
              <button
                onClick={() => toggle(root)}
                disabled={disabled}
                className="text-[var(--color-faint)] hover:text-red-400"
                aria-label={`remove ${root}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
