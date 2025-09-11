// Track files currently being updated from remote to suppress local echo
const updatingFromRemoteFiles: Set<string> = new Set();
// Live Share style collaborative coding extension
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// Session management
interface CollaborationSession {
    sessionId: string;
    role: 'host' | 'guest';
    participants: Map<string, Participant>;
    sharedWorkspace: vscode.WorkspaceFolder;
    permissions: SessionPermissions;
}

interface Participant {
    id: string;
    name: string;
    email?: string;
    role: 'host' | 'guest';
    permissions: ParticipantPermissions;
    cursor?: vscode.Position;
    selection?: vscode.Selection;
    activeFile?: string;
    lastSeen: Date;
}

interface SessionPermissions {
    allowGuestEdit: boolean;
    allowGuestDebug: boolean;
    allowGuestTerminal: boolean;
    allowGuestFileCreate: boolean;
    allowGuestFileDelete: boolean;
}

interface ParticipantPermissions {
    canEdit: boolean;
    canDebug: boolean;
    canAccessTerminal: boolean;
    canCreateFiles: boolean;
    canDeleteFiles: boolean;
    canViewFiles: boolean;
}

// Global state

let currentSession: CollaborationSession | null = null;
let ws: WebSocket | null = null;
let sessionStatusItem: vscode.StatusBarItem;
let inviteCodeStatusItem: vscode.StatusBarItem | null = null;
let removedParticipantIds: Set<string> = new Set();
let __cwm_wasHost: boolean = false;
let sessionStartMs: number | null = null; // Shared timer start (host-sourced)
let statusBarTimer: NodeJS.Timeout | null = null; // Ticks status bar every second when active

function ensureSessionStatusItem() {
    if (!sessionStatusItem) {
        sessionStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
        sessionStatusItem.command = 'code-with-me.showSessionMenu';
    }
    if (!inviteCodeStatusItem) {
        // Slightly higher priority than syncStatusItem so it sits to the left of it
        inviteCodeStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
        inviteCodeStatusItem.command = 'code-with-me.copyInvite';
    }
}

function refreshSessionStatusBar() {
    ensureSessionStatusItem();
    const isHost = (currentSession?.role === 'host' || currentRole === 'host');
    const isGuest = (currentSession?.role === 'guest' || currentRole === 'guest');
    const showEvenIfStopped = __cwm_wasHost && !isHost; // show in red after stop
    if (!isHost && !isGuest && !showEvenIfStopped) {
        sessionStatusItem.hide();
        return;
    }
    const guestCount = currentSession?.participants ?
        Array.from(currentSession.participants.values()).filter(p => p.id !== currentUserId && !removedParticipantIds.has(p.id)).length : 0;
    const active = !!(ws && ws.readyState === WebSocket.OPEN && currentSession);
    // Keep a ticking timer while active and we have a start time
    if (active && sessionStartMs != null) {
        if (!statusBarTimer) {
            try { statusBarTimer = setInterval(() => refreshSessionStatusBar(), 1000); } catch {}
        }
    } else {
        if (statusBarTimer) { try { clearInterval(statusBarTimer); } catch {} statusBarTimer = null; }
    }
    // Allow overriding codicon via configuration
    const cfg = vscode.workspace.getConfiguration('code-with-me');
    const compact: boolean = !!cfg.get<boolean>('statusBarCompact');
    const clickAction: string = (cfg.get<string>('statusBarClickAction') || 'menu'); // 'menu' | 'stop'
    const customCodicon = cfg.get<string>('statusBarCodicon');
    const iconActive = customCodicon || 'broadcast';
    const iconStopped = 'circle-slash';
    const formatElapsed = (start: number | null) => {
        if (!start) {return '';}
        const total = Math.max(0, Math.floor((Date.now() - start) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n: number) => n.toString().padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    };
    // Normalize optional logo to a proper URI (supports local paths and http/https/file URIs)
    const logoRaw = cfg.get<string>('statusBarLogo');
    let logoUri: string | undefined;
    if (logoRaw && typeof logoRaw === 'string') {
        try {
            if (logoRaw.startsWith('http://') || logoRaw.startsWith('https://') || logoRaw.startsWith('file:')) {
                logoUri = logoRaw;
            } else {
                logoUri = vscode.Uri.file(logoRaw).toString();
            }
        } catch {
            // ignore invalid paths
        }
    }
    if (active) {
        if (isHost) {
            sessionStatusItem.text = compact
                ? `$(${iconActive})`
                : `$(${iconActive}) Hosting Code With Me (${guestCount})${sessionStartMs != null ? ` • ${formatElapsed(sessionStartMs)}` : ''}`;
            // Tooltip: support optional logo image via config (statusBarLogo)
            if (logoUri) {
                const md = new vscode.MarkdownString();
                md.isTrusted = false;
                md.appendMarkdown(`![logo](${logoUri}|height=16)\n`);
                md.appendText(`Hosting session${guestCount ? ` • ${guestCount} participant(s)` : ' • waiting for guests'}`);
                sessionStatusItem.tooltip = md;
            } else {
                sessionStatusItem.tooltip = `Hosting session${guestCount ? ` • ${guestCount} participant(s)` : ' • waiting for guests'}`;
            }
            // Color logic: red until a guest joins, green after at least one guest
            sessionStatusItem.color = new vscode.ThemeColor(guestCount > 0 ? 'charts.green' : 'charts.red');
            // Click action when hosting
            sessionStatusItem.command = (clickAction === 'stop') ? 'code-with-me.stopSession' : 'code-with-me.showSessionMenu';

            // Compute and show invite code item (host only)
            const code = lastSessionUrl ? lastSessionUrl.substring(lastSessionUrl.lastIndexOf('/') + 1) : '';
            if (inviteCodeStatusItem) {
                if (code) {
                    inviteCodeStatusItem.text = `$(key) CWM: ${code}`;
                    const tip = new vscode.MarkdownString();
                    tip.appendMarkdown(`Click to copy code\n\n`);
                    if (lastSessionUrl) {
                        tip.appendMarkdown(`URL: ${lastSessionUrl}`);
                    }
                    inviteCodeStatusItem.tooltip = tip;
                    inviteCodeStatusItem.show();
                } else {
                    inviteCodeStatusItem.hide();
                }
            }
        } else if (isGuest) {
            // Guest view
            const guestIcon = 'pass'; // checkmark-like icon
            sessionStatusItem.text = compact
                ? `$(${guestIcon})`
                : `$(${guestIcon}) Connected to Host${sessionStartMs != null ? ` • ${formatElapsed(sessionStartMs)}` : ''}`;
            sessionStatusItem.tooltip = 'Connected to Host — Click to leave the session';
            sessionStatusItem.color = new vscode.ThemeColor('charts.green');
            sessionStatusItem.command = 'code-with-me.stopSession'; // acts as Leave session for guests
            if (inviteCodeStatusItem) { inviteCodeStatusItem.hide(); }
        }
    } else {
        // When stopped, show icon-only to avoid the "stopped" label as requested
        sessionStatusItem.text = `$(${iconStopped})`;
        if (logoUri) {
            const md = new vscode.MarkdownString();
            md.isTrusted = false;
            md.appendMarkdown(`![logo](${logoUri}|height=16)\n`);
            md.appendText('Session stopped');
            sessionStatusItem.tooltip = md;
        } else {
            sessionStatusItem.tooltip = 'Session stopped';
        }
        sessionStatusItem.color = new vscode.ThemeColor('charts.red');
        // When stopped, clicking opens the menu
        sessionStatusItem.command = 'code-with-me.showSessionMenu';
        if (inviteCodeStatusItem) { inviteCodeStatusItem.hide(); }
    }
    sessionStatusItem.show();
}

async function showHostSessionMenu() {
    const isHost = (currentSession?.role === 'host' || currentRole === 'host');
    if (!isHost) {
        vscode.window.showInformationMessage('Only the host can manage the session.');
        return;
    }
    const participants = currentSession?.participants ? Array.from(currentSession.participants.values()) : [];

    // Inline one-line Remove via QuickPick item buttons
    const qp = vscode.window.createQuickPick();
    qp.title = 'Code With Me — Host controls';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    const makeItem = (p: any): (vscode.QuickPickItem & { detail?: string; buttons?: vscode.QuickInputButton[] }) => {
        const blocked = removedParticipantIds.has(p.id);
        const buttons: vscode.QuickInputButton[] = [
            { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' }
        ];
        return {
            label: `${blocked ? '$(circle-slash) ' : ''}${p.name || p.id}`,
            description: blocked ? '(removed/blocked)' : undefined,
            detail: p.id,
            buttons
        } as any;
    };

    const itemsWithButtons: (vscode.QuickPickItem & { detail?: string; buttons?: vscode.QuickInputButton[] })[] = [];
    for (const p of participants) {
        if (p.id === currentUserId) { continue; }
        itemsWithButtons.push(makeItem(p));
    }
    if (itemsWithButtons.length === 0) {
        itemsWithButtons.push({ label: 'No guests connected', description: undefined } as any);
    }
    itemsWithButtons.push({ label: '$(debug-stop) Stop session', description: 'End collaboration session' } as any);
    qp.items = itemsWithButtons;

    const disposeAll = () => { try { qp.dispose(); } catch {} };

    qp.onDidTriggerItemButton(async (e) => {
        const id = (e.item as any).detail as string | undefined;
        if (!id) { return; }
        const name = participants.find(p => p.id === id)?.name || id;
        const confirm = await vscode.window.showWarningMessage(`Remove ${name} from the session?`, { modal: true }, 'Remove');
        if (confirm !== 'Remove') { return; }
        try {
            removedParticipantIds.add(id);
            currentSession?.participants?.delete(id);
            refreshSessionStatusBar();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'kick-guest', participantId: id, guestId: id, reason: 'removed_by_host', timestamp: Date.now() }));
            }
            vscode.window.showInformationMessage(`${name} has been removed and disconnected.`);
            // Refresh list
            const updated = currentSession?.participants ? Array.from(currentSession.participants.values()) : [];
            qp.items = updated.filter(p => p.id !== currentUserId).map(makeItem) as any;
        } catch (e) {
            vscode.window.showErrorMessage('Failed to remove participant');
        }
    });

    qp.onDidAccept(async () => {
        const choice = qp.selectedItems[0];
        if (!choice) { disposeAll(); return; }
        if (choice.label.startsWith('$(debug-stop)')) {
            disposeAll();
            await vscode.commands.executeCommand('code-with-me.stopSession');
            refreshSessionStatusBar();
            return;
        }
        // Ignore selecting participant rows (remove is via button)
        disposeAll();
    });

    qp.onDidHide(() => disposeAll());
    qp.show();
}
let participantStatusItem: vscode.StatusBarItem;
let syncStatusItem: vscode.StatusBarItem;
let currentUserId: string = crypto.randomUUID();
let currentRole: 'host' | 'guest' | null = null;
let collaborativeSession: any = null;
let participantCursors: Map<string, any> = new Map();
let participantCursorDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
let lastSessionUrl: string = '';
let hostSessionPermissions: SessionPermissions | null = null;
let guestSessionPermissions: SessionPermissions | null = null;
let guestUntitledMap: Map<string, vscode.TextDocument> = new Map();
// Tracks guest-initiated requests to open/receive content for a specific file.
// Used to ensure we only auto-open on the guest when it explicitly requested the content.
const pendingFileContentRequests: Set<string> = new Set();
// Optional timestamps for pending requests to avoid late/stale opens
const pendingFileContentAt: Map<string, number> = new Map();
let lastProcessedContent: Map<string, string> = new Map();
let isStopping: boolean = false;
// Session-scoped disposables (event listeners, watchers, etc.)
let sessionDisposables: vscode.Disposable[] = [];
// Guards to prevent duplicate registration
let sessionListenersActive = false;
let fileWatchersActive = false;

// New variables for batching and sequence tracking
let lastProcessedSequence = 0;
let pendingChanges: Map<string, any[]> = new Map();
let batchTimeout: NodeJS.Timeout | null = null;
const BATCH_DELAY = 50; // ms
// Per-file outgoing sequence counters
const fileSeqCounter: Map<string, number> = new Map();
// Per-file, per-sender last processed sequence to de-duplicate on receive
const lastProcessedSeqByFileAndSender: Map<string, Map<string, number>> = new Map();
// Recently applied message IDs to avoid duplicate processing regardless of server behavior
const recentMessageIds: string[] = [];
// A robust guard to link remote edits to the events they produce.
// Map<filePath, { resolve: () => void, reject: (reason?: any) => void }>
const editConfirmationPromises = new Map<string, { resolve: () => void, reject: (reason?: any) => void }>();

// Presence smoothing for many participants: debounce remote cursor decorations
const cursorDecorateTimers: Map<string, NodeJS.Timeout> = new Map();
const CURSOR_DECORATE_MS = 40;

// Local cursor send debounce and dedupe
const cursorSendTimers: Map<string, NodeJS.Timeout> = new Map(); // key: filePath
const lastSentCursorPos: Map<string, { line: number; character: number }> = new Map();
const CURSOR_SEND_MS = 45;

// Per-file apply queue to serialize incoming edits and avoid interleaving
const perFileApplyQueue: Map<string, Promise<void>> = new Map();
function enqueueFileChange(filePath: string, task: () => Promise<void>): Promise<void> {
    const previous = perFileApplyQueue.get(filePath) ?? Promise.resolve();
    const next = previous
        .then(() => task())
        .catch((e) => {
            console.error('[CodeWithMe] Error in queued file apply for', filePath, e);
        })
        .finally(() => {
            // Only clear if we are still the tail
            if (perFileApplyQueue.get(filePath) === next) {
                perFileApplyQueue.delete(filePath);
            }
        });
    perFileApplyQueue.set(filePath, next);
    return next;
}

// Attribution: global decoration cache and per-file ownership map
const attributionDecorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
// Map<filePath, Map<lineNumber, { userName: string }>>
const lineOwnership: Map<string, Map<number, { userName: string }>> = new Map();

