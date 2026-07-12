export const LEVELS = ['light', 'standard', 'heavy'] as const;
export type TaskLevel = (typeof LEVELS)[number];

export const STATUSES = ['draft', 'planned', 'working', 'verifying', 'iterating', 'delivered'] as const;
export type TaskStatus = (typeof STATUSES)[number];

export interface TaskState {
  schema_version: 1;
  task_id: string;
  title: string;
  level: TaskLevel;
  status: TaskStatus;
  current_round: number;
  state_version: number;
  repository: string;
  code_revision: string;
  updated_at: string;
  last_command: string;
}

export interface Criterion { id: string; text: string }
export interface Budget {
  schema_version: 1;
  max_attempts: number;
  max_consecutive_failures: number;
  max_repeated_error: number;
  max_no_progress: number;
  max_tokens: number;
  max_work_units: number;
}

export type AttemptOutcome = 'success' | 'failure' | 'no_progress';
export interface Attempt {
  schema_version: 1;
  attempt: number;
  round: number;
  timestamp: string;
  action: string;
  outcome: AttemptOutcome;
  error_fingerprint: string | null;
  tokens: number;
  work_units: number;
}

export type GuardDecision = 'continue' | 'stop' | 'needs_user';
export interface GuardResult {
  decision: GuardDecision;
  reason: string;
  attempts: number;
  tokens: number;
  work_units: number;
}

export interface EvidenceRecord {
  schema_version: 1;
  id: string;
  task_id: string;
  round: number;
  code_revision: string;
  type: 'command' | 'test' | 'review' | 'artifact';
  artifact: string;
  sha256: string;
  exit_code: number;
  created_at: string;
}

export interface DeliveryMapping { ac: string; evidence: string[] }

export const LEGAL_TRANSITIONS: Record<string, [TaskStatus[], TaskStatus]> = {
  plan: [['draft'], 'planned'],
  round: [['planned', 'iterating'], 'working'],
  'verify-pass': [['working'], 'verifying'],
  'verify-fail': [['working', 'verifying'], 'iterating'],
  deliver: [['verifying'], 'delivered'],
};

