export type SubagentResumeCommandResult = { action: "resume"; sessionId: string; agent: string };
export type SubagentsCommandResult = SubagentResumeCommandResult | { action: "settings" };
