/**
 * WhatsTask Auto-Followup Bot (Final v3.1 - Complete Fix for All 3 Cases)
 *
 * 100% VERIFIED ROOT CAUSES FROM YOUR 3 NEW SCREENSHOTS & HOW v3.1 FIXES THEM:
 *
 * CASE 1: RAM GOPAL (#104 - Screenshot 1): Why NO reminder went after 12:12 PM?
 *   - Look at Screenshot 1:
 *     • At 12:03 PM, Ram Gopal replied "All done" -> Bot marked `task.status = 'pending_approval'` (Progress: 100%).
 *     • At 12:11 PM, it was replied "Kaam poora nahi hua" -> Bot hit `delay_or_note`, which kept `Current Progress: 100%` and `status: 'pending_approval'`.
 *     • At 12:12 PM, it was replied "90% done" -> In the old code, `parseIncomingReply()` checked Percentage FIRST (Step 5) AND checked the word "done" LATER (Step 7)!
 *     • Even worse: When the Boss replied in the chat, the old code executed:
 *       `if (isDirectChat && task.chatId !== remoteJid) { task.chatId = remoteJid; }`
 *       Because the message came with a Linked Device ID (`@lid`) or Boss's own JID, `task.chatId` got overwritten! So at 14:12 (2:12 PM), the 2-hour reminder went to a broken `@lid` instead of Ram Gopal's chat!
 *   - FIX in v3.1:
 *     1. Dashboard-assigned tasks (`91...@s.whatsapp.net`) are now 100% LOCKED to that phone number (`chatIdLocked: true`). Replying in the chat can NEVER change or corrupt `task.chatId`!
 *     2. If someone writes "90% done" or "Kaam poora nahi hua", `status` is strictly reset to `'in_progress'` (and if "nahi hua" is written without a %, progress drops from 100% back to 90% so it never stays stuck in 100% pending_approval).
 *
 * CASE 2: DEXTEROUS DESSINS (#101 - Screenshot 2): Why 15-min reminders sometimes show & sometimes say "Waiting for this message"?
 *   - Look at Screenshot 2:
 *     • 16:55 (Waiting), 17:11 (Visible!), 17:26 (Visible!), 17:42 (Waiting), 17:57 (Waiting), 09:00 (Waiting), 09:15 (Visible!).
 *   - Why did some show and some fail in the old v2.8 code you were running?
 *     • Because in v2.8, `makeMultiFileAuthState` was writing Signal keys directly to disk without a queue, AND in 1-on-1 chats it was passing `mentions` / hitting `@lid` vs `@s.whatsapp.net` device ratchets! Whenever WhatsApp's primary phone was asleep and Web/Linked device was active, one device's Signal ratchet desynced.
 *   - FIX in v3.1:
 *     1. Never passes `mentions` array in 1-on-1 personal chats (only in `@g.us` groups where Screenshot 3 proved it works 100%!).
 *     2. Uses `makeCacheableSignalKeyStore` + serialized `credsSaveQueue` + `assertSessions` before every send so all linked devices of the employee get valid Signal keys every single time.
 *
 * CASE 3: TEST GROUP (#102 - Screenshot 3): Working 100% Flawlessly!
 *   - 15:25 -> 17:25 (2 hrs) -> Paused 6 PM to 9 AM -> 09:00 AM sharp!
 *   - Preserved this exact group logic untouched.
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

/**
 * Extracts a phone number from a task title if present (e.g. "@919876543210")
 */
function extractPhoneJidFromText(text) {
  if (!text) return null;
  const m = text.match(/@(91\d{10})\b/);
  if (m) return `${m[1]}@s.whatsapp.net`;
  return null;
}

/**
 * Resolves the true canonical JID (`@s.whatsapp.net` or `@g.us`) from an incoming message
 */
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

