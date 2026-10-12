"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ItemInput, ItemKind, WorkspaceItem } from "@/lib/items";

type Account = { id: string; email: string };
type View = "agenda" | "task" | "event";
type AuthMode = "login" | "register";
type Draft = {
  title: string;
  details: string;
  scheduledDate: string;
  scheduledTime: string;
};
type Editor = { kind: ItemKind; item: WorkspaceItem | null };

const emptyDraft = (): Draft => ({ title: "", details: "", scheduledDate: "", scheduledTime: "" });

async function errorFromResponse(response: Response, fallback: string) {
  try {
    const result: unknown = await response.json();
    if (result && typeof result === "object" && "error" in result && typeof result.error === "string") {
      return result.error;
    }
  } catch {
    // The endpoint may return an empty response for a session error.
  }
  return fallback;
}

function sortItems(items: WorkspaceItem[]) {
  return [...items].sort((left, right) => {
    if (left.scheduledDate === null && right.scheduledDate !== null) return 1;
    if (left.scheduledDate !== null && right.scheduledDate === null) return -1;
    if (left.scheduledDate && right.scheduledDate && left.scheduledDate !== right.scheduledDate) {
      return left.scheduledDate.localeCompare(right.scheduledDate);
    }
    const leftTime = left.scheduledTime ?? "";
    const rightTime = right.scheduledTime ?? "";
    if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromInput(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateOrdinal(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function groupDateLabel(value: string, clientReady: boolean) {
  const date = dateFromInput(value);
  if (!clientReady) {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(date);
  }

  const today = localDateString(new Date());
  const difference = dateOrdinal(value) - dateOrdinal(today);
  const formatted = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
  if (difference === 0) return `Today · ${formatted}`;
  if (difference === 1) return `Tomorrow · ${formatted}`;
  return formatted;
}

function formatTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(2000, 0, 1, hour, minute));
}

function formatToday() {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}

function NavIcon({ name }: { name: View }) {
  if (name === "agenda") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5.5" width="16" height="15" rx="2.5" />
        <path d="M8 3.5v4M16 3.5v4M4 10h16M8 13.5h2M14 13.5h2M8 17h2" />
      </svg>
    );
  }
  if (name === "task") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <path d="m8 12.3 2.4 2.4L16.5 9" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.5 10.1c0 5.2-7.5 10.4-7.5 10.4S4.5 15.3 4.5 10.1a7.5 7.5 0 1 1 15 0Z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function AuthScreen({
  mode,
  onModeChange,
  onSubmit,
  busy,
  error,
}: {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  error: string | null;
}) {
  const isRegister = mode === "register";

  return (
    <main className="auth-layout">
      <section className="auth-story" aria-label="About FileTasks">
        <div className="auth-story-inner">
          <div className="brand brand-light">
            <BrandMark />
            <span>FileTasks</span>
          </div>
          <div className="story-copy">
            <p className="eyebrow eyebrow-light">A little room to breathe</p>
            <h1>Make space for what matters.</h1>
            <p className="story-description">
              Keep the things you need to do and the moments you want to remember, all in one calm place.
            </p>
          </div>
          <div className="auth-art" aria-hidden="true">
            <div className="art-sun" />
            <div className="art-orbit art-orbit-one" />
            <div className="art-orbit art-orbit-two" />
            <div className="art-leaf art-leaf-one" />
            <div className="art-leaf art-leaf-two" />
            <div className="art-leaf art-leaf-three" />
            <div className="art-card art-card-back">
              <span className="art-card-line art-line-short" />
              <span className="art-card-line" />
              <span className="art-card-line art-line-medium" />
            </div>
            <div className="art-card art-card-front">
              <div className="art-card-heading">
                <span className="art-check">✓</span>
                <span>YOUR DAY, GENTLY PLANNED</span>
              </div>
              <div className="art-plan-row">
                <span className="art-plan-time">09:30</span>
                <span className="art-plan-copy"><b>Take a slower morning</b><small>One thing at a time</small></span>
              </div>
              <div className="art-plan-row art-plan-row-muted">
                <span className="art-plan-time">14:00</span>
                <span className="art-plan-copy"><b>A walk in the garden</b><small>Something to look forward to</small></span>
              </div>
            </div>
            <span className="art-spark art-spark-one">✳</span>
            <span className="art-spark art-spark-two">✦</span>
          </div>
          <p className="story-footnote">Your personal space, wherever you are.</p>
        </div>
      </section>

      <section className="auth-panel" aria-label={isRegister ? "Create an account" : "Sign in"}>
        <div className="auth-panel-inner">
          <div className="mobile-brand brand">
            <BrandMark />
            <span>FileTasks</span>
          </div>
          <p className="eyebrow">WELCOME TO FILETASKS</p>
          <h2>{isRegister ? "Your space starts here." : "Welcome back."}</h2>
          <p className="auth-intro">
            {isRegister ? "Create an account to keep your plans close." : "Sign in to pick up where you left off."}
          </p>

          <div className="auth-switch" role="group" aria-label="Account action">
            <button
              type="button"
              className={isRegister ? "" : "auth-switch-active"}
              aria-pressed={!isRegister}
              onClick={() => onModeChange("login")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={isRegister ? "auth-switch-active" : ""}
              aria-pressed={isRegister}
              onClick={() => onModeChange("register")}
            >
              Create account
            </button>
          </div>

          <form className="auth-form" onSubmit={onSubmit}>
            {error && <p className="form-error" role="alert">{error}</p>}
            <label className="field-label" htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              maxLength={254}
              required
            />
            <label className="field-label password-label" htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder="At least 12 characters"
              minLength={12}
              maxLength={1024}
              required
            />
            <p className="field-hint">Use at least 12 characters.</p>
            <button className="button button-primary auth-submit" type="submit" disabled={busy}>
              {busy ? (isRegister ? "Creating your account…" : "Signing in…") : (isRegister ? "Create account" : "Sign in")}
              {!busy && <span aria-hidden="true">→</span>}
            </button>
          </form>
          <p className="auth-privacy">Your plans are saved privately to your account.</p>
        </div>
      </section>
    </main>
  );
}

function ItemCard({
  item,
  disabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: WorkspaceItem;
  disabled: boolean;
  onToggle: (item: WorkspaceItem) => void;
  onEdit: (item: WorkspaceItem) => void;
  onDelete: (item: WorkspaceItem) => void;
}) {
  const isTask = item.kind === "task";
  const isComplete = isTask && item.completed === true;

  return (
    <article className={`item-card${isComplete ? " item-card-complete" : ""}`}>
      {isTask ? (
        <button
          className={`task-check${isComplete ? " task-check-complete" : ""}`}
          type="button"
              aria-label={isComplete ? `Reopen Task: ${item.title}` : `Complete Task: ${item.title}`}
          aria-pressed={isComplete}
          disabled={disabled}
          onClick={() => onToggle(item)}
        >
          {isComplete && <span aria-hidden="true">✓</span>}
        </button>
      ) : (
        <span className="event-marker" aria-hidden="true"><span /></span>
      )}

      <div className="item-main">
        <div className="item-topline">
          <span className={`kind-badge ${isTask ? "kind-task" : "kind-event"}`}>
            <span className="badge-dot" aria-hidden="true" />
            {isTask ? "TASK" : "EVENT"}
          </span>
          {item.scheduledTime && <span className="item-time">{formatTime(item.scheduledTime)}</span>}
          {isComplete && <span className="complete-label">Completed</span>}
        </div>
        <h3 className="item-title">{item.title}</h3>
        {item.details && <p className="item-details">{item.details}</p>}
      </div>

      <div className="item-actions">
        <button
          className="icon-button"
          type="button"
          aria-label={`Edit ${item.title}`}
          title="Edit"
          disabled={disabled}
          onClick={() => onEdit(item)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m13.7 3.3 3 3M4 16l.6-3.2L13.4 4a1.4 1.4 0 0 1 2 0l.6.6a1.4 1.4 0 0 1 0 2L7.2 15.4 4 16Z" /></svg>
        </button>
        <button
          className="icon-button icon-button-delete"
          type="button"
          aria-label={`Delete ${item.title}`}
          title="Delete"
          disabled={disabled}
          onClick={() => onDelete(item)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V4h4v2m2.5 0-.6 10H6.1L5.5 6m2.7 3v4m3.6-4v4" /></svg>
        </button>
      </div>
    </article>
  );
}

function ItemDialog({
  editor,
  draft,
  setDraft,
  error,
  busy,
  onClose,
  onSubmit,
}: {
  editor: Editor;
  draft: Draft;
  setDraft: (update: (current: Draft) => Draft) => void;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editing = editor.item !== null;
  const kindName = editor.kind === "task" ? "Task" : "Event";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape" && busy) event.preventDefault();
  }

  return (
    <dialog
      className="native-dialog item-dialog"
      ref={dialogRef}
      aria-labelledby="item-dialog-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="dialog-topline">
        <div>
          <p className="eyebrow">{editing ? `EDIT ${kindName.toUpperCase()}` : `NEW ${kindName.toUpperCase()}`}</p>
          <h2 id="item-dialog-title">{editing ? `Edit ${kindName.toLowerCase()}` : `Add a ${kindName.toLowerCase()}`}</h2>
        </div>
        <button className="dialog-close icon-button" type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button>
      </div>
      <form className="editor-form" onSubmit={onSubmit}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label className="field-label" htmlFor="item-title">Title</label>
        <input
          id="item-title"
          type="text"
          value={draft.title}
          autoFocus
          maxLength={200}
          placeholder={editor.kind === "task" ? "What needs doing?" : "What would you like to remember?"}
          required
          disabled={busy}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />

        <label className="field-label field-label-spaced" htmlFor="item-details">Details <span aria-hidden="true">Optional</span></label>
        <textarea
          id="item-details"
          value={draft.details}
          maxLength={10_000}
          placeholder="Add a few notes…"
          rows={4}
          disabled={busy}
          onChange={(event) => setDraft((current) => ({ ...current, details: event.target.value }))}
        />

        <div className="date-time-row">
          <div>
            <label className="field-label" htmlFor="item-date">Date <span aria-hidden="true">Optional</span></label>
            <input
              id="item-date"
              type="date"
              value={draft.scheduledDate}
              disabled={busy}
              onChange={(event) => setDraft((current) => ({
                ...current,
                scheduledDate: event.target.value,
                scheduledTime: event.target.value ? current.scheduledTime : "",
              }))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="item-time">Time <span aria-hidden="true">Optional</span></label>
            <input
              id="item-time"
              type="time"
              value={draft.scheduledTime}
              disabled={busy || !draft.scheduledDate}
              onChange={(event) => setDraft((current) => ({ ...current, scheduledTime: event.target.value }))}
            />
            {!draft.scheduledDate && <span className="time-hint">Choose a date first</span>}
          </div>
        </div>

        <div className="dialog-actions">
          <button className="button button-quiet" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : `Save ${kindName}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DeleteDialog({
  item,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  item: WorkspaceItem;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      className="native-dialog delete-dialog"
      ref={dialogRef}
      aria-labelledby="delete-dialog-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <span className="delete-symbol" aria-hidden="true">⌫</span>
      <p className="eyebrow">REMOVE FROM YOUR SPACE</p>
      <h2 id="delete-dialog-title">Delete this {item.kind}?</h2>
      <p className="delete-copy">
        <strong>{item.title}</strong> will be deleted from your account across all your devices. This can’t be undone.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button button-quiet" type="button" disabled={busy} autoFocus onClick={onClose}>Keep it</button>
        <button className="button button-danger" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </dialog>
  );
}

function EmptyState({ view, onCreate }: { view: View; onCreate: (kind: ItemKind) => void }) {
  if (view === "task") {
    return (
      <div className="empty-state">
        <span className="empty-illustration empty-task" aria-hidden="true"><span>✓</span></span>
        <p className="eyebrow">ONE THING AT A TIME</p>
        <h2>No Tasks on your list yet.</h2>
        <p>Start with one small thing you’d like to get done.</p>
        <button className="button button-primary" type="button" onClick={() => onCreate("task")}>Add your first Task <span aria-hidden="true">→</span></button>
      </div>
    );
  }

  if (view === "event") {
    return (
      <div className="empty-state">
        <span className="empty-illustration empty-event" aria-hidden="true"><span>✳</span></span>
        <p className="eyebrow">A MOMENT TO LOOK FORWARD TO</p>
        <h2>No Events on the horizon.</h2>
        <p>Save a date worth remembering, with as much detail as you need.</p>
        <button className="button button-primary" type="button" onClick={() => onCreate("event")}>Add your first Event <span aria-hidden="true">→</span></button>
      </div>
    );
  }

  return (
    <div className="empty-state empty-agenda">
      <span className="empty-illustration empty-agenda-art" aria-hidden="true">
        <span className="empty-circle empty-circle-one" />
        <span className="empty-circle empty-circle-two" />
        <span className="empty-leaf" />
        <span className="empty-page"><i /><i /><i /></span>
      </span>
      <p className="eyebrow">A FRESH PAGE</p>
      <h2>A clear day is a lovely place to start.</h2>
      <p>Add a Task to make progress, or an Event to keep a moment close.</p>
      <div className="empty-actions">
        <button className="button button-primary" type="button" onClick={() => onCreate("task")}>Add a Task <span aria-hidden="true">→</span></button>
        <button className="button button-secondary" type="button" onClick={() => onCreate("event")}>Plan an Event</button>
      </div>
    </div>
  );
}

export default function Page() {
  const [authStatus, setAuthStatus] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [account, setAccount] = useState<Account | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [view, setView] = useState<View>("agenda");
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [mutation, setMutation] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const identityVersion = useRef(0);
  const itemRequestVersion = useRef(0);
  const signedInRef = useRef(false);
  const mutationLock = useRef(false);
  const signingOutLock = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const newTaskButtonRef = useRef<HTMLButtonElement>(null);
  const isMutating = mutation !== null;

  useEffect(() => {
    setClientReady(true);
    const version = ++identityVersion.current;
    let mounted = true;

    async function checkSession() {
      try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        if (!mounted || identityVersion.current !== version) return;
        if (response.status === 401) {
          signedInRef.current = false;
          setAuthStatus("signed-out");
          setItemsLoading(false);
          return;
        }
        if (!response.ok) {
          setAuthError(await errorFromResponse(response, "Could not check your session. Please sign in."));
          setAuthStatus("signed-out");
          setItemsLoading(false);
          return;
        }
        const result = await response.json() as { user: Account };
        if (!mounted || identityVersion.current !== version) return;
        signedInRef.current = true;
        setAccount(result.user);
        setAuthStatus("signed-in");
        void loadItems(version);
      } catch {
        if (!mounted || identityVersion.current !== version) return;
        setAuthError("Could not reach FileTasks. Please check your connection and sign in.");
        setAuthStatus("signed-out");
        setItemsLoading(false);
      }
    }

    void checkSession();
    return () => {
      mounted = false;
    };
    // Session discovery runs once for this page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadItems(version: number) {
    if (!signedInRef.current || identityVersion.current !== version || mutationLock.current || signingOutLock.current) return;
    const requestVersion = ++itemRequestVersion.current;
    setItemsLoading(true);
    setItemsError(null);
    try {
      const response = await fetch("/api/items", { credentials: "same-origin", cache: "no-store" });
      if (identityVersion.current !== version || itemRequestVersion.current !== requestVersion) return;
      if (response.status === 401) {
        expireSession(version, "Your session has expired. Please sign in again.");
        return;
      }
      if (!response.ok) {
        setItemsError(await errorFromResponse(response, "Could not load your items. Please try again."));
        return;
      }
      const result = await response.json() as { items: WorkspaceItem[] };
      if (identityVersion.current !== version || itemRequestVersion.current !== requestVersion) return;
      setItems(sortItems(result.items));
      setLastUpdated(new Date());
    } catch {
      if (identityVersion.current === version && itemRequestVersion.current === requestVersion) {
        setItemsError("Could not reach FileTasks. Check your connection and refresh.");
      }
    } finally {
      if (identityVersion.current === version && itemRequestVersion.current === requestVersion) {
        setItemsLoading(false);
      }
    }
  }

  function expireSession(version: number, message: string) {
    if (identityVersion.current !== version) return;
    identityVersion.current += 1;
    itemRequestVersion.current += 1;
    signedInRef.current = false;
    setAccount(null);
    setItems([]);
    setItemsError(null);
    setActionError(null);
    setAuthMode("login");
    setAuthError(message);
    setAuthStatus("signed-out");
    setItemsLoading(false);
    setEditor(null);
    setDeleteTarget(null);
  }

  useEffect(() => {
    if (authStatus !== "signed-in") return;
    const version = identityVersion.current;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadItems(version);
    };
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
    };
    // The refresh loop is tied to the authenticated session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authBusy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setAuthError(null);
    setAuthBusy(true);
    try {
      const response = await fetch(`/api/auth/${authMode === "register" ? "register" : "login"}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        setAuthError(await errorFromResponse(response, "Could not sign you in. Please try again."));
        return;
      }
      const result = await response.json() as { user: Account };
      identityVersion.current += 1;
      itemRequestVersion.current += 1;
      const version = identityVersion.current;
      signedInRef.current = true;
      setAccount(result.user);
      setItems([]);
      setItemsError(null);
      setActionError(null);
      setAuthError(null);
      setAuthStatus("signed-in");
      setItemsLoading(true);
      void loadItems(version);
    } catch {
      setAuthError("Could not reach FileTasks. Check your connection and try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    if (signingOutLock.current || mutationLock.current) return;
    signingOutLock.current = true;
    setMutation("signout");
    setActionError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(await errorFromResponse(response, "Could not sign out. Please try again."));
      identityVersion.current += 1;
      itemRequestVersion.current += 1;
      signedInRef.current = false;
      setAccount(null);
      setItems([]);
      setItemsError(null);
      setLastUpdated(null);
      setAuthMode("login");
      setAuthError(null);
      setAuthStatus("signed-out");
      setItemsLoading(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not sign out. Please try again.");
    } finally {
      signingOutLock.current = false;
      setMutation(null);
    }
  }

  function rememberFocus() {
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
  }

  function restoreFocus() {
    window.requestAnimationFrame(() => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
      else newTaskButtonRef.current?.focus();
      restoreFocusRef.current = null;
    });
  }

  function openEditor(kind: ItemKind, item: WorkspaceItem | null = null) {
    rememberFocus();
    setEditorError(null);
    setDraft(item ? {
      title: item.title,
      details: item.details,
      scheduledDate: item.scheduledDate ?? "",
      scheduledTime: item.scheduledTime ?? "",
    } : emptyDraft());
    setEditor({ kind, item });
  }

  function closeEditor() {
    if (mutationLock.current) return;
    setEditor(null);
    setEditorError(null);
    restoreFocus();
  }

  function openDelete(item: WorkspaceItem) {
    rememberFocus();
    setDeleteError(null);
    setDeleteTarget(item);
  }

  function closeDelete() {
    if (mutationLock.current) return;
    setDeleteTarget(null);
    setDeleteError(null);
    restoreFocus();
  }

  function beginMutation(label: string) {
    if (mutationLock.current || !signedInRef.current) return null;
    mutationLock.current = true;
    const version = identityVersion.current;
    itemRequestVersion.current += 1;
    setItemsLoading(false);
    setMutation(label);
    setActionError(null);
    return version;
  }

  function endMutation() {
    mutationLock.current = false;
    setMutation(null);
  }

  function refreshAfterMutation(version: number) {
    window.setTimeout(() => void loadItems(version), 0);
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || mutationLock.current) return;
    if (!draft.title.trim()) {
      setEditorError("Enter a title before saving.");
      return;
    }
    const version = beginMutation(editor.item ? "save" : "create");
    if (version === null) return;
    setEditorError(null);
    const input: ItemInput = {
      kind: editor.kind,
      title: draft.title.trim(),
      details: draft.details,
      scheduledDate: draft.scheduledDate || null,
      scheduledTime: draft.scheduledDate ? (draft.scheduledTime || null) : null,
    };
    try {
      const response = await fetch(editor.item ? `/api/items/${encodeURIComponent(editor.item.id)}` : "/api/items", {
        method: editor.item ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (identityVersion.current !== version) return;
      if (response.status === 401) {
        expireSession(version, "Your session has expired. Please sign in again.");
        return;
      }
      if (!response.ok) {
        setEditorError(await errorFromResponse(response, "Could not save this item. Please try again."));
        refreshAfterMutation(version);
        return;
      }
      const result = await response.json() as { item: WorkspaceItem };
      if (identityVersion.current !== version) return;
      setItems((current) => sortItems([
        ...current.filter((item) => item.id !== result.item.id),
        result.item,
      ]));
      setLastUpdated(new Date());
      setEditor(null);
      setEditorError(null);
      restoreFocus();
    } catch {
      if (identityVersion.current === version) {
        setEditorError("Could not reach FileTasks. Your changes are still here; try saving again.");
        refreshAfterMutation(version);
      }
    } finally {
      endMutation();
    }
  }

  async function toggleTask(item: WorkspaceItem) {
    const version = beginMutation(`toggle:${item.id}`);
    if (version === null) return;
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: item.completed !== true }),
      });
      if (identityVersion.current !== version) return;
      if (response.status === 401) {
        expireSession(version, "Your session has expired. Please sign in again.");
        return;
      }
      if (!response.ok) throw new Error(await errorFromResponse(response, "Could not update this Task."));
      const result = await response.json() as { item: WorkspaceItem };
      if (identityVersion.current !== version) return;
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? result.item : currentItem));
      setLastUpdated(new Date());
    } catch (error) {
      if (identityVersion.current === version) {
        setActionError(error instanceof Error ? error.message : "Could not update this Task.");
        refreshAfterMutation(version);
      }
    } finally {
      endMutation();
    }
  }

  async function deleteItem() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const version = beginMutation(`delete:${target.id}`);
    if (version === null) return;
    setDeleteError(null);
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (identityVersion.current !== version) return;
      if (response.status === 401) {
        expireSession(version, "Your session has expired. Please sign in again.");
        return;
      }
      if (!response.ok) {
        setDeleteError(await errorFromResponse(response, "Could not delete this item. Please try again."));
        refreshAfterMutation(version);
        return;
      }
      setItems((current) => current.filter((item) => item.id !== target.id));
      setLastUpdated(new Date());
      setDeleteTarget(null);
      setDeleteError(null);
      restoreFocus();
    } catch {
      if (identityVersion.current === version) {
        setDeleteError("Could not reach FileTasks. Please try again.");
        refreshAfterMutation(version);
      }
    } finally {
      endMutation();
    }
  }

  const visibleItems = useMemo(
    () => sortItems(items.filter((item) => view === "agenda" || item.kind === view)),
    [items, view],
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, WorkspaceItem[]>();
    for (const item of visibleItems) {
      const key = item.scheduledDate ?? "__undated__";
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return [...grouped.entries()].map(([key, groupedItems]) => ({
      key: key === "__undated__" ? null : key,
      items: groupedItems,
    }));
  }, [visibleItems]);
  const taskCount = items.filter((item) => item.kind === "task").length;
  const eventCount = items.filter((item) => item.kind === "event").length;
  const openTaskCount = items.filter((item) => item.kind === "task" && item.completed !== true).length;
  const completedTaskCount = taskCount - openTaskCount;

  if (authStatus === "checking") {
    return (
      <main className="auth-loading" aria-label="Loading FileTasks">
        <BrandMark />
        <span>Opening your space…</span>
      </main>
    );
  }

  if (authStatus === "signed-out") {
    return (
      <AuthScreen
        mode={authMode}
        onModeChange={(nextMode) => {
          setAuthMode(nextMode);
          setAuthError(null);
        }}
        onSubmit={handleAuthSubmit}
        busy={authBusy}
        error={authError}
      />
    );
  }

  return (
    <main className="workspace-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-top">
          <div className="brand">
            <BrandMark />
            <span>FileTasks</span>
          </div>
          <div className="sidebar-section-label">YOUR SPACE</div>
          <nav className="sidebar-nav" aria-label="Your space">
            {(["agenda", "task", "event"] as const).map((name) => {
              const count = name === "agenda" ? items.length : name === "task" ? taskCount : eventCount;
              const label = name === "agenda" ? "Agenda" : name === "task" ? "Tasks" : "Events";
              return (
                <button
                  className={`side-link${view === name ? " side-link-active" : ""}`}
                  type="button"
                  key={name}
                  aria-current={view === name ? "page" : undefined}
                  aria-label={label}
                  onClick={() => setView(name)}
                >
                  <NavIcon name={name} />
                  <span>{label}</span>
                  <span className="side-count">{count}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="account-avatar" aria-hidden="true">{account?.email.slice(0, 1).toUpperCase() ?? "F"}</div>
          <div className="account-copy">
            <span className="account-label">SIGNED IN AS</span>
            <span className="account-email" title={account?.email}>{account?.email}</span>
          </div>
          <button
            className="signout-button"
            type="button"
            onClick={handleSignOut}
            disabled={isMutating}
            aria-label="Sign out"
            title="Sign out"
          >
            {isMutating && mutation === "signout" ? <span className="button-spinner" aria-hidden="true" /> : (
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4H4.5A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16H8M11 6l4 4-4 4m4-4H7" /></svg>
            )}
          </button>
        </div>
      </aside>

      <section className="main-content" aria-label="Personal agenda">
        <div className="content-inner">
          <header className="page-header">
            <div className="page-heading">
              <p className="eyebrow">{clientReady ? formatToday() : "YOUR PERSONAL SPACE"}</p>
              <h1>Your agenda<span>.</span></h1>
              <p className="page-subtitle">
                {openTaskCount} {openTaskCount === 1 ? "Task" : "Tasks"} to do
                <span className="subtitle-divider">·</span>
                {eventCount} {eventCount === 1 ? "Event" : "Events"} to look forward to
                {completedTaskCount > 0 && <span className="completed-summary"> · {completedTaskCount} completed</span>}
              </p>
            </div>
            <div className="header-actions">
              <button
                className="button button-primary"
                type="button"
                ref={newTaskButtonRef}
                disabled={isMutating}
                aria-label="New Task"
                onClick={() => openEditor("task")}
              >
                <span className="plus-icon" aria-hidden="true">+</span> New Task
              </button>
              <button className="button button-secondary" type="button" aria-label="New Event" disabled={isMutating} onClick={() => openEditor("event")}>
                <span className="plus-icon" aria-hidden="true">+</span> New Event
              </button>
            </div>
          </header>

          <div className="list-toolbar">
            <div className="view-heading">
              <h2>{view === "agenda" ? "Coming up" : view === "task" ? "Your Tasks" : "Your Events"}</h2>
              <span className="visible-count">{visibleItems.length}</span>
            </div>
            <div className="toolbar-right">
              {lastUpdated && <span className="sync-status"><span className="sync-dot" />Synced {lastUpdated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
              <button
                className="refresh-button"
                type="button"
                onClick={() => void loadItems(identityVersion.current)}
                disabled={itemsLoading || isMutating}
              >
                <svg className={itemsLoading ? "refresh-icon refresh-icon-spinning" : "refresh-icon"} viewBox="0 0 20 20" aria-hidden="true"><path d="M16.6 8A6.8 6.8 0 0 0 4 5.3L2.8 6.5M3.1 3.5v3.2h3.2M3.4 12A6.8 6.8 0 0 0 16 14.7l1.2-1.2m-.3 3v-3.2h-3.2" /></svg>
                {itemsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {actionError && (
            <div className="notice notice-error" role="alert">
              <span>{actionError}</span>
              <button type="button" aria-label="Dismiss message" onClick={() => setActionError(null)}>×</button>
            </div>
          )}
          {itemsError && (
            <div className="notice notice-error" role="alert">
              <span>{itemsError}</span>
              <button type="button" aria-label="Dismiss message" onClick={() => setItemsError(null)}>×</button>
            </div>
          )}

          {itemsLoading && items.length === 0 ? (
            <div className="list-loading" role="status"><span className="loading-mark" />Loading your agenda…</div>
          ) : visibleItems.length === 0 ? (
            <EmptyState view={view} onCreate={openEditor} />
          ) : (
            <div className="agenda-groups">
              {groups.map((group) => (
                <section className="agenda-group" key={group.key ?? "undated"} aria-labelledby={`group-${group.key ?? "undated"}`}>
                  <div className="group-heading">
                    <h2 id={`group-${group.key ?? "undated"}`}>
                      {group.key ? groupDateLabel(group.key, clientReady) : "Whenever it fits"}
                    </h2>
                    <span>{group.items.length} {group.items.length === 1 ? "item" : "items"}</span>
                  </div>
                  <div className="item-list">
                    {group.items.map((item) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        disabled={isMutating || itemsLoading}
                        onToggle={toggleTask}
                        onEdit={(selected) => openEditor(selected.kind, selected)}
                        onDelete={openDelete}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          <footer className="page-footer">
            <span>One step, one moment at a time.</span>
            <span className="footer-leaf" aria-hidden="true">✳</span>
          </footer>
        </div>
      </section>

      {editor && (
        <ItemDialog
          editor={editor}
          draft={draft}
          setDraft={setDraft}
          error={editorError}
          busy={mutation === "save" || mutation === "create"}
          onClose={closeEditor}
          onSubmit={saveDraft}
        />
      )}
      {deleteTarget && (
        <DeleteDialog
          item={deleteTarget}
          busy={mutation === `delete:${deleteTarget.id}`}
          error={deleteError}
          onClose={closeDelete}
          onConfirm={deleteItem}
        />
      )}
    </main>
  );
}
