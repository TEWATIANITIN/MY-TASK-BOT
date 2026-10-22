/**
 * Alternative WhatsApp Integration: Baileys / WhatsApp Web (QR Code)
 * Works directly with existing WhatsApp numbers & Group Chats without Meta Business Verification
 */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const taskService = require('./taskService');
const TaskUpdateParser = require('./nlpParser');

class WhatsAppBaileysClient {
  constructor() {
    this.sock = null;
    this.isConnected = false;
  }

  async startClient() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          console.log('\n📲 SCAN THIS QR CODE WITH YOUR WHATSAPP TO CONNECT:');
          qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log('Connection closed. Reconnecting...', shouldReconnect);
          this.isConnected = false;
          if (shouldReconnect) {
            this.startClient();
          }
        } else if (connection === 'open') {
          console.log('✅ WhatsApp Web client connected successfully!');
          this.isConnected = true;
        }
      });

      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const remoteJid = msg.key.remoteJid; // e.g. "919876543210@s.whatsapp.net" or "group-id@g.us"
          const isGroup = remoteJid.endsWith('@g.us');
          const sender = isGroup ? msg.key.participant : remoteJid;
          const senderName = msg.pushName || 'Employee';
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

          if (!text) continue;

          // Process task updates
          await this.handleIncomingMessage({ remoteJid, sender, senderName, isGroup, text });
        }
      });
    } catch (err) {
      console.error('Failed to initialize Baileys client:', err.message);
    }
  }

  async handleIncomingMessage({ remoteJid, sender, senderName, isGroup, text }) {
    console.log(`[Baileys Msg] from ${senderName} (${remoteJid}): "${text}"`);
    const allTasks = taskService.getAllTasks();

    // Check if message references any task
    const activeTasks = allTasks.filter(t => t.status !== 'completed');
    const parsed = TaskUpdateParser.parse(text, activeTasks);

    let targetTask = null;
    if (parsed.taskId) {
      targetTask = taskService.getTaskById(parsed.taskId);
    } else if (activeTasks.length > 0) {
      targetTask = activeTasks.find(t =>
        isGroup ? t.groupId === remoteJid : sender.includes(t.assigneePhone.replace(/\D/g, ''))
      );
    }

    if (!targetTask) return;

    let newStatus = targetTask.status;
    if (parsed.isComplete) newStatus = 'completed';
    else if (parsed.isBlocked) newStatus = 'blocked';
    else if (parsed.progress !== null) newStatus = 'in_progress';

    taskService.updateTaskStatus(targetTask.id, {
      status: newStatus,
      progress: parsed.progress !== null ? parsed.progress : targetTask.progress,
      note: text,
      sender: senderName
    });

    let reply = '';
    if (newStatus === 'completed') {
      reply = `🎉 Task #${targetTask.id} ("${targetTask.title}") completed! All follow-up reminders cancelled. Well done!`;
    } else if (newStatus === 'blocked') {
      reply = `⚠️ Task #${targetTask.id} marked as BLOCKED: "${parsed.blockerReason}". Manager alerted.`;
    } else {
      reply = `✅ Task #${targetTask.id} update recorded: ${targetTask.progress}% complete.`;
    }

    await this.sendMessage(remoteJid, reply);
  }

  async sendMessage(jid, text) {
    if (!this.sock || !this.isConnected) {
      console.log(`[Simulated Baileys Send to ${jid}]: ${text}`);
      return;
    }
    await this.sock.sendMessage(jid, { text });
  }
}

module.exports = new WhatsAppBaileysClient();
