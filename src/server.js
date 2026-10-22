require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// State Management
let sock = null;
let qrImageDataUrl = null;
let connectionStatus = 'initializing'; // initializing | qr_ready | connected | error
let lastError = '';
let connectedUser = null;
let tasks = [];
let taskCounter = 101;
let knownGroups = [];

// Create a new task
function createTask({ title, assigneeName, chatJid, isGroup, intervalMinutes }) {
  const intervalMs = (Number(intervalMinutes) || 60) * 60 * 1000;
  const task = {
    id: taskCounter++,
    title: title.trim(),
    assigneeName: (assigneeName || 'Team Member').trim(),
    chatJid,
    isGroup: !!isGroup,
    status: 'pending',
    progress: 0,
    intervalMinutes: Number(intervalMinutes) || 60,
    nextFollowUpAt: Date.now() + intervalMs,
    createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    lastUpdate: 'Task assigned'
  };
  tasks.unshift(task);
  return task;
}

// Parse employee reply
function checkMessageForUpdate(text) {
  const lower = text.toLowerCase().trim();
  if (/\b(done|completed|complete|finished|100%|ho gaya|hogaya|हो गया|पूरा हो गया)\b/i.test(lower)) {
    return { type: 'completed', progress: 100 };
  }
  const pctMatch = lower.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const pct = Math.min(100, Math.max(0, parseInt(pctMatch[1], 10)));
    return { type: pct === 100 ? 'completed' : 'progress', progress: pct };
  }
  if (/\b(blocked|stuck|issue|problem|waiting|रुका|अटका)\b/i.test(lower)) {
    return { type: 'blocked' };
  }
  return null;
}

// Send WhatsApp message safely
async function sendWhatsAppMessage(jid, text, mentions = []) {
  if (!sock || connectionStatus !== 'connected') {
    console.log('[WhatsApp Not Connected Yet] Would send to', jid, ':', text);
    return false;
  }
  try {
    let targetJid = jid;
    if (!targetJid.includes('@')) {
      const cleanPhone = targetJid.replace(/\D/g, '');
      targetJid = `${cleanPhone}@s.whatsapp.net`;
    }
    await sock.sendMessage(targetJid, { text, mentions });
    return true;
  } catch (err) {
    console.error('Send message error:', err.message);
    return false;
  }
}

