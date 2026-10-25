/**
 * WhatsTask Auto-Followup Bot (Upgraded v2.8 - Strict 9 AM - 6 PM Auto-Window + Anti-Freeze + Remind Button)
 * Key Features & Fixes in v2.8:
 * 1. STRICT 9:00 AM - 6:00 PM IST AUTOMATIC SCHEDULE:
 *    - Automatically pauses all automatic reminders from 6:00 PM to 9:00 AM IST (Night DND Always ON).
 *    - Automatically resumes at 9:00 AM IST sharp every morning without any manual button click!
 * 2. FIXED WRONG JID / CHAT ID OVERWRITE BUG:
 *    - Prevents `task.chatId` from being overwritten by `@lid` when someone replies, ensuring 15-min and 2-hour reminders never get lost.
 * 3. FIXED PROMISE QUEUE FREEZE & CRON-TRIGGERED CHECKS:
 *    - 15-second timeout per message send so a slow WhatsApp socket never blocks future reminders.
 *    - Every incoming request from cron-job.org also triggers the reminder check during daytime hours (9 AM - 6 PM).
 * 4. Added "🔔 Remind" button next to Approve & Delete on every task card in the Dashboard.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DATA_FILE = path.join(__dirname, 'tasks_data.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');

let detectedSelfUrl = process.env.RENDER_EXTERNAL_URL || null;

let store = {
  nextId: 101,
  settings: {
    quietHoursEnabled: true, // Strictly enabled: No auto-reminders between 6:00 PM and 9:00 AM IST
    quietStartHour: 18,      // 6:00 PM IST
    quietEndHour: 9,         // 9:00 AM IST
    requireManagerApproval: true
  },
  tasks: []
};

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.tasks)) {
        store = {
          ...store,
          ...parsed,
          settings: {
            ...store.settings,
            ...(parsed.settings || {}),
            // Always enforce 6 PM to 9 AM quiet hours automatically
            quietHoursEnabled: true,
            quietStartHour: 18,
            quietEndHour: 9
          }
        };
      }
    }
  } catch (e) {
    console.error('Error loading store:', e.message);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving store:', e.message);
  }
}

loadStore();

// Repair any existing tasks whose chatId was accidentally overwritten with @lid or missing NextNudgeAt
for (const t of store.tasks) {
  if (t.status !== 'completed') {
    if (t.chatId && t.chatId.endsWith('@lid') && t.altChatId && t.altChatId.endsWith('@s.whatsapp.net')) {
      console.log(`🔧 Restored Task #${t.id} chatId from ${t.chatId} -> ${t.altChatId}`);
      t.chatId = t.altChatId;
    }
    if (!t.nextNudgeAt) {
      t.nextNudgeAt = Date.now() + (t.intervalMins || 15) * 60000;
    }
  }
}
saveStore();

function getISTDate() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 5.5 * 3600000);
}

function formatISTTime(timestampMs) {
  if (!timestampMs) return 'Never';
  const d = new Date(timestampMs);
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + 5.5 * 3600000);
  return ist.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function isQuietHours() {
  const ist = getISTDate();
  const hour = ist.getHours();
  const start = store.settings.quietStartHour; // 18 (6 PM)
  const end = store.settings.quietEndHour;     // 9  (9 AM)
  if (start > end) {
    return hour >= start || hour < end;
  }
  return hour >= start && hour < end;
}

let sock = null;
let currentQR = null;
let currentPairingCode = null;
let isConnected = false;
let isConnecting = false;
let reconnectTimer = null;
let botOwnJid = null;
let isCheckingReminders = false;

const sentByBotMessageIds = new Set();
const sentMessagesForRetry = new Map();
let sendQueuePromise = Promise.resolve();

function clearAuthFolder() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log('🧹 Cleared auth_info_baileys folder for fresh session.');
    }
  } catch (e) {
    console.error('Failed to clear auth folder:', e.message);
  }
}

// --- Build Mentions Array so @30838083317796 becomes a real clickable @Name tag in WhatsApp ---
function buildMentions(text, savedMentions = []) {
  const mentionSet = new Set(Array.isArray(savedMentions) ? savedMentions : []);
  const matches = (text || '').matchAll(/@(\d{10,18})\b/g);
  for (const m of matches) {
    const num = m[1];
    const alreadyHas = Array.from(mentionSet).some(j => j.startsWith(num + '@'));
    if (!alreadyHas) {
      if (num.length >= 13) {
        mentionSet.add(`${num}@lid`);
      } else {
        mentionSet.add(`${num}@s.whatsapp.net`);
      }
    }
  }
  return Array.from(mentionSet);
}

// Helper to prevent sock.sendMessage from ever hanging the queue forever
function withTimeout(promise, ms, timeoutMsg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMsg)), ms);
    promise
      .then(val => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function sendWhatsAppMessage(jid, text, savedMentions = [], fallbackJid = null) {
  sendQueuePromise = sendQueuePromise
    .catch(() => {}) // Ensure a prior error never breaks the promise chain
    .then(async () => {
      if (!sock || !isConnected) {
        console.log(`[Offline - Reminder Held -> ${jid}]: ${text.slice(0, 60)}...`);
        return null;
      }

      const mentions = buildMentions(text, savedMentions);
      const payload = mentions.length > 0 ? { text, mentions } : { text };

      try {
        const sent = await withTimeout(
          sock.sendMessage(jid, payload),
          15000,
          'WhatsApp sendMessage timed out after 15s'
        );

        if (sent && sent.key && sent.key.id) {
          const id = sent.key.id;
          sentByBotMessageIds.add(id);
          sentMessagesForRetry.set(id, sent.message || { conversation: text });

          if (sentByBotMessageIds.size > 500) {
            const first = sentByBotMessageIds.values().next().value;
            sentByBotMessageIds.delete(first);
          }
          if (sentMessagesForRetry.size > 500) {
            const firstKey = sentMessagesForRetry.keys().next().value;
            sentMessagesForRetry.delete(firstKey);
          }
        }
        await new Promise(r => setTimeout(r, 1500));
        return sent || { ok: true };
      } catch (err) {
        console.error(`⚠️ Primary send failed (${jid}):`, err.message);

        // If primary JID failed and we have a fallback JID (like altChatId), try that immediately
        if (fallbackJid && fallbackJid !== jid) {
          try {
            console.log(`🔄 Trying fallback JID: ${fallbackJid}`);
            const sentFallback = await withTimeout(
              sock.sendMessage(fallbackJid, payload),
              15000,
              'Fallback sendMessage timed out'
            );
            if (sentFallback && sentFallback.key && sentFallback.key.id) {
              sentByBotMessageIds.add(sentFallback.key.id);
            }
            await new Promise(r => setTimeout(r, 1500));
            return sentFallback || { ok: true };
          } catch (err2) {
            console.error(`❌ Fallback send also failed (${fallbackJid}):`, err2.message);
          }
        }

        // If timed out, the WebSocket may be zombie/stale—trigger a fresh reconnect
        if (err.message.includes('timed out') || err.message.includes('Connection Closed')) {
          console.log('🔄 Detected stale WhatsApp socket, reconnecting...');
          isConnected = false;
          isConnecting = false;
          setTimeout(startWhatsApp, 1500);
        }

        await new Promise(r => setTimeout(r, 1000));
        return null;
      }
    });
  return sendQueuePromise;
}

// Send a reminder for a single task (used by both auto-scheduler & manual button)
async function triggerTaskReminder(task, isManual = false) {
  const now = Date.now();
  const headerPrefix = isManual ? '🔔 *MANUAL REMINDER' : '⏰ *TASK REMINDER';

  let sentResult = null;
  if (task.status === 'pending_approval') {
    sentResult = await sendWhatsAppMessage(
      task.chatId,
      `🔔 *PENDING BOSS APPROVAL (#${task.id})*\n\n📌 *Task:* ${task.title}\nयह काम पूरा रिपोर्ट किया गया है। रिमाइंडर बंद करने के लिए *"Approve #${task.id}"* लिखें।`,
      task.mentions,
      task.altChatId
    );
  } else {
    sentResult = await sendWhatsAppMessage(
      task.chatId,
      `${headerPrefix} (#${task.id})*\n\n📌 *Task:* ${task.title}\n📈 *Current Progress:* ${task.progress}% पूरा हुआ (${100 - task.progress}% बाकी है)\n📝 *Last Note:* ${task.lastNote || 'कोई अपडेट नहीं'}\n\nकृपया इस मैसेज पर Reply करें या लिखें: *"#${task.id} 40% हो गया"*`,
      task.mentions,
      task.altChatId
    );
  }

  if (sentResult) {
    task.lastNudgeAt = Date.now();
    task.nextNudgeAt = Date.now() + (task.intervalMins || 120) * 60000;
    task.lastSendError = null;
    saveStore();
    console.log(`✅ Sent reminder for Task #${task.id} -> Next in ${task.intervalMins} mins`);
    return true;
  } else {
    task.lastSendError = `Retry pending (${formatISTTime(now)})`;
    saveStore();
    return false;
  }
}

// Check and dispatch any due reminders (Strictly runs only between 9:00 AM and 6:00 PM IST)
async function checkAndSendDueReminders() {
  if (isCheckingReminders) return;
  if (!sock || !isConnected) return;
  if (isQuietHours()) return; // Strictly block automatic reminders between 6:00 PM and 9:00 AM IST

  isCheckingReminders = true;
  try {
    const now = Date.now();
    const dueTasks = store.tasks.filter(
      t => t.status !== 'completed' && (!t.nextNudgeAt || t.nextNudgeAt <= now)
    );

    for (const task of dueTasks) {
      if (isQuietHours()) break;
      await triggerTaskReminder(task, false);
    }
  } catch (e) {
    console.error('Error in checkAndSendDueReminders:', e.message);
  } finally {
    isCheckingReminders = false;
  }
}

// Middleware to auto-detect Render URL & trigger due reminders on every incoming HTTP / Cron request!
app.use((req, res, next) => {
  if (!detectedSelfUrl && req.headers.host && !req.headers.host.includes('localhost')) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    detectedSelfUrl = `${proto}://${req.headers.host}`;
    console.log('🌐 Auto-detected Keep-Alive URL:', detectedSelfUrl);
  }
  // Whenever cron-job.org or the user hits the server during 9 AM - 6 PM, proactively check due reminders!
  checkAndSendDueReminders().catch(() => {});
  next();
});

function cleanTaskText(rawText) {
  return rawText
    .replace(/^(?:task|टास्क)\s*:\s*/i, '')
    .replace(/\[(\d+\s*(?:m|min|mins|h|hr|hrs|d|day))\]/gi, '')
    .trim();
}

