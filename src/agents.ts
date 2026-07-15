// An agent is an installed on-disk package (see main.ts). The catalog now lives
// in `registry/` and the user's library in userData/agents — both loaded over IPC.
export type Agent = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  examplePrompt: string;
  version?: string;
  author?: string;
  source?: string;
  commands?: AgentCommand[];
  category?: string; // marketplace shelf, e.g. "Career"
  tagline?: string; // one-liner shown on the marketplace card
  featured?: boolean; // surfaced in the featured row
};
export type AgentCommand = { command: string; label: string };
