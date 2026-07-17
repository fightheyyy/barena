import { TraceEvent } from "../domain/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface ModelClient {
  chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  call_id: string;
  status: "success" | "error" | "blocked" | "unsafe";
  content: string;
  artifacts?: string[];
  evidence?: string[];
}

export interface ToolExecutor {
  getToolDefinitions(): ToolDefinition[];
  executeTool(call: ToolCall): Promise<ToolResult>;
}

export interface SkillRegistry {
  load(): Promise<void> | void;
  list(): string[];
  get(skillName: string): string | null;
}

export interface RoleContract {
  id: string;
  display_name: string;
  prompt: string;
  allowed_tools: string[];
  tool_visibility?: "all" | "allowlist" | "denylist";
}

export interface EvidenceSink {
  writeTrace(events: TraceEvent[]): void;
  writeArtifact(relativePath: string, content: string): string;
}

