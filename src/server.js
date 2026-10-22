require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const taskService = require('./taskService');
const whatsappCloud = require('./whatsappBaileys');
const TaskUpdateParser = require('./nlpParser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
whatsappCloud.initBaileys();

// 1. Meta WhatsApp Webhook endpoints
app.get('/webhook', (req, res) => whatsappCloud.verifyWebhook(req, res));
app.post('/webhook', (req, res) => whatsappCloud.handleIncomingWebhook(req, res));

// 2. Task Management REST APIs
app.get('/api/tasks', (req, res) => {
  res.json({ success: true, tasks: taskService.getAllTasks() });
});

app.post('/api/tasks', (req, res) => {
  const { title, description, assigneeName, assigneePhone, chatType, groupName, groupId, deadline, nudgeIntervalHours, priority } = req.body;
  if (!title || !assigneeName || !assigneePhone) {
    return res.status(400).json({ success: false, error: 'title, assigneeName, and assigneePhone are required' });
  }

  const created = taskService.createTask({
    title,
    description,
    assigneeName,
    assigneePhone,
    chatType,
    groupName,
    groupId,
    deadline,
    nudgeIntervalHours,
    priority
  });

  // Send initial task assignment message via WhatsApp
  const assignMsg = `📋 *NEW TASK ASSIGNED*\n\nHello @${created.assigneeName}, you have been assigned a new task:\n\n*Task #${created.id}*: ${created.title}\n*Details*: ${created.description || 'None'}\n*Deadline*: ${new Date(created.deadline).toLocaleString()}\n*Follow-up Cadence*: Every ${created.nudgeIntervalHours} hour(s) until complete.\n\nPlease reply to this chat whenever you have an update!`;

  whatsappCloud.sendMessage(created.assigneePhone, assignMsg);

  res.status(201).json({ success: true, task: created });
});

app.post('/api/tasks/:id/nudge', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const task = taskService.getTaskById(taskId);
  if (!task) return res.status(404).json({ success: false, error: 'Task not found' });

  if (task.status === 'completed') {
    return res.status(400).json({ success: false, error: 'Task is already completed' });
  }

  const messageText = taskService.generateNudgeMessage(task);
  await whatsappCloud.sendMessage(task.assigneePhone, messageText);
  const updated = taskService.recordNudgeSent(task.id, messageText);

  res.json({ success: true, task: updated, messageSent: messageText });
});

app.post('/api/tasks/:id/update', (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const { status, progress, note, sender } = req.body;
  const updated = taskService.updateTaskStatus(taskId, { status, progress, note, sender });
  if (!updated) return res.status(404).json({ success: false, error: 'Task not found' });
  res.json({ success: true, task: updated });
});

// 3. Simulated Incoming Message Endpoint (for testing & dashboard simulator)
app.post('/api/simulate-reply', async (req, res) => {
  const { senderPhone, senderName, text, isGroup, groupId } = req.body;
  await whatsappCloud.processIncomingMessage({
    senderPhone: senderPhone || '+919876543210',
    senderName: senderName || 'Employee',
    text: text || '',
    isGroup: !!isGroup,
    groupId: groupId || null
  });

  res.json({ success: true, message: 'Processed simulated update', tasks: taskService.getAllTasks() });
});

// 4. Background Automated Follow-up Scheduler (Runs every minute)
cron.schedule('* * * * *', async () => {
  const dueTasks = taskService.getTasksNeedingNudge();
  if (dueTasks.length > 0) {
    console.log(`⏰ [Auto-Scheduler] Found ${dueTasks.length} tasks needing follow-up...`);
    for (const task of dueTasks) {
      const nudgeMsg = taskService.generateNudgeMessage(task);
      console.log(`➡️ Sending automated nudge to ${task.assigneeName} (${task.assigneePhone}) for Task #${task.id}`);
      await whatsappCloud.sendMessage(task.assigneePhone, nudgeMsg);
      taskService.recordNudgeSent(task.id, nudgeMsg);
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Task Follow-Up Bot server running on port ${PORT}`);
  console.log(`📡 Webhook URL: http://your-domain.com/webhook`);
});
