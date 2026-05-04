import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

const PROTOCOL_VERSION = 1;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 30_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CUSTOM_TYPE = "whisper";
const NAME_ENTRY_TYPE = "whisper-name";

type DeliveryMode = "user" | "note";

type AgentRecord = {
	version: number;
	name: string;
	pid: number;
	host: string;
	port: number;
	token: string;
	cwd: string;
	sessionFile?: string;
	startedAt: number;
	updatedAt: number;
};

type IncomingWhisperMessage = {
	id?: string;
	from?: string;
	message?: string;
	mode?: DeliveryMode;
	timestamp?: number;
};

const sendSchema = Type.Object({
	to: Type.String({ description: "Name of the target pi agent." }),
	message: Type.String({ description: "Message to send to the target pi agent." }),
	mode: Type.Optional(
		StringEnum(["user", "note"] as const, {
			description: "user triggers the target agent as a user prompt; note only displays the message.",
		}),
	),
});

export default function whisperExtension(pi: ExtensionAPI) {
	const registryDir = process.env.PI_WHISPER_DIR ?? join(homedir(), ".pi", "whisper");
	const token = randomUUID();
	const startedAt = Date.now();

	let server: Server | undefined;
	let serverPort: number | undefined;
	let currentName: string | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let activeCtx: ExtensionContext | undefined;
	let recordPath: string | undefined;

	pi.registerFlag("whisper-name", {
		description: "Name this pi agent for Whisper IPC.",
		type: "string",
	});

	pi.registerTool({
		name: "whisper_send",
		label: "Whisper Send",
		description: "Send a message to another named pi agent on this machine. Messages are limited to 64KB.",
		promptSnippet: "Send a message to another named local pi agent via Whisper IPC.",
		promptGuidelines: [
			"Use whisper_send when the user asks you to contact, coordinate with, or hand off work to another local pi agent.",
			"Use whisper_send with mode=\"user\" when the receiving agent should act on the message; use mode=\"note\" for notification only.",
		],
		parameters: sendSchema,
		async execute(_toolCallId, params, signal) {
			const from = requireCurrentName(currentName);
			const mode = params.mode ?? "user";
			const result = await sendToAgent(registryDir, params.to, {
				from,
				message: params.message,
				mode,
			}, signal);

			return {
				content: [{ type: "text", text: `Sent ${mode} message from ${from} to ${result.to}.` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "whisper_list_agents",
		label: "Whisper List Agents",
		description: "List named pi agents currently reachable through Whisper on this machine.",
		promptSnippet: "List local pi agents currently reachable through Whisper IPC.",
		promptGuidelines: ["Use whisper_list_agents before whisper_send when you do not know the target agent name."],
		parameters: Type.Object({}),
		async execute() {
			const agents = await listActiveAgents(registryDir);
			return {
				content: [{ type: "text", text: formatAgentList(agents, currentName) }],
				details: { agents },
			};
		},
	});

	pi.registerCommand("whisper-name", {
		description: "Show or set this pi agent's Whisper name.",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				postLocalMessage(pi, `This agent is named ${currentName ?? "(not registered)"}.`);
				return;
			}

			try {
				await activateName(name, ctx, { persist: true, allowFallback: false });
				ctx.ui.notify(`Whisper name set to ${name}`, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				postLocalMessage(pi, errorMessage(error));
			}
		},
	});

	pi.registerCommand("whisper-list", {
		description: "List reachable Whisper agents on this machine.",
		handler: async (_args, _ctx) => {
			const agents = await listActiveAgents(registryDir);
			postLocalMessage(pi, formatAgentList(agents, currentName), { agents });
		},
	});

	pi.registerCommand("whisper-send", {
		description: "Send a user prompt to another Whisper agent. Usage: /whisper-send <agent> <message>",
		getArgumentCompletions: (prefix) => completeAgentNames(registryDir, prefix, currentName),
		handler: async (args, ctx) => {
			await handleSendCommand(pi, registryDir, currentName, args, "user", ctx.signal);
		},
	});

	pi.registerCommand("whisper-note", {
		description: "Display a note in another Whisper agent. Usage: /whisper-note <agent> <message>",
		getArgumentCompletions: (prefix) => completeAgentNames(registryDir, prefix, currentName),
		handler: async (args, ctx) => {
			await handleSendCommand(pi, registryDir, currentName, args, "note", ctx.signal);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		await ensureServer();

		const requested = getConfiguredName(pi, ctx) ?? `pi-${process.pid}`;
		try {
			await activateName(requested, ctx, { persist: false, allowFallback: requested !== `pi-${process.pid}` });
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeCtx = undefined;
		ctx.ui.setStatus("whisper", undefined);
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		if (recordPath) await rm(recordPath, { force: true });
		recordPath = undefined;
		await closeServer(server);
		server = undefined;
		serverPort = undefined;
	});

	async function ensureServer() {
		if (server && serverPort !== undefined) return;

		server = createServer((req, res) => {
			void handleIncoming(req, res, pi, () => activeCtx, token);
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server?.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server?.off("error", onError);
				const address = server?.address();
				if (!address || typeof address === "string") {
					reject(new Error("Whisper could not determine its listening port."));
					return;
				}
				serverPort = address.port;
				resolve();
			};
			server?.once("error", onError);
			server?.once("listening", onListening);
			server?.listen(0, DEFAULT_HOST);
		});
	}

	async function activateName(
		name: string,
		ctx: ExtensionContext,
		options: { persist: boolean; allowFallback: boolean },
	) {
		const validName = validateName(name);
		try {
			await publish(validName, ctx);
		} catch (error) {
			if (!options.allowFallback) throw error;
			const fallback = `pi-${process.pid}`;
			await publish(fallback, ctx);
			ctx.ui.notify(`${errorMessage(error)} Using fallback name ${fallback}.`, "warning");
			return;
		}

		if (options.persist) pi.appendEntry(NAME_ENTRY_TYPE, { name: validName });
	}

	async function publish(name: string, ctx: ExtensionContext) {
		if (serverPort === undefined) throw new Error("Whisper server has not started.");

		const existing = await findAgent(registryDir, name);
		if (existing && !isSelfRecord(existing, token)) {
			throw new Error(`Whisper name \"${name}\" is already in use by pid ${existing.pid}.`);
		}

		await mkdir(registryDir, { recursive: true });

		const nextPath = getRecordPath(registryDir, name);
		const oldPath = recordPath;
		currentName = name;
		recordPath = nextPath;

		await writeRecord(ctx);
		if (oldPath && oldPath !== nextPath) await rm(oldPath, { force: true });

		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => {
			if (activeCtx) void writeRecord(activeCtx);
		}, HEARTBEAT_MS);
		heartbeat.unref?.();

		ctx.ui.setStatus("whisper", `whisper:${name}`);
	}

	async function writeRecord(ctx: ExtensionContext) {
		if (!currentName || !recordPath || serverPort === undefined) return;
		const record: AgentRecord = {
			version: PROTOCOL_VERSION,
			name: currentName,
			pid: process.pid,
			host: DEFAULT_HOST,
			port: serverPort,
			token,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			startedAt,
			updatedAt: Date.now(),
		};
		await writeJsonAtomic(recordPath, record);
	}
}

async function handleSendCommand(
	pi: ExtensionAPI,
	registryDir: string,
	currentName: string | undefined,
	args: string,
	mode: DeliveryMode,
	signal: AbortSignal | undefined,
) {
	const parsed = parseTargetAndMessage(args);
	if (!parsed) {
		postLocalMessage(pi, `Usage: /whisper-${mode === "note" ? "note" : "send"} <agent> <message>`);
		return;
	}

	try {
		const from = requireCurrentName(currentName);
		const result = await sendToAgent(registryDir, parsed.to, { from, message: parsed.message, mode }, signal);
		postLocalMessage(pi, `Sent ${mode} message from ${from} to ${result.to}.`, result);
	} catch (error) {
		postLocalMessage(pi, errorMessage(error));
	}
}

async function handleIncoming(
	req: IncomingMessage,
	res: ServerResponse,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | undefined,
	token: string,
) {
	try {
		if (req.method !== "POST" || req.url !== "/message") {
			writeResponse(res, 404, { error: "not found" });
			return;
		}

		if (req.headers["x-whisper-token"] !== token) {
			writeResponse(res, 401, { error: "unauthorized" });
			return;
		}

		const body = await readRequestBody(req, MAX_MESSAGE_BYTES);
		const payload = JSON.parse(body) as IncomingWhisperMessage;
		const from = typeof payload.from === "string" && payload.from.trim() ? payload.from.trim() : "unknown";
		const message = typeof payload.message === "string" ? payload.message : "";
		const mode = payload.mode === "note" ? "note" : "user";
		if (!message.trim()) throw new Error("message must be a non-empty string");

		const ctx = getCtx();
		if (mode === "note") {
			postLocalMessage(pi, `Note from ${from}:\n\n${message}`, {
				from,
				mode,
				id: payload.id,
				timestamp: payload.timestamp,
			});
		} else {
			const prompt = `Message from pi agent \"${from}\":\n\n${message}`;
			if (ctx?.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}
			if (ctx?.hasUI) ctx.ui.notify(`Whisper message from ${from}`, "info");
		}

		writeResponse(res, 200, { ok: true });
	} catch (error) {
		writeResponse(res, 400, { error: errorMessage(error) });
	}
}

async function sendToAgent(
	registryDir: string,
	to: string,
	payload: { from: string; message: string; mode: DeliveryMode },
	signal?: AbortSignal,
) {
	const target = await findAgent(registryDir, to);
	if (!target) throw new Error(`No active Whisper agent named \"${to}\".`);
	if (payload.message.length > MAX_MESSAGE_BYTES) throw new Error("Message is too large for Whisper (64KB max).");

	await postJson(target, {
		id: randomUUID(),
		from: payload.from,
		message: payload.message,
		mode: payload.mode,
		timestamp: Date.now(),
	}, signal);

	return { to: target.name, host: target.host, port: target.port, mode: payload.mode };
}

async function postJson(target: AgentRecord, payload: IncomingWhisperMessage, signal?: AbortSignal) {
	const body = JSON.stringify(payload);

	return new Promise<void>((resolve, reject) => {
		const req = request(
			{
				host: target.host,
				port: target.port,
				path: "/message",
				method: "POST",
				signal,
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
					"x-whisper-token": target.token,
				},
			},
			(res) => {
				let response = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					response += chunk;
				});
				res.on("end", () => {
					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						resolve();
						return;
					}
					reject(new Error(`Whisper delivery failed (${res.statusCode ?? "unknown"}): ${response}`));
				});
			},
		);

		req.setTimeout(DEFAULT_TIMEOUT_MS, () => {
			req.destroy(new Error(`Whisper delivery timed out after ${DEFAULT_TIMEOUT_MS}ms.`));
		});
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

async function listActiveAgents(registryDir: string): Promise<AgentRecord[]> {
	await mkdir(registryDir, { recursive: true });
	const files = await readdir(registryDir).catch(() => [] as string[]);
	const records: AgentRecord[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const fullPath = join(registryDir, file);
		try {
			const record = JSON.parse(await readFile(fullPath, "utf8")) as AgentRecord;
			if (!isActiveRecord(record)) {
				await rm(fullPath, { force: true });
				continue;
			}
			records.push(record);
		} catch {
			await rm(fullPath, { force: true });
		}
	}
	return records.sort((a, b) => a.name.localeCompare(b.name));
}

function listActiveAgentsSync(registryDir: string): AgentRecord[] {
	if (!existsSync(registryDir)) return [];
	const records: AgentRecord[] = [];
	for (const file of readdirSync(registryDir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const record = JSON.parse(readFileSync(join(registryDir, file), "utf8")) as AgentRecord;
			if (isActiveRecord(record)) records.push(record);
		} catch {
			// Ignore malformed records in sync autocomplete path.
		}
	}
	return records.sort((a, b) => a.name.localeCompare(b.name));
}

async function findAgent(registryDir: string, name: string): Promise<AgentRecord | undefined> {
	const validName = validateName(name);
	const records = await listActiveAgents(registryDir);
	return records.filter((record) => record.name === validName).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function isActiveRecord(record: AgentRecord) {
	return (
		record &&
		record.version === PROTOCOL_VERSION &&
		typeof record.name === "string" &&
		typeof record.host === "string" &&
		typeof record.port === "number" &&
		typeof record.token === "string" &&
		Date.now() - record.updatedAt <= STALE_AFTER_MS
	);
}

function isSelfRecord(record: AgentRecord, token: string) {
	return record.pid === process.pid && record.token === token;
}

function getConfiguredName(pi: ExtensionAPI, ctx: ExtensionContext) {
	const flagName = pi.getFlag("whisper-name");
	if (typeof flagName === "string" && flagName.trim()) return flagName.trim();
	if (process.env.PI_WHISPER_NAME?.trim()) return process.env.PI_WHISPER_NAME.trim();

	let restored: string | undefined;
	for (const entry of ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>) {
		if (entry.type !== "custom" || entry.customType !== NAME_ENTRY_TYPE) continue;
		const data = entry.data as { name?: unknown } | undefined;
		if (typeof data?.name === "string") restored = data.name;
	}
	return restored;
}

function validateName(name: string) {
	const trimmed = name.trim();
	if (!NAME_PATTERN.test(trimmed)) {
		throw new Error("Whisper names must be 1-64 characters: letters, numbers, dot, underscore, or dash.");
	}
	return trimmed;
}

function getRecordPath(registryDir: string, name: string) {
	const digest = createHash("sha256").update(name).digest("hex").slice(0, 24);
	return join(registryDir, `${digest}.json`);
}

async function writeJsonAtomic(path: string, value: unknown) {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}

async function readRequestBody(req: IncomingMessage, maxBytes: number) {
	return new Promise<string>((resolve, reject) => {
		let bytes = 0;
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > maxBytes) {
				reject(new Error("message too large"));
				req.destroy();
				return;
			}
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function writeResponse(res: ServerResponse, statusCode: number, payload: unknown) {
	const body = JSON.stringify(payload);
	res.writeHead(statusCode, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function postLocalMessage(pi: ExtensionAPI, content: string, details?: unknown) {
	pi.sendMessage({
		customType: CUSTOM_TYPE,
		content,
		display: true,
		details,
	});
}

function formatAgentList(agents: AgentRecord[], currentName?: string) {
	if (agents.length === 0) return "No active Whisper agents found.";
	return agents
		.map((agent) => {
			const self = agent.name === currentName ? " (this agent)" : "";
			const age = Math.max(0, Math.round((Date.now() - agent.updatedAt) / 1000));
			return `- ${agent.name}${self} pid=${agent.pid} cwd=${agent.cwd} heartbeat=${age}s ago`;
		})
		.join("\n");
}

function completeAgentNames(registryDir: string, prefix: string, currentName?: string) {
	const currentToken = prefix.trim();
	const agents = listActiveAgentsSync(registryDir)
		.filter((agent) => agent.name !== currentName)
		.filter((agent) => agent.name.startsWith(currentToken));
	return agents.length ? agents.map((agent) => ({ value: agent.name, label: agent.name, description: agent.cwd })) : null;
}

function parseTargetAndMessage(args: string) {
	const trimmed = args.trim();
	const match = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
	if (!match) return undefined;
	return { to: match[1], message: match[2] };
}

function requireCurrentName(name: string | undefined) {
	if (!name) throw new Error("Whisper is not registered yet. Use /whisper-name <name> first.");
	return name;
}

function closeServer(server: Server | undefined) {
	return new Promise<void>((resolve) => {
		if (!server) {
			resolve();
			return;
		}
		server.close(() => resolve());
	});
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
