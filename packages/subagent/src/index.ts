import { isAbsolute, resolve } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, summarizeAgents } from "./agents.js";

const MAX_TASKS = 6;
const MAX_CONCURRENCY = 3;

const TaskSchema = Type.Object({
  agent: Type.String({ description: "Agent name from ~/.pi/agent/agents or .pi/agents" }),
  prompt: Type.String({ description: "Concrete prompt to delegate" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this subagent" })),
});

const SubagentParams = Type.Object({
  tasks: Type.Array(TaskSchema, { description: "Tasks to run" }),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, {
    description: "Agent discovery scope. Default: user.",
  })),
});

type SubagentParams = Static<typeof SubagentParams>;

type RunStatus = "running" | "success" | "failed";

interface SubagentRun {
  agent: string;
  prompt: string;
  status: RunStatus;
  output: string;
  error?: string;
  model?: string;
}

interface SubagentDetails {
  mode: "tasks";
  runs: SubagentRun[];
}

function resolveChildCwd(rootCwd: string, cwd?: string) {
  if (!cwd) return rootCwd;
  return isAbsolute(cwd) ? cwd : resolve(rootCwd, cwd);
}

function resolveAgentModel(modelRegistry: ModelRegistry | undefined, modelSpec: string | undefined): Model<any> | undefined {
  if (!modelSpec) return undefined;
  if (!modelRegistry) throw new Error(`Agent specifies model ${modelSpec}, but no model registry is available.`);

  const slash = modelSpec.indexOf("/");
  if (slash !== -1) {
    const provider = modelSpec.slice(0, slash);
    const modelId = modelSpec.slice(slash + 1);
    if (!provider || !modelId) throw new Error(`Invalid agent model ${modelSpec}. Use provider/model or a bare model id.`);

    const model = modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Agent model ${modelSpec} was not found.`);
    return model;
  }

  const matches = modelRegistry.getAll().filter((model) => model.id === modelSpec);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const candidates = matches.map((model) => `${model.provider}/${model.id}`).join(", ");
    throw new Error(`Agent model ${modelSpec} is ambiguous. Use one of: ${candidates}`);
  }
  throw new Error(`Agent model ${modelSpec} was not found.`);
}

function disposeSession(session: AgentSession | undefined) {
  const disposable = session as (AgentSession & { dispose?: () => void | Promise<void> }) | undefined;
  return Promise.resolve(disposable?.dispose?.());
}

async function runAgent(options: {
  rootCwd: string;
  agents: AgentConfig[];
  modelRegistry: ModelRegistry | undefined;
  agentName: string;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRun) => void;
}): Promise<SubagentRun> {
  const agent = options.agents.find((candidate) => candidate.name === options.agentName);
  if (!agent) {
    const error = `Unknown agent: ${options.agentName}. Available agents: ${options.agents.map((a) => a.name).join(", ") || "none"}`;
    return {
      agent: options.agentName,
      prompt: options.prompt,
      status: "failed",
      output: error,
      error,
    };
  }

  const run: SubagentRun = {
    agent: agent.name,
    prompt: options.prompt,
    status: "running",
    output: "",
    model: agent.model,
  };
  options.onUpdate?.(run);

  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let aborting = false;
  const abort = () => {
    aborting = true;
    void session?.abort().catch(() => undefined);
  };

  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (options.signal?.aborted) throw new Error("Parent request aborted.");

    const childCwd = resolveChildCwd(options.rootCwd, options.cwd);
    const model = resolveAgentModel(options.modelRegistry, agent.model);
    const resourceLoader = new DefaultResourceLoader({
      cwd: childCwd,
      agentDir: getAgentDir(),
      appendSystemPromptOverride: (base) => (agent.systemPrompt ? [...base, agent.systemPrompt] : base),
    });
    await resourceLoader.reload();

    const result = await createAgentSession({
      cwd: childCwd,
      resourceLoader,
      modelRegistry: options.modelRegistry,
      model,
      tools: agent.tools?.length ? agent.tools : undefined,
      sessionManager: SessionManager.inMemory(childCwd),
    });
    session = result.session;

    if (options.signal?.aborted) throw new Error("Parent request aborted.");

    unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_update") return;
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta") return;
      run.output += update.delta;
      options.onUpdate?.(run);
    });

    await session.prompt(options.prompt, { source: "extension" });
    if (options.signal?.aborted) throw new Error("Parent request aborted.");

    run.output = session.getLastAssistantText() ?? "";
    run.status = "success";
    options.onUpdate?.(run);
    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.status = "failed";
    run.error = aborting && !message.toLowerCase().includes("abort") ? `Aborted: ${message}` : message;
    run.output ||= run.error;
    options.onUpdate?.(run);
    return run;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe?.();
    await disposeSession(session);
  }
}

async function mapLimited<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

function validateTasks(tasks: SubagentParams["tasks"] | undefined) {
  if (!Array.isArray(tasks)) return "Provide a tasks array.";
  if (tasks.length === 0) return "Provide at least one task.";
  if (tasks.length > MAX_TASKS) return `Too many tasks (${tasks.length}). Max is ${MAX_TASKS}.`;
  return undefined;
}

function summarizeRuns(runs: SubagentRun[]) {
  return runs
    .map((run) => {
      const icon = run.status === "success" ? "✓" : run.status === "failed" ? "✗" : "…";
      const preview = run.output.trim().split("\n").slice(0, 6).join("\n");
      return `${icon} ${run.agent}: ${preview || "(no output)"}`;
    })
    .join("\n\n");
}

function renderRuns(runs: SubagentRun[]) {
  return runs
    .map((run) => {
      const output = run.output.trim() || run.error?.trim() || "(no output)";
      return `## ${run.agent} — ${run.status}\n\n${output}`;
    })
    .join("\n\n");
}

