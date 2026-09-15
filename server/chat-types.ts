export interface ChatConfigLocation {
  RUNTIME: { state: string };
}

export interface HostChatConfig {
  baseUrl: string;
  pathname: string;
  model: string;
  apiKey: string;
}

export interface UserProfile {
  callName: string;
  relationship: 'atelier_owner' | 'friend' | 'confidant' | 'lover';
  note: string;
}

export type Normalized<Value> = { value: Value; error?: never } | { error: string; value?: never };

export interface CharacterPromptContext {
  userProfile?: unknown;
  memories?: unknown;
}
