pub const CHECKPOINT: &str = "waiIllustriousSDXL_v170.safetensors";
pub const MODEL: &str = "waiIllustriousSDXL_v170";
pub const MAX_PENDING: usize = 4;
pub const MAX_JSON: usize = 8 * 1024 * 1024;
pub const MAX_IMAGE: usize = 16 * 1024 * 1024;
pub const UPSCALERS: &[&str] = &[
    "Auto",
    "Remacri",
    "Latent",
    "Latent (nearest-exact)",
    "R-ESRGAN 4x+ Anime6B",
    "R-ESRGAN 4x+",
];
pub const SUPER_RES: &[&str] = &["Remacri", "R-ESRGAN 4x+ Anime6B", "R-ESRGAN 4x+"];
pub const SUPER_RES_FILES: &[&str] = &[
    "4x_foolhardy_Remacri.safetensors",
    "R-ESRGAN 4x+ Anime6B.pth",
    "RealESRGAN_x4plus.pth",
];
pub const ALLOWED: &[&str] = &[
    "prompt",
    "negative",
    "profile",
    "modelId",
    "character",
    "loras",
    "width",
    "height",
    "steps",
    "cfg",
    "seed",
    "sampler",
    "scheduler",
    "hiresFix",
    "hiresScale",
    "hiresUpscaler",
    "hiresSteps",
    "denoisingStrength",
    "faceDetailer",
    "adultEnabled",
];
pub const LORAS: &[(&str, &str, &str)] = &[
    (
        "L_NENE_V18_WD14",
        "ayachi_nene_v18_wd14.safetensors",
        "nene",
    ),
    (
        "L_NAT_V18_WD14",
        "shiki_natsume_v18_wd14.safetensors",
        "natsume",
    ),
];
pub fn sampler(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "DPM++ 2M" => Some(("dpmpp_2m", "normal")),
        "DPM++ 2M Karras" => Some(("dpmpp_2m", "karras")),
        "Euler a" => Some(("euler_ancestral", "normal")),
        "Euler" => Some(("euler", "normal")),
        _ => None,
    }
}
