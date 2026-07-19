import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowPathIcon,
  Bars3Icon,
  ChevronDownIcon,
  CommandLineIcon,
  EllipsisHorizontalIcon,
  PlusIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import type { FinishPreflight, ProjectRecord, TerminalRecord, WorktreeRecord } from "@wtr/shared";
import { ApiError, apiClient } from "./api.js";
import { TerminalView } from "./terminal-view.js";

type Modal =
  | { type: "project" }
  | { type: "worktree"; project: ProjectRecord }
  | { type: "terminal"; worktree: WorktreeRecord }
  | { type: "cleanup"; project: ProjectRecord }
  | { type: "finish"; worktree: WorktreeRecord }
  | { type: "discard"; worktree: WorktreeRecord }
  | { type: "diagnostics" }
  | null;

export default function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(() =>
    localStorage.getItem("wtr-terminal"),
  );
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(async () => {
    try {
      const next = await apiClient.projects();
      setProjects(next);
      setUnauthorized(false);
      setSelectedTerminalId((current) => {
        if (
          current &&
          next.some((project) =>
            project.worktrees.some((worktree) =>
              worktree.terminals.some((terminal) => terminal.id === current),
            ),
          )
        ) {
          return current;
        }
        return (
          next.flatMap((project) => project.worktrees.flatMap((worktree) => worktree.terminals))[0]
            ?.id ?? null
        );
      });
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) setUnauthorized(true);
      else setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (unauthorized) return;
    const events = new EventSource("/api/events");
    const refresh = () => void load();
    const eventNames = [
      "project.created",
      "project.updated",
      "worktree.created",
      "worktree.updated",
      "worktree.removed",
      "terminal.created",
      "terminal.updated",
      "terminal.removed",
      "cleanup.completed",
      "cleanup.failed",
    ];
    eventNames.forEach((name) => events.addEventListener(name, refresh));
    return () => events.close();
  }, [load, unauthorized]);

  const allWorktrees = useMemo(() => projects.flatMap((project) => project.worktrees), [projects]);
  const allTerminals = useMemo(
    () => allWorktrees.flatMap((worktree) => worktree.terminals),
    [allWorktrees],
  );
  const selectedTerminal =
    allTerminals.find((terminal) => terminal.id === selectedTerminalId) ?? null;
  const selectedWorktree = selectedTerminal
    ? (allWorktrees.find((worktree) => worktree.id === selectedTerminal.worktreeId) ?? null)
    : (allWorktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null);

  const selectWorktree = (worktree: WorktreeRecord) => {
    setSelectedWorktreeId(worktree.id);
    if (worktree.kind === "linked")
      void apiClient.refreshPr(worktree.id).then(load).catch(showError(setError));
  };

  const selectTerminal = (terminal: TerminalRecord) => {
    setSelectedTerminalId(terminal.id);
    setSelectedWorktreeId(terminal.worktreeId);
    localStorage.setItem("wtr-terminal", terminal.id);
    const worktree = allWorktrees.find((item) => item.id === terminal.worktreeId);
    if (worktree?.kind === "linked")
      void apiClient.refreshPr(worktree.id).then(load).catch(showError(setError));
    setDrawerOpen(false);
  };

  if (unauthorized) return <Login onSuccess={() => void load()} />;

  return (
    <div className="app-frame">
      <header className="mobile-bar">
        <button
          type="button"
          className="icon-button"
          aria-label="Open worktree drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <Bars3Icon />
          <span className="touch-target" aria-hidden="true" />
        </button>
        <select
          name="terminal-selector"
          aria-label="Terminal selector"
          value={selectedTerminalId ?? ""}
          onChange={(event) => {
            const terminal = allTerminals.find((item) => item.id === event.target.value);
            if (terminal) selectTerminal(terminal);
          }}
        >
          <option value="">Select terminal</option>
          {allTerminals.map((terminal) => (
            <option value={terminal.id} key={terminal.id}>
              {terminal.name}
            </option>
          ))}
        </select>
        <span className="mobile-brand">wtr</span>
      </header>
      <div
        className={drawerOpen ? "drawer-backdrop open" : "drawer-backdrop"}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside className={drawerOpen ? "sidebar open" : "sidebar"}>
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Worktree driver</p>
            <h1>wtr</h1>
          </div>
          <button
            type="button"
            className="icon-button mobile-close"
            aria-label="Close drawer"
            onClick={() => setDrawerOpen(false)}
          >
            <XMarkIcon />
            <span className="touch-target" aria-hidden="true" />
          </button>
        </header>
        <div className="sidebar-primary">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setModal({ type: "project" })}
          >
            <PlusIcon /> Add project
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Diagnostics"
            title="Diagnostics"
            onClick={() => setModal({ type: "diagnostics" })}
          >
            <WrenchScrewdriverIcon />
            <span className="touch-target" aria-hidden="true" />
          </button>
        </div>
        <nav className="tree" aria-label="Projects and worktrees">
          {loading ? <p className="sidebar-note">Loading repositories…</p> : null}
          {!loading && !projects.length ? (
            <p className="sidebar-note">Register a Git repository to begin.</p>
          ) : null}
          {projects.map((project) => (
            <section className="project-tree" key={project.id}>
              <div className="project-row">
                <div className="project-name" title={project.repositoryPath}>
                  <ChevronDownIcon /> <strong>{project.name}</strong>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="icon-button compact"
                    aria-label={`Create worktree in ${project.name}`}
                    title="New worktree"
                    onClick={() => setModal({ type: "worktree", project })}
                  >
                    <PlusIcon />
                    <span className="touch-target" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button compact"
                    aria-label={`Cleanup ${project.name}`}
                    title="Clean merged worktrees"
                    onClick={() => setModal({ type: "cleanup", project })}
                  >
                    <ArrowPathIcon />
                    <span className="touch-target" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <ul role="list">
                {project.worktrees.map((worktree) => (
                  <li key={worktree.id}>
                    <button
                      type="button"
                      className={
                        selectedWorktree?.id === worktree.id
                          ? "worktree-row selected"
                          : "worktree-row"
                      }
                      onClick={() => selectWorktree(worktree)}
                    >
                      <span className="branch-line">
                        <span className={worktree.dirty?.dirty ? "dirty-mark" : "clean-mark"} />
                        {worktree.branch}
                      </span>
                      {worktree.kind === "linked" && <PrBadge state={worktree.pr.state} />}
                    </button>
                    <div className="worktree-actions">
                      <button
                        type="button"
                        onClick={() => setModal({ type: "terminal", worktree })}
                      >
                        <PlusIcon /> Terminal
                      </button>
                      {worktree.kind === "linked" && (
                        <button
                          type="button"
                          onClick={() => setModal({ type: "finish", worktree })}
                        >
                          Finish
                        </button>
                      )}
                      {worktree.kind === "linked" && (
                        <button
                          type="button"
                          onClick={() => setModal({ type: "discard", worktree })}
                        >
                          <EllipsisHorizontalIcon /> Discard
                        </button>
                      )}
                    </div>
                    <ul role="list" className="terminal-list">
                      {worktree.terminals.map((terminal) => (
                        <li key={terminal.id}>
                          <button
                            type="button"
                            className={
                              selectedTerminalId === terminal.id
                                ? "terminal-row selected"
                                : "terminal-row"
                            }
                            onClick={() => selectTerminal(terminal)}
                          >
                            <CommandLineIcon />
                            <span>{terminal.name}</span>
                            <span
                              className={`status-dot ${terminal.status}`}
                              title={terminal.status}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        {selectedTerminal && (
          <footer className="terminal-tools">
            <button
              type="button"
              onClick={() => {
                const name = window.prompt("Terminal name", selectedTerminal.name);
                if (name?.trim())
                  void apiClient
                    .renameTerminal(selectedTerminal.id, name.trim())
                    .then(load)
                    .catch(showError(setError));
              }}
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Delete terminal “${selectedTerminal.name}”? Its tmux session and process will be terminated.`,
                  )
                ) {
                  void apiClient
                    .deleteTerminal(selectedTerminal.id)
                    .then(load)
                    .catch(showError(setError));
                }
              }}
            >
              Delete terminal
            </button>
          </footer>
        )}
      </aside>
      <TerminalView terminal={selectedTerminal} onStatusChange={() => void load()} />
      {error && (
        <div className="toast" role="alert">
          {error}
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
            <XMarkIcon />
          </button>
        </div>
      )}
      {modal && (
        <ActionModal
          modal={modal}
          close={() => setModal(null)}
          refresh={load}
          setError={setError}
        />
      )}
    </div>
  );
}

function PrBadge({ state }: { state: WorktreeRecord["pr"]["state"] }) {
  const label = state === "no_pr" ? "no PR" : state;
  return <span className={`pr-badge ${state}`}>{label}</span>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="login-page">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apiClient.login(token).then(onSuccess).catch(showError(setError));
        }}
      >
        <p className="eyebrow">Private terminal access</p>
        <h1>Unlock wtr</h1>
        <p>
          Enter the daemon’s static authentication token. It is stored only in an HttpOnly session
          cookie.
        </p>
        <label htmlFor="token">Authentication token</label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="button button-primary">
          Continue
        </button>
      </form>
    </main>
  );
}

function ActionModal({
  modal,
  close,
  refresh,
  setError,
}: {
  modal: Exclude<Modal, null>;
  close: () => void;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<
    (FinishPreflight & { commits?: { ahead: number; behind: number } | null }) | null
  >(null);
  const [cleanupPreviews, setCleanupPreviews] = useState<FinishPreflight[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (modal.type === "finish")
      void apiClient.finishPreview(modal.worktree.id).then(setPreview).catch(showError(setError));
    if (modal.type === "discard")
      void apiClient.discardPreview(modal.worktree.id).then(setPreview).catch(showError(setError));
    if (modal.type === "cleanup")
      void apiClient
        .cleanupPreview(modal.project.id)
        .then(setCleanupPreviews)
        .catch(showError(setError));
    if (modal.type === "diagnostics")
      void apiClient.diagnostics().then(setDiagnostics).catch(showError(setError));
  }, [modal]);

  const submit = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action()
      .then(async () => {
        close();
        await refresh();
      })
      .catch(showError(setError))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button
          type="button"
          className="icon-button modal-close"
          aria-label="Close"
          onClick={close}
        >
          <XMarkIcon />
          <span className="touch-target" aria-hidden="true" />
        </button>
        {modal.type === "project" && (
          <ProjectForm
            busy={busy}
            onSubmit={(repositoryPath) => submit(() => apiClient.addProject(repositoryPath))}
          />
        )}
        {modal.type === "worktree" && (
          <WorktreeForm
            project={modal.project}
            busy={busy}
            onSubmit={(branch, fromCurrent) =>
              submit(() => apiClient.createWorktree(modal.project.id, branch, fromCurrent))
            }
          />
        )}
        {modal.type === "terminal" && (
          <TerminalForm
            worktree={modal.worktree}
            busy={busy}
            onSubmit={(name, argv) =>
              submit(() => apiClient.createTerminal(modal.worktree.id, name, argv))
            }
          />
        )}
        {modal.type === "finish" && (
          <CleanupConfirm
            title="Finish worktree"
            worktree={modal.worktree}
            preview={preview}
            busy={busy}
            onConfirm={() => submit(() => apiClient.finish(modal.worktree.id))}
          />
        )}
        {modal.type === "discard" && (
          <DiscardConfirm
            worktree={modal.worktree}
            preview={preview}
            busy={busy}
            onConfirm={(confirm) => submit(() => apiClient.discard(modal.worktree.id, confirm))}
          />
        )}
        {modal.type === "cleanup" && (
          <BulkCleanup
            project={modal.project}
            previews={cleanupPreviews}
            busy={busy}
            onConfirm={() => submit(() => apiClient.cleanup(modal.project.id))}
          />
        )}
        {modal.type === "diagnostics" && <Diagnostics values={diagnostics} />}
      </section>
    </div>
  );
}

function ProjectForm({ busy, onSubmit }: { busy: boolean; onSubmit: (path: string) => void }) {
  const [pathValue, setPathValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(pathValue);
      }}
    >
      <p className="eyebrow">Repository</p>
      <h2 id="modal-title">Register project</h2>
      <label htmlFor="repository-path">Repository path</label>
      <input
        id="repository-path"
        name="repository-path"
        value={pathValue}
        onChange={(event) => setPathValue(event.target.value)}
        placeholder="/Users/you/Projects/example"
        required
        autoFocus
      />
      <p className="form-note">
        The daemon resolves the main checkout and imports existing linked worktrees.
      </p>
      <button type="submit" className="button button-primary" disabled={busy}>
        {busy ? "Registering…" : "Register project"}
      </button>
    </form>
  );
}

function WorktreeForm({
  project,
  busy,
  onSubmit,
}: {
  project: ProjectRecord;
  busy: boolean;
  onSubmit: (branch: string, fromCurrent: boolean) => void;
}) {
  const [branch, setBranch] = useState("");
  const [fromCurrent, setFromCurrent] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(branch, fromCurrent);
      }}
    >
      <p className="eyebrow">{project.name}</p>
      <h2 id="modal-title">Create worktree</h2>
      <label htmlFor="branch">Branch name</label>
      <input
        id="branch"
        name="branch"
        value={branch}
        onChange={(event) => setBranch(event.target.value)}
        placeholder="feature/cache"
        required
        autoFocus
      />
      <label className="check-row">
        <input
          type="checkbox"
          name="from-current"
          checked={fromCurrent}
          onChange={(event) => setFromCurrent(event.target.checked)}
        />{" "}
        Start from current branch
      </label>
      <p className="form-note">
        Creation runs through <code>git gtr</code>, including its copy rules and hooks.
      </p>
      <button type="submit" className="button button-primary" disabled={busy}>
        {busy ? "Creating…" : "Create worktree"}
      </button>
    </form>
  );
}

function TerminalForm({
  worktree,
  busy,
  onSubmit,
}: {
  worktree: WorktreeRecord;
  busy: boolean;
  onSubmit: (name: string, argv?: string[]) => void;
}) {
  const [name, setName] = useState("Pi");
  const [kind, setKind] = useState("pi");
  const [argvText, setArgvText] = useState('["pnpm", "dev"]');
  const [parseError, setParseError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        let argv: string[] | undefined;
        if (kind === "pi") argv = ["pi"];
        if (kind === "dev") argv = ["pnpm", "dev"];
        if (kind === "custom") {
          try {
            const parsed = JSON.parse(argvText) as unknown;
            if (
              !Array.isArray(parsed) ||
              !parsed.length ||
              !parsed.every((value) => typeof value === "string")
            )
              throw new Error("Enter a non-empty JSON string array");
            argv = parsed;
          } catch (parseIssue) {
            setParseError(parseIssue instanceof Error ? parseIssue.message : String(parseIssue));
            return;
          }
        }
        onSubmit(name, argv);
      }}
    >
      <p className="eyebrow">{worktree.branch}</p>
      <h2 id="modal-title">Create terminal</h2>
      <label htmlFor="terminal-name">Display name</label>
      <input
        id="terminal-name"
        name="terminal-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        autoFocus
      />
      <label htmlFor="terminal-kind">Command</label>
      <select
        id="terminal-kind"
        name="terminal-kind"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value);
          if (event.target.value === "shell") setName("Shell");
          if (event.target.value === "pi") setName("Pi");
          if (event.target.value === "dev") setName("Dev server");
        }}
      >
        <option value="pi">Pi — ["pi"]</option>
        <option value="shell">Login shell</option>
        <option value="dev">Dev server — ["pnpm", "dev"]</option>
        <option value="custom">Custom argv</option>
      </select>
      {kind === "custom" && (
        <>
          <label htmlFor="argv">JSON argv array</label>
          <textarea
            id="argv"
            name="argv"
            rows={4}
            value={argvText}
            onChange={(event) => setArgvText(event.target.value)}
          />
          <p className="form-note">Arguments are spawned literally without shell interpolation.</p>
        </>
      )}
      {parseError && <p className="form-error">{parseError}</p>}
      <button type="submit" className="button button-primary" disabled={busy}>
        {busy ? "Starting…" : "Create terminal"}
      </button>
    </form>
  );
}

function CleanupConfirm({
  title,
  worktree,
  preview,
  busy,
  onConfirm,
}: {
  title: string;
  worktree: WorktreeRecord;
  preview: FinishPreflight | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <div>
      <p className="eyebrow">Safe cleanup</p>
      <h2 id="modal-title">{title}</h2>
      <CleanupFacts worktree={worktree} preview={preview} />
      {preview && !preview.eligible && (
        <div className="warning">
          <strong>Finish refused</strong>
          <ul>
            {preview.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        className="button button-primary danger"
        disabled={busy || !preview?.eligible}
        onClick={onConfirm}
      >
        {busy ? "Accepting…" : "Finish and terminate terminals"}
      </button>
    </div>
  );
}

function DiscardConfirm({
  worktree,
  preview,
  busy,
  onConfirm,
}: {
  worktree: WorktreeRecord;
  preview: (FinishPreflight & { commits?: { ahead: number; behind: number } | null }) | null;
  busy: boolean;
  onConfirm: (confirm: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  return (
    <div>
      <p className="eyebrow">Destructive cleanup</p>
      <h2 id="modal-title">Discard worktree</h2>
      <CleanupFacts worktree={worktree} preview={preview} />
      <div className="warning danger">
        <strong>All terminals and local changes will be lost.</strong>
        <p>
          This force-removes the worktree through <code>git gtr</code>.
        </p>
      </div>
      <label htmlFor="branch-confirm">Type {worktree.branch} to confirm</label>
      <input
        id="branch-confirm"
        name="branch-confirm"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        autoComplete="off"
      />
      <button
        type="button"
        className="button button-primary danger"
        disabled={busy || confirmation !== worktree.branch}
        onClick={() => onConfirm(confirmation)}
      >
        {busy ? "Accepting…" : "Discard permanently"}
      </button>
    </div>
  );
}

function CleanupFacts({
  worktree,
  preview,
}: {
  worktree: WorktreeRecord;
  preview: (FinishPreflight & { commits?: { ahead: number; behind: number } | null }) | null;
}) {
  return (
    <dl className="facts">
      <div>
        <dt>Branch</dt>
        <dd>{worktree.branch}</dd>
      </div>
      <div>
        <dt>Path</dt>
        <dd>{worktree.path}</dd>
      </div>
      <div>
        <dt>Pull request</dt>
        <dd>{preview?.pr.state ?? "checking…"}</dd>
      </div>
      <div>
        <dt>Git merged</dt>
        <dd>{preview ? (preview.gitMerged ? "yes" : "no") : "checking…"}</dd>
      </div>
      {preview?.commits && (
        <div>
          <dt>Commits</dt>
          <dd>
            {preview.commits.ahead} ahead, {preview.commits.behind} behind
          </dd>
        </div>
      )}
      <div>
        <dt>Uncommitted</dt>
        <dd>
          {preview
            ? `${preview.dirty.total} (${preview.dirty.staged} staged, ${preview.dirty.unstaged} unstaged, ${preview.dirty.untracked} untracked)`
            : "checking…"}
        </dd>
      </div>
      <div>
        <dt>Terminals killed</dt>
        <dd>
          {preview
            ? preview.terminals.map((terminal) => terminal.name).join(", ") || "none"
            : "checking…"}
        </dd>
      </div>
    </dl>
  );
}

function BulkCleanup({
  project,
  previews,
  busy,
  onConfirm,
}: {
  project: ProjectRecord;
  previews: FinishPreflight[] | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const eligible = previews?.filter((preview) => preview.eligible) ?? [];
  return (
    <div>
      <p className="eyebrow">{project.name}</p>
      <h2 id="modal-title">Clean merged worktrees</h2>
      <p className="form-note">
        Bulk cleanup uses the same strict finish checks for each worktree. Dirty worktrees are never
        forced.
      </p>
      <div className="preview-list">
        {previews === null ? (
          <p>Checking branches and pull requests…</p>
        ) : (
          previews.map((preview) => (
            <div key={preview.worktreeId}>
              <strong>{preview.branch}</strong>
              <span>
                {preview.path}
                <br />
                PR: {preview.pr.state} · dirty: {preview.dirty.total}
                <br />
                Terminals: {preview.terminals.map((terminal) => terminal.name).join(", ") || "none"}
                <br />
                {preview.eligible ? "Eligible for safe finish" : preview.reasons.join(", ")}
              </span>
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        className="button button-primary danger"
        disabled={busy || !eligible.length}
        onClick={onConfirm}
      >
        {busy
          ? "Accepting…"
          : `Clean ${eligible.length} worktree${eligible.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}

function Diagnostics({ values }: { values: Record<string, unknown> | null }) {
  return (
    <div>
      <p className="eyebrow">Local daemon</p>
      <h2 id="modal-title">Diagnostics</h2>
      {values ? (
        <dl className="facts diagnostics">
          {Object.entries(values).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>Checking dependencies…</p>
      )}
    </div>
  );
}

function showError(setError: (value: string | null) => void) {
  return (value: unknown) => setError(value instanceof Error ? value.message : String(value));
}
