import { OUTPUT_SNIPPET_LENGTH, PROMPT_PREVIEW_LENGTH, compact } from "./view-helpers.js";

const RESUME_MESSAGE_SNIPPET_LENGTH = 80;

export interface SubagentResumeMessageDetails {
  sessionId: string;
  agent: string;
  status: string;
  promptPreview: string;
  outputSnippet?: string;
  errorSnippet?: string;
  result?: unknown;
}

export interface SubagentResumeMessage {
  customType: "subagent-resume";
  content: string;
  display: true;
  details: SubagentResumeMessageDetails;
}

export function createSubagentResumeMessage(result: {
  agent: string;
  prompt: string;
  status: string;
  output?: string;
  error?: string;
  sessionId?: string;
}): SubagentResumeMessage {
  const promptPreview = compact(result.prompt, PROMPT_PREVIEW_LENGTH);
  const outputSnippet = result.output ? compact(result.output, OUTPUT_SNIPPET_LENGTH) : undefined;
  const errorSnippet = result.error ? compact(result.error, OUTPUT_SNIPPET_LENGTH) : undefined;
  const sessionId = result.sessionId ?? "unknown";
  const details: SubagentResumeMessageDetails = {
    sessionId,
    agent: result.agent,
    status: result.status,
    promptPreview,
    outputSnippet,
    errorSnippet,
    result,
  };

  return {
    customType: "subagent-resume",
    display: true,
    content: formatSubagentResumeMessageContent(details),
    details,
  };
}

export function formatSubagentResumeMessageContent(details: SubagentResumeMessageDetails): string {
  const title = details.status === "completed" ? "Subagent resume completed" : `Subagent resume ${details.status}`;
  const parts = [
    title,
    `agent: ${details.agent}`,
    `session: ${details.sessionId}`,
    `prompt: ${details.promptPreview}`,
  ];
  if (details.outputSnippet) parts.push(`output: ${compact(details.outputSnippet, RESUME_MESSAGE_SNIPPET_LENGTH)}`);
  if (details.errorSnippet) parts.push(`error: ${compact(details.errorSnippet, RESUME_MESSAGE_SNIPPET_LENGTH)}`);
  return parts.join(" · ");
}
