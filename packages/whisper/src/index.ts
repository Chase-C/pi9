import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const PROTOCOL_VERSION = 2;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 30_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_WIRE_BYTES = MAX_MESSAGE_BYTES + 8 * 1024;
const INBOX_CAP = 100;
const ASK_REGISTRY_POLL_MS = 100;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

type Urgency = "interrupt" | "soon" | "later";
type InboundKind = "send" | "ask";

type AgentRecord = {
	version: number;
	id: string;
	name: string;
	pid: number;
	host: string;
	port: number;
	token: string;
	cwd: string;
	sessionFile?: string;
	description?: string;
	startedAt: number;
	updatedAt: number;
};

type WhisperWireMessage = {
	id?: string;
	kind?: string;
	requestId?: string;
	from?: string;
	fromId?: string;
	message?: string;
	code?: string;
	urgency?: string;
	timestamp?: number;
};

type InboundEnvelope = {
	kind: InboundKind;
	id: string;
	from: string;
	fromId?: string;
	message: string;
	requestId?: string;
	receivedAt: number;
	timestamp?: number;
	urgency: Urgency;
};

type PendingInboundAsk = {
	requestId: string;
	from: string;
	fromId?: string;
	message: string;
	receivedAt: number;
};

type ReplyEnvelope = {
	requestId: string;
	from: string;
	fromId?: string;
	message: string;
	timestamp?: number;
};

type PendingOutboundAsk = {
	resolve(reply: ReplyEnvelope): void;
	reject(error: Error): void;
};

type InboxWaiter = {
	resolve(envelopes: InboundEnvelope[]): void;
	reject(error: Error): void;
	timer?: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
};

const whisperParams = Type.Object({
	action: Type.String({ description: "Whisper operation to perform. One of: me, list, send, update, ask, wait, pending, reply." }),
	to: Type.Optional(Type.String({ description: "For action='send' and action='ask'. Id of the target agent (returned by whisper({ action: 'list' }))." })),
	message: Type.Optional(Type.String({ description: "For action='send', action='ask', and action='reply'." })),
	urgency: Type.Optional(Type.String({ description: "For action='send' and action='ask'. One of: interrupt, soon, later. Defaults to 'interrupt' for ask and 'soon' for send." })),
	description: Type.Optional(Type.String({ description: "For action='update'. Short (1 sentence) status. Empty string clears it." })),
	requestId: Type.Optional(Type.String({
		description: "For action='reply'. Request id from the injected whisper-ask message or from whisper({ action: 'pending' }).",
	})),
	timeoutMs: Type.Optional(Type.Number({
		description: "For action='ask' and action='wait'. Optional timeout in milliseconds.",
	})),
});

