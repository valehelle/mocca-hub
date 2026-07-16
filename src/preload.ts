import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Line = { role: 'agent' | 'system' | 'tool' | 'thinking'; text: string };
type RunPayload = {
  task: string;
  instructions: string;
  allowedTools: string[];
  agentId: string;
  threadId: string;
  resume?: string;
};
type WsFile = {
  name: string;
  rel: string;
  path: string;
  size: number;
  isDir: boolean;
};
type FileContent = {
  kind: 'markdown' | 'text' | 'pdf' | 'image' | 'binary' | 'toobig' | 'error';
  name: string;
  content?: string;
  dataUrl?: string;
  message?: string;
};

type Kind = 'text' | 'thinking';

contextBridge.exposeInMainWorld('agent', {
  run: (payload: RunPayload) => ipcRenderer.send('agent:run', payload),
  stop: (threadId: string) => ipcRenderer.send('agent:stop', threadId),

  // A run began that the renderer didn't start (e.g. a scheduled run).
  onStarted: (
    cb: (p: { threadId: string; agentId: string; prompt: string }) => void,
  ) => {
    const handler = (
      _e: IpcRendererEvent,
      p: { threadId: string; agentId: string; prompt: string },
    ) => cb(p);
    ipcRenderer.on('agent:started', handler);
    return () => ipcRenderer.removeListener('agent:started', handler);
  },

  // A connected tool needs the user to sign in (its OAuth page just opened).
  onMcpAuth: (
    cb: (p: { threadId: string; server: string; message: string }) => void,
  ) => {
    const handler = (
      _e: IpcRendererEvent,
      p: { threadId: string; server: string; message: string },
    ) => cb(p);
    ipcRenderer.on('agent:mcp-auth', handler);
    return () => ipcRenderer.removeListener('agent:mcp-auth', handler);
  },

  onSession: (cb: (threadId: string, sessionId: string) => void) => {
    const handler = (
      _e: IpcRendererEvent,
      p: { threadId: string; sessionId: string },
    ) => cb(p.threadId, p.sessionId);
    ipcRenderer.on('agent:session', handler);
    return () => ipcRenderer.removeListener('agent:session', handler);
  },

  onMessage: (cb: (threadId: string, line: Line) => void) => {
    const handler = (_e: IpcRendererEvent, p: { threadId: string; line: Line }) =>
      cb(p.threadId, p.line);
    ipcRenderer.on('agent:message', handler);
    return () => ipcRenderer.removeListener('agent:message', handler);
  },

  onStreamStart: (cb: (threadId: string, kind: Kind) => void) => {
    const handler = (_e: IpcRendererEvent, p: { threadId: string; kind: Kind }) =>
      cb(p.threadId, p.kind);
    ipcRenderer.on('agent:stream-start', handler);
    return () => ipcRenderer.removeListener('agent:stream-start', handler);
  },

  onStreamDelta: (cb: (threadId: string, kind: Kind, text: string) => void) => {
    const handler = (
      _e: IpcRendererEvent,
      p: { threadId: string; kind: Kind; text: string },
    ) => cb(p.threadId, p.kind, p.text);
    ipcRenderer.on('agent:stream-delta', handler);
    return () => ipcRenderer.removeListener('agent:stream-delta', handler);
  },

  onStreamEnd: (cb: (threadId: string, kind: Kind) => void) => {
    const handler = (_e: IpcRendererEvent, p: { threadId: string; kind: Kind }) =>
      cb(p.threadId, p.kind);
    ipcRenderer.on('agent:stream-end', handler);
    return () => ipcRenderer.removeListener('agent:stream-end', handler);
  },

  // The agent wants to do something outside its sandbox (e.g. install system
  // software). Surface an approve/deny prompt; the answer goes back via respond.
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
  ) => {
    const handler = (
      _e: IpcRendererEvent,
      p: {
        threadId: string;
        id: string;
        tool: string;
        command?: string;
        title: string;
        category?: string;
        categoryLabel?: string;
      },
    ) => cb(p);
    ipcRenderer.on('agent:permission', handler);
    return () => ipcRenderer.removeListener('agent:permission', handler);
  },
  respondPermission: (id: string, allow: boolean, remember: boolean) =>
    ipcRenderer.send('agent:permission-response', id, allow, remember),

  onDone: (cb: (threadId: string) => void) => {
    const handler = (_e: IpcRendererEvent, p: { threadId: string }) =>
      cb(p.threadId);
    ipcRenderer.on('agent:done', handler);
    return () => ipcRenderer.removeListener('agent:done', handler);
  },

  onError: (cb: (threadId: string, message: string) => void) => {
    const handler = (
      _e: IpcRendererEvent,
      p: { threadId: string; message: string },
    ) => cb(p.threadId, p.message);
    ipcRenderer.on('agent:error', handler);
    return () => ipcRenderer.removeListener('agent:error', handler);
  },
});

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

type AgentDetails = {
  readme?: string;
  skills?: Array<{ name: string; description: string }>;
  mcp?: McpEntry[];
};

