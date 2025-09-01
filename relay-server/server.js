const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { URL } = require('url');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(cors());
app.use(helmet());

// Simple health endpoint
app.get('/', (_req, res) => res.json({ ok: true, service: 'code-with-me-relay' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// sessionId -> { hostWs: WebSocket, guests: Map<participantId, WebSocket> }
const sessions = new Map();

/**
 * Attach metadata safely to a ws
 */
function tagSocket(ws, info) {
  ws.__cwm = Object.assign({}, ws.__cwm || {}, info);
}

/**
 * Safe send
 */
const safeSend = (ws, obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
};

/**
 * Broadcast a message to all participants in a session except the sender.
 */
function broadcast(senderWs, message) {
  const meta = senderWs.__cwm || {};
  if (!meta.sessionId) return;

  const session = sessions.get(meta.sessionId);
  if (!session) return;

  const strMessage = JSON.stringify(message);

  const sendMessage = (ws) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(strMessage);
        } catch (e) {
            console.error('[Relay] sendMessage error:', e);
        }
    }
  };

  let recipients = 0;
  // If sender is the host, send to all guests
  if (meta.role === 'Host') {
    session.guests.forEach((guest) => { sendMessage(guest.ws); recipients++; });
  } else if (meta.role === 'Guest') {
    // If sender is a guest, ONLY send to the host.
    // The host is the source of truth and will broadcast back to all guests.
    if (session.hostWs) { sendMessage(session.hostWs); recipients++; }
  }

  if (message && message.type) {
    console.log(`[Relay] Broadcast ${message.type} from ${meta.role} to ${recipients} recipient(s) in session ${meta.sessionId}`);
  }
}

wss.on('connection', (ws, req) => {
  console.log('[Relay] New connection from', req.socket.remoteAddress, 'to', req.url);
  const { pathname } = new URL(req.url, `ws://${req.headers.host}`);
  const sessionId = pathname.substring(1); // remove leading '/'

  if (!sessionId) {
      console.log('[Relay] Connection without session ID, closing.');
      ws.close(1008, 'Session ID is required in the URL path.');
      return;
  }

  tagSocket(ws, { sessionId });

  ws.on('message', (raw) => {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
    } catch (e) {
      console.error('[Relay] Non-JSON message dropped');
      return;
    }

    // The first message should be 'role-identification'
    if (data.type === 'role-identification') {
      const { role, userName } = data;
      const meta = ws.__cwm;

      if (role === 'Host') {
        if (sessions.has(meta.sessionId)) {
          console.log(`[Relay] Host tried to connect to existing session ${meta.sessionId}. Closing.`);
          safeSend(ws, { type: 'error', message: 'Session already exists.' });
          ws.close();
          return;
        }
        const participantId = 'host-' + uuidv4();
        sessions.set(meta.sessionId, { hostWs: ws, guests: new Map() });
        tagSocket(ws, { role: 'Host', participantId, userName: userName || 'Host' });
        console.log(`[Relay] Host ${participantId} (${userName}) created session ${meta.sessionId}`);
        safeSend(ws, { type: 'session-created', sessionId: meta.sessionId });
      } else if (role === 'Guest') {
        const session = sessions.get(meta.sessionId);
        if (!session) {
          console.log(`[Relay] Guest tried to join non-existent session ${meta.sessionId}.`);
          safeSend(ws, { type: 'error', message: 'Session not found' });
          ws.close();
          return;
        }
        const participantId = 'guest-' + uuidv4();
        session.guests.set(participantId, { ws, userName: userName || 'Guest' });
        tagSocket(ws, { role: 'Guest', participantId, userName: userName || 'Guest' });
        console.log(`[Relay] Guest ${participantId} (${userName}) joined session ${meta.sessionId}`);
        safeSend(ws, { type: 'session-joined', sessionId: meta.sessionId });
        // Notify everyone that a new participant has joined
        broadcast(ws, { type: 'participant-joined', participantId: ws.__cwm.participantId, userName: ws.__cwm.userName });
      }
      return;
    }

    // For any other message, broadcast it.
    const senderMeta = ws.__cwm || {};
    if (!senderMeta.role) {
        console.log('[Relay] Message from unidentified client. Dropping.');
        return;
    }

    if (data && data.type === 'file-change') {
      const fp = data.filePath || data.path || '<unknown>';
      console.log(`[Relay] Received file-change for ${fp} (seq=${data.sequence ?? '?'}) from ${senderMeta.role} ${senderMeta.participantId} in session ${senderMeta.sessionId}`);
    }

    const envelope = {
      __relay: true,
      from: senderMeta.role || 'Unknown',
      participantId: senderMeta.participantId,
      ...data
    };
    broadcast(ws, envelope);
  });

  ws.on('close', () => {
    const meta = ws.__cwm || {};
    if (!meta.sessionId) return;

    const session = sessions.get(meta.sessionId);
    if (!session) return;

    if (meta.role === 'Host') {
      // If the host disconnects, close the entire session
      console.log(`[Relay] Host of session ${meta.sessionId} disconnected. Closing session.`);
      // Notify all guests and close their connections
      for (const guest of session.guests.values()) {
        safeSend(guest.ws, { type: 'session-ended', message: 'Host has left the session.' });
        guest.ws.close();
      }
      sessions.delete(meta.sessionId);
    } else if (meta.role === 'Guest') {
      // If a guest disconnects, just remove them from the session
      // and notify remaining participants
      broadcast(ws, { type: 'participant-left', participantId: meta.participantId });
      session.guests.delete(meta.participantId);
      console.log(`[Relay] Guest ${meta.participantId} left session ${meta.sessionId}.`);
    }
  });
});

server.listen(3000, () => {
  console.log('Relay server running on port 3000');
});