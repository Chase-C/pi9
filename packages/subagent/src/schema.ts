import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./domain/model-thinking-level.js";
import { isConversationId, type ConversationId } from "./domain/conversation-id.js";
import { isRunId, type RunId } from "./domain/run-id.js";

export { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./domain/model-thinking-level.js";

const NonBlankString = (description: string) => Type.String({ minLength: 1, pattern: ".*\\S.*", description });
const SpawnTaskSchema = Type.Object({
  agent: NonBlankString("Agent name."),
  prompt: NonBlankString("Delegated task."),
  label: Type.Optional(NonBlankString("Display label.")),
  skills: Type.Optional(Type.Array(NonBlankString("Skill name."), { description: "Skills override." })),
  model: Type.Optional(NonBlankString("Model override.")),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS)),
  cwd: Type.Optional(NonBlankString("Working directory.")),
}, { additionalProperties: false });
const ResumeTaskSchema = Type.Object({
  conversationId: NonBlankString("Conversation ID."),
  prompt: NonBlankString("Follow-up prompt."),
}, { additionalProperties: false });
export const TaskSchema = Type.Union([SpawnTaskSchema, ResumeTaskSchema]);
export const SUBAGENT_ACTIONS = ["agents", "list", "run", "join", "remove"] as const;
export const RUN_STATUSES = ["queued", "running", "completed", "error", "aborted", "interrupted", "skipped"] as const;
export const SubagentParams = Type.Union([
  Type.Object({ action: Type.Literal("agents") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list"), status: Type.Optional(Type.Array(StringEnum(RUN_STATUSES), { minItems: 1 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("run"), tasks: Type.Array(TaskSchema, { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("join"), runIds: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("remove"), conversationIds: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }),
]);
export type SubagentParams = Static<typeof SubagentParams>;
export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export const isRunStatus = (v: unknown): v is RunStatus => typeof v === "string" && (RUN_STATUSES as readonly string[]).includes(v);
export type SpawnRequest = { kind: "spawn"; agent: string; prompt: string; label?: string; skills?: string[]; model?: string; thinking?: ModelThinkingLevel; cwd?: string };
export type ResumeRequest = { kind: "resume"; conversationId: ConversationId; prompt: string };
export type TaskRequest = SpawnRequest | ResumeRequest;
export type ParsedTask = TaskRequest | { error: string };
export type SubagentInvocation =
 | { action: "agents" }
 | { action: "list"; status?: RunStatus[] }
 | { action: "run"; tasks: TaskRequest[] }
 | { action: "join"; runIds: RunId[] }
 | { action: "remove"; conversationIds: ConversationId[] };
export type SubagentInvocationParseError = { error: string; action?: SubagentAction; errors?: string[]; missingAction?: boolean; taskCountError?: boolean };
export type ParsedSubagentInvocation = SubagentInvocation | SubagentInvocationParseError;
export interface ParseSubagentInvocationOptions { maxTasks?: number }

const allowedInvocationKeys: Record<SubagentAction, readonly string[]> = {
 agents: ["action"], list: ["action", "status"], run: ["action", "tasks"], join: ["action", "runIds"], remove: ["action", "conversationIds"],
};
const removedFieldMigration: Record<string, string> = {
 background: "Runs are asynchronous by default; use action=run.",
 dispatch: "Use action=run with tasks.",
 wait: "Use action=join with runIds.",
 results: "Use action=join with runIds.",
 remove: "Use action=remove with conversationIds.",
 sessionId: "Use conversationId inside a resume task.",
 retainConversation: "Conversations are retained by default and removed with action=remove.",
};
export function parseSubagentInvocation(raw: unknown, options: ParseSubagentInvocationOptions = {}): ParsedSubagentInvocation {
 const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
 const action = p.action;
 if (!action) return { error: 'Provide an action: "agents", "list", "run", "join", or "remove".', missingAction: true };
 if (action === "results") return { error: "The results action was removed. Use action=join with runIds." };
 if (typeof action !== "string" || !(SUBAGENT_ACTIONS as readonly string[]).includes(action)) return { error: `Unknown action: ${String(action)}. Use "agents", "list", "run", "join", or "remove".` };
 const a = action as SubagentAction;
 for (const [field, migration] of Object.entries(removedFieldMigration)) if (p[field] !== undefined) return { error: `Field ${field} was removed. ${migration}`, action: a };
 const extra = Object.keys(p).find(key => !allowedInvocationKeys[a].includes(key));
 if (extra) return { error: `Property ${extra} is not allowed for action=${a}. Allowed properties: ${allowedInvocationKeys[a].join(", ")}.`, action: a };
 if (a === "agents") return { action: a };
 if (a === "list") {
   if (p.status !== undefined && (!Array.isArray(p.status) || !p.status.length || !p.status.every(isRunStatus))) return { error: "list status must be a non-empty array of valid run statuses.", action: a };
   return { action: a, ...(p.status ? { status: p.status as RunStatus[] } : {}) };
 }
 if (a === "run") {
   if (!Array.isArray(p.tasks) || !p.tasks.length) return { error: "Provide at least one task.", action: a, taskCountError: true };
   if (options.maxTasks !== undefined && p.tasks.length > options.maxTasks) return { error: `Too many tasks (${p.tasks.length}). Max is ${options.maxTasks}.`, action: a, taskCountError: true };
   const parsed = p.tasks.map(parseTask); const errors = parsed.flatMap((x, i) => "error" in x ? [`task[${i}]: ${x.error}`] : []);
   return errors.length ? { error: errors.join("\n"), errors, action: a } : { action: a, tasks: parsed as TaskRequest[] };
 }
 if (a === "join") { const ids = parseIds(p.runIds, "join", isRunId, "runId", "conversation ID"); return "error" in ids ? { ...ids, action: a } : { action: a, runIds: ids }; }
 const ids = parseIds(p.conversationIds, "remove", isConversationId, "conversationId", "run ID");
 return "error" in ids ? { ...ids, action: a } : { action: a, conversationIds: ids };
}
function parseIds<T extends string>(v: unknown, action: string, guard: (x: unknown) => x is T, name: string, wrong: string): T[] | { error: string } {
 if (!Array.isArray(v) || !v.length || !v.every(x => typeof x === "string" && x.trim())) return { error: `${action} requires a non-empty ${name}s array.` };
 const bad = v.find(x => !guard(x)); if (bad !== undefined) return { error: `${action} received invalid ${name} '${bad}' (a ${wrong} is not accepted).` };
 return v as T[];
}
export function parseTask(raw: unknown): ParsedTask {
 if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Task must be an object." }; const t = raw as Record<string, unknown>;
 if (t.sessionId !== undefined) return { error: "Task field sessionId was removed. Use conversationId to resume a conversation." };
 if (t.retainConversation !== undefined) return { error: "Task field retainConversation was removed. Conversations are retained by default and removed with action=remove." };
 const spawn = t.agent !== undefined, resume = t.conversationId !== undefined;
 const allowed = resume ? ["conversationId", "prompt"] : ["agent", "prompt", "label", "skills", "model", "thinking", "cwd"];
 const extra = Object.keys(t).find(key => !allowed.includes(key));
 if (extra) return { error: resume ? `Task with conversationId rejects ${extra}; that field belongs to a spawn task.` : `Task property ${extra} is not allowed for a spawn task.` };
 if (spawn === resume) return { error: "Task must carry exactly one of agent (spawn) or conversationId (resume)." };
 if (typeof t.prompt !== "string" || !t.prompt.trim()) return { error: "Task prompt must be a non-empty string." };
 if (resume) {
   if (!isConversationId(t.conversationId)) return { error: `Task conversationId '${String(t.conversationId)}' is invalid (a run ID is not accepted).` };
   for (const f of ["label", "skills", "model", "thinking", "cwd"] as const) if (t[f] !== undefined) return { error: `Task with conversationId rejects ${f}; that field belongs to a spawn task.` };
   return { kind: "resume", conversationId: t.conversationId, prompt: t.prompt };
 }
 if (typeof t.agent !== "string" || !t.agent.trim()) return { error: "Task agent must be a non-empty string." };
 if (t.label !== undefined && (typeof t.label !== "string" || !t.label.trim())) return { error: "Task label must be a non-empty string when present." };
 if (t.skills !== undefined && (!Array.isArray(t.skills) || !t.skills.every(x => typeof x === "string" && x.trim()))) return { error: "Task skills must contain only non-empty strings." };
 for (const f of ["model", "cwd"] as const) if (t[f] !== undefined && (typeof t[f] !== "string" || !(t[f] as string).trim())) return { error: `Task ${f} must be a non-empty string when present.` };
 if (t.thinking !== undefined && !isModelThinkingLevel(t.thinking)) return { error: `Task thinking must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.` };
 return { kind: "spawn", agent: t.agent, prompt: t.prompt, ...(t.label !== undefined ? { label: t.label as string } : {}), ...(t.skills !== undefined ? { skills: t.skills as string[] } : {}), ...(t.model !== undefined ? { model: t.model as string } : {}), ...(t.thinking !== undefined ? { thinking: t.thinking as ModelThinkingLevel } : {}), ...(t.cwd !== undefined ? { cwd: t.cwd as string } : {}) };
}
