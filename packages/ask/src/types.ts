export type AskOption = {
  label: string;
  description?: string;
};

export type AskParams = {
  question: string;
  context?: string;
  options?: AskOption[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  answered?: boolean;
};

export type ValidatedAskParams = {
  question: string;
  context?: string;
  options: AskOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
};

export type AskAnswer = {
  selections: Array<AskOption & { comment?: string }>;
  freeform?: string;
};

export type AskToolDetails =
  | { status: "answered"; question: string; answer: AskAnswer }
  | { status: "cancelled"; question: string }
  | { status: "ui_unavailable"; question: string };

export type AskResponse = {
  content: Array<{ type: "text"; text: string }>;
  details: AskToolDetails;
};