// Initialize Baileys WhatsApp Connection
async function startWhatsApp() {
  try {
    connectionStatus = 'initializing';
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
    const DisconnectReason = baileys.DisconnectReason || baileys.default?.DisconnectReason;
    const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion || baileys.default?.fetchLatestBaileysVersion;

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch (e) {}

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhatsTask Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrImageDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        connectionStatus = 'qr_ready';
        console.log('✅ QR Code Ready! Open your Render URL in browser to scan.');
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        qrImageDataUrl = null;
        connectedUser = sock.user;
        console.log('🎉 WhatsApp Connected Successfully as:', connectedUser?.id);

        // Fetch groups list
        try {
          const groups = await sock.groupFetchAllParticipating();
          knownGroups = Object.values(groups).map(g => ({ id: g.id, subject: g.subject }));
        } catch (e) {}
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;
        console.log('Connection closed. Reconnecting:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(startWhatsApp, 4000);
        } else {
          connectionStatus = 'disconnected';
        }
      }
    });

    // Listen to incoming and outgoing WhatsApp messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const chatJid = msg.key.remoteJid;
        if (!chatJid || chatJid === 'status@broadcast') continue;

        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim();

        if (!text) continue;

        // 1. Check if user is assigning a new task directly inside WhatsApp using "Task:" or "टास्क:"
        const taskCmdMatch = text.match(/^(?:task|टास्क)\s*:\s*(.+)/i);
        if (taskCmdMatch) {
          const rawContent = taskCmdMatch[1].trim();
          const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
          let assigneeName = 'Team';
          let taskTitle = rawContent;

          if (rawContent.includes('-')) {
            const parts = rawContent.split('-');
            assigneeName = parts[0].replace('@', '').trim();
            taskTitle = parts.slice(1).join('-').trim();
          }

          const newTask = createTask({
            title: taskTitle,
            assigneeName,
            chatJid,
            isGroup: chatJid.endsWith('@g.us'),
            intervalMinutes: 60
          });

          const confirmMsg = `📋 *NEW TASK ASSIGNED (#${newTask.id})*\n\n👤 *Assignee:* ${newTask.assigneeName}\n📌 *Task:* ${newTask.title}\n⏰ *Auto-Reminder:* Every 60 mins until completed\n\n_Reply with "Done" or "हो गया" when finished._`;
          await sendWhatsAppMessage(chatJid, confirmMsg, mentionedJids);
          continue;
        }

        // 2. Ignore bot's own automated messages from triggering completion
        if (text.startsWith('📋 *NEW TASK') || text.startsWith('⏰ *TASK REMINDER') || text.startsWith('✅ *TASK COMPLETED')) {
          continue;
        }

        // 3. Check if an active task exists in this chat and employee replied with an update
        const activeTasksInChat = tasks.filter(t => t.chatJid === chatJid && t.status !== 'completed');
        if (activeTasksInChat.length > 0) {
          const parsed = checkMessageForUpdate(text);
          if (parsed) {
            const targetTask = activeTasksInChat[0];
            targetTask.lastUpdate = text;
            if (parsed.type === 'completed') {
              targetTask.status = 'completed';
              targetTask.progress = 100;
              await sendWhatsAppMessage(
                chatJid,
                `✅ *TASK COMPLETED (#${targetTask.id})*\n\nGreat job! "${targetTask.title}" is marked 100% complete. Automatic reminders are now stopped.`
              );
            } else if (parsed.type === 'progress') {
              targetTask.status = 'in_progress';
              targetTask.progress = parsed.progress;
              targetTask.nextFollowUpAt = Date.now() + targetTask.intervalMinutes * 60 * 1000;
              await sendWhatsAppMessage(
                chatJid,
                `👍 *Update Recorded (#${targetTask.id}):* Progress set to ${parsed.progress}%. Next check-in in ${targetTask.intervalMinutes} mins.`
              );
            } else if (parsed.type === 'blocked') {
              targetTask.status = 'blocked';
              await sendWhatsAppMessage(
                chatJid,
                `⚠️ *Blocker Noted (#${targetTask.id}):* "${text}". Status marked as Blocked.`
              );
            }
          }
        }
      }
    });
  } catch (err) {
    console.error('Baileys initialization error:', err);
    connectionStatus = 'error';
    lastError = err.message;
  }
}

// Background Auto-Followup Loop (Checks every 30 seconds)
setInterval(async () => {
  const now = Date.now();
  for (const task of tasks) {
    if (task.status !== 'completed' && now >= task.nextFollowUpAt) {
      task.nextFollowUpAt = now + task.intervalMinutes * 60 * 1000;
      const reminderMsg = `⏰ *TASK REMINDER (#${task.id})*\n\n👋 Hi *${task.assigneeName}*, please share an update on:\n📌 *"${task.title}"*\n\n📊 Current Progress: ${task.progress}%\n_Reply with "% done" or "Done" / "हो गया" if completed._`;
      await sendWhatsAppMessage(task.chatJid, reminderMsg);
    }
  }
}, 30 * 1000);

// REST APIs for Dashboard
app.get('/api/status', (req, res) => {
  res.json({
    connectionStatus,
    qrImageDataUrl,
    connectedUser,
    lastError,
    tasks,
    knownGroups
  });
});

app.post('/api/tasks', async (req, res) => {
  const { title, assigneeName, phoneOrGroup, intervalMinutes } = req.body;
  if (!title || !phoneOrGroup) {
    return res.status(400).json({ error: 'Task title and Phone/Group are required' });
  }
  const isGroup = phoneOrGroup.endsWith('@g.us');
  const chatJid = isGroup ? phoneOrGroup : `${phoneOrGroup.replace(/\D/g, '')}@s.whatsapp.net`;

  const task = createTask({
    title,
    assigneeName: assigneeName || 'Employee',
    chatJid,
    isGroup,
    intervalMinutes: Number(intervalMinutes) || 60
  });

  const msg = `📋 *NEW TASK ASSIGNED (#${task.id})*\n\n👋 Hi *${task.assigneeName}*,\n📌 *Task:* ${task.title}\n⏰ *Follow-up:* Every ${task.intervalMinutes} mins until completed.\n\n_Please reply with your progress (e.g. "50%") or "Done" / "हो गया" when finished._`;
  await sendWhatsAppMessage(chatJid, msg);

  res.json({ success: true, task });
});