// Auto-reload guards on unexpected disconnects
let __cwm_reloadScheduled: boolean = false;
let __cwm_reloadBackoffMs: number = 1000; // start with 1s
const __cwm_reloadBackoffMaxMs: number = 8000; // cap at 8s
function scheduleReload(reason: string) {
    try {
        if (__cwm_reloadScheduled) { return; }
        // Do not auto-reload if user explicitly stopped the session
        if (isStopping) { return; }
        __cwm_reloadScheduled = true;
        console.log(`[CodeWithMe] Scheduling window reload due to ${reason} in ${__cwm_reloadBackoffMs}ms`);
        const delay = __cwm_reloadBackoffMs;
        __cwm_reloadBackoffMs = Math.min(__cwm_reloadBackoffMs * 2, __cwm_reloadBackoffMaxMs);
        setTimeout(() => {
            try {
                // reset the flag just before reload attempt
                __cwm_reloadScheduled = false;
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            } catch (e) {
                console.error('[CodeWithMe] Failed to execute reloadWindow command', e);
            }
        }, delay);
    } catch (e) {
        console.error('[CodeWithMe] scheduleReload error', e);
    }
}
// Cache: compact header labels per user (one label per contiguous block)
/* Per-user compact header decorations (one label per contiguous block) */
const headerDecorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();

// GitHub identity (populated via VS Code auth API) — single definition
interface GitHubIdentity {
    userId: string;
    userName: string;
    token?: string;
}
// Module-level cached identity
let cwmCurrentIdentity: GitHubIdentity | null = null;

// Resolve a stable display name for attribution
function getDisplayUserName(roleHint?: 'host' | 'guest'): string {
    try {
        if (cwmCurrentIdentity?.userName) {return cwmCurrentIdentity.userName;}
        // Try VS Code authenticated accounts (silent)
        // Note: we won't block if it fails
        const anyGlobal = (global as any);
        const cached = anyGlobal.__cwm_fallbackUserName;
        if (cached) {return cached;}
        const os = require('os');
        const envUser = process.env['GIT_AUTHOR_NAME'] || process.env['USER'] || process.env['USERNAME'] || os.userInfo()?.username;
        const name = envUser || (roleHint === 'host' ? 'Host' : roleHint === 'guest' ? 'Guest' : 'Unknown');
        anyGlobal.__cwm_fallbackUserName = name;
        return name;
    } catch {
        return roleHint === 'host' ? 'Host' : roleHint === 'guest' ? 'Guest' : 'Unknown';
    }
}

/**
 * Generates a short, memorable, and URL-friendly session code.
 * e.g., ABC-DEF
 */
function generateSessionCode(length: number = 6): string {
    // Using a character set that avoids ambiguous characters (I, O, 0, 1)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Add a dash for readability if the length is 6
    if (length === 6) {
        return `${result.substring(0, 3)}-${result.substring(3, 6)}`;
    }
    return result;
}

// Decorations for showing other participants
let participantDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
let cursorDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();

// NEW: Function to create a decoration for a participant's cursor
function getParticipantCursorDecoration(participantId: string, userName: string): vscode.TextEditorDecorationType {
    if (participantCursorDecorations.has(participantId)) {
        return participantCursorDecorations.get(participantId)!;
    }

    // Neutral, subtle styling (transparent-like) with smaller name label
    // Use a very light border and a small, unobtrusive label without solid background color
    const borderColor = 'rgba(128,128,128,0.35)';
    const labelColor = '#888';
    const decoration = vscode.window.createTextEditorDecorationType({
        // Thin, subtle border to indicate cursor without strong color
        border: `1px solid ${borderColor}`,
        borderRadius: '2px',
        after: {
            contentText: ` ${userName}`,
            margin: '0 0 0 4px',
            backgroundColor: 'transparent',
            color: labelColor,
            border: `1px solid rgba(128,128,128,0.25)`,
            // Make the label smaller and more transparent
            textDecoration: 'none; font-size: 12px; opacity: 0.7; padding: 0 2px; border-radius: 2px;',
            fontWeight: 'normal',
        },
    });

    participantCursorDecorations.set(participantId, decoration);
    return decoration;
}

// NEW: Function to render all participant cursors in the active editor
function updateParticipantCursors() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {return;}

    // Clear all previous cursor decorations
    participantCursorDecorations.forEach(deco => editor.setDecorations(deco, []));

    for (const [id, cursor] of participantCursors.entries()) {
        // Only draw if the cursor is in the currently active file
        let currentEditorHostPath = editor.document.uri.fsPath;
        if (currentRole === 'guest') {
            try {
                for (const [hostPath, doc] of guestUntitledMap.entries()) {
                    if (doc === editor.document) { currentEditorHostPath = hostPath; break; }
                }
            } catch {}
        }
        if (cursor.filePath === currentEditorHostPath) {
            const userName = cursor.user?.userName || 'Guest';
            const decorationType = getParticipantCursorDecoration(id, userName);
            const range = new vscode.Range(cursor.position, cursor.position);
            editor.setDecorations(decorationType, [range]);
        }
    }
}

function getUserDecoration(userName: string): vscode.TextEditorDecorationType {
    if (attributionDecorationTypes.has(userName)) {return attributionDecorationTypes.get(userName)!;}
    // Unified blue color for all ownership highlights
    const color = '#2F81F7'; // blue
    const deco = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: 'rgba(47, 129, 247, 0.10)',
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        borderColor: 'rgba(47, 129, 247, 0.40)',
        borderWidth: '1px 0 0 0',
        borderStyle: 'solid'
    });
    attributionDecorationTypes.set(userName, deco);
    return deco;
}
// Per-user compact header decoration (used once per contiguous block)
function getHeaderDecoration(userName: string): vscode.TextEditorDecorationType {
    // Cache per user so labels are stable
    if (headerDecorationTypes.has(userName)) {return headerDecorationTypes.get(userName)!;}

    // Show pill at end of the line (right side), subtle and compact
    const header = vscode.window.createTextEditorDecorationType({
        isWholeLine: false,
        rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
        before: undefined,
        after: {
            contentText: '',
            // place at end of line: small margin to the right and slight vertical lift
            margin: '-0.2em 0 0 6px',
            color: '#2F81F7',
            backgroundColor: 'rgba(47, 129, 247, 0.15)',
            textDecoration: `
                none;
                font-weight: 500;
                border-radius: 5px;
                padding: 0px 6px;
                font-size: 0.8em;
                letter-spacing: 0.2px;
            `
        }
    });
    headerDecorationTypes.set(userName, header);
    return header;
}
// Persistent per-user header decoration used to render the label above the line
/* ensure only one getHeaderDecoration() implementation exists in file */

// Apply persistent per-line ownership decorations to an editor
function refreshOwnershipDecorations(editor: vscode.TextEditor) {
    try {
        // Resolve host path for guest untitled docs so our lineOwnership map matches
        let filePath = editor.document.fileName;
        if (currentRole === 'guest') {
            try {
                for (const [hostPath, doc] of guestUntitledMap.entries()) {
                    if (doc === editor.document) { filePath = hostPath; break; }
                }
            } catch {}
        }
        const map = lineOwnership.get(filePath);

        // Clear previously applied ownership decorations
        attributionDecorationTypes.forEach((deco) => editor.setDecorations(deco, []));
        headerDecorationTypes.forEach((deco) => editor.setDecorations(deco, []));

        if (!map) {return;}

        // 1) Collect owned lines per user
        const perUserLines = new Map<string, number[]>();
        for (const [line, meta] of map.entries()) {
            if (line >= editor.document.lineCount) {continue;}
            const arr = perUserLines.get(meta.userName) ?? [];
            arr.push(line);
            perUserLines.set(meta.userName, arr);
        }

        // Show ownership labels for all contributors (host and guests) on both sides

        // 2) For each user, sort and compress into contiguous blocks
        for (const [userName, lines] of perUserLines.entries()) {
            lines.sort((a, b) => a - b);

            const highlightRanges: vscode.Range[] = [];
            const headerOpts: vscode.DecorationOptions[] = [];

            let i = 0;
            while (i < lines.length) {
                let startLine = lines[i];
                let endLine = startLine;

                while (i + 1 < lines.length && lines[i + 1] === endLine + 1) {
                    endLine = lines[i + 1];
                    i++;
                }

                // Whole-line highlight for all lines in the block
                for (let ln = startLine; ln <= endLine; ln++) {
                    const text = editor.document.lineAt(Math.min(ln, editor.document.lineCount - 1)).text;
                    const r = new vscode.Range(new vscode.Position(ln, 0), new vscode.Position(ln, Math.max(0, text.length)));
                    highlightRanges.push(r);
                }

                // Single compact pill above the first line of the block
                // render at end of the edited line (right side)
                const line = startLine;
                const lineEnd = new vscode.Position(line, Number.MAX_SAFE_INTEGER);
                headerOpts.push({
                    range: new vscode.Range(lineEnd, lineEnd),
                    renderOptions: {
                        after: {
                            contentText: `  \u{1F464} ${userName}  `
                        }
                    }
                });

                i++;
            }

            const lineDeco = getUserDecoration(userName);
            const headerDeco = getHeaderDecoration(userName);
            editor.setDecorations(lineDeco, highlightRanges);
            editor.setDecorations(headerDeco, headerOpts);
        }
    } catch (e) {
        console.error('[CodeWithMe] refreshOwnershipDecorations error', e);
    }
}


// WebSocket server URL
// Updated to point to the EC2 instance
const DEFAULT_PUBLIC_WS_URL = 'ws://ec2-52-66-143-241.ap-south-1.compute.amazonaws.com:3000';

// Message types for WebSocket communication
const MESSAGE_TYPES = {
    SESSION_STOPPED: 'session-stopped',
    GUEST_LEFT: 'guest-left',
    // Add other message types here if needed
};

// Tree view provider for host workspace
class HostWorkspaceProvider implements vscode.TreeDataProvider<WorkspaceItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<WorkspaceItem | undefined | null | void> = new vscode.EventEmitter<WorkspaceItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<WorkspaceItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private workspaceTree: any[] = [];

    refresh(workspaceTree: any[]) {
        console.log('[CodeWithMe] HostWorkspaceProvider: Refreshing with', workspaceTree.length, 'items');
        console.log('[CodeWithMe] HostWorkspaceProvider: Tree data:', workspaceTree);
        this.workspaceTree = workspaceTree;
        this._onDidChangeTreeData.fire();
        console.log('[CodeWithMe] HostWorkspaceProvider: Tree data updated and fired change event');
    }

    getTreeItem(element: WorkspaceItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: WorkspaceItem): Thenable<WorkspaceItem[]> {
        if (!element) {
            // Root level - return workspace items
            console.log('[CodeWithMe] HostWorkspaceProvider: Getting root children, workspaceTree length:', this.workspaceTree.length);
            const items = this.workspaceTree.map(item => new WorkspaceItem(item));
            console.log('[CodeWithMe] HostWorkspaceProvider: Created', items.length, 'root items');
            return Promise.resolve(items);
        } else {
            // Child level - return children of folders
            console.log('[CodeWithMe] HostWorkspaceProvider: Getting children for element:', element.item.name, 'type:', element.item.type);
            if (element.item.type === 'folder' && element.item.children) {
                const children = element.item.children.map((child: any) => new WorkspaceItem(child));
                console.log('[CodeWithMe] HostWorkspaceProvider: Created', children.length, 'child items for folder:', element.item.name);
                return Promise.resolve(children);
            }
            return Promise.resolve([]);
        }
    }
}

// Workspace item class
class WorkspaceItem extends vscode.TreeItem {
    constructor(public item: any) {
        super(
            item.name,
            item.type === 'folder' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        this.tooltip = item.path || item.name;
        this.description = item.type === 'file' ? 'file' : 'folder';
        
        if (item.type === 'file') {
            this.iconPath = new vscode.ThemeIcon('file');
            this.contextValue = 'file';
            if (item.isOpen) {
                this.description = 'Open';
            } else if (item.isModified) {
                this.description = 'Modified';
            } else {
                this.description = 'File';
            }
            // Enable click-to-open behavior for Guest
            this.command = {
                title: 'Open',
                // IMPORTANT: align command id with the actual registration below
                command: 'code-with-me.openFromExplorer',
                arguments: [this.item]
            };
        } else {
            this.iconPath = new vscode.ThemeIcon('folder');
            this.contextValue = 'folder';
            if (item.hasOpenFiles) {
                this.description = 'Folder (has open files)';
            } else {
                this.description = 'Folder';
            }
        }
    }
}

// Global tree view provider instance
let codeWithMeTreeProvider: CodeWithMeTreeProvider | null = null;

// Code with me tree provider (Guest-side Explorer)
class CodeWithMeTreeProvider implements vscode.TreeDataProvider<WorkspaceItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<WorkspaceItem | undefined | null | void> = new vscode.EventEmitter<WorkspaceItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<WorkspaceItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private tree: any[] = [];

    setTree(hostTree: any[]) {
        this.tree = Array.isArray(hostTree) ? hostTree : [];
        this._onDidChangeTreeData.fire();
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WorkspaceItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: WorkspaceItem): Thenable<WorkspaceItem[]> {
        if (!element) {
            const items = this.tree.map(node => new WorkspaceItem(node));
            return Promise.resolve(items);
        }
        if (element.item.type === 'folder' && Array.isArray(element.item.children)) {
            return Promise.resolve(element.item.children.map((n: any) => new WorkspaceItem(n)));
        }
        return Promise.resolve([]);
    }
}

// Function to create WebSocket connection
function createWebSocket(url: string): any {
    // Use the global WebSocket if available, otherwise use require
    if (typeof WebSocket !== 'undefined') {
        return new WebSocket(url);
    } else {
        const WebSocket = require('ws');
        return new WebSocket(url);
    }
}

// Function to get language from file path
function getLanguageFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: { [key: string]: string } = {
        '.js': 'javascript',
        '.ts': 'typescript',
        '.py': 'python',
        '.java': 'java',
        '.cpp': 'cpp',
        '.c': 'c',
        '.html': 'html',
        '.css': 'css',
        '.json': 'json',
        '.md': 'markdown'
    };
    return languageMap[ext] || 'plaintext';
}

// Screen sharing removed: legacy screen capture and streaming paths deleted

// Legacy VS Code state sync removed

// Legacy screen update loop, WebRTC, and input simulation code removed.

