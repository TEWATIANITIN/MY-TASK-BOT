/**
 * WhatsTask Auto-Followup Bot (Final v3.3 - Default 24 Hours Reminder + Combined Multi-Task Reminders)
 *
 * KEY UPGRADES IN v3.3:
 * 1. DEFAULT REMINDER CHANGED TO 24 HOURS (1440 Minutes):
 *    - Whenever you assign a task in WhatsApp without specifying a bracket interval (like `[15m]` or `[2h]`), the default reminder interval is now 24 Hours (1440 mins) instead of 2 Hours!
 *    - Also made "Remind every 24 Hours (Daily 9AM-6PM)" the default selected option in the Dashboard dropdown.
 * 2. COMBINED SINGLE REMINDER FOR MULTIPLE TASKS (No More 10 Separate Messages Spam!):
 *    - When you assign multiple tasks to an employee, the bot sends ONE combined summary message when assigning AND ONE combined reminder message when due.
 * 3. MULTI-TASK BULK REPLY SUPPORT:
 *    - Employees can reply to multiple tasks in a single message (e.g. `#117 50% #118 done #123 30%`) and the bot updates all of them at once.
 * 4. Preserves all v3.1/v3.2 fixes: Locked Phone JID (`@s.whatsapp.net`), Zero "Waiting for this message" fix, Strict 9:00 AM - 6:00 PM IST schedule, and Manual "🔔 Remind" button.
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
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DATA_FILE = path.join(__dirname, 'tasks_data.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');
const silentLogger = pino({ level: 'silent' });

let detectedSelfUrl = process.env.RENDER_EXTERNAL_URL || null;

let store = {
  nextId: 101,
  lidToPnMap: {}, // Maps WhatsApp @lid -> real @s.whatsapp.net phone JID
  settings: {
    quietHoursEnabled: true, // Strictly 9:00 AM to 6:00 PM IST (No reminders 6 PM - 9 AM)
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
          lidToPnMap: { ...(store.lidToPnMap || {}), ...(parsed.lidToPnMap || {}) },
          settings: {
            ...store.settings,
            ...(parsed.settings || {}),
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

/**
 * Normalizes any JID:
 * - Strips device ":xx" suffix (e.g., `919876543210:12@s.whatsapp.net` -> `919876543210@s.whatsapp.net`)
 * - Converts `@lid` to `@s.whatsapp.net` whenever the mapping is known
 */
function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return jid;
  const clean = jid.replace(/:\d+@/, '@');
  if (clean.endsWith('@lid') && store.lidToPnMap && store.lidToPnMap[clean]) {
    return store.lidToPnMap[clean];
  }
  return clean;
}

function extractPhoneJidFromText(text) {
  if (!text) return null;
  const m = text.match(/@(91\d{10})\b/);
  if (m) return `${m[1]}@s.whatsapp.net`;
  return null;
}

function resolveCanonicalChatIds(msg) {
  const rawRemote = normalizeJid(msg.key.remoteJid);
  const rawSenderPn = normalizeJid(
    msg.key.senderPn ||
    msg.key.participantPn ||
    (msg.key.participant && msg.key.participant.endsWith('@s.whatsapp.net') ? msg.key.participant : null)
  );
  const rawParticipantLid = normalizeJid(
    msg.key.participant && msg.key.participant.endsWith('@lid') ? msg.key.participant : null
  );

  if (rawRemote && rawRemote.endsWith('@lid') && rawSenderPn && rawSenderPn.endsWith('@s.whatsapp.net')) {
    store.lidToPnMap[rawRemote] = rawSenderPn;
  }
  if (rawParticipantLid && rawSenderPn && rawSenderPn.endsWith('@s.whatsapp.net')) {
    store.lidToPnMap[rawParticipantLid] = rawSenderPn;
  }

  if (rawRemote && rawRemote.endsWith('@lid')) {
    const mappedPn = store.lidToPnMap[rawRemote] || rawSenderPn;
    if (mappedPn && mappedPn.endsWith('@s.whatsapp.net')) {
      return { primaryChatId: mappedPn, altChatId: rawRemote };
    }
  }

  return { primaryChatId: rawRemote, altChatId: rawSenderPn || rawParticipantLid || null };
}

