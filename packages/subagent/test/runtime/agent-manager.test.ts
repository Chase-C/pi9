import { test, expect } from "vitest";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const registry = { agents: new Map([["worker", config]]) } as any;
const ctx = { cwd: "/tmp" } as any;
const session = () => ({ messages: [], subscribe: () => () => {}, abort() {}, steer() {}, getSteeringMessages(){return[]}, getFollowUpMessages(){return[]} }) as any;
const runner = async (_: any, agent: any, attempt: any) => { agent.bindSession(session()); return completedRun(agent, attempt.runId, attempt.prompt); };

test("ordered starts reserve capacity atomically and resumes are allowed at capacity", async () => {
 const manager = new AgentManager(registry, 2, runner, 1);
 const batch = manager.startRun(ctx, [{kind:"spawn",agent:"worker",prompt:"one"},{kind:"spawn",agent:"worker",prompt:"two"}] as any);
 expect(batch.starts.map(x=>x.ok)).toEqual([true,false]); expect((batch.starts[1] as any).error).toContain("Remove terminal conversations");
 await batch.completion; const first = batch.starts[0] as any;
 const resumed = manager.startRun(ctx,[{kind:"resume",conversationId:first.conversationId,prompt:"again"}] as any); await resumed.completion;
 expect((resumed.starts[0] as any).conversationId).toBe(first.conversationId); expect((resumed.starts[0] as any).runId).not.toBe(first.runId);
 expect(manager.conversation(first.conversationId).runs.map(r=>r.runId)).toEqual([first.runId,(resumed.starts[0] as any).runId]);
});

test("joins exact historical runs, reject atomically, and remain stable across resume", async () => {
 const manager = new AgentManager(registry,1,runner); const a=manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"old"}] as any); await a.completion;
 const first=a.starts[0] as any; const bad=`missing-run` as any; expect(()=>manager.bindJoin([first.runId,bad])).toThrow();
 expect(manager.conversation(first.conversationId).runs[0].observerCount).toBe(0);
 const join=manager.bindJoin([first.runId]); expect(manager.conversation(first.conversationId).runs[0].observerCount).toBe(1);
 const b=manager.startRun(ctx,[{kind:"resume",conversationId:first.conversationId,prompt:"new"}] as any); await b.completion;
 expect((await join.completion)[0]).toMatchObject({status:"completed",output:"old"}); join.release();
});

test("removal terminalizes immediately, wakes joins, removes lookup, and descendants survive", async () => {
 let release!:()=>void; const gate=new Promise<void>(r=>release=r); let physical=false;
 const slow=async (_:any,agent:any,attempt:any)=>{ agent.bindSession({...session(),abort(){physical=true; return gate}}); await gate; return completedRun(agent,attempt.runId,"late") };
 const manager=new AgentManager(registry,2,slow); const parent=manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"p"}] as any); const p=parent.starts[0] as any;
 await new Promise(r=>setImmediate(r)); const child=manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"c"}] as any,{parentConversationId:p.conversationId}); const c=child.starts[0] as any;
 const join=manager.bindJoin([p.runId]); const removed=manager.removeConversation(p.conversationId);
 expect(removed.aborted).toBe(1); expect(manager.listConversations().map(x=>x.conversationId)).toContain(c.conversationId); expect(()=>manager.bindJoin([p.runId])).toThrow();
 expect(await join.completion).toEqual([{status:"aborted",error:"Conversation removed."}]); expect(physical).toBe(true); release();
});

test("subtree join discovers late children and grandchildren and waits in root-first order", async () => {
 const gates = new Map<string, () => void>();
 const controlled = async (_: any, agent: any, attempt: any) => {
  agent.bindSession(session()); await new Promise<void>(resolve => gates.set(attempt.prompt, resolve));
  return completedRun(agent, attempt.runId, attempt.prompt);
 };
 const manager = new AgentManager(registry, 8, controlled);
 const rootStart = manager.startRun(ctx, [{kind:"spawn",agent:"worker",prompt:"root"}] as any); const root = rootStart.starts[0] as any;
 await new Promise(r => setImmediate(r)); const join = manager.bindJoin([root.runId]);
 const childStart = manager.startRun(ctx, [{kind:"spawn",agent:"worker",prompt:"child"}] as any, {parentConversationId:root.conversationId,parentRunId:root.runId}); const child = childStart.starts[0] as any;
 await new Promise(r => setImmediate(r)); const grandStart = manager.startRun(ctx, [{kind:"spawn",agent:"worker",prompt:"grand"}] as any, {parentConversationId:child.conversationId,parentRunId:child.runId}); const grand = grandStart.starts[0] as any;
 await new Promise(r => setImmediate(r)); gates.get("root")!(); await rootStart.completion;
 let finished = false; void join.completion.then(() => { finished = true; }); await new Promise(r => setImmediate(r)); expect(finished).toBe(false);
 gates.get("grand")!(); await grandStart.completion; expect(finished).toBe(false); gates.get("child")!(); await childStart.completion;
 expect(join.project().map(x => [x.runId, x.conversationId])).toEqual([[root.runId,root.conversationId],[child.runId,child.conversationId],[grand.runId,grand.conversationId]]);
 expect((await join.completion).map(x => x.output)).toEqual(["root","child","grand"]); join.release();
});

test("subtree join retains an already-bound descendant after its conversation is removed", async () => {
 let releaseRoot!:()=>void; const rootGate=new Promise<void>(resolve=>releaseRoot=resolve);
 const controlled=async (_:any,agent:any,attempt:any)=>{ agent.bindSession(session()); if(attempt.prompt==="root") await rootGate; return completedRun(agent,attempt.runId,attempt.prompt); };
 const manager=new AgentManager(registry,4,controlled);
 const rootStart=manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"root"}] as any); const root=rootStart.starts[0] as any;
 await new Promise(r=>setImmediate(r)); const childStart=manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"child"}] as any,{parentConversationId:root.conversationId,parentRunId:root.runId}); const child=childStart.starts[0] as any;
 await childStart.completion; const join=manager.bindJoin([root.runId]);
 expect(join.project().map(x=>x.runId)).toEqual([root.runId,child.runId]);
 manager.removeConversation(child.conversationId); releaseRoot(); await rootStart.completion;
 expect(join.project().map(x=>x.runId)).toEqual([root.runId,child.runId]);
 expect(await join.completion).toEqual([{status:"completed",output:"root"},{status:"completed",output:"child"}]); join.release();
});

test("children of a resumed run do not attach to an older run join", async () => {
 const manager = new AgentManager(registry, 4, runner); const firstStart = manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"old"}] as any); await firstStart.completion; const first=firstStart.starts[0] as any;
 const oldJoin=manager.bindJoin([first.runId]); const resumedStart=manager.startRun(ctx,[{kind:"resume",conversationId:first.conversationId,prompt:"new"}] as any); await resumedStart.completion; const resumed=resumedStart.starts[0] as any;
 const child=manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"new-child"}] as any,{parentConversationId:first.conversationId,parentRunId:resumed.runId}); await child.completion;
 expect(oldJoin.project().map(x=>x.runId)).toEqual([first.runId]); oldJoin.release();
});

test("spawn execution is independent of caller cancellation ownership", async()=>{ const manager=new AgentManager(registry,1,runner); const controller=new AbortController(); const batch=manager.startRun(ctx,[{kind:"spawn",agent:"worker",prompt:"ok"}] as any); controller.abort(); await batch.completion; const s=batch.starts[0] as any; expect(manager.conversation(s.conversationId).runs[0].status).toMatchObject({kind:"done",outcome:"completed"}); });
