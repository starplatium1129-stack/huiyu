import type { ProfileDomain } from '../../types/profile';

export const PROFILE_CHAT_KEYS = ['aics_chat_v1', 'aics_chat_archive_v1', 'aics_chat_memories_v1',
  'aics_user_profile_v1', 'aics_retired_companion_chat_v1', 'aics_chat_reset_v1'] as const
export const PROFILE_SETTING_KEYS = ['aics_desktop_start_page', 'aics_desktop_last_page', 'aics_theme',
  'aics_interface_sound_v1', 'aics_sd_last_success_v1', 'aics_pb_director_mode', 'aics_scene_favorites',
  'aics_recent_scenes', 'aics_hidden_scenes', 'aics_scene_usage_v1', 'aics_show_mature', 'aics_tunnel_off',
  'aics_chat_model', 'aics_chat_api_drafts', 'aics_chat_thinking_v1', 'aics_chat_volume_v1',
  'aics_companion_live2d_v1', 'aics_live2d_quality_v1', 'aics_stage_framing_v1', 'aics_companion_behavior_v1',
  'aics_companion_affection_v1', 'aics_speech_input_v1', 'aics_draw_engine', 'aics_guest_guide_dismissed',
  'aics_auto_save_to_gallery', 'aics_backup_last_at', 'aics-artist-usage', 'aics-voice-studio-collapsed',
  'aics_managed_route_collapsed_v1', 'aics_managed_route_dismissed_v1', 'atelier-desktop-appearance-v1'] as const
export const PROFILE_DRAFT_KEYS = ['aics_pb_last_draft', 'aics_video_ctx', 'aics_video_shots_ctx',
  'aics_video_scenario_ctx', 'aics_video_draft_v1', 'aics_video_shots_draft_v1', 'aics_pb_temp_result_v1'] as const
export function profileDomainForKey(key: string): ProfileDomain | null {
  if ((PROFILE_CHAT_KEYS as readonly string[]).includes(key)) return 'chat'
  if ((PROFILE_SETTING_KEYS as readonly string[]).includes(key)) return 'settings'
  if ((PROFILE_DRAFT_KEYS as readonly string[]).includes(key) || key.startsWith('aics_chat_draft_v1:') || key.startsWith('aics-model-draft-')) return 'draft'
  return null
}