// Collaborative editing - no screen capture, real-time file sync
async function setupCollaborationSession(url: string, role: 'Host' | 'Guest') {
    try {
        console.log(`[CodeWithMe] ${role}: Setting up collaboration with URL:`, url);
        
        // Connect to WebSocket server
        ws = new WebSocket(url);
        currentRole = role.toLowerCase() as 'host' | 'guest';
        
        ws.onopen = async () => {
            console.log(`[CodeWithMe] ${role}: WebSocket connected successfully`);
            
            // Send role identification
            ws!.send(JSON.stringify({
                type: 'role-identification',
                role: role,
                userName: getDisplayUserName(role.toLowerCase() as 'host' | 'guest'),
                timestamp: Date.now()
            }));

            // Initialize currentSession so status bar and menus can reflect state
            try {
                const sessionIdFromUrl = (() => {
                    try { return new URL(url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; }
                })();
                const sharedWorkspace = vscode.workspace.workspaceFolders?.[0] as vscode.WorkspaceFolder;
                currentSession = {
                    sessionId: sessionIdFromUrl,
                    role: (role.toLowerCase() as 'host' | 'guest'),
                    participants: new Map<string, Participant>(),
                    sharedWorkspace,
                    permissions: (role === 'Host' ? (hostSessionPermissions as SessionPermissions) : (guestSessionPermissions as SessionPermissions)) || {
                        allowGuestEdit: true,
                        allowGuestDebug: false,
                        allowGuestTerminal: false,
                        allowGuestFileCreate: true,
                        allowGuestFileDelete: false,
                    }
                };
                // Add self to participant map for reference (filtered from guest count by id)
                currentSession.participants.set(currentUserId, {
                    id: currentUserId,
                    name: getDisplayUserName(currentRole || undefined as any),
                    role: (role.toLowerCase() as 'host' | 'guest'),
                    permissions: {
                        canEdit: true,
                        canDebug: false,
                        canAccessTerminal: false,
                        canCreateFiles: true,
                        canDeleteFiles: false,
                        canViewFiles: true,
                    },
                    lastSeen: new Date()
                } as Participant);
            } catch (e) {
                console.warn('[CodeWithMe] Failed to initialize currentSession on open', e);
            }
            // Show initial status (red until a guest joins)
            try { refreshSessionStatusBar(); } catch {}

            if (role === 'Host') {
                await setupHostCollaborativeSession();
                vscode.window.showInformationMessage('Host session started. Share the invite link with collaborators.');
                // Proactively send workspace info shortly after connect
                setTimeout(() => {
                    console.log('[CodeWithMe] Host: Handshake kick - sending workspace-info');
                    sendWorkspaceInfo();
                }, 400);
            } else {
                await setupGuestCollaborativeSession();
                vscode.window.showInformationMessage('Connected to host. You can now collaborate in real-time.');
                // Handshake: guest announces presence; DO NOT require explicit request for workspace
                const helloMsg = { 
                    type: 'hello-guest', 
                    guestId: currentUserId, 
                    userName: getDisplayUserName('guest'),
                    timestamp: Date.now() 
                };
                try {
                    ws!.send(JSON.stringify(helloMsg));
                    console.log('[CodeWithMe] Guest: Sent hello-guest handshake');
                } catch (e) {
                    console.log('[CodeWithMe] Guest: Failed to send hello-guest', e);
                }
                // Auto-focus the Code with me explorer so the user sees the tree immediately
                setTimeout(async () => {
                    try {
                        await vscode.commands.executeCommand('code-with-me-explorer.focus');
                        console.log('[CodeWithMe] Guest: Focused Code with me explorer');
                    } catch (e) {
                        console.log('[CodeWithMe] Guest: Could not focus explorer', e);
                    }
                }, 500);
            }
        };
        
        ws.onerror = async (error: any) => {
            console.error(`[CodeWithMe] ${role}: WebSocket error:`, error);
            vscode.window.showErrorMessage(`Connection failed. Make sure the server is running.`);
            // Perform same cleanup as guest stop flow so no editors linger
            try {
                cleanupSessionState();
                if ((currentRole || role.toLowerCase()) === 'guest') {
                    await discardAndCloseAllEditors();
                }
            } catch (e) {
                console.warn('[CodeWithMe] Cleanup on error failed', e);
            }
            // Auto-reload on any socket error (network drop, host crash, etc.)
            scheduleReload('socket-error');
        };
        
        ws.onclose = async () => {
            console.log(`[CodeWithMe] ${role}: WebSocket connection closed`);
            vscode.window.showWarningMessage('Session disconnected.');
            // Perform same cleanup as guest stop flow so no editors linger
            try {
                cleanupSessionState();
                if ((currentRole || role.toLowerCase()) === 'guest') {
                    await discardAndCloseAllEditors();
                }
            } catch (e) {
                console.warn('[CodeWithMe] Cleanup on close failed', e);
            }
            // Auto-reload on close to recover from disconnections
            scheduleReload('socket-closed');
        };
        
        ws.onmessage = async (event: any) => {
            try {
                const normalizeParticipantId = (s?: string) => {
                    if (!s) {return s;}
                    return s.replace(/^(guest-|host-)/, '');
                };
                // Normalize to string
                let text: string;
                if (event.data instanceof Blob) {
                    text = await event.data.text();
                } else {
                    text = event.data?.toString?.() ?? '';
                }
                if (!text) {return;}

                let msg: any;
                try {
                    msg = JSON.parse(text);
                } catch {
                    console.log(`[CodeWithMe] ${role}: Received non-JSON message (ignored)`);
                    return;
                }

                // Some servers wrap actual payload under msg.data
                const payload = (msg && typeof msg === 'object' && msg.data && typeof msg.data === 'object' && msg.data.type)
                    ? msg.data
                    : msg;

                // Host: on hello-guest, register participant immediately and push workspace-info
                if (role === 'Host' && payload?.type === 'hello-guest') {
                    console.log('[CodeWithMe] Host: Received hello-guest from', (payload.guestId || payload.participantId), '- sending workspace-info');
                    try {
                        if (currentSession && currentSession.participants) {
                            const pid = (payload.participantId || payload.guestId) as string | undefined;
                            if (!pid) { await sendWorkspaceInfo(); return; }
                            if (pid === currentUserId) { await sendWorkspaceInfo(); return; }
                            // If this participant was previously removed/blocked, immediately kick again and do not add
                            if (removedParticipantIds.has(pid)) {
                                console.log('[CodeWithMe] Host: hello-guest from removed participant, re-kicking:', pid);
                                try { ws?.send(JSON.stringify({ type: 'kick-guest', participantId: pid, guestId: pid, reason: 'removed_by_host', timestamp: Date.now() })); } catch {}
                                await sendWorkspaceInfo();
                                return;
                            }
                            const name = payload.userName || pid;
                            // Idempotent: if already present, update name/lastSeen and skip duplicate insert
                            const existing = currentSession.participants.get(pid);
                            if (existing) {
                                existing.name = name;
                                existing.lastSeen = new Date();
                                currentSession.participants.set(pid, existing);
                                refreshSessionStatusBar();
                                await sendWorkspaceInfo();
                                return;
                            }
                            currentSession.participants.set(pid, {
                                id: pid,
                                name,
                                role: 'guest',
                                permissions: {
                                    canEdit: !!hostSessionPermissions?.allowGuestEdit,
                                    canDebug: !!hostSessionPermissions?.allowGuestDebug,
                                    canAccessTerminal: !!hostSessionPermissions?.allowGuestTerminal,
                                    canCreateFiles: !!hostSessionPermissions?.allowGuestFileCreate,
                                    canDeleteFiles: !!hostSessionPermissions?.allowGuestFileDelete,
                                    canViewFiles: true,
                                },
                                lastSeen: new Date()
                            } as Participant);
                            refreshSessionStatusBar(); // turn green when first guest arrives
                            vscode.window.showInformationMessage(`${name} joined the session`);
                        }
                    } catch (e) {
                        console.warn('[CodeWithMe] Host: Failed to register guest on hello-guest', e);
                    }
                    await sendWorkspaceInfo();
                    return;
                }

                // Guest: if workspace-info arrives, populate the Explorer view immediately
                if (role === 'Guest' && payload?.type === 'workspace-info' && codeWithMeTreeProvider) {
                    const treeMsg = payload;
                    if (Array.isArray(treeMsg?.tree)) {
                        codeWithMeTreeProvider.setTree(treeMsg.tree);
                        // Focus once so the user sees it
                        try { await vscode.commands.executeCommand('code-with-me-explorer.focus'); } catch {}
                        console.log('[CodeWithMe] Guest: Populated Explorer tree from onmessage');
                    }
                }

                // Guest: if host removes this guest, end only this guest's session.
                // The relay logs show kick-guest is sent to exactly 1 recipient; therefore it's safe to stop unconditionally on guest receipt.
                if (role === 'Guest' && ((payload?.type === 'kick-guest') || (msg?.type === 'kick-guest'))) {
                    console.log('[CodeWithMe] Guest: received kick-guest -> stopping guest session');
                    try {
                        vscode.window.showWarningMessage('You were removed from the session by the host.');
                    } finally {
                        try { await vscode.commands.executeCommand('code-with-me.stopSession', true); } catch {}
                    }
                    return;
                }

                // Delegate remaining handling
                await handleCollaborativeMessage(msg, role);
            } catch (error) {
                console.error(`[CodeWithMe] ${role}: Error handling message:`, error);
            }
        };
        
    } catch (error) {
        console.error(`[CodeWithMe] ${role}: Error setting up collaboration:`, error);
        vscode.window.showErrorMessage(`[CodeWithMe] ${role}: Failed to setup collaboration`);
    }
}

// Setup host collaborative session - JetBrains style
async function setupHostCollaborativeSession() {
    console.log('[CodeWithMe] Host: Setting up collaborative session...');
    
    // Initialize collaborative session state
    collaborativeSession = {
        participants: new Map(),
        activeFiles: new Map(),
        cursors: new Map(),
        permissions: new Map()
    };
    
    // Setup file watchers for real-time synchronization
    setupFileWatchers();
    
    // Setup editor change listeners
    setupEditorChangeListeners();
    
    // Send initial workspace state to any connected guests
    broadcastWorkspaceState();
    
    console.log('[CodeWithMe] Host: Collaborative session ready');
}

// Setup guest collaborative session - JetBrains style
async function setupGuestCollaborativeSession() {
    console.log('[CodeWithMe] Guest: Setting up collaborative session...');

    // Do NOT send request-workspace-info here; host will push it upon 'hello-guest'
    // Fallback safety timer: if no workspace-info arrives shortly, request once.
    setTimeout(() => {
        if (ws && ws.readyState === 1 && !(global as any).__cwm_lastWorkspaceInfo) {
            console.log('[CodeWithMe] Guest: No workspace-info after delay, requesting once as fallback');
            try {
                ws.send(JSON.stringify({ type: 'request-workspace-info', timestamp: Date.now() }));
            } catch {}
        }
    }, 1500);

    // Setup editor change listeners for collaborative editing
    setupGuestEditorListeners();
    
    console.log('[CodeWithMe] Guest: Ready for collaborative editing');
}

// Handle collaborative messages - JetBrains style
async function handleCollaborativeMessage(msg: any, role: 'Host' | 'Guest') {
    try {
        console.log(`[CodeWithMe] ${role}: Handling collaborative message:`, msg?.type);
        if (!msg || !msg.type) {
            console.warn('[CodeWithMe] Message without type received:', msg);
            return;
        }

        switch (msg.type) {
            case 'file-change':
                await handleFileChange(msg, role);
                break;

            case 'cursor-position':
                await handleCursorPosition(msg, role);
                break;

            // NEW: when Host sends file-content, Guest opens it only if it explicitly requested
            case 'file-content':
                if (role === 'Guest') {
                    try {
                        const data = msg.data || msg;
                        // Support both shapes: { data: { path, content } } and { filePath, content }
                        const pRaw = (data?.path !== undefined) ? data.path : data?.filePath;
                        const content = data?.content;
                        if (pRaw && typeof content === 'string') {
                            const p = String(pRaw);
                            if (pendingFileContentRequests.has(p)) {
                                // Optional freshness guard (ignore very late arrivals > 5s)
                                const ts = pendingFileContentAt.get(p) || 0;
                                const fresh = Date.now() - ts < 5000;
                                pendingFileContentRequests.delete(p);
                                pendingFileContentAt.delete(p);
                                if (fresh) {
                                    console.log('[CodeWithMe] Guest: Opening file from file-content (requested):', p);
                                    await openFileContentInGuestEditor(p, content);
                                } else {
                                    console.log('[CodeWithMe] Guest: Ignoring stale file-content for', p);
                                }
                            } else {
                                console.log('[CodeWithMe] Guest: Ignoring unsolicited file-content for', p);
                            }
                        } else {
                            console.warn('[CodeWithMe] Guest: file-content missing path/filePath or content');
                        }
                    } catch (e) {
                        console.error('[CodeWithMe] Guest: Failed to open file from file-content:', e);
                    }
                }
                break;

            case 'workspace-info':
                if (role === 'Guest') {
                    const payload = msg?.data ?? msg; // accept either wrapped or direct
                    const items = Array.isArray(payload?.tree) ? payload.tree.length : 'unknown';
                    console.log('[CodeWithMe] Guest: Processing workspace info… items:', items);

                    // Cache robustly
                    (global as any).__cwm_lastWorkspaceInfo = payload;

                    // Immediately populate Explorer view
                    if (codeWithMeTreeProvider && Array.isArray(payload?.tree)) {
                        codeWithMeTreeProvider.setTree(payload.tree);
                        // NEW: Handle permissions from host
                        if (payload.permissions) {
                            guestSessionPermissions = payload.permissions;
                            const mode = guestSessionPermissions?.allowGuestEdit ? 'Read & Write' : 'Read-only';
                            vscode.window.showInformationMessage(`Session mode is: ${mode}.`);
                        }
                        console.log('[CodeWithMe] Guest: Code with me Explorer populated');
                    }

                    await handleWorkspaceInfo({ data: payload });

                    // Auto-request first file (best effort) is optional; do not block the explorer population
                    const findFirstFile = (nodes: any[]): string | undefined => {
                        for (const n of nodes) {
                            if (n.type === 'file' && n.path) {return n.path;}
                            if (n.type === 'folder' && Array.isArray(n.children)) {
                                const f = findFirstFile(n.children);
                                if (f) {return f;}
                            }
                        }
                        return undefined;
                    };
                    const firstFile = Array.isArray(payload?.tree) ? findFirstFile(payload.tree) : undefined;
                    if (firstFile && ws && ws.readyState === 1) {
                        console.log('[CodeWithMe] Guest: (optional) preloading first file:', firstFile);
                        // Commented: leave opening to user click to avoid unexpected focus jumps
                        // ws.send(JSON.stringify({ type: 'request-file-content', filePath: firstFile }));
                    } else {
                        console.log('[CodeWithMe] Guest: No file found in workspace-info to consider preload');
                    }
                }
                break;

            case 'request-workspace-info':
                if (role === 'Host') {
                    console.log('[CodeWithMe] Host: request-workspace-info received - sending workspace-info');
                    await sendWorkspaceInfo();
                }
                break;

            // NEW: Guest asks Host to open a file; Host immediately streams content back
            case 'open-file':
                if (role === 'Host') {
                    try {
                        const filePath = msg.filePath || msg.data;
                        console.log('[CodeWithMe] Host: open-file received for', filePath);
                        if (filePath) {
                            // Do not open the file locally on Host; only stream content back to Guest
                            // Immediately stream content back to Guest
                            await openFileForGuest(filePath);
                        }
                    } catch (e) {
                        console.error('[CodeWithMe] Host: Failed to handle open-file:', e);
                    }
                }
                break;

            // NEW: Guest requests raw file content; Host responds with file-content immediately
            case 'request-file-content':
                if (role === 'Host') {
                    try {
                        const filePath = msg.filePath || msg.data;
                        console.log('[CodeWithMe] Host: request-file-content received for', filePath);
                        if (filePath) {
                            await sendFileContentToGuestByPath(filePath);
                        }
                    } catch (e) {
                        console.error('[CodeWithMe] Host: Failed to handle request-file-content:', e);
                    }
                }
                break;

            case 'participant-joined':
                await handleParticipantJoined(msg);
                break;

            case 'participant-left':
                await handleParticipantLeft(msg);
                break;

            case 'permission-request':
                if (role === 'Host') {
                    await handlePermissionRequest(msg);
                }
                break;

            case MESSAGE_TYPES.SESSION_STOPPED:
                console.log(`[CodeWithMe] ${role}: Received session-stopped notification`);
                cleanupSessionState();
                if (role === 'Guest' && msg?.hostInitiated) {
                    await discardAndCloseAllEditors();
                    vscode.window.showInformationMessage('Host ended the collaboration session.');
                    setTimeout(async () => {
                        try {
                            await reloadWindowRobustly();
                        }
                        catch (e) {
                            console.warn('[CodeWithMe] Guest reload after host stop failed:', e);
                        }
                    }, 500);
                    return;
                }
                break;

            case MESSAGE_TYPES.GUEST_LEFT:
                if (currentSession && currentSession.role === 'host') {
                    const leftUser = msg.userName || 'A guest';
                    // Suppress toast here to avoid duplicate notifications.
                    // handleParticipantLeft will show a single user-friendly message instead.
                    console.log(`[CodeWithMe] Guest left (suppressed toast): ${leftUser}`);
                }
                break;

            default:
                console.log(`[CodeWithMe] ${role}: Unknown message type:`, msg.type);
        }

    } catch (error) {
        console.error(`[CodeWithMe] ${role}: Error handling collaborative message:`, error);
    }
}

// Setup file watchers for real-time synchronization
function setupFileWatchers() {
    if (fileWatchersActive) {
        console.log('[CodeWithMe] File watchers already active; skipping re-register');
        return;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {return;}

    // Watch for file creates only to stream initial content; avoid echoing editor changes
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    // Track watcher for disposal on session end
    sessionDisposables.push(fileWatcher);

    // Disable change rebroadcast to prevent duplication with editor listeners
    // fileWatcher.onDidChange(async (uri) => { /* intentionally disabled */ });

    const createDisposable = fileWatcher.onDidCreate(async (uri) => {
        try {
            if (ws && ws.readyState === 1) {
                const content = await vscode.workspace.fs.readFile(uri);
                ws.send(JSON.stringify({
                    type: 'file-content',
                    filePath: uri.fsPath,
                    content: content.toString(),
                    timestamp: Date.now(),
                    originId: currentUserId
                }));
            }
        } catch (e) {
            console.error('[CodeWithMe] Host: file create stream error', e);
        }
    });
    sessionDisposables.push(createDisposable);
    fileWatchersActive = true;
}

// Setup editor change listeners for collaborative editing
function setupEditorChangeListeners() {
    if (sessionListenersActive) {
        console.log('[CodeWithMe] Editor listeners already active; skipping re-register');
        return;
    }
    // Per-file debounce and seq/version tracking handled at module scope
    // Guest-side debounce map to suppress discard/close-induced full clears
    const pendingFullClears = new Map<string, { changes: any[]; timer: NodeJS.Timeout; doc: vscode.TextDocument }>();

    const onChangeDisp = vscode.workspace.onDidChangeTextDocument(async (event) => {
        console.count('[CodeWithMe] onDidChangeTextDocument fired');
        // Skip if this file is currently being updated from remote
        const eventFilePath = event.document.uri.fsPath;

        // NEW: Robust promise-based guard.
        // If this change is a known remote edit, resolve the confirmation promise and stop.
        // Map guest untitled documents back to their host path for guarding
        let guardKey = eventFilePath;
        if (currentRole === 'guest') {
            try {
                for (const [hostPath, doc] of guestUntitledMap.entries()) {
                    if (doc === event.document) { guardKey = hostPath; break; }
                }
            } catch {}
        }
        if (updatingFromRemoteFiles.has(guardKey)) {
            const promiseControls = editConfirmationPromises.get(guardKey);
            if (promiseControls) {
                console.log(`[CodeWithMe] Confirmed remote edit for ${guardKey}, suppressing echo.`);
                promiseControls.resolve();
                // The promise is now fulfilled, but we leave the cleanup to the handleFileChange function
            } else {
                console.warn(`[CodeWithMe] Guarded event fired for ${guardKey}, but no promise found.`);
            }
            return;
        }

        if (currentRole === 'guest' && guestSessionPermissions && !guestSessionPermissions.allowGuestEdit) {
            if (!(global as any).__cwm_readOnlyWarningShown) {
                vscode.window.showWarningMessage('This is a read-only session. Your changes will not be sent to the host.');
                (global as any).__cwm_readOnlyWarningShown = true;
            }
            return; // Don't process or send changes
        }

        const document = event.document;
        // Prefer the original host path if this is an untitled guest document we mapped
        let filePath = document.uri.fsPath;
        if (currentRole === 'guest') {
            try {
                for (const [hostPath, doc] of guestUntitledMap.entries()) {
                    if (doc === document) { filePath = hostPath; break; }
                }
            } catch {}
        }
        const who = getDisplayUserName(currentRole || undefined as any);

        if (event.contentChanges && event.contentChanges.length > 0) {
            // If a previous full-clear is pending for this file (we were waiting to see if the doc closes),
            // and another edit arrives, treat it as intentional editing: merge the pending clear and continue.
            const pendingFC = pendingFullClears.get(filePath);
            if (pendingFC) {
                try { clearTimeout(pendingFC.timer); } catch {}
                pendingFullClears.delete(filePath);
                if (!pendingChanges.has(filePath)) {pendingChanges.set(filePath, []);}
                pendingChanges.get(filePath)!.push(...pendingFC.changes);
            }
            // Guard: if guest discards an untitled buffer, VS Code may emit a single change
            // that clears the entire document before closing. Suppress broadcasting that.
            console.log('[CodeWithMe] onDidChangeTextDocument: PROCESS local changes', {
                file: filePath,
                changes: event.contentChanges.length
            });
            let map = lineOwnership.get(filePath);
            if (!map) { map = new Map(); lineOwnership.set(filePath, map); }

            // Update local ownership tracking
            for (const ch of event.contentChanges) {
                const insertedLines = ch.text.split('\n').length - 1;
                const startLine = ch.range.start.line;
                const endLine = Math.max(startLine, ch.range.end.line + insertedLines);
                for (let ln = startLine; ln <= endLine; ln++) {
                    map.set(ln, { userName: who });
                }
            }

            // Update UI
            try {
                let editors: vscode.TextEditor[] = [];
                if (currentRole === 'guest') {
                    const mappedDoc = guestUntitledMap.get(filePath);
                    if (mappedDoc) {
                        editors = vscode.window.visibleTextEditors.filter(e => e.document === mappedDoc);
                    }
                } else {
                    editors = vscode.window.visibleTextEditors.filter(e => e.document.fileName === filePath);
                }
                editors.forEach(e => refreshOwnershipDecorations(e));
            } catch {}

            // Batch changes
            if (!pendingChanges.has(filePath)) {
                pendingChanges.set(filePath, []);
            }
            
            const changes = event.contentChanges.map(change => ({
                range: {
                    start: { line: change.range.start.line, character: change.range.start.character },
                    end: { line: change.range.end.line, character: change.range.end.character }
                },
                rangeLength: change.rangeLength,
                rangeOffset: change.rangeOffset,
                text: change.text,
                timestamp: Date.now()
            }));
            
            // Special handling for guest single full-clear: debounce to see if the document is being closed.
            let handledAsPendingFullClear = false;
            if (currentRole === 'guest' && event.contentChanges.length === 1) {
                const ch = event.contentChanges[0];
                const prevLen = (lastProcessedContent.get(filePath) || '').length;
                const isFullClear = ch.rangeOffset === 0 && ch.rangeLength === prevLen && ch.text === '';
                // Only consider when editing a mapped shared doc (so we know it targets a host file)
                let isMapped = false;
                try {
                    for (const [, doc] of guestUntitledMap.entries()) {
                        if (doc === document) { isMapped = true; break; }
                    }
                } catch {}
                if (isMapped && isFullClear) {
                    // Hold this clear briefly; if the doc closes, we drop it. Otherwise, we send it.
                    const timer = setTimeout(() => {
                        // Timer fired: consider this an intentional clear; enqueue and send
                        if (!pendingChanges.has(filePath)) {pendingChanges.set(filePath, []);}
                        pendingChanges.get(filePath)!.push(...changes);
                        pendingFullClears.delete(filePath);
                        try { lastProcessedContent.set(filePath, document.getText()); } catch {}
                        if (batchTimeout) {clearTimeout(batchTimeout);}
                        batchTimeout = setTimeout(() => { sendBatchUpdates(); }, BATCH_DELAY);
                    }, 300);
                    pendingFullClears.set(filePath, { changes, timer, doc: document });
                    handledAsPendingFullClear = true;
                }
            }

            if (!handledAsPendingFullClear) {
                if (!pendingChanges.has(filePath)) {pendingChanges.set(filePath, []);}
                pendingChanges.get(filePath)!.push(...changes);
            }
            // Update last known content after applying local change
            try { lastProcessedContent.set(filePath, document.getText()); } catch {}
            
            // Clear any existing timeout and set a new one
            if (batchTimeout) {
                clearTimeout(batchTimeout);
            }
            
            // If we handled as pending full clear, sending is scheduled by its timer; otherwise use normal batch timer
            if (!handledAsPendingFullClear) {
                batchTimeout = setTimeout(() => {
                    sendBatchUpdates();
                }, BATCH_DELAY);
            }
        }
    });

    // If a guest closes a document while a full-clear is pending, cancel the clear (treat as discard/close)
    const onDidCloseDisp = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
        if (currentRole !== 'guest') {return;}
        try {
            for (const [fp, pending] of pendingFullClears.entries()) {
                if (pending.doc === closedDoc) {
                    try { clearTimeout(pending.timer); } catch {}
                    pendingFullClears.delete(fp);
                    console.log('[CodeWithMe] Guest: Cancelled pending full clear due to document close', fp);
                }
            }
            // Also clear cursor debounce state for this file if applicable
            const fp = closedDoc.uri.fsPath;
            try { const t = cursorSendTimers.get(fp); if (t) { clearTimeout(t); } } catch {}
            cursorSendTimers.delete(fp);
            lastSentCursorPos.delete(fp);
        } catch {}
    });

    // Prevent guest from saving any file during a session
    const onWillSaveDisp = vscode.workspace.onWillSaveTextDocument(async (event) => {
        if (currentRole === 'guest') {
            try {
                vscode.window.showErrorMessage('Guests cannot save files during a collaboration session. Changes are not saved.');
                // Ensure we revert the same document that is being saved
                await vscode.window.showTextDocument(event.document, { preserveFocus: true, preview: false });
                // Revert discards pending changes so the save becomes a no-op
                await vscode.commands.executeCommand('workbench.action.files.revert');
            } catch {}
            // Do not provide edits; allow the (now clean) save to proceed as a no-op
            event.waitUntil(Promise.resolve([]));
        }
    });
    sessionDisposables.push(onWillSaveDisp);

    // Track cursor position changes
    const onSelDisp = vscode.window.onDidChangeTextEditorSelection(async (event) => {
        console.count('[CodeWithMe] onDidChangeTextEditorSelection fired');
        if (!(ws && ws.readyState === 1)) { return; }

        // Map guest untitled doc back to host path
        let selFilePath = event.textEditor.document.uri.fsPath;
        if (currentRole === 'guest') {
            try {
                for (const [hostPath, doc] of guestUntitledMap.entries()) {
                    if (doc === event.textEditor.document) { selFilePath = hostPath; break; }
                }
            } catch {}
        }

        // Suppress local cursor broadcasts when this file is being updated from remote
        if (updatingFromRemoteFiles.has(selFilePath)) {
            return;
        }

        const activeSel = event.selections[0]?.active;
        if (!activeSel) { return; }

        // Only send if changed since last send for this file
        const last = lastSentCursorPos.get(selFilePath);
        if (last && last.line === activeSel.line && last.character === activeSel.character) {
            return;
        }

        // Debounce per file path
        const existing = cursorSendTimers.get(selFilePath);
        if (existing) { try { clearTimeout(existing); } catch {} }
        const timer = setTimeout(() => {
            try {
                lastSentCursorPos.set(selFilePath, { line: activeSel.line, character: activeSel.character });
                ws!.send(JSON.stringify({
                    type: 'cursor-position',
                    filePath: selFilePath,
                    position: { line: activeSel.line, character: activeSel.character },
                    timestamp: Date.now(),
                    participantId: currentUserId,
                    user: cwmCurrentIdentity ? {
                        userId: cwmCurrentIdentity.userId,
                        userName: cwmCurrentIdentity.userName
                    } : {
                        userId: currentUserId,
                        userName: 'Unknown'
                    }
                }));
            } catch (e) {
                console.warn('[CodeWithMe] Failed to send debounced cursor-position', e);
            }
        }, CURSOR_SEND_MS);
        cursorSendTimers.set(selFilePath, timer);
    });
    sessionDisposables.push(onSelDisp);
    sessionListenersActive = true;
}