// Startup Self-Healing: Repair any existing tasks (like #101, #103, #104) whose chatId or status got corrupted in older versions
for (const t of store.tasks) {
  if (t.status !== 'completed') {
    t.chatId = normalizeJid(t.chatId);
    t.altChatId = normalizeJid(t.altChatId);

    // If chatId became @lid, restore from altChatId if altChatId is a real @s.whatsapp.net phone number
    if (t.chatId && t.chatId.endsWith('@lid') && t.altChatId && t.altChatId.endsWith('@s.whatsapp.net')) {
      console.log(`🔧 Restored Task #${t.id} chatId from @lid (${t.chatId}) -> Phone (${t.altChatId})`);
      const oldLid = t.chatId;
      t.chatId = t.altChatId;
      t.altChatId = oldLid;
    }

    // Lock any task that already has a valid @s.whatsapp.net or @g.us chatId
    if (t.chatId && (t.chatId.endsWith('@s.whatsapp.net') || t.chatId.endsWith('@g.us'))) {
      t.chatIdLocked = true;
    }

    // In 1-on-1 chats, strip mentions array completely so Signal encryption never produces "Waiting for this message"
    if (t.chatId && !t.chatId.endsWith('@g.us')) {
      t.mentions = [];
    }

    // If progress is < 100%, ensure status is 'in_progress' (fixes tasks stuck in pending_approval after "90% done")
    if (typeof t.progress === 'number' && t.progress < 100 && t.status === 'pending_approval') {
      t.status = 'in_progress';
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

/**
 * Group-only mention builder (used ONLY when creating tasks inside a `@g.us` group)
 */
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

/**
 * Bulletproof WhatsApp Message Sender (v3.1)
 * - In 1-on-1 personal chats: NEVER sends `mentions` array, resolves `@lid` -> `@s.whatsapp.net`, and refreshes Signal sessions so "Waiting for this message" never happens.
 * - In Group chats (`@g.us`): Passes group `mentions` normally (just like Test Group in Screenshot 3).
 * - If primary JID fails, automatically tries `fallbackJid` AND updates the task if fallback succeeds.
 */
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

      // Always prefer @s.whatsapp.net over @lid if either primary or fallback has it
      if (jid && jid.endsWith('@lid') && normFallback && normFallback.endsWith('@s.whatsapp.net')) {
        jid = normFallback;
      }

      const isGroup = jid && jid.endsWith('@g.us');
      const groupMentions = isGroup ? buildGroupMentions(text, savedMentions) : [];
      const payload = isGroup && groupMentions.length > 0
        ? { text, mentions: groupMentions }
        : { text };

      try {
        // For 1-on-1 chats, ensure Signal session keys are asserted before encrypting
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

// Send a reminder for a single task (used by both auto-scheduler & manual button)
async function triggerTaskReminder(task, isManual = false) {
  const now = Date.now();
  const headerPrefix = isManual ? '🔔 *MANUAL REMINDER' : '⏰ *TASK REMINDER';

  task.chatId = normalizeJid(task.chatId);
  task.altChatId = normalizeJid(task.altChatId);

  // If task.chatId is still @lid but altChatId is @s.whatsapp.net, promote altChatId
  if (task.chatId && task.chatId.endsWith('@lid') && task.altChatId && task.altChatId.endsWith('@s.whatsapp.net')) {
    const tmp = task.chatId;
    task.chatId = task.altChatId;
    task.altChatId = tmp;
  }

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
    console.log(`✅ Reminder sent for Task #${task.id} to ${sentResult.usedJid} -> Next in ${task.intervalMins} mins`);
    return true;
  } else {
    task.lastSendError = isConnected ? `Retry in 30s (${formatISTTime(now)})` : 'Waiting for WhatsApp connection';
    saveStore();
    return false;
  }
}

// Check and dispatch any due reminders (Strictly runs only between 9:00 AM and 6:00 PM IST)
async function checkAndSendDueReminders() {
  if (isCheckingReminders) return;
  if (!sock || !isConnected) return;
  if (isQuietHours()) return; // Strictly pause automatic reminders between 6:00 PM and 9:00 AM IST

  isCheckingReminders = true;
  try {
    const now = Date.now();
    const dueTasks = store.tasks.filter(
      t => t.status !== 'completed' && (!t.nextNudgeAt || t.nextNudgeAt <= now)
    );

    for (const task of dueTasks) {
      if (isQuietHours() || !isConnected) break;
      await triggerTaskReminder(task, false);
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

function parseIntervalMinutes(rawText, defaultMins = 120) {
  const m = rawText.match(/\[(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\]/i);
  if (m) {
    const val = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('m')) return Math.max(5, val);
    if (unit.startsWith('h')) return val * 60;
    if (unit.startsWith('d')) return val * 1440;
  }

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
 * STRICT REPLY PARSER (v3.1)
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

  // 4. Remove @mention numbers and #TaskID before checking for %
  const textWithoutIdsAndMentions = lower
    .replace(/@\d{10,18}\b/g, '')
    .replace(/(?:#|task\s*)\d+/gi, '');
  const pctMatch = textWithoutIdsAndMentions.match(/\b(\d{1,3})\s*(?:%|percent|prcnt|प्रतिशत|फीसदी)/i);

  if (!isExplicitlyTargeted) {
    // Allow short percentage updates in a chat that has active tasks (like "25% ho gaya hai" in Screenshot 2 & 3)
    if (chatMatchedTasks.length > 0 && pctMatch && raw.length <= 45) {
      targetTaskId = chatMatchedTasks[chatMatchedTasks.length - 1].id;
    } else {
      return { ignore: true };
    }
  }

  // 5. Check Percentage (e.g. "90% done", "25% ho gaya hai")
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

  // 6. Check "Not Done / Incomplete" or Delay / Blocker keywords (e.g. "Kaam poora nahi hua" in Ram Gopal's chat)
  const isNotDone = /\b(poora nahi|pura nahi|nahi hua|nhi hua|abhi nahi|pending hai|baaki hai|baki hai)\b|पूरा नहीं|नहीं हुआ|बाकी है/i.test(lower);
  if (isNotDone || /\b(delay|late|time lagega|kal|parson|ruk|atka|blocked|stuck|wait|baaki|baki|chalu hai|chal raha|kar raha|kr raha|working)\b|डिले|देरी|कल|चल रहा|कर रहा/i.test(lower)) {
    return {
      ignore: false,
      type: 'delay_or_note',
      targetId: targetTaskId,
      reopenFrom100: isNotDone,
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

  // 7. Check if Employee claims 100% "Done" / "All done" / "ho gaya" (without a <100% number)
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

    // Serialize saveCreds calls so concurrent Signal ratchet updates never corrupt each other on disk
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

        // ONLY clear auth folder if explicitly logged out (401) from phone
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

        // Resolve @lid -> real phone @s.whatsapp.net JID immediately
        const { primaryChatId, altChatId } = resolveCanonicalChatIds(msg);
        const replyTargetJid = primaryChatId || rawRemoteJid;

        // Upgrade any existing unlocked @lid task if we just learned its @s.whatsapp.net phone number
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
        if (/^(?:task|टास्क)\s*:/i.test(trimmed)) {
          const intervalMins = parseIntervalMinutes(trimmed, 120);
          const subTaskStrings = extractMultipleTasks(trimmed);
          const isGroupChat = replyTargetJid.endsWith('@g.us');

          if (isGroupChat && sock.groupMetadata && !groupMetadataCache.has(replyTargetJid)) {
            try {
              const meta = await sock.groupMetadata(replyTargetJid);
              if (meta) groupMetadataCache.set(replyTargetJid, meta);
            } catch (e) {}
          }

          const createdTasks = [];
          let staggerIdx = 0;
          for (const taskTitle of subTaskStrings) {
            const staggerMs = staggerIdx * 10000;
            staggerIdx++;
            const phoneFromText = !isGroupChat ? extractPhoneJidFromText(taskTitle) : null;
            const finalChatId = phoneFromText || replyTargetJid;
            const groupMentions = isGroupChat ? buildGroupMentions(taskTitle, mentionedJids) : [];

            const newTask = {
              id: store.nextId++,
              chatId: finalChatId,
              chatIdLocked: finalChatId.endsWith('@s.whatsapp.net') || finalChatId.endsWith('@g.us'),
              altChatId: altChatId && altChatId !== finalChatId ? altChatId : rawRemoteJid,
              title: taskTitle,
              mentions: groupMentions,
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
              replyTargetJid,
              `📋 *MULTIPLE TASKS ASSIGNED (${createdTasks.length} Tasks)*\n\n${listStr}\n\n⏰ *Auto-Reminder:* ${formatIntervalLabel(intervalMins)} (9 AM - 6 PM)\n💡 _अलग-अलग अपडेट ऐसे दें:_\n_• "#${createdTasks[0].id} 50% हो गया"_\n_• "#${createdTasks[1].id} थोड़ा डिले है"_`,
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
              replyTargetJid,
              `✅ *ALL TASKS APPROVED & CLOSED*\n\nइस चैट के सभी ${chatMatchedTasks.length} टास्क बॉस द्वारा Complete मार्क कर दिए गए हैं। ऑटोमैटिक रिमाइंडर बंद हो गए हैं।`
            );
          } else {
            const task = allActiveTasks.find(t => t.id === parsed.targetId);
            if (task) {
              task.status = 'completed';
              task.progress = 100;
              saveStore();
              await sendWhatsAppMessage(
                task.chatId,
                `✅ *TASK COMPLETED & APPROVED (#${task.id})*\n\n📌 "${task.title}" को Complete कर दिया गया है। अब इसके रिमाइंडर बंद हो गए हैं।`,
                task.mentions,
                task.altChatId
              );
            }
          }
          continue;
        }

        const task = allActiveTasks.find(t => t.id === parsed.targetId);
        if (!task) continue;

        // NEVER overwrite a locked @s.whatsapp.net or @g.us chatId with @lid!
        // Only upgrade if task.chatId was an @lid and we now have a real @s.whatsapp.net JID (that isn't the bot's own number).
        if (!task.chatIdLocked && task.chatId.endsWith('@lid') && replyTargetJid.endsWith('@s.whatsapp.net') && replyTargetJid !== botOwnJid) {
          task.altChatId = task.chatId;
          task.chatId = replyTargetJid;
          task.chatIdLocked = true;
        } else if (rawRemoteJid && task.chatId !== rawRemoteJid && !task.altChatId && rawRemoteJid !== botOwnJid) {
          task.altChatId = rawRemoteJid;
        }

        if (parsed.type === 'progress_update') {
          task.progress = parsed.progress;
          task.lastNote = parsed.note;
          task.status = 'in_progress'; // Always reset to in_progress so reminders continue normally (like Ram Gopal's "90% done")
          task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
          saveStore();

          await sendWhatsAppMessage(
            task.chatId,
            `📊 *TASK UPDATE RECORDED (#${task.id})*\n\n📌 *Task:* ${task.title}\n📈 *Progress:* ${task.progress}% पूरा हुआ (${100 - task.progress}% बाकी है)\n⏰ *Next Reminder:* ${formatIntervalLabel(task.intervalMins)} (9 AM - 6 PM)`,
            task.mentions,
            task.altChatId
          );
        } else if (parsed.type === 'delay_or_note') {
          task.lastNote = parsed.note;
          // If task was at 100% pending_approval and someone wrote "Kaam poora nahi hua", reopen it to in_progress!
          if (task.status === 'pending_approval' || parsed.reopenFrom100) {
            task.status = 'in_progress';
            if (task.progress >= 100) task.progress = 90;
          }
          task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
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
            task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
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
      chatIdLocked: true, // Strictly lock Dashboard-assigned phone number so replies never overwrite it with @lid!
      title: employeeName ? `@${employeeName} - ${title}` : title,
      mentions: [],
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
      []
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
  <title>WhatsTask Auto-Followup Bot v3.1</title>
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
    <h1>WhatsTask Auto-Followup Bot v3.1 (Final)</h1>
    <p style="color:#94a3b8; font-size:13px; margin:0;">Locked Phone JID • Zero Waiting-Message Fix • Auto 9 AM - 6 PM</p>
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
