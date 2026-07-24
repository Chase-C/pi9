export interface Persona {
  name: string;
  description?: string;
  instructions: string;
  sourcePath: string;
}

export interface PersonaStateSnapshot {
  activeName: string | null;
  baselineName: string | null;
}

export type CycleDirection = "next" | "previous";
