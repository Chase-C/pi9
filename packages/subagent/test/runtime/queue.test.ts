import { test, expect } from "vitest";
import { RunQueue } from "../../src/scheduler.js";
test("a parent lease suspends and reacquires around recursive queued work", async () => {
 const queue=new RunQueue(1); const order:string[]=[];
 await queue.enqueue(async lease=>{ order.push("parent"); await lease.suspendDuring(()=>queue.enqueue(async()=>{order.push("child")})); order.push("parent-resumed"); });
 expect(order).toEqual(["parent","child","parent-resumed"]);
});

test("abandoning a suspended task does not retain its reacquired slot", async () => {
  const queue = new RunQueue(1);
  let releaseSuspension!: () => void;
  let releaseBlocker!: () => void;
  let releaseParent!: () => void;
  let suspensionStarted!: () => void;
  const suspension = new Promise<void>(done => { releaseSuspension = done; });
  const blocker = new Promise<void>(done => { releaseBlocker = done; });
  const parent = new Promise<void>(done => { releaseParent = done; });
  const enteredSuspension = new Promise<void>(done => { suspensionStarted = done; });
  const task = queue.enqueueCancellable(async lease => {
    await lease.suspendDuring(() => { suspensionStarted(); return suspension; });
    await parent;
    return "finished";
  });
  await enteredSuspension;
  const blockingTask = queue.enqueue(async () => { await blocker; });
  await new Promise(done => setImmediate(done));

  releaseSuspension();
  await Promise.resolve();
  expect(task.abandon("abandoned")).toBe(true);
  let probeStarted = false;
  const probe = queue.enqueue(async () => { probeStarted = true; });
  releaseBlocker();
  await blockingTask;
  await new Promise(done => setImmediate(done));
  await new Promise(done => setImmediate(done));

  const releasedCapacity = probeStarted;
  releaseParent();
  await probe;
  expect(releasedCapacity).toBe(true);
});
