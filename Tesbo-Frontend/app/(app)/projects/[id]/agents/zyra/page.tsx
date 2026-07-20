"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronRight, IconClipboardCheck, IconCopy, IconPlus, IconSettings, IconSparkles } from "@tabler/icons-react";
import {
  authMe,
  createZyraChatSession,
  getProject,
  getZyraAgent,
  getZyraChatSession,
  listZyraChatSessions,
  sendZyraChatMessage,
  stopZyraChatPlan,
  resumeZyraChatPlan,
  type ZyraAgentState,
  type ZyraChatMessage,
  type ZyraChatSession,
  type ZyraChatTestcaseRow,
} from "@/lib/api";
import { Button, StatusChip, Textarea } from "@/components/ui";
import { useTopBarSlots } from "@/components/TopBarSlots";

// ─── Zyra icon badge — gradient sparkle mark used in the header and per-message ──
function ZyraMark({ size = 24 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[7px]"
      style={{ width: size, height: size, background: "linear-gradient(135deg, #7C5FCC 0%, #4F46E5 100%)" }}
    >
      <IconSparkles size={Math.round(size * 0.58)} stroke={1.9} className="text-white" />
    </div>
  );
}

// ─── Quick actions shown on empty chat ───────────────────────────────────────
const QUICK_ACTIONS = [
  { label: "Generate smoke tests", prompt: "Generate smoke test cases covering the most critical user flows in this project." },
  { label: "Find coverage gaps", prompt: "Analyze existing test cases and identify the most important areas of missing coverage." },
  { label: "Add negative scenarios", prompt: "Add negative test cases for the main features, focusing on invalid inputs and error states." },
  { label: "Improve expected results", prompt: "Review existing test cases and rewrite any weak or vague expected results to be more specific." },
  { label: "Regression test cases", prompt: "Generate a regression test suite that covers the core product functionality." },
  { label: "Review this module", prompt: "Review all test cases in this project and identify duplicates, outdated cases, and weak coverage." },
  { label: "Edge cases", prompt: "Create edge case test scenarios covering boundary values, empty states, and unexpected inputs." },
  { label: "API test cases", prompt: "Generate API test cases for the main endpoints covering success, error, and boundary scenarios." },
];

