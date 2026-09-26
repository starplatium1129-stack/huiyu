/** Runtime request DTOs are optional at the boundary because malformed JSON is
 * still possible; handlers validate before invoking the service. */
export interface TranslateRequest { text?: string }
export interface VoicePrepareRequest { voice?: string; translation?: boolean }
export interface TtsRequest {
  voice?: string
  text?: string
  language?: string
  emotion?: string
  referenceEmotion?: string
  consistency?: string
  speed?: number
}