// Function to send batched updates
function sendBatchUpdates() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {return;}
    
    pendingChanges.forEach((changes, filePath) => {
        if (changes.length === 0) {return;}
        
        // Preserve original capture order; do not resort by timestamp
        
        // Per-file, per-sender monotonic sequence
        const nextSeq = (fileSeqCounter.get(filePath) || 0) + 1;
        fileSeqCounter.set(filePath, nextSeq);
        const messageId = crypto.randomUUID();

        ws!.send(JSON.stringify({
            type: 'file-change',
            filePath: filePath,
            originId: currentUserId,
            messageId,
            changes: changes.map(c => ({
                range: c.range,
                rangeLength: c.rangeLength,
                rangeOffset: c.rangeOffset,
                text: c.text
            })),
            timestamp: Date.now(),
            sequence: nextSeq,
            user: cwmCurrentIdentity ? { 
                userId: cwmCurrentIdentity.userId, 
                userName: cwmCurrentIdentity.userName 
            } : { 
                userId: currentUserId, 
                userName: 'Unknown' 
            }
        }));
    });
    
    // Clear the batch
    pendingChanges.clear();
}

// Setup guest editor listeners
function setupGuestEditorListeners() {
    setupEditorChangeListeners(); // Same as host for now
}

// Handle file changes from collaborators
async function handleFileChange(msg: any, role: 'Host' | 'Guest') {
    let filePath: string | undefined;
    try {
        console.count('[CodeWithMe] handleFileChange fired');
        filePath = msg.filePath || msg.path;
        if (!filePath) {return;}

        // Drop our own echoes
        if (msg.originId && msg.originId === currentUserId) {
            return;
        }

        // Global messageId de-duplication
        if (msg.messageId) {
            if (recentMessageIds.includes(msg.messageId)) {
                console.log('[CodeWithMe] Duplicate messageId, ignoring', msg.messageId);
                return;
            }
            recentMessageIds.push(msg.messageId);
            if (recentMessageIds.length > 500) {
                recentMessageIds.splice(0, recentMessageIds.length - 500);
            }
        }

        // Check sequence number for ordering
        const senderId = msg.originId || 'unknown';
        let perSender = lastProcessedSeqByFileAndSender.get(filePath);
        if (!perSender) {
            perSender = new Map<string, number>();
            lastProcessedSeqByFileAndSender.set(filePath, perSender);
        }
        const lastSeq = perSender.get(senderId) || 0;
        if (typeof msg.sequence === 'number' && msg.sequence <= lastSeq) {
            console.log('[CodeWithMe] Out-of-order/duplicate sequence, ignoring', { filePath, senderId, seq: msg.sequence, lastSeq });
            return;
        }
        if (typeof msg.sequence === 'number') {
            perSender.set(senderId, msg.sequence);
        }

        await enqueueFileChange(filePath, async () => {
        updatingFromRemoteFiles.add(filePath!);

        // Create a confirmation promise that the onDidChangeTextDocument handler will resolve.
        const confirmationPromise = new Promise<void>((resolve, reject) => {
            editConfirmationPromises.set(filePath!, { resolve, reject });
        });

        try {
        // Resolve target document for applying remote edits
        let doc: vscode.TextDocument;
        if (role === 'Guest') {
            const mapped = guestUntitledMap.get(filePath!);
            if (mapped && !mapped.isClosed) {
                doc = mapped;
            } else {
                // If the document is not in our map or is closed, do nothing.
                // The changes will be synced when the guest manually re-opens the file.
                console.log(`[CodeWithMe] Guest: Ignoring change for untracked/closed doc ${filePath}.`);
                return;
            }
        } else {
            try {
                doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath!));
            } catch {
                console.warn(`[CodeWithMe] Host: Could not open ${filePath} for applying changes.`);
                return;
            }
        }
        
        // The new logic MUST use deltas (changes).
        if (!msg.changes || !Array.isArray(msg.changes)) {
            console.warn('[CodeWithMe] Received file-change message without changes array. Ignoring.');
            return;
        }

        // Host-side guard: suppress a single "full clear to empty" delta that matches
        // a typical close/revert-induced clear from a guest untitled buffer.
        // This avoids accidental emptying of the host file when the guest closes without saving.
        // IMPORTANT: If the host currently allows guest editing, honor the edit (do not suppress)
        // so that intentional select-all + backspace by a guest will apply to the host.
        if (role === 'Host' && msg.changes.length === 1 && !(hostSessionPermissions?.allowGuestEdit)) {
            try {
                const ch = msg.changes[0];
                if (ch && ch.text === '' && ch.range && ch.range.start && ch.range.end) {
                    const startZero = ch.range.start.line === 0 && ch.range.start.character === 0;
                    const lastLine = Math.max(0, doc.lineCount - 1);
                    const endPos = doc.lineAt(lastLine).range.end;
                    const endMatches = ch.range.end.line === endPos.line && ch.range.end.character === endPos.character;
                    const len = doc.getText().length;
                    const rangeLenOk = typeof ch.rangeLength === 'number' ? (ch.rangeLength === len) : true;
                    if (startZero && endMatches && rangeLenOk) {
                        console.warn('[CodeWithMe] Host: Suppressing potential close-induced full clear for', filePath);
                        return;
                    }
                }
            } catch {}
        }

        // We'll apply edits in the original sender-provided order to preserve intent.
        const changesToApply: { range: vscode.Range; text: string; rangeOffset?: number; _idx: number }[] = [];

        // First, validate all changes
        for (const change of msg.changes) {
            // Add a guard to ensure the change object has the expected structure
            if (!change.range || !change.range.start || !change.range.end) {
                console.warn('[CodeWithMe] Received a file-change object without a valid range. Skipping.', change);
                continue;
            }

            try {
                const range = new vscode.Range(
                    new vscode.Position(change.range.start.line, change.range.start.character),
                    new vscode.Position(change.range.end.line, change.range.end.character)
                );
                
                // Store the change for later application
                changesToApply.push({
                    range,
                    text: change.text,
                    rangeOffset: typeof change.rangeOffset === 'number' ? change.rangeOffset : undefined,
                    _idx: changesToApply.length // preserve original capture order as stable tiebreaker
                });
            } catch (e) {
                console.error('[CodeWithMe] Error processing change:', e);
                continue;
            }
        }

        // Do not sort; preserve the order captured by the sender

        // Preserve and restore local selection so caret does not shift when others edit above
        const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
        const selectionBefore = editor?.selection;

        // Apply all sorted changes in a single atomic transaction
        const combinedEdit = new vscode.WorkspaceEdit();
        for (const { range, text } of changesToApply) {
            combinedEdit.replace(doc.uri, range, text);
        }
        const success = await vscode.workspace.applyEdit(combinedEdit);

        // Restore selection to keep local caret independent of remote inserts above
        if (editor && selectionBefore) {
            try {
                editor.selection = selectionBefore;
            } catch (e) {
                console.warn('[CodeWithMe] Could not restore selection after remote edit.', e);
            }
        }

        if (success) {
            // Wait for the onDidChangeTextDocument handler to confirm it saw the event.
            // This is far more reliable than a fixed setTimeout.
            const timeoutPromise = new Promise<void>((_, reject) => 
                setTimeout(() => reject(new Error('Timeout waiting for edit confirmation event')), 1000)
            );

            try {
                await Promise.race([confirmationPromise, timeoutPromise]);
            } catch (e) {
                console.warn(`[CodeWithMe] Did not receive edit confirmation for ${filePath}. The sync guard might be stale. Error:`, e);
                // The promise might have been rejected by the timeout. Clean up the resolver.
                const promiseControls = editConfirmationPromises.get(filePath!);
                promiseControls?.reject(e);
            }


            // If we are the Host and this change originated from a Guest, forward it to other Guests
            if (role === 'Host' && ws && ws.readyState === WebSocket.OPEN) {
                const fromGuest = msg.originId && msg.originId !== currentUserId;
                if (fromGuest) {
                    try {
                        const forwardPayload = {
                            type: 'file-change',
                            filePath: filePath,
                            originId: msg.originId, // preserve original sender
                            messageId: msg.messageId, // preserve for global de-dupe
                            sequence: msg.sequence, // preserve per-file ordering from original sender
                            changes: msg.changes,
                            timestamp: msg.timestamp || Date.now(),
                            user: msg.user, // preserve user info
                            forwardedByHost: true
                        };
                        ws.send(JSON.stringify(forwardPayload));
                        console.log('[CodeWithMe] Host: Forwarded guest change to other guests', {
                            filePath,
                            originId: msg.originId,
                            sequence: msg.sequence,
                            messageId: msg.messageId
                        });
                    } catch (e) {
                        console.warn('[CodeWithMe] Host: Failed to forward guest change', e);
                    }
                }
            }
            // Update persistent ownership map for the affected lines
            const userName = (msg.user?.userName) || getDisplayUserName(role === 'Host' ? 'host' : 'guest');
            let map = lineOwnership.get(filePath!);
            if (!map) { 
                map = new Map(); 
                lineOwnership.set(filePath!, map); 
            }

            for (const change of msg.changes) {
                if (!change.range || !change.range.start || !change.range.end) {
                    continue;
                }

                const insertedLines = change.text.split('\n').length - 1;
                const startLine = change.range.start.line;
                const endLine = Math.max(startLine, change.range.end.line + insertedLines);
                for (let ln = startLine; ln <= endLine; ln++) {
                    map.set(ln, { userName });
                }
            }

            // Apply persistent decorations for this document
            const editors = role === 'Guest'
                ? vscode.window.visibleTextEditors.filter(e => e.document === doc)
                : vscode.window.visibleTextEditors.filter(e => e.document.fileName === filePath);
            for (const ed of editors) {
                refreshOwnershipDecorations(ed);
            }

            updateSyncStatus(`${userName} edit applied`, '$(sync)');
        } else {
            // If applyEdit failed, we must clean up the promise to prevent a memory leak.
            const promiseControls = editConfirmationPromises.get(filePath!);
            promiseControls?.reject(new Error('applyEdit failed'));
            console.error(`[CodeWithMe] ${role}: Failed to apply edit for ${filePath}`);
            // Consider requesting a full resync for this file
        }
        } finally {
            // Always clear guards for this file
            updatingFromRemoteFiles.delete(filePath!);
            editConfirmationPromises.delete(filePath!);
        }
    }); // end enqueueFileChange task
    } catch (error) {
        console.error(`[CodeWithMe] ${role}: Error handling file change:`, error);
    } finally {
        // Note: cleanup occurs inside the queued task's finally/flow to keep the guard scoped correctly
    }
}

