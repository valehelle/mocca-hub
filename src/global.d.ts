export {};

type Line = { role: 'agent' | 'system' | 'tool' | 'thinking'; text: string };
type AuthStatus = {
  ok: boolean;
  method: 'apikey' | 'oauth' | 'none';
  canUseSubscription: boolean;
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
type RunPayload = {
  task: string;
  instructions: string;
  allowedTools: string[];
  agentId: string;
  threadId: string;
  resume?: string;
};
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
type McpEntry = {
  name: string;
  description?: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  needsAuth?: boolean;
  authNote?: string;
  bundled?: boolean; // shipped by the plugin's own .mcp.json
  disabled?: boolean; // bundled server the user switched off
};
type WsFile = {
  name: string;
  rel: string;
  path: string;
  size: number;
  isDir: boolean;
};
type AgentPackage = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  allowedTools: string[];
  examplePrompt: string;
  instructions: string;
  version?: string;
  author?: string;
  source?: string;
  commands?: { command: string; label: string }[];
  category?: string; // marketplace grouping, e.g. "Career"
  tagline?: string; // one-liner shown on the marketplace card
  featured?: boolean; // surfaced in the featured row
};
type InstallResult =
  | { ok: true; id: string; installed: AgentPackage[] }
  | { ok: false; error: string };

declare global {
  interface Window {
    agent: {
      run: (payload: RunPayload) => void;
      stop: (threadId: string) => void;
      onStarted: (
        cb: (p: { threadId: string; agentId: string; prompt: string }) => void,
      ) => () => void;
      onMcpAuth: (
        cb: (p: { threadId: string; server: string; message: string }) => void,
      ) => () => void;
      onSession: (
        cb: (threadId: string, sessionId: string) => void,
      ) => () => void;
      onMessage: (cb: (threadId: string, line: Line) => void) => () => void;
      onStreamStart: (
        cb: (threadId: string, kind: 'text' | 'thinking') => void,
      ) => () => void;
      onStreamDelta: (
        cb: (threadId: string, kind: 'text' | 'thinking', text: string) => void,
      ) => () => void;
      onStreamEnd: (
        cb: (threadId: string, kind: 'text' | 'thinking') => void,
      ) => () => void;
      onPermission: (
        cb: (p: {
          threadId: string;
          id: string;
          tool: string;
          command?: string;
          title: string;
          category?: string;
          categoryLabel?: string;
        }) => void,
      ) => () => void;
      respondPermission: (id: string, allow: boolean, remember: boolean) => void;
      onDone: (cb: (threadId: string) => void) => () => void;
      onError: (cb: (threadId: string, message: string) => void) => () => void;
    };
    workspace: {
      list: (agentId: string, relPath?: string) => Promise<WsFile[]>;
      pick: () => Promise<string[]>;
      commit: (agentId: string, paths: string[]) => Promise<WsFile[]>;
      open: (filePath: string) => Promise<void>;
      read: (filePath: string) => Promise<{
        kind: 'markdown' | 'text' | 'pdf' | 'image' | 'binary' | 'toobig' | 'error';
        name: string;
        content?: string;
        dataUrl?: string;
        message?: string;
      }>;
      reveal: (agentId: string) => Promise<void>;
    };
    shell: {
      openExternal: (url: string) => Promise<void>;
    };
    view: {
      baseUrl: () => Promise<string>;
      canvases: (
        agentId: string,
      ) => Promise<Array<{ name: string; rel: string }>>;
      read: (agentId: string, rel: string) => Promise<string>;
      write: (agentId: string, rel: string, content: string) => Promise<boolean>;
      list: (agentId: string, rel?: string) => Promise<WsFile[]>;
    };
    system: {
      hasHomebrew: () => Promise<boolean>;
      installHomebrew: () => Promise<void>;
      authStatus: () => Promise<AuthStatus>;
      setKey: (key: string) => Promise<AuthStatus>;
      hasStoredKey: () => Promise<boolean>;
      usage: () => Promise<UsageSnapshot | null>;
      usageCached: () => Promise<UsageSnapshot | null>;
    };
    approvals: {
      list: (
        agentId: string,
      ) => Promise<Array<{ category: string; label: string }>>;
      revoke: (
        agentId: string,
        category: string,
      ) => Promise<Array<{ category: string; label: string }>>;
    };
    mcp: {
      catalog: () => Promise<McpEntry[]>;
      list: (agentId: string) => Promise<McpEntry[]>;
      resolve: (name: string) => Promise<McpEntry | { error: string }>;
      add: (agentId: string, entry: McpEntry) => Promise<McpEntry[]>;
      remove: (agentId: string, name: string) => Promise<McpEntry[]>;
      setEnabled: (
        agentId: string,
        name: string,
        enabled: boolean,
      ) => Promise<McpEntry[]>;
    };
    schedules: {
      list: (agentId: string) => Promise<Schedule[]>;
      save: (agentId: string, s: Partial<Schedule>) => Promise<Schedule[]>;
      delete: (agentId: string, id: string) => Promise<Schedule[]>;
      runNow: (agentId: string, id: string) => Promise<Schedule[]>;
    };
    threads: {
      list: (
        agentId: string,
      ) => Promise<Array<{ id: string; title: string; updatedAt: number }>>;
      load: (
        agentId: string,
        threadId: string,
      ) => Promise<{ sessionId: string | null; log: unknown[] } | null>;
      save: (
        agentId: string,
        threadId: string,
        data: unknown,
      ) => Promise<void>;
      delete: (agentId: string, threadId: string) => Promise<void>;
    };
    market: {
      registry: () => Promise<AgentPackage[]>;
      installed: () => Promise<AgentPackage[]>;
      details: (id: string) => Promise<{
        readme?: string;
        skills?: Array<{ name: string; description: string }>;
        mcp?: McpEntry[];
      }>;
      install: (id: string) => Promise<InstallResult>;
      installGithub: (repo: string) => Promise<InstallResult>;
      installFolder: () => Promise<InstallResult>;
      createAgent: (name: string, brief: string) => Promise<InstallResult>;
      uninstall: (id: string) => Promise<AgentPackage[]>;
    };
  }
}
