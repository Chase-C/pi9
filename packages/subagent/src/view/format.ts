export {
  agentsDetails,
  backgroundStartedDetails,
  inventoryDetails,
  resultsDetails,
  runDetails,
  type AgentListingEntry,
  type AgentsDetails,
  type BackgroundSpawnHandle,
  type BackgroundStartedDetails,
  type InventoryDetails,
  type InventoryFilter,
  type RemoveSummary,
  type RemoveSummaryDetails,
  type ResultsDetails,
  type RunDetails,
  type SubagentDetails,
} from "./details.js";

export {
  buildWidgetModel,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSessionLine,
  formatRunSessionLine,
  formatWidgetLines,
  hasBackgroundAncestor,
  stringifyWidgetModel,
  type WidgetModel,
  type WidgetRow,
  type WidgetSection,
  type WidgetSectionTitle,
} from "./session-lines.js";

export {
  createSubagentTextComponent,
  formatAgentConfigInspect,
  formatAgentConfigSummary,
  formatSubagentToolLines,
  runSummary,
  type RunSummary,
} from "./tool-result-lines.js";