function parseIntervalMinutes(rawText, defaultMins = 120) {
  // 1. Check bracket format first e.g. [15m], [2h]
  const m = rawText.match(/\[(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\]/i);
  if (m) {
    const val = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('m')) return Math.max(5, val);
    if (unit.startsWith('h')) return val * 60;
    if (unit.startsWith('d')) return val * 1440;
  }

  // 2. Also support natural Hindi/English text e.g. "har 15 min", "every 15 mins", "15 minute me"
  const nat = rawText.match(/(?:every|har|हर)\s*(\d+)\s*(m|min|mins|minute|minutes|मिनट|h|hr|hrs|hour|hours|घंटे|घंटा)/i);
  if (nat) {
    const val = parseInt(nat[1], 10);
    const unit = nat[2].toLowerCase();
    if (unit.startsWith('m') || unit.includes('मिनट')) return Math.max(5, val);
    if (unit.startsWith('h') || unit.includes('घंट')) return val * 60;
  }

  return defaultMins;
}

function extractMultipleTasks(rawBody) {
  const bodyAfterPrefix = rawBody
    .replace(/^(?:task|टास्क)\s*:\s*/i, '')
    .replace(/\[(\d+\s*(?:m|min|mins|h|hr|hrs|d|day))\]/gi, '')
    .trim();

  const lines = bodyAfterPrefix
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    let assigneeHeader = '';
    let taskLines = lines;
    if (lines[0].split(/\s+/).length <= 3 && !/^\d+[\.\)]/.test(lines[0])) {
      assigneeHeader = lines[0];
      taskLines = lines.slice(1);
    }
    return taskLines.map(line => {
      const cleanedLine = line.replace(/^\d+[\.\)\-]\s*/, '').replace(/^[\-\*•]\s*/, '').trim();
      return assigneeHeader ? `${assigneeHeader} - ${cleanedLine}` : cleanedLine;
    }).filter(Boolean);
  }

  if (/\b1[\.\)]\s+.+\b2[\.\)]\s+/i.test(bodyAfterPrefix)) {
    const parts = bodyAfterPrefix.split(/\s*(?=\b\d+[\.\)]\s+)/).map(p => p.trim()).filter(Boolean);
    let prefix = '';
    let items = parts;
    if (!/^\d+[\.\)]/.test(parts[0])) {
      prefix = parts[0];
      items = parts.slice(1);
    }
    return items.map(item => {
      const clean = item.replace(/^\d+[\.\)]\s*/, '').trim();
      return prefix ? `${prefix} - ${clean}` : clean;
    });
  }

  return [cleanTaskText(rawBody)];
}

