export {
  agentsDetails,
  backgroundResultsDetails,
  backgroundStartedDetails,
  inventoryDetails,
  runDetails,
  runResultsDetails,
  type AgentListingEntry,
  type AgentsDetails,
  type BackgroundResultsDetails,
  type BackgroundSpawnHandle,
  type BackgroundStartedDetails,
  type InventoryDetails,
  type InventoryFilter,
  type RemoveSummary,
  type RemoveSummaryDetails,
  type RunDetails,
  type RunResultsDetails,
  type SubagentDetails,
} from "./details.js";

export {
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSessionLine,
  formatRunSessionLine,
  formatWidgetLines,
} from "./session-lines.js";

export {
  createSubagentTextComponent,
  formatAgentConfigInspect,
  formatAgentConfigSummary,
  formatSubagentToolLines,
} from "./tool-result-lines.js";