// Handle cursor position updates (remote presence as decorations only)
async function handleCursorPosition(msg: any, role: 'Host' | 'Guest') {
    const participantId = msg.participantId || msg.user?.userId;
    if (!participantId) { return; }
    // Never render our own remote cursor
    if (participantId === currentUserId) { return; }
    if (!msg || !msg.filePath || !msg.position) { return; }

    // Store latest presence
    participantCursors.set(participantId, {
        filePath: msg.filePath,
        position: msg.position,
        timestamp: msg.timestamp,
        user: msg.user
    });

    const scheduleDecorate = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const decorationType = getParticipantCursorDecoration(participantId, msg.user?.userName || 'Guest');
        let currentEditorHostPath = editor.document.uri.fsPath;
        if (currentRole === 'guest') {
            try {
                for (const [hostPath, doc] of guestUntitledMap.entries()) {
                    if (doc === editor.document) { currentEditorHostPath = hostPath; break; }
                }
            } catch {}
        }
        if (msg.filePath === currentEditorHostPath) {
            const range = new vscode.Range(msg.position, msg.position);
            editor.setDecorations(decorationType, [range]);
        } else {
            editor.setDecorations(decorationType, []);
        }
    };

    // Debounce per participant to reduce flicker with many updates
    const existing = cursorDecorateTimers.get(participantId);
    if (existing) { try { clearTimeout(existing); } catch {} }
    const t = setTimeout(scheduleDecorate, CURSOR_DECORATE_MS);
    cursorDecorateTimers.set(participantId, t);
}

// Handle workspace info for guests
async function handleWorkspaceInfo(msg: any) {
    try {
        console.log('[CodeWithMe] Guest: Received workspace info from host');
        const info = msg?.data;
        if (!info || !Array.isArray(info.tree)) {
            console.error('[CodeWithMe] Guest: Invalid workspace info payload:', info);
            vscode.window.showErrorMessage('Code with me: Invalid workspace info received');
            return;
        }

        // Count files
        let fileCount = 0;
        const countFiles = (nodes: any[]) => {
            for (const node of nodes) {
                if (node.type === 'file') {fileCount++;}
                else if (node.type === 'folder' && Array.isArray(node.children)) {countFiles(node.children);}
            }
        };
        countFiles(info.tree);
        console.log(`[CodeWithMe] Guest: Workspace "${info.name}" at ${info.path} with ${fileCount} files`);

        // Sync session start for shared timer
        try { if (typeof info.sessionStartMs === 'number') { sessionStartMs = info.sessionStartMs; } } catch {}
        // Ensure guest status bar updates immediately and timer starts ticking
        try { refreshSessionStatusBar(); } catch {}
        // Cache workspace for quick-pick
        (global as any).__cwm_lastWorkspaceInfo = info;

        // Update the Explorer tree immediately without user request
        if (codeWithMeTreeProvider) {
            codeWithMeTreeProvider.setTree(info.tree);
        }

        // Feedback to user (non-blocking)
        vscode.window.setStatusBarMessage(`Code with me: Host workspace "${info.name}" - ${fileCount} files`, 3000);
    } catch (e) {
        console.error('[CodeWithMe] Guest: Error in handleWorkspaceInfo:', e);
    }
}