/**
 * STRICT REPLY PARSER (v2.8)
 */
function parseIncomingReply(text, quotedText, chatMatchedTasks, allActiveTasks) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();

  // 1. HARD LOOP GUARD
  if (
    raw.startsWith('👍') ||
    raw.startsWith('📋') ||
    raw.startsWith('✅') ||
    raw.startsWith('⏰') ||
    raw.startsWith('📊') ||
    raw.startsWith('🔔') ||
    raw.startsWith('⚠️') ||
    raw.startsWith('🚨') ||
    raw.startsWith('📝') ||
    lower.includes('update recorded') ||
    lower.includes('new task assigned') ||
    lower.includes('multiple tasks assigned') ||
    lower.includes('task completed') ||
    lower.includes('next check-in') ||
    lower.includes('auto-reminder:') ||
    lower.includes('manual reminder') ||
    lower.includes('approval needed') ||
    lower.includes('pending boss approval') ||
    lower.includes('delay / status noted') ||
    lower.includes('note recorded')
  ) {
    return { ignore: true };
  }

  // 2. Boss/Manager Approval ("Approve #101", "Close #101", "Approve all")
  const approveMatch = lower.match(/^(?:approve|close|final\s*done)\s*(?:#|task\s*)?(\d+|all)\b/i);
  if (approveMatch) {
    return {
      ignore: false,
      type: 'manager_approve',
      targetId: approveMatch[1] !== 'all' ? parseInt(approveMatch[1], 10) : 'all'
    };
  }

  // 3. Check explicit Task ID (#101) OR quoted Bot message with (#101)
  let targetTaskId = null;
  let isExplicitlyTargeted = false;

  const explicitIdMatch = lower.match(/(?:#|task\s*)(\d{3,4})\b/i);
  if (explicitIdMatch) {
    const idNum = parseInt(explicitIdMatch[1], 10);
    if (allActiveTasks.some(t => t.id === idNum)) {
      targetTaskId = idNum;
      isExplicitlyTargeted = true;
    }
  }

  if (!targetTaskId && quotedText) {
    const quotedIdMatch = quotedText.match(/\(#(\d{3,4})\)/) || quotedText.match(/#(\d{3,4})\b/);
    if (quotedIdMatch) {
      const qId = parseInt(quotedIdMatch[1], 10);
      if (allActiveTasks.some(t => t.id === qId)) {
        targetTaskId = qId;
        isExplicitlyTargeted = true;
      }
    }
  }

  // 4. Remove @mention numbers and #TaskID before checking for % so @308380... isn't mistaken for a number
  const textWithoutIdsAndMentions = lower
    .replace(/@\d{10,18}\b/g, '')
    .replace(/(?:#|task\s*)\d+/gi, '');
  const pctMatch = textWithoutIdsAndMentions.match(/\b(\d{1,3})\s*(?:%|percent|prcnt|प्रतिशत|फीसदी)/i);

  if (!isExplicitlyTargeted) {
    if (chatMatchedTasks.length > 0 && pctMatch && raw.length <= 45) {
      targetTaskId = chatMatchedTasks[chatMatchedTasks.length - 1].id;
    } else {
      return { ignore: true };
    }
  }

  // 5. Check Percentage
  if (pctMatch) {
    const pct = Math.min(100, Math.max(0, parseInt(pctMatch[1], 10)));
    if (pct < 100) {
      return {
        ignore: false,
        type: 'progress_update',
        targetId: targetTaskId,
        progress: pct,
        note: raw
      };
    } else {
      return {
        ignore: false,
        type: 'employee_claim_done',
        targetId: targetTaskId,
        progress: 100,
        note: raw
      };
    }
  }

  // 6. Check Delay / Blocker keywords
  if (/\b(delay|late|time lagega|kal|parson|ruk|atka|blocked|stuck|wait|baaki|baki|nahi hua|nhi hua|chalu hai|chal raha|kar raha|kr raha|working)\b|डिले|देरी|कल|बाकी|नहीं हुआ|चल रहा|कर रहा/i.test(lower)) {
    return {
      ignore: false,
      type: 'delay_or_note',
      targetId: targetTaskId,
      note: raw
    };
  }

  if (/\b(aadha|adha|half)\b|आधा/i.test(lower)) {
    return {
      ignore: false,
      type: 'progress_update',
      targetId: targetTaskId,
      progress: 50,
      note: raw
    };
  }

  if (/\b(thoda|shuru|started)\b|थोड़ा|शुरू/i.test(lower)) {
    return {
      ignore: false,
      type: 'progress_update',
      targetId: targetTaskId,
      progress: 20,
      note: raw
    };
  }

  // 7. Check if Employee claims "Done" / "ho gaya"
  if (/\b(done|completed|complete|ho gaya|hogaya|ho gya|khatam|poora ho gaya)\b|हो गया|पूरा हो गया|खत्म/i.test(lower)) {
    return {
      ignore: false,
      type: 'employee_claim_done',
      targetId: targetTaskId,
      progress: 100,
      note: raw
    };
  }

  // 8. General Q&A note when tagged with #ID or swipe-replied to bot
  return {
    ignore: false,
    type: 'general_qa_note',
    targetId: targetTaskId,
    note: raw
  };
}

function formatIntervalLabel(mins) {
  if (mins >= 1440 && mins % 1440 === 0) return `Every ${mins / 1440} Day(s) (24 Hours)`;
  if (mins >= 60 && mins % 60 === 0) return `Every ${mins / 60} Hour(s)`;
  return `Every ${mins} Mins`;
}

function formatNextDueInfo(nextNudgeAt) {
  if (isQuietHours()) {
    return '🌙 Paused (6 PM - 9 AM) • Resumes at 9:00 AM';
  }
  if (!nextNudgeAt) return 'Due now';
  const diffMs = nextNudgeAt - Date.now();
  if (diffMs <= 0) {
    return '⚡ Sending now...';
  }
  const minsLeft = Math.ceil(diffMs / 60000);
  if (minsLeft < 60) return `Next in ${minsLeft} min(s)`;
  const hrs = Math.floor(minsLeft / 60);
  const remMins = minsLeft % 60;
  return `Next in ${hrs}h ${remMins}m`;
}

async function startWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ws?.close();
      } catch (e) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest && latest.version) version = latest.version;
    } catch (e) {}

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      browser: Browsers && Browsers.ubuntu ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      getMessage: async (key) => {
        if (key && key.id && sentMessagesForRetry.has(key.id)) {
          return sentMessagesForRetry.get(key.id);
        }
        return { conversation: '⏰ Task Reminder Check-in' };
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        isConnected = false;
        console.log('📲 New QR Code generated.');
      }

      if (connection === 'open') {
        currentQR = null;
        currentPairingCode = null;
        isConnected = true;
        isConnecting = false;
        botOwnJid = sock.user?.id;
        console.log('✅ WhatsApp Connected as:', botOwnJid);

        // Immediately check if any reminders became due while disconnected/restarting (only sends if 9 AM - 6 PM)
        setTimeout(() => {
          checkAndSendDueReminders().catch(() => {});
        }, 3000);
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Connection closed (code: ${statusCode}).`);

        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.badSession ||
          statusCode === 401 ||
          statusCode === 403
        ) {
          clearAuthFolder();
          currentQR = null;
          currentPairingCode = null;
          reconnectTimer = setTimeout(startWhatsApp, 2500);
        } else {
          reconnectTimer = setTimeout(startWhatsApp, 4000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const msgId = msg.key.id;
        if (sentByBotMessageIds.has(msgId)) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') continue;

        const senderPn = msg.key.senderPn || msg.key.participant || null;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        if (!text || !text.trim()) continue;
        const trimmed = text.trim();

        const contextInfo = msg.message.extendedTextMessage?.contextInfo;
        const mentionedJids = contextInfo?.mentionedJid || [];
        const quotedMsg = contextInfo?.quotedMessage;
        const quotedText =
          quotedMsg?.conversation ||
          quotedMsg?.extendedTextMessage?.text ||
          '';

        // A. Assign new task(s) from WhatsApp when message starts with "Task:" or "टास्क:"
        if (/^(?:task|टास्क)\s*:/i.test(trimmed)) {
          const intervalMins = parseIntervalMinutes(trimmed, 120);
          const subTaskStrings = extractMultipleTasks(trimmed);

          const createdTasks = [];
          let staggerIdx = 0;
          for (const taskTitle of subTaskStrings) {
            const staggerMs = staggerIdx * 10000;
            staggerIdx++;
            const taskMentions = buildMentions(taskTitle, mentionedJids);
            const newTask = {
              id: store.nextId++,
              chatId: remoteJid, // Strictly keep the exact chat JID where the task was created!
              altChatId: senderPn && senderPn !== remoteJid ? senderPn : null,
              title: taskTitle,
              mentions: taskMentions,
              assignee: 'Team',
              progress: 0,
              status: 'in_progress',
              intervalMins,
              lastNudgeAt: Date.now(),
              nextNudgeAt: Date.now() + intervalMins * 60000 + staggerMs,
              lastNote: 'Assigned',
              createdAt: new Date().toISOString()
            };
            store.tasks.push(newTask);
            createdTasks.push(newTask);
          }
          saveStore();

          if (createdTasks.length === 1) {
            const t = createdTasks[0];
            await sendWhatsAppMessage(
              remoteJid,
              `📋 *NEW TASK ASSIGNED (#${t.id})*\n\n📌 *Task:* ${t.title}\n⏰ *Auto-Reminder:* ${formatIntervalLabel(t.intervalMins)} (9 AM - 6 PM)\n\n💡 _Update देने के लिए इस मैसेज पर Reply करें या लिखें: "#${t.id} 25% हो गया"_\n🔒 _काम पूरा होने पर बॉस "Approve #${t.id}" लिखकर बंद करेंगे।_`,
              t.mentions
            );
          } else {
            const listStr = createdTasks
              .map(t => `🔹 *#${t.id}:* ${t.title} (0% पूरा हुआ)`)
              .join('\n');
            await sendWhatsAppMessage(
              remoteJid,
              `📋 *MULTIPLE TASKS ASSIGNED (${createdTasks.length} Tasks)*\n\n${listStr}\n\n⏰ *Auto-Reminder:* ${formatIntervalLabel(intervalMins)} (9 AM - 6 PM)\n💡 _अलग-अलग अपडेट ऐसे दें:_\n_• "#${createdTasks[0].id} 50% हो गया"_\n_• "#${createdTasks[1].id} थोड़ा डिले है"_`,
              mentionedJids
            );
          }
          continue;
        }

        // B. Strict check for active tasks
        const allActiveTasks = store.tasks.filter(t => t.status !== 'completed');
        if (allActiveTasks.length === 0) continue;

        const chatMatchedTasks = allActiveTasks.filter(
          t =>
            t.chatId === remoteJid ||
            t.altChatId === remoteJid ||
            (senderPn && (t.chatId === senderPn || t.altChatId === senderPn))
        );

        const parsed = parseIncomingReply(
          trimmed,
          quotedText,
          chatMatchedTasks,
          allActiveTasks
        );
        if (parsed.ignore) continue;

        // Handle Boss Approval ("Approve #101" / "Close #101")
        if (parsed.type === 'manager_approve') {
          if (parsed.targetId === 'all') {
            if (chatMatchedTasks.length === 0) continue;
            chatMatchedTasks.forEach(t => {
              t.status = 'completed';
              t.progress = 100;
            });
            saveStore();
            await sendWhatsAppMessage(
              remoteJid,
              `✅ *ALL TASKS APPROVED & CLOSED*\n\nइस चैट के सभी ${chatMatchedTasks.length} टास्क बॉस द्वारा Complete मार्क कर दिए गए हैं। ऑटोमैटिक रिमाइंडर बंद हो गए हैं।`
            );
          } else {
            const task = allActiveTasks.find(t => t.id === parsed.targetId);
            if (task) {
              task.status = 'completed';
              task.progress = 100;
              saveStore();
              await sendWhatsAppMessage(
                remoteJid,
                `✅ *TASK COMPLETED & APPROVED (#${task.id})*\n\n📌 "${task.title}" को Complete कर दिया गया है। अब इसके रिमाइंडर बंद हो गए हैं।`,
                task.mentions
              );
            }
          }
          continue;
        }

        const task = allActiveTasks.find(t => t.id === parsed.targetId);
        if (!task) continue;

        // CRITICAL FIX: Do NOT overwrite task.chatId with @lid when replying!
        if (remoteJid && task.chatId !== remoteJid && !task.altChatId) {
          task.altChatId = remoteJid;
        }

        if (parsed.type === 'progress_update') {
          task.progress = parsed.progress;
          task.lastNote = parsed.note;
          task.status = 'in_progress';
          task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
          saveStore();

          await sendWhatsAppMessage(
            remoteJid,
            `📊 *TASK UPDATE RECORDED (#${task.id})*\n\n📌 *Task:* ${task.title}\n📈 *Progress:* ${task.progress}% पूरा हुआ (${100 - task.progress}% बाकी है)\n⏰ *Next Reminder:* ${formatIntervalLabel(task.intervalMins)} (9 AM - 6 PM)`,
            task.mentions
          );
        } else if (parsed.type === 'delay_or_note') {
          task.lastNote = parsed.note;
          task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
          saveStore();

          await sendWhatsAppMessage(
            remoteJid,
            `⚠️ *DELAY / STATUS NOTED (#${task.id})*\n\n📌 *Task:* ${task.title}\n📝 *Update:* "${parsed.note}"\n📈 *Current Progress:* ${task.progress}% पूरा हुआ\n⏰ _रिमाइंडर (9 AM - 6 PM) चालू रहेगा। कृपया साथ में काम का प्रतिशत भी बताएं।_`,
            task.mentions
          );
        } else if (parsed.type === 'general_qa_note') {
          task.lastNote = parsed.note;
          saveStore();

          await sendWhatsAppMessage(
            remoteJid,
            `📝 *NOTE RECORDED (#${task.id})*\n\n📌 *Task:* ${task.title}\n💬 *Reply:* "${parsed.note}"\n📈 *Current Progress:* ${task.progress}% पूरा हुआ\n\n👉 _कृपया यह भी बताएं कि काम कितने प्रतिशत हुआ है (जैसे: "#${task.id} 25 percent ho gaya")।_`,
            task.mentions
          );
        } else if (parsed.type === 'employee_claim_done') {
          task.progress = 100;
          task.lastNote = parsed.note;

          if (store.settings.requireManagerApproval) {
            task.status = 'pending_approval';
            task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
            saveStore();

            await sendWhatsAppMessage(
              remoteJid,
              `🔔 *APPROVAL NEEDED (#${task.id})*\n\n📌 *Task:* ${task.title}\nएम्प्लॉई ने लिखा है कि काम पूरा हो गया है ("${parsed.note}")।\n\n👉 *बॉस ध्यान दें:* रिमाइंडर बंद करने के लिए कृपया *"Approve #${task.id}"* या *"Close #${task.id}"* लिखें (या डैशबोर्ड से Approve दबाएं)।`,
              task.mentions
            );
          } else {
            task.status = 'completed';
            saveStore();
            await sendWhatsAppMessage(
              remoteJid,
              `✅ *TASK COMPLETED (#${task.id})*\n\n📌 "${task.title}" पूरा हो गया है। रिमाइंडर बंद कर दिए गए हैं।`,
              task.mentions
            );
          }
        }
      }
    });
  } catch (err) {
    console.error('WhatsApp init error:', err.message);
    isConnecting = false;
    reconnectTimer = setTimeout(startWhatsApp, 5000);
  }
}

