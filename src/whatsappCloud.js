/**
 * Meta WhatsApp Cloud API Client & Webhook Handler
 */
const axios = require('axios');
const taskService = require('./taskService');
const TaskUpdateParser = require('./nlpParser');

class WhatsAppCloudApi {
  constructor() {
    this.token = process.env.WHATSAPP_TOKEN || '';
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    this.verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'task_bot_verify_secret';
    this.apiUrl = `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`;
  }

  /**
   * Verify Webhook challenge from Meta
   */
  verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === this.verifyToken) {
        console.log('✅ Webhook verified successfully with Meta!');
        return res.status(200).send(challenge);
      } else {
        return res.sendStatus(403);
      }
    }
    return res.sendStatus(400);
  }

  /**
   * Process incoming WhatsApp Webhook payload
   */
  async handleIncomingWebhook(req, res) {
    const body = req.body;
    res.status(200).send('EVENT_RECEIVED'); // Acknowledge immediately to Meta

    if (body.object) {
      if (
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages &&
        body.entry[0].changes[0].value.messages[0]
      ) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from; // Sender's phone number
        const senderName = body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || 'Employee';
        const messageType = msg.type;

        if (messageType === 'text') {
          const textBody = msg.text.body;
          await this.processIncomingMessage({
            senderPhone: from,
            senderName,
            text: textBody,
            isGroup: false,
            contextId: from
          });
        }
      }
    }
  }

  /**
   * Core logic to interpret message and execute update
   */
  async processIncomingMessage({ senderPhone, senderName, text, isGroup, contextId, groupId }) {
    console.log(`📩 Incoming WhatsApp from ${senderName} (${senderPhone}): "${text}"`);

    // Find active tasks matching this assignee
    const allTasks = taskService.getAllTasks();
    const activeTasks = allTasks.filter(
      t => t.status !== 'completed' && (
        t.assigneePhone.includes(senderPhone.replace(/\D/g, '')) ||
        t.assigneeName.toLowerCase().includes(senderName.toLowerCase()) ||
        (isGroup && t.groupId === groupId)
      )
    );

    // Parse the message with NLP
    const parsed = TaskUpdateParser.parse(text, activeTasks);
    console.log('🔍 Parsed task update:', parsed);

    let targetTask = null;
    if (parsed.taskId) {
      targetTask = taskService.getTaskById(parsed.taskId);
    } else if (activeTasks.length > 0) {
      targetTask = activeTasks[0]; // default to the latest / highest priority active task
    }

    if (!targetTask) {
      // Reply with help info
      const reply = `Hi ${senderName}, I couldn't find an active task matching your message. To update a task, include the Task ID, e.g. "Task #101: 70% completed" or "Done #101".`;
      await this.sendMessage(senderPhone, reply);
      return;
    }

    // Apply update to task
    const oldStatus = targetTask.status;
    const oldProgress = targetTask.progress;

    let newStatus = targetTask.status;
    if (parsed.isComplete) {
      newStatus = 'completed';
    } else if (parsed.isBlocked) {
      newStatus = 'blocked';
    } else if (parsed.progress !== null) {
      newStatus = 'in_progress';
    }

    const updated = taskService.updateTaskStatus(targetTask.id, {
      status: newStatus,
      progress: parsed.progress !== null ? parsed.progress : targetTask.progress,
      note: text,
      sender: senderName
    });

    // Formulate response to employee
    let acknowledgement = '';
    if (updated.status === 'completed') {
      acknowledgement = `🎉 Great job ${senderName}! Task #${targetTask.id} ("${targetTask.title}") is marked as COMPLETED. Follow-up notifications have stopped. Thank you!`;
    } else if (updated.status === 'blocked') {
      acknowledgement = `⚠️ Understood ${senderName}. Task #${targetTask.id} has been marked as BLOCKED (${parsed.blockerReason || 'Waiting on dependencies'}). The manager has been alerted.`;
    } else {
      acknowledgement = `✅ Got it! Task #${targetTask.id} updated to ${updated.progress}% progress. Next follow-up is scheduled in ${targetTask.nudgeIntervalHours} hours if not completed before.`;
    }

    await this.sendMessage(senderPhone, acknowledgement);
  }

  /**
   * Send WhatsApp message via Meta Cloud API
   */
  async sendMessage(toPhone, messageBody) {
    if (!this.token || !this.phoneNumberId) {
      console.log(`[SIMULATED WhatsApp Outbound to ${toPhone}]:\n${messageBody}`);
      return { success: true, simulated: true };
    }

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toPhone.replace(/\D/g, ''),
          type: 'text',
          text: { preview_url: false, body: messageBody }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`
          }
        }
      );
      return response.data;
    } catch (err) {
      console.error('Error sending WhatsApp message:', err.response?.data || err.message);
      return { success: false, error: err.message };
    }
  }
}

module.exports = new WhatsAppCloudApi();
