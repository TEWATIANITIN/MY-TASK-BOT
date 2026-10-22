# WhatsApp Employee Task Follow-Up Bot 🤖📋

An automated system to delegate tasks to employees in WhatsApp 1-on-1 chats or Group chats and persistently request updates until the task is marked **Completed**.

---

## 🌟 Key Capabilities

1. **Direct & Group Chat Support**:
   - Assign tasks to an employee individually or inside project WhatsApp groups.
   - Mentions employee (`@Rahul`) in group chats to demand accountability.
2. **Persistent Follow-up Loop ("Nudge Engine")**:
   - Automated check-in reminders sent at customizable cadences (every 1 hr, 2 hrs, 4 hrs, daily standup, etc.).
   - Follow-up stops *only* once the task status is marked `Completed` (or 100%).
   - Escalates reminder urgency when approaching or passing deadlines.
3. **Smart Natural Language Update Parsing**:
   - Employees simply reply in normal WhatsApp chat!
   - Recognizes completions: `"Done"`, `"Completed"`, `"Finished"`, `"ho gaya"`, `"100%"`.
   - Recognizes progress percentages: `"45% done"`, `"halfway through"`, `"almost done (85%)"`.
   - Recognizes blockers: `"Blocked: waiting for client approval"`, `"Stuck on DB migration"`.
   - Recognizes ETAs: `"Will finish by 6pm"`, `"ETA tomorrow 11am"`.
4. **Dual WhatsApp Integration Options**:
   - **Option A: Official Meta WhatsApp Cloud API** (Best for official business scale).
   - **Option B: Baileys / WhatsApp Web QR Code** (Free, connects directly to any WhatsApp phone/number or group without Meta approval).

---

## 🚀 Quick Start (Local or VPS)

### 1. Prerequisites
- Node.js v18+ or Docker
- A WhatsApp account or Meta Developer Account

### 2. Installation
```bash
unzip whatsapp-task-tracker.zip
cd whatsapp-task-tracker
npm install
```

### 3. Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Add your credentials if using Meta Cloud API:
- `WHATSAPP_TOKEN`: Meta System User access token
- `WHATSAPP_PHONE_NUMBER_ID`: Found in Meta App Dashboard > WhatsApp > API Setup
- `WHATSAPP_VERIFY_TOKEN`: Custom secret string for webhook handshake

### 4. Run the Server
```bash
npm start
```
By default, the server runs on `http://localhost:3000`.

---

## 🔗 Connecting WhatsApp Webhooks (Meta Cloud API)

1. Use ngrok or your domain: `ngrok http 3000`
2. Go to **Meta for Developers** -> Your App -> **WhatsApp** -> **Configuration**.
3. Set **Callback URL** to: `https://your-domain.ngrok-free.app/webhook`
4. Set **Verify Token** to the value of `WHATSAPP_VERIFY_TOKEN`.
5. Under **Webhook fields**, subscribe to `messages`.

---

## 💬 WhatsApp Message Formats & Commands

### Task Assignment Format:
When you assign a task via the app or API, the bot sends:
> 📋 **NEW TASK ASSIGNED**
> Hello @Rahul, you have been assigned:
> **Task #101**: Submit Q3 Sales Report
> **Deadline**: Today, 5:00 PM
> **Follow-up Cadence**: Every 2 hours until completed.

### Bot Follow-up Check-in:
> ⏰ **Task Check-in** @Rahul:
> Quick check-in on Task #101 ("Submit Q3 Sales Report").
> Progress: 45% | ⏳ Due in 2 hrs.
> Reply with: "Done", "% progress", or your current blocker.

### How Employees Reply:
- `"50% done, finished draft"` -> Updates progress to 50%, schedules next nudge.
- `"Blocked: waiting on client feedback"` -> Flags task as Blocked, alerts manager.
- `"Done"` or `"Completed"` -> Marks task Completed, terminates follow-up loop!

---

## 📁 Project Structure

```
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── .env.example
└── src/
    ├── nlpParser.js       # Smart regex and NLP entity extractor for chat replies
    ├── taskService.js     # Task state store, scheduler & nudge generator
    ├── whatsappCloud.js   # Official Meta WhatsApp Cloud API client & webhooks
    ├── whatsappBaileys.js # Direct WhatsApp Web / QR code connector
    └── server.js          # Express API server & background cron scheduler
```