// Startup Self-Healing & Syncing: Repair existing tasks and align nextNudgeAt for tasks in the same chat & interval
const chatIntervalSyncMap = new Map();
for (const t of store.tasks) {
  if (t.status !== 'completed') {
    t.chatId = normalizeJid(t.chatId);
    t.altChatId = normalizeJid(t.altChatId);

    if (t.chatId && t.chatId.endsWith('@lid') && t.altChatId && t.altChatId.endsWith('@s.whatsapp.net')) {
      const oldLid = t.chatId;
      t.chatId = t.altChatId;
      t.altChatId = oldLid;
    }

    if (t.chatId && (t.chatId.endsWith('@s.whatsapp.net') || t.chatId.endsWith('@g.us'))) {
      t.chatIdLocked = true;
    }

    if (t.chatId && !t.chatId.endsWith('@g.us')) {
      t.mentions = [];
    }

    if (typeof t.progress === 'number' && t.progress < 100 && t.status === 'pending_approval') {
      t.status = 'in_progress';
    }

    if (!t.nextNudgeAt) {
      t.nextNudgeAt = Date.now() + (t.intervalMins || 1440) * 60000;
    }

    // Align tasks of the same chat + same interval that were created within 2 minutes of each other so they remind together!
    const syncKey = `${t.chatId}_${t.intervalMins}`;
    if (!chatIntervalSyncMap.has(syncKey)) {
      chatIntervalSyncMap.set(syncKey, t.nextNudgeAt);
    } else {
      const refTime = chatIntervalSyncMap.get(syncKey);
      if (Math.abs(t.nextNudgeAt - refTime) <= 5 * 60000) {
        t.nextNudgeAt = refTime;
      }
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
  const start = store.settings.quietStartHour; // 18 (6:00 PM IST)
  const end = store.settings.quietEndHour;     // 9  (9:00 AM IST)
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
const groupMetadataCache = new Map();
let sendQueuePromise = Promise.resolve();
let credsSaveQueue = Promise.resolve();

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

function buildGroupMentions(text, savedMentions = []) {
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

function sendWhatsAppMessage(rawJid, text, savedMentions = [], fallbackJid = null) {
  sendQueuePromise = sendQueuePromise
    .catch(() => {})
    .then(async () => {
      if (!sock || !isConnected) {
        console.log(`[Offline - Holding Message for ${rawJid}]`);
        return null;
      }

      let jid = normalizeJid(rawJid);
      const normFallback = normalizeJid(fallbackJid);

      if (jid && jid.endsWith('@lid') && normFallback && normFallback.endsWith('@s.whatsapp.net')) {
        jid = normFallback;
      }

      const isGroup = jid && jid.endsWith('@g.us');
      const groupMentions = isGroup ? buildGroupMentions(text, savedMentions) : [];
      const payload = isGroup && groupMentions.length > 0
        ? { text, mentions: groupMentions }
        : { text };

      try {
        if (!isGroup && typeof sock.assertSessions === 'function') {
          try {
            await withTimeout(sock.assertSessions([jid], false), 5000, 'assertSessions timeout');
          } catch (e) {}
        }

        const sent = await withTimeout(
          sock.sendMessage(jid, payload),
          20000,
          'sendMessage timed out after 20s'
        );

        if (sent && sent.key && sent.key.id) {
          const id = sent.key.id;
          sentByBotMessageIds.add(id);
          sentMessagesForRetry.set(id, sent.message || { conversation: text });

          if (sentByBotMessageIds.size > 1000) {
            const first = sentByBotMessageIds.values().next().value;
            sentByBotMessageIds.delete(first);
          }
          if (sentMessagesForRetry.size > 1000) {
            const firstKey = sentMessagesForRetry.keys().next().value;
            sentMessagesForRetry.delete(firstKey);
          }
        }
        await new Promise(r => setTimeout(r, 1500));
        return { sent: sent || { ok: true }, usedJid: jid };
      } catch (err) {
        console.error(`⚠️ Primary send error (${jid}):`, err.message);

        if (normFallback && normFallback !== jid && sock && isConnected) {
          try {
            console.log(`🔄 Retrying via fallback JID: ${normFallback}`);
            const sentFallback = await withTimeout(
              sock.sendMessage(normFallback, { text }),
              15000,
              'Fallback sendMessage timed out'
            );
            if (sentFallback && sentFallback.key && sentFallback.key.id) {
              const fId = sentFallback.key.id;
              sentByBotMessageIds.add(fId);
              sentMessagesForRetry.set(fId, sentFallback.message || { conversation: text });
            }
            await new Promise(r => setTimeout(r, 1500));
            return { sent: sentFallback || { ok: true }, usedJid: normFallback };
          } catch (err2) {
            console.error(`❌ Fallback send also failed (${normFallback}):`, err2.message);
          }
        }

        await new Promise(r => setTimeout(r, 1000));
        return null;
      }
    });
  return sendQueuePromise;
}

/**
 * Sends a COMBINED reminder for a list of tasks belonging to the same chat/employee!
 * - If 1 task is due: sends the clean single-task reminder format.
 * - If multiple tasks (e.g., #117 to #126) are due for the same chat: sends ONE single combined message listing all of them together!
 */
async function triggerBatchReminder(tasksList, isManual = false) {
  if (!Array.isArray(tasksList) || tasksList.length === 0) return false;

  const now = Date.now();
  const firstTask = tasksList[0];
  firstTask.chatId = normalizeJid(firstTask.chatId);
  firstTask.altChatId = normalizeJid(firstTask.altChatId);

  if (firstTask.chatId && firstTask.chatId.endsWith('@lid') && firstTask.altChatId && firstTask.altChatId.endsWith('@s.whatsapp.net')) {
    const tmp = firstTask.chatId;
    firstTask.chatId = firstTask.altChatId;
    firstTask.altChatId = tmp;
  }

  let messageText = '';
  const allMentions = [];
  for (const t of tasksList) {
    if (Array.isArray(t.mentions)) allMentions.push(...t.mentions);
  }

  if (tasksList.length === 1) {
    const task = tasksList[0];
    const headerPrefix = isManual ? '🔔 *MANUAL REMINDER' : '⏰ *TASK REMINDER';
    if (task.status === 'pending_approval') {
      messageText = `🔔 *PENDING BOSS APPROVAL (#${task.id})*\n\n📌 *Task:* ${task.title}\nयह काम पूरा रिपोर्ट किया गया है। रिमाइंडर बंद करने के लिए *"Approve #${task.id}"* लिखें।`;
    } else {
      messageText = `${headerPrefix} (#${task.id})*\n\n📌 *Task:* ${task.title}\n📈 *Current Progress:* ${task.progress}% पूरा हुआ (${100 - task.progress}% बाकी है)\n📝 *Last Note:* ${task.lastNote || 'कोई अपडेट नहीं'}\n\nकृपया इस मैसेज पर Reply करें या लिखें: *"#${task.id} 40% हो गया"*`;
    }
  } else {
    // COMBINED SINGLE REMINDER FOR MULTIPLE TASKS!
    const headerTitle = isManual
      ? `🔔 *MANUAL REMINDER (${tasksList.length} Pending Tasks)*`
      : `⏰ *TASK REMINDER (${tasksList.length} Pending Tasks)*`;

    const lines = tasksList.map(t => {
      const statusTag = t.status === 'pending_approval'
        ? '✅ *100% (Needs Boss Approval)*'
        : `📈 *${t.progress}% पूरा* (${100 - t.progress}% बाकी)`;
      const noteStr = t.lastNote && t.lastNote !== 'Assigned' && t.lastNote !== 'Assigned from Dashboard'
        ? ` | 📝 _"${t.lastNote}"_`
        : '';
      return `🔹 *#${t.id}:* ${t.title}\n   └ ${statusTag}${noteStr}`;
    }).join('\n\n');

    const ex1 = tasksList[0].id;
    const ex2 = tasksList[1].id;
    messageText = `${headerTitle}\n\n${lines}\n\n💡 *एक साथ या अलग-अलग अपडेट ऐसे दें:*\n• *"#${ex1} 50% #${ex2} 100%"*\n• या किसी एक का: *"#${ex1} 40% हो गया"*`;
  }

  const sentResult = await sendWhatsAppMessage(
    firstTask.chatId,
    messageText,
    allMentions,
    firstTask.altChatId
  );

  if (sentResult) {
    const finishNow = Date.now();
    for (const t of tasksList) {
      t.lastNudgeAt = finishNow;
      t.nextNudgeAt = finishNow + (t.intervalMins || 1440) * 60000;
      t.lastSendError = null;
    }
    saveStore();
    console.log(`✅ Sent combined reminder for ${tasksList.length} task(s) [${tasksList.map(t => '#' + t.id).join(', ')}] to ${sentResult.usedJid}`);
    return true;
  } else {
    for (const t of tasksList) {
      t.lastSendError = isConnected ? `Retry in 30s (${formatISTTime(now)})` : 'Waiting for WhatsApp connection';
    }
    saveStore();
    return false;
  }
}

// Keep single-task wrapper for compatibility
async function triggerTaskReminder(task, isManual = false) {
  return triggerBatchReminder([task], isManual);
}

/**
 * Check and dispatch any due reminders (Strictly runs only between 9:00 AM and 6:00 PM IST)
 * GROUPS all due tasks by `chatId` so an employee with 10 tasks gets ONE combined reminder message instead of 10 separate messages!
 */
async function checkAndSendDueReminders() {
  if (isCheckingReminders) return;
  if (!sock || !isConnected) return;
  if (isQuietHours()) return; // Strictly pause automatic reminders between 6:00 PM and 9:00 AM IST

  isCheckingReminders = true;
  try {
    const now = Date.now();
    // Look ahead by 60 seconds when grouping so tasks created in the same batch (even if 10s apart) always get grouped together!
    const dueTasks = store.tasks.filter(
      t => t.status !== 'completed' && (!t.nextNudgeAt || t.nextNudgeAt <= now)
    );

    if (dueTasks.length === 0) return;

    // Group due tasks by normalized chatId (and include any sibling active tasks of the same chat & interval that are due within the next 2 minutes)
    const groupedByChat = new Map();
    const includedTaskIds = new Set();

    for (const task of dueTasks) {
      const normChatId = normalizeJid(task.chatId);
      if (!groupedByChat.has(normChatId)) {
        groupedByChat.set(normChatId, []);
      }
      if (!includedTaskIds.has(task.id)) {
        groupedByChat.get(normChatId).push(task);
        includedTaskIds.add(task.id);
      }

      // Also pull in any sibling tasks of the same chat + same interval whose timer is due within the next 2 minutes so a batch never splits!
      const siblings = store.tasks.filter(
        s =>
          s.status !== 'completed' &&
          !includedTaskIds.has(s.id) &&
          normalizeJid(s.chatId) === normChatId &&
          s.intervalMins === task.intervalMins &&
          s.nextNudgeAt &&
          s.nextNudgeAt <= now + 120000
      );
      for (const sib of siblings) {
        groupedByChat.get(normChatId).push(sib);
        includedTaskIds.add(sib.id);
      }
    }

    for (const [, chatTasks] of groupedByChat.entries()) {
      if (isQuietHours() || !isConnected) break;
      // Sort by task ID ascending (#117, #118, #119...)
      chatTasks.sort((a, b) => a.id - b.id);
      await triggerBatchReminder(chatTasks, false);
    }
  } catch (e) {
    console.error('Error in checkAndSendDueReminders:', e.message);
  } finally {
    isCheckingReminders = false;
  }
}

// Middleware to auto-detect Render URL & trigger due reminders on every incoming HTTP / Cron request
app.use((req, res, next) => {
  if (!detectedSelfUrl && req.headers.host && !req.headers.host.includes('localhost')) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    detectedSelfUrl = `${proto}://${req.headers.host}`;
    console.log('🌐 Auto-detected Keep-Alive URL:', detectedSelfUrl);
  }
  checkAndSendDueReminders().catch(() => {});
  next();
});

function cleanTaskText(rawText) {
  return rawText
    .replace(/^(?:task|टास्क)\s*:\s*/i, '')
    .replace(/\[(\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))\]/gi, '')
    .trim();
}

// Default interval is now 1440 minutes (24 Hours) when no interval tag is provided in WhatsApp!
function parseIntervalMinutes(rawText, defaultMins = 1440) {
  const m = rawText.match(/\[(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\]/i);
  if (m) {
    const val = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('m')) return Math.max(5, val);
    if (unit.startsWith('h')) return val * 60;
    if (unit.startsWith('d')) return val * 1440;
  }

  const nat = rawText.match(/(?:every|har|हर)\s*(\d+)\s*(m|min|mins|minute|minutes|मिनट|h|hr|hrs|hour|hours|घंटे|घंटा|d|day|days|दिन)/i);
  if (nat) {
    const val = parseInt(nat[1], 10);
    const unit = nat[2].toLowerCase();
    if (unit.startsWith('m') || unit.includes('मिनट')) return Math.max(5, val);
    if (unit.startsWith('h') || unit.includes('घंट')) return val * 60;
    if (unit.startsWith('d') || unit.includes('दिन')) return val * 1440;
  }

  return defaultMins;
}

function extractMultipleTasks(rawBody) {
  const bodyAfterPrefix = rawBody
    .replace(/^(?:task|टास्क)\s*:\s*/i, '')
    .replace(/\[(\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))\]/gi, '')
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
 * Parse a single segment for one task (used by both single reply and multi-task bulk reply)
 */
function classifyTaskUpdateSegment(segmentText, targetTaskId) {
  const raw = (segmentText || '').trim();
  const lower = raw.toLowerCase();

  const textWithoutIdsAndMentions = lower
    .replace(/@\d{10,18}\b/g, '')
    .replace(/(?:#|task\s*)\d+/gi, '');
  const pctMatch = textWithoutIdsAndMentions.match(/\b(\d{1,3})\s*(?:%|percent|prcnt|प्रतिशत|फीसदी)/i);

  if (pctMatch) {
    const pct = Math.min(100, Math.max(0, parseInt(pctMatch[1], 10)));
    if (pct < 100) {
      return { type: 'progress_update', targetId: targetTaskId, progress: pct, note: raw };
    } else {
      return { type: 'employee_claim_done', targetId: targetTaskId, progress: 100, note: raw };
    }
  }

  const isNotDone = /\b(poora nahi|pura nahi|nahi hua|nhi hua|abhi nahi|pending hai|baaki hai|baki hai)\b|पूरा नहीं|नहीं हुआ|बाकी है/i.test(lower);
  if (isNotDone || /\b(delay|late|time lagega|kal|parson|ruk|atka|blocked|stuck|wait|baaki|baki|chalu hai|chal raha|kar raha|kr raha|working)\b|डिले|देरी|कल|चल रहा|कर रहा/i.test(lower)) {
    return { type: 'delay_or_note', targetId: targetTaskId, reopenFrom100: isNotDone, note: raw };
  }

  if (/\b(aadha|adha|half)\b|आधा/i.test(lower)) {
    return { type: 'progress_update', targetId: targetTaskId, progress: 50, note: raw };
  }

  if (/\b(thoda|shuru|started)\b|थोड़ा|शुरू/i.test(lower)) {
    return { type: 'progress_update', targetId: targetTaskId, progress: 20, note: raw };
  }

  if (/\b(done|completed|complete|ho gaya|hogaya|ho gya|khatam|poora ho gaya)\b|हो गया|पूरा हो गया|खत्म/i.test(lower)) {
    return { type: 'employee_claim_done', targetId: targetTaskId, progress: 100, note: raw };
  }

  return { type: 'general_qa_note', targetId: targetTaskId, note: raw };
}

/**
 * STRICT REPLY PARSER (v3.3 - Supports Single OR Multi-Task Bulk Replies!)
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
    lower.includes('note recorded') ||
    lower.includes('combined task update')
  ) {
    return { ignore: true };
  }

  // 2. Boss/Manager Approval ("Approve #101", "Approve #117 #118", "Close #101", "Approve all")
  if (/^(?:approve|close|final\s*done)\b/i.test(lower)) {
    if (/\ball\b/i.test(lower)) {
      return { ignore: false, type: 'manager_approve', targetId: 'all' };
    }
    const ids = Array.from(lower.matchAll(/(?:#|task\s*)?(\d{3,4})\b/g)).map(m => parseInt(m[1], 10));
    if (ids.length > 0) {
      return { ignore: false, type: 'manager_approve_multi', targetIds: ids };
    }
  }

  // 3. Check if the message mentions MULTIPLE explicit task IDs (e.g. "#117 50% #118 80%")
  const explicitMatches = Array.from(raw.matchAll(/(?:#|task\s*)(\d{3,4})\b/gi));
  const validExplicitMatches = explicitMatches.filter(m => {
    const idNum = parseInt(m[1], 10);
    return allActiveTasks.some(t => t.id === idNum);
  });

  if (validExplicitMatches.length > 1) {
    const updates = [];
    for (let i = 0; i < validExplicitMatches.length; i++) {
      const currentMatch = validExplicitMatches[i];
      const idNum = parseInt(currentMatch[1], 10);
      const startIdx = currentMatch.index;
      const endIdx = i + 1 < validExplicitMatches.length ? validExplicitMatches[i + 1].index : raw.length;
      const segment = raw.slice(startIdx, endIdx).trim();
      updates.push(classifyTaskUpdateSegment(segment, idNum));
    }
    return { ignore: false, type: 'multi_task_update', updates };
  }

  // 4. Single explicit Task ID (#101) OR quoted Bot message with (#101)
  let targetTaskId = null;
  let isExplicitlyTargeted = false;

  if (validExplicitMatches.length === 1) {
    targetTaskId = parseInt(validExplicitMatches[0][1], 10);
    isExplicitlyTargeted = true;
  }

  if (!targetTaskId && quotedText) {
    const allQuotedIds = Array.from(quotedText.matchAll(/#(\d{3,4})\b/g))
      .map(m => parseInt(m[1], 10))
      .filter(idNum => allActiveTasks.some(t => t.id === idNum));
    const uniqueQuotedIds = Array.from(new Set(allQuotedIds));

    if (uniqueQuotedIds.length === 1) {
      targetTaskId = uniqueQuotedIds[0];
      isExplicitlyTargeted = true;
    } else if (uniqueQuotedIds.length > 1) {
      const textWithoutIds = lower.replace(/@\d{10,18}\b/g, '');
      const pctMatch = textWithoutIds.match(/\b(\d{1,3})\s*(?:%|percent|prcnt|प्रतिशत|फीसदी)/i);
      if (/\b(all|sab|saare|सारे|सब)\b/i.test(lower) && (pctMatch || /\b(done|ho gaya|complete)\b/i.test(lower))) {
        const updates = uniqueQuotedIds.map(idNum => classifyTaskUpdateSegment(raw, idNum));
        return { ignore: false, type: 'multi_task_update', updates };
      }
      return {
        ignore: false,
        type: 'clarify_which_task',
        candidateIds: uniqueQuotedIds,
        note: raw
      };
    }
  }

  const textWithoutIdsAndMentions = lower
    .replace(/@\d{10,18}\b/g, '')
    .replace(/(?:#|task\s*)\d+/gi, '');
  const pctMatch = textWithoutIdsAndMentions.match(/\b(\d{1,3})\s*(?:%|percent|prcnt|प्रतिशत|फीसदी)/i);

  if (!isExplicitlyTargeted) {
    if (chatMatchedTasks.length === 1 && pctMatch && raw.length <= 45) {
      targetTaskId = chatMatchedTasks[0].id;
    } else if (chatMatchedTasks.length > 1 && pctMatch && raw.length <= 45) {
      return {
        ignore: false,
        type: 'clarify_which_task',
        candidateIds: chatMatchedTasks.map(t => t.id),
        note: raw
      };
    } else {
      return { ignore: true };
    }
  }

  const singleResult = classifyTaskUpdateSegment(raw, targetTaskId);
  return { ignore: false, ...singleResult };
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
    return isConnected ? '⚡ Sending now...' : '⏳ Waiting for WhatsApp Link';
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

    const authConfig = typeof makeCacheableSignalKeyStore === 'function'
      ? {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentLogger)
        }
      : state;

    sock = makeWASocket({
      version,
      auth: authConfig,
      logger: silentLogger,
      printQRInTerminal: true,
      browser: Browsers && Browsers.ubuntu ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 350,
      maxMsgRetryCount: 5,
      cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
      getMessage: async (key) => {
        if (key && key.id && sentMessagesForRetry.has(key.id)) {
          return sentMessagesForRetry.get(key.id);
        }
        return { conversation: '⏰ Task Reminder Check-in (Please reply with your task #ID and % progress)' };
      }
    });

    sock.ev.on('creds.update', () => {
      credsSaveQueue = credsSaveQueue
        .catch(() => {})
        .then(() => saveCreds())
        .catch(err => console.error('saveCreds error:', err.message));
    });

    sock.ev.on('groups.update', (updates) => {
      for (const u of updates) {
        if (u.id) groupMetadataCache.set(u.id, u);
      }
    });

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
        botOwnJid = normalizeJid(sock.user?.id);
        console.log('✅ WhatsApp Connected as:', botOwnJid);

        for (const t of store.tasks) {
          if (t.status !== 'completed') t.lastSendError = null;
        }
        saveStore();

        setTimeout(() => {
          checkAndSendDueReminders().catch(() => {});
        }, 4000);
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Connection closed (code: ${statusCode}).`);

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          console.log('🔒 Device logged out from phone. Clearing auth session for fresh QR.');
          clearAuthFolder();
          currentQR = null;
          currentPairingCode = null;
          reconnectTimer = setTimeout(startWhatsApp, 3000);
        } else {
          console.log('🔄 Reconnecting using existing saved session (no QR needed)...');
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

        const rawRemoteJid = normalizeJid(msg.key.remoteJid);
        if (!rawRemoteJid || rawRemoteJid === 'status@broadcast') continue;

        const { primaryChatId, altChatId } = resolveCanonicalChatIds(msg);
        const replyTargetJid = primaryChatId || rawRemoteJid;

        let storeUpdatedByLidMap = false;
        for (const t of store.tasks) {
          if (t.status !== 'completed' && t.chatId && t.chatId.endsWith('@lid')) {
            const normChat = normalizeJid(t.chatId);
            if (normChat && normChat.endsWith('@s.whatsapp.net')) {
              t.altChatId = t.chatId;
              t.chatId = normChat;
              t.chatIdLocked = true;
              storeUpdatedByLidMap = true;
            }
          }
        }
        if (storeUpdatedByLidMap) saveStore();

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
        // Default reminder interval is now 1440 mins (24 Hours)!
        if (/^(?:task|टास्क)\s*:/i.test(trimmed)) {
          const intervalMins = parseIntervalMinutes(trimmed, 1440);
          const subTaskStrings = extractMultipleTasks(trimmed);
          const isGroupChat = replyTargetJid.endsWith('@g.us');

          if (isGroupChat && sock.groupMetadata && !groupMetadataCache.has(replyTargetJid)) {
            try {
              const meta = await sock.groupMetadata(replyTargetJid);
              if (meta) groupMetadataCache.set(replyTargetJid, meta);
            } catch (e) {}
          }

          const batchNow = Date.now();
          const sharedNextNudgeAt = batchNow + intervalMins * 60000;
          const batchId = `batch_${batchNow}`;
          const createdTasks = [];

          for (const taskTitle of subTaskStrings) {
            const phoneFromText = !isGroupChat ? extractPhoneJidFromText(taskTitle) : null;
            const finalChatId = phoneFromText || replyTargetJid;
            const groupMentions = isGroupChat ? buildGroupMentions(taskTitle, mentionedJids) : [];

            const newTask = {
              id: store.nextId++,
              batchId,
              chatId: finalChatId,
              chatIdLocked: finalChatId.endsWith('@s.whatsapp.net') || finalChatId.endsWith('@g.us'),
              altChatId: altChatId && altChatId !== finalChatId ? altChatId : rawRemoteJid,
              title: taskTitle,
              mentions: groupMentions,
              assignee: 'Team',
              progress: 0,
              status: 'in_progress',
              intervalMins,
              lastNudgeAt: batchNow,
              nextNudgeAt: sharedNextNudgeAt, // Exact same timestamp so their reminders always go together in ONE combined message!
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
              t.chatId,
              `📋 *NEW TASK ASSIGNED (#${t.id})*\n\n📌 *Task:* ${t.title}\n⏰ *Auto-Reminder:* ${formatIntervalLabel(t.intervalMins)} (9 AM - 6 PM)\n\n💡 _Update देने के लिए इस मैसेज पर Reply करें या लिखें: "#${t.id} 25% हो गया"_\n🔒 _काम पूरा होने पर बॉस "Approve #${t.id}" लिखकर बंद करेंगे।_`,
              t.mentions,
              t.altChatId
            );
          } else {
            const listStr = createdTasks
              .map(t => `🔹 *#${t.id}:* ${t.title} (0% पूरा हुआ)`)
              .join('\n');
            await sendWhatsAppMessage(
              createdTasks[0].chatId,
              `📋 *MULTIPLE TASKS ASSIGNED (${createdTasks.length} Tasks)*\n\n${listStr}\n\n⏰ *Auto-Reminder:* ${formatIntervalLabel(intervalMins)} (9 AM - 6 PM) — _सभी का एक साथ एक ही मैसेज में रिमाइंडर आएगा!_\n\n💡 _एक साथ या अलग-अलग अपडेट ऐसे दें:_\n_• "#${createdTasks[0].id} 50% #${createdTasks[1].id} 100%"_\n_• या "#${createdTasks[0].id} 50% हो गया"_`,
              isGroupChat ? mentionedJids : [],
              altChatId
            );
          }
          continue;
        }

        // B. Strict check for active tasks
        const allActiveTasks = store.tasks.filter(t => t.status !== 'completed');
        if (allActiveTasks.length === 0) continue;

        const chatMatchedTasks = allActiveTasks.filter(
          t =>
            t.chatId === replyTargetJid ||
            t.chatId === rawRemoteJid ||
            t.altChatId === replyTargetJid ||
            t.altChatId === rawRemoteJid ||
            (altChatId && (t.chatId === altChatId || t.altChatId === altChatId))
        );

        const parsed = parseIncomingReply(
          trimmed,
          quotedText,
          chatMatchedTasks,
          allActiveTasks
        );
        if (parsed.ignore) continue;

        // Handle Boss Approval ("Approve #101", "Approve #117 #118", "Approve all")
        if (parsed.type === 'manager_approve') {
          if (chatMatchedTasks.length === 0) continue;
          chatMatchedTasks.forEach(t => {
            t.status = 'completed';
            t.progress = 100;
          });
          saveStore();
          await sendWhatsAppMessage(
            replyTargetJid,
            `✅ *ALL TASKS APPROVED & CLOSED*\n\nइस चैट के सभी ${chatMatchedTasks.length} टास्क बॉस द्वारा Complete मार्क कर दिए गए हैं। ऑटोमैटिक रिमाइंडर बंद हो गए हैं।`
          );
          continue;
        }

        if (parsed.type === 'manager_approve_multi') {
          const approvedList = [];
          for (const idNum of parsed.targetIds) {
            const t = allActiveTasks.find(x => x.id === idNum);
            if (t) {
              t.status = 'completed';
              t.progress = 100;
              approvedList.push(t);
            }
          }
          if (approvedList.length > 0) {
            saveStore();
            if (approvedList.length === 1) {
              const task = approvedList[0];
              await sendWhatsAppMessage(
                task.chatId,
                `✅ *TASK COMPLETED & APPROVED (#${task.id})*\n\n📌 "${task.title}" को Complete कर दिया गया है। अब इसके रिमाइंडर बंद हो गए हैं।`,
                task.mentions,
                task.altChatId
              );
            } else {
              const lines = approvedList.map(t => `✅ *#${t.id}:* ${t.title}`).join('\n');
              await sendWhatsAppMessage(
                approvedList[0].chatId,
                `✅ *${approvedList.length} TASKS APPROVED & CLOSED*\n\n${lines}\n\nइन टास्क के रिमाइंडर अब बंद हो गए हैं।`,
                approvedList[0].mentions,
                approvedList[0].altChatId
              );
            }
          }
          continue;
        }

        // If employee replied "25% ho gaya" without #ID when multiple tasks are active in the chat
        if (parsed.type === 'clarify_which_task') {
          const idExamples = parsed.candidateIds.slice(0, 3).map(id => `#${id}`).join(', ');
          await sendWhatsAppMessage(
            replyTargetJid,
            `❓ *कृपया Task #ID साथ में लिखें*\n\nइस चैट में एक से ज़्यादा टास्क चल रहे हैं (${idExamples}...)।\nकृपया टास्क नंबर के साथ रिप्लाई करें, जैसे:\n• *"#${parsed.candidateIds[0]} ${parsed.note}"*\n• या एक साथ कई टास्क: *"#${parsed.candidateIds[0]} 50% #${parsed.candidateIds[1] || parsed.candidateIds[0]} 100%"*`
          );
          continue;
        }

        // Handle Multi-Task Bulk Update in a single message (e.g. "#117 50% #118 done")
        if (parsed.type === 'multi_task_update') {
          const updatedSummaryLines = [];
          let targetChatForReply = replyTargetJid;
          let targetAltForReply = altChatId;

          for (const upd of parsed.updates) {
            const task = allActiveTasks.find(t => t.id === upd.targetId);
            if (!task) continue;
            targetChatForReply = task.chatId;
            targetAltForReply = task.altChatId;

            if (upd.type === 'progress_update') {
              task.progress = upd.progress;
              task.lastNote = upd.note;
              task.status = 'in_progress';
              updatedSummaryLines.push(`📊 *#${task.id}:* ${task.title} ➔ *${task.progress}% पूरा*`);
            } else if (upd.type === 'employee_claim_done') {
              task.progress = 100;
              task.lastNote = upd.note;
              task.status = store.settings.requireManagerApproval ? 'pending_approval' : 'completed';
              updatedSummaryLines.push(
                store.settings.requireManagerApproval
                  ? `🔔 *#${task.id}:* ${task.title} ➔ *100% (Pending Boss Approval)*`
                  : `✅ *#${task.id}:* ${task.title} ➔ *Completed*`
              );
            } else if (upd.type === 'delay_or_note') {
              task.lastNote = upd.note;
              if (task.status === 'pending_approval' || upd.reopenFrom100) {
                task.status = 'in_progress';
                if (task.progress >= 100) task.progress = 90;
              }
              updatedSummaryLines.push(`⚠️ *#${task.id}:* ${task.title} ➔ Note: "${upd.note}" (${task.progress}%)`);
            } else {
              task.lastNote = upd.note;
              updatedSummaryLines.push(`📝 *#${task.id}:* ${task.title} ➔ "${upd.note}" (${task.progress}%)`);
            }
          }

          if (updatedSummaryLines.length > 0) {
            saveStore();
            await sendWhatsAppMessage(
              targetChatForReply,
              `📊 *COMBINED TASK UPDATE RECORDED (${updatedSummaryLines.length} Tasks)*\n\n${updatedSummaryLines.join('\n')}\n\n⏰ _बाकी पेंडिंग टास्क का रिमाइंडर तय समय पर एक साथ आएगा।_`,
              [],
              targetAltForReply
            );
          }
          continue;
        }

        // Handle Single Task Update
        const task = allActiveTasks.find(t => t.id === parsed.targetId);
        if (!task) continue;

        if (!task.chatIdLocked && task.chatId.endsWith('@lid') && replyTargetJid.endsWith('@s.whatsapp.net') && replyTargetJid !== botOwnJid) {
          task.altChatId = task.chatId;
          task.chatId = replyTargetJid;
          task.chatIdLocked = true;
        } else if (rawRemoteJid && task.chatId !== rawRemoteJid && !task.altChatId && rawRemoteJid !== botOwnJid) {
          task.altChatId = rawRemoteJid;
        }

        // Keep nextNudgeAt synced with sibling tasks in the same chat & interval
        const siblingTasks = allActiveTasks.filter(
          s => s.id !== task.id && normalizeJid(s.chatId) === normalizeJid(task.chatId) && s.intervalMins === task.intervalMins
        );
        const syncedNextNudge = siblingTasks.length > 0 && siblingTasks[0].nextNudgeAt > Date.now()
          ? siblingTasks[0].nextNudgeAt
          : Date.now() + task.intervalMins * 60000;

        if (parsed.type === 'progress_update') {
          task.progress = parsed.progress;
          task.lastNote = parsed.note;
          task.status = 'in_progress';
          task.nextNudgeAt = syncedNextNudge;
          saveStore();

          await sendWhatsAppMessage(
            task.chatId,
            `📊 *TASK UPDATE RECORDED (#${task.id})*\n\n📌 *Task:* ${task.title}\n📈 *Progress:* ${task.progress}% पूरा हुआ (${100 - task.progress}% बाकी है)\n⏰ *Next Reminder:* ${formatIntervalLabel(task.intervalMins)} (9 AM - 6 PM)`,
            task.mentions,
            task.altChatId
          );
        } else if (parsed.type === 'delay_or_note') {
          task.lastNote = parsed.note;
          if (task.status === 'pending_approval' || parsed.reopenFrom100) {
            task.status = 'in_progress';
            if (task.progress >= 100) task.progress = 90;
          }
          task.nextNudgeAt = syncedNextNudge;
          saveStore();

          await sendWhatsAppMessage(
            task.chatId,
            `⚠️ *DELAY / STATUS NOTED (#${task.id})*\n\n📌 *Task:* ${task.title}\n📝 *Update:* "${parsed.note}"\n📈 *Current Progress:* ${task.progress}% पूरा हुआ\n⏰ _रिमाइंडर (9 AM - 6 PM) चालू रहेगा। कृपया साथ में काम का प्रतिशत भी बताएं।_`,
            task.mentions,
            task.altChatId
          );
        } else if (parsed.type === 'general_qa_note') {
          task.lastNote = parsed.note;
          saveStore();

          await sendWhatsAppMessage(
            task.chatId,
            `📝 *NOTE RECORDED (#${task.id})*\n\n📌 *Task:* ${task.title}\n💬 *Reply:* "${parsed.note}"\n📈 *Current Progress:* ${task.progress}% पूरा हुआ\n\n👉 _कृपया यह भी बताएं कि काम कितने प्रतिशत हुआ है (जैसे: "#${task.id} 25 percent ho gaya")।_`,
            task.mentions,
            task.altChatId
          );
        } else if (parsed.type === 'employee_claim_done') {
          task.progress = 100;
          task.lastNote = parsed.note;

          if (store.settings.requireManagerApproval) {
            task.status = 'pending_approval';
            task.nextNudgeAt = syncedNextNudge;
            saveStore();

            await sendWhatsAppMessage(
              task.chatId,
              `🔔 *APPROVAL NEEDED (#${task.id})*\n\n📌 *Task:* ${task.title}\nएम्प्लॉई ने लिखा है कि काम पूरा हो गया है ("${parsed.note}")।\n\n👉 *बॉस ध्यान दें:* रिमाइंडर बंद करने के लिए कृपया *"Approve #${task.id}"* या *"Close #${task.id}"* लिखें (या डैशबोर्ड से Approve दबाएं)।`,
              task.mentions,
              task.altChatId
            );
          } else {
            task.status = 'completed';
            saveStore();
            await sendWhatsAppMessage(
              task.chatId,
              `✅ *TASK COMPLETED (#${task.id})*\n\n📌 "${task.title}" पूरा हो गया है। रिमाइंडर बंद कर दिए गए हैं।`,
              task.mentions,
              task.altChatId
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

// Manual Remind Now endpoint for individual task
app.post('/api/remind/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = store.tasks.find(t => t.id === id && t.status !== 'completed');
  if (task) {
    await triggerBatchReminder([task], true);
  }
  res.redirect('/?reminded=' + id);
});

// Manual "Remind All Tasks of This Employee/Chat in 1 Message" endpoint
app.post('/api/remind-chat', async (req, res) => {
  const { chatId } = req.body;
  const normTarget = normalizeJid(chatId);
  const chatTasks = store.tasks.filter(
    t => t.status !== 'completed' && normalizeJid(t.chatId) === normTarget
  );
  if (chatTasks.length > 0) {
    chatTasks.sort((a, b) => a.id - b.id);
    await triggerBatchReminder(chatTasks, true);
  }
  res.redirect('/?reminded=all');
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

/**
 * Assign New Task(s) from Dashboard (v3.3):
 * - Default interval fallback is now 1440 mins (24 Hours).
 */
app.post('/api/assign', async (req, res) => {
  const { employeeName, phone, details, intervalMins } = req.body;
  if (!phone || !details) return res.redirect('/');

  const cleanPhone = phone.replace(/\D/g, '');
  const finalPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
  const jid = finalPhone.endsWith('@g.us') ? finalPhone : `${finalPhone}@s.whatsapp.net`;
  const mins = parseInt(intervalMins, 10) || 1440;

  const subTasks = extractMultipleTasks(details);
  const batchNow = Date.now();
  const sharedNextNudgeAt = batchNow + mins * 60000;
  const batchId = `batch_${batchNow}`;
  const createdTasks = [];

  for (const title of subTasks) {
    const newTask = {
      id: store.nextId++,
      batchId,
      chatId: jid,
      chatIdLocked: true,
      title: employeeName ? `@${employeeName} - ${title}` : title,
      mentions: [],
      assignee: employeeName || 'Employee',
      progress: 0,
      status: 'in_progress',
      intervalMins: mins,
      lastNudgeAt: batchNow,
      nextNudgeAt: sharedNextNudgeAt, // Exact same timestamp so reminders are always combined!
      lastNote: 'Assigned from Dashboard',
      createdAt: new Date().toISOString()
    };
    store.tasks.push(newTask);
    createdTasks.push(newTask);
  }
  saveStore();

  if (createdTasks.length === 1) {
    const newTask = createdTasks[0];
    await sendWhatsAppMessage(
      jid,
      `📋 *NEW TASK ASSIGNED (#${newTask.id})*\n\n👤 *Assignee:* ${newTask.assignee}\n📌 *Task:* ${newTask.title}\n⏰ *Auto-Reminder:* ${formatIntervalLabel(mins)} (9 AM - 6 PM)\n\n💡 _अपडेट देने के लिए इस मैसेज पर Reply करें या लिखें: "#${newTask.id} 25% हो गया"_`,
      []
    );
  } else if (createdTasks.length > 1) {
    const listStr = createdTasks
      .map(t => `🔹 *#${t.id}:* ${t.title} (0% पूरा हुआ)`)
      .join('\n');
    await sendWhatsAppMessage(
      jid,
      `📋 *MULTIPLE TASKS ASSIGNED (${createdTasks.length} Tasks)*\n👤 *Assignee:* ${employeeName || 'Employee'}\n\n${listStr}\n\n⏰ *Auto-Reminder:* ${formatIntervalLabel(mins)} (9 AM - 6 PM) — _सभी का रिमाइंडर एक साथ एक ही मैसेज में आएगा!_\n\n💡 _एक साथ या अलग-अलग अपडेट ऐसे दें:_\n_• "#${createdTasks[0].id} 50% #${createdTasks[1].id} 100%"_\n_• या "#${createdTasks[0].id} 25% हो गया"_`,
      []
    );
  }

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
      `✅ *TASK APPROVED & COMPLETED (#${task.id})*\n\n📌 "${task.title}" को डैशबोर्ड से Complete कर दिया गया है। अब इसके रिमाइंडर बंद हो गए हैं।`,
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
  const remindedParam = req.query.reminded || null;

  // Group active tasks by chatId so we can show a "🔔 Remind All Combined" button when an employee has multiple tasks
  const chatTaskCounts = {};
  for (const t of activeTasks) {
    const key = normalizeJid(t.chatId);
    chatTaskCounts[key] = (chatTaskCounts[key] || 0) + 1;
  }
  const multiTaskChats = Object.keys(chatTaskCounts).filter(k => chatTaskCounts[k] > 1);

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
  <title>WhatsTask Auto-Followup Bot v3.3</title>
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
    <h1>WhatsTask Auto-Followup Bot v3.3 (Final)</h1>
    <p style="color:#94a3b8; font-size:13px; margin:0;">Default 24h Reminder • Combined Multi-Task Reminders • 9 AM - 6 PM</p>
    <div id="statusBadgeContainer">
      ${isConnected
        ? '<span class="badge badge-ok">✅ WhatsApp Connected & Active</span>'
        : '<span class="badge badge-warn">📱 Link WhatsApp Below (QR or Phone Number)</span>'}
    </div>
    <p style="font-size:12px; color:#94a3b8; margin-top:10px; margin-bottom:0;">
      IST Time: <b>${timeStr}</b> | Auto-Schedule (9 AM - 6 PM): <b>${quietNow ? '🌙 Night DND (Paused 6PM-9AM)' : '☀️ Daytime Active (Sending Reminders)'}</b>
    </p>
  </div>

  ${remindedParam ? `
  <div class="card" style="padding:0; background:transparent; border:none;">
    <div class="toast">🔔 ${remindedParam === 'all' ? 'सभी पेंडिंग टास्क का एक संयुक्त (Combined) रिमाइंडर' : 'Task #' + remindedParam + ' का रिमाइंडर'} WhatsApp पर तुरंत भेज दिया गया है!</div>
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
    <h4 style="color:#4ade80; margin:0 0 8px;">💡 मल्टीपल टास्क और संयुक्त (Combined) रिमाइंडर कैसे काम करेगा?</h4>
    <p style="font-size:13px; color:#cbd5e1; margin:0 0 8px;">1. बिना समय लिखे सीधा <b>Task:</b> लिखने पर अब डिफ़ॉल्ट रूप से <b>24 Hours (Daily)</b> का रिमाइंडर सेट होगा। अगर कम समय चाहिए तो <b>[2h]</b> या <b>[15m]</b> लिख सकते हैं।</p>
    <pre style="background:#07120d; padding:10px; border-radius:8px; color:#4ade80; font-size:12px; white-space:pre-wrap;">#117 50% #118 100% #123 30%</pre>
    <p style="font-size:12px; color:#94a3b8; margin:8px 0 0;">
      2. एम्प्लॉई एक ही मैसेज में कई टास्क का अपडेट दे सकता है या किसी एक का (जैसे: <b>#123 40% हो गया</b>)।
    </p>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">Assign New Task (One or Multiple)</h3>
    <form method="POST" action="/api/assign">
      <input name="employeeName" placeholder="Employee Name (e.g. Ram Sir)" required />
      <input name="phone" placeholder="WhatsApp Number with 91 (e.g. 919876543210)" required />
      <textarea name="details" rows="4" placeholder="1. Raghu&#10;2. Park Hyatt&#10;3. Contractor payment" required></textarea>
      <select name="intervalMins">
        <option value="15">Remind every 15 Minutes (Daytime 9AM-6PM)</option>
        <option value="60">Remind every 1 Hour (Daytime 9AM-6PM)</option>
        <option value="120">Remind every 2 Hours (Daytime 9AM-6PM)</option>
        <option value="240">Remind every 4 Hours (Daytime 9AM-6PM)</option>
        <option value="1440" selected>Remind every 24 Hours (Daily 9AM-6PM)</option>
      </select>
      <button type="submit" class="btn">Send Combined on WhatsApp & Start Reminders</button>
    </form>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">Active Tasks (${activeTasks.length})</h3>
    ${multiTaskChats.map(chatKey => `
      <form method="POST" action="/api/remind-chat" style="margin-bottom:12px;">
        <input type="hidden" name="chatId" value="${chatKey}" />
        <button type="submit" style="width:100%; background:#f59e0b; color:#0f172a; border:none; padding:10px 14px; border-radius:10px; font-weight:800; cursor:pointer; font-size:13px;">
          🔔 Send 1 Combined Reminder for All ${chatTaskCounts[chatKey]} Tasks (${chatKey.split('@')[0]})
        </button>
      </form>
    `).join('')}
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
            <button type="submit" title="Send Single Reminder" style="background:#f59e0b; color:#0f172a; border:none; padding:8px 10px; border-radius:8px; font-weight:700; cursor:pointer; font-size:12px;">🔔 Remind</button>
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