// --- Background Reminder Scheduler (Checks every 30 seconds, sends ONLY between 9:00 AM and 6:00 PM IST) ---
setInterval(() => {
  checkAndSendDueReminders().catch(err => {
    console.error('Scheduler error:', err.message);
  });
}, 30000);

// --- Internal Keep-Alive Self-Ping (Every 4 minutes) ---
setInterval(() => {
  const targetUrl = detectedSelfUrl || process.env.RENDER_EXTERNAL_URL;
  if (targetUrl) {
    const client = targetUrl.startsWith('https') ? https : http;
    client.get(`${targetUrl}/api/status`, (res) => {
      res.resume();
    }).on('error', () => {});
  }
}, 4 * 60 * 1000);

app.get('/api/status', (req, res) => {
  const qrImageUrl = currentQR
    ? `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(currentQR)}`
    : '';
  res.json({
    isConnected,
    qrImageUrl,
    pairingCode: currentPairingCode || null,
    isQuietHours: isQuietHours(),
    activeTasksCount: store.tasks.filter(t => t.status !== 'completed').length
  });
});

// Manual Remind Now endpoint for individual task (Works anytime when you click 🔔 Remind)
app.post('/api/remind/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = store.tasks.find(t => t.id === id && t.status !== 'completed');
  if (task) {
    await triggerTaskReminder(task, true);
  }
  res.redirect('/?reminded=' + id);
});