export default function whisperExtension(pi: ExtensionAPI) {
	const registryDir = process.env.PI_WHISPER_DIR ?? join(homedir(), ".pi", "whisper");
	const token = randomUUID();
	const id = randomUUID();
	const startedAt = Date.now();
	const inbox: InboundEnvelope[] = [];
	const waiters: InboxWaiter[] = [];
	const pendingInboundAsks = new Map<string, PendingInboundAsk>();
	const pendingOutboundAsks = new Map<string, PendingOutboundAsk>();

	let server: Server | undefined;
	let serverPort: number | undefined;
	let currentName: string | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let activeCtx: ExtensionContext | undefined;
	let recordPath: string | undefined;
	let currentDescription: string | undefined;

	pi.registerFlag("whisper-name", {
		description: "Name this pi agent for Whisper IPC.",
		type: "string",
	});

	pi.registerTool({
		name: "whisper",
		label: "Whisper",
		description: "Coordinate with named local pi agents on this machine.",
		promptSnippet: "List local pi agents or send a message to one with whisper.",
		promptGuidelines: ["Use whisper for local agent-to-agent coordination."],
		parameters: whisperParams,
		async execute(_toolCallId, params, signal): Promise<any> {
			if (params.action === "me") {
				const name = requireCurrentName(currentName);
				const agent = await findAgentById(registryDir, id);
				if (!agent) throw new Error(`No active Whisper record for this agent (${name}, ${id}).`);
				return {
					content: [{ type: "text", text: `This Whisper agent is ${agent.name} (${agent.id}).` }],
					details: { ...agent, agent },
				};
			}

			if (params.action === "list") {
				const agents = await listActiveAgents(registryDir);
				return {
					content: [{ type: "text", text: formatAgentList(agents, id) }],
					details: { agents },
				};
			}

			if (params.action === "send") {
				const from = requireCurrentName(currentName);
				const to = requireNonEmpty(params.to, "to is required for Whisper action 'send'.");
				const message = requireMessage(params.message, "send");
				const urgency = parseUrgency(params.urgency ?? "soon");
				const result = await sendToAgent(registryDir, to, { from, fromId: id, message, urgency }, signal);
				return {
					content: [{ type: "text", text: `Sent message from ${from} to ${result.to}.` }],
					details: result,
				};
			}

			if (params.action === "ask") {
				const from = requireCurrentName(currentName);
				const to = requireNonEmpty(params.to, "to is required for Whisper action 'ask'.");
				const message = requireMessage(params.message, "ask");
				const urgency = parseUrgency(params.urgency ?? "interrupt");
				const timeoutMs = parseTimeoutMs(params.timeoutMs);
				const reply = await askAgent(to, { from, fromId: id, message, urgency }, timeoutMs, signal);
				return {
					content: [{ type: "text", text: `Whisper reply from ${reply.from}:\n\n${reply.message}` }],
					details: reply,
				};
			}

			if (params.action === "wait") {
				const timeoutMs = parseTimeoutMs(params.timeoutMs);
				const envelopes = await waitForInbox(timeoutMs, signal);
				const timedOut = envelopes.length === 0 && timeoutMs !== undefined;
				return {
					content: [{ type: "text", text: formatWaitResult(envelopes, timedOut) }],
					details: { envelopes, timedOut },
				};
			}

			if (params.action === "pending") {
				const asks = [...pendingInboundAsks.values()].sort((a, b) => a.receivedAt - b.receivedAt);
				return {
					content: [{ type: "text", text: formatPendingAsks(asks) }],
					details: { asks },
				};
			}

			if (params.action === "reply") {
				const from = requireCurrentName(currentName);
				const requestId = requireNonEmpty(params.requestId, "requestId is required for Whisper action 'reply'.");
				const message = requireMessage(params.message, "reply");
				const result = await replyToAsk(requestId, { from, fromId: id, message }, signal);
				return {
					content: [{ type: "text", text: `Replied to Whisper ask ${requestId}.` }],
					details: result,
				};
			}

			if (params.action === "update") {
				const extraFields = Object.keys(params).filter((key) => key !== "action" && key !== "description");
				if (extraFields.length > 0) {
					throw new Error(`Only description can be updated; unsupported field(s): ${extraFields.join(", ")}.`);
				}
				const name = requireCurrentName(currentName);
				if (typeof params.description !== "string") {
					throw new Error("description is required for Whisper action 'update'.");
				}
				currentDescription = params.description === "" ? undefined : params.description;
				if (activeCtx) await writeRecord(activeCtx);
				return {
					content: [{ type: "text", text: "Updated Whisper description." }],
					details: { id, name, description: currentDescription },
				};
			}

			throw new Error(`Unknown Whisper action: ${params.action}`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		await ensureServer();

		const requested = getConfiguredName(pi) ?? `pi-${process.pid}`;
		try {
			await activateName(requested, ctx, { allowFallback: requested !== `pi-${process.pid}` });
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
		for (const waiter of waiters.splice(0)) rejectWaiter(waiter, new Error("Whisper session is shutting down."));
		for (const ask of pendingOutboundAsks.values()) ask.reject(new Error("Whisper session is shutting down."));
		pendingOutboundAsks.clear();
		pendingInboundAsks.clear();
		inbox.splice(0);
		await closeServer(server);
		server = undefined;
		serverPort = undefined;
	});

	async function ensureServer() {
		if (server && serverPort !== undefined) return;

		server = createServer((req, res) => {
			void handleIncoming(req, res, pi, () => activeCtx, token, {
				enqueueInbound,
				pendingInboundAsks,
				pendingOutboundAsks,
			});
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

	async function activateName(name: string, ctx: ExtensionContext, options: { allowFallback: boolean }) {
		const validName = validateName(name);
		try {
			await publish(validName, ctx);
		} catch (error) {
			if (!options.allowFallback) throw error;
			const fallback = `pi-${process.pid}`;
			await publish(fallback, ctx);
			ctx.ui.notify(`${errorMessage(error)} Using fallback name ${fallback}.`, "warning");
		}
	}

	async function publish(name: string, ctx: ExtensionContext) {
		if (serverPort === undefined) throw new Error("Whisper server has not started.");

		await mkdir(registryDir, { recursive: true });

		const nextPath = getRecordPath(registryDir, id);
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
			id,
			name: currentName,
			pid: process.pid,
			host: DEFAULT_HOST,
			port: serverPort,
			token,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			description: currentDescription,
			startedAt,
			updatedAt: Date.now(),
		};
		await writeJsonAtomic(recordPath, record);
	}

	function enqueueInbound(envelope: InboundEnvelope) {
		const waiter = waiters.shift();
		if (waiter) {
			resolveWaiter(waiter, [envelope]);
			return;
		}

		inbox.push(envelope);
		if (inbox.length > INBOX_CAP) {
			inbox.shift();
			console.warn(`Whisper inbox exceeded ${INBOX_CAP} messages; dropped oldest envelope.`);
		}
	}

	function waitForInbox(timeoutMs: number | undefined, signal?: AbortSignal) {
		if (inbox.length > 0) return Promise.resolve(inbox.splice(0));
		return new Promise<InboundEnvelope[]>((resolve, reject) => {
			const waiter: InboxWaiter = { resolve, reject, signal };
			const remove = () => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
			};
			waiters.push(waiter);
			if (timeoutMs !== undefined) {
				waiter.timer = setTimeout(() => {
					remove();
					resolveWaiter(waiter, []);
				}, timeoutMs);
				waiter.timer.unref?.();
			}
			if (signal) {
				waiter.onAbort = () => {
					remove();
					rejectWaiter(waiter, new Error("Whisper wait aborted."));
				};
				if (signal.aborted) waiter.onAbort();
				else signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
		});
	}

	async function askAgent(
		to: string,
		payload: { from: string; fromId: string; message: string; urgency: Urgency },
		timeoutMs: number | undefined,
		signal?: AbortSignal,
	) {
		const target = await findAgentById(registryDir, to);
		if (!target) throw new Error(`No active Whisper agent with id \"${to}\".`);
		assertMessageSize(payload.message);

		const requestId = randomUUID();
		const frame: WhisperWireMessage = {
			id: requestId,
			from: payload.from,
			fromId: payload.fromId,
			message: payload.message,
			kind: "ask",
			urgency: payload.urgency,
			timestamp: Date.now(),
		};

		return new Promise<ReplyEnvelope>((resolve, reject) => {
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let monitor: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;

			const cleanup = () => {
				pendingOutboundAsks.delete(requestId);
				if (timeout) clearTimeout(timeout);
				if (monitor) clearInterval(monitor);
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			};
			const settleResolve = (reply: ReplyEnvelope) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(reply);
			};
			const settleReject = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const sendCancellation = (code: string, message: string) => {
				void postJson(target, {
					kind: "error",
					id: randomUUID(),
					requestId,
					from: payload.from,
					fromId: payload.fromId,
					code,
					message,
					timestamp: Date.now(),
				}).catch(() => undefined);
			};

			pendingOutboundAsks.set(requestId, { resolve: settleResolve, reject: settleReject });

			if (timeoutMs !== undefined) {
				timeout = setTimeout(() => {
					sendCancellation("expired", `Whisper ask ${requestId} expired.`);
					settleReject(new Error(`Whisper ask timed out after ${timeoutMs}ms.`));
				}, timeoutMs);
				timeout.unref?.();
			}

			monitor = setInterval(() => {
				void findAgentById(registryDir, to).then((record) => {
					if (!record) settleReject(new Error(`Whisper ask target ${target.name} (${target.id}) is unreachable.`));
				}).catch((error) => settleReject(new Error(`Whisper ask target ${target.name} (${target.id}) is unreachable: ${errorMessage(error)}`)));
			}, ASK_REGISTRY_POLL_MS);
			monitor.unref?.();

			if (signal) {
				onAbort = () => {
					sendCancellation("cancelled", `Whisper ask ${requestId} was cancelled by the sender.`);
					settleReject(new Error("Whisper ask aborted by caller."));
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			void postJson(target, frame, signal).catch((error) => {
				settleReject(new Error(`Whisper ask target ${target.name} (${target.id}) is unreachable: ${errorMessage(error)}`));
			});
		});
	}

	async function replyToAsk(requestId: string, payload: { from: string; fromId: string; message: string }, signal?: AbortSignal) {
		const ask = pendingInboundAsks.get(requestId);
		if (!ask) throw new Error(`No pending inbound Whisper ask with requestId \"${requestId}\".`);
		if (!ask.fromId) throw new Error(`Cannot reply to Whisper ask ${requestId}; sender id is missing.`);
		assertMessageSize(payload.message);

		const target = await findAgentById(registryDir, ask.fromId);
		if (!target) throw new Error(`No active Whisper agent with id \"${ask.fromId}\" for reply.`);

		await postJson(target, {
			kind: "reply",
			id: randomUUID(),
			requestId,
			from: payload.from,
			fromId: payload.fromId,
			message: payload.message,
			timestamp: Date.now(),
		}, signal);
		pendingInboundAsks.delete(requestId);

		return { requestId, to: ask.from, toId: ask.fromId, message: payload.message };
	}
}

async function handleIncoming(
	req: IncomingMessage,
	res: ServerResponse,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | undefined,
	token: string,
	state: {
		enqueueInbound(envelope: InboundEnvelope): void;
		pendingInboundAsks: Map<string, PendingInboundAsk>;
		pendingOutboundAsks: Map<string, PendingOutboundAsk>;
	},
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

		const body = await readRequestBody(req, MAX_WIRE_BYTES);
		const payload = JSON.parse(body) as WhisperWireMessage;
		if (payload.kind === "send") {
			const envelope = parseInboundEnvelope(payload, "send", "soon");
			state.enqueueInbound(envelope);
			injectInbound(pi, getCtx(), envelope);
			writeResponse(res, 200, { ok: true });
			return;
		}

		if (payload.kind === "ask") {
			const envelope = parseInboundEnvelope(payload, "ask", "interrupt");
			if (!envelope.requestId) throw new Error("ask requestId is required");
			state.pendingInboundAsks.set(envelope.requestId, {
				requestId: envelope.requestId,
				from: envelope.from,
				fromId: envelope.fromId,
				message: envelope.message,
				receivedAt: envelope.receivedAt,
			});
			state.enqueueInbound(envelope);
			injectInbound(pi, getCtx(), envelope);
			writeResponse(res, 200, { ok: true });
			return;
		}

		if (payload.kind === "reply") {
			const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
			const pending = requestId ? state.pendingOutboundAsks.get(requestId) : undefined;
			if (pending) {
				const from = typeof payload.from === "string" && payload.from.trim() ? payload.from.trim() : "unknown";
				const fromId = typeof payload.fromId === "string" && payload.fromId.trim() ? payload.fromId.trim() : undefined;
				const message = typeof payload.message === "string" ? payload.message : "";
				if (!message.trim()) pending.reject(new Error("Whisper reply message must be a non-empty string."));
				else pending.resolve({ requestId, from, fromId, message, timestamp: payload.timestamp });
			}
			writeResponse(res, 200, { ok: true });
			return;
		}

		if (payload.kind === "error") {
			const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
			if (requestId) {
				const pendingOutbound = state.pendingOutboundAsks.get(requestId);
				if (pendingOutbound) {
					const code = typeof payload.code === "string" && payload.code ? payload.code : "error";
					const message = typeof payload.message === "string" && payload.message ? payload.message : "Whisper ask failed.";
					pendingOutbound.reject(new Error(`Whisper ask failed (${code}): ${message}`));
				}
				state.pendingInboundAsks.delete(requestId);
			}
			writeResponse(res, 200, { ok: true });
			return;
		}

		throw new Error("Unsupported Whisper message kind.");
	} catch (error) {
		writeResponse(res, 400, { error: errorMessage(error) });
	}
}

function parseInboundEnvelope(payload: WhisperWireMessage, kind: InboundKind, defaultUrgency: Urgency): InboundEnvelope {
	const from = typeof payload.from === "string" && payload.from.trim() ? payload.from.trim() : "unknown";
	const fromId = typeof payload.fromId === "string" && payload.fromId.trim() ? payload.fromId.trim() : undefined;
	const id = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : randomUUID();
	const message = typeof payload.message === "string" ? payload.message : "";
	const urgency = parseUrgency(payload.urgency ?? defaultUrgency);
	if (!message.trim()) throw new Error("message must be a non-empty string");
	return {
		kind,
		id,
		from,
		fromId,
		message,
		requestId: kind === "ask" ? id : undefined,
		receivedAt: Date.now(),
		timestamp: payload.timestamp,
		urgency,
	};
}

function injectInbound(pi: ExtensionAPI, ctx: ExtensionContext | undefined, envelope: InboundEnvelope) {
	const customType = envelope.kind === "ask" ? "whisper-ask" : "whisper-send";
	const noun = envelope.kind === "ask" ? "ask" : "message";
	pi.sendMessage({
		customType,
		content: `Whisper ${noun} from ${envelope.from}:\n\n${envelope.message}`,
		display: true,
		details: {
			from: envelope.from,
			fromId: envelope.fromId,
			message: envelope.message,
			id: envelope.id,
			requestId: envelope.requestId,
			timestamp: envelope.timestamp,
		},
	}, { deliverAs: urgencyToDeliverAs(envelope.urgency), triggerTurn: envelope.urgency !== "later" });
	if (ctx?.hasUI) ctx.ui.notify(`Whisper ${noun} from ${envelope.from}`, "info");
}

async function sendToAgent(
	registryDir: string,
	to: string,
	payload: { from: string; fromId: string; message: string; urgency: Urgency },
	signal?: AbortSignal,
) {
	const target = await findAgentById(registryDir, to);
	if (!target) throw new Error(`No active Whisper agent with id \"${to}\".`);
	assertMessageSize(payload.message);

	await postJson(target, {
		id: randomUUID(),
		from: payload.from,
		fromId: payload.fromId,
		message: payload.message,
		kind: "send",
		urgency: payload.urgency,
		timestamp: Date.now(),
	}, signal);

	return { to: target.name, toId: target.id, host: target.host, port: target.port, urgency: payload.urgency };
}

async function postJson(target: AgentRecord, payload: WhisperWireMessage, signal?: AbortSignal) {
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
	return records.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function findAgentById(registryDir: string, id: string): Promise<AgentRecord | undefined> {
	const records = await listActiveAgents(registryDir);
	return records.find((record) => record.id === id);
}

function isActiveRecord(record: AgentRecord) {
	return (
		record &&
		record.version === PROTOCOL_VERSION &&
		typeof record.id === "string" &&
		typeof record.name === "string" &&
		typeof record.host === "string" &&
		typeof record.port === "number" &&
		typeof record.token === "string" &&
		Date.now() - record.updatedAt <= STALE_AFTER_MS
	);
}

function getConfiguredName(pi: ExtensionAPI) {
	const flagName = pi.getFlag("whisper-name");
	if (typeof flagName === "string" && flagName.trim()) return flagName.trim();
	if (process.env.PI_WHISPER_NAME?.trim()) return process.env.PI_WHISPER_NAME.trim();
	return undefined;
}

function validateName(name: string) {
	const trimmed = name.trim();
	if (!NAME_PATTERN.test(trimmed)) {
		throw new Error("Whisper names must be 1-64 characters: letters, numbers, dot, underscore, or dash.");
	}
	return trimmed;
}

function getRecordPath(registryDir: string, id: string) {
	const digest = createHash("sha256").update(id).digest("hex").slice(0, 24);
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

function formatAgentList(agents: AgentRecord[], currentId?: string) {
	if (agents.length === 0) return "No active Whisper agents found.";
	return agents
		.map((agent) => {
			const self = agent.id === currentId ? " (this agent)" : "";
			const age = Math.max(0, Math.round((Date.now() - agent.updatedAt) / 1000));
			const description = agent.description ? ` description=${agent.description}` : "";
			return `- ${agent.name}${self} id=${agent.id} pid=${agent.pid} cwd=${agent.cwd}${description} heartbeat=${age}s ago`;
		})
		.join("\n");
}

function formatWaitResult(envelopes: InboundEnvelope[], timedOut: boolean) {
	if (timedOut) return "No Whisper messages received before timeout.";
	if (envelopes.length === 0) return "No pending Whisper messages.";
	return envelopes.map((envelope) => {
		const requestId = envelope.requestId ? ` requestId=${envelope.requestId}` : "";
		return `- ${envelope.kind} from ${envelope.from}${requestId}: ${envelope.message}`;
	}).join("\n");
}

function formatPendingAsks(asks: PendingInboundAsk[]) {
	if (asks.length === 0) return "No pending Whisper asks.";
	return asks.map((ask) => `- requestId=${ask.requestId} from=${ask.from}: ${ask.message}`).join("\n");
}

function requireNonEmpty(value: string | undefined, message: string) {
	if (typeof value !== "string" || !value.trim()) throw new Error(message);
	return value.trim();
}

function requireMessage(value: string | undefined, action: string) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`message is required for Whisper action '${action}'.`);
	return value;
}

function requireCurrentName(name: string | undefined) {
	if (!name) throw new Error("Whisper is not registered yet. Set --whisper-name or PI_WHISPER_NAME first.");
	return name;
}

function parseUrgency(value: string): Urgency {
	if (value === "interrupt" || value === "soon" || value === "later") return value;
	throw new Error("Whisper urgency must be one of: interrupt, soon, later.");
}

function parseTimeoutMs(value: unknown) {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("timeoutMs must be a non-negative number.");
	}
	return value;
}

function assertMessageSize(message: string) {
	if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Message is too large for Whisper (64KB max).");
}

function urgencyToDeliverAs(urgency: Urgency) {
	if (urgency === "interrupt") return "steer";
	if (urgency === "later") return "nextTurn";
	return "followUp";
}

function resolveWaiter(waiter: InboxWaiter, envelopes: InboundEnvelope[]) {
	if (waiter.timer) clearTimeout(waiter.timer);
	if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	waiter.resolve(envelopes);
}

function rejectWaiter(waiter: InboxWaiter, error: Error) {
	if (waiter.timer) clearTimeout(waiter.timer);
	if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	waiter.reject(error);
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
