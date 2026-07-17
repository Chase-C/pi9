export {
  agentsDetails,
  backgroundStartedDetails,
  inventoryDetails,
  resultsDetails,
  runDetails,
  type AgentListingEntry,
  type AgentsDetails,
  type BackgroundPreflightError,
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
  formatSessionIdentityLine,
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
  formatSubagentToolLines,
  runSummary,
  type RunSummary,
} from "./tool-result-lines.js";
