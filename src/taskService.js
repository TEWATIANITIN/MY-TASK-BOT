/**
 * Task Service - State Management, Update Logs & Nudge Engine
 */

class TaskService {
  constructor() {
    this.tasks = [];
    this.nextId = 101;
    this.subscribers = [];
    this._initSeedData();
  }

  _initSeedData() {
    const now = Date.now();
    this.tasks = [
      {
        id: 101,
        title: "Submit Q3 Sales & Lead Conversion Report",
        description: "Collate CRM numbers and create 5-slide summary deck.",
        assigneeName: "Rahul Sharma",
        assigneePhone: "+919876543210",
        chatType: "direct", // 'direct' or 'group'
        groupName: null,
        groupId: null,
        deadline: new Date(now + 6 * 3600 * 1000).toISOString(), // in 6 hours
        nudgeIntervalHours: 2,
        priority: "High",
        status: "in_progress", // 'pending' | 'in_progress' | 'blocked' | 'completed' | 'overdue'
        progress: 45,
        nudgeCount: 2,
        lastNudgeAt: new Date(now - 1.8 * 3600 * 1000).toISOString(),
        nextNudgeAt: new Date(now + 0.2 * 3600 * 1000).toISOString(),
        createdAt: new Date(now - 8 * 3600 * 1000).toISOString(),
        updates: [
          {
            timestamp: new Date(now - 6 * 3600 * 1000).toISOString(),
            sender: "Rahul Sharma",
            type: "update",
            text: "Started pulling HubSpot raw export data.",
            progress: 20
          },
          {
            timestamp: new Date(now - 3 * 3600 * 1000).toISOString(),
            sender: "Rahul Sharma",
            type: "update",
            text: "45% done, working on chart layouts.",
            progress: 45
          }
        ]
      },
      {
        id: 102,
        title: "Fix Stripe Webhook 500 error on checkout",
        description: "Investigate server error logs and deploy patch to staging.",
        assigneeName: "Priya Nair",
        assigneePhone: "+919812345678",
        chatType: "group",
        groupName: "🚀 Tech & Dev Squad",
        groupId: "tech-squad-group-01",
        deadline: new Date(now + 3 * 3600 * 1000).toISOString(),
        nudgeIntervalHours: 1,
        priority: "Urgent",
        status: "blocked",
        progress: 60,
        nudgeCount: 3,
        lastNudgeAt: new Date(now - 0.9 * 3600 * 1000).toISOString(),
        nextNudgeAt: new Date(now + 0.1 * 3600 * 1000).toISOString(),
        createdAt: new Date(now - 4 * 3600 * 1000).toISOString(),
        updates: [
          {
            timestamp: new Date(now - 2 * 3600 * 1000).toISOString(),
            sender: "Priya Nair",
            type: "update",
            text: "60% done, located bug in signature verification.",
            progress: 60
          },
          {
            timestamp: new Date(now - 1 * 3600 * 1000).toISOString(),
            sender: "Priya Nair",
            type: "blocker",
            text: "Blocked: waiting on Stripe Test API secret key regeneration from DevOps.",
            progress: 60
          }
        ]
      },
      {
        id: 103,
        title: "Vendor Contract Review for Cloud Storage",
        description: "Review terms, SLA requirements, and discount structure.",
        assigneeName: "Amit Verma",
        assigneePhone: "+919890123456",
        chatType: "direct",
        groupName: null,
        groupId: null,
        deadline: new Date(now + 24 * 3600 * 1000).toISOString(),
        nudgeIntervalHours: 4,
        priority: "Medium",
        status: "pending",
        progress: 0,
        nudgeCount: 0,
        lastNudgeAt: null,
        nextNudgeAt: new Date(now + 1.5 * 3600 * 1000).toISOString(),
        createdAt: new Date(now - 1 * 3600 * 1000).toISOString(),
        updates: []
      }
    ];
    this.nextId = 104;
  }

  getAllTasks() {
    return this.tasks;
  }

  getTaskById(id) {
    return this.tasks.find(t => t.id === parseInt(id, 10));
  }

