/**
 * WhatsTask Auto-Followup Bot (Upgraded v2.0)
 * Features:
 * 1. Night Quiet Hours (6:00 PM to 9:00 AM IST - No night disturbance)
 * 2. Multiple Tasks in a single message (1. Task A, 2. Task B, 3. Task C)
 * 3. Smart % Progress & Delay tracking (20%, 25%, "thoda delay hai")
 * 4. Boss/Manager Approval ("Close #101" / "Approve #101" or Dashboard button) - Employee can't prematurely stop reminders
 * 5. Loop Protection (Bot never replies to its own messages)
 * 6. 15m, 1h, 2h, 4h, and 24h (Daily same time) reminder options
 * 7. Auto-Reconnect & Self-Keep-Alive to prevent 6:00 AM disconnects
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Persistent File Store (Saves tasks & settings locally) ---
const DATA_FILE = path.join(__dirname, 'tasks_data.json');

let store = {
  nextId: 101,
  settings: {
    quietHoursEnabled: true,
    quietStartHour: 18, // 6:00 PM IST
    quietEndHour: 9,    // 9:00 AM IST
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
        store = { ...store, ...parsed };
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

// --- Helper: Get Current Hour in IST (Asia/Kolkata) ---
function getISTDate() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 5.5 * 3600000); // UTC + 5:30
}

function isQuietHours() {
  if (!store.settings.quietHoursEnabled) return false;
  const ist = getISTDate();
  const hour = ist.getHours();
  const start = store.settings.quietStartHour; // 18 (6 PM)
  const end = store.settings.quietEndHour;     // 9 (9 AM)

  if (start > end) {
    // Overnight window e.g. 18:00 to 09:00
    return hour >= start || hour < end;
  } else {
    return hour >= start && hour < end;
  }
}

// --- WhatsApp Connection State ---
let sock = null;
let currentQR = null;
let isConnected = false;
let botOwnJid = null;
const sentByBotMessageIds = new Set(); // Prevents infinite loops 100%

async function sendWhatsAppMessage(jid, text) {
  if (!sock || !isConnected) {
    console.log(`[Offline Queue -> ${jid}]: ${text}`);
    return null;
  }
  try {
    const sent = await sock.sendMessage(jid, { text });
    if (sent && sent.key && sent.key.id) {
      sentByBotMessageIds.add(sent.key.id);
      // Keep set bounded
      if (sentByBotMessageIds.size > 500) {
        const first = sentByBotMessageIds.values().next().value;
        sentByBotMessageIds.delete(first);
      }
    }
    return sent;
  } catch (err) {
    console.error('Failed to send WhatsApp message:', err.message);
    return null;
  }
}

// --- Clean WhatsApp internal @LID / @JID numbers in task text ---
function cleanTaskText(rawText) {
  return rawText
    .replace(/^task\s*:\s*/i, '')
    .replace(/\[(\d+(?:m|h|hr|hrs|d))\]/gi, '')
    .trim();
}

// --- Parse Interval Tag from Message (e.g. [15m], [1h], [2h], [4h], [24h]) ---
function parseIntervalMinutes(rawText, defaultMins = 120) {
  const m = rawText.match(/\[(\d+)\s*(m|min|mins|h|hr|hrs|d|day)\]/i);
  if (!m) return defaultMins;
  const val = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('m')) return Math.max(15, val);
  if (unit.startsWith('h')) return val * 60;
  if (unit.startsWith('d')) return val * 1440;
  return defaultMins;
}

