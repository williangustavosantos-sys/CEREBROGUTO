import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_STORE_PATH = path.join(__dirname, "../tmp/audit-logs.json");

export type LogAction =
  | "admin_login"
  | "user_created"
  | "user_updated"
  | "invite_created"
  | "access_paused"
  | "access_reactivated"
  | "access_renewed"
  | "coach_created"
  | "coach_updated"
  | "coach_deleted"
  | "coach_assigned"
  | "coach_unassigned"
  | "workout_edited"
  | "workout_generated"
  | "workout_locked"
  | "workout_unlocked"
  | "workout_reset"
  | "workout_published"
  | "diet_edited"
  | "diet_generated"
  | "diet_locked"
  | "diet_unlocked"
  | "diet_reset"
  | "diet_published"
  | "custom_exercise_requested"
  | "custom_exercise_approved"
  | "arena_reset"
  | "password_reset"
  | "user_deleted"
  | "team_created"
  | "team_updated"
  | "invite_regenerated";

export interface AuditLog {
  id: string;
  action: LogAction;
  actorUserId: string;
  actorRole: string;
  targetUserId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface LogStore {
  logs: AuditLog[];
}

function ensureStoreFile(): void {
  if (!fs.existsSync(LOG_STORE_PATH)) {
    fs.mkdirSync(path.dirname(LOG_STORE_PATH), { recursive: true });
    fs.writeFileSync(LOG_STORE_PATH, JSON.stringify({ logs: [] }, null, 2));
  }
}

function readLogs(): AuditLog[] {
  try {
    ensureStoreFile();
    const data = JSON.parse(fs.readFileSync(LOG_STORE_PATH, "utf-8")) as LogStore;
    return data.logs;
  } catch {
    return [];
  }
}

function writeLogs(logs: AuditLog[]): void {
  try {
    ensureStoreFile();
    fs.writeFileSync(LOG_STORE_PATH, JSON.stringify({ logs }, null, 2));
  } catch {
    // ignore
  }
}

export function addLog(log: Omit<AuditLog, "id" | "timestamp">): AuditLog {
  const logs = readLogs();
  const newLog: AuditLog = {
    ...log,
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
  };
  logs.unshift(newLog); // Newest first
  
  // Keep only last 1000 logs to prevent file bloating
  const trimmed = logs.slice(0, 1000);
  writeLogs(trimmed);
  return newLog;
}

export function getLogs(filters?: { targetUserId?: string; actorUserId?: string }): AuditLog[] {
  const logs = readLogs();
  if (!filters) return logs;
  
  return logs.filter(log => {
    if (filters.targetUserId && log.targetUserId !== filters.targetUserId) return false;
    if (filters.actorUserId && log.actorUserId !== filters.actorUserId) return false;
    return true;
  });
}
