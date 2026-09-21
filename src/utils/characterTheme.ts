import type { CSSProperties } from 'vue'

/**
 * Runtime character theme resolver.
 *
 * The director used to encode every character as a selector in tokens.css. That
 * made the entry stylesheet grow with the catalogue and made a new character
 * require a CSS edit. These values are the small set of existing, deliberately
 * tuned exceptions; characters without an exception use characters.json's
 * accent_color and CSS derives the remaining tokens from it.
 */
export interface CharacterThemeRecord {
  id?: unknown
  accent_color?: unknown
}

interface CharacterThemeOverride {
  accent: string
  aura?: string
  auraSecondary?: string
}

/** Existing visual calibrations moved out of the entry stylesheet. */
export const CHARACTER_THEME_OVERRIDES: Readonly<Record<string, CharacterThemeOverride>> = Object.freeze({
  akeno_himejima: { accent: '#9333ea', aura: 'rgba(147,51,234,.32)', auraSecondary: 'rgba(239,68,68,.22)' },
  akizuki_kanna: { accent: '#d5a4bd' },
  albedo_overlord: { accent: '#eab308', aura: 'rgba(234,179,8,.30)', auraSecondary: 'rgba(15,23,42,.28)' },
  alisa_mikhailovna_kujou: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  arcueid_brunestud: { accent: '#eab308', aura: 'rgba(234,179,8,.32)', auraSecondary: 'rgba(220,38,38,.22)' },
  arima_kana: { accent: '#d79baf', aura: 'rgba(215,155,175,.22)', auraSecondary: 'rgba(215,155,175,.14)' },
  artoria_pendragon: { accent: '#4fb3ff', aura: 'rgba(45,135,255,.34)', auraSecondary: 'rgba(245,200,75,.24)' },
  artoria_pendragon_alter: { accent: '#f59e0b', aura: 'rgba(245,158,11,.32)', auraSecondary: 'rgba(15,23,42,.28)' },
  asada_shino: { accent: '#9bb8c6' },
  asuka_langley: { accent: '#f87171', aura: 'rgba(248,113,113,.30)', auraSecondary: 'rgba(251,191,36,.22)' },
  asuma_toki: { accent: '#edc15a', aura: 'rgba(237,163,90,.30)', auraSecondary: 'rgba(212,237,90,.20)' },
  asuna_yuuki: { accent: '#e11d48', aura: 'rgba(225,29,72,.32)', auraSecondary: 'rgba(245,158,11,.22)' },
  ayanami_rei: { accent: '#93c5fd', aura: 'rgba(147,197,253,.30)', auraSecondary: 'rgba(248,113,113,.20)' },
  caren_hortensia: { accent: '#c084fc', aura: 'rgba(192,132,252,.30)', auraSecondary: 'rgba(220,38,38,.20)' },
  cartethyia: { accent: '#c4b995' },
  cc_code_geass: { accent: '#84cc16', aura: 'rgba(132,204,22,.30)', auraSecondary: 'rgba(245,158,11,.22)' },
  changli_wuthering: { accent: '#d79e8c' },
  chen_arknights: { accent: '#66d6c7', aura: 'rgba(102,214,177,.30)', auraSecondary: 'rgba(102,177,214,.20)' },
  cheshire_azur: { accent: '#38bdf8', aura: 'rgba(56,189,248,.32)', auraSecondary: 'rgba(16,185,129,.22)' },
  chitanda_eru: { accent: '#8b5cf6', aura: 'rgba(139,92,246,.32)', auraSecondary: 'rgba(16,185,129,.20)' },
  chloe_von_einzbern: { accent: '#d5a293' },
  ciel_tsukihime: { accent: '#2563eb', aura: 'rgba(37,99,235,.32)', auraSecondary: 'rgba(241,245,249,.24)' },
  dorothy_nikke: { accent: '#d4a9c3' },
  dusk_arknights: { accent: '#66d6c7', aura: 'rgba(102,214,177,.30)', auraSecondary: 'rgba(102,177,214,.20)' },
  elaina: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  elfaria_alvis_serfort: { accent: '#97bddd' },
  ellen_joe: { accent: '#ef4444', aura: 'rgba(239,68,68,.32)', auraSecondary: 'rgba(15,23,42,.28)' },
  emilia_rezero: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  ereshkigal_fate: { accent: '#60a5fa', aura: 'rgba(30,64,175,.34)', auraSecondary: 'rgba(253,230,138,.22)' },
  eris_greyrat: { accent: '#ef4444', aura: 'rgba(220,38,38,.32)', auraSecondary: 'rgba(245,158,11,.22)' },
  eunectes_arknights: { accent: '#edc15a', aura: 'rgba(237,163,90,.30)', auraSecondary: 'rgba(212,237,90,.20)' },
  exusiai_arknights: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  eyjafjalla_arknights: { accent: '#ec8db0', aura: 'rgba(236,141,195,.30)', auraSecondary: 'rgba(236,151,141,.20)' },
  fern_frieren: { accent: '#c08eeb', aura: 'rgba(173,142,235,.30)', auraSecondary: 'rgba(235,142,235,.20)' },
  frieren: { accent: '#88d4f5', aura: 'rgba(100,210,240,.30)', auraSecondary: 'rgba(210,235,255,.24)' },
  fubuki_one_punch: { accent: '#86ad9c' },
  furina: { accent: '#38bdf8', aura: 'rgba(56,189,248,.32)', auraSecondary: 'rgba(147,197,253,.22)' },
  futaba_rio: { accent: '#b1acbd' },
  golden_darkness: { accent: '#eab308', aura: 'rgba(234,179,8,.32)', auraSecondary: 'rgba(239,68,68,.24)' },
  goldenglow_arknights: { accent: '#66d6c7', aura: 'rgba(102,214,177,.30)', auraSecondary: 'rgba(102,177,214,.20)' },
  gotoh_hitori: { accent: '#f472b6', aura: 'rgba(244,114,182,.30)', auraSecondary: 'rgba(56,189,248,.20)' },
  harudera_yuria: { accent: '#f59e0b', aura: 'rgba(245,158,11,.32)', auraSecondary: 'rgba(30,41,59,.28)' },
  hatsune_miku: { accent: '#39c5bb', aura: 'rgba(57,197,187,.34)', auraSecondary: 'rgba(240,120,180,.22)' },
  hayasaka_ai: { accent: '#8ea9d7', aura: 'rgba(142,169,215,.22)', auraSecondary: 'rgba(142,169,215,.14)' },
  hayase_yuuka: { accent: '#60a5fa', aura: 'rgba(96,165,250,.30)', auraSecondary: 'rgba(45,212,191,.22)' },
  historia_reiss: { accent: '#eab308', aura: 'rgba(202,138,4,.34)', auraSecondary: 'rgba(125,211,252,.22)' },
  hitachi_mako: { accent: '#22c55e', aura: 'rgba(34,197,94,.30)', auraSecondary: 'rgba(15,23,42,.28)' },
  hori_kyouko: { accent: '#d2a475', aura: 'rgba(210,164,117,.22)', auraSecondary: 'rgba(210,164,117,.14)' },
  hoshimi_miyabi: { accent: '#38bdf8', aura: 'rgba(56,189,248,.32)', auraSecondary: 'rgba(241,245,249,.24)' },
  hoshino_ai: { accent: '#f43f5e', aura: 'rgba(225,29,72,.34)', auraSecondary: 'rgba(192,132,252,.24)' },
  hu_tao: { accent: '#fb7185', aura: 'rgba(251,113,133,.32)', auraSecondary: 'rgba(251,191,36,.20)' },
  ichinose_asuna: { accent: '#fbbf24', aura: 'rgba(251,191,36,.32)', auraSecondary: 'rgba(254,243,199,.22)' },
  ikaros: { accent: '#f472b6', aura: 'rgba(244,114,182,.32)', auraSecondary: 'rgba(56,189,248,.22)' },
  illyasviel_von_einzbern: { accent: '#e599f7', aura: 'rgba(215,130,245,.32)', auraSecondary: 'rgba(255,180,210,.22)' },
  ishtar_fate: { accent: '#eab308', aura: 'rgba(146,64,14,.32)', auraSecondary: 'rgba(59,130,246,.22)' },
  isshiki_iroha: { accent: '#f59e0b', aura: 'rgba(245,158,11,.30)', auraSecondary: 'rgba(236,72,153,.22)' },
  izumi_sagiri: { accent: '#a9bced', aura: 'rgba(169,188,237,.22)', auraSecondary: 'rgba(169,188,237,.14)' },
  jeanne_alter: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  jeanne_d_arc: { accent: '#60a5fa', aura: 'rgba(96,165,250,.32)', auraSecondary: 'rgba(251,191,36,.22)' },
  kafka: { accent: '#c084fc', aura: 'rgba(192,132,252,.30)', auraSecondary: 'rgba(244,114,182,.20)' },
  kaltsit_arknights: { accent: '#6cd08d', aura: 'rgba(108,208,121,.30)', auraSecondary: 'rgba(108,208,188,.20)' },
  kama_fate: { accent: '#c9a0b1' },
  kanroji_mitsuri: { accent: '#d69aaf' },
  kasugano_sora: { accent: '#b0b8cd' },
  kasumigaoka_utaha: { accent: '#ef4444', aura: 'rgba(127,29,29,.34)', auraSecondary: 'rgba(226,232,240,.22)' },
  katou_megumi: { accent: '#f43f5e', aura: 'rgba(244,63,94,.32)', auraSecondary: 'rgba(253,224,71,.20)' },
  kazami_kazuki: { accent: '#fca5a5', aura: 'rgba(252,165,165,.32)', auraSecondary: 'rgba(241,245,249,.24)' },
  kisara_engage_kiss: { accent: '#ec8db0', aura: 'rgba(236,141,195,.30)', auraSecondary: 'rgba(236,151,141,.20)' },
  kitagawa_marin: { accent: '#edc15a', aura: 'rgba(237,163,90,.30)', auraSecondary: 'rgba(212,237,90,.20)' },
  kochou_shinobu: { accent: '#a78bfa', aura: 'rgba(76,29,149,.32)', auraSecondary: 'rgba(249,168,212,.24)' },
  komine_sachi: { accent: '#f472b6', aura: 'rgba(244,114,182,.32)', auraSecondary: 'rgba(186,230,253,.22)' },
  kotegawa_yui: { accent: '#10b981', aura: 'rgba(16,185,129,.30)', auraSecondary: 'rgba(239,68,68,.20)' },
  krista_lenz: { accent: '#eab308', aura: 'rgba(202,138,4,.34)', auraSecondary: 'rgba(125,211,252,.22)' },
  kuonji_alice: { accent: '#9aa9ba' },
  kurokawa_akane: { accent: '#3b82f6', aura: 'rgba(37,99,235,.32)', auraSecondary: 'rgba(168,85,247,.22)' },
  kyouyama_kazusa: { accent: '#ec8db0', aura: 'rgba(236,141,195,.30)', auraSecondary: 'rgba(236,151,141,.20)' },
  laevatain_arknights: { accent: '#ea7571', aura: 'rgba(234,113,133,.30)', auraSecondary: 'rgba(234,173,113,.20)' },
  lala_satalin_deviluke: { accent: '#f43f5e', aura: 'rgba(244,63,94,.32)', auraSecondary: 'rgba(52,211,153,.22)' },
  lappland_arknights: { accent: '#c084fc', aura: 'rgba(192,132,252,.30)', auraSecondary: 'rgba(226,232,240,.24)' },
  lemuen_arknights: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  ling_arknights: { accent: '#d4a83c', aura: 'rgba(14,116,144,.30)', auraSecondary: 'rgba(212,168,60,.24)' },
  lucy_cyberpunk: { accent: '#c084fc', aura: 'rgba(192,132,252,.32)', auraSecondary: 'rgba(34,211,238,.24)' },
  makima: { accent: '#edc15a', aura: 'rgba(237,163,90,.30)', auraSecondary: 'rgba(212,237,90,.20)' },
  makinohara_shouko: { accent: '#9bafcb' },
  maomao: { accent: '#8cae9a' },
  marcille_donato: { accent: '#c5bd8e' },
  maria_mikhailovna_kujou: { accent: '#ceb79b' },
  mash_kyrielight: { accent: '#c084fc', aura: 'rgba(147,51,234,.32)', auraSecondary: 'rgba(96,165,250,.22)' },
  matou_sakura: { accent: '#c08eeb', aura: 'rgba(173,142,235,.30)', auraSecondary: 'rgba(235,142,235,.20)' },
  medea_caster: { accent: '#94a6d1' },
  medusa_rider: { accent: '#b09dcf' },
  mikasa_ackerman: { accent: '#e11d48', aura: 'rgba(159,18,57,.34)', auraSecondary: 'rgba(148,163,184,.22)' },
  mimori_byakuya: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  misaka_mikoto: { accent: '#ffb443', aura: 'rgba(255,160,40,.34)', auraSecondary: 'rgba(100,190,255,.22)' },
  misono_mika: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  momo_velia_deviluke: { accent: '#c084fc', aura: 'rgba(192,132,252,.32)', auraSecondary: 'rgba(244,114,182,.22)' },
  morgan_le_fay_fate: { accent: '#60a5fa', aura: 'rgba(30,58,138,.36)', auraSecondary: 'rgba(224,242,254,.24)' },
  mouri_ran: { accent: '#a9a1d0' },
  mudrock_arknights: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  murasame: { accent: '#86efac', aura: 'rgba(134,239,172,.32)', auraSecondary: 'rgba(56,189,248,.22)' },
  nana_asta_deviluke: { accent: '#fb7185', aura: 'rgba(251,113,133,.32)', auraSecondary: 'rgba(168,85,247,.20)' },
  natsume: { accent: '#fbb040', aura: 'rgba(251,176,64,.30)', auraSecondary: 'rgba(230,120,80,.20)' },
  nene: { accent: '#ff75a0', aura: 'rgba(183,132,246,.28)', auraSecondary: 'rgba(255,117,160,.20)' },
  perlica_arknights: { accent: '#66d6c7', aura: 'rgba(102,214,177,.30)', auraSecondary: 'rgba(102,177,214,.20)' },
  quillpen_arknights: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  raiden_shogun: { accent: '#b179ff', aura: 'rgba(148,85,255,.34)', auraSecondary: 'rgba(235,185,75,.22)' },
  raphtalia: { accent: '#c99473' },
  rem_rezero: { accent: '#68b8ff', aura: 'rgba(60,150,255,.32)', auraSecondary: 'rgba(210,140,240,.20)' },
  reze_chainsaw: { accent: '#ec8db0', aura: 'rgba(236,141,195,.30)', auraSecondary: 'rgba(236,151,141,.20)' },
  rias_gremory: { accent: '#e52b50', aura: 'rgba(229,43,80,.32)', auraSecondary: 'rgba(15,23,42,.24)' },
  roxy_migurdia: { accent: '#5cb3ff', aura: 'rgba(70,160,255,.32)', auraSecondary: 'rgba(170,120,230,.22)' },
  ryougi_shiki: { accent: '#dc2626', aura: 'rgba(220,38,38,.32)', auraSecondary: 'rgba(15,23,42,.24)' },
  saint_cecilia: { accent: '#6cd08d', aura: 'rgba(108,208,121,.30)', auraSecondary: 'rgba(108,208,188,.20)' },
  sakurajima_mai: { accent: '#91a8ff', aura: 'rgba(90,120,240,.32)', auraSecondary: 'rgba(240,160,210,.20)' },
  scathach_fate: { accent: '#a855f7', aura: 'rgba(168,85,247,.32)', auraSecondary: 'rgba(220,38,38,.24)' },
  shiina_mahiru: { accent: '#f59e0b', aura: 'rgba(245,158,11,.32)', auraSecondary: 'rgba(56,189,248,.20)' },
  shiina_mashiro: { accent: '#d6b586', aura: 'rgba(214,181,134,.22)', auraSecondary: 'rgba(214,181,134,.14)' },
  shinjou_akane: { accent: '#b79fca' },
  shinomiya_kaguya: { accent: '#e11d48', aura: 'rgba(153,27,27,.34)', auraSecondary: 'rgba(251,191,36,.22)' },
  shiranui_mai: { accent: '#cf9f94' },
  shirogane_kei: { accent: '#a6bbd3' },
  shiromi_iori: { accent: '#f87171', aura: 'rgba(248,113,113,.30)', auraSecondary: 'rgba(203,213,225,.24)' },
  shokuhou_misaki: { accent: '#fbbf24', aura: 'rgba(168,85,247,.28)', auraSecondary: 'rgba(252,211,77,.22)' },
  shorekeeper: { accent: '#9cbbda' },
  skadi_arknights: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  sorasaki_hina: { accent: '#ccd1e1', aura: 'rgba(204,213,225,.30)', auraSecondary: 'rgba(208,204,225,.20)' },
  sparkle_hsr: { accent: '#f43f5e', aura: 'rgba(244,63,94,.32)', auraSecondary: 'rgba(15,23,42,.24)' },
  suou_amane: { accent: '#f43f5e', aura: 'rgba(244,63,94,.34)', auraSecondary: 'rgba(30,58,138,.24)' },
  suou_yuki: { accent: '#b0a4cb' },
  surtr_arknights: { accent: '#edc15a', aura: 'rgba(237,163,90,.30)', auraSecondary: 'rgba(212,237,90,.20)' },
  suzuran_arknights: { accent: '#edc15a', aura: 'rgba(237,163,90,.30)', auraSecondary: 'rgba(212,237,90,.20)' },
  sylphiette: { accent: '#66d6c7', aura: 'rgba(102,214,177,.30)', auraSecondary: 'rgba(102,177,214,.20)' },
  tachibana_mikari: { accent: '#d8a4be' },
  taihou_azur: { accent: '#dc2626', aura: 'rgba(220,38,38,.34)', auraSecondary: 'rgba(245,158,11,.24)' },
  takarada_rikka: { accent: '#91b5dc', aura: 'rgba(145,181,220,.22)', auraSecondary: 'rgba(145,181,220,.14)' },
  tatsumaki: { accent: '#8abc9d' },
  texas_arknights: { accent: '#38bdf8', aura: 'rgba(56,189,248,.30)', auraSecondary: 'rgba(251,191,36,.20)' },
  tobiichi_origami: { accent: '#9dbce5' },
  togawa_sakiko: { accent: '#9facd1' },
  tohsaka_rin: { accent: '#e63946', aura: 'rgba(220,40,60,.34)', auraSecondary: 'rgba(80,150,240,.22)' },
  tokisaki_kurumi: { accent: '#e63956', aura: 'rgba(220,30,60,.34)', auraSecondary: 'rgba(220,170,60,.22)' },
  tomotake_yoshino: { accent: '#bae6fd', aura: 'rgba(186,230,253,.32)', auraSecondary: 'rgba(239,68,68,.20)' },
  triad: { accent: '#d9a4ef', aura: 'rgba(216,180,254,.28)', auraSecondary: 'rgba(242,187,104,.18)' },
  tsukatsuki_rio: { accent: '#ea7571', aura: 'rgba(234,113,133,.30)', auraSecondary: 'rgba(234,173,113,.20)' },
  ubel_frieren: { accent: '#7fba9b' },
  violet_evergarden: { accent: '#3b82f6', aura: 'rgba(59,130,246,.32)', auraSecondary: 'rgba(245,158,11,.22)' },
  viviana_arknights: { accent: '#fbbf24', aura: 'rgba(251,191,36,.32)', auraSecondary: 'rgba(253,230,138,.22)' },
  vivy: { accent: '#8fbad2' },
  vladilena_milize: { accent: '#f43f5e', aura: 'rgba(244,63,94,.32)', auraSecondary: 'rgba(203,213,225,.24)' },
  waguri_kaoruko: { accent: '#f59e0b', aura: 'rgba(245,158,11,.32)', auraSecondary: 'rgba(16,185,129,.22)' },
  yae_miko: { accent: '#d49eb9' },
  yamada_anna: { accent: '#3b82f6', aura: 'rgba(59,130,246,.32)', auraSecondary: 'rgba(244,63,94,.20)' },
  yanami_anna: { accent: '#9caed8' },
  yatogami_tohka: { accent: '#a794db' },
  yor_forger: { accent: '#ea7571', aura: 'rgba(234,113,133,.30)', auraSecondary: 'rgba(234,173,113,.20)' },
  yorha_2b: { accent: '#94a3b8', aura: 'rgba(148,163,184,.30)', auraSecondary: 'rgba(186,230,253,.22)' },
  yuigahama_yui: { accent: '#ee9e58', aura: 'rgba(238,128,88,.30)', auraSecondary: 'rgba(238,228,88,.20)' },
  yukinoshita_haruno: { accent: '#e11d48', aura: 'rgba(225,29,72,.34)', auraSecondary: 'rgba(59,130,246,.22)' },
  yukinoshita_yukino: { accent: '#78a6ff', aura: 'rgba(90,145,255,.32)', auraSecondary: 'rgba(180,210,255,.22)' },
  yuzuriha_inori: { accent: '#ff85ad', aura: 'rgba(255,115,160,.34)', auraSecondary: 'rgba(120,210,255,.22)' },
  yvonne_arknights: { accent: '#f59e0b', aura: 'rgba(217,119,6,.32)', auraSecondary: 'rgba(56,189,248,.22)' },
  zero_two: { accent: '#db9eae' },
})