// --- Split Multi-Task Message into Individual Tasks ---
function extractMultipleTasks(rawBody) {
  const bodyAfterPrefix = rawBody.replace(/^task\s*:\s*/i, '').trim();

  // Check if message has multiple lines or numbered list (1. ..., 2. ..., 3. ...)
  const lines = bodyAfterPrefix
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    // If first line is just an @mention or name (e.g. "@Rahul"), attach it to sub-lines
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

  // Also check inline numbered tasks: "1. send quote 2. call vendor 3. update sheet"
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

// --- Smart Update & Reply Parser ---
function parseIncomingReply(text, activeTasksInChat) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();

  // 1. HARD LOOP GUARD: Ignore Bot's own messages & system templates
  if (
    raw.startsWith('👍') ||
    raw.startsWith('📋') ||
    raw.startsWith('✅') ||
    raw.startsWith('⏰') ||
    raw.startsWith('📊') ||
    raw.startsWith('🔔') ||
    raw.startsWith('⚠️') ||
    raw.startsWith('🚨') ||
    lower.includes('update recorded') ||
    lower.includes('new task assigned') ||
    lower.includes('task completed') ||
    lower.includes('next check-in') ||
    lower.includes('auto-reminder:') ||
    lower.includes('approval needed')
  ) {
    return { ignore: true };
  }

  // 2. Check if Boss/Manager is Approving / Closing a task:
  // Examples: "Approve #101", "Close #101", "Final done #101", "Approve all"
  const approveMatch = lower.match(/^(?:approve|close|final\s*done|ok\s*done|band\s*karo)\s*(?:#|task\s*)?(\d+|all)?/i);
  if (approveMatch) {
    return {
      ignore: false,
      type: 'manager_approve',
      targetId: approveMatch[1] && approveMatch[1] !== 'all' ? parseInt(approveMatch[1], 10) : 'all'
    };
  }

  // 3. Extract explicit Task ID if mentioned (e.g. "#102 40%", "102 50% ho gaya")
  let targetTaskId = null;
  const idMatch = lower.match(/(?:#|task\s*)(\d{3,4})\b/i) || lower.match(/^(\d{3,4})\s*[:\-]/);
  if (idMatch) {
    targetTaskId = parseInt(idMatch[1], 10);
  } else if (activeTasksInChat.length === 1) {
    targetTaskId = activeTasksInChat[0].id;
  } else if (activeTasksInChat.length > 1) {
    // Default to most recently nudged or latest task in this chat
    targetTaskId = activeTasksInChat[activeTasksInChat.length - 1].id;
  }

  // 4. Check Percentage FIRST (e.g. "20%", "25 percent ho gaya", "30% काम हो गया")
  // Removes any "#101" first so task ID isn't confused with percentage
  const textWithoutTaskId = lower.replace(/(?:#|task\s*)\d+/gi, '');
  const pctMatch = textWithoutTaskId.match(/(\d{1,3})\s*(?:%|percent|prcnt|प्रतिशत|फीसदी)/i);
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

  // 5. Check Delay / Blocker / Partial keywords ("thoda delay hai", "kal hoga", "aadha hua", "abhi nahi hua")
  if (/\b(delay|late|time lagega|kal|parson|ruk|atka|blocked|stuck|wait|baaki|baki|nahi hua|nhi hua|chalu hai|chal raha)\b|डिले|देरी|कल|बाकी|नहीं हुआ|चल रहा/i.test(lower)) {
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

  // 6. Check if Employee claims "Done" / "ho gaya" (without any <100% number)
  if (/\b(done|completed|complete|ho gaya|hogaya|ho gya|khatam|poora ho gaya)\b|हो गया|पूरा हो गया|खत्म/i.test(lower)) {
    return {
      ignore: false,
      type: 'employee_claim_done',
      targetId: targetTaskId,
      progress: 100,
      note: raw
    };
  }

  return { ignore: true };
}

// --- Format Interval Label ---
function formatIntervalLabel(mins) {
  if (mins >= 1440 && mins % 1440 === 0) return `Every ${mins / 1440} Day(s) (24 Hours)`;
  if (mins >= 60 && mins % 60 === 0) return `Every ${mins / 60} Hour(s)`;
  return `Every ${mins} Mins`;
}

// --- Start Baileys WhatsApp Connection with Auto-Reconnect ---
async function startWhatsApp() {
  try {
    const authFolder = path.join(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ['WhatsTask Bot', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        isConnected = false;
        console.log('📲 New QR Code generated. Scan from dashboard.');
      }

      if (connection === 'open') {
        currentQR = null;
        isConnected = true;
        botOwnJid = sock.user?.id;
        console.log('✅ WhatsApp Connected as:', botOwnJid);
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(`⚠️ Connection closed (code: ${statusCode}). LoggedOut: ${loggedOut}`);

        if (loggedOut) {
          // Only delete auth folder if user explicitly clicked "Log out" from phone
          try {
            fs.rmSync(authFolder, { recursive: true, force: true });
          } catch (e) {}
          setTimeout(startWhatsApp, 3000);
        } else {
          // Transient network drop at 6:00 AM -> Reconnect automatically WITHOUT wiping session!
          setTimeout(startWhatsApp, 4000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const msgId = msg.key.id;
        // Skip if this exact message was sent by our bot!
        if (sentByBotMessageIds.has(msgId)) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        if (!text || !text.trim()) continue;
        const trimmed = text.trim();

        // A. Check if creating new task(s): starts with "Task:" or "टास्क:"
        if (/^(?:task|टास्क)\s*:/i.test(trimmed)) {
          const intervalMins = parseIntervalMinutes(trimmed, 120); // Default 2 hours
          const subTaskStrings = extractMultipleTasks(trimmed);

          const createdTasks = [];
          for (const taskTitle of subTaskStrings) {
            const newTask = {
              id: store.nextId++,
              chatId: remoteJid,
              title: taskTitle,
              assignee: 'Team',
              progress: 0,
              status: 'in_progress', // 'in_progress' | 'pending_approval' | 'completed'
              intervalMins,
              lastNudgeAt: Date.now(),
              nextNudgeAt: Date.now() + intervalMins * 60000,
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
              `📋 *NEW TASK ASSIGNED (#${t.id})*\n\n📌 *Task:* ${t.title}\n⏰ *Auto-Reminder:* ${formatIntervalLabel(t.intervalMins)} (9 AM - 6 PM)\n\n💡 _Update देने के लिए लिखें: "#${t.id} 25% हो गया" या "#${t.id} थोड़ा डिले है"_\n🔒 _काम पूरा होने पर बॉस "Approve #${t.id}" लिखकर बंद करेंगे।_`
            );
          } else {
            const listStr = createdTasks
              .map(t => `🔹 *#${t.id}:* ${t.title} (0%)`)
              .join('\n');
            await sendWhatsAppMessage(
              remoteJid,
              `📋 *MULTIPLE TASKS ASSIGNED (${createdTasks.length} Tasks)*\n\n${listStr}\n\n⏰ *Auto-Reminder:* ${formatIntervalLabel(intervalMins)} (9 AM - 6 PM)\n💡 _अलग-अलग अपडेट ऐसे दें:_\n_• "#${createdTasks[0].id} 50% हो गया"_\n_• "#${createdTasks[1].id} थोड़ा डिले है"_`
            );
          }
          continue;
        }

        // B. Check if there are active tasks in this chat
        const activeInChat = store.tasks.filter(
          t => t.chatId === remoteJid && t.status !== 'completed'
        );
        if (activeInChat.length === 0) continue;

        const parsed = parseIncomingReply(trimmed, activeInChat);
        if (parsed.ignore) continue;

        // Handle Boss Approval ("Approve #101" / "Close #101")
        if (parsed.type === 'manager_approve') {
          if (parsed.targetId === 'all') {
            activeInChat.forEach(t => {
              t.status = 'completed';
              t.progress = 100;
            });
            saveStore();
            await sendWhatsAppMessage(
              remoteJid,
              `✅ *ALL TASKS APPROVED & CLOSED*\n\nइस चैट के सभी ${activeInChat.length} टास्क बॉस द्वारा 100% Complete मार्क कर दिए गए हैं। ऑटोमैटिक रिमाइंडर बंद हो गए हैं।`
            );
          } else {
            const task = store.tasks.find(t => t.id === parsed.targetId && t.chatId === remoteJid);
            if (task) {
              task.status = 'completed';
              task.progress = 100;
              saveStore();
              await sendWhatsAppMessage(
                remoteJid,
                `✅ *TASK COMPLETED & APPROVED (#${task.id})*\n\n📌 "${task.title}" को 100% Complete कर दिया गया है। अब इसके रिमाइंडर बंद हो गए हैं।`
              );
            }
          }
          continue;
        }

        // Find target task for progress / delay / claim done
        const task = store.tasks.find(
          t => t.id === parsed.targetId && t.chatId === remoteJid && t.status !== 'completed'
        );
        if (!task) continue;

        if (parsed.type === 'progress_update') {
          task.progress = parsed.progress;
          task.lastNote = parsed.note;
          task.status = 'in_progress';
          task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
          saveStore();

          await sendWhatsAppMessage(
            remoteJid,
            `📊 *TASK UPDATE RECORDED (#${task.id})*\n\n📌 *Task:* ${task.title}\n📈 *Progress:* ${task.progress} पूरा हुआ (${100 - task.progress} बाकी है)\n⏰ *Next Reminder:* ${formatIntervalLabel(task.intervalMins)}`
          );
        } else if (parsed.type === 'delay_or_note') {
          task.lastNote = parsed.note;
          task.nextNudgeAt = Date.now() + task.intervalMins * 60000;
          saveStore();

          await sendWhatsAppMessage(
            remoteJid,
            `⚠️ *DELAY / STATUS NOTED (#${task.id})*\n\n📌 *Task:* ${task.title}\n📝 *Update:* "${parsed.note}"\n📈 *Current Progress:* ${task.progress} points\n⏰ _रिमाइंडर चालू रहेगा। अगला चेक-इन तय समय पर आएगा।_`
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
              `🔔 *APPROVAL NEEDED (#${task.id})*\n\n📌 *Task:* ${task.title}\nएम्प्लॉई ने लिखा है कि काम पूरा हो गया है ("${parsed.note}")।\n\n👉 *बॉस ध्यान दें:* रिमाइंडर बंद करने के लिए कृपया *"Approve #${task.id}"* या *"Close #${task.id}"* लिखें (या डैशबोर्ड से Complete दबाएं)।`
            );
          } else {
            task.status = 'completed';
            saveStore();
            await sendWhatsAppMessage(
              remoteJid,
              `✅ *TASK COMPLETED (#${task.id})*\n\n📌 "${task.title}" पूरा हो गया है। रिमाइंडर बंद कर दिए गए हैं।`
            );
          }
        }
      }
    });
  } catch (err) {
    console.error('WhatsApp init error:', err.message);
    setTimeout(startWhatsApp, 5000);
  }
}

// --- Background Reminder Scheduler (Runs every 60 seconds) ---
setInterval(async () => {
  // 1. Check Night Quiet Hours (6:00 PM to 9:00 AM IST)
  if (isQuietHours()) {
    return; // Do not disturb employees at night!
  }

  const now = Date.now();
  const dueTasks = store.tasks.filter(
    t => t.status !== 'completed' && t.nextNudgeAt && t.nextNudgeAt <= now
  );

  for (const task of dueTasks) {
    task.nextNudgeAt = now + task.intervalMins * 60000;
    task.lastNudgeAt = now;
    saveStore();

    if (task.status === 'pending_approval') {
      await sendWhatsAppMessage(
        task.chatId,
        `🔔 *PENDING BOSS APPROVAL (#${task.id})*\n\n📌 *Task:* ${task.title}\nयह काम 100% रिपोर्ट किया गया है। रिमाइंडर बंद करने के लिए *"Approve #${task.id}"* लिखें।`
      );
    } else {
      await sendWhatsAppMessage(
        task.chatId,
        `⏰ *TASK REMINDER (#${task.id})*\n\n📌 *Task:* ${task.title}\n📈 *Current Progress:* ${task.progress} पूरा हुआ\n📝 *Last Note:* ${task.lastNote || 'कोई अपडेट नहीं'}\n\nकृपया अपना अपडेट दें: जैसे *"#${task.id} 40% हो गया"* या *"#${task.id} थोड़ा डिले है"*`
      );
    }
  }
}, 60000);

// --- Internal Keep-Alive Self-Ping (Every 4 minutes) ---
setInterval(() => {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) {
    const client = renderUrl.startsWith('https') ? https : http;
    client.get(renderUrl, (res) => {
      res.resume();
    }).on('error', () => {});
  }
}, 4 * 60 * 1000);

// --- Web Dashboard API & HTML ---
app.post('/api/assign', async (req, res) => {
  const { employeeName, phone, details, intervalMins } = req.body;
  if (!phone || !details) return res.redirect('/');

  const cleanPhone = phone.replace(/\D/g, '');
  const jid = cleanPhone.endsWith('@g.us') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
  const mins = parseInt(intervalMins, 10) || 120;

  const subTasks = extractMultipleTasks(details);
  for (const title of subTasks) {
    const newTask = {
      id: store.nextId++,
      chatId: jid,
      title: employeeName ? `@${employeeName} - ${title}` : title,
      assignee: employeeName || 'Employee',
      progress: 0,
      status: 'in_progress',
      intervalMins: mins,
      lastNudgeAt: Date.now(),
      nextNudgeAt: Date.now() + mins * 60000,
      lastNote: 'Assigned from Dashboard',
      createdAt: new Date().toISOString()
    };
    store.tasks.push(newTask);

    await sendWhatsAppMessage(
      jid,
      `📋 *NEW TASK ASSIGNED (#${newTask.id})*\n\n👤 *Assignee:* ${newTask.assignee}\n📌 *Task:* ${newTask.title}\n⏰ *Auto-Reminder:* ${formatIntervalLabel(mins)} (9 AM - 6 PM)\n\n💡 _अपडेट देने के लिए लिखें: "#${newTask.id} 25% हो गया" या "#${newTask.id} थोड़ा डिले है"_`
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
      `✅ *TASK APPROVED & COMPLETED (#${task.id})*\n\n📌 "${task.title}" को डैशबोर्ड से Complete कर दिया गया है। अब रिमाइंडर बंद हो गए हैं।`
    );
  }
  res.redirect('/');
});

app.post('/api/settings', (req, res) => {
  store.settings.quietHoursEnabled = req.body.quietHoursEnabled === 'on';
  store.settings.requireManagerApproval = req.body.requireManagerApproval === 'on';
  saveStore();
  res.redirect('/');
});

app.get('/', async (req, res) => {
  const activeTasks = store.tasks.filter(t => t.status !== 'completed');
  const istNow = getISTDate();
  const timeStr = istNow.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const quietNow = isQuietHours();

  let qrImageUrl = '';
  if (currentQR) {
    qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(currentQR)}`;
  }

  res.send(`<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsTask Auto-Followup Bot v2.0</title>
  <style>
    body { background:#0b1120; color:#f8fafc; font-family:system-ui,-apple-system,sans-serif; margin:0; padding:16px; }
    .card { background:#151f32; border:1px solid #263554; border-radius:16px; padding:20px; max-width:520px; margin:0 auto 16px; }
    h1 { color:#25d366; margin:0 0 8px; font-size:24px; }
    .badge { display:inline-block; padding:6px 14px; border-radius:99px; font-size:13px; font-weight:600; margin-top:8px; }
    .badge-ok { background:#064e3b; color:#34d399; }
    .badge-warn { background:#451a03; color:#fbbf24; }
    input, select, textarea { width:100%; box-sizing:border-box; padding:12px; margin-bottom:12px; border-radius:10px; border:1px solid #334155; background:#0f172a; color:#fff; font-size:14px; }
    .btn { width:100%; padding:13px; border:none; border-radius:10px; background:#16a34a; color:#fff; font-weight:700; font-size:15px; cursor:pointer; }
    .task-row { background:#0f172a; border:1px solid #1e293b; border-radius:12px; padding:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; }
  </style>
</head>
<body>
  <div class="card" style="text-align:center;">
    <h1>WhatsTask Auto-Followup Bot v2.0</h1>
    <p style="color:#94a3b8; font-size:14px; margin:0;">Smart % Tracking • Multi-Task • Night DND (6 PM - 9 AM)</p>
    <div>
      ${isConnected
        ? '<span class="badge badge-ok">✅ WhatsApp Connected & Active</span>'
        : '<span class="badge badge-warn">📱 Scan QR Code Below</span>'}
    </div>
    <p style="font-size:12px; color:#64748b; margin-top:8px;">IST Time: ${timeStr} | Night DND (6PM-9AM): <b>${quietNow ? '🌙 Sleeping (No Night Pings)' : '☀️ Active'}</b></p>
  </div>

  ${!isConnected && qrImageUrl ? `
  <div class="card" style="text-align:center;">
    <h3 style="margin-top:0;">Scan QR Code with WhatsApp</h3>
    <p style="font-size:13px; color:#94a3b8;">Open WhatsApp -> Linked Devices -> Link a Device</p>
    <img src="${qrImageUrl}" style="border:8px solid #fff; border-radius:12px; max-width:240px;" />
  </div>` : ''}

  <div class="card" style="border-color:#14532d; background:#0c1f17;">
    <h4 style="color:#4ade80; margin:0 0 8px;">💡 WhatsApp से एक या कई टास्क कैसे दें?</h4>
    <p style="font-size:13px; color:#cbd5e1; margin:0 0 8px;">चैट या ग्रुप में ऐसे लिखें (समय के लिए [1h], [2h], [4h], या [24h] लगाएं):</p>
    <pre style="background:#07120d; padding:10px; border-radius:8px; color:#4ade80; font-size:12px; white-space:pre-wrap;">Task: @Rahul [2h]
1. क्लाइंट को कोटेशन भेजो
2. साइट की फोटो मंगवाओ</pre>
    <p style="font-size:12px; color:#94a3b8; margin:8px 0 0;">
      • एम्प्लॉई लिखेगा: <b>"#101 25% हो गया"</b> या <b>"#102 थोड़ा डिले है"</b><br>
      • काम पूरा होने पर बॉस लिखेंगे: <b>"Approve #101"</b> या नीचे से Complete दबाएंगे।
    </p>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">Assign New Task (One or Multiple)</h3>
    <form method="POST" action="/api/assign">
      <input name="employeeName" placeholder="Employee Name (e.g. Rahul)" required />
      <input name="phone" placeholder="WhatsApp Number with 91 (e.g. 919876543210)" required />
      <textarea name="details" rows="3" placeholder="1. Send quotation PDF\n2. Check site report" required></textarea>
      <select name="intervalMins">
        <option value="15">Remind every 15 Minutes (Urgent)</option>
        <option value="60">Remind every 1 Hour (Daytime 9AM-6PM)</option>
        <option value="120" selected>Remind every 2 Hours (Daytime 9AM-6PM)</option>
        <option value="240">Remind every 4 Hours (Daytime 9AM-6PM)</option>
        <option value="1440">Remind every 24 Hours (Daily Same Time)</option>
      </select>
      <button type="submit" class="btn">Send on WhatsApp & Start Reminders</button>
    </form>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">Active Tasks (${activeTasks.length})</h3>
    ${activeTasks.length === 0 ? '<p style="color:#64748b; font-size:14px;">कोई पेंडिंग टास्क नहीं है।</p>' : activeTasks.map(t => `
      <div class="task-row">
        <div>
          <div style="font-weight:700; font-size:14px;">#${t.id}: ${t.title}</div>
          <div style="font-size:12px; color:#94a3b8; margin-top:4px;">Progress: <b>${t.progress}%</b> | Note: ${t.lastNote}</div>
          <div style="font-size:11px; color:#38bdf8; margin-top:2px;">${formatIntervalLabel(t.intervalMins)} ${t.status === 'pending_approval' ? '• 🔔 Needs Boss Approval' : ''}</div>
        </div>
        <form method="POST" action="/api/complete/${t.id}" style="margin:0;">
          <button type="submit" style="background:#059669; color:#fff; border:none; padding:8px 12px; border-radius:8px; font-weight:600; cursor:pointer;">Approve & Close</button>
        </form>
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
