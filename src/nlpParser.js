/**
 * NLP & Pattern Matcher for WhatsApp Employee Task Updates
 */

class TaskUpdateParser {
  /**
   * Parse an incoming WhatsApp message string for task updates
   * @param {string} text - Message body from employee
   * @param {Array} activeTasksForEmployee - Optional active tasks list for context
   * @returns {Object} Extracted intent, taskId, progress, status, blocker, eta, note
   */
  static parse(text, activeTasksForEmployee = []) {
    const raw = (text || '').trim();
    const lower = raw.toLowerCase();

    const result = {
      rawMessage: raw,
      taskId: null,
      status: null, // 'completed' | 'in_progress' | 'blocked' | 'update_only'
      progress: null, // 0 to 100
      isComplete: false,
      isBlocked: false,
      blockerReason: null,
      eta: null,
      updateSummary: raw
    };

    // 1. Extract explicit Task ID if present (e.g., #102, task 102, T-102)
    const taskIdMatch = lower.match(/(?:#|task\s*|t-)(\d+)/i);
    if (taskIdMatch) {
      result.taskId = parseInt(taskIdMatch[1], 10);
    } else if (activeTasksForEmployee.length === 1) {
      // If only one task is active for this employee/context, bind to it
      result.taskId = activeTasksForEmployee[0].id;
    }

    // 2. Extract Progress Percentage first (e.g., 40%, 75% done, 65 percent)
    const percentMatch = lower.match(/(\d{1,3})\s*(?:%|percent)/i);
    if (percentMatch) {
      const val = parseInt(percentMatch[1], 10);
      if (val >= 0 && val <= 100) {
        result.progress = val;
        if (val === 100) {
          result.isComplete = true;
          result.status = 'completed';
        } else {
          result.status = 'in_progress';
        }
      }
    } else if (/\b(halfway|half done|50-50)\b/i.test(lower)) {
      result.progress = 50;
      result.status = 'in_progress';
    } else if (/\b(just started|started working|beginning)\b/i.test(lower)) {
      result.progress = 15;
      result.status = 'in_progress';
    } else if (/\b(almost done|nearly finished|wrapping up|final touches)\b/i.test(lower)) {
      result.progress = 90;
      result.status = 'in_progress';
    }

    // 3. Check for Completion signals (only if progress wasn't explicitly < 100%)
    if (result.progress === null || result.progress === 100) {
      // Avoid false positive on "not done", "not completed", "yet to be done"
      const isNegative = /\b(not done|not finished|not complete|yet to|incomplete)\b/i.test(lower);
      if (!isNegative) {
        const completeKeywords = [
          /\b(done|completed|finished|complete|ho gaya|khatam|resolved|closed|submitted)\b/i,
          /\b(100%|100 percent)\b/i,
          /\b(all done|it's ready|task complete|work done)\b/i
        ];
        for (const regex of completeKeywords) {
          if (regex.test(lower)) {
            result.isComplete = true;
            result.status = 'completed';
            result.progress = 100;
            break;
          }
        }
      }
    }

    // 4. Check for Blockers
    const blockerKeywords = [
      /\b(blocked|stuck|waiting for|dependency|issue with|can't proceed|delay|delayed)\b/i,
      /\b(client hasn't|server down|need approval|pending approval)\b/i
    ];
    for (const regex of blockerKeywords) {
      if (regex.test(lower)) {
        result.isBlocked = true;
        result.status = 'blocked';
        result.blockerReason = raw;
        break;
      }
    }

    // 5. Check for ETA mentions
    const etaMatch = lower.match(/(?:by|eta|around|before|till|until)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm|hours?|mins?|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)?)/i);
    if (etaMatch) {
      result.eta = etaMatch[1].trim();
    }

    // Fallback status if none matched but there's a note
    if (!result.status && raw.length > 0) {
      result.status = 'in_progress';
    }

    return result;
  }
}

module.exports = TaskUpdateParser;
