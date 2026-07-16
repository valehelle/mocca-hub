import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { marked } from 'marked';
import { Agent } from './agents';

marked.setOptions({ gfm: true, breaks: true });
const md = (text: string) => marked.parse(text, { async: false }) as string;

// An agent can render richer-than-chat HTML on the Canvas by ending a message
// with `[CANVAS: output/foo.html]` (legacy `[APP: …]` / `[VIEW: …]` still work).
const VIEW_RE = /\[(?:CANVAS|APP|VIEW):\s*([^\]]+?)\s*\]/i;

// The `window.mocca` bridge is injected server-side into every view (see
// VIEW_BRIDGE_JS in main.ts) so it arrives on the view's own loopback origin.

type LogLine = {
  role: 'you' | 'agent' | 'system' | 'tool' | 'thinking';
  text: string;
  seconds?: number; // thinking duration, attached when a 'thinking' line ends
  streaming?: boolean; // true while tokens are still arriving for this line
};
type WsFile = {
  name: string;
  rel: string;
  path: string;
  size: number;
  isDir: boolean;
};
type ThreadMeta = { id: string; title: string; updatedAt: number };
type Schedule = {
  id: string;
  prompt: string;
  kind: 'daily' | 'interval';
  time?: string;
  minutes?: number;
  enabled: boolean;
  threadId: string;
  lastRunAt?: number;
  nextRunAt: number;
};

function timeUntil(ts: number): string {
  const s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}
