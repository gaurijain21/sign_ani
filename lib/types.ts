export interface Landmark {
  x: number
  y: number
  z?: number
}

export interface Frame {
  leftHand: Landmark[] | null
  rightHand: Landmark[] | null
  pose: Landmark[] | null
}

export interface SignData {
  word: string
  fps: number
  frames: Frame[]
  source?: "wlasl" | "mock"
  wordTimeline?: WordTimelineItem[]
}

export interface WordTimelineItem {
  word: string
  displayWord: string
  startFrame: number
  endFrame: number
}

export type MissingWordConfidence = "low" | "medium" | "high"

export interface MissingWordReplacement {
  originalWord: string
  replacementWord: string
  confidence: MissingWordConfidence
  reason: string
}

export type DictionaryEntryType = "word" | "phrase"

export interface SignDictionaryEntry {
  gloss: string
  type: DictionaryEntryType
  jsonPath: string
  jsonUrl?: string
  available: boolean
  source: string
  fps?: number
  frameCount?: number
  aliases?: string[]
  category?: string
}

export type PlaybackQueueItemStatus = "available" | "skipped" | "unavailable"

export interface PlaybackQueueItem {
  id: string
  text: string
  gloss: string
  type: DictionaryEntryType | "filler"
  status: PlaybackQueueItemStatus
  entry?: SignDictionaryEntry
  reason?: string
  replacement?: MissingWordReplacement
}

export interface SignMetadata {
  word: string
  description?: string
  category?: string
}

// WLASL Manifest Types
export interface ManifestEntry {
  word: string
  gloss: string
  videoPath: string | null
  videoPaths?: string[]
  jsonPath: string | null
  available?: boolean
  videoAvailable: boolean
  landmarksAvailable: boolean
  instanceCount: number
}

export interface SignManifest {
  version: string
  generatedAt: string
  wlaslPath: string
  stats: {
    totalWlaslWords: number
    videosDownloaded: number
    landmarksGenerated: number
  }
  entries: Record<string, ManifestEntry>
}

export type SignStatus = 
  | "available"           // Has landmark JSON, can play animation
  | "needs_processing"    // Has video but no landmarks
  | "not_downloaded"      // In WLASL but no video
  | "not_in_wlasl"        // Word doesn't exist in WLASL