export default function subagentExtension(pi: ExtensionAPI) {
  pi.registerCommand("subagents", {
    description: "List available subagents",
    handler: async (args, ctx) => {
      const scope = (args.trim() as AgentScope) || "user";
      const { agents, searched } = discoverAgents(ctx.cwd, scope);
      ctx.ui.notify(
        `${agents.length} subagent(s) found\n\n${summarizeAgents(agents) || "No agents found."}\n\nSearched:\n${searched.join("\n")}`,
        agents.length ? "info" : "warning",
      );
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate work to isolated pi subagents. Supports task-array delegation.",
    promptSnippet: "Delegate focused tasks to isolated pi subagents with separate context windows",
    promptGuidelines: [
      "Use subagent for independent research, planning, review, or implementation tasks that benefit from isolated context.",
      "Use subagent with one writer by default; avoid parallel file-writing tasks unless explicitly requested.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const mode = "tasks";
      const scope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, scope);
      const availableAgents = summarizeAgents(discovery.agents) || "none";
      const validationError = validateTasks(params.tasks);

      if (validationError) {
        return {
          content: [{ type: "text", text: `${validationError}\n\nAvailable agents:\n${availableAgents}` }],
          details: { mode, runs: [] } satisfies SubagentDetails,
          isError: true,
        };
      }

      const tasks = params.tasks;
      const liveRuns: SubagentRun[] = tasks.map((task) => ({ agent: task.agent, prompt: task.prompt, status: "running", output: "" }));
      const emit = () => onUpdate?.({ content: [{ type: "text", text: summarizeRuns(liveRuns) }], details: { mode, runs: liveRuns } });

      const runs = await mapLimited(tasks, MAX_CONCURRENCY, async (task, index) => {
        const run = await runAgent({
          rootCwd: ctx.cwd,
          agents: discovery.agents,
          modelRegistry: ctx.modelRegistry,
          agentName: task.agent,
          prompt: task.prompt,
          cwd: task.cwd,
          signal,
          onUpdate: (partial) => {
            liveRuns[index] = partial;
            emit();
          },
        });
        liveRuns[index] = run;
        emit();
        return run;
      });

      const failed = runs.some((run) => run.status === "failed");
      return {
        content: [{ type: "text", text: renderRuns(runs) }],
        details: { mode, runs } satisfies SubagentDetails,
        isError: failed || undefined,
      };
    },
  });
}
