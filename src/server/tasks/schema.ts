/**
 * Generic persistent task storage (A3a) and budget ledger (A3b).
 *
 * DDL only: tests apply `statements` directly; the Lead registers them in
 * src/server/database/migrations.ts. No table is created on module import.
 *
 * FROZEN after A3b: this file is business migration 0005 (0004=projects,
 * 0006=materials). Any later DDL (A3c and beyond) must be added under a new
 * migration number 0007+, never by editing these statements or deleting old
 * ones. Three tables plus the runner singleton are created here:
 *   equilens_tasks, equilens_task_runner, equilens_project_budgets,
 *   equilens_task_budget_reservations.
 *
 * equilens_task_runner is a singleton row that serialises global execution
 * (spec §9: one exec in-process runner). It reuses the existing
 * contract-review runner semantics — short lease, per-attempt execution token,
 * conditional UPDATE claim — instead of introducing a second executor.
 *
 * Budget accounting (A3b) keeps calls, time, task cost and project cost
 * separately and persistently. Reservations are written before any paid
 * external request and survive a crash; an unknown provider usage keeps the
 * conservative reservation instead of being treated as free.
 */
export const statements: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS equilens_tasks (id VARCHAR(36) PRIMARY KEY,kind VARCHAR(32) NOT NULL,owner VARCHAR(64) NOT NULL,project_id VARCHAR(64) NOT NULL,operation_id VARCHAR(100) NOT NULL,request_hash VARCHAR(64) NOT NULL,manifest TEXT NOT NULL,manifest_hash VARCHAR(64) NOT NULL,state VARCHAR(16) NOT NULL,stage VARCHAR(32) NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT,attempt INTEGER NOT NULL,max_attempts INTEGER NOT NULL,calls_used INTEGER NOT NULL,max_calls INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,max_cost_fen INTEGER NOT NULL DEFAULT 0,cost_reserved_fen INTEGER NOT NULL DEFAULT 0,cost_charged_fen INTEGER NOT NULL DEFAULT 0,time_reserved_ms INTEGER NOT NULL DEFAULT 0,time_charged_ms INTEGER NOT NULL DEFAULT 0,attempt_started_at TEXT,execution_token VARCHAR(36),lease_until TEXT,result_summary TEXT,error_code VARCHAR(64),error_message TEXT,UNIQUE(owner,project_id,operation_id))",
  "CREATE INDEX IF NOT EXISTS equilens_tasks_queue ON equilens_tasks(state,created_at)",
  "CREATE INDEX IF NOT EXISTS equilens_tasks_project ON equilens_tasks(project_id,created_at)",
  "CREATE INDEX IF NOT EXISTS equilens_tasks_owner ON equilens_tasks(owner,created_at)",
  "CREATE TABLE IF NOT EXISTS equilens_task_runner (id INTEGER PRIMARY KEY,token VARCHAR(36),lease_until TEXT)",
  "INSERT INTO equilens_task_runner(id,token,lease_until) SELECT 1,NULL,NULL WHERE NOT EXISTS (SELECT 1 FROM equilens_task_runner WHERE id=1)",
  "CREATE TABLE IF NOT EXISTS equilens_project_budgets (project_id VARCHAR(64) PRIMARY KEY,cost_limit_fen INTEGER NOT NULL,cost_reserved_fen INTEGER NOT NULL,cost_charged_fen INTEGER NOT NULL,registered_by VARCHAR(36) NOT NULL,registered_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS equilens_task_budget_reservations (task_id VARCHAR(36) NOT NULL,attempt INTEGER NOT NULL,call_number INTEGER NOT NULL,project_id VARCHAR(64) NOT NULL,cost_reserved_fen INTEGER NOT NULL,time_reserved_ms INTEGER NOT NULL,actual_cost_fen INTEGER NOT NULL,actual_time_ms INTEGER NOT NULL,usage_known INTEGER NOT NULL,status VARCHAR(16) NOT NULL,created_at TEXT NOT NULL,settled_at TEXT,PRIMARY KEY(task_id,attempt,call_number),FOREIGN KEY(task_id) REFERENCES equilens_tasks(id) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS equilens_task_budget_project ON equilens_task_budget_reservations(project_id,status)",
  "CREATE INDEX IF NOT EXISTS equilens_task_budget_task ON equilens_task_budget_reservations(task_id,status)",
]
