import { test, expect } from "vitest";
import { TaskQueue } from "../../src/runtime/task-queue.js";
test("a parent lease suspends and reacquires around recursive queued work", async () => {
 const queue=new TaskQueue(1); const order:string[]=[];
 await queue.enqueue(async lease=>{ order.push("parent"); await lease.suspendDuring(()=>queue.enqueue(async()=>{order.push("child")})); order.push("parent-resumed"); });
 expect(order).toEqual(["parent","child","parent-resumed"]);
});