// ─── Markdown renderer ────────────────────────────────────────────────────────
function mdInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function mdTable(lines: string[]): string {
  const isSep = (l: string) => /^\|[\s\-:|]+\|$/.test(l.trim());
  const cells = (l: string) => l.trim().replace(/(?:^\|)|(?:\|$)/g, "").split("|").map(c => c.trim());
  const data = lines.filter(l => !isSep(l));
  if (!data.length) return "";
  const [hdr, ...rows] = data;
  const thead = `<thead><tr>${cells(hdr).map(h => `<th>${mdInline(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(r => `<tr>${cells(r).map(c => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="zyra-md-table-wrap"><table class="zyra-md-table">${thead}${tbody}</table></div>`;
}

function renderMarkdown(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc(text).split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^### /.test(t)) { out.push(`<h3>${mdInline(t.slice(4))}</h3>`); i++; continue; }
    if (/^## /.test(t)) { out.push(`<h2>${mdInline(t.slice(3))}</h2>`); i++; continue; }
    if (/^# /.test(t)) { out.push(`<h1>${mdInline(t.slice(2))}</h1>`); i++; continue; }
    if (/^---+$/.test(t)) { out.push("<hr/>"); i++; continue; }
    if (t.startsWith("|")) {
      const tbl: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { tbl.push(lines[i]); i++; }
      out.push(mdTable(tbl));
      continue;
    }
    if (/^[-*] /.test(t) || /^\d+\. /.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        if (/^[-*] /.test(l)) { items.push(`<li>${mdInline(l.slice(2))}</li>`); i++; }
        else if (/^\d+\. /.test(l)) { items.push(`<li>${mdInline(l.replace(/^\d+\. /, ""))}</li>`); i++; }
        else break;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (t === "") { out.push("<br/>"); i++; continue; }
    out.push(`<p>${mdInline(t)}</p>`);
    i++;
  }
  return out.join("");
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatTime(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function firstStepPreview(value: unknown): string {
  if (!value) return "—";
  if (Array.isArray(value)) {
    const first = value[0];
    if (!first) return "—";
    if (typeof first === "string") return first;
    const n = first.step ?? 1;
    const text = first.action || first.expected || "";
    return text ? `${n} → ${text}` : "—";
  }
  if (typeof value !== "string") return "—";
  try { return firstStepPreview(JSON.parse(value)); } catch { return "—"; }
}

// ─── Tone maps — mirror RepositoryTestCaseTable's priority/status conventions ──
function priorityTone(priority?: string) {
  if (priority === "P0") return "error" as const;
  if (priority === "P1") return "warning" as const;
  if (priority === "P2") return "confidenceHigh" as const;
  return "neutral" as const;
}

function statusTone(status?: string) {
  if (status === "Approved") return "success" as const;
  if (status === "In Review") return "warning" as const;
  if (status === "Deprecated" || status === "Archived") return "error" as const;
  return "brand" as const;
}

function actionColor(action?: string): string {
  if (action === "archived") return "text-[var(--status-fail-text)]";
  if (action === "updated") return "text-[var(--info-foreground)]";
  if (action === "created") return "text-[var(--success-foreground)]";
  return "text-[var(--muted)]";
}

function summarizeTestcaseActions(rows: ZyraChatTestcaseRow[]): string | null {
  if (!rows.length) return null;
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.action || "suggested";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const verb = counts.created ? "generated" : counts.updated ? "updated" : counts.archived ? "archived" : "suggested";
  return `${rows.length} test case${rows.length === 1 ? "" : "s"} ${verb}`;
}

// ─── TestcaseTable ────────────────────────────────────────────────────────────
function TestcaseTable({ rows }: { rows: ZyraChatTestcaseRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[var(--border)] text-sm">
          <thead className="bg-[var(--background)]">
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">First step</th>
              <th className="px-3 py-2">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {rows.map((row, i) => (
              <tr key={`${row.id || row.externalId || row.title}-${i}`} className="align-top hover:bg-[var(--surface-secondary)] transition-colors">
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] text-[var(--muted)]">{row.externalId || "—"}</span>
                    <StatusChip tone="info" className="w-fit !rounded-full !px-1.5 !py-0 !text-[10px] !font-medium">
                      {row.type || "Functional"}
                    </StatusChip>
                  </div>
                </td>
                <td className="max-w-[280px] px-3 py-3 text-[12px] leading-snug text-[var(--foreground)]">{row.title}</td>
                <td className="px-3 py-3">
                  <StatusChip tone={priorityTone(row.priority)} className="!rounded-[5px] !px-[7px] !py-[2px] !font-mono !text-[11px] !font-semibold">
                    {row.priority || "P2"}
                  </StatusChip>
                </td>
                <td className="px-3 py-3">
                  <StatusChip tone={statusTone(row.status)} className="!px-[9px] !py-[2px] !text-[11px] !font-medium">
                    {row.status || "Draft"}
                  </StatusChip>
                </td>
                <td className="max-w-[220px] px-3 py-3 text-[11px] leading-snug text-[var(--muted)]">
                  <div className="line-clamp-2">{firstStepPreview(row.stepsJson)}</div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span className={`text-[11px] font-semibold capitalize ${actionColor(row.action)}`}>
                      {row.action || "suggested"}
                    </span>
                    <span className="text-[10px] text-[var(--muted)]">AI · Zyra chat</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── resolveContent ───────────────────────────────────────────────────────────
// message.content may be a raw JSON blob from the AI when the backend fallback
// stored the full structured response as-is. Extract reply + testcases from it.
function resolveContent(message: ZyraChatMessage): { text: string; testcases: ZyraChatTestcaseRow[]; reasoning: string | null } {
  let text = message.content ?? "";
  let testcases: ZyraChatTestcaseRow[] = message.testcases ?? [];
  let reasoning = message.reasoningSummary ?? null;

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (typeof parsed.reply === "string" && parsed.reply) text = parsed.reply;
        if (!reasoning && typeof parsed.reasoningSummary === "string" && parsed.reasoningSummary) {
          reasoning = parsed.reasoningSummary;
        }
        if (Array.isArray(parsed.testcases) && parsed.testcases.length > 0 && testcases.length === 0) {
          testcases = parsed.testcases as ZyraChatTestcaseRow[];
        }
      }
    } catch {
      // Not JSON — use content as-is
    }
  }

  return { text, testcases, reasoning };
}

// ─── MessageBubble ────────────────────────────────────────────────────────────
function MessageBubble({ message, projectId }: { message: ZyraChatMessage; projectId: string }) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const { text, testcases, reasoning } = isUser ? { text: message.content, testcases: [], reasoning: null } : resolveContent(message);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (isUser) {
    return (
      <article className="flex justify-end">
        <div className="flex max-w-[70%] flex-col items-end gap-1">
          <div className="rounded-[10px] border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--foreground)]">
            <div className="whitespace-pre-wrap">{text}</div>
          </div>
          <time className="px-1 font-mono text-[10px] text-[var(--muted)]">{formatTime(message.createdAt)}</time>
        </div>
      </article>
    );
  }

  const metaLabel = summarizeTestcaseActions(testcases);

  return (
    <article className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <ZyraMark size={24} />
        <span className="text-xs font-semibold text-[var(--foreground)]">Zyra</span>
        {metaLabel && <span className="text-[11px] text-[var(--muted)]">{metaLabel}</span>}
      </div>

      {reasoning && (
        <details className="w-full max-w-[720px]">
          <summary className="cursor-pointer text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] select-none">
            Zyra reasoning
          </summary>
          <div className="mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted)]">
            {reasoning}
          </div>
        </details>
      )}

      <div
        className="zyra-prose max-w-[720px] text-[13px] leading-[1.7] text-[var(--muted)]"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />

      <TestcaseTable rows={testcases} />

      <div className="flex items-center gap-2">
        {testcases.length > 0 && (
          <Link
            href={`/projects/${projectId}/testcases`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] font-medium text-[var(--muted)] hover:border-[var(--brand-border)] hover:text-[var(--foreground)]"
          >
            <IconClipboardCheck size={13} stroke={1.9} />
            View test cases
          </Link>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] font-medium text-[var(--muted)] hover:border-[var(--brand-border)] hover:text-[var(--foreground)]"
        >
          <IconCopy size={13} stroke={1.9} />
          {copied ? "Copied" : "Copy"}
        </button>
        <time className="ml-auto font-mono text-[10px] text-[var(--muted)]">{formatTime(message.createdAt)}</time>
      </div>
    </article>
  );
}

// ─── ThinkingBubble ───────────────────────────────────────────────────────────
function ThinkingBubble() {
  return (
    <div className="flex items-center gap-2">
      <ZyraMark size={24} />
      <div className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

// ─── PlanProgressBubble ───────────────────────────────────────────────────────
function PlanProgressBubble({ plan }: { plan: { doneCount: number; totalCount: number } }) {
  const pct = plan.totalCount > 0 ? Math.round((plan.doneCount / plan.totalCount) * 100) : 0;
  return (
    <div className="flex items-start gap-2">
      <ZyraMark size={24} />
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-xs text-[var(--muted)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-primary)] animate-pulse" />
        Generating remaining scenarios — {plan.doneCount}/{plan.totalCount} covered ({pct}%). Review what&apos;s in so far; more will appear here shortly.
      </div>
    </div>
  );
}

// ─── NoKeyBanner ─────────────────────────────────────────────────────────────
function NoKeyBanner({ projectId }: { projectId: string }) {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-center">
      <div className="text-2xl mb-2">⚡</div>
      <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">AI provider not connected</h3>
      <p className="mt-2 text-xs text-amber-700/80 dark:text-amber-400/80">
        Zyra needs an Anthropic or OpenAI key allocated to this project before it can respond.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <Link href="/settings?tab=ai" className="inline-flex items-center justify-center gap-1 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700">
          Set up AI key
        </Link>
        <Link href={`/projects/${projectId}/agents/zyra/settings`} className="text-xs text-amber-700/70 hover:underline dark:text-amber-400/70">
          Check Zyra settings
        </Link>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ZyraChatPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  // Take over the shared TopBar with this page's breadcrumb + actions (portaled below),
  // matching the full-bleed IDE-workspace pattern used by the Test Cases / Plan Details screens.
  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  const [projectName, setProjectName] = useState("");
  const [agent, setAgent] = useState<ZyraAgentState | null>(null);
  const [sessions, setSessions] = useState<ZyraChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ZyraChatSession | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stoppingPlan, setStoppingPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messages = useMemo(() => activeSession?.messages || [], [activeSession]);

  const refreshSessions = useCallback(async () => {
    const data = await listZyraChatSessions(projectId);
    setSessions(data.list);
    return data.list;
  }, [projectId]);

  const openSession = useCallback(async (sessionId: string) => {
    const session = await getZyraChatSession(projectId, sessionId);
    setActiveSession(session);
  }, [projectId]);

  const createSession = useCallback(async () => {
    const session = await createZyraChatSession(projectId);
    setSessions((prev) => [session, ...prev]);
    setActiveSession(session);
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [projectId]);

  const loadData = useCallback(async () => {
    try {
      const [project, agentData, sessionData] = await Promise.all([
        getProject(projectId),
        getZyraAgent(projectId),
        refreshSessions(),
      ]);
      setProjectName(String(project.name || ""));
      setAgent(agentData);
      if (sessionData[0]) await openSession(sessionData[0].id);
      else await createSession();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Zyra chat.");
    } finally {
      setLoading(false);
    }
  }, [createSession, openSession, projectId, refreshSessions]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) router.replace("/login");
      else void loadData();
    });
  }, [loadData, router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  // While Zyra is actively working through a batched "all possible cases" plan, poll for
  // the new chat messages it posts as each batch finishes — they arrive without the user
  // sending anything, so the normal send/response cycle never picks them up on its own.
  // A paused plan isn't running, so there's nothing new to poll for until it's resumed.
  const isPlanRunning = activeSession?.activePlan?.status === "running";
  const activeSessionId = activeSession?.id;
  useEffect(() => {
    if (!isPlanRunning || !activeSessionId) return;
    const interval = setInterval(() => {
      getZyraChatSession(projectId, activeSessionId)
        .then((fresh) => {
          setActiveSession((prev) => (prev && prev.id === activeSessionId ? fresh : prev));
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(interval);
  }, [isPlanRunning, activeSessionId, projectId]);

  async function submitMessage(text: string) {
    if (!activeSession || !text.trim() || sending) return;
    const trimmed = text.trim();
    setInput("");
    setSending(true);
    setError(null);
    const optimistic: ZyraChatMessage = {
      id: `local-${Date.now()}`,
      sessionId: activeSession.id,
      projectId,
      userId: null,
      role: "user",
      content: trimmed,
      reasoningSummary: null,
      actionType: null,
      status: "sent",
      testcases: [],
      activity: [],
      createdAt: new Date().toISOString(),
    };
    setActiveSession((prev) => prev ? { ...prev, messages: [...(prev.messages || []), optimistic] } : prev);
    try {
      const result = await sendZyraChatMessage(projectId, activeSession.id, trimmed);
      setActiveSession(result.session);
      void refreshSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Zyra could not answer.";
      setError(msg);
      setActiveSession((prev) => prev ? { ...prev, messages: (prev.messages || []).filter((m) => m.id !== optimistic.id) } : prev);
    } finally {
      setSending(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submitMessage(input);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage(input);
    }
  }

  function onQuickAction(prompt: string) {
    setInput(prompt);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function handleStopPlan() {
    if (!activeSession || stoppingPlan) return;
    setStoppingPlan(true);
    try {
      const session = await stopZyraChatPlan(projectId, activeSession.id);
      setActiveSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop Zyra.");
    } finally {
      setStoppingPlan(false);
    }
  }

  async function handleResumePlan() {
    if (!activeSession || stoppingPlan) return;
    setStoppingPlan(true);
    try {
      const session = await resumeZyraChatPlan(projectId, activeSession.id);
      setActiveSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume Zyra.");
    } finally {
      setStoppingPlan(false);
    }
  }

  return (
    // Full-bleed, full-height IDE-style workspace — same pattern as the Test Cases / Plan
    // Details screens. `tc-fullbleed` makes the wrapping .tesbo-page drop its centered
    // 1280px cap + padding, so this fills the whole content region below the 3.5rem TopBar.
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* This page takes over the shared TopBar: breadcrumb (start slot) + actions (end slot). */}
        {topBarStartEl &&
          createPortal(
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push("/projects")}
                    className="truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--brand-primary)]"
                  >
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <span className="font-medium text-[var(--brand-primary)]">Zyra</span>
            </nav>,
            topBarStartEl,
          )}
        {topBarEndEl &&
          createPortal(
            <div className="flex flex-wrap items-center gap-2">
              {agent && (
                <StatusChip tone={agent.agent.active ? "success" : "warning"} dot>
                  {agent.agent.active ? "AI connected" : "No AI key"}
                </StatusChip>
              )}
              <Link href={`/projects/${projectId}/agents/tasks`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">
                <IconClipboardCheck size={15} stroke={1.9} />
                Task board
              </Link>
              <Link href={`/projects/${projectId}/agents/zyra/settings`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">
                <IconSettings size={15} stroke={1.9} />
                Settings
              </Link>
            </div>,
            topBarEndEl,
          )}

        {/* Title + subtitle row */}
        <div className="mb-3 flex shrink-0 items-center gap-2.5 pl-4">
          <ZyraMark size={28} />
          <div>
            <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">Zyra</h1>
            <p className="mt-[1px] text-[13px] text-[var(--muted-soft)]">
              AI test case assistant — generate, update, and manage test cases through conversation.
            </p>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="ml-4 mb-3 shrink-0 rounded-xl border border-[var(--error)]/40 bg-[var(--error-soft)] px-4 py-3 text-sm text-[var(--error)] flex items-start justify-between gap-3">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="shrink-0 text-[var(--error)]/60 hover:text-[var(--error)]">✕</button>
          </div>
        )}

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">
            <div className="text-center space-y-2">
              <div className="h-8 w-8 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin mx-auto" />
              <p className="text-sm text-[var(--muted)]">Loading Zyra...</p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">

            {/* ── Session sidebar ─────────────────────────────────────────── */}
            <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              {/* Sidebar header */}
              <div className="shrink-0 flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">Conversations</p>
                  <p className="text-[11px] text-[var(--muted)]">
                    {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => void createSession()}>
                  <IconPlus size={13} stroke={2} />
                  New
                </Button>
              </div>

              {/* Session list — scrollable */}
              <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {sessions.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-[var(--muted)]">No conversations yet</p>
                )}
                {sessions.map((session) => {
                  const isActive = activeSession?.id === session.id;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => void openSession(session.id)}
                      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        isActive
                          ? "border-[var(--brand-border)] bg-[var(--surface-secondary)]"
                          : "border-transparent hover:bg-[var(--surface-secondary)]"
                      }`}
                    >
                      <span className={`block truncate text-[12px] font-medium ${isActive ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                        {session.title}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-[var(--muted-soft)]">
                        {formatTime(session.updatedAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* ── Chat area ───────────────────────────────────────────────── */}
            <section className="flex flex-1 min-w-0 flex-col bg-[var(--surface-secondary)] overflow-hidden">
              {/* Chat header — fixed */}
              <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
                <p className="text-sm font-semibold text-[var(--foreground)]">{activeSession?.title || "Zyra"}</p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  {agent?.aiKey ? (
                    <>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">{agent.aiKey.provider}</span>
                      <span className="text-[var(--border)]">·</span>
                      <span className="font-mono text-[11px] text-[var(--muted)]">{agent.aiKey.defaultModel || "default model"}</span>
                    </>
                  ) : (
                    <span className="text-xs text-[var(--muted)]">No AI key connected</span>
                  )}
                </p>
              </div>

              {/* Messages — scrollable */}
              <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
                {!messages.length && (
                  <div className="flex h-full flex-col items-center justify-center gap-6 py-8">
                    {!agent?.agent.active ? (
                      <NoKeyBanner projectId={projectId} />
                    ) : (
                      <>
                        <div className="text-center max-w-md">
                          <div className="mx-auto mb-3 h-12 w-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-xl font-bold text-white">Z</div>
                          <h3 className="text-base font-semibold text-[var(--foreground)]">How can I help?</h3>
                          <p className="mt-1 text-sm text-[var(--muted)]">
                            Generate test cases, find coverage gaps, update existing tests, or review your test suite — all through conversation.
                          </p>
                        </div>
                        <div className="w-full max-w-2xl">
                          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Quick actions</p>
                          <div className="flex flex-wrap gap-2">
                            {QUICK_ACTIONS.map((action) => (
                              <button
                                key={action.label}
                                type="button"
                                onClick={() => onQuickAction(action.prompt)}
                                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-xs font-medium text-[var(--foreground)] transition-all hover:border-[var(--brand-primary)] hover:shadow-sm active:scale-95"
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {messages.map((msg) => <MessageBubble key={msg.id} message={msg} projectId={projectId} />)}
                {sending && <ThinkingBubble />}
                {!sending && isPlanRunning && activeSession?.activePlan && <PlanProgressBubble plan={activeSession.activePlan} />}
                <div ref={endRef} />
              </div>

              {/* Input — fixed at bottom */}
              <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                {activeSession?.activePlan?.status === "paused" && (
                  <div className="mb-2.5 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <span>
                      Paused — {activeSession.activePlan.doneCount}/{activeSession.activePlan.totalCount} scenarios covered.
                    </span>
                    <Button type="button" size="sm" variant="secondary" onClick={handleResumePlan} disabled={stoppingPlan}>
                      {stoppingPlan ? "Resuming…" : "Resume"}
                    </Button>
                  </div>
                )}
                <form onSubmit={onSubmit}>
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    rows={3}
                    placeholder={
                      agent?.agent.active
                        ? "Ask Zyra to generate, update, or review test cases..."
                        : "Connect an AI key to start chatting with Zyra"
                    }
                    disabled={sending || !agent?.agent.active}
                    className="resize-none"
                  />
                  <div className="mt-2.5 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-[var(--muted)]">
                      <kbd className="rounded border border-[var(--border)] bg-[var(--surface-secondary)] px-1 py-0.5 font-mono text-[10px]">Enter</kbd>{" "}send
                      {" · "}
                      <kbd className="rounded border border-[var(--border)] bg-[var(--surface-secondary)] px-1 py-0.5 font-mono text-[10px]">Shift+Enter</kbd>{" "}new line
                    </p>
                    <div className="flex items-center gap-2">
                      {isPlanRunning && (
                        <Button type="button" size="sm" variant="secondary" onClick={handleStopPlan} disabled={stoppingPlan}>
                          {stoppingPlan ? "Stopping…" : "Stop"}
                        </Button>
                      )}
                      <Button type="submit" size="sm" disabled={!input.trim() || sending || !agent?.agent.active}>
                        {sending ? "Thinking..." : "Send"}
                      </Button>
                    </div>
                  </div>
                </form>
              </div>
            </section>
          </div>
        )}
      </div>

      {/* Inline styles for markdown prose */}
      <style>{`
        .zyra-prose strong { font-weight: 600; }
        .zyra-prose em { font-style: italic; }
        .zyra-prose .inline-code {
          font-family: ui-monospace, monospace;
          font-size: 0.8em;
          background: var(--surface-secondary);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 1px 4px;
        }
        .zyra-prose ul {
          list-style: disc;
          padding-left: 1.25rem;
          margin: 0.5rem 0;
        }
        .zyra-prose li { margin: 0.2rem 0; }
      `}</style>
    </main>
  );
}
