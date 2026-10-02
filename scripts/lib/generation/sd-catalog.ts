// SD model and LoRA filenames used by offline showcase planning.
export const CHECKPOINT = 'waiIllustriousSDXL_v170.safetensors';

export const LORAS: Record<string, {
    file: string;
    character: string;
    min: number;
    max: number;
}> = Object.freeze({
    L_NENE_V18_WD14: { file: 'ayachi_nene_v18_wd14.safetensors', character: 'nene', min: 0.65, max: 1 },
    L_NAT_V18_WD14: { file: 'shiki_natsume_v18_wd14.safetensors', character: 'natsume', min: 0.65, max: 1 }
});
