import { z } from 'zod';
import { LEVELS, STATUSES } from './model.js';

export const stateSchema = z.object({
  schema_version: z.literal(1), task_id: z.string().regex(/^TASK-[A-Z0-9][A-Z0-9-]*$/),
  title: z.string().min(3), level: z.enum(LEVELS), status: z.enum(STATUSES),
  current_round: z.number().int().nonnegative(), state_version: z.number().int().positive(),
  repository: z.string().min(1), code_revision: z.string().min(1), updated_at: z.iso.datetime(), last_command: z.string().min(1),
}).strict();

export const specSchema = z.object({
  schema_version: z.literal(1), task_id: z.string(), title: z.string().min(3), level: z.enum(LEVELS),
}).strict();

export const acceptanceSchema = z.object({
  schema_version: z.literal(1), task_id: z.string(),
  criteria: z.array(z.object({ id: z.string().regex(/^AC-[1-9]\d*$/), text: z.string().min(3) }).strict()).min(1),
}).strict();

export const planSchema = z.object({
  schema_version: z.literal(1), task_id: z.string(), version: z.number().int().positive(),
  ac_coverage: z.array(z.string().regex(/^AC-[1-9]\d*$/)).min(1),
}).strict();

export const roundSchema = z.object({
  schema_version: z.literal(1), task_id: z.string(), round: z.number().int().positive(), status: z.enum(['open', 'verified_pass', 'verified_fail']),
}).strict();

export const verifySchema = z.object({
  schema_version: z.literal(1), task_id: z.string(), round: z.number().int().nonnegative(),
  result: z.enum(['pending', 'pass', 'fail']), verifier: z.string(), independent: z.boolean(), human_checked: z.boolean(),
  signed_round: z.number().int().nonnegative(), evidence: z.array(z.string().regex(/^EV-[1-9]\d*$/)),
}).strict();

export const deliverySchema = z.object({
  schema_version: z.literal(1), task_id: z.string(), round: z.number().int().nonnegative(), code_revision: z.string(),
  mappings: z.array(z.object({ ac: z.string().regex(/^AC-[1-9]\d*$/), evidence: z.array(z.string().regex(/^EV-[1-9]\d*$/)).min(1) }).strict()),
}).strict();

export const budgetSchema = z.object({
  schema_version: z.literal(1), max_attempts: z.number().int().positive(), max_consecutive_failures: z.number().int().positive(),
  max_repeated_error: z.number().int().positive(), max_no_progress: z.number().int().positive(), max_tokens: z.number().int().positive(),
  max_work_units: z.number().positive(),
}).strict();

export const attemptSchema = z.object({
  schema_version: z.literal(1), attempt: z.number().int().positive(), round: z.number().int().positive(), timestamp: z.iso.datetime(),
  action: z.string().min(3), outcome: z.enum(['success', 'failure', 'no_progress']), error_fingerprint: z.string().min(3).nullable(),
  tokens: z.number().int().nonnegative(), work_units: z.number().nonnegative(),
}).strict();

export const evidenceSchema = z.object({
  schema_version: z.literal(1), id: z.string().regex(/^EV-[1-9]\d*$/), task_id: z.string(), round: z.number().int().positive(),
  code_revision: z.string().min(1), type: z.enum(['command', 'test', 'review', 'artifact']), artifact: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), exit_code: z.number().int(), created_at: z.iso.datetime(),
}).strict();

