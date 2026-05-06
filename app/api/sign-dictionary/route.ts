import { NextResponse } from "next/server"
import { loadManifest } from "@/lib/manifest"
import type { SignDictionaryEntry } from "@/lib/types"

export async function GET() {
  const manifest = await loadManifest()

  if (!manifest) {
    return NextResponse.json({
      entries: [],
      stats: {
        total: 0,
        available: 0,
        source: "local",
      },
    })
  }

  const entries: SignDictionaryEntry[] = Object.values(manifest.entries)
    .map((entry) => ({
      gloss: entry.word,
      type: "word" as const,
      jsonPath: entry.jsonPath || `signs/${entry.word}.json`,
      available: Boolean(entry.landmarksAvailable),
      source: "WLASL",
      fps: 30,
      frameCount: undefined,
      aliases: [],
      category: "WLASL",
    }))
    .sort((a, b) => a.gloss.localeCompare(b.gloss))

  return NextResponse.json({
    entries,
    stats: {
      total: entries.length,
      available: entries.filter((entry) => entry.available).length,
      source: "local",
    },
  })
}
