import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
  stderr: string;
  exitCode?: number;
  model?: string;
}

interface SubagentDetails {
  mode: "tasks";
  runs: SubagentRun[];
}

function finalAssistantText(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function piInvocation(args: string[]) {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writeSystemPrompt(agent: AgentConfig) {
  if (!agent.systemPrompt) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const file = join(dir, `${agent.name.replace(/[^a-z0-9_.-]/gi, "_")}-system.md`);
  await writeFile(file, agent.systemPrompt, { mode: 0o600 });
  return { dir, file };
}

async function runAgent(options: {
  rootCwd: string;
  agents: AgentConfig[];
  agentName: string;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRun) => void;
}): Promise<SubagentRun> {
  const agent = options.agents.find((candidate) => candidate.name === options.agentName);
  if (!agent) {
    return {
      agent: options.agentName,
      prompt: options.prompt,
      status: "failed",
      output: `Unknown agent: ${options.agentName}. Available agents: ${options.agents.map((a) => a.name).join(", ") || "none"}`,
      stderr: "",
      exitCode: 1,
    };
  }

  const run: SubagentRun = {
    agent: agent.name,
    prompt: options.prompt,
    status: "running",
    output: "",
    stderr: "",
    model: agent.model,
  };
  options.onUpdate?.(run);

  let promptFile: Awaited<ReturnType<typeof writeSystemPrompt>>;
  try {
    const args = ["--mode", "json", "-p", "--no-session"];
    if (agent.model) args.push("--model", agent.model);
    if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

    promptFile = await writeSystemPrompt(agent);
    if (promptFile) args.push("--append-system-prompt", promptFile.file);
    args.push(options.prompt);

    const invocation = piInvocation(args);
    const messages: Message[] = [];

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd ?? options.rootCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            messages.push(event.message as Message);
            run.output = finalAssistantText(messages);
            options.onUpdate?.(run);
          }
        } catch {
          // JSON mode writes one event per line; ignore non-JSON noise defensively.
        }
      };

      child.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      });
      child.stderr.on("data", (data) => {
        run.stderr += data.toString();
      });
      child.on("error", () => resolve(1));
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
        resolve(code ?? 0);
      });

      const abort = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });

    run.exitCode = exitCode;
    run.output ||= finalAssistantText(messages) || run.stderr.trim() || "(no output)";
    run.status = exitCode === 0 ? "success" : "failed";
    options.onUpdate?.(run);
    return run;
  } finally {
    if (promptFile) await rm(promptFile.dir, { recursive: true, force: true });
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
      const liveRuns: SubagentRun[] = tasks.map((task) => ({ agent: task.agent, prompt: task.prompt, status: "running", output: "", stderr: "" }));
      const emit = () => onUpdate?.({ content: [{ type: "text", text: summarizeRuns(liveRuns) }], details: { mode, runs: liveRuns } });

      const runs = await mapLimited(tasks, MAX_CONCURRENCY, async (task, index) => {
        const run = await runAgent({
          rootCwd: ctx.cwd,
          agents: discovery.agents,
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
        content: [{ type: "text", text: summarizeRuns(runs) }],
        details: { mode, runs } satisfies SubagentDetails,
        isError: failed || undefined,
      };
    },
  });
}