// Send workspace info to guests
async function sendWorkspaceInfo() {
    if (ws && ws.readyState === 1) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0];        
        if (workspaceRoot) {
            console.log('[CodeWithMe] Host: Getting workspace tree for guest...');
            const tree = await getWorkspaceFiles(workspaceRoot.uri.fsPath);
            
            // Initialize session start on first send
            if (sessionStartMs == null) { sessionStartMs = Date.now(); }
            const workspaceInfo = {
                name: workspaceRoot.name,
                path: workspaceRoot.uri.fsPath,
                tree: tree,
                permissions: hostSessionPermissions,
                sessionStartMs
            };
            
            const message = JSON.stringify({
                type: 'workspace-info',
                data: workspaceInfo
            });
            console.log('[CodeWithMe] Host: Sending workspace info message, length:', message.length);
            
            ws.send(message);
            console.log('[CodeWithMe] Host: Sent workspace info to guest successfully');
        } else {
            console.log('[CodeWithMe] Host: No workspace folder found');
        }
    } else {
        console.log('[CodeWithMe] Host: WS not ready to send workspace info, will retry shortly…');
        setTimeout(() => { try { sendWorkspaceInfo(); } catch (e) { console.log('[CodeWithMe] Host: resend workspace info failed', e); } }, 300);
    }
}

// Broadcast workspace state to all participants
function broadcastWorkspaceState() {
    if (ws && ws.readyState === 1) {
        sendWorkspaceInfo();
    }
}

// Handle participant events
async function handleParticipantJoined(msg: any) {
    const pid = (msg.participantId || msg.guestId) as string | undefined;
    const userName = msg.userName || pid;
    console.log(`[CodeWithMe] Participant joined: ${userName} (${pid})`);
    let isNew = false;
    // Update participants map if present, idempotently
    try {
        if (currentSession && currentSession.participants && pid) {
            const existing = currentSession.participants.get(pid);
            if (existing) {
                existing.name = userName;
                existing.lastSeen = new Date();
                currentSession.participants.set(pid, existing);
            } else {
                currentSession.participants.set(pid, {
                    id: pid,
                    name: userName,
                    role: 'guest',
                    permissions: {
                        canEdit: true,
                        canDebug: false,
                        canAccessTerminal: false,
                        canCreateFiles: true,
                        canDeleteFiles: false,
                        canViewFiles: true,
                    },
                    lastSeen: new Date()
                } as Participant);
                isNew = true;
            }
        }
    } catch {}
    refreshSessionStatusBar();
    if (isNew && userName) {
        vscode.window.showInformationMessage(`${userName} joined the session`);
    }
}

async function handleParticipantLeft(msg: any) {
    const participantId: string | undefined = msg?.participantId;
    let displayName: string = 'Guest';
    // Prefer an explicit name on the message, then fall back to the participants map
    if (msg?.userName && typeof msg.userName === 'string' && msg.userName.trim().length > 0) {
        displayName = msg.userName;
    }
    if (participantId && currentSession?.participants) {
        const participant = currentSession.participants.get(participantId);
        if (participant?.name && participant.name.trim().length > 0) {
            displayName = participant.name;
        }
    }
    console.log('[CodeWithMe] Participant left:', participantId);
    // Remove from participants map
    try {
        if (currentSession && currentSession.participants && msg.participantId) {
            currentSession.participants.delete(msg.participantId);
        }
    } catch {}
    refreshSessionStatusBar();
    vscode.window.showInformationMessage(`${displayName} left the session`);
    participantCursors.delete(msg.participantId);
    // NEW: Clean up decorations for the participant who left
    if (participantCursorDecorations.has(msg.participantId)) {
        participantCursorDecorations.get(msg.participantId)?.dispose();
        participantCursorDecorations.delete(msg.participantId);
    }
    updateParticipantCursors(); // Re-render to remove the cursor
}

// Handle permission requests
async function handlePermissionRequest(msg: any) {
    const action = await vscode.window.showInformationMessage(
        `${msg.participantId} is requesting ${msg.permission} permission`,
        'Allow',
        'Deny'
    );
    
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: 'permission-response',
            participantId: msg.participantId,
            permission: msg.permission,
            granted: action === 'Allow',
            timestamp: Date.now()
        }));
    }
}

async function setupCollaboration(url: string, role: 'Host' | 'Guest') {
    try {
        console.log(`[CodeWithMe] ${role}: Setting up collaboration with URL:`, url);
        
        // Use JetBrains-style collaboration (no screen capture)
        await setupCollaborationSession(url, role);
        
    } catch (error) {
        console.error(`[CodeWithMe] ${role}: Error setting up collaboration:`, error);
        vscode.window.showErrorMessage(`[CodeWithMe] ${role}: Failed to setup collaboration`);
    }
}

async function joinSession() {
   vscode.window.showInformationMessage('[CodeWithMe] joinSession called');

   const input = await vscode.window.showInputBox({
       prompt: 'Enter the session code or the full URL from the host',
       placeHolder: 'e.g., ABC-DEF or ws://...'
   });
   if (!input) { return; }
   
   let sessionUrl: string;
   const trimmedInput = input.trim();

   // Check if the user entered a full URL or just the code
   if (trimmedInput.startsWith('ws://') || trimmedInput.startsWith('wss://')) {
       sessionUrl = trimmedInput;
   } else {
       // Assume it's a session code and construct the URL
       sessionUrl = `${DEFAULT_PUBLIC_WS_URL}/${trimmedInput}`;
   }
   
   lastSessionUrl = sessionUrl;
   console.log('[CodeWithMe] Guest: Joining session with URL:', sessionUrl);
   
   // Focus the view immediately so the user sees population
   setTimeout(() => vscode.commands.executeCommand('code-with-me-explorer.focus'), 100);
   
   // Show connecting message
   vscode.window.showInformationMessage('Connecting to host server...');
   
   // Use JetBrains-style collaboration (direct file sharing)
   await setupCollaborationSession(sessionUrl, 'Guest');
}

async function shareSessionLink() {
    if (!lastSessionUrl) {
        vscode.window.showErrorMessage('[CodeWithMe] No active session to share');
        return;
    }

    try {
        // Extract session code from the URL
        const sessionCode = lastSessionUrl.substring(lastSessionUrl.lastIndexOf('/') + 1);

        // Copy CODE to clipboard by default (JetBrains-style)
        await vscode.env.clipboard.writeText(sessionCode);

        const invitationMessage = `Session started.\n\nSession Code: ${sessionCode}\n\nShare this code or the full URL with your guest.\n\nSession code has been copied to the clipboard.`;

        vscode.window.showInformationMessage('Session code copied to clipboard.');

        const action = await vscode.window.showInformationMessage(
            invitationMessage,
            { title: 'Copy Code Again', isCloseAffordance: false }
        );
        
        if (action?.title === 'Copy Code Again') {
            await vscode.env.clipboard.writeText(sessionCode);
            vscode.window.showInformationMessage('Session code copied to clipboard again.');
        }
        
    } catch (error) {
        console.error('[CodeWithMe] Error copying to clipboard:', error);
        vscode.window.showErrorMessage('[CodeWithMe] Failed to copy to clipboard');
    }
}

// Function to send workspace info to guest
async function sendWorkspaceInfoToGuest() {
    try {
        console.log('[CodeWithMe] Host: Attempting to send workspace info...');
        console.log('[CodeWithMe] Host: WebSocket exists:', !!ws);
        console.log('[CodeWithMe] Host: WebSocket readyState:', ws?.readyState);

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0];        
        if (workspaceRoot && ws && ws.readyState === 1) { // WebSocket.OPEN
            console.log('[CodeWithMe] Host: Getting workspace tree for guest...');
            const tree = await getWorkspaceFiles(workspaceRoot.uri.fsPath);
            
            const workspaceInfo = {
                name: workspaceRoot.name,
                path: workspaceRoot.uri.fsPath,
                tree: tree,
                permissions: hostSessionPermissions
            };
            
            const message = JSON.stringify({
                type: 'workspace-info',
                data: workspaceInfo
            });
            console.log('[CodeWithMe] Host: Sending workspace info message, length:', message.length);
            
            ws.send(message);
            console.log('[CodeWithMe] Host: Sent workspace info to guest successfully');
        } else {
            console.log('[CodeWithMe] Host: Cannot send workspace info - workspace:', !!workspaceRoot, 'ws:', !!ws, 'readyState:', ws?.readyState); // WebSocket.OPEN
        }
    } catch (error) {
        console.error('[CodeWithMe] Host: Error sending workspace info:', error);
    }
}

// Function to get workspace files
async function getWorkspaceFiles(rootPath: string): Promise<any[]> {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const result = [];
    
    // Sort entries: folders first, then files, both alphabetically
    const sortedEntries = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) {return -1;}
        if (!a.isDirectory() && b.isDirectory()) {return 1;}
        return a.name.localeCompare(b.name);
    });
    
    for (const entry of sortedEntries) {
        // Skip hidden files and common build directories
        if (entry.name.startsWith('.') || 
            entry.name === 'node_modules' || 
            entry.name === '__pycache__' ||
            entry.name === '.git' ||
            entry.name === 'dist' ||
            entry.name === 'build' ||
            entry.name === '.vscode') {continue;}
            
        const fullPath = path.join(rootPath, entry.name);
        
        try {
        if (entry.isDirectory()) {
                const children = await getWorkspaceFiles(fullPath);
                // Only include folders that have children or are not empty
                if (children.length > 0) {
            result.push({
                type: 'folder',
                name: entry.name,
                        children: children
            });
                }
        } else {
                // Include all files except very large ones
                const stats = await fs.stat(fullPath);
                if (stats.size < 1024 * 1024) { // Skip files larger than 1MB
            result.push({
                type: 'file',
                name: entry.name,
                path: fullPath
            });
                }
            }
        } catch (error) {
            console.log(`[CodeWithMe] Skipping ${fullPath}: ${error}`);
        }
    }
    return result;
}

// Function to send file content to guest
async function sendFileContentToGuest(document: vscode.TextDocument) {
    try {
        if (ws && ws.readyState === 1) {
            const content = document.getText();
            const fileInfo = {
                path: document.fileName,
                content: content,
                language: document.languageId,
                lineCount: document.lineCount
            };
            
            ws.send(JSON.stringify({
                type: 'file-content',
                data: fileInfo
            }));
            
            console.log('[CodeWithMe] Host: Sent file content to guest:', document.fileName);
        }
            } catch (error) {
        console.error('[CodeWithMe] Host: Error sending file content:', error);
    }
}

// Function to send file content to guest by file path
async function sendFileContentToGuestByPath(filePath: string) {
    try {
        if (ws && ws.readyState === 1) {
            // Read file content directly from file system
            const content = await fs.readFile(filePath, 'utf8');
            const fileInfo = {
                path: filePath,
                content: content,
                language: getLanguageFromPath(filePath),
                lineCount: content.split('\n').length
            };
            
            ws.send(JSON.stringify({
                type: 'file-content',
                data: fileInfo
            }));
            
            console.log('[CodeWithMe] Host: Sent file content to guest by path:', filePath);
        }
    } catch (error) {
        console.error('[CodeWithMe] Host: Error sending file content by path:', error);
        vscode.window.showErrorMessage(`[CodeWithMe] Failed to read file: ${path.basename(filePath)}`);
    }
}

// Function to open file in guest's VS Code editor
async function openFileInGuestEditor(filePath: string) {
    try {
        // Request file content from host and open directly in VS Code
        if (ws && ws.readyState === 1) {
            // Mark this path as a guest-initiated request so the incoming file-content is allowed to open
            pendingFileContentRequests.add(filePath);
            ws.send(JSON.stringify({
                type: 'request-file-content',
                filePath: filePath
            }));
            // Don't show the "requesting" message - just open the file
            console.log(`[CodeWithMe] Guest: Requesting file content for: ${filePath}`);
        } else {
            vscode.window.showErrorMessage('[CodeWithMe] Not connected to host');
        }
    } catch (error) {
        console.error('[CodeWithMe] Guest: Error opening file in editor:', error);
        vscode.window.showErrorMessage(`[CodeWithMe] Failed to open file: ${path.basename(filePath)}`);
    }
}

// Function to open file content in guest's VS Code editor
async function openFileContentInGuestEditor(filePath: string, content: string) {
    try {
        console.log('[CodeWithMe] Guest: Opening file content in editor:', filePath);
        // If this file already has a mapped untitled document, reuse it and replace content fully
        let existing = guestUntitledMap.get(filePath);
        // Guard against stale/closed documents left in the map after the tab was closed
        if (existing && !vscode.workspace.textDocuments.includes(existing)) {
            try { guestUntitledMap.delete(filePath); } catch {}
            existing = undefined as any;
        }
        if (existing) {
            const editor = await vscode.window.showTextDocument(existing, { preview: false });
            const currentText = existing.getText();
            if (currentText !== content) {
                updatingFromRemoteFiles.add(filePath);
                try {
                    const lastLine = Math.max(0, existing.lineCount - 1);
                    const endPos = existing.lineAt(lastLine).range.end;
                    const ok = await editor.edit((eb) => {
                        eb.replace(new vscode.Range(new vscode.Position(0, 0), endPos), content);
                    }, { undoStopBefore: false, undoStopAfter: false });
                    if (!ok) {
                        console.warn('[CodeWithMe] Guest: Failed to replace content for already-open doc', filePath);
                    }
                } finally {
                    updatingFromRemoteFiles.delete(filePath);
                }
                try { lastProcessedContent.set(filePath, content); } catch {}
                try { refreshOwnershipDecorations(editor); } catch {}
            }
            return;
        }

        // Otherwise, open as a NAMED untitled document so the tab shows the real filename
        const title = path.basename(filePath);
        const uri = vscode.Uri.parse(`untitled:${title}`);
        const document = await vscode.workspace.openTextDocument(uri);
        // Set language mode based on the original path
        try { await vscode.languages.setTextDocumentLanguage(document, getLanguageFromPath(filePath)); } catch {}

        const editor = await vscode.window.showTextDocument(document, { preview: false });

        // Replace content programmatically, guarded to avoid echoing as a local change
        updatingFromRemoteFiles.add(filePath);
        try {
            const lastLine = Math.max(0, document.lineCount - 1);
            const endPos = document.lineAt(lastLine).range.end;
            const ok = await editor.edit((eb) => {
                eb.replace(new vscode.Range(new vscode.Position(0, 0), endPos), content);
            }, { undoStopBefore: false, undoStopAfter: false });
            if (!ok) {
                console.warn('[CodeWithMe] Guest: Failed to set initial content for', filePath);
            }
        } finally {
            updatingFromRemoteFiles.delete(filePath);
        }

        // Track mapping from host path to this untitled document
        guestUntitledMap.set(filePath, document);
        // Initialize last known content for suppression heuristics
        try { lastProcessedContent.set(filePath, content); } catch {}
        // Ensure decorations/UI render immediately for guest
        try { refreshOwnershipDecorations(editor); } catch {}
        console.log('[CodeWithMe] Guest: File opened as named untitled document with mapping (no local file created)');
    } catch (error) {
        console.error('[CodeWithMe] Guest: Error opening file content in editor:', error);
        vscode.window.showErrorMessage(`[CodeWithMe] Failed to open file: ${path.basename(filePath)}`);
    }
}

