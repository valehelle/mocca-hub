import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import started from 'electron-squirrel-startup';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const execFileP = promisify(execFile);

// ── In-app view server ───────────────────────────────────────────────────────
// Interactive views are served from a loopback HTTP origin, NOT srcdoc. srcdoc
// inherits Mocca's origin, so a view rendered that way would either be crippled
// (no same-origin → opaque origin → YouTube/many embeds refuse to run) or unsafe
// (same-origin → reaches Mocca's renderer + preload). A real http://127.0.0.1
// origin fixes both: embeds get a genuine web origin AND the frame stays
// cross-origin to Mocca, so it still can't touch the app internals.
//
// A random path token gates the server so other local processes can't guess
// URLs; every file read is scoped to the requesting workspace and refuses `..`.
const VIEW_TOKEN = randomBytes(16).toString('hex');
let viewServerPort = 0;

const VIEW_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

// Injected into every HTML view — the ONLY channel back to Mocca (postMessage,
// validated cross-origin on the renderer side).
const VIEW_BRIDGE_JS = `<script>(function(){
  var pending={}, seq=0;
  function call(verb,args){return new Promise(function(res,rej){
    var id=++seq; pending[id]={res:res,rej:rej};
    parent.postMessage({__mocca:true,id:id,verb:verb,args:args||{}},'*');});}
  window.addEventListener('message',function(e){
    var d=e.data; if(!d||!d.__moccaReply) return;
    var p=pending[d.id]; if(!p) return; delete pending[d.id];
    d.error?p.rej(new Error(d.error)):p.res(d.result);});
  window.mocca={
    chat:{send:function(t){return call('chat.send',{text:t});}},
    files:{read:function(p){return call('files.read',{path:p});},
      write:function(p,c){return call('files.write',{path:p,content:c});},
      list:function(p){return call('files.list',{path:p});}}
  };
})();</script>`;

// Mocca's design language — Swiss / International Typographic Style, dark: big
// bold type, tabular numerals, hairline rules, flat (no shadows/gradients),
// generous whitespace, one accent. Injected into every Canvas so agent pages
// look native. Agents compose these components; their own <style> comes after
// and can override for a genuinely custom app.
const MOCCA_CANVAS_CSS = `
:root{
  --bg:#0e0f13;--panel:#16181e;--panel-2:#1b1e26;--line:#2a2e38;
  --text:#f2f3f7;--muted:#9297a6;--accent:#d97757;--maxw:960px;color-scheme:dark;
}
*{box-sizing:border-box}
/* Mobile-first: the Canvas is a NARROW vertical panel by default and can be
   widened. Padding, type, and grids all scale with the panel's own width. */
body{margin:0;background:var(--bg);color:var(--text);
  font-family:"Helvetica Neue",Helvetica,Arial,-apple-system,system-ui,sans-serif;
  font-size:15px;line-height:1.55;letter-spacing:-.005em;
  padding:clamp(18px,4.5vw,48px) clamp(16px,4.5vw,40px);
  padding-bottom:clamp(48px,10vw,96px);-webkit-font-smoothing:antialiased}
.container{max-width:var(--maxw);margin:0 auto}
.section{margin:2.2em 0}
/* Type — big, bold, tight; shrinks gracefully in a narrow panel */
h1,.h1{font-size:clamp(26px,6.5vw,52px);font-weight:800;line-height:1.03;letter-spacing:-.03em;margin:0 0 .3em}
h2,.h2{font-size:clamp(20px,4.5vw,30px);font-weight:800;line-height:1.1;letter-spacing:-.02em;margin:1.6em 0 .45em}
h3,.h3{font-size:16px;font-weight:700;letter-spacing:-.01em;margin:1.3em 0 .3em}
h1:first-child,h2:first-child,h3:first-child{margin-top:0}
p{margin:.6em 0;max-width:66ch}
.lead{font-size:19px;line-height:1.5;max-width:60ch;color:var(--text)}
.overline{display:block;font-size:12px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;color:var(--accent);margin-bottom:.7em}
.muted{color:var(--muted)}.accent{color:var(--accent)}
strong,b{font-weight:700;color:#fff}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
a:hover{border-bottom-color:currentColor}
hr,.rule{border:none;border-top:1px solid var(--line);margin:2.2em 0}
code{font-family:"SF Mono",ui-monospace,Menlo,monospace;background:var(--panel-2);padding:2px 6px;border-radius:3px;font-size:.88em}
pre{background:var(--panel);border:1px solid var(--line);padding:16px;border-radius:4px;overflow:auto}
/* Layout — all grids reflow: 1 column narrow, more as the panel widens */
.grid{display:grid;gap:clamp(14px,2.5vw,24px);grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.grid-2{display:grid;gap:clamp(14px,2.5vw,24px);grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.grid-3{display:grid;gap:clamp(14px,2.5vw,24px);grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.row{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.stack{display:flex;flex-direction:column;gap:10px}
/* Wrap a wide table so it scrolls instead of overflowing a narrow panel */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
/* Stat — big numerals over a rule */
.stat{border-top:2px solid var(--text);padding-top:12px}
.stat__num{font-size:clamp(34px,5vw,54px);font-weight:800;line-height:1;
  letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.stat__label{font-size:12px;font-weight:600;letter-spacing:.06em;
  text-transform:uppercase;color:var(--muted);margin-top:8px}
.stat--accent .stat__num{color:var(--accent)}
/* Card — flat, ruled, generous */
.card{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:clamp(16px,3vw,22px)}
.card__title{font-size:16px;font-weight:700;letter-spacing:-.01em;margin:0 0 8px}
/* Table — spare, ruled, tabular */
table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14px;font-variant-numeric:tabular-nums}
thead th{text-align:left;font-size:12px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;color:var(--muted);padding:0 14px 10px;border-bottom:2px solid var(--text)}
tbody td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:hover{background:var(--panel)}
/* Badge — minimal */
.badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;
  text-transform:uppercase;padding:3px 8px;border:1px solid var(--line);border-radius:3px;color:var(--muted)}
.badge--accent{color:var(--accent);border-color:var(--accent)}
/* Button — flat, bold */
.btn{display:inline-flex;align-items:center;gap:8px;font-family:inherit;font-size:14px;
  font-weight:700;padding:11px 20px;border:none;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer}
.btn:hover{filter:brightness(1.08)}
.btn--ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.btn--ghost:hover{border-color:var(--text)}
/* Progress */
.bar{height:6px;background:var(--panel-2);overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent)}
/* Tabs — underline; scroll sideways if they don't fit the panel */
.tabs{display:flex;gap:22px;border-bottom:1px solid var(--line);margin:1.5em 0;overflow-x:auto;-webkit-overflow-scrolling:touch}
.tab{white-space:nowrap}
.tab{padding:0 0 12px;margin-bottom:-1px;font-weight:700;font-size:14px;color:var(--muted);
  cursor:pointer;border-bottom:2px solid transparent;background:none;border-top:0;border-left:0;border-right:0}
.tab--on{color:var(--text);border-bottom-color:var(--accent)}
/* List — ruled rows */
ul,ol{padding-left:1.3em}li{margin:.35em 0}
.list{list-style:none;padding:0;margin:1em 0}
.list>li{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid var(--line);margin:0}
/* App shell — STABLE layout so nothing jumps when state changes. Fixed header +
   fixed control bar, scrolling body. Persistent controls (a player's transport,
   a now-playing line) live in .app__bar and update IN PLACE. */
/* Normal docs grow with their content so the page scrolls naturally; only the
   .app shell is pinned to the viewport (and scrolls internally via .app__body).
   Forcing height:100% on every body pinned long docs to viewport height, which
   could clip/kill scrolling depending on the agent's markup. */
html,body{min-height:100%}
body:has(.app){padding:0;height:100%;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh}
.app__header{flex-shrink:0;padding:16px clamp(16px,4vw,24px);border-bottom:1px solid var(--line)}
.app__body{flex:1;min-height:0;overflow:auto;padding:clamp(16px,4vw,24px);padding-bottom:clamp(40px,8vw,72px)}
.app__bar{flex-shrink:0;display:flex;align-items:center;gap:14px;
  padding:12px clamp(16px,4vw,24px);border-top:1px solid var(--line);background:var(--panel)}`;

// Insert Mocca's kit + the bridge into an agent HTML doc without breaking it:
// after <head> if present, else open one after <html>, else after <!doctype>,
// else prepend. (Prepending before <!doctype> would force quirks mode.)
function injectCanvasHead(html: string, inject: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head) {
    const at = head.index! + head[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) {
    const at = htmlTag.index! + htmlTag[0].length;
    return html.slice(0, at) + '<head>' + inject + '</head>' + html.slice(at);
  }
  const dt = html.match(/<!doctype[^>]*>/i);
  if (dt) {
    const at = dt.index! + dt[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  return inject + html;
}

function startViewServer(): void {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      // /<token>/<agentId>/<rel...>
      if (parts[0] !== VIEW_TOKEN) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const agentId = decodeURIComponent(parts[1] || '');
      const rel = parts.slice(2).map(decodeURIComponent).join('/');
      const root = workDir(agentId);
      const full = path.resolve(root, rel || '');
      if (full !== root && !full.startsWith(root + path.sep)) {
        res.writeHead(403).end('outside workspace');
        return;
      }
      const buf = await fsp.readFile(full);
      const ext = path.extname(full).toLowerCase();
      const type = VIEW_MIME[ext] ?? 'application/octet-stream';
      if (ext === '.html' || ext === '.htm') {
        // Give every Canvas Mocca's design language + the bridge.
        const html = injectCanvasHead(
          buf.toString('utf8'),
          `<style>${MOCCA_CANVAS_CSS}</style>${VIEW_BRIDGE_JS}`,
        );
        res.writeHead(200, { 'Content-Type': type }).end(html);
      } else {
        res.writeHead(200, { 'Content-Type': type }).end(buf);
      }
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  // Ephemeral port, loopback only. Bind to localhost (127.0.0.1) but SERVE from
  // the `localhost` hostname — YouTube (and other Google embeds) accept a
  // `localhost` referrer but reject the raw `127.0.0.1` IP.
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') viewServerPort = addr.port;
  });
}