  createTask(taskData) {
    const now = Date.now();
    const intervalHours = parseFloat(taskData.nudgeIntervalHours) || 2;
    const newTask = {
      id: this.nextId++,
      title: taskData.title.trim(),
      description: (taskData.description || '').trim(),
      assigneeName: taskData.assigneeName.trim(),
      assigneePhone: taskData.assigneePhone.trim(),
      chatType: taskData.chatType || 'direct',
      groupName: taskData.chatType === 'group' ? (taskData.groupName || 'General Group') : null,
      groupId: taskData.chatType === 'group' ? (taskData.groupId || 'group-default') : null,
      deadline: taskData.deadline ? new Date(taskData.deadline).toISOString() : new Date(now + 8 * 3600 * 1000).toISOString(),
      nudgeIntervalHours: intervalHours,
      priority: taskData.priority || 'Medium',
      status: 'pending',
      progress: 0,
      nudgeCount: 0,
      lastNudgeAt: null,
      nextNudgeAt: new Date(now + intervalHours * 3600 * 1000).toISOString(),
      createdAt: new Date(now).toISOString(),
      updates: []
    };

    this.tasks.unshift(newTask);
    return newTask;
  }

  updateTaskStatus(id, updateData) {
    const task = this.getTaskById(id);
    if (!task) return null;

    const now = Date.now();
    if (updateData.status) task.status = updateData.status;
    if (typeof updateData.progress === 'number') task.progress = updateData.progress;

    if (task.status === 'completed') {
      task.progress = 100;
      task.nextNudgeAt = null; // No more follow ups!
    } else {
      // Re-schedule next nudge
      task.nextNudgeAt = new Date(now + task.nudgeIntervalHours * 3600 * 1000).toISOString();
    }

    if (updateData.note) {
      task.updates.push({
        timestamp: new Date(now).toISOString(),
        sender: updateData.sender || task.assigneeName,
        type: updateData.status === 'blocked' ? 'blocker' : (task.status === 'completed' ? 'completion' : 'update'),
        text: updateData.note,
        progress: task.progress
      });
    }

    return task;
  }

  recordNudgeSent(taskId, messageText) {
    const task = this.getTaskById(taskId);
    if (!task) return null;

    const now = Date.now();
    task.nudgeCount += 1;
    task.lastNudgeAt = new Date(now).toISOString();
    task.nextNudgeAt = new Date(now + task.nudgeIntervalHours * 3600 * 1000).toISOString();

    task.updates.push({
      timestamp: new Date(now).toISOString(),
      sender: "System Bot",
      type: "nudge",
      text: messageText,
      progress: task.progress
    });

    return task;
  }

  getTasksNeedingNudge() {
    const now = Date.now();
    return this.tasks.filter(t => {
      if (t.status === 'completed') return false;
      if (!t.nextNudgeAt) return false;
      return new Date(t.nextNudgeAt).getTime() <= now;
    });
  }

  generateNudgeMessage(task) {
    const isOverdue = new Date(task.deadline).getTime() < Date.now();
    const hoursLeft = Math.round((new Date(task.deadline).getTime() - Date.now()) / (3600 * 1000));
    const tag = `@${task.assigneeName}`;

    let deadlineStr = isOverdue
      ? `⚠️ OVERDUE by ${Math.abs(hoursLeft)} hrs!`
      : `⏳ Due in ${hoursLeft > 0 ? hoursLeft : '<1'} hrs`;

    if (task.nudgeCount === 0) {
      // First follow-up
      return `👋 Hi ${tag}, following up on Task #${task.id}: "${task.title}".\n\n${deadlineStr}\nCurrent status: ${task.progress}% done.\n\nPlease reply with your latest update, ETA, or any blockers!`;
    } else if (isOverdue || task.nudgeCount >= 3) {
      // Escalation / High urgency
      return `🚨 *ACTION REQUIRED* ${tag}: Task #${task.id} "${task.title}" is ${deadlineStr}.\n\nCurrent progress is at ${task.progress}%. What is preventing completion? Please reply with an immediate status update or blocker so we can assist.`;
    } else {
      // Regular periodic check-in
      return `⏰ *Task Check-in* ${tag}: Quick update check on Task #${task.id} ("${task.title}").\nProgress: ${task.progress}% | ${deadlineStr}.\nReply with: "Done", "% progress", or your current blocker.`;
    }
  }
}

module.exports = new TaskService();
