import { promises as fs } from "fs"
import path from "path"
import type { SignManifest, ManifestEntry, SignStatus, SignData } from "./types"

// Path to the manifest file
const MANIFEST_PATH = path.join(process.cwd(), "data", "signManifest.json")
const SIGNS_PATH = path.join(process.cwd(), "data", "signs")

// Cache for manifest to avoid repeated file reads
let manifestCache: SignManifest | null = null
let manifestCacheTime: number = 0
const CACHE_TTL = 60000 // 1 minute cache

/**
 * Load the sign manifest from disk
 */
export async function loadManifest(): Promise<SignManifest | null> {
  const now = Date.now()
  
  // Return cached manifest if still valid
  if (manifestCache && now - manifestCacheTime < CACHE_TTL) {
    return manifestCache
  }
  
  try {
    const content = await fs.readFile(MANIFEST_PATH, "utf-8")
    manifestCache = JSON.parse(content) as SignManifest
    manifestCacheTime = now
    return manifestCache
  } catch {
    // Manifest doesn't exist yet - return null
    return null
  }
}

/**
 * Get the status of a word in the system
 */
export async function getWordStatus(word: string): Promise<{
  status: SignStatus
  entry: ManifestEntry | null
}> {
  const manifest = await loadManifest()
  const normalizedWord = word.toLowerCase().trim()
  
  if (!manifest) {
    return { status: "not_in_wlasl", entry: null }
  }
  
  const entry = manifest.entries[normalizedWord]
  
  if (!entry) {
    return { status: "not_in_wlasl", entry: null }
  }
  
  if (entry.landmarksAvailable) {
    return { status: "available", entry }
  }
  
  return { status: entry.videoAvailable ? "needs_processing" : "not_downloaded", entry }
}

/**
 * Load sign data for a word
 */
export async function loadSignData(word: string): Promise<{
  data: SignData | null
  source: "wlasl" | "mock"
  error: string | null
}> {
  const normalizedWord = word.toLowerCase().trim()
  const { status, entry } = await getWordStatus(normalizedWord)
  
  // If landmarks are available, try to load from JSON
  if (status === "available" && entry?.landmarksAvailable && entry.jsonPath) {
    try {
      const jsonPath = path.join(SIGNS_PATH, path.basename(entry.jsonPath))
      const content = await fs.readFile(jsonPath, "utf-8")
      const data = JSON.parse(content) as SignData
      return { data: { ...data, source: "wlasl" }, source: "wlasl", error: null }
    } catch {
      return {
        data: null,
        source: "mock",
        error: "This sign exists in WLASL but needs preprocessing.",
      }
    }
  }
  
  // Handle different statuses
  switch (status) {
    case "needs_processing":
      return {
        data: null,
        source: "mock",
        error: "This sign exists in WLASL but needs preprocessing.",
      }
    
    case "not_downloaded":
      return {
        data: null,
        source: "mock",
        error: "This sign exists in WLASL but needs preprocessing.",
      }
    
    case "not_in_wlasl":
      return {
        data: null,
        source: "mock",
        error: "This word is not available in the current WLASL dataset.",
      }
    
    default:
      return { data: null, source: "mock", error: "Sign not found" }
  }
}

/**
 * Get all available words from the manifest
 */
export async function getAvailableWords(): Promise<string[]> {
  const manifest = await loadManifest()
  
  if (!manifest) {
    return []
  }
  
  // Autocomplete should only expose WLASL words with downloaded/extracted videos.
  return Object.values(manifest.entries)
    .filter((entry) => entry.videoAvailable)
    .map((entry) => entry.word)
    .sort()
}

/**
 * Get all words in WLASL (regardless of availability)
 */
export async function getAllWlaslWords(): Promise<string[]> {
  const manifest = await loadManifest()
  
  if (!manifest) {
    return []
  }
  
  return Object.keys(manifest.entries).sort()
}

/**
 * Get suggested words for the UI
 */
export async function getSuggestedWords(): Promise<string[]> {
  const manifest = await loadManifest()
  
  // Prioritize WLASL words with landmarks
  if (manifest) {
    const available = Object.values(manifest.entries)
      .filter((entry) => entry.videoAvailable)
      .sort((a, b) => b.instanceCount - a.instanceCount) // Sort by popularity
      .slice(0, 8)
      .map((entry) => entry.word)
    
    return available
  }
  
  return []
}

/**
 * Get manifest statistics
 */
export async function getManifestStats(): Promise<{
  totalWlaslWords: number
  videosDownloaded: number
  landmarksGenerated: number
  manifestExists: boolean
}> {
  const manifest = await loadManifest()
  
  if (!manifest) {
    return {
      totalWlaslWords: 0,
      videosDownloaded: 0,
      landmarksGenerated: 0,
      manifestExists: false,
    }
  }
  
  return {
    totalWlaslWords: manifest.stats.totalWlaslWords,
    videosDownloaded: manifest.stats.videosDownloaded,
    landmarksGenerated: manifest.stats.landmarksGenerated,
    manifestExists: true,
  }
}

/**
 * Search for words matching a query
 */
export async function searchWords(query: string, limit: number = 10): Promise<{
  word: string
  status: SignStatus
}[]> {
  const normalizedQuery = query.toLowerCase().trim()
  
  if (!normalizedQuery) {
    return []
  }
  
  const manifest = await loadManifest()
  
  const results: { word: string; status: SignStatus; score: number }[] = []
  
  if (manifest) {
    for (const entry of Object.values(manifest.entries)) {
      const word = entry.word.toLowerCase()
      
      // Calculate match score
      let score = 0
      if (word === normalizedQuery) {
        score = 100
      } else if (word.startsWith(normalizedQuery)) {
        score = 50
      } else if (word.includes(normalizedQuery)) {
        score = 25
      } else {
        continue
      }
      
      // Boost available signs
      if (entry.landmarksAvailable) {
        score += 10
      } else if (entry.videoAvailable) {
        score += 5
      }
      
      let status: SignStatus
      if (entry.landmarksAvailable) {
        status = "available"
      } else if (entry.videoAvailable) {
        status = "needs_processing"
      } else {
        status = "not_downloaded"
      }
      
      results.push({ word, status, score })
    }
  }
  
  // Sort by score and return top results
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ word, status }) => ({ word, status }))
}