// Utilization clamped to a whole 0–100 percent.
function pct(u: number): number {
  return Math.max(0, Math.min(100, Math.round(u)));
}
// "Resets in 3 hr 53 min" — relative, for the rolling session window.
function resetsIn(ms: number | null): string {
  if (!ms) return '';
  const s = Math.floor((ms - Date.now()) / 1000);
  if (s <= 0) return 'Resets now';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `Resets in ${d} day${d === 1 ? '' : 's'}`;
  }
  if (h > 0) return `Resets in ${h} hr ${m} min`;
  return `Resets in ${m} min`;
}
// "Resets Wed 8:00 PM" — absolute weekday + time, for weekly windows.
function resetsAt(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Resets ${day} ${time}`;
}
// A humanized plan name: "max" → "Max", "Claude Max" as-is.
function prettyPlan(p: string | null): string {
  if (!p) return '';
  if (/claude/i.test(p)) return p;
  return p.charAt(0).toUpperCase() + p.slice(1);
}
// One usage window: name + % on a row, a utilization bar, and a sub-line.
function UsageWindow({ w, sub }: { w: LimitWindow; sub: string }) {
  const p = pct(w.utilization);
  return (
    <div className="usage__win">
      <div className="usage__row">
        <span className="usage__name">{w.label}</span>
        <span className="usage__pct">{p}% used</span>
      </div>
      <div className="usage__bar">
        <span
          className={p >= 90 ? 'is-over' : p >= 75 ? 'is-warn' : ''}
          style={{ width: `${p}%` }}
        />
      </div>
      {sub && <div className="usage__sub">{sub}</div>}
    </div>
  );
}
type McpEntry = {
  name: string;
  description?: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType?: 'oauth' | 'key' | 'none';
  authHeader?: string;
  needsAuth?: boolean;
  authNote?: string;
  bundled?: boolean; // shipped by the plugin's own .mcp.json
  disabled?: boolean; // bundled server the user switched off
};
type FileView = {
  kind: string;
  name: string;
  content?: string;
  dataUrl?: string;
  message?: string;
  path: string;
};
type View = 'run' | 'marketplace';
type AuthStatus = {
  ok: boolean;
  method: 'apikey' | 'oauth' | 'none';
  canUseSubscription: boolean; // true only in an unpackaged source build
};
type LimitWindow = {
  label: string;
  utilization: number;
  resetsAt: number | null;
};
type UsageSnapshot = {
  plan: string | null;
  email?: string;
  available: boolean;
  session: LimitWindow | null;
  weeklyAll: LimitWindow | null;
  weeklyModels: LimitWindow[];
  updatedAt: number;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function timeAgo(ts: number): string {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type Action = {
  label: string;
  message: string;
  kind?: 'file' | 'input';
};

// The agent appends suggested next actions in an [ACTIONS]…[/ACTIONS] block,
// one per line as `Label | message | kind`. We strip that from the visible text
// and turn each line into a button.
function splitActions(text: string): { body: string; actions: Action[] } {
  // These markers drive the panel / audio bar; strip them from the message.
  text = text.replace(VIEW_RE, '').trimEnd();
  const start = text.indexOf('[ACTIONS]');
  if (start === -1) return { body: text, actions: [] };
  const body = text.slice(0, start).trimEnd();
  const end = text.indexOf('[/ACTIONS]', start);
  if (end === -1) return { body, actions: [] }; // block not closed yet (streaming)
  const actions = text
    .slice(start + '[ACTIONS]'.length, end)
    .split('\n')
    .map((s) => s.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .map((line): Action => {
      const parts = line.split('|').map((s) => s.trim());
      const kind = parts[2]?.toLowerCase();
      const k = kind === 'file' ? 'file' : kind === 'input' ? 'input' : undefined;
      return {
        label: parts[0],
        // For a one-click action the button text IS what gets sent, so clicking
        // "Play some music" sends exactly that. A separate prefill message only
        // makes sense for input/file actions, where the user edits it first.
        message: k ? parts[1] || parts[0] : parts[0],
        kind: k,
      };
    });
  return { body, actions };
}

// One tool call: "Run · npm test" → verb + detail.
function ToolLine({ text }: { text: string }) {
  const idx = text.indexOf(' · ');
  const verb = idx === -1 ? text : text.slice(0, idx);
  const detail = idx === -1 ? '' : text.slice(idx + 3);
  return (
    <div className="tool">
      <span className="tool__verb">{verb}</span>
      {detail && <span className="tool__detail">{detail}</span>}
    </div>
  );
}

// "Run ×4, Edit" — what a collapsed group of tool calls did, at a glance.
function toolSummary(lines: LogLine[]): string {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const idx = l.text.indexOf(' · ');
    const verb = idx === -1 ? l.text : l.text.slice(0, idx);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return [...counts]
    .map(([v, n]) => (n > 1 ? `${v} ×${n}` : v))
    .join(', ');
}

// Agents fire off long runs of tool calls, and a row each drowns the actual
// conversation. A single call still shows inline; a run of them collapses into
// one summary line you can expand when you actually want the detail.
function ToolGroup({ lines }: { lines: LogLine[] }) {
  const [open, setOpen] = useState(false);

  if (lines.length === 1) {
    return (
      <div className="line line--tool">
        <span className="line__dot" />
        <ToolLine text={lines[0].text} />
      </div>
    );
  }

  return (
    <div className="line line--tool">
      <span className="line__dot" />
      <div className="toolgroup">
        <button
          className="toolgroup__head"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Hide steps' : 'Show steps'}
        >
          <span className="tool__verb">
            {open ? '▾' : '▸'} {lines.length} steps
          </span>
          {!open && (
            <span className="tool__detail">{toolSummary(lines)}</span>
          )}
        </button>
        {open && (
          <div className="toolgroup__body">
            {lines.map((l, k) => (
              <ToolLine key={k} text={l.text} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentLine({
  line,
  onAction,
}: {
  line: LogLine;
  onAction: (action: Action) => void;
}) {
  const { body, actions } = splitActions(line.text);
  // Render markdown the whole time (even while streaming), so the text never
  // flips from raw syntax to formatted. Memoized so completed messages don't
  // re-parse on every render.
  const html = useMemo(() => md(body), [body]);
  return (
    <div className="line__text">
      <div className="line__md" dangerouslySetInnerHTML={{ __html: html }} />
      {!line.streaming && actions.length > 0 && (
        <div className="actions">
          {actions.map((a, k) => (
            <button
              key={k}
              className="action"
              onClick={() => onAction(a)}
              title={a.kind === 'file' ? 'Attach a file, then send' : a.message}
            >
              {a.kind === 'file' && <span className="action__clip">📎</span>}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [installed, setInstalled] = useState<Agent[]>([]);
  const [market, setMarket] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  // Mocca can't run agents without Claude auth. null = still checking;
  // ok === false = show the setup screen.
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const authOk = auth === null ? null : auth.ok;
  const [authChecking, setAuthChecking] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const checkAuth = () => {
    setAuthChecking(true);
    window.system
      .authStatus()
      .then(setAuth)
      .catch(() =>
        setAuth({ ok: false, method: 'none', canUseSubscription: false }),
      )
      .finally(() => setAuthChecking(false));
  };
  useEffect(checkAuth, []);
  // Save the pasted Claude Console key. Keys start `sk-ant-`; check before
  // storing so a typo surfaces here instead of as a failed first message.
  function saveKey() {
    const k = keyInput.trim();
    if (!k.startsWith('sk-ant-')) {
      setKeyError('That doesn’t look like a Claude API key — they start with “sk-ant-”.');
      return;
    }
    setKeyError(null);
    setAuthChecking(true);
    window.system
      .setKey(k)
      .then((s) => {
        setAuth(s);
        if (s.ok) setKeyInput('');
        else setKeyError('Mocca couldn’t use that key. Check it and try again.');
      })
      .catch(() => setKeyError('Could not save the key.'))
      .finally(() => setAuthChecking(false));
  }
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [ghRepo, setGhRepo] = useState('');
  // Marketplace browsing: free-text search + category filter.
  const [mktQuery, setMktQuery] = useState('');
  const [mktCat, setMktCat] = useState('All');
  // The workspace whose detail page is open (null = browsing the shelves).
  const [mktDetail, setMktDetail] = useState<Agent | null>(null);
  const [mktInfo, setMktInfo] = useState<{
    readme?: string;
    skills?: Array<{ name: string; description: string }>;
    mcp?: McpEntry[];
  } | null>(null);
  const [mktInfoBusy, setMktInfoBusy] = useState(false);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBrief, setCreateBrief] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [cmdExpanded, setCmdExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Plan usage limits (the /usage panel), shown in Settings.
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedPrompt, setSchedPrompt] = useState('');
  const [schedKind, setSchedKind] = useState<'daily' | 'interval'>('daily');
  const [schedTime, setSchedTime] = useState('09:00');
  const [schedMinutes, setSchedMinutes] = useState(60);
  const [mcpList, setMcpList] = useState<McpEntry[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<McpEntry[]>([]);
  const [mcpQuery, setMcpQuery] = useState('');
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpCandidate, setMcpCandidate] = useState<McpEntry | null>(null);
  const [mcpKey, setMcpKey] = useState('');
  const [approvals, setApprovals] = useState<
    Array<{ category: string; label: string }>
  >([]);
  const [view, setView] = useState<View>('run');
  const [prompt, setPrompt] = useState('');
  // Everything is keyed by threadId so a thread keeps running (and collecting
  // output) while you look at a different agent.
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>({});
  const [awaitingMap, setAwaitingMap] = useState<Record<string, boolean>>({});
  // Pending sandbox-escape approval per thread (agent wants to act outside its
  // workspace, e.g. install system software). One at a time per thread.
  const [permMap, setPermMap] = useState<
    Record<
      string,
      {
        id: string;
        tool: string;
        command?: string;
        title: string;
        category?: string;
        categoryLabel?: string;
      } | null
    >
  >({});
  // Whether the raw command under the current approval prompt is expanded, and
  // whether "always allow this kind of action" is checked.
  const [permOpen, setPermOpen] = useState(false);
  const [permRemember, setPermRemember] = useState(false);
  const [threadAgent, setThreadAgent] = useState<Record<string, string>>({});
  // Session id per thread. Once set, the next send resumes it so the agent
  // remembers that conversation across restarts.
  const [sessionIds, setSessionIds] = useState<Record<string, string | null>>({});
  const [threadId, setThreadId] = useState<string>('');
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [files, setFiles] = useState<WsFile[]>([]);
  // At the root, files are shown as two human groups instead of input/output
  // folders: what you gave the agent, and what it made you.
  const [sharedFiles, setSharedFiles] = useState<WsFile[]>([]);
  const [createdFiles, setCreatedFiles] = useState<WsFile[]>([]);
  const [fileDir, setFileDir] = useState(''); // '' = root (Shared + Created)
  const fileDirRef = useRef('');
  const [viewer, setViewer] = useState<FileView | null>(null);
  // The interactive in-app view loaded PER workspace (agentId → view). Each entry
  // is rendered as its own iframe that stays mounted (hidden when you're in a
  // different workspace) so media keeps playing everywhere — opening one
  // workspace's Canvas never stops another's player. `wsTab` toggles the panel
  // between the file browser and the view.
  const [activeViews, setActiveViews] = useState<
    Record<string, { name: string; rel: string; src: string }>
  >({});
  // The view belonging to the currently selected workspace (null = none).
  const activeView = selectedId ? activeViews[selectedId] ?? null : null;
  const [wsTab, setWsTab] = useState<'files' | 'view'>('files');
  // The agent is writing a Canvas HTML file — show a "composing" cue until the
  // [CANVAS:] marker renders it. Holds the agentId that's composing.
  const [composing, setComposing] = useState<string | null>(null);
  // Every canvas the selected workspace has built (its canvas/ folder) — powers
  // the switcher when there's more than one.
  const [canvases, setCanvases] = useState<Array<{ name: string; rel: string }>>(
    [],
  );
  function refreshCanvases(id: string | null) {
    if (!id) return setCanvases([]);
    window.view.canvases(id).then(setCanvases).catch(() => setCanvases([]));
  }
  // Width of the right panel — draggable via the splitter, persisted.
  const [panelW, setPanelW] = useState(() => {
    const v = Number(localStorage.getItem('mocca.panelW'));
    return v >= 240 ? v : 320;
  });
  useEffect(() => {
    localStorage.setItem('mocca.panelW', String(panelW));
  }, [panelW]);
  const [panelOpen, setPanelOpen] = useState(
    () => localStorage.getItem('mocca.panelOpen') !== 'false',
  );
  useEffect(() => {
    localStorage.setItem('mocca.panelOpen', String(panelOpen));
  }, [panelOpen]);
  const [libW, setLibW] = useState(() => {
    const v = Number(localStorage.getItem('mocca.libW'));
    return v >= 200 ? v : 300;
  });
  useEffect(() => {
    localStorage.setItem('mocca.libW', String(libW));
  }, [libW]);
  // True while dragging a splitter — kills iframe pointer-events so the Canvas
  // doesn't swallow the mouseup and leave the drag "stuck".
  const [resizing, setResizing] = useState(false);
  const viewFrameRef = useRef<HTMLIFrameElement | null>(null);
  // Marker keys we've already opened (one per canvas emission, across all
  // workspaces/threads). A Set — NOT a single value — so returning to a
  // workspace whose Canvas is already open never re-opens it (which would
  // reload the iframe and stop its player).
  const openedViewsRef = useRef<Set<string>>(new Set());
  const viewBaseRef = useRef<string>(''); // loopback origin serving view files
  // Mocca-owned audio: a stream the app plays itself (not a detached ffplay), so
  // it's always stoppable and persists across workspace switches. Lives in the
  // app chrome, not in any view.
  // Files staged in the composer (chosen but not yet copied). They commit to the
  // workspace only when the user sends the message.
  const [pending, setPending] = useState<{ path: string; name: string }[]>([]);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const threadAgentRef = useRef<Record<string, string>>({});
  threadAgentRef.current = threadAgent;

  function refreshFiles(id: string | null, dir = fileDirRef.current) {
    if (!id) {
      setFiles([]);
      setSharedFiles([]);
      setCreatedFiles([]);
      return;
    }
    if (!dir) {
      // Root: show the two groups side by side, no folder-clicking needed.
      window.workspace.list(id, 'input').then(setSharedFiles).catch(() => setSharedFiles([]));
      window.workspace.list(id, 'output').then(setCreatedFiles).catch(() => setCreatedFiles([]));
      setFiles([]);
    } else {
      window.workspace
        .list(id, dir)
        .then((fs: WsFile[]) => setFiles(fs))
        .catch(() => setFiles([]));
    }
  }

  function navigateFiles(dir: string) {
    setFileDir(dir);
    fileDirRef.current = dir;
    refreshFiles(selectedIdRef.current, dir);
  }
  // ms timestamp when each thread's thinking block started (null = not thinking)
  const thinkStartRef = useRef<Record<string, number | null>>({});
  const [, setTick] = useState(0); // re-render to advance live "Thinking… Ns"
  const endRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // stay pinned to bottom unless the user scrolls up
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Turns in flight per thread. Streaming input lets you send more while the
  // agent works, so a thread is "running" whenever any turn is outstanding.
  const outstandingRef = useRef<Record<string, number>>({});
  const logsRef = useRef(logs);
  logsRef.current = logs;
  const prevRunningRef = useRef<Record<string, boolean>>({});

  const selected = installed.find((a) => a.id === selectedId) ?? null;
  // Does the currently-open view belong to the workspace on screen? (A view from
  // another workspace stays mounted+hidden so its media keeps playing.)
  const viewHere = !!activeView; // activeView is already scoped to selectedId
  const composingHere = composing === selectedId;
  const isInstalled = (id: string) => installed.some((a) => a.id === id);

  // Views onto the currently-open thread.
  // ── Marketplace shaping ────────────────────────────────────────────────────
  // Categories in a deliberate order (not alphabetical) so the shelf reads well.
  const CAT_ORDER = ['Career', 'Writing', 'Learning', 'Work', 'Money', 'Life'];
  const mktCats = useMemo(() => {
    const present = new Set(market.map((a) => a.category).filter(Boolean));
    return ['All', ...CAT_ORDER.filter((c) => present.has(c))];
  }, [market]);

  const mktCount = (c: string) =>
    c === 'All' ? market.length : market.filter((a) => a.category === c).length;

  const mktFiltered = useMemo(() => {
    const q = mktQuery.trim().toLowerCase();
    return market.filter((a) => {
      if (mktCat !== 'All' && a.category !== mktCat) return false;
      if (!q) return true;
      return [a.name, a.tagline, a.description, a.category, a.author]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q));
    });
  }, [market, mktQuery, mktCat]);

  // Featured only makes sense on the unfiltered shelf — once you're searching or
  // narrowing, you want results, not a highlight reel.
  const showFeatured = mktCat === 'All' && !mktQuery.trim();
  const mktFeatured = useMemo(
    () => market.filter((a) => a.featured).slice(0, 6),
    [market],
  );

  // Group into category shelves on the full view; a flat grid once filtered.
  const mktGroups = useMemo((): Array<[string, Agent[]]> => {
    if (mktCat !== 'All' || mktQuery.trim()) return [['', mktFiltered]];
    return CAT_ORDER.map(
      (c) => [c, mktFiltered.filter((a) => a.category === c)] as [string, Agent[]],
    ).filter(([, items]) => items.length > 0);
  }, [mktFiltered, mktCat, mktQuery]);

  const log = logs[threadId] ?? [];
  // Fold consecutive tool calls into one row so a burst of them collapses into
  // a single expandable summary instead of flooding the chat.
  const rows = useMemo(() => {
    const out: Array<{ key: number; tools?: LogLine[]; line?: LogLine }> = [];
    log.forEach((l, i) => {
      if (l.role === 'tool') {
        const last = out[out.length - 1];
        if (last?.tools) last.tools.push(l);
        else out.push({ key: i, tools: [l] });
        return;
      }
      out.push({ key: i, line: l });
    });
    return out;
  }, [log]);
  const running = !!runningMap[threadId];
  const awaitingFirst = !!awaitingMap[threadId];
  const sessionId = sessionIds[threadId] ?? null;
  const thinkElapsed = (() => {
    const s = thinkStartRef.current[threadId];
    return s ? Math.floor((Date.now() - s) / 1000) : 0;
  })();
  // An agent shows a running indicator if any of its threads is working.
  const agentRunning = (agentId: string) =>
    Object.entries(runningMap).some(
      ([tid, r]) => r && threadAgent[tid] === agentId,
    );
  const cmds = selected?.commands ?? [];
  const CMD_LIMIT = 6;
  const shownCmds = cmdExpanded ? cmds : cmds.slice(0, CMD_LIMIT);

  const append = (tid: string, line: LogLine) =>
    setLogs((ls) => ({ ...ls, [tid]: [...(ls[tid] ?? []), line] }));
  const patchLast = (tid: string, fn: (l: LogLine) => LogLine) =>
    setLogs((ls) => {
      const arr = ls[tid] ?? [];
      const last = arr[arr.length - 1];
      if (!last || !last.streaming) return ls;
      return { ...ls, [tid]: [...arr.slice(0, -1), fn(last)] };
    });
  const finalizeStreaming = (tid: string) =>
    setLogs((ls) => {
      const arr = ls[tid] ?? [];
      if (!arr.some((x) => x.streaming)) return ls;
      return { ...ls, [tid]: arr.map((x) => (x.streaming ? { ...x, streaming: false } : x)) };
    });

  useEffect(() => {
    // Tool lines (and nothing else) arrive here — text/thinking stream.
    const offMessage = window.agent.onMessage((tid, line) => {
      setAwaitingMap((m) => ({ ...m, [tid]: false }));
      // The agent is writing/updating a Canvas HTML file → show "composing" and
      // focus the Canvas so the user sees it building, not a blank wait.
      if (
        line.role === 'tool' &&
        /^(Write|Edit)\b/.test(line.text) &&
        /\.html?\b/i.test(line.text)
      ) {
        const owner = threadAgentRef.current[tid] ?? selectedIdRef.current;
        if (owner) {
          setComposing(owner);
          if (owner === selectedIdRef.current) setWsTab('view');
        }
      }
      append(tid, line);
    });
    const offSession = window.agent.onSession((tid, sid) =>
      setSessionIds((m) => ({ ...m, [tid]: sid })),
    );
    const offMcpAuth = window.agent.onMcpAuth(({ threadId: tid, server }) => {
      append(tid, {
        role: 'system',
        text: `🔑 Sign in to ${server} in the browser window that just opened, then it'll continue.`,
      });
    });
    const offPermission = window.agent.onPermission((p) => {
      setPermMap((m) => ({ ...m, [p.threadId]: p }));
      setPermOpen(false); // start collapsed; user expands to see the raw command
      setPermRemember(false);
    });

    // A run started that we didn't initiate (a scheduled run). Adopt its thread
    // so its output is captured, saved, and shows the agent as working.
    const offStarted = window.agent.onStarted(async ({ threadId: tid, agentId, prompt }) => {
      setThreadAgent((m) => ({ ...m, [tid]: agentId }));
      if (!logsRef.current[tid]) {
        const t = await window.threads.load(agentId, tid).catch((): null => null);
        setLogs((ls) => (ls[tid] ? ls : { ...ls, [tid]: (t?.log as LogLine[]) ?? [] }));
        setSessionIds((m) => ({ ...m, [tid]: t?.sessionId ?? null }));
      }
      outstandingRef.current[tid] = (outstandingRef.current[tid] ?? 0) + 1;
      setRunningMap((m) => ({ ...m, [tid]: true }));
      setAwaitingMap((m) => ({ ...m, [tid]: true }));
      append(tid, { role: 'you', text: prompt });
    });

    const offStreamStart = window.agent.onStreamStart((tid, kind) => {
      setAwaitingMap((m) => ({ ...m, [tid]: false }));
      append(tid, {
        role: kind === 'text' ? 'agent' : 'thinking',
        text: '',
        streaming: true,
      });
      if (kind === 'thinking' && thinkStartRef.current[tid] == null) {
        thinkStartRef.current[tid] = Date.now();
      }
    });
    const offStreamDelta = window.agent.onStreamDelta((tid, _kind, text) => {
      patchLast(tid, (last) => ({ ...last, text: last.text + text }));
    });
    const offStreamEnd = window.agent.onStreamEnd((tid, kind) => {
      const start = thinkStartRef.current[tid];
      const seconds =
        kind === 'thinking' && start
          ? Math.max(1, Math.round((Date.now() - start) / 1000))
          : undefined;
      if (kind === 'thinking') thinkStartRef.current[tid] = null;
      patchLast(tid, (last) => ({ ...last, streaming: false, seconds }));
    });

    const offDone = window.agent.onDone((tid) => {
      outstandingRef.current[tid] = Math.max(
        0,
        (outstandingRef.current[tid] ?? 1) - 1,
      );
      finalizeStreaming(tid);
      refreshFiles(selectedIdRef.current);
      refreshCanvases(selectedIdRef.current);
      if (outstandingRef.current[tid] === 0) {
        thinkStartRef.current[tid] = null;
        setAwaitingMap((m) => ({ ...m, [tid]: false }));
        setRunningMap((m) => ({ ...m, [tid]: false }));
        // Turn ended — if a Canvas was being composed but none rendered (agent
        // wrote a scratch file, or changed its mind), drop the composing cue.
        const owner = threadAgentRef.current[tid];
        if (owner) setComposing((c) => (c === owner ? null : c));
      }
    });
    const offError = window.agent.onError((tid, text) => {
      outstandingRef.current[tid] = 0;
      thinkStartRef.current[tid] = null;
      setAwaitingMap((m) => ({ ...m, [tid]: false }));
      finalizeStreaming(tid);
      append(tid, { role: 'system', text: `error: ${text}` });
      setRunningMap((m) => ({ ...m, [tid]: false }));
    });
    return () => {
      offMessage();
      offSession();
      offMcpAuth();
      offPermission();
      offStarted();
      offStreamStart();
      offStreamDelta();
      offStreamEnd();
      offDone();
      offError();
    };
  }, []);

  // Auto-scroll: pin to the bottom as content streams, but only if the user is
  // already near the bottom — so scrolling up to re-read isn't yanked away.
  function onLogScroll() {
    const el = logRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, awaitingFirst]);

  // Load the selected workspace's files, starting back at the root.
  useEffect(() => {
    fileDirRef.current = '';
    setFileDir('');
    refreshFiles(selectedId, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Show cached usage limits immediately on load.
  useEffect(() => {
    window.system.usageCached().then((u) => u && setUsage(u)).catch(() => {});
  }, []);

  // Pull fresh usage limits (also the Settings refresh button).
  const refreshUsage = useCallback(() => {
    setUsageBusy(true);
    window.system
      .usage()
      .then((u) => u && setUsage(u))
      .catch(() => {})
      .finally(() => setUsageBusy(false));
  }, []);

  // Refresh when Settings opens, so the numbers are current on view.
  useEffect(() => {
    if (settingsOpen) refreshUsage();
  }, [settingsOpen, refreshUsage]);

  // Advance the live "Thinking… Ns" counters while anything is running.
  useEffect(() => {
    if (!Object.values(runningMap).some(Boolean)) return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [runningMap]);

  function startFreshThread(agentId?: string) {
    const id = newId();
    setThreadId(id);
    setLogs((ls) => ({ ...ls, [id]: [] }));
    setSessionIds((m) => ({ ...m, [id]: null }));
    if (agentId) setThreadAgent((m) => ({ ...m, [id]: agentId }));
  }

  async function openThread(agentId: string, id: string) {
    setThreadId(id);
    setThreadAgent((m) => ({ ...m, [id]: agentId }));
    // If we already hold this thread in memory (e.g. it ran in the background
    // while you were elsewhere) that transcript is newer than the saved one.
    if (logsRef.current[id]) return;
    const t = await window.threads.load(agentId, id).catch((): null => null);
    setLogs((ls) => ({ ...ls, [id]: (t?.log as LogLine[]) ?? [] }));
    setSessionIds((m) => ({ ...m, [id]: t?.sessionId ?? null }));
  }

  // On selecting an agent, load its thread list and open the most recent one
  // (or start a fresh thread if it has none).
  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setThreads([]);
      startFreshThread();
      return;
    }
    (async () => {
      const list = await window.threads.list(selectedId).catch((): ThreadMeta[] => []);
      if (cancelled) return;
      setThreads(list);
      // Prefer a thread of this agent that's currently running, else the latest.
      const live = Object.keys(runningMap).find(
        (tid) => runningMap[tid] && threadAgent[tid] === selectedId,
      );
      if (live) await openThread(selectedId, live);
      else if (list.length) await openThread(selectedId, list[0].id);
      else startFreshThread(selectedId);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Save any thread that just finished a turn (even a background one).
  useEffect(() => {
    for (const tid of Object.keys(prevRunningRef.current)) {
      if (!prevRunningRef.current[tid] || runningMap[tid]) continue;
      const aid = threadAgent[tid];
      const lg = logs[tid];
      if (!aid || !lg?.length) continue;
      const firstYou = lg.find((l) => l.role === 'you')?.text ?? '';
      const title =
        firstYou
          .replace(/^📎[^\n]*\n+/, '')
          .trim()
          .slice(0, 48) || 'New chat';
      window.threads.save(aid, tid, {
        id: tid,
        title,
        updatedAt: Date.now(),
        sessionId: sessionIds[tid] ?? null,
        log: lg,
      });
      if (aid === selectedIdRef.current) {
        window.threads
          .list(aid)
          .then(setThreads)
          .catch((): void => {});
      }
    }
    prevRunningRef.current = { ...runningMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningMap]);

  async function attachFiles() {
    if (!selected) return;
    const paths = await window.workspace.pick();
    if (!paths.length) return;
    setPending((p) => {
      const seen = new Set(p.map((x) => x.name));
      const add = paths
        .map((full) => ({ path: full, name: full.split('/').pop() || full }))
        .filter((x) => !seen.has(x.name));
      return [...p, ...add];
    });
  }

  function removePending(name: string) {
    setPending((p) => p.filter((x) => x.name !== name));
  }

  // Add files straight into Shared (they land in input/), no send needed.
  async function addShared() {
    if (!selected) return;
    const paths = await window.workspace.pick();
    if (!paths.length) return;
    await window.workspace.commit(selected.id, paths).catch((): WsFile[] => []);
    refreshFiles(selected.id, fileDirRef.current);
  }

  // One file/folder row in the panel.
  const renderFile = (f: WsFile) => (
    <button
      key={f.path}
      className="wfile"
      onClick={() => (f.isDir ? navigateFiles(f.rel) : openViewer(f))}
      title={f.isDir ? `Open ${f.name}` : `Preview ${f.name}`}
    >
      {f.isDir && (
        <svg
          className="wfile__folder"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      )}
      <span className="wfile__name">{f.name}</span>
      <span className="wfile__size">{f.isDir ? '›' : fmtSize(f.size)}</span>
    </button>
  );

  // Drag a splitter to resize a pane. `apply` sets a width from the pointer X.
  function startDrag(e: ReactMouseEvent, apply: (x: number) => void) {
    e.preventDefault();
    setResizing(true);
    const onMove = (ev: MouseEvent) => apply(ev.clientX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  // Right panel: width grows as the pointer moves left.
  const startPanelDrag = (e: ReactMouseEvent) =>
    startDrag(e, (x) =>
      setPanelW(Math.min(Math.max(window.innerWidth - x, 240), window.innerWidth - 420)),
    );
  // Left library: width is the pointer's X.
  const startLibDrag = (e: ReactMouseEvent) =>
    startDrag(e, (x) => setLibW(Math.min(Math.max(x, 220), 460)));

  async function openViewer(f: WsFile) {
    // HTML files are interactive views — render them live in the panel, not as
    // read-only source in the modal.
    if (/\.html?$/i.test(f.name)) {
      loadView(f.rel, f.name);
      return;
    }
    const data = await window.workspace.read(f.path);
    setViewer({ ...data, path: f.path });
  }

  // Show a workspace HTML file in the panel. It loads from Mocca's loopback
  // origin (real http origin → embeds like YouTube work; still cross-origin to
  // Mocca → can't reach the app). Loading a new view unmounts the old one.
  async function loadView(rel: string, name: string) {
    const id = selectedIdRef.current;
    if (!id) return;
    if (!viewBaseRef.current) {
      viewBaseRef.current = await window.view.baseUrl().catch(() => '');
    }
    if (!viewBaseRef.current) return;
    const encRel = rel.split('/').map(encodeURIComponent).join('/');
    // Cache-bust so re-opening the same file always reloads fresh content (the
    // iframe is keyed by src; an identical URL would never reload).
    const src = `${viewBaseRef.current}/${encodeURIComponent(id)}/${encRel}?v=${Date.now()}`;
    setActiveViews((v) => ({ ...v, [id]: { name, rel, src } }));
    setComposing((c) => (c === id ? null : c));
    setWsTab('view');
    refreshCanvases(id);
  }

  // The bridge effect calls the latest runAgent without re-subscribing each render.
  const runAgentRef = useRef<(t?: string) => void>(() => {});


  // Load the marketplace (bundled registry) and the library (installed on disk).
  useEffect(() => {
    window.market
      .registry()
      .then(setMarket)
      .catch(() => setMarket([]));
    window.market
      .installed()
      .then((pkgs) => {
        setInstalled(pkgs);
        setSelectedId((s) => s || pkgs[0]?.id || '');
      })
      .catch(() => setInstalled([]));
  }, []);

  // Open a workspace's detail page and pull the extras (README, skills, bundled
  // servers). The page renders immediately from the card data we already have;
  // the fetched parts fill in when they arrive.
  async function openDetail(a: Agent) {
    setMktDetail(a);
    setMktInfo(null);
    setMktInfoBusy(true);
    try {
      setMktInfo(await window.market.details(a.id));
    } catch {
      setMktInfo({});
    } finally {
      setMktInfoBusy(false);
    }
  }

  async function install(id: string) {
    setInstallingId(id);
    setGhError(null);
    try {
      const res = await window.market.install(id);
      if (res.ok) {
        setInstalled(res.installed);
        openAgent(res.id ?? id); // jump straight into the new workspace
      } else if ('error' in res && res.error) {
        setGhError(`Couldn't install ${id}: ${res.error}`);
      }
    } catch (e) {
      setGhError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingId(null);
    }
  }

  async function uninstall(id: string) {
    const pkgs = await window.market.uninstall(id);
    setInstalled(pkgs);
    // Drop any in-memory threads belonging to the removed agent.
    setLogs((ls) => {
      const next = { ...ls };
      for (const tid of Object.keys(next)) {
        if (threadAgent[tid] === id) delete next[tid];
      }
      return next;
    });
    if (selectedId === id) setSelectedId(pkgs[0]?.id || '');
  }

  // Load this agent's schedules + connected tools when the settings modal opens.
  useEffect(() => {
    if (!settingsOpen || !selectedId) return;
    window.schedules
      .list(selectedId)
      .then(setSchedules)
      .catch((): void => {});
    window.mcp
      .list(selectedId)
      .then(setMcpList)
      .catch((): void => {});
    window.mcp
      .catalog()
      .then(setMcpCatalog)
      .catch((): void => {});
    window.approvals
      .list(selectedId)
      .then(setApprovals)
      .catch((): void => {});
    setMcpCandidate(null);
    setMcpError(null);
    setMcpQuery('');
  }, [settingsOpen, selectedId]);

  async function revokeApproval(category: string) {
    if (!selectedId) return;
    setApprovals(await window.approvals.revoke(selectedId, category));
  }

  async function findMcp(name: string) {
    const q = name.trim();
    if (!q || mcpBusy) return;
    setMcpBusy(true);
    setMcpError(null);
    setMcpCandidate(null);
    try {
      const res = await window.mcp.resolve(q);
      if ('error' in res) setMcpError(res.error);
      else setMcpCandidate(res);
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpBusy(false);
    }
  }

  async function addMcp(entry: McpEntry) {
    if (!selected) return;
    // If the user supplied an API key, inject it as the auth header.
    const key = mcpKey.trim();
    const withKey: McpEntry =
      entry.authType === 'key' && key
        ? {
            ...entry,
            headers: {
              ...(entry.headers ?? {}),
              [entry.authHeader || 'Authorization']: key.startsWith('Bearer')
                ? key
                : `Bearer ${key}`,
            },
          }
        : entry;
    setMcpList(await window.mcp.add(selected.id, withKey));
    setMcpCandidate(null);
    setMcpQuery('');
    setMcpKey('');
  }

  async function removeMcp(name: string) {
    if (!selected) return;
    setMcpList(await window.mcp.remove(selected.id, name));
  }

  // Bundled servers belong to the plugin, so they're switched off rather than
  // removed. Takes effect on the workspace's next run.
  async function setMcpEnabled(name: string, enabled: boolean) {
    if (!selected) return;
    setMcpList(await window.mcp.setEnabled(selected.id, name, enabled));
  }

  async function addSchedule() {
    if (!selected || !schedPrompt.trim()) return;
    const list = await window.schedules.save(selected.id, {
      prompt: schedPrompt.trim(),
      kind: schedKind,
      time: schedKind === 'daily' ? schedTime : undefined,
      minutes: schedKind === 'interval' ? schedMinutes : undefined,
      enabled: true,
    });
    setSchedules(list);
    setSchedPrompt('');
  }

  async function toggleSchedule(s: Schedule) {
    if (!selected) return;
    setSchedules(
      await window.schedules.save(selected.id, { ...s, enabled: !s.enabled }),
    );
  }

  async function deleteSchedule(id: string) {
    if (!selected) return;
    setSchedules(await window.schedules.delete(selected.id, id));
  }

  async function runScheduleNow(id: string) {
    if (!selected) return;
    setSchedules(await window.schedules.runNow(selected.id, id));
    closeSettings();
  }

  function closeSettings() {
    setSettingsOpen(false);
    setConfirmDelete(false);
  }

  async function deleteSelected() {
    if (!selected) return;
    await uninstall(selected.id); // removes the agent's package, plugin + workspace
    closeSettings();
  }

  async function installGithub() {
    const repo = ghRepo.trim();
    if (!repo || ghBusy) return;
    setGhBusy(true);
    setGhError(null);
    try {
      const res = await window.market.installGithub(repo);
      if (res.ok) {
        setInstalled(res.installed);
        setGhRepo('');
        openAgent(res.id);
      } else if ('error' in res) {
        setGhError(res.error);
      }
    } catch (e) {
      setGhError(e instanceof Error ? e.message : String(e));
    } finally {
      setGhBusy(false);
    }
  }

  async function createAgent() {
    const name = createName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const res = await window.market.createAgent(name, createBrief.trim());
      if (res.ok) {
        setInstalled(res.installed);
        setCreateOpen(false);
        setCreateName('');
        setCreateBrief('');
        openAgent(res.id);
      } else if ('error' in res && res.error) {
        setCreateError(res.error);
      }
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  async function installFolder() {
    if (ghBusy) return;
    setGhBusy(true);
    setGhError(null);
    try {
      const res = await window.market.installFolder();
      if (res.ok) {
        setInstalled(res.installed);
        openAgent(res.id);
      } else if ('error' in res && res.error) {
        setGhError(res.error);
      }
    } catch (e) {
      setGhError(e instanceof Error ? e.message : String(e));
    } finally {
      setGhBusy(false);
    }
  }

  function openAgent(id: string) {
    setSelectedId(id); // the [selectedId] effect restores its threads/chat
    setPending([]);
    setCmdExpanded(false);
    setSettingsOpen(false);
    setConfirmDelete(false);
    setHistoryOpen(false);
    setView('run');
  }

  function newChat() {
    setHistoryOpen(false);
    startFreshThread(selected?.id); // new id → next send starts a fresh session
  }

  async function pickThread(id: string) {
    setHistoryOpen(false);
    if (id === threadId || !selected) return;
    await openThread(selected.id, id);
  }

  async function deleteThread(id: string) {
    if (!selected) return;
    await window.threads.delete(selected.id, id);
    setLogs((ls) => {
      const next = { ...ls };
      delete next[id];
      return next;
    });
    const list = await window.threads.list(selected.id).catch((): ThreadMeta[] => []);
    setThreads(list);
    if (id === threadId) {
      if (list.length) await openThread(selected.id, list[0].id);
      else startFreshThread(selected.id);
    }
  }

  async function runAgent(taskText?: string) {
    const typed = (taskText ?? prompt).trim();
    if ((!typed && pending.length === 0) || !selected || !threadId) return;
    const tid = threadId;

    // Commit staged attachments into the workspace on send.
    let attached: string[] = [];
    if (pending.length) {
      attached = pending.map((x) => x.name);
      const updated = await window.workspace.commit(
        selected.id,
        pending.map((x) => x.path),
      );
      // Uploads land in input/ — show them there.
      fileDirRef.current = 'input';
      setFileDir('input');
      setFiles(updated);
      setPending([]);
    }

    const task =
      (attached.length ? `📎 Attached: ${attached.join(', ')}\n\n` : '') +
      (typed || `I've attached ${attached.join(', ')}. Please take a look.`);

    outstandingRef.current[tid] = (outstandingRef.current[tid] ?? 0) + 1;
    setRunningMap((m) => ({ ...m, [tid]: true }));
    setAwaitingMap((m) => ({ ...m, [tid]: true }));
    setThreadAgent((m) => ({ ...m, [tid]: selected.id }));
    setPrompt('');
    if (taRef.current) taRef.current.style.height = 'auto';
    append(tid, { role: 'you', text: task });
    window.agent.run({
      task,
      instructions: selected.instructions,
      allowedTools: selected.allowedTools,
      agentId: selected.id,
      threadId: tid,
      resume: sessionIds[tid] ?? undefined,
    });
  }
  runAgentRef.current = runAgent;

  // The view bridge: the sandboxed view posts {__mocca, id, verb, args}; we run
  // an allowlisted, workspace-scoped verb and post the result back. We only ever
  // accept messages from OUR view iframe — never the embedded YouTube/etc frames.
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const frame = viewFrameRef.current;
      const d = e.data;
      // Only our view iframe, from the loopback origin — never the embedded
      // YouTube/SomaFM frames or any other window.
      if (
        !frame ||
        e.source !== frame.contentWindow ||
        !e.origin.startsWith('http://localhost:') ||
        !d?.__mocca
      )
        return;
      const id = selectedIdRef.current;
      const reply = (patch: Record<string, unknown>) =>
        frame.contentWindow?.postMessage(
          { __moccaReply: true, id: d.id, ...patch },
          e.origin,
        );
      try {
        if (!id) throw new Error('No workspace open.');
        const a = d.args ?? {};
        let result: unknown = null;
        switch (d.verb) {
          case 'chat.send':
            if (typeof a.text === 'string' && a.text.trim())
              runAgentRef.current(a.text);
            result = true;
            break;
          case 'files.read':
            result = await window.view.read(id, String(a.path ?? ''));
            break;
          case 'files.write':
            result = await window.view.write(
              id,
              String(a.path ?? ''),
              String(a.content ?? ''),
            );
            break;
          case 'files.list':
            result = await window.view.list(id, String(a.path ?? ''));
            break;
          default:
            throw new Error(`Unknown verb: ${d.verb}`);
        }
        reply({ result });
      } catch (err) {
        reply({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // When the agent's latest message declares `[VIEW: path]`, open it in the panel.
  useEffect(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].role !== 'agent') continue;
      const m = log[i].text.match(VIEW_RE);
      if (!m) break; // most recent agent turn had no view
      const rel = m[1].trim();
      // Include the message index so a NEW message re-emitting the SAME file
      // (a regenerated Canvas) re-loads instead of being deduped away.
      const key = `${threadId}:${i}:${rel}`;
      if (openedViewsRef.current.has(key)) break; // already opened — don't reload
      openedViewsRef.current.add(key);
      loadView(rel, rel.split('/').pop() || rel);
      break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, threadId]);

  // Switching workspaces shows that workspace's Files — but we DON'T unmount the
  // active view. Its iframe stays alive (hidden) so media keeps playing across
  // the switch; the View tab reappears when you return to its workspace.
  useEffect(() => {
    // Returning to the view's own workspace re-opens the View tab; elsewhere,
    // show Files (the view keeps playing hidden either way).
    setWsTab(selectedId && activeViews[selectedId] ? 'view' : 'files');
    refreshCanvases(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function stopAgent() {
    if (threadId) window.agent.stop(threadId);
  }

  function fillComposer(text: string) {
    setPrompt(text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    });
  }

  // Answer a pending sandbox-escape prompt, note the outcome in the chat, and
  // clear it so the agent's paused turn can continue.
  function respondPermission(allow: boolean) {
    const req = permMap[threadId];
    if (!req) return;
    const remember = allow && permRemember;
    window.agent.respondPermission(req.id, allow, remember);
    setPermMap((m) => ({ ...m, [threadId]: null }));
    append(threadId, {
      role: 'system',
      text: allow
        ? remember && req.categoryLabel
          ? `✅ Always allowing ${req.categoryLabel} in this workspace.`
          : `✅ You approved: ${req.title}`
        : `🚫 You declined: ${req.title}`,
    });
  }

  // Dispatch a clicked suggestion by its kind: a plain action sends right away;
  // an `input` action prefills the composer so the user adds detail; a `file`
  // action prefills AND opens the attach picker.
  function handleAction(a: Action) {
    // Special host action: an agent needs Homebrew but it's missing. Launch the
    // official installer in Terminal rather than sending anything to the agent.
    if (a.message.trim() === '__mocca_install_homebrew__') {
      window.system.installHomebrew();
      if (threadId) {
        append(threadId, {
          role: 'system',
          text: 'Opening Terminal to install Homebrew. Enter your Mac password when asked, then come back and ask me again.',
        });
      }
      return;
    }
    if (a.kind === 'file') {
      fillComposer(a.message);
      attachFiles();
    } else if (a.kind === 'input') {
      fillComposer(a.message);
    } else {
      runAgent(a.message);
    }
  }

  // Mocca can't do anything without Claude auth — gate the whole app on it.
  if (authOk === false) {
    return (
      <div className="setup">
        <div className="setup__card">
          <div className="setup__logo">☕️</div>
          <h1 className="setup__title">Add your Claude API key</h1>
          <p className="setup__lead">
            Mocca runs its agents on your own Claude account. Paste a key from the
            Claude Console — it’s stored encrypted on this Mac and never leaves it.
          </p>
          <input
            className="setup__input"
            type="password"
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setKeyError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && saveKey()}
            placeholder="sk-ant-…"
            autoFocus
            spellCheck={false}
          />
          {keyError && <div className="setup__error">{keyError}</div>}
          <button
            className="setup__btn"
            onClick={saveKey}
            disabled={authChecking || !keyInput.trim()}
          >
            {authChecking ? 'Checking…' : 'Start using Mocca'}
          </button>
          <p className="setup__hint">
            Don’t have one?{' '}
            <button
              className="setup__link"
              onClick={() =>
                window.shell.openExternal('https://platform.claude.com/settings/keys')
              }
            >
              Create a key in the Claude Console
            </button>
            . Usage is billed to your Anthropic account per token.
          </p>

          {/* Source builds only: someone running Mocca themselves may use their
              own Claude Code sign-in — the shipped app has no such path. */}
          {auth?.canUseSubscription && (
            <div className="setup__alt">
              <div className="setup__alt-head">Running from source</div>
              <p className="setup__warn">
                Using your Claude subscription with a third-party app isn’t
                permitted by Anthropic. Your account could be restricted without
                notice. Use an API key instead.
              </p>
              <p className="setup__hint">
                If you sign in with <code>claude</code> in a terminal, this build
                will pick that up and run without a key.
              </p>
              <button
                className="setup__btn setup__btn--ghost"
                onClick={checkAuth}
                disabled={authChecking}
              >
                {authChecking ? 'Checking…' : 'Re-check sign-in'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Left: YOUR installed agents */}
      <aside className="library" style={{ width: libW }}>
        <div className="library__head">
          <div className="library__titlerow">
            <div className="library__title">Workspace</div>
            <div className="library__add">
              <button
                className="workspace__icon"
                onClick={() => setAddOpen((o) => !o)}
                title="Add a workspace"
                aria-label="Add a workspace"
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              {addOpen && (
                <>
                  <div className="menu-scrim" onClick={() => setAddOpen(false)} />
                  <div className="addmenu">
                    <button
                      className="addmenu__item"
                      onClick={() => {
                        setAddOpen(false);
                        setCreateOpen(true);
                      }}
                    >
                      New workspace…
                    </button>
                    <button
                      className="addmenu__item"
                      onClick={() => {
                        setAddOpen(false);
                        setView('marketplace');
                      }}
                    >
                      Browse marketplace
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="library__list">
          {installed.length === 0 ? (
            <div className="library__empty">
              No workspaces yet.
              <br />
              Use ＋ to create one or browse the marketplace.
            </div>
          ) : (
            installed.map((a) => (
              <button
                key={a.id}
                className={`card card--btn ${
                  a.id === selectedId && view === 'run' ? 'card--active' : ''
                }`}
                onClick={() => openAgent(a.id)}
              >
                <div className="card__name">
                  {a.name}
                  {agentRunning(a.id) && (
                    <span
                      className="card__running"
                      title="Working…"
                      aria-label="Working"
                    />
                  )}
                </div>
                <div className="card__desc">{a.description}</div>
              </button>
            ))
          )}
        </div>
      </aside>

      <div
        className="splitter"
        onMouseDown={startLibDrag}
        title="Drag to resize"
      />

      {/* Right: Marketplace OR the run panel */}
      {view === 'marketplace' ? (
        mktDetail ? (
          <section className="market">
            <header className="market__head">
              <button
                className="market__back"
                onClick={() => setMktDetail(null)}
              >
                ← Marketplace
              </button>
              <button
                className="market__done"
                onClick={() => {
                  setMktDetail(null);
                  setView('run');
                }}
              >
                Done
              </button>
            </header>

            <div className="market__body">
              <div className="det__hero">
                <span className="det__emoji">{mktDetail.emoji}</span>
                <div className="det__id">
                  <div className="det__name">{mktDetail.name}</div>
                  <div className="det__tag">
                    {mktDetail.tagline ?? mktDetail.description}
                  </div>
                  <div className="det__meta">
                    {mktDetail.category && (
                      <span className="chip chip--on">{mktDetail.category}</span>
                    )}
                    {mktDetail.author && <span>by {mktDetail.author}</span>}
                    {mktDetail.version && <span>v{mktDetail.version}</span>}
                    {mktDetail.source?.startsWith('github:') && (
                      <button
                        className="mcard__repo"
                        onClick={() =>
                          window.shell.openExternal(
                            `https://github.com/${mktDetail.source!.slice('github:'.length)}`,
                          )
                        }
                      >
                        {mktDetail.source.slice('github:'.length)} ↗
                      </button>
                    )}
                  </div>
                </div>
                <div className="det__actions">
                  {isInstalled(mktDetail.id) ? (
                    <>
                      <button
                        className="mcard__install"
                        onClick={() => openAgent(mktDetail.id)}
                      >
                        Open
                      </button>
                      <button
                        className="mcard__uninstall"
                        onClick={() => uninstall(mktDetail.id)}
                      >
                        Uninstall
                      </button>
                    </>
                  ) : (
                    <button
                      className="mcard__install"
                      onClick={() => install(mktDetail.id)}
                      disabled={installingId === mktDetail.id}
                    >
                      {installingId === mktDetail.id ? 'Installing…' : 'Install'}
                    </button>
                  )}
                </div>
              </div>

              {mktDetail.description && (
                <div className="det__sec">
                  <div className="market__blockhead">About</div>
                  <p className="det__body">{mktDetail.description}</p>
                </div>
              )}

              {mktDetail.examplePrompt && (
                <div className="det__sec">
                  <div className="market__blockhead">Try this</div>
                  <div className="det__try">“{mktDetail.examplePrompt}”</div>
                </div>
              )}

              {mktDetail.allowedTools?.length > 0 && (
                <div className="det__sec">
                  <div className="market__blockhead">What it can use</div>
                  <div className="det__tools">
                    {mktDetail.allowedTools.map((t) => (
                      <span key={t} className="det__tool">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {mktInfo?.skills && mktInfo.skills.length > 0 && (
                <div className="det__sec">
                  <div className="market__blockhead">
                    Skills ({mktInfo.skills.length})
                  </div>
                  <div className="det__skills">
                    {mktInfo.skills.map((sk) => (
                      <div key={sk.name} className="det__skill">
                        <div className="det__skillname">{sk.name}</div>
                        {sk.description && (
                          <div className="det__skilldesc">{sk.description}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {mktInfo?.mcp && mktInfo.mcp.length > 0 && (
                <div className="det__sec">
                  <div className="market__blockhead">Bundled tools</div>
                  {mktInfo.mcp.map((m) => (
                    <div key={m.name} className="det__mcp">
                      <b>{m.name}</b>{' '}
                      <span className="det__mcpcmd">
                        {[m.command, ...(m.args ?? [])].filter(Boolean).join(' ') ||
                          m.url}
                      </span>
                      {m.env && Object.keys(m.env).length > 0 && (
                        <span className="det__mcpenv">
                          {' '}
                          · carries {Object.keys(m.env).join(', ')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="det__sec">
                <div className="market__blockhead">
                  Readme{mktInfoBusy ? ' · loading…' : ''}
                </div>
                {mktInfo?.readme ? (
                  <div
                    className="det__readme line__md"
                    dangerouslySetInnerHTML={{ __html: md(mktInfo.readme) }}
                  />
                ) : mktInfoBusy ? null : (
                  <p className="det__body det__muted">
                    No readme found for this workspace.
                  </p>
                )}
              </div>
            </div>
          </section>
        ) : (
        <section className="market">
          <header className="market__head">
            <div>
              <div className="market__title">Marketplace</div>
              <div className="market__sub">
                {market.length} workspaces, each powered by a Claude Code agent.
              </div>
            </div>
            <button className="market__done" onClick={() => setView('run')}>
              Done
            </button>
          </header>

          <div className="market__body">

          <input
            className="market__search"
            value={mktQuery}
            onChange={(e) => setMktQuery(e.target.value)}
            placeholder="Search workspaces…"
            aria-label="Search workspaces"
          />

          {showFeatured && mktFeatured.length > 0 && (
            <div className="market__block">
              <div className="market__blockhead">Featured</div>
              <div className="feat">
                {mktFeatured.map((a) => {
                  const has = isInstalled(a.id);
                  const busy = installingId === a.id;
                  return (
                    <div
                      key={a.id}
                      className="featcard"
                      onClick={() => openDetail(a)}
                    >
                      <div className="featcard__emoji">{a.emoji}</div>
                      <div className="featcard__name">{a.name}</div>
                      <div className="featcard__tag">
                        {a.tagline ?? a.description}
                      </div>
                      {has ? (
                        <span className="featcard__done">✓ Installed</span>
                      ) : (
                        <button
                          className="featcard__cta"
                          onClick={(e) => {
                            e.stopPropagation();
                            install(a.id);
                          }}
                          disabled={busy}
                        >
                          {busy ? 'Installing…' : 'Install'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="chips">
            {mktCats.map((c) => (
              <button
                key={c}
                className={`chip ${mktCat === c ? 'chip--on' : ''}`}
                onClick={() => setMktCat(c)}
              >
                {c}
                <span className="chip__n">{mktCount(c)}</span>
              </button>
            ))}
          </div>

          {mktFiltered.length === 0 ? (
            <div className="market__empty">
              Nothing matches{mktQuery.trim() ? ` “${mktQuery.trim()}”` : ''}.
            </div>
          ) : (
            mktGroups.map(([cat, items]) => (
              <div key={cat || 'results'} className="market__block">
                {cat && <div className="market__blockhead">{cat}</div>}
                <div className="market__grid">
                  {items.map((a) => {
                    const has = isInstalled(a.id);
                    const busy = installingId === a.id;
                    const repo = a.source?.startsWith('github:')
                      ? a.source.slice('github:'.length)
                      : null;
                    return (
                      <div
                        key={a.id}
                        className={`mcard ${has ? 'mcard--has' : ''}`}
                        onClick={() => openDetail(a)}
                      >
                        <div className="mcard__top">
                          <span className="mcard__emoji">{a.emoji}</span>
                          <div className="mcard__id">
                            <div className="mcard__name">{a.name}</div>
                            {a.author && (
                              <div className="mcard__by">by {a.author}</div>
                            )}
                          </div>
                        </div>
                        <div className="mcard__desc">
                          {a.tagline ?? a.description}
                        </div>
                        <div className="mcard__foot">
                          {repo ? (
                            <button
                              className="mcard__repo"
                              title={`View ${repo} on GitHub`}
                              onClick={(e) => {
                                e.stopPropagation();
                                window.shell.openExternal(
                                  `https://github.com/${repo}`,
                                );
                              }}
                            >
                              GitHub ↗
                            </button>
                          ) : (
                            <span />
                          )}
                          {has ? (
                            <button
                              className="mcard__uninstall"
                              onClick={(e) => {
                                e.stopPropagation();
                                uninstall(a.id);
                              }}
                            >
                              Uninstall
                            </button>
                          ) : (
                            <button
                              className="mcard__install"
                              onClick={(e) => {
                                e.stopPropagation();
                                install(a.id);
                              }}
                              disabled={busy}
                            >
                              {busy ? 'Installing…' : 'Install'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          <details className="market__adv">
            <summary>Install from GitHub or a folder</summary>
            <div className="market__gh">
              <input
                className="market__ghinput"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && installGithub()}
                placeholder="owner/repo — e.g. santifer/career-ops"
                disabled={ghBusy}
              />
              <button
                className="market__ghbtn"
                onClick={installGithub}
                disabled={ghBusy || !ghRepo.trim()}
              >
                {ghBusy ? 'Installing…' : 'Install'}
              </button>
              <button
                className="market__ghbtn"
                onClick={installFolder}
                disabled={ghBusy}
                title="Install a Claude Code plugin from a local folder"
              >
                From folder…
              </button>
            </div>
            {ghError && <div className="market__gherror">{ghError}</div>}
          </details>
          </div>
        </section>
        )
      ) : (
        <section className="run">
          {selected ? (
            <div className="run__cols">
              <div className="run__chat">
              <header className="run__header">
                <div className="run__titlerow">
                  <div className="run__title">{selected.name}</div>
                  <div className="history">
                    <button
                      className="run__gear"
                      onClick={() => setHistoryOpen((o) => !o)}
                      title="Chat history"
                      aria-label="Chat history"
                    >
                      <svg
                        width="17"
                        height="17"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                    </button>
                    {historyOpen && (
                      <>
                        <div
                          className="menu-scrim"
                          onClick={() => setHistoryOpen(false)}
                        />
                        <div className="history__menu">
                          <div className="history__head">Chats</div>
                          {threads.length === 0 ? (
                            <div className="history__empty">
                              No saved chats yet.
                            </div>
                          ) : (
                            threads.map((t) => (
                              <div
                                key={t.id}
                                className={`history__item ${
                                  t.id === threadId ? 'is-active' : ''
                                }`}
                              >
                                <button
                                  className="history__pick"
                                  onClick={() => pickThread(t.id)}
                                >
                                  <span className="history__title">
                                    {t.title}
                                  </span>
                                  <span className="history__time">
                                    {timeAgo(t.updatedAt)}
                                  </span>
                                </button>
                                <button
                                  className="history__del"
                                  onClick={() => deleteThread(t.id)}
                                  title="Delete chat"
                                  aria-label="Delete chat"
                                >
                                  ×
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    className="run__gear"
                    onClick={newChat}
                    title="New chat"
                    aria-label="New chat"
                  >
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </button>
                  <button
                    className="run__gear"
                    onClick={() => setSettingsOpen(true)}
                    title="Workspace settings"
                    aria-label="Workspace settings"
                  >
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                  <button
                    className={`run__gear ${panelOpen ? 'run__gear--on' : ''}`}
                    onClick={() => setPanelOpen((o) => !o)}
                    title={panelOpen ? 'Hide panel' : 'Show Files & Canvas'}
                    aria-label="Toggle panel"
                  >
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <path d="M15 4v16" />
                    </svg>
                  </button>
                </div>
                <div className="run__desc">{selected.description}</div>
                {cmds.length > 0 && (
                  <div className="run__commands">
                    {shownCmds.map((c) => (
                      <button
                        key={c.command}
                        className="cmd"
                        onClick={() => runAgent(c.command)}
                        title={`Run ${c.command}`}
                      >
                        {c.label}
                      </button>
                    ))}
                    {cmds.length > CMD_LIMIT && (
                      <button
                        className="cmd cmd--more"
                        onClick={() => setCmdExpanded((v) => !v)}
                      >
                        {cmdExpanded ? 'Show less' : `+${cmds.length - CMD_LIMIT} more`}
                      </button>
                    )}
                  </div>
                )}
              </header>
              <main className="run__log" ref={logRef} onScroll={onLogScroll}>
                {log.length === 0 ? (
                  <div className="run__empty">Try: “{selected.examplePrompt}”</div>
                ) : (
                  rows.map(({ key, tools, line }) =>
                    tools ? (
                      <ToolGroup key={key} lines={tools} />
                    ) : line!.role === 'you' ? (
                      <div key={key} className="you">
                        <div className="you__bubble">{line!.text}</div>
                      </div>
                    ) : line!.role === 'thinking' ? (
                      <div key={key} className="line line--thinking">
                        <span
                          className={`line__dot ${
                            line!.streaming ? 'line__dot--pulse' : ''
                          }`}
                        />
                        <div className="thought__head--live">
                          {line!.streaming
                            ? `Thinking… ${thinkElapsed}s`
                            : line!.seconds
                              ? `Thought for ${line!.seconds}s`
                              : 'Thought'}
                        </div>
                      </div>
                    ) : (
                      <div key={key} className={`line line--${line!.role}`}>
                        <span className="line__dot" />
                        {line!.role === 'agent' ? (
                          <AgentLine line={line!} onAction={handleAction} />
                        ) : (
                          <span className="line__text">
                            {line!.text}
                            {line!.streaming && <span className="caret" />}
                          </span>
                        )}
                      </div>
                    ),
                  )
                )}
                <div ref={endRef} />
              </main>
              <footer className="run__input">
                {running && !permMap[threadId] && (
                  <div className="runbar" aria-label="Loading">
                    <span className="runbar__dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                )}
                {permMap[threadId] && (
                  <div className="permbar">
                    <div className="permbar__head">
                      <span className="permbar__lock">🔒</span>
                      <div className="permbar__summary">
                        <div className="permbar__title">
                          {permMap[threadId]!.title}
                        </div>
                        <div className="permbar__note">
                          Outside this workspace — runs only if you approve.
                        </div>
                      </div>
                    </div>
                    {permMap[threadId]!.command && (
                      <button
                        className="permbar__toggle"
                        onClick={() => setPermOpen((v) => !v)}
                      >
                        {permOpen ? '▾ Hide command' : '▸ Show command'}
                      </button>
                    )}
                    {permOpen && permMap[threadId]!.command && (
                      <pre className="permbar__cmd">
                        {permMap[threadId]!.command}
                      </pre>
                    )}
                    <label className="permbar__remember">
                      <input
                        type="checkbox"
                        checked={permRemember}
                        onChange={(e) => setPermRemember(e.target.checked)}
                      />
                      Always allow{' '}
                      {permMap[threadId]!.categoryLabel ?? 'this'} in this
                      workspace
                    </label>
                    <div className="permbar__actions">
                      <button
                        className="permbar__deny"
                        onClick={() => respondPermission(false)}
                      >
                        Deny
                      </button>
                      <button
                        className="permbar__allow"
                        onClick={() => respondPermission(true)}
                      >
                        {permRemember ? 'Always allow' : 'Approve'}
                      </button>
                    </div>
                  </div>
                )}
                {pending.length > 0 && (
                  <div className="attachments">
                    {pending.map((f) => (
                      <span key={f.name} className="attach-chip">
                        📎 {f.name}
                        <button
                          className="attach-chip__x"
                          onClick={() => removePending(f.name)}
                          aria-label={`Remove ${f.name}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="composer">
                  <button
                    className="composer__add"
                    onClick={attachFiles}
                    title="Attach a file (uploads when you send)"
                    aria-label="Attach a file"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <textarea
                    ref={taRef}
                    className="composer__ta"
                    value={prompt}
                    rows={1}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      const t = e.target;
                      t.style.height = 'auto';
                      t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        runAgent();
                      }
                    }}
                    placeholder={
                      running
                        ? 'Send another message…'
                        : sessionId
                          ? 'Ask a follow-up…'
                          : `Ask ${selected.name}…`
                    }
                  />
                  {running ? (
                    <button
                      className="composer__btn composer__btn--stop"
                      onClick={stopAgent}
                      title="Stop"
                      aria-label="Stop"
                    >
                      <span className="composer__icon-stop" />
                    </button>
                  ) : (
                    <button
                      className="composer__btn"
                      onClick={() => runAgent()}
                      disabled={!prompt.trim() && pending.length === 0}
                      title="Send"
                      aria-label="Send"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 19V5M6 11l6-6 6 6" />
                      </svg>
                    </button>
                  )}
                </div>
              </footer>
              </div>

              {panelOpen && (
                <div
                  className="splitter"
                  onMouseDown={startPanelDrag}
                  title="Drag to resize"
                />
              )}
              {panelOpen && (
              <aside
                className="workspace"
                style={{ width: panelW }}
              >
                <div className="workspace__head">
                  <span className="workspace__tabs">
                    <button
                      className={`wstab ${wsTab === 'files' ? 'wstab--on' : ''}`}
                      onClick={() => setWsTab('files')}
                    >
                      Files
                    </button>
                    <button
                      className={`wstab ${wsTab === 'view' ? 'wstab--on' : ''}`}
                      onClick={() => setWsTab('view')}
                      title={viewHere ? activeView!.name : 'Canvas'}
                    >
                      Canvas
                      {viewHere && <span className="wstab__dot" />}
                    </button>
                  </span>
                  {wsTab === 'view' && viewHere ? (
                    <button
                      className="workspace__icon"
                      onClick={() => {
                        setActiveViews((v) => {
                          const next = { ...v };
                          delete next[selectedId];
                          return next;
                        });
                        setWsTab('files');
                        // Let this workspace's marker re-open the Canvas later.
                        for (const k of [...openedViewsRef.current]) {
                          if (k.startsWith(`${threadId}:`)) openedViewsRef.current.delete(k);
                        }
                      }}
                      title="Close canvas"
                      aria-label="Close canvas"
                    >
                      ×
                    </button>
                  ) : (
                    <button
                      className="workspace__icon"
                      onClick={() => selected && window.workspace.reveal(selected.id)}
                      title="Reveal folder in Finder"
                      aria-label="Reveal folder in Finder"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </button>
                  )}
                </div>

                {wsTab === 'files' && fileDir && (
                  <div className="workspace__crumbs">
                    <button className="crumb" onClick={() => navigateFiles('')}>
                      Files
                    </button>
                    {fileDir
                      .split('/')
                      .filter(Boolean)
                      .map((seg, i, arr) => (
                        <span key={seg + i}>
                          <span className="crumb__sep">/</span>
                          <button
                            className="crumb"
                            onClick={() => navigateFiles(arr.slice(0, i + 1).join('/'))}
                          >
                            {i === 0 && seg === 'input'
                              ? 'Shared'
                              : i === 0 && seg === 'output'
                                ? 'Created'
                                : seg}
                          </button>
                        </span>
                      ))}
                  </div>
                )}

                {/* Switch between the workspace's canvases when it has several. */}
                {wsTab === 'view' && viewHere && canvases.length > 1 && (
                  <div className="canvasbar">
                    {canvases.map((c) => (
                      <button
                        key={c.rel}
                        className={`canvasbar__item ${
                          activeView && activeView.rel === c.rel
                            ? 'canvasbar__item--on'
                            : ''
                        }`}
                        onClick={() => loadView(c.rel, c.name)}
                        title={c.name}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}

                {/* One iframe PER workspace that has a Canvas open. Each stays
                    mounted whenever it's loaded — hidden when you're in another
                    workspace or on the Files tab — so a player in one workspace
                    keeps playing while you work in another. Only the selected
                    workspace's frame is shown and wired to the bridge ref. */}
                {Object.entries(activeViews).map(([agentId, v]) => {
                  const isSelected = agentId === selectedId;
                  const visible =
                    isSelected && wsTab === 'view' && viewHere && !composingHere;
                  return (
                    <iframe
                      key={agentId}
                      ref={isSelected ? viewFrameRef : undefined}
                      className="viewpane"
                      style={{
                        display: visible ? 'block' : 'none',
                        pointerEvents: resizing ? 'none' : 'auto',
                      }}
                      sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms allow-downloads"
                      src={v.src}
                      title={v.name}
                    />
                  );
                })}

                {wsTab === 'view' && composingHere && (
                  <div className="canvas-empty">
                    <div className="composing">
                      <div className="composing__text">
                        Composing your Canvas…
                      </div>
                      <span className="composing__dots">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  </div>
                )}

                {wsTab === 'view' && !composingHere && !viewHere && (
                  <div className="canvas-empty">
                    <div className="canvas-empty__mark">◧</div>
                    <div className="canvas-empty__title">Canvas</div>
                    <div className="canvas-empty__body">
                      When a richer answer helps — a comparison, a dashboard, a
                      live player — {selected.name} builds it here instead of a
                      wall of text. Ask it to compare, plan, or lay something out.
                    </div>
                  </div>
                )}

                <div
                  className="workspace__list"
                  style={{ display: wsTab === 'files' ? 'flex' : 'none' }}
                >
                  {fileDir ? (
                    // Inside a subfolder — plain list with breadcrumb above.
                    files.length === 0 ? (
                      <div className="workspace__empty">This folder is empty.</div>
                    ) : (
                      files.map(renderFile)
                    )
                  ) : (
                    // Root — two human groups instead of input/output folders.
                    <>
                      <div className="wgroup">
                        <div className="wgroup__head">
                          <span>Shared</span>
                          <button
                            className="wgroup__add"
                            onClick={addShared}
                            title="Add files to share"
                            aria-label="Add files"
                          >
                            ＋
                          </button>
                        </div>
                        {sharedFiles.length === 0 ? (
                          <div className="wgroup__empty">
                            Files you give {selected.name} show up here.
                          </div>
                        ) : (
                          sharedFiles.map(renderFile)
                        )}
                      </div>
                      <div className="wgroup">
                        <div className="wgroup__head">
                          <span>Created</span>
                        </div>
                        {createdFiles.length === 0 ? (
                          <div className="wgroup__empty">
                            What {selected.name} makes for you shows up here.
                          </div>
                        ) : (
                          createdFiles.map(renderFile)
                        )}
                      </div>
                    </>
                  )}
                </div>
              </aside>
              )}
            </div>
          ) : (
            <div className="run__placeholder">
              No workspace selected.
              <br />
              Use ＋ to create one, then pick it here.
            </div>
          )}
        </section>
      )}

      {viewer && (
        <div className="modal__scrim" onClick={() => setViewer(null)}>
          <div className="viewer" onClick={(e) => e.stopPropagation()}>
            <div className="viewer__head">
              <div className="viewer__name">{viewer.name}</div>
              <div className="viewer__actions">
                <button
                  className="viewer__ext"
                  onClick={() => window.workspace.open(viewer.path)}
                >
                  Open externally
                </button>
                <button
                  className="modal__x"
                  onClick={() => setViewer(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="viewer__body">
              {viewer.kind === 'markdown' ? (
                <div
                  className="line__md"
                  dangerouslySetInnerHTML={{ __html: md(viewer.content ?? '') }}
                />
              ) : viewer.kind === 'text' ? (
                <pre className="viewer__text">{viewer.content}</pre>
              ) : viewer.kind === 'pdf' ? (
                <iframe
                  className="viewer__pdf"
                  src={viewer.dataUrl}
                  title={viewer.name}
                />
              ) : viewer.kind === 'image' ? (
                <img
                  className="viewer__img"
                  src={viewer.dataUrl}
                  alt={viewer.name}
                />
              ) : (
                <div className="viewer__msg">
                  {viewer.kind === 'toobig'
                    ? 'This file is too large to preview here.'
                    : viewer.kind === 'error'
                      ? (viewer.message ?? 'Could not open this file.')
                      : 'No in-app preview for this file type.'}
                  <button
                    className="viewer__ext"
                    onClick={() => window.workspace.open(viewer.path)}
                  >
                    Open in default app
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <div
          className="modal__scrim"
          onClick={() => !createBusy && setCreateOpen(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <div className="modal__title">New workspace</div>
              <button
                className="modal__x"
                onClick={() => !createBusy && setCreateOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal__desc">
              Describe what you want. Claude sets the workspace up — then it
              starts empty and grows its own files as you use it.
            </div>
            <div className="form">
              <label className="form__label">Name</label>
              <input
                className="form__input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Trip Planner"
                disabled={createBusy}
                autoFocus
              />
              <label className="form__label">What should it do?</label>
              <textarea
                className="form__ta"
                value={createBrief}
                onChange={(e) => setCreateBrief(e.target.value)}
                placeholder="e.g. Help me plan trips — research destinations, build day-by-day itineraries, and keep a packing list."
                disabled={createBusy}
                rows={4}
              />
              {createError && <div className="form__error">{createError}</div>}
            </div>
            <div className="modal__confirm">
              <button
                className="btn-ghost"
                onClick={() => setCreateOpen(false)}
                disabled={createBusy}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={createAgent}
                disabled={createBusy || !createName.trim()}
              >
                {createBusy ? 'Building…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && selected && (
        <div className="modal__scrim" onClick={closeSettings}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <div className="modal__title">{selected.name}</div>
              <button
                className="modal__x"
                onClick={closeSettings}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal__desc">{selected.description}</div>
            <div className="modal__meta">
              {selected.source?.startsWith('github:') && (
                <div>
                  Source ·{' '}
                  <button
                    className="modal__link"
                    onClick={() =>
                      window.shell.openExternal(
                        `https://github.com/${selected.source!.slice('github:'.length)}`,
                      )
                    }
                    title="Open on GitHub"
                  >
                    {selected.source.slice('github:'.length)}
                  </button>
                </div>
              )}
              {selected.source?.startsWith('folder:') && (
                <div>
                  Source ·{' '}
                  <button
                    className="modal__link"
                    onClick={() =>
                      window.workspace.open(selected.source!.slice('folder:'.length))
                    }
                    title="Reveal folder"
                  >
                    {selected.source.slice('folder:'.length)}
                  </button>
                </div>
              )}
              {selected.version && <div>Version · {selected.version}</div>}
              {selected.author && <div>Author · {selected.author}</div>}
            </div>

            {auth?.ok && (
              <div className="sched">
                <div className="sched__head">Claude account</div>
                <div className="sched__item">
                  <div className="sched__info">
                    <div className="sched__prompt">
                      {auth.method === 'apikey' ? 'API key' : 'Claude subscription'}
                    </div>
                    <div className="sched__when">
                      {auth.method === 'apikey'
                        ? 'Stored encrypted on this Mac · billed per token'
                        : 'Source build only — not permitted for distributed apps'}
                    </div>
                  </div>
                  {auth.method === 'apikey' && (
                    <div className="sched__actions">
                      <button
                        className="sched__btn"
                        onClick={() =>
                          window.system.setKey('').then(setAuth).catch(() => {})
                        }
                      >
                        Replace key
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {usage && usage.available && (
              <div className="sched">
                <div className="usage__head">
                  <span className="usage__title">Plan usage limits</span>
                  {usage.plan && (
                    <span className="usage__plan">{prettyPlan(usage.plan)}</span>
                  )}
                </div>

                {usage.session && (
                  <UsageWindow
                    w={usage.session}
                    sub={resetsIn(usage.session.resetsAt)}
                  />
                )}

                {(usage.weeklyAll || usage.weeklyModels.length > 0) && (
                  <>
                    <div className="usage__section">Weekly limits</div>
                    {usage.weeklyAll && (
                      <UsageWindow
                        w={usage.weeklyAll}
                        sub={resetsAt(usage.weeklyAll.resetsAt)}
                      />
                    )}
                    {usage.weeklyModels.map((w) => (
                      <UsageWindow
                        key={w.label}
                        w={w}
                        sub={
                          pct(w.utilization) === 0
                            ? `You haven’t used ${w.label} yet`
                            : resetsAt(w.resetsAt)
                        }
                      />
                    ))}
                  </>
                )}

                <div className="usage__foot">
                  <span>Last updated: {timeAgo(usage.updatedAt) || 'just now'}</span>
                  <button
                    className="usage__refresh"
                    onClick={refreshUsage}
                    disabled={usageBusy}
                    title="Refresh"
                    aria-label="Refresh usage"
                  >
                    ↻
                  </button>
                </div>
              </div>
            )}

            <div className="sched">
              <div className="sched__head">Connected tools</div>
              {mcpList.length > 0 &&
                mcpList.map((m) => (
                  <div
                    key={m.name}
                    className={`sched__item ${m.disabled ? 'is-paused' : ''}`}
                  >
                    <div className="sched__info">
                      <div className="sched__prompt">
                        {m.name}
                        {m.bundled && (
                          <span className="tag tag--bundled">bundled</span>
                        )}
                      </div>
                      <div className="sched__when">
                        {m.bundled
                          ? // Show what it will actually run — a bundled server can
                            // spawn any command, so don't hide that behind a label.
                            [m.command, ...(m.args ?? [])].filter(Boolean).join(' ') ||
                            m.url ||
                            'bundled tool'
                          : m.description || m.url || m.command}
                        {m.bundled && m.env && Object.keys(m.env).length > 0 && (
                          <> · carries {Object.keys(m.env).join(', ')}</>
                        )}
                      </div>
                    </div>
                    <div className="sched__actions">
                      {m.bundled ? (
                        <button
                          className="sched__btn"
                          onClick={() => setMcpEnabled(m.name, !!m.disabled)}
                        >
                          {m.disabled ? 'Enable' : 'Disable'}
                        </button>
                      ) : (
                        <button
                          className="sched__btn sched__btn--del"
                          onClick={() => removeMcp(m.name)}
                          aria-label="Remove tool"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                ))}

              {mcpCandidate ? (
                <div className="mcpcard">
                  <div className="mcpcard__name">{mcpCandidate.name}</div>
                  <div className="mcpcard__desc">{mcpCandidate.description}</div>
                  <div className="mcpcard__meta">
                    {mcpCandidate.transport.toUpperCase()} ·{' '}
                    {mcpCandidate.url ??
                      `${mcpCandidate.command} ${(mcpCandidate.args ?? []).join(' ')}`}
                  </div>
                  {mcpCandidate.authType === 'oauth' && (
                    <div className="mcpcard__auth">
                      🔐 {mcpCandidate.authNote || 'Opens a sign-in page in your browser on first use.'}
                    </div>
                  )}
                  {mcpCandidate.authType === 'key' && (
                    <div className="mcpcard__keywrap">
                      <div className="mcpcard__auth">
                        🔑 {mcpCandidate.authNote || 'Paste an API key or token.'}
                      </div>
                      <input
                        className="form__input"
                        type="password"
                        value={mcpKey}
                        onChange={(e) => setMcpKey(e.target.value)}
                        placeholder="API key / token"
                        autoComplete="off"
                      />
                    </div>
                  )}
                  <div className="mcpcard__actions">
                    <button
                      className="btn-ghost"
                      onClick={() => {
                        setMcpCandidate(null);
                        setMcpKey('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn-primary"
                      onClick={() => addMcp(mcpCandidate)}
                      disabled={mcpCandidate.authType === 'key' && !mcpKey.trim()}
                    >
                      Add to workspace
                    </button>
                  </div>
                </div>
              ) : (
                <div className="sched__form">
                  <div className="sched__row">
                    <input
                      className="form__input"
                      style={{ flex: 1 }}
                      value={mcpQuery}
                      onChange={(e) => setMcpQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && findMcp(mcpQuery)}
                      placeholder="Connect a tool by name — e.g. linear, notion, github"
                      disabled={mcpBusy}
                    />
                    <button
                      className="btn-primary"
                      onClick={() => findMcp(mcpQuery)}
                      disabled={mcpBusy || !mcpQuery.trim()}
                    >
                      {mcpBusy ? 'Finding…' : 'Find'}
                    </button>
                  </div>
                  {mcpError && <div className="form__error">{mcpError}</div>}
                  {mcpCatalog.filter((c) => !mcpList.some((m) => m.name === c.name))
                    .length > 0 && (
                    <div className="mcpsuggest">
                      {mcpCatalog
                        .filter((c) => !mcpList.some((m) => m.name === c.name))
                        .map((c) => (
                          <button
                            key={c.name}
                            className="cmd"
                            onClick={() => setMcpCandidate(c)}
                            title={c.description}
                          >
                            {c.name}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="sched">
              <div className="sched__head">Scheduled runs</div>
              {schedules.length === 0 ? (
                <div className="sched__empty">
                  Nothing scheduled. Add a task below and it'll run on its own in
                  the background.
                </div>
              ) : (
                schedules.map((s) => (
                  <div
                    key={s.id}
                    className={`sched__item ${s.enabled ? '' : 'is-paused'}`}
                  >
                    <div className="sched__info">
                      <div className="sched__prompt">{s.prompt}</div>
                      <div className="sched__when">
                        {s.kind === 'daily'
                          ? `Daily at ${s.time}`
                          : `Every ${s.minutes} min`}
                        {s.enabled ? ` · next ${timeUntil(s.nextRunAt)}` : ' · paused'}
                      </div>
                    </div>
                    <div className="sched__actions">
                      <button
                        className="sched__btn"
                        onClick={() => runScheduleNow(s.id)}
                      >
                        Run now
                      </button>
                      <button
                        className="sched__btn"
                        onClick={() => toggleSchedule(s)}
                      >
                        {s.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        className="sched__btn sched__btn--del"
                        onClick={() => deleteSchedule(s.id)}
                        aria-label="Delete schedule"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))
              )}

              <div className="sched__form">
                <input
                  className="form__input"
                  value={schedPrompt}
                  onChange={(e) => setSchedPrompt(e.target.value)}
                  placeholder="What should it do? e.g. Scan for new job openings"
                />
                <div className="sched__row">
                  <select
                    className="sched__select"
                    value={schedKind}
                    onChange={(e) =>
                      setSchedKind(e.target.value as 'daily' | 'interval')
                    }
                  >
                    <option value="daily">Daily at</option>
                    <option value="interval">Every</option>
                  </select>
                  {schedKind === 'daily' ? (
                    <input
                      className="sched__when-input"
                      type="time"
                      value={schedTime}
                      onChange={(e) => setSchedTime(e.target.value)}
                    />
                  ) : (
                    <>
                      <input
                        className="sched__when-input"
                        type="number"
                        min={5}
                        value={schedMinutes}
                        onChange={(e) => setSchedMinutes(Number(e.target.value))}
                      />
                      <span className="sched__unit">minutes</span>
                    </>
                  )}
                  <button
                    className="btn-primary"
                    onClick={addSchedule}
                    disabled={!schedPrompt.trim()}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            <div className="sched">
              <div className="sched__head">Permissions</div>
              {approvals.length === 0 ? (
                <div className="sched__empty">
                  No standing approvals. When you check “Always allow” on a
                  request, it appears here so you can revoke it.
                </div>
              ) : (
                approvals.map((ap) => (
                  <div key={ap.category} className="sched__item">
                    <div className="sched__info">
                      <div className="sched__prompt">Always allow {ap.label}</div>
                      <div className="sched__when">
                        Runs without asking in this workspace
                      </div>
                    </div>
                    <div className="sched__actions">
                      <button
                        className="sched__btn"
                        onClick={() => revokeApproval(ap.category)}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="modal__danger">
              {!confirmDelete ? (
                <button
                  className="btn-danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete workspace
                </button>
              ) : (
                <>
                  <div className="modal__warn">
                    Permanently delete the <b>{selected.name}</b> workspace and
                    all its files — its agent, chats, and any output it created.
                    This can’t be undone.
                  </div>
                  <div className="modal__confirm">
                    <button
                      className="btn-ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </button>
                    <button className="btn-danger" onClick={deleteSelected}>
                      Delete everything
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="modal__credit">
              Mocca — made by{' '}
              <button
                className="modal__link"
                onClick={() =>
                  window.shell.openExternal('https://github.com/valehelle')
                }
                title="Open Hazmi’s GitHub profile"
              >
                Hazmi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