contextBridge.exposeInMainWorld('market', {
  registry: (): Promise<AgentPackage[]> => ipcRenderer.invoke('market:registry'),
  installed: (): Promise<AgentPackage[]> => ipcRenderer.invoke('market:installed'),
  details: (id: string): Promise<AgentDetails> =>
    ipcRenderer.invoke('market:details', id),
  install: (id: string): Promise<InstallResult> =>
    ipcRenderer.invoke('market:install', id),
  installGithub: (repo: string): Promise<InstallResult> =>
    ipcRenderer.invoke('market:installGithub', repo),
  installFolder: (): Promise<InstallResult> =>
    ipcRenderer.invoke('market:installFolder'),
  createAgent: (name: string, brief: string): Promise<InstallResult> =>
    ipcRenderer.invoke('market:createAgent', name, brief),
  uninstall: (id: string): Promise<AgentPackage[]> =>
    ipcRenderer.invoke('market:uninstall', id),
});

contextBridge.exposeInMainWorld('shell', {
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url),
});

// Workspace-scoped file access for the in-app view bridge (see App.tsx). The
// renderer mediates; the sandboxed view never gets these directly.
contextBridge.exposeInMainWorld('view', {
  baseUrl: (): Promise<string> => ipcRenderer.invoke('view:baseUrl'),
  canvases: (agentId: string): Promise<Array<{ name: string; rel: string }>> =>
    ipcRenderer.invoke('view:canvases', agentId),
  read: (agentId: string, rel: string): Promise<string> =>
    ipcRenderer.invoke('view:read', agentId, rel),
  write: (agentId: string, rel: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('view:write', agentId, rel, content),
  list: (agentId: string, rel = ''): Promise<WsFile[]> =>
    ipcRenderer.invoke('view:list', agentId, rel),
});

type Approval = { category: string; label: string };
contextBridge.exposeInMainWorld('approvals', {
  list: (agentId: string): Promise<Approval[]> =>
    ipcRenderer.invoke('approvals:list', agentId),
  revoke: (agentId: string, category: string): Promise<Approval[]> =>
    ipcRenderer.invoke('approvals:revoke', agentId, category),
});

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

contextBridge.exposeInMainWorld('system', {
  hasHomebrew: (): Promise<boolean> => ipcRenderer.invoke('system:hasHomebrew'),
  installHomebrew: (): Promise<void> =>
    ipcRenderer.invoke('system:installHomebrew'),
  authStatus: (): Promise<{ ok: boolean; method: 'apikey' | 'oauth' | 'none' }> =>
    ipcRenderer.invoke('system:authStatus'),
  // Plan usage limits (the /usage panel data) — for Settings.
  usage: (): Promise<UsageSnapshot | null> => ipcRenderer.invoke('system:usage'),
  usageCached: (): Promise<UsageSnapshot | null> =>
    ipcRenderer.invoke('system:usageCached'),
});

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
  bundled?: boolean;
  disabled?: boolean;
};

contextBridge.exposeInMainWorld('mcp', {
  catalog: (): Promise<McpEntry[]> => ipcRenderer.invoke('mcp:catalog'),
  list: (agentId: string): Promise<McpEntry[]> =>
    ipcRenderer.invoke('mcp:list', agentId),
  resolve: (name: string): Promise<McpEntry | { error: string }> =>
    ipcRenderer.invoke('mcp:resolve', name),
  add: (agentId: string, entry: McpEntry): Promise<McpEntry[]> =>
    ipcRenderer.invoke('mcp:add', agentId, entry),
  remove: (agentId: string, name: string): Promise<McpEntry[]> =>
    ipcRenderer.invoke('mcp:remove', agentId, name),
  setEnabled: (
    agentId: string,
    name: string,
    enabled: boolean,
  ): Promise<McpEntry[]> =>
    ipcRenderer.invoke('mcp:setEnabled', agentId, name, enabled),
});

contextBridge.exposeInMainWorld('schedules', {
  list: (agentId: string): Promise<Schedule[]> =>
    ipcRenderer.invoke('schedules:list', agentId),
  save: (agentId: string, s: Partial<Schedule>): Promise<Schedule[]> =>
    ipcRenderer.invoke('schedules:save', agentId, s),
  delete: (agentId: string, id: string): Promise<Schedule[]> =>
    ipcRenderer.invoke('schedules:delete', agentId, id),
  runNow: (agentId: string, id: string): Promise<Schedule[]> =>
    ipcRenderer.invoke('schedules:runNow', agentId, id),
});

contextBridge.exposeInMainWorld('threads', {
  list: (
    agentId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: number }>> =>
    ipcRenderer.invoke('threads:list', agentId),
  load: (
    agentId: string,
    threadId: string,
  ): Promise<{ sessionId: string | null; log: unknown[] } | null> =>
    ipcRenderer.invoke('threads:load', agentId, threadId),
  save: (agentId: string, threadId: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('threads:save', agentId, threadId, data),
  delete: (agentId: string, threadId: string): Promise<void> =>
    ipcRenderer.invoke('threads:delete', agentId, threadId),
});

contextBridge.exposeInMainWorld('workspace', {
  list: (agentId: string, relPath = ''): Promise<WsFile[]> =>
    ipcRenderer.invoke('workspace:list', agentId, relPath),
  pick: (): Promise<string[]> => ipcRenderer.invoke('workspace:pick'),
  commit: (agentId: string, paths: string[]): Promise<WsFile[]> =>
    ipcRenderer.invoke('workspace:commit', agentId, paths),
  open: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('workspace:open', filePath),
  read: (filePath: string): Promise<FileContent> =>
    ipcRenderer.invoke('workspace:read', filePath),
  reveal: (agentId: string): Promise<void> =>
    ipcRenderer.invoke('workspace:reveal', agentId),
});
