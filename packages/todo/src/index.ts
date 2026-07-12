import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodoTool } from "./tool.js";

export default function todoExtension(pi: ExtensionAPI): void {
  registerTodoTool(pi);
}
