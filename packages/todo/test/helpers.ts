import type { Todo, TodoStatus, TodoTaskInput } from "../src/types.js";

export function describedTask(name: string, description = `Detailed description for ${name}.`): TodoTaskInput {
  return { name, description };
}

export function todo(
  name: string,
  status: TodoStatus = "pending",
  description = `Detailed description for ${name}.`,
): Todo {
  return { name, description, status };
}