const DEFAULT_THEME: CharacterThemeOverride = Object.freeze({
  accent: '#ff75a0',
  aura: 'rgba(183,132,246,.28)',
  auraSecondary: 'rgba(255,117,160,.20)',
})
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i

function recordFor(id: string, records: readonly CharacterThemeRecord[]): CharacterThemeRecord | undefined {
  return records.find(record => String(record?.id || '') === id)
}

function dataAccent(record: CharacterThemeRecord | undefined): string | undefined {
  const value = typeof record?.accent_color === 'string' ? record.accent_color.trim() : ''
  return HEX_COLOR.test(value) ? value : undefined
}

export function resolveCharacterTheme(id: string, records: readonly CharacterThemeRecord[] = []): CharacterThemeOverride {
  const override = CHARACTER_THEME_OVERRIDES[id]
  const accent = override?.accent || dataAccent(recordFor(id, records)) || DEFAULT_THEME.accent
  return {
    accent,
    aura: override?.aura || `color-mix(in srgb, ${accent} 22%, transparent)`,
    auraSecondary: override?.auraSecondary || `color-mix(in srgb, ${accent} 14%, transparent)`,
  }
}

/** CSS custom properties for the .pb host; derived values stay in CSS syntax. */
export function characterThemeStyle(id: string, records: readonly CharacterThemeRecord[] = []): CSSProperties {
  const theme = resolveCharacterTheme(id, records)
  return {
    '--character-accent': theme.accent,
    '--character-accent-hover': `color-mix(in srgb, ${theme.accent} 75%, white)`,
    '--character-soft': `color-mix(in srgb, ${theme.accent} 16%, transparent)`,
    '--character-glow': `color-mix(in srgb, ${theme.accent} 32%, transparent)`,
    '--character-aura': theme.aura || `color-mix(in srgb, ${theme.accent} 22%, transparent)`,
    '--character-aura-secondary': theme.auraSecondary || `color-mix(in srgb, ${theme.accent} 14%, transparent)`,
  } as CSSProperties
}

/** Only the document-level atmosphere needs to escape the .pb subtree. */
export function applyCharacterAtmosphere(id: string, records: readonly CharacterThemeRecord[] = []): void {
  if (typeof document === 'undefined') return
  const theme = resolveCharacterTheme(id, records)
  const root = document.documentElement
  root.style.setProperty('--character-aura', theme.aura || `color-mix(in srgb, ${theme.accent} 22%, transparent)`)
  root.style.setProperty('--character-aura-secondary', theme.auraSecondary || `color-mix(in srgb, ${theme.accent} 14%, transparent)`)
}

export function clearCharacterAtmosphere(): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.removeProperty('--character-aura')
  document.documentElement.style.removeProperty('--character-aura-secondary')
}