app.post('/api/pair-phone', async (req, res) => {
  try {
    const rawPhone = (req.body.pairPhone || '').replace(/\D/g, '');
    if (!rawPhone || rawPhone.length < 10) {
      return res.redirect('/?error=invalid_phone');
    }
    const phoneWithCountry = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;

    if (!sock) {
      await startWhatsApp();
    }
    await new Promise(r => setTimeout(r, 1500));

    if (sock && typeof sock.requestPairingCode === 'function') {
      const code = await sock.requestPairingCode(phoneWithCountry);
      currentPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`🔑 Generated Pairing Code for ${phoneWithCountry}: ${currentPairingCode}`);
    }
    res.redirect('/');
  } catch (err) {
    console.error('Pairing code error:', err.message);
    res.redirect('/?error=pair_failed');
  }
});

app.post('/api/reset-session', async (req, res) => {
  try {
    isConnected = false;
    isConnecting = false;
    currentQR = null;
    currentPairingCode = null;
    if (sock) {
      try {
        sock.ws?.close();
      } catch (e) {}
      sock = null;
    }
    clearAuthFolder();
    setTimeout(startWhatsApp, 1000);
  } catch (e) {}
  res.redirect('/');
});

app.post('/api/assign', async (req, res) => {
  const { employeeName, phone, details, intervalMins } = req.body;
  if (!phone || !details) return res.redirect('/');

  const cleanPhone = phone.replace(/\D/g, '');
  const finalPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
  const jid = finalPhone.endsWith('@g.us') ? finalPhone : `${finalPhone}@s.whatsapp.net`;
  const mins = parseInt(intervalMins, 10) || 120;

  const subTasks = extractMultipleTasks(details);
  let staggerIndex = 0;
  for (const title of subTasks) {
    const staggerMs = staggerIndex * 10000;
    staggerIndex++;

    const newTask = {
      id: store.nextId++,
      chatId: jid,
      title: employeeName ? `@${employeeName} - ${title}` : title,
      mentions: !finalPhone.endsWith('@g.us') ? [`${finalPhone}@s.whatsapp.net`] : [],
      assignee: employeeName || 'Employee',
      progress: 0,
      status: 'in_progress',
      intervalMins: mins,
      lastNudgeAt: Date.now(),
      nextNudgeAt: Date.now() + mins * 60000 + staggerMs,
      lastNote: 'Assigned from Dashboard',
      createdAt: new Date().toISOString()
    };
    store.tasks.push(newTask);

    await sendWhatsAppMessage(
      jid,
      `📋 *NEW TASK ASSIGNED (#${newTask.id})*\n\n👤 *Assignee:* ${newTask.assignee}\n📌 *Task:* ${newTask.title}\n⏰ *Auto-Reminder:* ${formatIntervalLabel(mins)} (9 AM - 6 PM)\n\n💡 _अपडेट देने के लिए इस मैसेज पर Reply करें या लिखें: "#${newTask.id} 25% हो गया"_`,
      newTask.mentions
    );
  }
  saveStore();
  res.redirect('/');
});