function viewBaseUrl(): string {
  return `http://localhost:${viewServerPort}/${VIEW_TOKEN}`;
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  // In dev the dock shows Electron's icon unless we set it explicitly.
  if (process.platform === 'darwin' && app.dock) {
    const devIcon = path.join(app.getAppPath(), 'assets', 'icon.png');
    if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  }

  const mainWindow = new BrowserWindow({
    title: 'Mocca',
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Let a Canvas start its own media without the user clicking first —
      // agents build players/dashboards that should just play.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ── Per-agent workspace ──────────────────────────────────────────────────────
// Each agent gets its own directory under userData/workspaces/<agentId>. The
// agent runs with cwd set here, so everything it reads/writes stays in its own
// space, and the user can view/upload files through the Workspace panel.
type WsFile = {
  name: string; // display name within the current folder
  rel: string; // path relative to the workspace root, e.g. "input/cv.pdf"
  path: string; // absolute path
  size: number;
  isDir: boolean;
};

function workspaceDir(agentId: string): string {
  const safe = (agentId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(app.getPath('userData'), 'workspaces', safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A plugin agent is cloned to agents/<id>/plugin and RUNS inside that dir, so
// its own files (modes/, scripts, templates) are the working dir and relative
// reads resolve. Non-plugin agents use a plain empty workspace.
function pluginDir(agentId: string): string {
  const safe = (agentId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(agentsDir(), safe, 'plugin');
}
// Every workspace exposes exactly two folders to the user: input/ (files they
// hand the agent) and output/ (everything the agent produces for them).
const IO_DIRS = ['input', 'output'] as const;

function workDir(agentId: string): string {
  const pdir = pluginDir(agentId);
  const dir = fs.existsSync(pdir) ? pdir : workspaceDir(agentId);
  for (const d of IO_DIRS) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

function inputDir(agentId: string): string {
  const dir = path.join(workDir(agentId), 'input');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Everything an agent installs must stay inside its workspace so (a) it's
// contained and (b) deleting the workspace removes it. The Seatbelt sandbox
// already blocks writes outside cwd; these env vars go one step further and
// point every package manager's cache + global-install target at a hidden
// `.local` folder inside the workspace, so `npm i -g`, `pip install`, cargo,
// go, etc. succeed *into the workspace* instead of erroring on a blocked
// system path. We deliberately do NOT override HOME — the Claude CLI reads the
// user's login from ~/.claude and must keep working.
function containEnv(cwd: string): Record<string, string> {
  const p = (...s: string[]): string => path.join(cwd, '.local', ...s);
  const bin = p('bin');
  return {
    npm_config_cache: p('npm-cache'),
    npm_config_prefix: p('npm-global'),
    YARN_CACHE_FOLDER: p('yarn-cache'),
    PNPM_HOME: p('pnpm'),
    PIP_CACHE_DIR: p('pip-cache'),
    PYTHONUSERBASE: p('python'), // `pip install --user` lands here
    PIPX_HOME: p('pipx'),
    PIPX_BIN_DIR: bin,
    CARGO_HOME: p('cargo'),
    RUSTUP_HOME: p('rustup'),
    GOPATH: p('go'),
    GOBIN: bin,
    GOCACHE: p('go-cache'),
    XDG_DATA_HOME: p('share'),
    XDG_CACHE_HOME: p('cache'),
    XDG_STATE_HOME: p('state'),
    XDG_CONFIG_HOME: p('config'),
    // Claude Code plugins persist per-plugin data here (the standard var). The
    // CLI substitutes it in plugin configs but doesn't export it to Bash, so
    // plugins fall back to ~/.<something> outside the sandbox. Pointing it into
    // the workspace keeps that data contained and writable without a prompt.
    CLAUDE_PLUGIN_DATA: p('plugin-data'),
    // Put the workspace-local bin dirs first so freshly-installed CLIs run.
    PATH: [bin, p('npm-global', 'bin'), p('go', 'bin'), p('cargo', 'bin'), process.env.PATH ?? '']
      .filter(Boolean)
      .join(path.delimiter),
  };
}

// The real brew, if Homebrew is installed (Apple Silicon or Intel prefix). Used
// only to detect Homebrew for the user-initiated "Install Homebrew" flow — the
// agent itself can't install system software without the user approving it.
function realBrew(): string | null {
  for (const c of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Approvals the user chose to remember, per workspace. Grouped by a coarse
// category so "always allow" covers the recurring action (e.g. all audio
// playback) rather than one exact command. Kept in userData so it survives
// restarts; cleared when the workspace is deleted.
function approvalsFile(): string {
  return path.join(app.getPath('userData'), 'approvals.json');
}
function loadApprovals(): Record<string, string[]> {
  try {
    return JSON.parse(fs.readFileSync(approvalsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveApprovals(a: Record<string, string[]>): void {
  try {
    fs.writeFileSync(approvalsFile(), JSON.stringify(a, null, 2));
  } catch {
    /* best effort */
  }
}
function rememberApproval(agentId: string, category: string): void {
  const a = loadApprovals();
  const list = a[agentId] ?? [];
  if (!list.includes(category)) a[agentId] = [...list, category];
  saveApprovals(a);
}
function isApproved(agentId: string, category: string): boolean {
  return (loadApprovals()[agentId] ?? []).includes(category);
}

// The recurring "kind" of a command, so an always-allow covers similar future
// commands instead of just the exact one.
function approvalCategory(command: string): string {
  if (/\bbrew\b/i.test(command)) return 'homebrew';
  if (/\bsudo\b/i.test(command)) return 'sudo';
  if (/\b(apt|apt-get|dnf|yum|pacman|zypper|apk|port|snap|mas)\b/i.test(command))
    return 'syspkg';
  if (/\b(ffplay|mpv|afplay|vlc|cvlc|paplay|aplay)\b/i.test(command))
    return 'audio';
  return 'sandbox-escape';
}
// Human label for the "always allow …" line.
function categoryLabel(category: string): string {
  switch (category) {
    case 'homebrew':
      return 'Homebrew installs';
    case 'sudo':
      return 'admin (sudo) commands';
    case 'syspkg':
      return 'system package installs';
    case 'audio':
      return 'audio playback';
    default:
      return 'commands that reach outside the workspace';
  }
}

// A short, human sentence describing what an approval request will actually do,
// so the prompt reads like plain language instead of a wall of shell.
function describeApproval(command: string): string {
  const brew = command.match(/\bbrew\s+install\s+([\w@+./-]+)/i);
  if (brew) return `Install “${brew[1]}” with Homebrew (system-wide software)`;
  if (/\bbrew\s+(upgrade|reinstall|tap|link|pin|bundle)\b/i.test(command))
    return 'Change Homebrew packages on your Mac (system-wide)';
  if (/\bsudo\b/i.test(command))
    return 'Run a command as administrator (sudo)';
  const apt = command.match(
    /\b(?:apt(?:-get)?|dnf|yum|zypper|apk|port|snap)\s+(?:install|add)\s+([\w.+-]+)/i,
  );
  if (apt) return `Install “${apt[1]}” (system package)`;
  if (/\b(dnf|yum|pacman|zypper|apk|port|snap|mas)\b/i.test(command))
    return 'Install system software on your Mac';
  if (/\b(ffplay|mpv|afplay|vlc|cvlc|paplay|aplay)\b/i.test(command))
    return 'Play audio through your speakers (needs system audio access)';
  return 'Run a command that reaches outside its workspace';
}

// A Bash command that installs system-wide software or otherwise needs to write
// outside the workspace — the things the sandbox blocks and that require the
// user's explicit approval before they run unsandboxed.
function needsSystemApproval(command: string): boolean {
  return (
    /\bsudo\b/i.test(command) ||
    /\bbrew\s+(install|upgrade|reinstall|tap|link|pin|bundle)\b/i.test(command) ||
    /\bapt(-get)?\s+(install|upgrade)\b/i.test(command) ||
    /\bdnf\s+install\b/i.test(command) ||
    /\byum\s+install\b/i.test(command) ||
    /\bpacman\s+-S\b/i.test(command) ||
    /\bzypper\s+(in|install)\b/i.test(command) ||
    /\bapk\s+add\b/i.test(command) ||
    /\bport\s+install\b/i.test(command) ||
    /\bsnap\s+install\b/i.test(command) ||
    /\bmas\s+install\b/i.test(command)
  );
}

// Browse one directory of a workspace. The user only ever sees input/ and
// output/ — at the root we list just those two; below them, real contents.
async function listWorkspace(agentId: string, relPath = ''): Promise<WsFile[]> {
  const root = workDir(agentId);
  // Never escape the workspace, and never leave the two visible folders.
  const safeRel = relPath.split('/').filter((p) => p && p !== '..').join('/');
  const out: WsFile[] = [];

  if (!safeRel) {
    for (const d of IO_DIRS) {
      const full = path.join(root, d);
      if (fs.existsSync(full)) {
        out.push({ name: d, rel: d, path: full, size: 0, isDir: true });
      }
    }
    return out;
  }
  if (!IO_DIRS.includes(safeRel.split('/')[0] as (typeof IO_DIRS)[number])) return [];

  let shipped = new Set<string>();
  try {
    const m = JSON.parse(
      await fsp.readFile(path.join(pluginDir(agentId), '.agenthub-shipped.json'), 'utf8'),
    );
    shipped = new Set<string>(m.paths ?? []);
  } catch {
    /* not a plugin agent */
  }

  const dir = path.join(root, safeRel);
  if (!fs.existsSync(dir)) return [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = `${safeRel}/${e.name}`;
    if (!e.isDirectory() && shipped.has(rel)) continue; // plugin's own file
    const full = path.join(dir, e.name);
    const size = e.isDirectory() ? 0 : (await fsp.stat(full)).size;
    out.push({ name: e.name, rel, path: full, size, isDir: e.isDirectory() });
  }
  // Folders first, then files, each alphabetical.
  return out.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}

ipcMain.handle('workspace:list', (_e, agentId: string, relPath = '') =>
  listWorkspace(agentId, relPath),
);

ipcMain.handle('workspace:open', async (_e, filePath: string) => {
  await shell.openPath(filePath);
});

// Read a file for the in-app viewer. Text/markdown come back as a string; PDFs
// and images as data URLs; anything else is flagged for "open externally".
const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.csv', '.tsv', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.py', '.rb', '.go', '.rs', '.sh', '.yml', '.yaml', '.toml', '.ini',
  '.html', '.css', '.scss', '.xml', '.log', '.tex', '.env', '.sql', '.conf',
]);

ipcMain.handle('workspace:read', async (_e, filePath: string) => {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const st = await fsp.stat(filePath).catch((): null => null);
  if (!st) return { kind: 'error', name, message: 'File not found.' };
  const MAX_BIN = 12 * 1024 * 1024;
  const MAX_TXT = 2 * 1024 * 1024;

  if (ext === '.pdf') {
    if (st.size > MAX_BIN) return { kind: 'toobig', name };
    const buf = await fsp.readFile(filePath);
    return {
      kind: 'pdf',
      name,
      dataUrl: `data:application/pdf;base64,${buf.toString('base64')}`,
    };
  }
  if (ext in IMG_MIME) {
    if (st.size > MAX_BIN) return { kind: 'toobig', name };
    const buf = await fsp.readFile(filePath);
    return {
      kind: 'image',
      name,
      dataUrl: `data:${IMG_MIME[ext]};base64,${buf.toString('base64')}`,
    };
  }
  if (TEXT_EXT.has(ext) || ext === '') {
    if (st.size > MAX_TXT) return { kind: 'toobig', name };
    return { kind: ext === '.md' ? 'markdown' : 'text', name, content: await fsp.readFile(filePath, 'utf8') };
  }
  return { kind: 'binary', name };
});

ipcMain.handle('shell:openExternal', async (_e, url: string) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});

// Native tools (mpv, ffmpeg, …) come from Homebrew, which agents can't install
// for themselves (needs the user's admin password + a real terminal). Report
// whether it's present, and — on request — launch the official installer in
// Terminal so the user just enters their password once.
ipcMain.handle('system:hasHomebrew', () => realBrew() !== null);

// ── Auth ─────────────────────────────────────────────────────────────────────
// Mocca runs agents through the Claude Agent SDK, which needs an API key from
// the Claude Console. That is the ONLY method the shipped app supports, and the
// only one Anthropic permits for third-party products built on the Agent SDK:
//
//   "Developers building products or services that interact with Claude's
//    capabilities, including those using the Agent SDK, should use API key
//    authentication… Anthropic does not permit third-party developers to offer
//    Claude.ai login or to route requests through Free, Pro, or Max plan
//    credentials on behalf of their users."
//   — https://code.claude.com/docs/en/legal-and-compliance
//
// A Claude Code OAuth sign-in (Pro/Max) is therefore accepted ONLY in an
// unpackaged source build — i.e. someone running Mocca themselves, which the
// same policy contemplates as "ordinary, individual usage of… the Agent SDK".
// The distributed DMG has no such path: `app.isPackaged` is the gate, so this is
// a property of the build rather than a promise in a README.
const SUBSCRIPTION_AUTH_ALLOWED = (): boolean => !app.isPackaged;

// The user's key, encrypted at rest with the OS keychain via safeStorage.
function keyFile(): string {
  return path.join(app.getPath('userData'), 'auth.bin');
}
function saveApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    fs.rmSync(keyFile(), { force: true });
    return;
  }
  // safeStorage needs the app ready; it is by the time any of this runs.
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8'); // no keychain (rare) — still contained to userData
  fs.writeFileSync(keyFile(), buf, { mode: 0o600 });
}
function loadApiKey(): string | null {
  try {
    const buf = fs.readFileSync(keyFile());
    const key = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8');
    return key.trim() || null;
  } catch {
    return null;
  }
}
// A key the user pasted in beats one inherited from the environment. (A GUI app
// launched from Finder inherits no shell env at all, so the stored key is the
// only one most users will ever have.)
function resolveApiKey(): string | null {
  return loadApiKey() ?? (process.env.ANTHROPIC_API_KEY?.trim() || null);
}

async function claudeAuthStatus(): Promise<{
  ok: boolean;
  method: 'apikey' | 'oauth' | 'none';
  canUseSubscription: boolean;
}> {
  const canUseSubscription = SUBSCRIPTION_AUTH_ALLOWED();
  if (resolveApiKey()) return { ok: true, method: 'apikey', canUseSubscription };
  // Subscription sign-in: source builds only — never the shipped app.
  if (canUseSubscription) {
    // OAuth credentials file (Linux/Windows, and some macOS installs).
    const credFile = path.join(app.getPath('home'), '.claude', '.credentials.json');
    if (fs.existsSync(credFile))
      return { ok: true, method: 'oauth', canUseSubscription };
    // macOS stores the Claude Code token in the login Keychain. Reading only the
    // item's attributes (not the secret) doesn't trigger a permission prompt.
    if (process.platform === 'darwin') {
      try {
        await execFileP('security', [
          'find-generic-password',
          '-s',
          'Claude Code-credentials',
        ]);
        return { ok: true, method: 'oauth', canUseSubscription };
      } catch {
        /* not found */
      }
    }
  }
  return { ok: false, method: 'none', canUseSubscription };
}

ipcMain.handle('system:authStatus', () => claudeAuthStatus());

// Save / clear the API key. Returns the fresh status so the UI can re-gate.
ipcMain.handle('auth:setKey', async (_e, key: string) => {
  saveApiKey(String(key ?? ''));
  // New credentials only take effect on a new session — restart every live one.
  for (const [k, s] of sessions) {
    s.close();
    sessions.delete(k);
  }
  lastUsage = null;
  void fetchUsageSnapshot();
  return claudeAuthStatus();
});
ipcMain.handle('auth:hasStoredKey', () => !!loadApiKey());

// ── Plan usage limits ────────────────────────────────────────────────────────
// The data behind Claude Code's `/usage` panel, surfaced in Settings: the
// claude.ai plan plus its rate-limit windows — a rolling 5-hour "current
// session" window and weekly windows (all-models + per-model), each a %
// utilization with a reset time. Pulled from the SDK on demand (an empty-input
// query spends no tokens) and cached so Settings shows last-known values
// instantly. `available` is false for API-key / 3P-provider sessions.
type AccountInfo = { email?: string; subscriptionType?: string };
type LimitWindow = {
  label: string;
  utilization: number; // 0–100
  resetsAt: number | null; // epoch ms
};
type UsageSnapshot = {
  plan: string | null; // e.g. "Claude Max"
  email?: string;
  available: boolean;
  session: LimitWindow | null; // five_hour
  weeklyAll: LimitWindow | null; // seven_day (all models)
  weeklyModels: LimitWindow[]; // per-model weekly windows
  updatedAt: number;
};

let lastUsage: UsageSnapshot | null = null;

function usageFile(): string {
  return path.join(app.getPath('userData'), 'usage.json');
}
function loadUsageCache(): void {
  try {
    lastUsage = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
  } catch {
    /* nothing cached yet */
  }
}
function saveUsageCache(): void {
  try {
    fs.writeFileSync(usageFile(), JSON.stringify(lastUsage, null, 2));
  } catch {
    /* best effort */
  }
}

type RawWindow = { utilization?: number | null; resets_at?: string | null };
function toWindow(label: string, w: RawWindow | null | undefined): LimitWindow | null {
  if (!w || typeof w.utilization !== 'number') return null;
  const t = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return { label, utilization: w.utilization, resetsAt: Number.isNaN(t) ? null : t };
}

// One throwaway query (no user turn → no tokens) yields both the account
// (plan/email) and the `/usage` rate-limit windows.
async function fetchUsageSnapshot(): Promise<UsageSnapshot | null> {
  const apiKey = resolveApiKey();
  // Without a key, the shipped app has no sanctioned way to call Claude — don't
  // quietly spin up a query that would run on whatever Claude Code login is on
  // the machine just to populate a Settings panel.
  if (!apiKey && !SUBSCRIPTION_AUTH_ALLOWED()) return null;
  try {
    // Keep the input stream OPEN (never yields, never ends) so the SDK doesn't
    // close the query before the network-backed usage() call responds — an empty
    // generator ends input immediately and the query closes mid-request. We tear
    // it down with interrupt() once we have the data.
    async function* keepOpen(): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>(() => {});
    }
    const q = query({
      prompt: keepOpen(),
      options: {
        settingSources: [],
        env: {
          ...process.env,
          ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
        },
      },
    });
    const account = (await q.accountInfo().catch((): null => null)) as AccountInfo | null;
    // Experimental SDK method — shape is loose on purpose; guard every field.
    const u = (await (
      q as unknown as {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
      }
    ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.().catch(
      (): null => null,
    )) as Record<string, unknown> | null;
    q.interrupt().catch((): void => {});

    const rl = (u?.rate_limits ?? {}) as Record<string, RawWindow | null | undefined> & {
      model_scoped?: Array<RawWindow & { display_name?: string }>;
    };
    const weeklyModels: LimitWindow[] = [];
    const opus = toWindow('Opus', rl.seven_day_opus);
    if (opus) weeklyModels.push(opus);
    const sonnet = toWindow('Sonnet', rl.seven_day_sonnet);
    if (sonnet) weeklyModels.push(sonnet);
    for (const m of rl.model_scoped ?? []) {
      const w = toWindow(String(m?.display_name ?? 'Model'), m);
      if (w) weeklyModels.push(w);
    }

    lastUsage = {
      plan:
        account?.subscriptionType ??
        (typeof u?.subscription_type === 'string' ? u.subscription_type : null),
      email: account?.email,
      available: u?.rate_limits_available === true,
      session: toWindow('Current session', rl.five_hour),
      weeklyAll: toWindow('All models', rl.seven_day),
      weeklyModels,
      updatedAt: Date.now(),
    };
    saveUsageCache();
    return lastUsage;
  } catch {
    return lastUsage;
  }
}

// Fetch fresh (the refresh button); or return whatever's cached instantly.
ipcMain.handle('system:usage', () => fetchUsageSnapshot());
ipcMain.handle('system:usageCached', () => lastUsage);

ipcMain.handle('system:installHomebrew', async () => {
  const script = `#!/bin/bash
echo "Installing Homebrew for Mocca."
echo "You may be asked for your Mac login password — this is required to install software."
echo
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo
echo "All set. You can close this window and return to Mocca, then ask your agent again."
`;
  const f = path.join(app.getPath('temp'), 'mocca-install-homebrew.command');
  await fsp.writeFile(f, script, { mode: 0o755 });
  await execFileP('open', ['-a', 'Terminal', f]);
});

ipcMain.handle('workspace:reveal', async (_e, agentId: string) => {
  await shell.openPath(workDir(agentId));
});

// ── In-app view bridge ───────────────────────────────────────────────────────
// An agent can write a self-contained HTML file and have Mocca render it live in
// a sandboxed panel — a real UI that runs inside the app (a music player, a
// dashboard). The view is untrusted: it runs in an iframe with no access to
// Mocca, and reaches back ONLY through these workspace-scoped verbs. Every path
// is resolved against the workspace and refuses to escape it.
function resolveInWorkspace(agentId: string, rel: string): string | null {
  const root = workDir(agentId);
  const full = path.resolve(root, rel || '');
  // Must stay inside the workspace — no `..` escapes, no absolute paths out.
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

ipcMain.handle('view:read', async (_e, agentId: string, rel: string) => {
  const full = resolveInWorkspace(agentId, rel);
  if (!full) throw new Error('Path is outside the workspace.');
  return fsp.readFile(full, 'utf8');
});

ipcMain.handle(
  'view:write',
  async (_e, agentId: string, rel: string, content: string) => {
    const full = resolveInWorkspace(agentId, rel);
    if (!full) throw new Error('Path is outside the workspace.');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, String(content ?? ''), 'utf8');
    return true;
  },
);

ipcMain.handle('view:list', (_e, agentId: string, rel = '') =>
  listWorkspace(agentId, rel),
);

// Every Canvas the agent has built lives in the workspace's `canvas/` folder.
// The Canvas panel lists them here to offer a switcher when there's more than one.
ipcMain.handle('view:canvases', async (_e, agentId: string) => {
  const dir = path.join(workDir(agentId), 'canvas');
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
      .map((e) => ({ name: e.name.replace(/\.html?$/i, ''), rel: `canvas/${e.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
});

// Pick files to attach — returns the chosen paths WITHOUT copying. They're
// staged in the composer and only committed to the workspace when the user
// sends the message.
ipcMain.handle('workspace:pick', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win ?? undefined, {
    properties: ['openFile', 'multiSelections'],
  });
  return res.canceled ? [] : res.filePaths;
});

// Commit staged files into the workspace's input/ folder (on send).
ipcMain.handle('workspace:commit', async (_e, agentId: string, paths: string[]) => {
  const dir = inputDir(agentId);
  for (const src of paths ?? []) {
    await fsp.copyFile(src, path.join(dir, path.basename(src)));
  }
  return listWorkspace(agentId, 'input');
});

// ── Agent packages (marketplace) ─────────────────────────────────────────────
// An agent is an on-disk package: a folder with agent.json (metadata) and
// instructions.md (the persona / skill body). The bundled `registry/` seeds the
// marketplace; installing copies (or fetches) a package into userData/agents so
// the library survives restarts. GitHub-sourced packages pull the real Claude
// Code plugin — plugin.json + .claude/skills/<name>/SKILL.md — straight from the repo.
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
  source?: string; // e.g. "github:santifer/career-ops"
  skillPath?: string; // path to SKILL.md within a GitHub repo
  commands?: AgentCommand[]; // detected actions, shown as reliable header chips
  multiSkill?: boolean; // load the whole plugin (all skills) rather than one SKILL
  category?: string; // marketplace grouping, e.g. "Career"
  tagline?: string; // one-liner for the marketplace card
  featured?: boolean; // surfaced in the marketplace's featured row
};
// A header action: `command` is sent to the agent, `label` is the button text.
type AgentCommand = { command: string; label: string };

function registryDir(): string {
  // Packaged: shipped as an extraResource under Contents/Resources.
  return path.join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    'registry',
  );
}
function agentsDir(): string {
  const dir = path.join(app.getPath('userData'), 'agents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function frontmatterBody(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  const nl = md.indexOf('\n', end + 1);
  return nl === -1 ? '' : md.slice(nl + 1);
}
function prettyName(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Pull the declared modes from a SKILL.md frontmatter argument-hint, e.g.
// `argument-hint: "[scan | pdf | tracker]"` → ['scan','pdf','tracker']. Capped
// so a huge list doesn't overrun the header.
function parseCommands(md: string): string[] {
  const m = md.match(/argument-hint:\s*"?\[([^\]]+)\]/);
  if (!m) return [];
  return m[1]
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 16);
}

async function loadPackageDir(dir: string): Promise<AgentPackage | null> {
  const manifest = path.join(dir, 'agent.json');
  if (!fs.existsSync(manifest)) return null;
  const meta = JSON.parse(await fsp.readFile(manifest, 'utf8')) as
    Partial<AgentPackage>;
  const insFile = path.join(dir, 'instructions.md');
  const instructions = fs.existsSync(insFile)
    ? (await fsp.readFile(insFile, 'utf8')).trim()
    : '';
  return {
    id: meta.id ?? path.basename(dir),
    name: meta.name ?? prettyName(path.basename(dir)),
    emoji: meta.emoji ?? '🧩',
    description: meta.description ?? '',
    allowedTools: meta.allowedTools ?? ['Read', 'Glob', 'Grep'],
    examplePrompt: meta.examplePrompt ?? '',
    instructions,
    version: meta.version,
    author: meta.author,
    source: meta.source,
    skillPath: meta.skillPath,
    commands: meta.commands ?? [],
    multiSkill: meta.multiSkill,
    category: meta.category,
    tagline: meta.tagline,
    featured: meta.featured,
  };
}

async function listDirPackages(base: string): Promise<AgentPackage[]> {
  if (!fs.existsSync(base)) return [];
  const entries = await fsp.readdir(base, { withFileTypes: true });
  const pkgs: AgentPackage[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkg = await loadPackageDir(path.join(base, e.name));
    if (pkg) pkgs.push(pkg);
  }
  return pkgs.sort((a, b) => a.name.localeCompare(b.name));
}

// Fetch a Claude Code plugin from GitHub and shape it into an AgentPackage.
async function githubFetchText(repo: string, filePath: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mocca', Accept: 'application/vnd.github.raw' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${repo}/${filePath}`);
  return res.text();
}

async function githubTree(repo: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
      { headers: { 'User-Agent': 'Mocca', Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { tree?: Array<{ path: string; type: string }> };
    return (data.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path);
  } catch {
    return [];
  }
}

// Is this a plugin skill file (not a template/dependency/mirror copy)?
const MIRROR_DIR = /^\.(grok|kimi|qwen|agents|opencode|antigravitycli|codex)(\/|$)/i;
function isSkillPath(p: string): boolean {
  if (!/(^|\/)SKILL\.md$/i.test(p)) return false;
  return !/(^|\/)(node_modules|templates?|examples?|tests?|\.git)(\/|$)/i.test(p);
}

// Pick the best single SKILL.md to represent a plugin. Skills can live at
// skills/<n>/, .claude/skills/<n>/, <n>/ (repo root), or nested — and repos
// like career-ops mirror them into .grok/, .kimi/, etc. Score for the canonical
// one named after the plugin, preferring shallow, non-mirror locations.
function pickSkillPath(paths: string[], slug: string): string | undefined {
  const skills = paths.filter(isSkillPath);
  if (!skills.length) return undefined;
  const score = (p: string): number => {
    const dir = p.replace(/\/?SKILL\.md$/i, '');
    let s = -p.split('/').length; // shallower is better
    if (new RegExp(`(^|/)${slug}$`, 'i').test(dir)) s += 100; // named after plugin
    if (/^skills\//i.test(p)) s += 40;
    else if (/^\.claude\/skills\//i.test(p)) s += 30;
    else if (!p.includes('/')) s += 25; // root SKILL.md
    else if (/^[^./][^/]*\/SKILL\.md$/i.test(p)) s += 20; // root <name>/SKILL.md
    if (MIRROR_DIR.test(p)) s -= 80;
    return s;
  };
  return skills.slice().sort((a, b) => score(b) - score(a))[0];
}

async function fetchGithubAgent(
  repo: string,
  skillPath?: string,
): Promise<{ id: string; name: string; description: string; version?: string; author?: string; instructions: string; commands: AgentCommand[]; skillPath?: string }> {
  let plugin: Record<string, unknown> = {};
  try {
    plugin = JSON.parse(await githubFetchText(repo, '.claude-plugin/plugin.json'));
  } catch {
    // no plugin.json — fall back to the repo name
  }
  const slug = (plugin.name as string) ?? repo.split('/')[1];

  let sp = skillPath;
  if (!sp) sp = pickSkillPath(await githubTree(repo), slug);
  if (!sp) throw new Error(`No SKILL.md found in ${repo}`);
  const skill = await githubFetchText(repo, sp);

  const author = plugin.author as { name?: string } | string | undefined;
  return {
    id: slug,
    name: prettyName(slug),
    description: (plugin.description as string) ?? '',
    version: plugin.version as string | undefined,
    author: typeof author === 'object' ? author?.name : author,
    instructions: frontmatterBody(skill).trim(),
    commands: parseCommands(skill).map((c) => ({ command: c, label: c })),
    skillPath: sp,
  };
}

async function writePackage(dir: string, pkg: AgentPackage): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const { instructions, ...meta } = pkg;
  await fsp.writeFile(
    path.join(dir, 'agent.json'),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
  await fsp.writeFile(path.join(dir, 'instructions.md'), instructions, 'utf8');
}

// Clone the FULL plugin repo and seed its files into the agent's workspace, so
// runtime files the router reads (career-ops's modes/*.md, templates, etc.) are
// actually present. Relative reads like `modes/pdf.md` resolve because the
// workspace is the agent's cwd. A manifest records what we seeded so the file
// panel can hide the scaffold from the user.
// Generically detect an installed plugin's commands from its files on disk —
// works for any Claude Code library, not just career-ops. Two sources:
//   1) skill modes: `argument-hint` in any .claude/skills/*/SKILL.md
//   2) plugin commands: each *.md in a commands/ or .claude/commands/ dir
// Walk a cloned plugin and return the absolute paths of every SKILL.md, at any
// depth and in any layout (skills/, .claude/skills/, root, nested).
async function findSkillFiles(pdir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (/^(node_modules|\.git|templates?|examples?|tests?)$/i.test(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (/^SKILL\.md$/i.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  await walk(pdir);
  return out;
}

async function detectCommands(
  pdir: string,
  skillPath?: string,
): Promise<AgentCommand[]> {
  const found = new Set<string>();

  const skillFiles = await findSkillFiles(pdir);
  if (skillPath) skillFiles.unshift(path.join(pdir, skillPath));
  for (const f of skillFiles) {
    try {
      for (const c of parseCommands(await fsp.readFile(f, 'utf8'))) found.add(c);
    } catch {
      /* skip */
    }
  }

  for (const cdir of ['commands', path.join('.claude', 'commands')]) {
    try {
      for (const e of await fsp.readdir(path.join(pdir, cdir), { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.md')) {
          found.add(e.name.replace(/\.md$/, ''));
        }
      }
    } catch {
      /* no commands dir */
    }
  }

  return [...found].slice(0, 16).map((c) => ({ command: c, label: c }));
}

// Read a single frontmatter field out of a SKILL.md.
function frontmatterField(md: string, key: string): string | undefined {
  if (!md.startsWith('---')) return undefined;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return undefined;
  const m = md.slice(3, end).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

// List every distinct skill in a cloned plugin. Deduped by skill name so a repo
// that mirrors its skills into .grok/, .kimi/, etc. still counts as one.
async function readAllSkills(
  pdir: string,
): Promise<Array<{ name: string; description: string }>> {
  const out: Array<{ name: string; description: string }> = [];
  const seen = new Set<string>();
  for (const f of await findSkillFiles(pdir)) {
    const rel = path.relative(pdir, f);
    if (MIRROR_DIR.test(rel)) continue; // skip harness mirror copies
    try {
      const md = await fsp.readFile(f, 'utf8');
      const name = frontmatterField(md, 'name') || path.basename(path.dirname(f));
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: frontmatterField(md, 'description') || '' });
    } catch {
      /* skip */
    }
  }
  return out;
}

// A light system prompt for a multi-skill plugin: orient the agent and let it
// invoke the plugin's own skills (loaded via the SDK plugins option).
function buildOverview(
  name: string,
  description: string,
  skills: Array<{ name: string; description: string }>,
): string {
  const shown = skills.slice(0, 30);
  const lines = shown
    .map((s) => `- **${s.name}**${s.description ? ` — ${s.description}` : ''}`)
    .join('\n');
  const more =
    skills.length > shown.length
      ? `\n- …and ${skills.length - shown.length} more skills — invoke any of them by name.`
      : '';
  return `You are ${name}${description ? ` — ${description}` : ''}.

You have a set of specialised skills (loaded and available to you). When the user asks for something, pick the right skill(s) and use them to do the work:

${lines}${more}

Read the user's uploaded files from the input/ folder, and save anything you produce for them into the output/ folder.`;
}

// After cloning, if a plugin has 2+ skills we can't paste just one — load the
// whole plugin natively and use a generated overview as the system prompt.
async function applyMultiSkill(
  agentId: string,
  destDir: string,
  name: string,
  description: string,
): Promise<boolean> {
  const skills = await readAllSkills(pluginDir(agentId));
  if (skills.length < 2) return false;
  await fsp.writeFile(
    path.join(destDir, 'instructions.md'),
    buildOverview(name, description, skills),
    'utf8',
  );
  try {
    const mf = path.join(destDir, 'agent.json');
    const m = JSON.parse(await fsp.readFile(mf, 'utf8'));
    m.multiSkill = true;
    await fsp.writeFile(mf, JSON.stringify(m, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
  return true;
}

function isMultiSkillSync(agentId: string): boolean {
  try {
    return !!JSON.parse(
      fs.readFileSync(path.join(agentsDir(), agentId, 'agent.json'), 'utf8'),
    ).multiSkill;
  } catch {
    return false;
  }
}

// Fallback when a plugin declares no commands in any known format: ask the
// agent itself to enumerate them as JSON. This gives us friendly labels too.
async function introspectCommands(
  instructions: string,
  cwd: string,
): Promise<AgentCommand[]> {
  const append = instructions
    ? `${instructions}\n\n${HOST_PREAMBLE}`
    : HOST_PREAMBLE;
  const prompt =
    'List every command, mode, or action a user can ask you to run. Respond with ONLY a compact JSON array (no prose, no code fence), up to 16 items, each: {"command":"<exact short text the user types>","label":"<short friendly button label>"}.';
  let text = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        allowedTools: ['Read', 'Glob', 'Grep'],
        cwd,
      },
    })) {
      const msg = m as Record<string, unknown>;
      if (msg?.type === 'assistant') {
        const content = (msg.message as Record<string, unknown>)?.content as
          | Array<Record<string, unknown>>
          | undefined;
        for (const b of content ?? []) {
          if (b.type === 'text') text += b.text as string;
        }
      }
    }
  } catch {
    return [];
  }
  const s = text.indexOf('[');
  const e = text.lastIndexOf(']');
  if (s === -1 || e === -1) return [];
  try {
    const arr = JSON.parse(text.slice(s, e + 1)) as Array<Record<string, unknown>>;
    return arr
      .filter((x) => x && x.command)
      .map((x) => ({
        command: String(x.command),
        label: String(x.label ?? x.command),
      }))
      .slice(0, 16);
  } catch {
    return [];
  }
}

// Record which files the plugin "shipped with" — the Files panel hides these so
// the user only sees their own content and the agent's fresh deliverables.
async function writeShipped(
  pdir: string,
  source: string,
  paths: string[],
): Promise<void> {
  await fsp.writeFile(
    path.join(pdir, '.agenthub-shipped.json'),
    JSON.stringify({ repo: source, paths }),
    'utf8',
  );
}

// For a fetched/generated plugin, everything in it is scaffolding → hide it all.
async function snapshotShipped(pdir: string, source: string): Promise<void> {
  const shipped: string[] = [];
  async function walk(dir: string, prefix: string) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else shipped.push(rel);
    }
  }
  await walk(pdir, '');
  await writeShipped(pdir, source, shipped);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `agent-${name.length}`
  );
}

// Ask Claude to author a new agent from a name + brief: a description, a system
// prompt, and starter commands. Returns null if it can't produce valid JSON.
async function generateAgent(
  name: string,
  brief: string,
): Promise<{ description: string; systemPrompt: string; commands: AgentCommand[] } | null> {
  const prompt = `You are authoring a new AI agent for Mocca, a desktop GUI where non-technical users chat with agents. The agent runs in its own working directory with file tools, web search, and bash, and can create any files/folders it needs.

Agent name: "${name}"
What the user wants it to do:
${brief || '(no description given — infer a sensible, useful general-purpose assistant for this name)'}

Write:
1. description: one concise sentence describing the agent.
2. systemPrompt: the agent's full instructions, written in second person ("You are ..."). Make it capable and focused on the user's intent. Tell it to create and organize files in its workspace as needed. Do NOT mention slash commands.
3. commands: up to 6 starter actions the user could click, each {"command","label"} where command is the message sent and label is the button text. Omit if none make sense.

Respond with ONLY a JSON object, no prose, no code fence:
{"description":"...","systemPrompt":"...","commands":[{"command":"...","label":"..."}]}`;

  let text = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120000);
  try {
    for await (const m of query({
      prompt,
      options: { allowedTools: [], abortController: abort },
    })) {
      const msg = m as Record<string, unknown>;
      if (msg?.type === 'assistant') {
        const content = (msg.message as Record<string, unknown>)?.content as
          | Array<Record<string, unknown>>
          | undefined;
        for (const b of content ?? []) if (b.type === 'text') text += b.text as string;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try {
    const obj = JSON.parse(text.slice(s, e + 1));
    const commands = Array.isArray(obj.commands)
      ? obj.commands
          .filter((c: Record<string, unknown>) => c && c.command)
          .map((c: Record<string, unknown>) => ({
            command: String(c.command),
            label: String(c.label ?? c.command),
          }))
          .slice(0, 6)
      : [];
    return {
      description: String(obj.description ?? ''),
      systemPrompt: String(obj.systemPrompt ?? ''),
      commands,
    };
  } catch {
    return null;
  }
}

async function seedPlugin(
  repo: string,
  agentId: string,
  skillPath?: string,
): Promise<AgentCommand[]> {
  const pdir = pluginDir(agentId);
  await fsp.rm(pdir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(pdir), { recursive: true });
  await execFileP(
    'git',
    ['clone', '--depth', '1', `https://github.com/${repo}.git`, pdir],
    { timeout: 180000 },
  );
  await fsp.rm(path.join(pdir, '.git'), { recursive: true, force: true });
  await snapshotShipped(pdir, `github:${repo}`);
  return detectCommands(pdir, skillPath);
}

// Copy a local plugin folder into the agent's plugin dir (excluding .git and
// node_modules), then snapshot + detect commands — same as the GitHub path.
async function seedPluginFolder(
  dir: string,
  agentId: string,
  skillPath?: string,
): Promise<AgentCommand[]> {
  const pdir = pluginDir(agentId);
  await fsp.rm(pdir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(pdir), { recursive: true });
  await fsp.cp(dir, pdir, {
    recursive: true,
    filter: (src) => {
      const b = path.basename(src);
      return b !== '.git' && b !== 'node_modules';
    },
  });
  // An imported folder is the user's OWN content — the only scaffolding is the
  // prompt/skill file. Everything else must stay visible in the Files panel.
  await writeShipped(pdir, `folder:${dir}`, skillPath ? [skillPath] : []);
  return detectCommands(pdir, skillPath);
}

// Read an agent's metadata from a local plugin folder (plugin.json + SKILL.md).
async function readLocalAgent(dir: string): Promise<{
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  instructions: string;
  commands: AgentCommand[];
  skillPath?: string;
}> {
  let plugin: Record<string, unknown> = {};
  try {
    plugin = JSON.parse(
      await fsp.readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
  } catch {
    /* not a formal plugin — fall back to folder name */
  }
  const slug = (plugin.name as string) ?? path.basename(dir);

  let skillPath: string | undefined;
  let skillMd = '';

  // 1. A Claude Code skill — top-level skills/ or .claude/skills/.
  for (const rootRel of ['skills', '.claude/skills']) {
    if (skillMd) break;
    try {
      const skillsRoot = path.join(dir, rootRel);
      const skillDirs = await fsp.readdir(skillsRoot);
      const chosen = skillDirs.includes(slug) ? slug : skillDirs[0];
      if (chosen) {
        skillPath = `${rootRel}/${chosen}/SKILL.md`;
        skillMd = await fsp.readFile(path.join(skillsRoot, chosen, 'SKILL.md'), 'utf8');
      }
    } catch {
      /* no such dir */
    }
  }

  // 2. A common system-prompt file at the folder root.
  if (!skillMd) {
    const entries = await fsp.readdir(dir).catch((): string[] => []);
    const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]));
    const named = [
      'skill.md', 'system.md', 'system_prompt.md', 'system-prompt.md',
      'prompt.md', 'instructions.md', 'agent.md', 'agents.md', 'claude.md',
      'readme.md',
    ];
    for (const n of named) {
      const actual = byLower.get(n);
      if (actual) {
        skillPath = actual;
        skillMd = await fsp.readFile(path.join(dir, actual), 'utf8');
        break;
      }
    }
    // 3. Fallback: the largest markdown file at the root.
    if (!skillMd) {
      let best: string | undefined;
      let bestSize = -1;
      for (const e of entries) {
        if (!e.toLowerCase().endsWith('.md')) continue;
        const s = await fsp.stat(path.join(dir, e)).catch((): null => null);
        if (s && s.size > bestSize) {
          bestSize = s.size;
          best = e;
        }
      }
      if (best) {
        skillPath = best;
        skillMd = await fsp.readFile(path.join(dir, best), 'utf8');
      }
    }
  }

  const author = plugin.author as { name?: string } | string | undefined;
  return {
    id: slug,
    name: prettyName(slug),
    description: (plugin.description as string) ?? '',
    version: plugin.version as string | undefined,
    author: typeof author === 'object' ? author?.name : author,
    instructions: skillMd ? frontmatterBody(skillMd).trim() : '',
    commands: skillMd
      ? parseCommands(skillMd).map((c) => ({ command: c, label: c }))
      : [],
    skillPath,
  };
}

// Persist detected commands into an installed package's agent.json.
async function writeCommands(dir: string, commands: AgentCommand[]): Promise<void> {
  if (!commands.length) return;
  const mf = path.join(dir, 'agent.json');
  const meta = JSON.parse(await fsp.readFile(mf, 'utf8'));
  meta.commands = commands;
  await fsp.writeFile(mf, JSON.stringify(meta, null, 2), 'utf8');
}

// Install a GitHub plugin by CLONING it (git, not the rate-limited REST API)
// and reading plugin.json + skills straight from the clone. `base` carries any
// curated marketplace metadata (name, emoji, examplePrompt) to prefer.
async function installPluginFromRepo(
  id: string,
  repo: string,
  base: Partial<AgentPackage>,
): Promise<void> {
  const dest = path.join(agentsDir(), id);
  const pdir = pluginDir(id);
  await fsp.rm(pdir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(pdir), { recursive: true });
  await execFileP(
    'git',
    ['clone', '--depth', '1', `https://github.com/${repo}.git`, pdir],
    { timeout: 180000 },
  );
  await fsp.rm(path.join(pdir, '.git'), { recursive: true, force: true });

  // Everything below reads the local clone — no GitHub API.
  let plugin: Record<string, unknown> = {};
  try {
    plugin = JSON.parse(
      await fsp.readFile(path.join(pdir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
  } catch {
    /* not a formal plugin */
  }
  const slug = (plugin.name as string) ?? repo.split('/')[1];
  const name = base.name ?? prettyName(slug);
  const description = base.description ?? (plugin.description as string) ?? '';
  const author =
    base.author ??
    (typeof plugin.author === 'object'
      ? (plugin.author as { name?: string })?.name
      : (plugin.author as string));

  let instructions = '';
  let multiSkill = false;
  if (base.skillPath) {
    // Curated entry pins ONE skill (e.g. career-ops's router) — use it as-is.
    instructions = frontmatterBody(
      await fsp.readFile(path.join(pdir, base.skillPath), 'utf8'),
    ).trim();
  } else {
    const skills = await readAllSkills(pdir);
    if (skills.length >= 2) {
      multiSkill = true;
      instructions = buildOverview(name, description, skills);
    } else {
      const files = await findSkillFiles(pdir);
      const rels = files.map((f) => path.relative(pdir, f).split(path.sep).join('/'));
      const best = pickSkillPath(rels, slug);
      if (best) instructions = frontmatterBody(await fsp.readFile(path.join(pdir, best), 'utf8')).trim();
    }
  }
  if (!instructions) throw new Error('No skill (SKILL.md) found in this plugin.');

  await snapshotShipped(pdir, `github:${repo}`);
  let commands = await detectCommands(pdir);
  if (!commands.length && !multiSkill) {
    commands = await introspectCommands(instructions, pdir);
  }

  await writePackage(dest, {
    id,
    name,
    emoji: base.emoji ?? '🧩',
    description,
    allowedTools:
      base.allowedTools ??
      ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
    examplePrompt: base.examplePrompt ?? `Ask ${name} to get started.`,
    instructions,
    version: plugin.version as string | undefined,
    author,
    source: `github:${repo}`,
    skillPath: base.skillPath,
    commands,
    multiSkill,
  });
}

async function installFromRegistry(id: string): Promise<void> {
  const src = path.join(registryDir(), id);
  if (!fs.existsSync(src)) throw new Error(`Unknown workspace: ${id}`);
  const base = await loadPackageDir(src);
  if (base?.source?.startsWith('github:')) {
    await installPluginFromRepo(id, base.source.slice('github:'.length), base);
  } else {
    // A fully bundled package (ships its own instructions.md) — just copy it.
    await fsp.cp(src, path.join(agentsDir(), id), { recursive: true });
  }
}

ipcMain.handle('market:registry', () => listDirPackages(registryDir()));

ipcMain.handle('market:installed', () => listDirPackages(agentsDir()));

// Everything the marketplace detail page shows beyond the card. Registry entries
// are metadata only (the plugin is cloned at install), so the substantial content
// — what this thing actually does — comes from the repo's README. Once installed,
// we can also show its real skills and any MCP servers it brought with it.
type AgentDetails = {
  readme?: string;
  skills?: Array<{ name: string; description: string }>;
  mcp?: McpEntry[];
};

ipcMain.handle('market:details', async (_e, id: string): Promise<AgentDetails> => {
  const out: AgentDetails = {};

  // Installed → we have the real plugin on disk.
  if (fs.existsSync(pluginDir(id))) {
    try {
      out.skills = await readAllSkills(pluginDir(id));
    } catch {
      /* not a multi-skill plugin */
    }
    out.mcp = pluginMcpEntries(id);
  }

  // The README is the listing copy. raw.githubusercontent is a CDN, so this
  // doesn't burn the GitHub API rate limit that broke installs before.
  const pkg =
    (await loadPackageDir(path.join(registryDir(), id))) ??
    (await loadPackageDir(path.join(agentsDir(), id)));
  const src = pkg?.source ?? '';
  if (src.startsWith('github:')) {
    const repo = src.slice('github:'.length);
    for (const name of ['README.md', 'readme.md', 'Readme.md']) {
      try {
        const res = await fetch(
          `https://raw.githubusercontent.com/${repo}/HEAD/${name}`,
        );
        if (res.ok) {
          out.readme = (await res.text()).slice(0, 40000);
          break;
        }
      } catch {
        /* offline or missing — the page just renders without it */
      }
    }
  }
  return out;
});

ipcMain.handle('market:install', async (_e, id: string) => {
  try {
    await installFromRegistry(id);
    return { ok: true, id, installed: await listDirPackages(agentsDir()) };
  } catch (err) {
    // Don't leave a half-installed workspace behind.
    await fsp.rm(path.join(agentsDir(), id), { recursive: true, force: true });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('market:installGithub', async (_e, repoInput: string) => {
  const repo = repoInput
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return { ok: false, error: 'Enter a repo as owner/name.' };
  }
  const id = slugify(repo.split('/')[1]);
  try {
    await installPluginFromRepo(id, repo, {});
    return { ok: true, id, installed: await listDirPackages(agentsDir()) };
  } catch (err) {
    await fsp.rm(path.join(agentsDir(), id), { recursive: true, force: true });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('market:installFolder', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, error: '' };
    const dir = res.filePaths[0];
    const a = await readLocalAgent(dir);
    const destDir = path.join(agentsDir(), a.id);
    await writePackage(destDir, {
      ...a,
      emoji: '🧩',
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      examplePrompt: `Ask ${a.name} to get started.`,
      source: `folder:${dir}`,
    });
    let cmds = await seedPluginFolder(dir, a.id, a.skillPath);
    if (!cmds.length) cmds = a.commands;
    if (!cmds.length) cmds = await introspectCommands(a.instructions, pluginDir(a.id));
    await writeCommands(destDir, cmds);
    return { ok: true, id: a.id, installed: await listDirPackages(agentsDir()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle(
  'market:createAgent',
  async (_e, name: string, brief: string) => {
    try {
      const trimmed = (name || '').trim();
      if (!trimmed) return { ok: false, error: 'Give the workspace a name.' };
      const id = slugify(trimmed);
      const gen = await generateAgent(trimmed, brief || '');
      if (!gen || !gen.systemPrompt) {
        return { ok: false, error: 'Could not set up the workspace. Try again.' };
      }

      // Scaffold a real Claude Code plugin so the agent is portable from birth.
      const pdir = pluginDir(id);
      await fsp.rm(pdir, { recursive: true, force: true });
      fs.mkdirSync(path.join(pdir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(pdir, '.claude', 'skills', id), { recursive: true });
      await fsp.writeFile(
        path.join(pdir, '.claude-plugin', 'plugin.json'),
        JSON.stringify(
          { name: id, version: '0.1.0', description: gen.description },
          null,
          2,
        ),
        'utf8',
      );
      const argHint = gen.commands.length
        ? `\nargument-hint: "[${gen.commands.map((c) => c.command).join(' | ')}]"`
        : '';
      const skillMd = `---\nname: ${id}\ndescription: ${gen.description}${argHint}\n---\n\n${gen.systemPrompt}\n`;
      await fsp.writeFile(
        path.join(pdir, '.claude', 'skills', id, 'SKILL.md'),
        skillMd,
        'utf8',
      );
      await snapshotShipped(pdir, 'created');

      const destDir = path.join(agentsDir(), id);
      await writePackage(destDir, {
        id,
        name: trimmed,
        emoji: '🧩',
        description: gen.description,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
        examplePrompt: gen.commands[0]?.command ?? 'Help me get started.',
        instructions: gen.systemPrompt,
        source: 'created',
        commands: gen.commands,
      });
      return { ok: true, id, installed: await listDirPackages(agentsDir()) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

ipcMain.handle('market:uninstall', async (_e, id: string) => {
  closeSessionsForAgent(id);
  await fsp.rm(path.join(agentsDir(), id), { recursive: true, force: true });
  await fsp.rm(workspaceDir(id), { recursive: true, force: true });
  // Forget any "always allow" grants for this workspace.
  const a = loadApprovals();
  if (a[id]) {
    delete a[id];
    saveApprovals(a);
  }
  return listDirPackages(agentsDir());
});

// ── Agent runtime ────────────────────────────────────────────────────────────
// The renderer sends 'agent:run' with the selected agent's config + the task.
// We run the Claude Agent SDK, stream each message back on 'agent:message',
// then 'agent:done' / 'agent:error'.
type RunPayload = {
  task: string;
  instructions: string;
  allowedTools: string[];
  agentId: string; // selects the agent's own workspace directory (cwd)
  threadId: string; // keys the streaming session; a new thread → fresh session
  resume?: string; // saved session id to resume — restores the thread's memory
};

// Host preamble appended to every agent's system prompt. Agents like career-ops
// are written for terminals and tell users to type slash commands ("/career-ops
// pdf"). Mocca is a GUI with no slash commands, so we steer the agent to
// speak in plain language the user can click or type.
const HOST_PREAMBLE = `You are running inside Mocca, a desktop GUI — not a terminal. The user CANNOT type slash commands.

- Never tell the user to type a slash command (e.g. "/career-ops pdf", "/scan", or any token starting with "/"). Never show slash-command syntax in your replies.
- When you offer choices or next steps, present them as plain, friendly options with a short description of what each does. Describe them naturally in your prose.
- Whenever there are concrete next actions, append them at the very END of your message inside an actions block. Put ONE action per line.
  - One-click actions (the common case): write JUST the button text on its own — no \`|\`. The button text is EXACTLY what gets sent when the user clicks it, so what they click always matches what they say. Keep it short but a complete instruction (e.g. \`Play some lofi\`, not \`Start music again\`).
  - Actions that need the user to add something first: use \`Label | prefill | kind\` where kind is \`input\` (the user types details before sending) or \`file\` (the user attaches a file). Here the prefill can differ from the label because the user sees and edits it before sending.
  Only include the block when there are real next actions. Keep it to at most 5. Example:
[ACTIONS]
Show my application tracker
Add my details | Here are my profile details: | input
Set up my profile from my CV | | file
[/ACTIONS]
- Your workspace has two folders the user can see: \`input/\` holds files they gave you; \`output/\` is where everything you produce for them must go. Read their files from \`input/\`. Save every deliverable (documents, reports, PDFs, exports) into \`output/\` — anything you write elsewhere is invisible to them. Scratch and working files can live anywhere else.
- You have a headless browser (the mcp__browser__* tools). WebFetch only sees static HTML, so when a page is JavaScript-heavy, blocked, or needs interaction (job boards, dashboards, search results, logins), use the browser to navigate and read the rendered page instead of giving up.
- HOW TO RESPOND — you have TWO surfaces, and you should FAVOUR THE CANVAS for anything substantial, because people understand things faster visually:
  - CHAT is for chatting: greetings, quick questions, clarifications, confirmations, short factual answers, and narrating what you're doing. Keep it conversational.
  - THE CANVAS is for the actual deliverable: any report, comparison, analysis, plan, summary, ranking, table, dashboard, timeline, breakdown, or interactive tool. If the user asked you to produce, compare, analyse, plan, or lay something out — build it on the Canvas, don't wall it into chat. Default to the Canvas whenever the answer is something the user will read, scan, compare, or keep.
  - How to build a Canvas: write a SELF-CONTAINED HTML file to the \`canvas/\` folder — always \`canvas/<name>.html\` (inline ALL css/js; embed images as data: URLs — external/relative files won't load), then end your message with a line \`[CANVAS: canvas/<name>.html]\`. Mocca renders it live in the panel, and lists every file in \`canvas/\` in a switcher so the user can flip between the apps you've built. Give each a short, distinct \`<name>\` (e.g. \`canvas/lofi-player.html\`, \`canvas/job-comparison.html\`). To UPDATE an existing canvas, rewrite the SAME file and re-emit its \`[CANVAS: …]\`. Keep the chat reply to a short lead-in ("Here's the comparison —"); do NOT also paste the whole thing as markdown.
  - DESIGN SYSTEM — the Canvas has Mocca's design language injected: Swiss / International Typographic Style, dark. Big bold type, tabular numerals, hairline rules, FLAT (no shadows, no gradients, no rounded blobs), generous whitespace, ONE accent. Compose these ready-made components with plain semantic HTML; do NOT invent your own colours, background, fonts, shadows, or a light theme — you'll break the system. Only add CSS for layout (grid/flex/spacing) or a component that doesn't exist. Wrap everything in \`<div class="container">\`.
    - Header: \`<span class="overline">Section label</span><h1>Big Bold Headline</h1><p class="lead">One-line summary.</p>\`
    - Stat (use for numbers — make them BIG): \`<div class="stat"><div class="stat__num">42%</div><div class="stat__label">Conversion</div></div>\` (add \`stat--accent\` to colour the number). Lay several out in a \`<div class="grid">\`.
    - Card: \`<div class="card"><div class="card__title">Title</div>…</div>\`.
    - Table: plain \`<table><thead>…<tbody>…\` — already styled (uppercase ruled header, tabular figures).
    - Badge: \`<span class="badge">tag</span>\` / \`badge--accent\`. Button: \`<button class="btn">Go</button>\` / \`btn--ghost\`.
    - Bar: \`<div class="bar"><span style="width:70%"></span></div>\`. Tabs: \`.tabs\`>\`.tab\`/\`.tab--on\`. List of rows: \`<ul class="list"><li><span>Label</span><span>Value</span></li></ul>\`.
    - Layout: \`.grid\` / \`.grid-2\` / \`.grid-3\` / \`.row\` / \`.stack\` / \`.section\`. Rule/divider: \`<hr>\`. Tokens: \`var(--bg|panel|panel-2|line|text|muted|accent)\`.
    - Lean into the typography: a strong headline + a couple of big stats reads better than dense body text. Left-aligned, spare, ordered.
    - MOBILE-FIRST / VERTICAL: the Canvas is a NARROW vertical panel by default (it can be widened). Design top-to-bottom in a single column and let it breathe vertically. The grid classes already reflow (one column when narrow, more as the panel widens) — so use \`.grid\`/\`.grid-2\`/\`.grid-3\` and they'll fill the width; don't hard-code multi-column layouts or fixed pixel widths. Avoid wide multi-column tables in the panel — prefer stacked cards or a \`.list\`; if you must use a wide table, wrap it in \`<div class="scroll">\` so it scrolls. Everything should look right at ~320px wide AND expand to fill when wider.
  - It can be INTERACTIVE via a small \`window.mocca\` API:
    - \`await mocca.chat.send("text")\` — send a message to you as if the user typed it (e.g. a button the user clicks to drill in).
    - \`await mocca.files.read("output/x.json")\` / \`mocca.files.write(path, content)\` / \`mocca.files.list("output")\` — read/write files in this workspace (workspace-relative; the Canvas can't touch anything outside it).
    - Embeds work: \`<audio>\`/\`<video>\`, maps, inline chart libraries, and normal YouTube videos (\`https://www.youtube.com/embed/<id>\`). To AUTOPLAY a YouTube embed you MUST both delegate autoplay and request it: \`<iframe allow="autoplay; encrypted-media; fullscreen" src="https://www.youtube.com/embed/<id>?autoplay=1">\` (without \`allow="autoplay"\` in the iframe, the browser blocks it). Same for a \`<video autoplay>\`/\`<audio autoplay>\` — just add \`autoplay\`. NOTE: YouTube LIVE streams are unreliable (they end/rotate and show "unavailable") — fine for a specific normal video, not for background music. Prefer the Canvas over telling the user to open something in a browser.
- BUILD ONE COMPLETE, SELF-SUFFICIENT APP — never fragments. This is critical: a Canvas is a full single-page app, like a real web app. It must EMBED ALL ITS DATA and handle EVERY interaction IN-PAGE with its own JavaScript. The user browses, searches, selects, switches screens, plays, and controls entirely inside the one page — WITHOUT you rebuilding it and WITHOUT a round-trip back to chat for each step.
  - Multiple screens go in ONE file: build them as sections/tabs/panels toggled by JS (show/hide, or a tiny in-page router), not as separate \`[CANVAS:]\` files. NEVER emit a genre-picker canvas and then a separate player canvas — that's ONE app: a picker that, on click, reveals/updates the player in the same page.
  - Embed the full dataset up front. A music app includes ALL the genres and their stations in its JS and switches between them on click. A dashboard includes all its panels. A browser includes the whole list and filters it client-side. Don't ask the user to go back to chat to "pick a genre" — put the genres IN the app.
  - Only ever re-emit \`[CANVAS: same-file.html]\` if you genuinely regenerated the file; normal interaction should need zero new canvases.
  - You have everything you need to make it real and full-featured: the whole design system (compose the components above), interactivity via in-page JS, \`<audio>\`/\`<video>\` and normal YouTube embeds for media, maps and inline chart libraries, and the \`window.mocca\` bridge (\`chat.send\`, \`files.read/write/list\`) to talk back to you or persist state only when in-page state isn't enough. Use them to ship a complete app in a single Canvas.
  - CRAFT — when you build a Canvas you are a SENIOR PRODUCT ENGINEER and a Swiss-style designer. Hold that bar:
    - EVERYTHING WORKS. Wire every button, tab, slider, and input to a real event listener — no dead or decorative controls. Before you finish, mentally click each control and confirm it does what it should. A player whose play button does nothing is a failure.
    - ONE source of truth for state, held in JS, and render the UI from it. Never track the same state in two places — that's exactly how a play/pause button desyncs from the sound.
    - AUDIO players specifically: use ONE \`<audio>\` element. Play = \`el.play()\`, pause = \`el.pause()\`. Drive the play/pause BUTTON off the audio element's OWN events — \`el.addEventListener('play', …)\` and \`('pause', …)\` update the icon/label — NOT off a manual boolean (that's the usual bug). Also handle \`waiting\`/\`playing\`/\`error\` so the UI reflects buffering and dead streams. Volume via \`el.volume\`.
    - Robust: guard nulls, catch \`play()\`'s promise rejection, handle stream/embed errors gracefully, and stay correct at any panel width.
    - DESIGN — Swiss / International Typographic Style, taken seriously: BIG BOLD TYPOGRAPHY is the hero; ruthless simplicity; generous whitespace; a strong grid; ONE accent; dead flat (no shadows, gradients, or clutter). Lead with a large headline and a few big, confident elements — cut everything inessential. Fewer, bigger, bolder. Make it look like it was designed, not assembled.
- PLAYING AUDIO — the Canvas plays its own audio with a plain HTML \`<audio>\` element that the app controls (its own play/pause/volume). This keeps playing while the user works (the Canvas stays mounted across workspace switches) and stops when they pause it or close the Canvas — no detached process. NEVER launch a native/system player (\`ffplay\`, \`mpv\`, \`afplay\`, \`vlc\`, …) or a background play command; those become unstoppable detached processes.
  - MUSIC / RADIO (lofi, jazz, ambient, study/focus, internet radio): use a DIRECT audio stream URL in an \`<audio autoplay>\` element — Icecast/SHOUTcast/MP3/AAC. The URL MUST be \`https://\` — the Canvas is a secure page, so an \`http://\` stream is blocked as mixed content and errors. Known-good (note the https): \`https://ice1.somafm.com/groovesalad-128-mp3\` (and other SomaFM channels: lush, dronezone, secretagent, etc.), \`https://lofi.stream.laut.fm/lofi\`. A direct https stream just plays, with real play/pause/volume, no click. This is the RIGHT choice for background music — do NOT use a YouTube "24/7 live" stream for it (YouTube live streams end/rotate and break). Reserve YouTube embeds for a specific normal video the user names.
- Your Bash runs in a sandbox: you can only write inside this workspace folder. Everything else on the machine is read-only to you. Language installs are already pointed at the workspace — prefer \`npm install\` / \`npm i -g\`, \`pip install --user\` (or a local venv), \`cargo install\`, \`go install\`; freshly-installed CLIs are on your PATH and stay contained to this workspace.
- You CANNOT install system-wide software on your own. A command that writes outside the workspace — Homebrew (\`brew install\`), \`sudo\`, \`apt\`, etc. — will pause and ask the USER to approve it. Only run such a command when the task genuinely needs a native tool that npm/pip can't provide (e.g. ffmpeg, mpv). When you do, first tell the user in one short sentence what you're about to install and why, then run it — they'll get an Approve/Deny prompt. If they decline, respect it and find another way or explain the limitation. Never try to work around the sandbox.
- Prefer workspace-local options first (a static/prebuilt binary downloaded into the workspace, or a language-package equivalent) before asking to install system-wide.
- If you need Homebrew but it isn't installed at all (running \`brew\` says command not found), you can't install it yourself — it needs the user's password in a real terminal. Explain that briefly and offer exactly this action so they can install it in one click, then ask again afterward:
[ACTIONS]
Install Homebrew | __mocca_install_homebrew__
[/ACTIONS]`;

// A persistent streaming session per open thread. The SDK query stays alive and
// we push user messages into its input stream — so the user can send/steer
// while the agent is still working (Claude Code parity), and the thread keeps
// its memory across turns without re-sending anything.
type SessionHandle = {
  key: string; // threadId — switching threads starts a fresh session
  agentId: string;
  push: (text: string) => void;
  interrupt: () => void;
  close: () => void;
};
// Many sessions can run at once — one per thread — so an agent keeps working
// while you switch to another. Keyed by threadId.
const sessions = new Map<string, SessionHandle>();

// When the agent asks to do something outside its sandbox (e.g. `brew install`
// which writes system-wide), a PreToolUse hook forwards an approve/deny prompt
// to the renderer and parks the decision here until the user answers. `remember`
// means "always allow this kind of action in this workspace".
const pendingPermissions = new Map<
  string,
  (d: { allow: boolean; remember: boolean }) => void
>();

ipcMain.on(
  'agent:permission-response',
  (_e, id: string, allow: boolean, remember: boolean) => {
    const resolve = pendingPermissions.get(id);
    if (resolve) {
      pendingPermissions.delete(id);
      resolve({ allow, remember });
    }
  },
);

// The "always allow" grants for a workspace, and revoking one.
const approvalEntries = (agentId: string) =>
  (loadApprovals()[agentId] ?? []).map((c) => ({
    category: c,
    label: categoryLabel(c),
  }));

ipcMain.handle('approvals:list', (_e, agentId: string) =>
  approvalEntries(agentId),
);
ipcMain.handle('approvals:revoke', (_e, agentId: string, category: string) => {
  const a = loadApprovals();
  a[agentId] = (a[agentId] ?? []).filter((c) => c !== category);
  if (!a[agentId].length) delete a[agentId];
  saveApprovals(a);
  return approvalEntries(agentId);
});

function closeSessionsForAgent(agentId: string): void {
  for (const [k, s] of sessions) {
    if (s.agentId === agentId) {
      s.close();
      sessions.delete(k);
    }
  }
}

// An async-iterable queue we push user turns into on demand.
function makeInputStream() {
  const queue: SDKUserMessage[] = [];
  let pending: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;
  const toMsg = (text: string): SDKUserMessage => ({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  });
  return {
    push(text: string) {
      if (closed) return;
      if (pending) {
        pending({ value: toMsg(text), done: false });
        pending = null;
      } else {
        queue.push(toMsg(text));
      }
    },
    close() {
      closed = true;
      if (pending) {
        pending({ value: undefined as never, done: true });
        pending = null;
      }
    },
    stream: {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length) {
              return Promise.resolve({ value: queue.shift() as SDKUserMessage, done: false });
            }
            if (closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((res) => {
              pending = res;
            });
          },
        };
      },
    } as AsyncIterable<SDKUserMessage>,
  };
}

// A headless Playwright browser, exposed to agents as mcp__browser__* tools.
// WebFetch only sees static HTML; this navigates and reads the rendered page.
// Runs with no visible window and an isolated (throwaway) profile.
function browserMcpServers() {
  let cli = path.join(
    app.getAppPath(),
    'node_modules',
    '@playwright',
    'mcp',
    'cli.js',
  );
  // In a packaged app node_modules live inside app.asar; this dep is unpacked.
  if (app.isPackaged) {
    cli = cli.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }
  if (!fs.existsSync(cli)) return {};
  return {
    browser: {
      type: 'stdio' as const,
      command: process.execPath,
      args: [cli, '--headless', '--isolated'],
      // Electron's binary must be told to behave as plain Node to run the CLI.
      env: {
        ...(process.env as Record<string, string>),
        ELECTRON_RUN_AS_NODE: '1',
      },
    },
  };
}

// A workspace's connected MCP tools (Linear, Notion, GitHub, …). Stored per
// workspace and merged into every session alongside the browser.
type McpEntry = {
  name: string; // key → tools appear as mcp__<name>__*
  description?: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType?: 'oauth' | 'key' | 'none';
  authHeader?: string; // header name for key auth, e.g. Authorization
  needsAuth?: boolean;
  authNote?: string;
  bundled?: boolean; // declared by the plugin's own .mcp.json, not added by the user
  disabled?: boolean; // a bundled server the user switched off
};

function mcpFile(agentId: string): string {
  return path.join(agentsDir(), agentId, 'mcp.json');
}

// Claude Code plugins declare their own MCP servers in `.mcp.json` — part of the
// plugin format, same shape as a project .mcp.json. Mocca used to ignore this
// file, so a workspace booted WITHOUT the tools it was built around: the
// marketing plugin lost its image generator and hand-rolled a curl workaround
// (digging its API key out of this very file) instead. We honour the spec now.
//
// But a `.mcp.json` can name any command to spawn (`npx <anything>`) and carry
// credentials, so these are surfaced in Settings rather than started silently —
// the user can see what a workspace brought with it and switch it off.
function pluginMcpEntries(agentId: string): McpEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(
      fs.readFileSync(path.join(pluginDir(agentId), '.mcp.json'), 'utf8'),
    );
  } catch {
    return []; // no bundled servers
  }
  const servers = ((raw as Record<string, unknown>)?.mcpServers ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const off = new Set(loadDisabledMcp(agentId));
  return Object.entries(servers).map(([name, s]) => {
    const type = s.type === 'http' || s.type === 'sse' ? s.type : 'stdio';
    return {
      name,
      description: 'Bundled with this workspace',
      transport: type as 'http' | 'sse' | 'stdio',
      url: typeof s.url === 'string' ? s.url : undefined,
      command: typeof s.command === 'string' ? s.command : undefined,
      args: Array.isArray(s.args) ? (s.args as string[]) : [],
      env: (s.env as Record<string, string>) ?? {},
      headers: (s.headers as Record<string, string>) ?? undefined,
      bundled: true,
      disabled: off.has(name),
    };
  });
}

// Bundled servers the user switched off, per workspace.
function mcpDisabledFile(agentId: string): string {
  return path.join(agentsDir(), agentId, 'mcp-disabled.json');
}
function loadDisabledMcp(agentId: string): string[] {
  try {
    const a = JSON.parse(fs.readFileSync(mcpDisabledFile(agentId), 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function saveDisabledMcp(agentId: string, names: string[]): void {
  try {
    fs.writeFileSync(mcpDisabledFile(agentId), JSON.stringify(names, null, 2));
  } catch {
    /* best effort */
  }
}

// Everything this workspace can connect to: what the user added, plus what the
// plugin shipped.
function allMcpEntries(agentId: string): McpEntry[] {
  return [...loadMcpSync(agentId), ...pluginMcpEntries(agentId)];
}
function loadMcpSync(agentId: string): McpEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpFile(agentId), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// Build SDK mcpServers config from a workspace's stored entries.
function storedMcpServers(agentId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // User-added servers plus the plugin's own — minus any bundled ones switched off.
  for (const e of allMcpEntries(agentId)) {
    if (e.disabled) continue;
    if (e.transport === 'stdio' && e.command) {
      out[e.name] = {
        type: 'stdio',
        command: e.command,
        args: e.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(e.env ?? {}) },
      };
    } else if ((e.transport === 'http' || e.transport === 'sse') && e.url) {
      out[e.name] = { type: e.transport, url: e.url, headers: e.headers };
    }
  }
  return out;
}

// Ask Claude to find the OFFICIAL MCP server for a service by name, using web
// search — returns a config candidate the user then verifies before we save it.
async function resolveMcp(name: string): Promise<McpEntry | { error: string }> {
  const prompt = `Find the OFFICIAL Model Context Protocol (MCP) server for "${name}". Prefer the vendor's own server over community ones. Figure out how it connects (a remote http/sse URL, or a local stdio command like \`npx -y <package>\`).

Respond with ONLY JSON, no prose, no code fence:
{"name":"<short lowercase id, e.g. linear>","description":"<one short line>","transport":"http|sse|stdio","url":"<remote url if applicable>","command":"<e.g. npx if stdio>","args":["..."],"authType":"oauth|key|none","authHeader":"<the HTTP header name for a key, e.g. Authorization — only if authType is key>","authNote":"<one line on how the user signs in / what key is needed, if any>"}
Set authType to "oauth" if the user signs in via a browser, "key" if they provide an API key/token in a header, or "none" if no auth is needed.
If you truly cannot find an official server, respond exactly: {"error":"not found"}`;

  let text = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120000);
  try {
    for await (const m of query({
      prompt,
      options: {
        allowedTools: ['WebSearch', 'WebFetch'],
        settingSources: [],
        abortController: abort,
      },
    })) {
      const msg = m as Record<string, unknown>;
      if (msg?.type === 'assistant') {
        const content = (msg.message as Record<string, unknown>)?.content as
          | Array<Record<string, unknown>>
          | undefined;
        for (const b of content ?? []) if (b.type === 'text') text += b.text as string;
      }
    }
  } catch {
    return { error: 'Search failed. Try again.' };
  } finally {
    clearTimeout(timer);
  }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return { error: 'No official server found.' };
  try {
    const obj = JSON.parse(text.slice(s, e + 1));
    if (obj.error) return { error: 'No official server found.' };
    const slug = String(obj.name || name)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '');
    const transport = ['http', 'sse', 'stdio'].includes(obj.transport)
      ? obj.transport
      : obj.url
        ? 'http'
        : 'stdio';
    const authType = ['oauth', 'key', 'none'].includes(obj.authType)
      ? obj.authType
      : obj.needsAuth
        ? 'oauth'
        : 'none';
    return {
      name: slug || 'server',
      description: String(obj.description ?? ''),
      transport,
      url: obj.url ? String(obj.url) : undefined,
      command: obj.command ? String(obj.command) : undefined,
      args: Array.isArray(obj.args) ? obj.args.map(String) : undefined,
      authType,
      authHeader: obj.authHeader ? String(obj.authHeader) : undefined,
      needsAuth: authType !== 'none',
      authNote: obj.authNote ? String(obj.authNote) : undefined,
    };
  } catch {
    return { error: 'Could not read the server details.' };
  }
}

function startSession(
  key: string,
  agentId: string,
  instructions: string,
  allowedTools: string[],
  send: (channel: string, data?: unknown) => void,
  resume?: string,
): SessionHandle {
  const input = makeInputStream();
  const append = instructions
    ? `${instructions}\n\n${HOST_PREAMBLE}`
    : HOST_PREAMBLE;
  const cwd = workDir(agentId);
  const stored = storedMcpServers(agentId);
  // Multi-skill plugins are loaded whole so all their skills are available; the
  // system prompt is a light overview and the agent invokes skills via Skill.
  const asPlugin = isMultiSkillSync(agentId) && fs.existsSync(pluginDir(agentId));

  const q = query({
    prompt: input.stream,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      allowedTools: [
        ...(allowedTools && allowedTools.length
          ? allowedTools
          : ['Read', 'Glob', 'Grep']),
        'mcp__browser', // all headless-browser tools
        ...Object.keys(stored).map((n) => `mcp__${n}`), // connected MCP tools
        ...(asPlugin ? ['Skill', 'Task'] : []), // invoke the plugin's skills
      ],
      ...(asPlugin
        ? { plugins: [{ type: 'local' as const, path: pluginDir(agentId) }] }
        : {}),
      mcpServers: { ...browserMcpServers(), ...stored },
      // Don't inherit the user's personal Claude Code settings / MCP servers —
      // an installed agent should only see what Mocca gives it.
      settingSources: [],
      // Sandbox the agent's Bash: writes are confined to the workspace (cwd) +
      // temp, so anything it writes or installs stays inside the workspace and
      // is wiped when the workspace is deleted. The FILESYSTEM is contained; the
      // network is not — agents legitimately need the open internet (streaming,
      // job boards, APIs, package downloads) and the headless browser already
      // has unrestricted access. `['*']` allows all domains so a first-seen host
      // can never silently 403.
      //
      // allowUnsandboxedCommands lets the agent REQUEST to run something outside
      // the sandbox (e.g. `brew install`, which writes system-wide) — but that
      // request is never silent: it routes through canUseTool below and only
      // runs if the USER approves it. So the sandbox has no system-write hole:
      // the agent alone can only touch the workspace.
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        network: { allowLocalBinding: true, allowedDomains: ['*'] },
        filesystem: { allowWrite: [cwd] },
      },
      // Redirect every package manager's cache + global-install target into the
      // workspace so installs succeed *inside* it instead of hitting a
      // sandbox-blocked system path. The user's API key is injected here too:
      // a Finder-launched app inherits no shell env, so without this the SDK
      // would fall through to whatever Claude Code login is on the machine.
      env: {
        ...process.env,
        ...(resolveApiKey() ? { ANTHROPIC_API_KEY: resolveApiKey() as string } : {}),
        ...containEnv(cwd),
      },
      // Gate every Bash call. Routine commands run sandboxed with no prompt; a
      // command that installs system software (or explicitly asks to leave the
      // sandbox) pauses for the user's approval. On approval we set
      // dangerouslyDisableSandbox so the command can actually write system-wide;
      // on denial we block it. (canUseTool is shadowed for tools listed in
      // allowedTools, so this must be a PreToolUse hook.)
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input, _tuid, opts) => {
                const i = input as {
                  tool_name?: string;
                  tool_input?: Record<string, unknown>;
                };
                if (i.tool_name !== 'Bash') return {};
                const command =
                  typeof i.tool_input?.command === 'string'
                    ? i.tool_input.command
                    : '';
                const wantsEscape =
                  i.tool_input?.dangerouslyDisableSandbox === true;
                if (!wantsEscape && !needsSystemApproval(command)) return {};

                const category = approvalCategory(command);
                const approve = {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'allow' as const,
                    permissionDecisionReason: 'Approved for this workspace.',
                    updatedInput: {
                      ...(i.tool_input ?? {}),
                      dangerouslyDisableSandbox: true,
                    },
                  },
                };
                // Already granted "always allow" for this kind of action here.
                if (isApproved(agentId, category)) return approve;

                const id = randomUUID();
                const { allow, remember } = await new Promise<{
                  allow: boolean;
                  remember: boolean;
                }>((resolve) => {
                  pendingPermissions.set(id, resolve);
                  opts.signal.addEventListener('abort', () => {
                    if (pendingPermissions.delete(id))
                      resolve({ allow: false, remember: false });
                  });
                  send('agent:permission', {
                    threadId: key,
                    id,
                    tool: 'Bash',
                    command,
                    title: describeApproval(command),
                    category,
                    categoryLabel: categoryLabel(category),
                  });
                });

                if (!allow) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'deny' as const,
                      permissionDecisionReason:
                        'The user declined this system-level action.',
                    },
                  };
                }
                if (remember) rememberApproval(agentId, category);
                return approve;
              },
            ],
          },
        ],
      },
      thinking: { type: 'adaptive' },
      extraArgs: { 'thinking-display': 'summarized' },
      includePartialMessages: true,
      // Resume the prior on-disk session so the agent remembers the thread
      // across app restarts / re-opening the agent.
      resume,
      cwd,
      permissionMode: 'acceptEdits',
      // When a connected MCP tool needs the user to sign in (OAuth), it opens
      // the auth page in the browser and tells the user in-chat.
      onElicitation: async (req) => {
        if (req.mode === 'url' && req.url) {
          try {
            await shell.openExternal(req.url);
          } catch {
            /* ignore */
          }
          send('agent:mcp-auth', {
            threadId: key,
            server: req.serverName,
            message: req.message,
          });
          return { action: 'accept' };
        }
        return { action: 'decline' };
      },
    },
  });

  const handle: SessionHandle = {
    key,
    agentId,
    push: input.push,
    interrupt: () => {
      q.interrupt().catch((): void => {});
    },
    close: () => input.close(),
  };
  sessions.set(key, handle);

  // The output loop runs for the whole life of the session. Each user turn
  // ends with a `result` message → we fire 'agent:done' but keep listening.
  // Every event carries its threadId so the renderer routes it to the right
  // conversation, even when that thread isn't the one on screen.
  (async () => {
    const blockTypes: Record<number, string> = {};
    try {
      for await (const message of q) {
        const sys = message as Record<string, unknown>;
        if (sys?.type === 'system' && sys?.subtype === 'init') {
          const sid = sys.session_id as string | undefined;
          if (sid) send('agent:session', { threadId: key, sessionId: sid });
          continue;
        }
        if (sys?.type === 'stream_event') {
          streamEvent(sys, blockTypes, key, send);
          continue;
        }
        if (sys?.type === 'result') {
          send('agent:done', { threadId: key });
          continue;
        }
        for (const line of toLines(message, cwd)) {
          send('agent:message', { threadId: key, line });
        }
      }
    } catch (err) {
      send('agent:error', {
        threadId: key,
        message: err instanceof Error ? err.message : String(err),
      });
      send('agent:done', { threadId: key });
    }
    if (sessions.get(key) === handle) sessions.delete(key);
  })();

  return handle;
}

// Interrupt one thread's current turn (its session stays alive for more input).
ipcMain.on('agent:stop', (_e, threadId: string) => {
  sessions.get(threadId)?.interrupt();
});

ipcMain.on('agent:run', (event, payload: RunPayload) => {
  const send = (channel: string, data?: unknown) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, data);
  };
  const { task, instructions, allowedTools, agentId, threadId, resume } =
    payload;
  // Reuse this thread's live session if it has one (so a message can land
  // mid-run); otherwise start one. Other threads' sessions keep running.
  let s = sessions.get(threadId);
  if (!s) {
    s = startSession(threadId, agentId, instructions, allowedTools, send, resume);
  }
  s.push(task);
});

app.on('before-quit', () => {
  for (const s of sessions.values()) s.close();
  sessions.clear();
});

// ── Thread history ───────────────────────────────────────────────────────────
// Each agent keeps many conversations under agents/<id>/threads/<threadId>.json.
// A thread stores { id, title, updatedAt, sessionId, log } so the picker can
// list them and re-opening restores both the transcript and the agent's memory.
function threadsDir(agentId: string): string {
  const dir = path.join(agentsDir(), agentId, 'threads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('threads:list', async (_e, agentId: string) => {
  const dir = threadsDir(agentId);
  const out: Array<{ id: string; title: string; updatedAt: number }> = [];
  for (const f of await fsp.readdir(dir).catch((): string[] => [])) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      out.push({
        id: t.id,
        title: t.title || 'Untitled',
        updatedAt: t.updatedAt || 0,
      });
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
});

ipcMain.handle('threads:load', async (_e, agentId: string, threadId: string) => {
  try {
    return JSON.parse(
      await fsp.readFile(path.join(threadsDir(agentId), `${threadId}.json`), 'utf8'),
    );
  } catch {
    return null;
  }
});

ipcMain.handle(
  'threads:save',
  async (_e, agentId: string, threadId: string, data: unknown) => {
    try {
      await fsp.writeFile(
        path.join(threadsDir(agentId), `${threadId}.json`),
        JSON.stringify(data),
        'utf8',
      );
    } catch {
      /* best-effort */
    }
  },
);

// ── Scheduled runs ───────────────────────────────────────────────────────────
// Each agent can have schedules in agents/<id>/schedules.json. A ticker fires
// due ones as background threads — they run exactly like a normal conversation,
// so their output streams into the thread and the agent shows as working.
type Schedule = {
  id: string;
  prompt: string;
  kind: 'daily' | 'interval';
  time?: string; // 'HH:MM' for daily
  minutes?: number; // for interval
  enabled: boolean;
  threadId: string; // persistent thread → each run continues the conversation
  lastRunAt?: number;
  nextRunAt: number;
};

function schedulesFile(agentId: string): string {
  return path.join(agentsDir(), agentId, 'schedules.json');
}

async function loadSchedules(agentId: string): Promise<Schedule[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(schedulesFile(agentId), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function saveSchedules(agentId: string, list: Schedule[]): Promise<void> {
  try {
    await fsp.writeFile(schedulesFile(agentId), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
}

function computeNextRun(s: Schedule, from = Date.now()): number {
  if (s.kind === 'interval') {
    return from + Math.max(1, s.minutes ?? 60) * 60_000;
  }
  const [h, m] = (s.time ?? '09:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function rendererSend(channel: string, data?: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

async function runScheduled(agentId: string, s: Schedule): Promise<void> {
  const pkg = await loadPackageDir(path.join(agentsDir(), agentId));
  if (!pkg) return;
  const tid = s.threadId;

  // Continue this schedule's conversation across runs.
  let resume: string | undefined;
  try {
    const t = JSON.parse(
      await fsp.readFile(path.join(threadsDir(agentId), `${tid}.json`), 'utf8'),
    );
    resume = t.sessionId ?? undefined;
  } catch {
    /* first run */
  }

  // Tell the renderer so it registers the thread, shows the prompt, and marks
  // the agent as working — even though the run wasn't user-initiated.
  rendererSend('agent:started', { threadId: tid, agentId, prompt: s.prompt });

  let sess = sessions.get(tid);
  if (!sess) {
    sess = startSession(
      tid,
      agentId,
      pkg.instructions,
      pkg.allowedTools,
      rendererSend,
      resume,
    );
  }
  sess.push(s.prompt);
}

async function tickSchedules(): Promise<void> {
  const now = Date.now();
  for (const pkg of await listDirPackages(agentsDir())) {
    const list = await loadSchedules(pkg.id);
    let changed = false;
    for (const s of list) {
      if (!s.enabled || s.nextRunAt > now) continue;
      s.lastRunAt = now;
      s.nextRunAt = computeNextRun(s, now);
      changed = true;
      runScheduled(pkg.id, s).catch((): void => {});
    }
    if (changed) await saveSchedules(pkg.id, list);
  }
}

let scheduleTimer: ReturnType<typeof setInterval> | null = null;
app.on('ready', () => {
  if (!scheduleTimer) scheduleTimer = setInterval(() => void tickSchedules(), 30_000);
  startViewServer();
  loadUsageCache();
  void fetchUsageSnapshot();
});

ipcMain.handle('view:baseUrl', () => viewBaseUrl());

// ── MCP tools ────────────────────────────────────────────────────────────────
// A small curated marketplace of popular official servers, plus name-search
// resolution via resolveMcp(). Both flows end at the same verify → add step.
const MCP_CATALOG: McpEntry[] = [
  { name: 'linear', description: 'Linear — issues, projects, cycles', transport: 'sse', url: 'https://mcp.linear.app/sse', needsAuth: true, authNote: 'Opens Linear sign-in on first use.' },
  { name: 'notion', description: 'Notion — pages and databases', transport: 'http', url: 'https://mcp.notion.com/mcp', needsAuth: true, authNote: 'Sign in to Notion when prompted.' },
  { name: 'sentry', description: 'Sentry — errors and issues', transport: 'http', url: 'https://mcp.sentry.dev/mcp', needsAuth: true, authNote: 'Sign in to Sentry when prompted.' },
  { name: 'github', description: 'GitHub — repos, issues, PRs', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', needsAuth: true, authNote: 'Requires a GitHub token / sign-in.' },
  { name: 'stripe', description: 'Stripe — payments and customers', transport: 'http', url: 'https://mcp.stripe.com', needsAuth: true, authNote: 'Requires a Stripe API key.' },
  { name: 'context7', description: 'Context7 — up-to-date library docs', transport: 'http', url: 'https://mcp.context7.com/mcp', needsAuth: false },
];

ipcMain.handle('mcp:catalog', () => MCP_CATALOG);
// Shows both what the user connected and what the plugin shipped in its .mcp.json.
ipcMain.handle('mcp:list', (_e, agentId: string) => allMcpEntries(agentId));
ipcMain.handle('mcp:resolve', (_e, name: string) => resolveMcp(name));

ipcMain.handle('mcp:add', async (_e, agentId: string, entry: McpEntry) => {
  const list = loadMcpSync(agentId).filter((x) => x.name !== entry.name);
  list.push(entry);
  await fsp.writeFile(mcpFile(agentId), JSON.stringify(list, null, 2), 'utf8');
  // New tools take effect on the next session — restart this agent's sessions.
  closeSessionsForAgent(agentId);
  return allMcpEntries(agentId);
});

ipcMain.handle('mcp:remove', async (_e, agentId: string, name: string) => {
  const list = loadMcpSync(agentId).filter((x) => x.name !== name);
  await fsp.writeFile(mcpFile(agentId), JSON.stringify(list, null, 2), 'utf8');
  closeSessionsForAgent(agentId);
  return allMcpEntries(agentId);
});

// Turn a plugin-bundled server on/off. Bundled servers can't be "removed" (they
// belong to the plugin), so the user disables them instead.
ipcMain.handle(
  'mcp:setEnabled',
  async (_e, agentId: string, name: string, enabled: boolean) => {
    const off = new Set(loadDisabledMcp(agentId));
    if (enabled) off.delete(name);
    else off.add(name);
    saveDisabledMcp(agentId, [...off]);
    closeSessionsForAgent(agentId);
    return allMcpEntries(agentId);
  },
);

ipcMain.handle('schedules:list', (_e, agentId: string) => loadSchedules(agentId));

ipcMain.handle(
  'schedules:save',
  async (_e, agentId: string, input: Partial<Schedule>) => {
    const list = await loadSchedules(agentId);
    const existing = input.id ? list.find((x) => x.id === input.id) : undefined;
    const s: Schedule = {
      id: existing?.id ?? randomUUID(),
      threadId: existing?.threadId ?? randomUUID(),
      prompt: input.prompt ?? existing?.prompt ?? '',
      kind: input.kind ?? existing?.kind ?? 'daily',
      time: input.time ?? existing?.time,
      minutes: input.minutes ?? existing?.minutes,
      enabled: input.enabled ?? existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: 0,
    };
    s.nextRunAt = computeNextRun(s);
    const next = existing
      ? list.map((x) => (x.id === s.id ? s : x))
      : [...list, s];
    await saveSchedules(agentId, next);
    return next;
  },
);

ipcMain.handle('schedules:delete', async (_e, agentId: string, id: string) => {
  const list = (await loadSchedules(agentId)).filter((x) => x.id !== id);
  await saveSchedules(agentId, list);
  return list;
});

ipcMain.handle('schedules:runNow', async (_e, agentId: string, id: string) => {
  const list = await loadSchedules(agentId);
  const s = list.find((x) => x.id === id);
  if (s) {
    s.lastRunAt = Date.now();
    await saveSchedules(agentId, list);
    await runScheduled(agentId, s);
  }
  return list;
});

ipcMain.handle(
  'threads:delete',
  async (_e, agentId: string, threadId: string) => {
    const s = sessions.get(threadId);
    if (s) {
      s.close();
      sessions.delete(threadId);
    }
    await fsp.rm(path.join(threadsDir(agentId), `${threadId}.json`), {
      force: true,
    });
  },
);

type Line = { role: 'agent' | 'system' | 'tool' | 'thinking'; text: string };
type Send = (channel: string, data?: unknown) => void;

// Relay a streaming content-block event to the renderer as start/delta/end
// signals. Text and thinking stream live; tool_use is left to the finalized
// assistant message (its input JSON is complete there).
function streamEvent(
  msg: Record<string, unknown>,
  blockTypes: Record<number, string>,
  threadId: string,
  send: Send,
): void {
  const ev = msg.event as Record<string, unknown> | undefined;
  if (!ev) return;

  if (ev.type === 'content_block_start') {
    const idx = ev.index as number;
    const t = (ev.content_block as Record<string, unknown>)?.type as string;
    blockTypes[idx] = t;
    if (t === 'text') send('agent:stream-start', { threadId, kind: 'text' });
    else if (t === 'thinking') send('agent:stream-start', { threadId, kind: 'thinking' });
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta as Record<string, unknown> | undefined;
    if (d?.type === 'text_delta') {
      send('agent:stream-delta', { threadId, kind: 'text', text: d.text as string });
    } else if (d?.type === 'thinking_delta') {
      send('agent:stream-delta', { threadId, kind: 'thinking', text: d.thinking as string });
    }
  } else if (ev.type === 'content_block_stop') {
    const idx = ev.index as number;
    const t = blockTypes[idx];
    if (t === 'text' || t === 'thinking') send('agent:stream-end', { threadId, kind: t });
    delete blockTypes[idx];
  }
}

// tool_use is the only content we render from the finalized assistant message —
// text and thinking already streamed live (see streamEvent). All other noise
// (system, user, rate-limit, result) is dropped.
function toLines(m: unknown, cwd: string): Line[] {
  const msg = m as Record<string, unknown>;
  if (msg?.type !== 'assistant') return [];

  const content = (msg.message as Record<string, unknown>)?.content as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(content)) return [];

  const lines: Line[] = [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      if (NOISE_TOOLS.has(block.name as string)) continue; // internal plumbing
      lines.push({ role: 'tool', text: describeTool(block, cwd) });
    }
  }
  return lines;
}

// Internal tools that carry no meaning for a human watching — hidden entirely.
const NOISE_TOOLS = new Set(['ToolSearch', 'TodoWrite']);

// Friendly verbs for the built-in tools, so a line reads "Write · cover.md"
// rather than exposing raw tool names + absolute paths.
const TOOL_LABELS: Record<string, string> = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit notebook',
  Bash: 'Run',
  Glob: 'Search',
  Grep: 'Search',
  WebSearch: 'Web search',
  WebFetch: 'Fetch',
  TodoWrite: 'Plan',
  Task: 'Delegate',
};

function describeTool(block: Record<string, unknown>, cwd: string): string {
  const rawName = (block.name as string) ?? 'tool';
  // mcp__browser__browser_navigate → "Browser · navigate"
  const label = rawName.startsWith('mcp__browser__')
    ? `Browser · ${rawName.replace('mcp__browser__browser_', '').replace(/_/g, ' ')}`
    : (TOOL_LABELS[rawName] ?? rawName);
  const input = (block.input as Record<string, unknown>) ?? {};

  // Pick the most meaningful field, and remember what kind it is so we can
  // format it well (paths keep their filename, commands/URLs keep their front).
  let target: string | undefined;
  let kind: 'path' | 'cmd' | 'url' | 'text' = 'text';
  if (typeof input.file_path === 'string') (target = input.file_path), (kind = 'path');
  else if (typeof input.path === 'string') (target = input.path), (kind = 'path');
  else if (typeof input.command === 'string') (target = input.command), (kind = 'cmd');
  else if (typeof input.url === 'string') (target = input.url), (kind = 'url');
  else if (typeof input.pattern === 'string') (target = input.pattern), (kind = 'text');
  else if (typeof input.query === 'string') (target = input.query), (kind = 'text');
  if (!target) return label;

  if (kind === 'url') {
    try {
      const u = new URL(target);
      target = u.host + (u.pathname === '/' ? '' : u.pathname);
    } catch {
      /* leave as-is */
    }
    if (target.length > 56) target = target.slice(0, 55) + '…';
  } else if (kind === 'path') {
    const home = app.getPath('home');
    if (cwd && target.startsWith(cwd + '/')) target = target.slice(cwd.length + 1);
    else if (target.startsWith(home + '/')) target = '~' + target.slice(home.length);
    if (target.length > 56) target = '…/' + target.slice(target.lastIndexOf('/') + 1);
  } else if (kind === 'cmd') {
    target = target.replace(/\s+/g, ' ').trim();
    // Drop a leading `cd <path> &&|;` — the agent just entering its work dir.
    target = target.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, '');
    // Drop leading shell variable assignments (`S="/very/long/path" cmd …`, or
    // `S=…; cmd …`). They're setup, not the action, and a long value would eat
    // the whole label — every such line would truncate to the same useless text.
    let prev: string;
    do {
      prev = target;
      target = target.replace(
        /^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s*(?:&&|;)?\s*/,
        '',
      );
    } while (target !== prev && target);
    // Collapse any remaining absolute work-dir paths to nothing.
    if (cwd) target = target.split(`${cwd}/`).join('').split(cwd).join('.');
    target = target.trim() || 'a command';
    if (target.length > 64) target = target.slice(0, 63) + '…';
  } else {
    // search text / pattern — one line, truncate from the front.
    target = target.replace(/\s+/g, ' ').trim();
    if (target.length > 64) target = target.slice(0, 63) + '…';
  }
  return `${label} · ${target}`;
}
