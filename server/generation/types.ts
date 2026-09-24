import type { ImageGenerationConfig, ImageJobInput } from '../../routes/anima/types';
export interface GenerationConfig extends ImageGenerationConfig {
    SD_HOST: string | URL;
    SD_API_AUTH?: string;
    RUNTIME_ROOT: string;
}
/** Normalized WAI request. Raw network fields are unknown until validation. */
export interface GenerationInput extends ImageJobInput {
    cleanPrompt: string;
    profile: string;
    character: unknown;
    loras: Array<{
        id: string;
        strength: number;
        file: string;
    }>;
    loraTags: Array<{
        name: string;
        weight: number;
    }>;
    webuiScheduler: string;
    comfyUnsupported: boolean;
    hiresUpscaler: string;
    hiresSteps: number;
    denoisingStrength: number;
    faceDetailer: boolean;
    autoHires: boolean;
    superResWanted: boolean;
    comfyHires: boolean;
}
export interface WebUIStatus {
    online: boolean;
    waiAvailable: boolean;
    checkpoint: string;
    samplers: string[];
    schedulers: string[];
    upscalers: string[];
    models: string[];
}
export interface GenerationStatus {
    online: boolean;
    provider: 'comfy' | 'webui' | null;
    webuiOnline: boolean;
    comfyFallbackOnline: boolean;
    checkpoint: string;
    samplers: string[];
    schedulers: string[];
    models: string[];
    loras: Array<{
        id: string;
        character: string;
        available: boolean;
    }>;
    capabilities: {
        basic: boolean;
        hires: boolean;
        hiresUpscalers: string[];
        faceDetailer: boolean;
        superResModel?: string | null;
    };
    pending: number;
    maxPending: number;
    webuiPending?: number;
    comfyPending?: number;
}
export interface WebUIJob {
    id: string;
    owner: string;
    input: GenerationInput;
    provider: 'webui';
    status: string;
    result: Buffer | null;
    mime?: string;
    error: string | null;
    code: string | number | null;
    metadata: Record<string, unknown>;
    /** Bound at admission: settings changes must not redirect an existing job's interrupt. */
    connection?: Pick<GenerationConfig, 'SD_HOST' | 'SD_API_AUTH'>;
    execution?: Promise<void>;
    cancellation?: Promise<void>;
    requestAbort?: AbortController;
    queueAbort?: AbortController;
    admissionRelease?: () => void;
    gcTimer?: ReturnType<typeof setTimeout> | null;
}