class SessionManager {
    public ws: WebSocket | null = null;
    public role: 'host' | 'guest' | null = null;
    public permissions: SessionPermissions | null = null;
    private isUpdatingFromRemote = false;

    constructor(role: 'host' | 'guest') {
        this.role = role;
    }

    public connect(url: string) {
        // WebSocket connection logic here
    }

    public setPermissions(perms: SessionPermissions) {
        this.permissions = perms;
    }

    public canGuestEdit(): boolean {
        if (this.role === 'guest' && this.permissions) {
            return this.permissions.allowGuestEdit;
        }
        return true; // Hosts can always edit
    }
    
    // ... other session management methods
}
// Function to insert text at cursor position
async function insertTextAtCursor(text: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, text);
        });
        vscode.window.showInformationMessage(`Guest inserted text: "${text}"`);
    }
}

/** Detect if a line is our username marker. Optionally match a specific user. */
function isUsernameMarker(line: string, who?: string): boolean {
    try {
        const t = (line || '').trim();
        if (!t) {return false;}
        if (!t.includes('[cwm-user]')) {return false;}
        if (who && !t.includes(who)) {return false;}
        // Recognized single-line comment prefixes and HTML-style marker
        return t.startsWith('#') || t.startsWith('//') || t.startsWith(';') || t.startsWith('<!--');
    } catch {
        return false;
    }
}

/* duplicate removed */

// Naive diff to detect changed span for attribution
function computeChangedRange(oldText: string, newText: string, doc: vscode.TextDocument): vscode.Range | null {
    if (oldText === newText) {return null;}
    let start = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (start < minLen && oldText[start] === newText[start]) {start++;}
    let endOld = oldText.length - 1;
    let endNew = newText.length - 1;
    while (endOld >= start && endNew >= start && oldText[endOld] === newText[endNew]) { endOld--; endNew--; }
    const startPos = doc.positionAt(start);
    const endPos = doc.positionAt(newText.length - (newText.length - 1 - endNew));
    return new vscode.Range(startPos, endPos);
}

/**
 * Build a persistent username attribution line with language-aware comment prefix.
 * Example: "# [cwm-user] username" for .py, "// [cwm-user] username" for .ts/.js, "; [cwm-user] username" for .ini, etc.
 */
function buildUsernameLine(languageId: string, userName: string): string {
    const map: Record<string, string> = {
        'typescript': '//',
        'javascript': '//',
        'json': '//',
        'jsonc': '//',
        'cpp': '//',
        'c': '//',
        'java': '//',
        'csharp': '//',
        'go': '//',
        'rust': '//',
        'python': '#',
        'shellscript': '#',
        'ruby': '#',
        'perl': '#',
        'makefile': '#',
        'yaml': '#',
        'ini': ';',
        'toml': '#',
        'properties': '#',
        'markdown': '<!--',
    };
    // Normalize: some languages report plaintext for unknown; prefer '#' in that case
    if (!(languageId in map)) {
        (map as any).plaintext = '#';
    }

    const prefix = map[languageId] ?? '#';
    return prefix === '<!--' ? `<!-- [cwm-user] ${userName} -->` : `${prefix} [cwm-user] ${userName}`;
}

// Ensure GitHub session using VS Code Authentication API
async function ensureGitHubSession(required: boolean = true): Promise<GitHubIdentity | null> {
    try {
        const scopes = ['read:user', 'user:email'];
        const session = await vscode.authentication.getSession('github', scopes, { createIfNone: required, silent: !required });
        if (!session) { return null; }
        const userName = session.account?.label || 'GitHub User';
        const userId = session.id || currentUserId;
        cwmCurrentIdentity = { userId, userName, token: (session as any).accessToken };
        return cwmCurrentIdentity;
    } catch (e) {
        console.error('[CodeWithMe] GitHub auth error:', e);
        return null;
    }
}

// Function to open file for guest
async function openFileForGuest(filePath: string) {
    try {
        // DO NOT open the file on host's machine
        // Just send the file content to guest
        console.log('[CodeWithMe] Host: Guest requested file content for:', filePath);
        await sendFileContentToGuestByPath(filePath);
        
        // Show full path so host knows exactly which file the guest opened
        vscode.window.showInformationMessage(`Sent file to guest: ${filePath}`);
    } catch (error) {
        console.error('[CodeWithMe] Host: Error sending file to guest:', error);
        vscode.window.showErrorMessage(`[CodeWithMe] Failed to send file to guest: ${path.basename(filePath)}`);
    }
}

// Remove all WebRTC and screen sharing logic
// Only keep file-based workspace and file sharing logic
// Function to update file content from guest
async function updateFileFromGuest(filePath: string, content: string) {
    try {
        console.log('[CodeWithMe] Host: Starting file update from guest:', filePath);

        // CRITICAL: Set sync guard flag to prevent infinite loops
        if (updatingFromRemoteFiles.has(filePath)) {
            console.log('[CodeWithMe] Host: Already updating from remote, skipping to prevent loop:', filePath);
            return;
        }
        
        // Check if content is the same as last processed to prevent duplicates
        const lastContent = lastProcessedContent.get(filePath);
        if (lastContent === content) {
            console.log('[CodeWithMe] Host: Content unchanged, skipping update for:', filePath);
            return;
        }
        
        // Set guard flag before any file operations
        updatingFromRemoteFiles.add(filePath);
        
        // Update last processed content
        lastProcessedContent.set(filePath, content);
        
        // Check if this is an Untitled file (new file in guest)
        if (filePath.startsWith('Untitled-')) {
            // Guest is editing an untitled file - find or create the corresponding document
            let document = guestUntitledMap.get(filePath);
            
            if (!document) {
                // Create new untitled document for this guest file
                document = await vscode.workspace.openTextDocument({
                    content: content,
                    language: 'plaintext'
                });
                guestUntitledMap.set(filePath, document);
                await vscode.window.showTextDocument(document);
                console.log('[CodeWithMe] Host: Created new untitled document for guest:', filePath);
                vscode.window.showInformationMessage(`Guest editing: ${filePath}`);
            } else {
                // Update existing document - find the editor and update content
                let editor = vscode.window.visibleTextEditors.find(e => e.document === document);
                if (!editor) {
                    editor = await vscode.window.showTextDocument(document);
                }
                
                // Replace entire content
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, content);
                });
                console.log('[CodeWithMe] Host: Updated existing untitled document from guest:', filePath);
            }
            return;
        }
        
        // For existing files, try to update without auto-opening
        try {
            const uri = vscode.Uri.file(filePath);
            
            // Check if file is already open in an editor
            let editor = vscode.window.visibleTextEditors.find(e => e.document.fileName === filePath);
            
            if (!editor) {
                // File is not open, just update the file on disk without opening it
                console.log('[CodeWithMe] Host: File not open, updating on disk only:', filePath);
                await fs.writeFile(filePath, content, 'utf8');
                console.log('[CodeWithMe] Host: File updated on disk from guest:', filePath);
                vscode.window.showInformationMessage(`Updated file from guest: ${path.basename(filePath)}`);
                showSyncActivity('Received from guest');
                return;
            }
            
            // File is already open, update the editor content
            const document = editor.document;
            
            // Create range for entire document
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            
            console.log('[CodeWithMe] Host: Replacing content, old length:', document.getText().length, 'new length:', content.length);
            
            // Replace entire content
            const success = await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, content);
            });
            
            if (success) {
                console.log('[CodeWithMe] Host: Successfully updated file from guest:', filePath);
                // Save silently
                await document.save();
                updateSyncStatus('Applied guest edit', '$(arrow-down)');
                showSyncActivity('Received from guest');
            } else {
                console.error('[CodeWithMe] Host: Failed to edit file from guest');
                throw new Error('Edit operation failed');
            }
        } catch (openError) {
            console.log('[CodeWithMe] Host: Could not open existing file, creating new one:', filePath);
            
            // If file doesn't exist, create it
            const newDocument = await vscode.workspace.openTextDocument({
                content: content,
                language: getLanguageFromPath(filePath)
            });
            
            await vscode.window.showTextDocument(newDocument);
            vscode.window.showInformationMessage(`Created new file from guest: ${path.basename(filePath)}`);
        }
    } catch (error) {
        console.error('[CodeWithMe] Host: Error updating file from guest:', error);
        vscode.window.showErrorMessage(`[CodeWithMe] Failed to update file from guest: ${path.basename(filePath)}`);
    } finally {
        // CRITICAL: Always reset the guard flag
        updatingFromRemoteFiles.delete(filePath);
        console.log('[CodeWithMe] Host: Reset sync guard flag after file update');
    }
}

// Function to save current file
async function saveCurrentFile() {
    try {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            await activeEditor.document.save();
            vscode.window.showInformationMessage(`Guest saved file: ${activeEditor.document.fileName}`);
        } else {
            vscode.window.showInformationMessage('No active file to save.');
        }
            } catch (error) {
        console.error('[CodeWithMe] Host: Error saving file:', error);
        vscode.window.showErrorMessage('[CodeWithMe] Failed to save file');
    }
}

// Function to find a file in the workspace tree
function findFileInTree(tree: any[], fileName: string): string | null {
    for (const node of tree) {
        if (node.type === 'file' && node.name === fileName) {
            return node.path;
        } else if (node.type === 'folder' && node.children) {
            const result = findFileInTree(node.children, fileName);
            if (result) {return result;}
        }
    }
    return null;
}

// Function to update sync status
function updateSyncStatus(status: string, icon: string = '$(sync)') {
    if (syncStatusItem) {
        syncStatusItem.text = `${icon} ${status}`;
        syncStatusItem.tooltip = `Real-time sync: ${status}`;
    }
}

// Function to show sync activity
function showSyncActivity(activity: string) {
    updateSyncStatus(activity, '$(sync~spin)');
    // Reset after 2 seconds
    setTimeout(() => {
        updateSyncStatus('Ready');
    }, 2000);
}

// WebView removed - direct VS Code integration

