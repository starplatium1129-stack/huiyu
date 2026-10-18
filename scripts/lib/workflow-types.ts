type WorkflowEffect = 'read-only' | 'preview' | 'self-heal-missing' | 'guard'
  | 'writes-source' | 'writes-product' | 'writes-release'
  | 'delete' | 'external-model' | 'network-download' | 'publish-remote' | 'service';
type WorkflowMachine = 'node' | 'windows' | 'windows-toolchain' | 'python' | 'python-pillow'
  | 'gateway' | 'comfyui' | 'vision-api' | 'network' | 'build-present';
interface WorkflowRun {
  nature: WorkflowEffect[];
  machine: WorkflowMachine[];
  switches?: Record<string, WorkflowEffect[]>;
  resume: 'idempotent' | 'checkpoint' | 'na';
  evidence: string | string[];
  unknown?: string[];
  notes?: string[];
}
export interface WorkflowDefinition {
  cmd?: string[] | null;
  steps?: string[];
  builtin?: 'audit';
  desc?: string;
  docs?: string;
  required?: string[];
  opts?: string;
  needs?: string;
  run?: WorkflowRun;
}
export type WorkflowRegistry = Record<string, WorkflowDefinition>;
export type RegisteredWorkflows = Record<string, WorkflowDefinition & { run: WorkflowRun }>;
export interface WorkflowStep { name: string; args: string[]; def: WorkflowDefinition }