app.post('/api/tasks/:id/nudge', async (req, res) => {
  const task = tasks.find(t => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const msg = `⏰ *TASK REMINDER (#${task.id})*\n\n👋 Hi *${task.assigneeName}*, what is the status of:\n📌 *"${task.title}"*?\n\n_Reply "Done" / "हो गया" once completed._`;
  await sendWhatsAppMessage(task.chatJid, msg);
  res.json({ success: true });
});

app.post('/api/tasks/:id/complete', (req, res) => {
  const task = tasks.find(t => t.id === Number(req.params.id));
  if (task) {
    task.status = 'completed';
    task.progress = 100;
  }
  res.json({ success: true });
});

// Web Interface (QR Scanner + Live Task Dashboard)
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsTask — WhatsApp Task Bot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen p-4 md:p-8">
  <div class="max-w-4xl mx-auto space-y-6">
    <div class="bg-slate-800 border border-slate-700 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-emerald-400">WhatsTask Auto-Followup Bot</h1>
        <p class="text-sm text-slate-400">Assign tasks in WhatsApp or below — automatic reminders run until "Done"</p>
      </div>
      <div id="statusBadge" class="px-4 py-2 rounded-full text-sm font-semibold bg-amber-500/20 text-amber-300">
        Checking status...
      </div>
    </div>

    <!-- QR Code Section -->
    <div id="qrSection" class="hidden bg-white text-slate-900 rounded-2xl p-6 text-center shadow-xl">
      <h2 class="text-xl font-bold mb-2">Scan QR Code with WhatsApp</h2>
      <p class="text-sm text-slate-600 mb-4">Open WhatsApp on your phone &rarr; <b>Linked Devices</b> &rarr; <b>Link a Device</b></p>
      <img id="qrImg" src="" alt="WhatsApp QR Code" class="mx-auto w-64 h-64 border-4 border-emerald-500 rounded-xl" />
    </div>

    <!-- How to assign directly from WhatsApp -->
    <div class="bg-emerald-950/50 border border-emerald-700/50 rounded-2xl p-4 text-sm">
      <p class="font-semibold text-emerald-300 mb-1">💡 WhatsApp से सीधे टास्क कैसे दें?</p>
      <p class="text-slate-300">किसी भी WhatsApp चैट या ग्रुप में बस ऐसे मैसेज लिखें:<br/>
      <code class="bg-slate-900 px-2 py-1 rounded text-emerald-400 mt-1 inline-block">Task: राहुल - शाम 5 बजे तक साइट की रिपोर्ट भेजो</code><br/>
      बॉट अपने आप टास्क रजिस्टर कर लेगा और हर 1 घंटे में रिमाइंडर भेजेगा जब तक एम्प्लॉई <b>"Done"</b> या <b>"हो गया"</b> न लिख दे!</p>
    </div>

    <!-- Assign Task Form -->
    <div class="bg-slate-800 border border-slate-700 rounded-2xl p-6">
      <h2 class="text-lg font-bold mb-4">Assign New Task from Dashboard</h2>
      <form id="taskForm" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <input id="assigneeName" type="text" placeholder="Employee Name (e.g. Rahul)" required class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm" />
        <input id="phoneOrGroup" list="groupList" type="text" placeholder="WhatsApp Number with 91 (e.g. 919876543210) or select Group" required class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm" />
        <datalist id="groupList"></datalist>
        <input id="title" type="text" placeholder="Task Details (e.g. Send quotation PDF)" required class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm md:col-span-2" />
        <select id="intervalMinutes" class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm">
          <option value="15">Remind every 15 Minutes</option>
          <option value="30">Remind every 30 Minutes</option>
          <option value="60" selected>Remind every 1 Hour</option>
          <option value="120">Remind every 2 Hours</option>
          <option value="240">Remind every 4 Hours</option>
        </select>
        <button type="submit" class="bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold rounded-xl px-6 py-2.5 text-sm transition">
          Send on WhatsApp & Start Reminders
        </button>
      </form>
    </div>

    <!-- Active Tasks List -->
    <div class="bg-slate-800 border border-slate-700 rounded-2xl p-6">
      <h2 class="text-lg font-bold mb-4">Active Tasks</h2>
      <div id="tasksList" class="space-y-3 text-sm text-slate-400">Loading tasks...</div>
    </div>
  </div>

  <script>
    async function refreshStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const badge = document.getElementById('statusBadge');
        const qrSection = document.getElementById('qrSection');
        const qrImg = document.getElementById('qrImg');

        if (data.connectionStatus === 'connected') {
          badge.className = 'px-4 py-2 rounded-full text-sm font-semibold bg-emerald-500/20 text-emerald-300';
          badge.innerText = '✅ WhatsApp Connected';
          qrSection.classList.add('hidden');
        } else if (data.connectionStatus === 'qr_ready' && data.qrImageDataUrl) {
          badge.className = 'px-4 py-2 rounded-full text-sm font-semibold bg-amber-500/20 text-amber-300';
          badge.innerText = '📱 Scan QR Code Below';
          qrImg.src = data.qrImageDataUrl;
          qrSection.classList.remove('hidden');
        } else {
          badge.innerText = '⏳ Starting WhatsApp Engine...';
          qrSection.classList.add('hidden');
        }

        // Populate groups dropdown
        if (data.knownGroups && data.knownGroups.length > 0) {
          const dl = document.getElementById('groupList');
          dl.innerHTML = data.knownGroups.map(g => '<option value="' + g.id + '">Group: ' + g.subject + '</option>').join('');
        }

        // Render tasks
        const listEl = document.getElementById('tasksList');
        if (!data.tasks || data.tasks.length === 0) {
          listEl.innerHTML = '<p class="text-slate-500">No tasks assigned yet.</p>';
        } else {
          listEl.innerHTML = data.tasks.map(t => \`
            <div class="bg-slate-900 border border-slate-700 rounded-xl p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <div>
                <span class="text-xs font-bold px-2 py-0.5 rounded \${t.status === 'completed' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">#\${t.id} • \${t.status.toUpperCase()} (\${t.progress}%)</span>
                <h3 class="font-bold text-white mt-1">\${t.title}</h3>
                <p class="text-xs text-slate-400">👤 \${t.assigneeName} • Every \${t.intervalMinutes}m • Last: \${t.lastUpdate}</p>
              </div>
              <div class="flex gap-2">
                \${t.status !== 'completed' ? \`
                  <button onclick="nudgeTask(\${t.id})" class="bg-slate-700 hover:bg-slate-600 text-white px-3 py-1.5 rounded-lg text-xs">Remind Now</button>
                  <button onclick="completeTask(\${t.id})" class="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg text-xs">Mark Done</button>
                \` : ''}
              </div>
            </div>
          \`).join('');
        }
      } catch (e) {}
    }

    async function nudgeTask(id) {
      await fetch('/api/tasks/' + id + '/nudge', { method: 'POST' });
      refreshStatus();
    }

    async function completeTask(id) {
      await fetch('/api/tasks/' + id + '/complete', { method: 'POST' });
      refreshStatus();
    }

    document.getElementById('taskForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        assigneeName: document.getElementById('assigneeName').value,
        phoneOrGroup: document.getElementById('phoneOrGroup').value,
        title: document.getElementById('title').value,
        intervalMinutes: document.getElementById('intervalMinutes').value
      };
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      document.getElementById('title').value = '';
      refreshStatus();
    });

    setInterval(refreshStatus, 4000);
    refreshStatus();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log('🚀 WhatsTask Server running on port', PORT);
  startWhatsApp();
});