// Main activation function
export function activate(context: vscode.ExtensionContext) {
    console.log('[CodeWithMe] Extension activated!');
    
    // Create status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(people) Code with me';
    statusBarItem.tooltip = 'Click to open Code with me options';
    statusBarItem.command = 'code-with-me.showOptions';
    statusBarItem.show();
    
    // Create sync status indicator
    syncStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    syncStatusItem.text = '$(sync) Ready';
    syncStatusItem.tooltip = 'Real-time sync status';
    syncStatusItem.show();
    
    console.log('[CodeWithMe] Status bar item created and shown');
    // Ensure session status items (including invite item) are initialized
    ensureSessionStatusItem();
    if (inviteCodeStatusItem) {
        context.subscriptions.push(inviteCodeStatusItem);
    }
    
    // Ensure the Code with me Explorer view is registered (once)
    try {
        if (!codeWithMeTreeProvider) {
            codeWithMeTreeProvider = new CodeWithMeTreeProvider();
        }
        const treeView = vscode.window.createTreeView('code-with-me-explorer', {
            treeDataProvider: codeWithMeTreeProvider,
            showCollapseAll: true
        });
        context.subscriptions.push(treeView);
        console.log('[CodeWithMe] Explorer view registered');
    } catch (e) {
        console.error('[CodeWithMe] Failed to register Explorer view:', e);
    }
    // Command used by Explorer file nodes
    const openFromExplorerCmd = vscode.commands.registerCommand('code-with-me.openFromExplorer', async (node: any) => {
        try {
            if (!node) { console.log('[CodeWithMe] openFromExplorer: no node'); return; }
            // Node may be WorkspaceItem.item or raw tree node
            const n = node.item ? node.item : node;
            if (n.type !== 'file' || !n.path) {
                vscode.window.showWarningMessage('Code with me: Not a file');
                return;
            }
            if (!ws || ws.readyState !== 1) {
                vscode.window.showErrorMessage('Code with me: Not connected to host');
                return;
            }
            // Mirror the exact quick-pick flow: host opens and immediately streams file-content
            pendingFileContentRequests.add(n.path);
            pendingFileContentAt.set(n.path, Date.now());
            ws.send(JSON.stringify({ type: 'open-file', filePath: n.path }));
            console.log('[CodeWithMe] Guest: open-file sent from Explorer for', n.path);
        } catch (e) {
            console.error('[CodeWithMe] openFromExplorer failed:', e);
        }
    });
    context.subscriptions.push(openFromExplorerCmd);

    // Register commands
    const copyInviteCmd = vscode.commands.registerCommand('code-with-me.copyInvite', async () => {
        try {
            const url = lastSessionUrl || '';
            const code = url ? url.substring(url.lastIndexOf('/') + 1) : '';
            if (!code) {
                vscode.window.showWarningMessage('No active session code to copy.');
                return;
            }
            await vscode.env.clipboard.writeText(code);
            const action = await vscode.window.showInformationMessage(
                `Invite code copied: ${code}`,
                { title: 'Copy Code Again', isCloseAffordance: true }
            );
            if (action?.title === 'Copy Code Again') {
                await vscode.env.clipboard.writeText(code);
                vscode.window.showInformationMessage('Session code copied to clipboard again.');
            }
        } catch (e) {
            console.error('[CodeWithMe] copyInvite failed:', e);
            vscode.window.showErrorMessage('Failed to copy invite.');
        }
    });
    context.subscriptions.push(copyInviteCmd);
    let startSessionDisposable = vscode.commands.registerCommand('code-with-me.startSession', async () => {
        // Require GitHub sign-in before starting session
        const identity = await ensureGitHubSession(true);
        if (!identity) {
            vscode.window.showWarningMessage('Sign in with GitHub is required to start a Code with me session.');
            return;
        }

        // NEW: Ask for session mode
        const mode = await vscode.window.showQuickPick(
            [
                { label: 'Read & Write', description: 'Guests can edit files.', detail: 'Default' },
                { label: 'Read-only', description: 'Guests can only view files.' }
            ],
            { placeHolder: 'Select a collaboration mode for the session' }
        );

        if (!mode) { return; } // User cancelled

        const allowGuestEdit = mode.label === 'Read & Write';
        hostSessionPermissions = {
            allowGuestEdit: allowGuestEdit,
            allowGuestDebug: false,
            allowGuestTerminal: false,
            allowGuestFileCreate: allowGuestEdit,
            allowGuestFileDelete: allowGuestEdit,
        };
        vscode.window.showInformationMessage(`[CodeWithMe] Starting collaborative session as ${identity.userName}...`);

        // Generate a short, memorable session code
        const sessionId = generateSessionCode();
        lastSessionUrl = `${DEFAULT_PUBLIC_WS_URL}/${sessionId}`;

        await setupCollaborationSession(lastSessionUrl, 'Host');
        // Set shared session start time
        sessionStartMs = Date.now();
        __cwm_wasHost = true;
        refreshSessionStatusBar();
        // After a short delay (guest likely connected), resend workspace info
        setTimeout(() => {
            try { sendWorkspaceInfo(); } catch (e) { console.log('[CodeWithMe] Host: resend workspace info failed', e); }
        }, 1000);
        await shareSessionLink();
        refreshSessionStatusBar();
    });
    
    let joinSessionDisposable = vscode.commands.registerCommand('code-with-me.joinSession', async () => {
        // Require GitHub sign-in before joining session
        const identity = await ensureGitHubSession(true);
        if (!identity) {
            vscode.window.showWarningMessage('Sign in with GitHub is required to join a Code with me session.');
            return;
        }
        await joinSession();
    });
    // Guest helper: request workspace info again
    const reRequestInfoCmd = vscode.commands.registerCommand('code-with-me.requestWorkspaceInfo', async () => {
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'request-workspace-info', timestamp: Date.now() }));
            vscode.window.showInformationMessage('Requested workspace info from host');
        } else {
            vscode.window.showErrorMessage('Not connected to host');
        }
    });
    // Guest helper: quick-pick open from cached workspace
    const quickOpenCmd = vscode.commands.registerCommand('code-with-me.openFromWorkspace', async () => {
        const info = (global as any).__cwm_lastWorkspaceInfo;
        if (!info || !Array.isArray(info.tree)) {
            // Proactively request and retry once after a short delay
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'request-workspace-info', timestamp: Date.now() }));
            }
            vscode.window.showWarningMessage('Fetching host workspace...');
            setTimeout(() => vscode.commands.executeCommand('code-with-me.openFromWorkspace'), 800);
            return;
        }
        const files: string[] = [];
        const walk = (nodes: any[]) => {
            for (const n of nodes) {
                if (n.type === 'file' && n.path) {files.push(n.path);}
                if (n.type === 'folder' && Array.isArray(n.children)) {walk(n.children);}
            }
        };
        walk(info.tree);
        if (files.length === 0) {
            vscode.window.showWarningMessage('Workspace has no shareable files.');
            return;
        }
        const pick = await vscode.window.showQuickPick(files, { placeHolder: 'Select a host file to open' });
        if (pick && ws && ws.readyState === 1) {
            // Change to auto-open flow: guest asks host to open and host immediately responds with file-content
            pendingFileContentRequests.add(pick);
            pendingFileContentAt.set(pick, Date.now());
            ws.send(JSON.stringify({ type: 'open-file', filePath: pick }));
            // Do NOT show the “Requested file …” toast
            console.log('[CodeWithMe] Guest: open-file sent for', pick);
        }
    });
    
    let stopSessionDisposable = vscode.commands.registerCommand('code-with-me.stopSession', async (skipConfirm?: boolean) => {
        const roleNow: 'host' | 'guest' | null = currentSession?.role ?? currentRole;
        const isHost = roleNow === 'host';

        if (isHost) {
            if (!skipConfirm) {
                const choice = await vscode.window.showWarningMessage(
                    'End collaboration session?',
                    { modal: true },
                    'End session'
                );
                if (choice !== 'End session') {
                    return;
                }
            }
            vscode.window.showInformationMessage('[CodeWithMe] Stopping session...');
            await stopSession(true, 'host');
            refreshSessionStatusBar();
        } else {
            // Guest: allow forced stop without confirmation (e.g., when kicked by host)
            if (!skipConfirm) {
                const choice = await vscode.window.showWarningMessage(
                    'Leave Code With Me session?',
                    { modal: true },
                    'Leave session'
                );
                if (choice !== 'Leave session') {
                    return;
                }
            }
            vscode.window.showInformationMessage('[CodeWithMe] Leaving session...');
            await stopSession(true, 'guest');
            refreshSessionStatusBar();
        }
    });
    
    // Show session (host) menu: list guests and allow removal
    const showSessionMenuCmd = vscode.commands.registerCommand('code-with-me.showSessionMenu', async () => {
        await showHostSessionMenu();
    });
    
    // Register status bar command for the 3 options
    let showOptionsDisposable = vscode.commands.registerCommand('code-with-me.showOptions', async () => {
        console.log('[CodeWithMe] Show options command triggered');
        const action = await vscode.window.showQuickPick(
            [
                { label: 'Start Session', description: 'Start collaborative session and share invite link' },
                { label: 'Join Session', description: 'Join an existing collaborative session' },
                { label: 'Stop Session', description: 'Stop the current collaborative session' }
            ],
            { placeHolder: 'Choose Code with me action...' }
        );
        
        if (!action) {return;}

        if (action.label === 'Start Session') {
            await vscode.commands.executeCommand('code-with-me.startSession');
        } else if (action.label === 'Join Session') {
            await vscode.commands.executeCommand('code-with-me.joinSession');
        } else if (action.label === 'Stop Session') {
            await vscode.commands.executeCommand('code-with-me.stopSession');
        }
    });
    
    // Add disposables to context
    context.subscriptions.push(startSessionDisposable);
    context.subscriptions.push(joinSessionDisposable);
    context.subscriptions.push(stopSessionDisposable);
    context.subscriptions.push(showSessionMenuCmd);
    context.subscriptions.push(showOptionsDisposable);
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(syncStatusItem);
    context.subscriptions.push(reRequestInfoCmd);
    context.subscriptions.push(quickOpenCmd);
    
    // NEW: Add listener to update cursors when switching editor tabs
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        updateParticipantCursors();
    }));

    console.log('[CodeWithMe] All commands registered and status bar item added to context');

    // Persist labels across navigation during the session (Host and Guest)
    vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) {refreshOwnershipDecorations(ed);}
    });
    vscode.workspace.onDidOpenTextDocument((doc) => {
        const ed = vscode.window.visibleTextEditors.find(e => e.document === doc);
        if (ed) {refreshOwnershipDecorations(ed);}
    });
}

// Centralized cleanup for collaborative session resources and state
function cleanupSessionState() {
    try {
        console.log('[CodeWithMe] Cleanup: starting cleanupSessionState');
        // Clear batching timer and pending operations
        if (batchTimeout) {
            try {
                clearTimeout(batchTimeout);
            }
            catch {}
            batchTimeout = null;
        }
        try {
            pendingChanges.clear();
        }
        catch {}
        try {
            lastProcessedSequence = 0;
        }
        catch {}
        try { fileSeqCounter.clear(); } catch {}
        // Dispose session-scoped disposables (watchers, listeners)
        try {
            for (const d of sessionDisposables) {
                try { d.dispose(); } catch {}
            }
            sessionDisposables = [];
        } catch {}
        // Clear participant cursor data and dispose decorations
        try {
            participantCursors.clear();
        }
        catch {}
        try {
            participantCursorDecorations.forEach(d => { try { d.dispose(); } catch {} });
            participantCursorDecorations.clear();
        }
        catch {}
        // Dispose per-participant decorations
        try {
            participantDecorations.forEach(d => { try { d.dispose(); } catch {} });
            participantDecorations.clear();
        } catch {}
        try {
            cursorDecorations.forEach(d => { try { d.dispose(); } catch {} });
            cursorDecorations.clear();
        } catch {}
        // Dispose attribution/header decorations and clear ownership
        try {
            attributionDecorationTypes.forEach(d => { try { d.dispose(); } catch {} });
            attributionDecorationTypes.clear();
        } catch {}
        try {
            headerDecorationTypes.forEach(d => { try { d.dispose(); } catch {} });
            headerDecorationTypes.clear();
        } catch {}
        try {
            lineOwnership.clear();
        } catch {}
        // Clear per-file sync state maps/sets
        try { guestUntitledMap.clear(); } catch {}
        try { lastProcessedContent.clear(); } catch {}
        try { lastProcessedSeqByFileAndSender.clear(); } catch {}
        try { updatingFromRemoteFiles.clear(); } catch {}
        try { editConfirmationPromises.clear(); } catch {}
        try { recentMessageIds.splice(0, recentMessageIds.length); } catch {}
        // Clear session participants if present
        try { (currentSession as any)?.participants?.clear?.(); } catch {}
        // Reset cached workspace info
        try { (global as any).__cwm_lastWorkspaceInfo = undefined; } catch {}
        // Close websocket connection
        if (ws) {
            // Detach handlers to prevent late events after cleanup
            try { (ws as any).onopen = null; } catch {}
            try { (ws as any).onmessage = null; } catch {}
            try { (ws as any).onerror = null; } catch {}
            try { (ws as any).onclose = null; } catch {}
            try {
                ws.close(1000, 'Session stopped');
            }
            catch {}
            ws = null;
        }
        // Reset session state
        currentSession = null;
        currentRole = null;
        // Reset guards so a new session can register listeners/watchers
        sessionListenersActive = false;
        fileWatchersActive = false;
        // Update status bar
        try {
            updateSyncStatus('Session stopped', '$(circle-slash)');
            if (syncStatusItem) { syncStatusItem.text = '$(sync) Ready'; syncStatusItem.tooltip = 'Real-time sync status'; }
        }
        catch {}
        console.log('[CodeWithMe] Cleanup: completed cleanupSessionState');
    }
    catch (e) {
        console.warn('[CodeWithMe] Cleanup: error in cleanupSessionState', e);
    }
}

// Ensure full cleanup when the extension deactivates
export function deactivate() {
    try {
        console.log('[CodeWithMe] Extension deactivating – running cleanup');
        cleanupSessionState();
    } catch (e) {
        console.warn('[CodeWithMe] Error during deactivate cleanup', e);
    }
}

// Improved reload function
async function reloadWindowRobustly() {
    console.log('[CodeWithMe] Attempting to reload workspace window...');
    
    vscode.window.showInformationMessage('Code with me session ended. Reloading window...');
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        console.log('[CodeWithMe] Reload successful via direct command');
    } catch (e) {
        console.log('[CodeWithMe] Direct reload failed, trying alternatives:', e);
        
        try {
            await vscode.commands.executeCommand('developer.reload');
        } catch (e2) {
            console.log('[CodeWithMe] Developer reload failed, trying URI method:', e2);
            
            try {
                await vscode.env.openExternal(vscode.Uri.parse('command:workbench.action.reloadWindow'));
            } catch (e3) {
                console.log('[CodeWithMe] All automatic methods failed, prompting user:', e3);
                
                const action = await vscode.window.showWarningMessage(
                    'Please reload VS Code window to complete session cleanup.',
                    'Reload Now',
                    'Reload Later'
                );
                
                if (action === 'Reload Now') {
                    try {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    } catch (e4) {
                        vscode.window.showErrorMessage('Unable to reload automatically. Please use Ctrl+Shift+P > "Reload Window"');
                    }
                }
            }
        }
    }
}

// Helper: discard unsaved changes and close all editors on guest
async function discardAndCloseAllEditors() {
    try {
        const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
        for (const doc of dirtyDocs) {
            try {
                await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            } catch {}
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    } catch (e) {
        console.warn('[CodeWithMe] Guest cleanup: error closing editors', e);
    }
}

// Fixed stopSession function
async function stopSession(notifyOthers: boolean = true, initiatedBy: 'host' | 'guest' | 'auto' = 'auto') {
    if (!currentSession && !ws) {return;}
    if (isStopping) {return;}
    
    isStopping = true;
    const wasHost = currentSession?.role === 'host';
    const wasGuest = currentSession?.role === 'guest';
    const sessionId = currentSession?.sessionId;
    const actualRole = initiatedBy !== 'auto' ? initiatedBy : (wasHost ? 'host' : 'guest');
    
    console.log(`[CodeWithMe] Stopping session - Role: ${actualRole}, NotifyOthers: ${notifyOthers}`);
    // Confirmation is handled by the command handler to avoid double prompts
    
    try {
        if (ws && ws.readyState === WebSocket.OPEN && notifyOthers) {
            if (actualRole === 'host') {
                ws.send(JSON.stringify({
                    type: MESSAGE_TYPES.SESSION_STOPPED,
                    sessionId,
                    hostInitiated: true,
                    shouldReload: true,
                    timestamp: Date.now()
                }));
                console.log('[CodeWithMe] Host: Sent session-stopped to all guests');
            } else {
                ws.send(JSON.stringify({
                    type: MESSAGE_TYPES.GUEST_LEFT,
                    participantId: currentUserId,
                    userName: getDisplayUserName(currentRole || undefined),
                    shouldReload: false,
                    timestamp: Date.now()
                }));
                console.log('[CodeWithMe] Guest: Sent guest-left to host');
            }
        }
        
        cleanupSessionState();
        
        // If a guest is stopping their own session, close all editors without prompts
        if (actualRole === 'guest') {
            await discardAndCloseAllEditors();
        }
        
        // Always reload to ensure absolutely clean state for the next session (host or guest)
        console.log(`[CodeWithMe] Scheduling reload for ${actualRole}`);
        setTimeout(async () => {
            try {
                await reloadWindowRobustly();
            } catch (e) {
                console.error('[CodeWithMe] Reload failed:', e);
            }
        }, 300);
        
    } catch (e) {
        console.error('[CodeWithMe] Error during session stop:', e);
    } finally {
        isStopping = false;
    }
}