app.post('/api/complete/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = store.tasks.find(t => t.id === id);
  if (task) {
    task.status = 'completed';
    task.progress = 100;
    saveStore();
    await sendWhatsAppMessage(
      task.chatId,
      `✅ *TASK APPROVED & COMPLETED (#${task.id})*\n\n📌 "${task.title}" को डैशबोर्ड से Complete कर दिया गया है। अब रिमाइंडर बंद हो गए हैं।`,
      task.mentions,
      task.altChatId
    );
  }
  res.redirect('/');
});

app.post('/api/delete/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  store.tasks = store.tasks.filter(t => t.id !== id);
  saveStore();
  res.redirect('/');
});

app.get('/', async (req, res) => {
  const activeTasks = store.tasks.filter(t => t.status !== 'completed');
  const istNow = getISTDate();
  const timeStr = istNow.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const quietNow = isQuietHours();
  const remindedId = req.query.reminded ? parseInt(req.query.reminded, 10) : null;

  let qrImageUrl = '';
  if (currentQR) {
    qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(currentQR)}`;
  }

  res.send(`<!DOCTYPE html>
<html lang="hi" translate="no">
<head>
  <meta charset="UTF-8">
  <meta name="google" content="notranslate">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsTask Auto-Followup Bot v2.8</title>
  <style>
    body { background:#0b1120; color:#f8fafc; font-family:system-ui,-apple-system,sans-serif; margin:0; padding:16px; }
    .card { background:#151f32; border:1px solid #263554; border-radius:16px; padding:20px; max-width:540px; margin:0 auto 16px; }
    h1 { color:#25d366; margin:0 0 8px; font-size:22px; }
    .badge { display:inline-block; padding:6px 14px; border-radius:99px; font-size:13px; font-weight:600; margin-top:8px; }
    .badge-ok { background:#064e3b; color:#34d399; }
    .badge-warn { background:#451a03; color:#fbbf24; }
    input, select, textarea { width:100%; box-sizing:border-box; padding:12px; margin-bottom:12px; border-radius:10px; border:1px solid #334155; background:#0f172a; color:#fff; font-size:14px; }
    .btn { width:100%; padding:13px; border:none; border-radius:10px; background:#16a34a; color:#fff; font-weight:700; font-size:15px; cursor:pointer; }
    .btn-blue { background:#2563eb; }
    .btn-red { background:#dc2626; padding:10px; font-size:13px; margin-top:8px; }
    .task-row { background:#0f172a; border:1px solid #1e293b; border-radius:12px; padding:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
    .pair-box { background:#0f172a; border:2px dashed #38bdf8; border-radius:12px; padding:14px; margin-top:12px; font-size:26px; font-weight:800; letter-spacing:4px; color:#38bdf8; }
    .toast { background:#065f46; border:1px solid #10b981; color:#ecfdf5; padding:10px 14px; border-radius:10px; font-size:13px; margin-bottom:12px; text-align:center; font-weight:600; }
  </style>
</head>
<body>
  <div class="card" style="text-align:center;">
    <h1>WhatsTask Auto-Followup Bot v2.8</h1>
    <p style="color:#94a3b8; font-size:13px; margin:0;">Real @Mention Tagging • Auto 9 AM - 6 PM Window • Manual Remind Button</p>
    <div id="statusBadgeContainer">
      ${isConnected
        ? '<span class="badge badge-ok">✅ WhatsApp Connected & Active</span>'
        : '<span class="badge badge-warn">📱 Link WhatsApp Below (QR or Phone Number)</span>'}
    </div>
    <p style="font-size:12px; color:#94a3b8; margin-top:10px; margin-bottom:0;">
      IST Time: <b>${timeStr}</b> | Auto-Schedule (9 AM - 6 PM): <b>${quietNow ? '🌙 Night DND (Paused 6PM-9AM)' : '☀️ Daytime Active (Sending Reminders)'}</b>
    </p>
  </div>

  ${remindedId ? `
  <div class="card" style="padding:0; background:transparent; border:none;">
    <div class="toast">🔔 Task #${remindedId} का रिमाइंडर WhatsApp पर तुरंत भेज दिया गया है!</div>
  </div>
  ` : ''}

  ${!isConnected ? `
  <div class="card" style="text-align:center;">
    <h3 style="margin-top:0; color:#4ade80;">तरीका 1: बिना QR स्कैन किए नंबर से जोड़ें (सबसे आसान)</h3>
    <p style="font-size:13px; color:#cbd5e1; margin-bottom:12px;">
      बॉट वाला WhatsApp नंबर नीचे डालें और 8-अंकों का कोड पाएं:
    </p>
    <form method="POST" action="/api/pair-phone">
      <input name="pairPhone" placeholder="WhatsApp Number with 91 (e.g. 919876543210)" required />
      <button type="submit" class="btn btn-blue">🔑 Get 8-Digit Pairing Code</button>
    </form>

    ${currentPairingCode ? `
      <div class="pair-box">${currentPairingCode}</div>
      <p style="font-size:12px; color:#fbbf24; margin-top:8px;">
        फोन में WhatsApp खोलें ➔ <b>Linked Devices</b> ➔ <b>Link a Device</b> ➔ नीचे <b>"Link with phone number instead"</b> पर टैप करें और ऊपर वाला कोड डालें!
      </p>
    ` : ''}

    <hr style="border:0; border-top:1px solid #263554; margin:20px 0;" />

    <h3 style="margin-top:0;">तरीका 2: Scan Live QR Code</h3>
    <p style="font-size:12px; color:#94a3b8;">यह QR हर 5 सेकंड में अपने आप ताज़ा (Refresh) होता है:</p>
    <div id="qrBox">
      ${qrImageUrl
        ? `<img id="qrImg" src="${qrImageUrl}" style="border:8px solid #fff; border-radius:12px; max-width:240px;" />`
        : `<p style="color:#fbbf24; font-size:13px;">⏳ नया QR Code बन रहा है... कृपया 5 सेकंड रुकें।</p>`}
    </div>

    <form method="POST" action="/api/reset-session">
      <button type="submit" class="btn btn-red">🔄 Reset Stuck Session & Generate Fresh QR</button>
    </form>
  </div>

  <script>
    setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.isConnected) {
          window.location.reload();
          return;
        }
        if (data.qrImageUrl) {
          const qrBox = document.getElementById('qrBox');
          const existingImg = document.getElementById('qrImg');
          if (existingImg) {
            if (existingImg.src !== data.qrImageUrl) existingImg.src = data.qrImageUrl;
          } else if (qrBox) {
            qrBox.innerHTML = '<img id="qrImg" src="' + data.qrImageUrl + '" style="border:8px solid #fff; border-radius:12px; max-width:240px;" />';
          }
        }
      } catch (e) {}
    }, 5000);
  </script>
  ` : `
  <div class="card" style="text-align:center;">
    <form method="POST" action="/api/reset-session" onsubmit="return confirm('क्या आप वाकई WhatsApp डिस्कनेक्ट करके नया नंबर जोड़ना चाहते हैं?');">
      <button type="submit" class="btn btn-red" style="margin-top:0;">🔌 Disconnect / Change WhatsApp Number</button>
    </form>
  </div>
  `}

  <div class="card" style="border-color:#14532d; background:#0c1f17;">
    <h4 style="color:#4ade80; margin:0 0 8px;">💡 WhatsApp से टास्क और रिप्लाई कैसे काम करेगा?</h4>
    <p style="font-size:13px; color:#cbd5e1; margin:0 0 8px;">1. नया टास्क देने के लिए शुरू में <b>Task:</b> लिखें और समय <b>[15m]</b> या <b>[2h]</b> लगाएं:</p>
    <pre style="background:#07120d; padding:10px; border-radius:8px; color:#4ade80; font-size:12px; white-space:pre-wrap;">Task: @Dexterous Dessins [15m]
1. क्लाइंट को कोटेशन भेजो
2. साइट की फोटो मंगवाओ</pre>
    <p style="font-size:12px; color:#94a3b8; margin:8px 0 0;">
      2. रिमाइंडर रोज़ सुबह <b>9:00 AM से शाम 6:00 PM</b> तक अपने आप जाएंगे और शाम 6 बजे से सुबह 9 बजे तक अपने आप बंद रहेंगे।
    </p>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">Assign New Task (One or Multiple)</h3>
    <form method="POST" action="/api/assign">
      <input name="employeeName" placeholder="Employee Name (e.g. DD)" required />
      <input name="phone" placeholder="WhatsApp Number with 91 (e.g. 919876543210)" required />
      <textarea name="details" rows="3" placeholder="1. Send quotation PDF&#10;2. Check site report" required></textarea>
      <select name="intervalMins">
        <option value="15">Remind every 15 Minutes (Daytime 9AM-6PM)</option>
        <option value="60">Remind every 1 Hour (Daytime 9AM-6PM)</option>
        <option value="120" selected>Remind every 2 Hours (Daytime 9AM-6PM)</option>
        <option value="240">Remind every 4 Hours (Daytime 9AM-6PM)</option>
        <option value="1440">Remind every 24 Hours (Daily 9AM-6PM)</option>
      </select>
      <button type="submit" class="btn">Send on WhatsApp & Start Reminders</button>
    </form>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">Active Tasks (${activeTasks.length})</h3>
    ${activeTasks.length === 0 ? '<p style="color:#64748b; font-size:14px;">कोई पेंडिंग टास्क नहीं है।</p>' : activeTasks.map(t => `
      <div class="task-row">
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:700; font-size:14px;">#${t.id}: ${t.title}</div>
          <div style="font-size:12px; color:#94a3b8; margin-top:4px;">Progress: <b>${t.progress}%</b> | Note: ${t.lastNote}</div>
          <div style="font-size:11px; color:#38bdf8; margin-top:3px;">
            ${formatIntervalLabel(t.intervalMins)} • <span style="color:#fbbf24;">${formatNextDueInfo(t.nextNudgeAt)}</span>
            • <span style="color:#94a3b8;">Last Sent: ${formatISTTime(t.lastNudgeAt)}</span>
            ${t.lastSendError ? ` • <span style="color:#f87171;">⚠️ ${t.lastSendError}</span>` : ''}
            ${t.status === 'pending_approval' ? ' • 🔔 Needs Boss Approval' : ''}
          </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <form method="POST" action="/api/remind/${t.id}" style="margin:0;">
            <button type="submit" title="Send Reminder Now on WhatsApp" style="background:#f59e0b; color:#0f172a; border:none; padding:8px 10px; border-radius:8px; font-weight:700; cursor:pointer; font-size:12px;">🔔 Remind</button>
          </form>
          <form method="POST" action="/api/complete/${t.id}" style="margin:0;">
            <button type="submit" style="background:#059669; color:#fff; border:none; padding:8px 10px; border-radius:8px; font-weight:600; cursor:pointer; font-size:12px;">Approve</button>
          </form>
          <form method="POST" action="/api/delete/${t.id}" style="margin:0;">
            <button type="submit" style="background:#dc2626; color:#fff; border:none; padding:8px 10px; border-radius:8px; font-weight:600; cursor:pointer; font-size:12px;">🗑️</button>
          </form>
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startWhatsApp();
});
