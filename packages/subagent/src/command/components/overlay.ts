import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, type Component, type Focusable, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../../domain/agent-config.js";
import type { AgentRunSnapshot, AgentSnapshot } from "../../domain/agent-snapshot.js";
import type { AgentManager } from "../../runtime/agent-manager.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "../../config/settings.js";
import { projectConversations } from "../overlay-view-model.js";
import { SubagentSettingsComponent, type SubagentSettingsChange } from "./settings.js";

export type SubagentOverlayPage = "conversations" | "agents" | "settings";
type Focus = "list" | "prompt" | "output";
export interface OverlayOptions {
  initialPage: SubagentOverlayPage; agents: readonly AgentConfig[]; settings: SubagentSettings;
  notify(message: string, level?: string): void;
  onSettingsChange(change: SubagentSettingsChange): SubagentSettings | void;
  onStart(agent: string, prompt: string): string | undefined;
  onResume(conversationId: string, prompt: string): void;
  onRemove?(conversationId: string): void;
}
interface RunRow { conversation: AgentSnapshot; run: AgentRunSnapshot }
export class SubagentOverlayComponent implements Component, Focusable {
  private page: SubagentOverlayPage; private selected = 0; private focus: Focus = "list"; private _focused = false;
  private readonly prompt = new Input(); private output?: RunRow; private promptConversationId?: string; private readonly unsubscribe: () => void;
  private readonly settings: SubagentSettingsComponent;
  constructor(private readonly manager: AgentManager, private readonly tui: Pick<TUI,"requestRender">, private readonly theme: Theme, keys: KeybindingsManager | undefined, private readonly done: () => void, private readonly options: OverlayOptions) {
    this.page = options.initialPage;
    this.unsubscribe = manager.onAgentUpdate(() => tui.requestRender());
    this.prompt.onEscape = () => { this.focus = "list"; this.promptConversationId=undefined; this.prompt.setValue(""); this.syncFocus(); };
    this.prompt.onSubmit = value => this.submit(value);
    const settings = options.settings?.runtime && options.settings?.display ? options.settings : DEFAULT_SUBAGENT_SETTINGS;
    this.settings = new SubagentSettingsComponent(settings, theme, keys as any, change => options.onSettingsChange(change), () => { this.page="conversations"; this.tui.requestRender(); }, () => this.tui.requestRender());
  }
  get focused() { return this._focused; } set focused(value: boolean) { this._focused=value; this.syncFocus(); }
  handleInput(data: string): void {
    if (this.focus === "prompt") { this.prompt.handleInput(data); this.tui.requestRender(); return; }
    if (this.output) {
      if (data === "r" && this.canResume(this.output)) { const conversationId=this.output.conversation.conversationId; this.output=undefined; this.openPrompt(conversationId); }
      else if (data === "\x1b" || data === "q") this.output=undefined;
      this.tui.requestRender();
      return;
    }
    if (data === "\x1b" || data === "q") return this.done();
    if (data === "\t") { this.page = this.page === "agents" ? "conversations" : this.page === "conversations" ? "settings" : "agents"; this.selected=0; this.tui.requestRender(); return; }
    if (this.page === "settings") { this.settings.handleInput(data); return; }
    if (data === "\x1b[A") this.selected=Math.max(0,this.selected-1);
    else if (data === "\x1b[B") this.selected++;
    else if (this.page === "agents" && (data === "\r" || data === "s")) this.openPrompt();
    else if (this.page === "conversations") this.conversationAction(data);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const title=this.output ? `Run ${this.output.run.runId} output` : this.page === "conversations" ? "Conversations" : this.page === "agents" ? "Agents" : "Settings";
    const lines=[`╭─ ${title} ${"─".repeat(Math.max(0,width-title.length-5))}╮`];
    if (this.output) lines.push(...this.renderOutput(width-4));
    else if (this.page === "conversations") lines.push(...this.renderConversations());
    else if (this.page === "agents") lines.push(...this.renderAgents(width-4));
    else lines.push(...this.settings.render(width-4).map(line=>`  ${line}`));
    lines.push(`╰${"─".repeat(Math.max(0,width-2))}╯`); return lines;
  }
  invalidate(): void { this.prompt.invalidate(); this.settings.invalidate(); this.tui.requestRender(); }
  dispose(): void { this.unsubscribe(); }
  private get rows(): RunRow[] { return projectConversations(this.manager.listConversations(),{mode:"tree",query:""}).flatMap(({conversation})=>conversation.runs.map(run=>({conversation,run}))); }
  private renderConversations(): string[] {
    const rows=this.rows; if(!rows.length)return["  No conversations."]; this.selected=Math.min(this.selected,rows.length-1);
    const line=(row:RunRow,i:number)=>{const s=row.run.status.kind==="done"?row.run.status.outcome:row.run.status.kind; const actions=i===this.selected&&row.run.status.kind==="done"?` · [Enter] output${this.canResume(row)?" · [r] resume":""}`:""; return `${i===this.selected?"▶":" "} ${row.conversation.config.name}${row.conversation.label?` · ${row.conversation.label}`:""} · ${row.run.runId} · ${row.conversation.conversationId} · ${s}${actions}`;};
    const active=rows.map((row,i)=>({row,i})).filter(x=>x.row.run.status.kind!=="done"); const done=rows.map((row,i)=>({row,i})).filter(x=>x.row.run.status.kind==="done");
    const lines=["  Active Runs",...(active.length?active.map(x=>line(x.row,x.i)):["  None"]),"","  Completed Runs",...(done.length?done.map(x=>line(x.row,x.i)):["  None"])];
    if(this.focus==="prompt") lines.push("",...this.prompt.render(76).map(x=>`  ${x}`));
    return lines;
  }
  private renderAgents(width:number): string[] { if(!this.options.agents.length)return["  No agents."]; this.selected=Math.min(this.selected,this.options.agents.length-1); const lines=this.options.agents.map((a,i)=>`${i===this.selected?"▶":" "} ${a.name} · ${a.description}`); if(this.focus==="prompt") lines.push("",...(this.prompt.render(width).map(x=>`  ${x}`))); return lines; }
  private renderOutput(width:number): string[] { const output=this.output!.run.status.kind==="done" ? this.output!.run.status.output || this.output!.run.status.error || "No output." : "Run is not complete."; const lines=new Markdown(output,0,0,markdownTheme(this.theme)).render(width).map(x=>`  ${x}`); if(this.canResume(this.output!)) lines.push("", "  [r] Resume conversation"); return lines; }
  private conversationAction(data:string): void { const row=this.rows[this.selected]; if(!row)return; if(data==="c"||data==="x"){this.options.onRemove?.(row.conversation.conversationId);return;} if(data==="r"&&this.canResume(row)){this.openPrompt(row.conversation.conversationId);return;} if(data==="\r"&&row.run.status.kind==="done")this.output=row; }
  private canResume(row:RunRow): boolean { return row.conversation.capabilities.canResume && row.conversation.runs.at(-1)?.runId===row.run.runId && row.run.status.kind==="done"; }
  private openPrompt(conversationId?:string): void { this.promptConversationId=conversationId; this.focus="prompt"; this.prompt.setValue(""); this.syncFocus(); }
  private submit(value:string): void { const text=value.trim(); if(!text)return; try { if(this.page==="agents"){const agent=this.options.agents[this.selected]; if(agent)this.options.onStart(agent.name,text);} else {const conversationId=this.promptConversationId; const row=this.rows.find(candidate=>candidate.conversation.conversationId===conversationId&&this.canResume(candidate)); if(!row){this.options.notify("Conversation is no longer available to resume.","warning");return;} this.options.onResume(row.conversation.conversationId,text);} this.promptConversationId=undefined; this.prompt.setValue(""); this.focus="list"; this.syncFocus(); } catch(error){this.options.notify(error instanceof Error?error.message:String(error),"warning");} }
  private syncFocus():void { this.prompt.focused=this._focused&&this.focus==="prompt"; }
}
function markdownTheme(theme:Theme):MarkdownTheme { const color=(name:any)=>(text:string)=>theme.fg?.(name,text)??text; return {heading:color("mdHeading"),link:color("mdLink"),linkUrl:color("mdLinkUrl"),code:color("mdCode"),codeBlock:color("mdCodeBlock"),codeBlockBorder:color("mdCodeBlockBorder"),quote:color("mdQuote"),quoteBorder:color("mdQuoteBorder"),hr:color("mdHr"),listBullet:color("mdListBullet"),bold:t=>theme.bold?.(t)??t,italic:t=>theme.italic?.(t)??t,strikethrough:t=>theme.strikethrough?.(t)??t,underline:t=>t}; }
