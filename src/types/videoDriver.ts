export type DrivingInput = 'video' | 'audio'

export interface VideoDriver {
  kind: DrivingInput
  name: string
  label: string
}

export function validVideoDriverName(kind: DrivingInput, name: string): boolean {
  return kind === 'audio' ? /^aics_video_audio_[a-f0-9]{40}\.wav$/.test(name)
    : /^aics_video_motion_[a-f0-9]{40}\.mp4$/.test(name)
}
