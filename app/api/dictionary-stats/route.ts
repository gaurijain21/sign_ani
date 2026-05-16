import { promises as fs } from "fs"
import path from "path"
import { NextResponse } from "next/server"
import { loadManifest } from "@/lib/manifest"

const PRIMARY_SYNONYM_MAP_PATH = path.join(process.cwd(), "public", "data", "synonymMap.json")
const MANUAL_SYNONYM_MAP_PATH = path.join(process.cwd(), "public", "data", "manualSynonymMap.json")

function normalizeWord(word: string) {
  return word
    .toLowerCase()
    .replace(/[^\w\s'-]/g, " ")
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

async function readSynonymMap() {
  const readJson = async (filePath: string) => {
    const raw = await fs.readFile(filePath, "utf-8")
    return JSON.parse(raw) as Record<string, unknown>
  }

  try {
    return {
      synonymMap: await readJson(PRIMARY_SYNONYM_MAP_PATH),
      synonymFilePathLoaded: PRIMARY_SYNONYM_MAP_PATH,
      warning: null as string | null,
    }
  } catch (error) {
    const warning = `[dictionary-stats] primary synonym map unavailable at ${PRIMARY_SYNONYM_MAP_PATH}; falling back to manual map.`
    console.warn(warning, error)
    try {
      return {
        synonymMap: await readJson(MANUAL_SYNONYM_MAP_PATH),
        synonymFilePathLoaded: MANUAL_SYNONYM_MAP_PATH,
        warning,
      }
    } catch (manualError) {
      const manualWarning = `[dictionary-stats] manual synonym map unavailable at ${MANUAL_SYNONYM_MAP_PATH}; continuing with no synonyms.`
      console.warn(manualWarning, manualError)
      return {
        synonymMap: {},
        synonymFilePathLoaded: "",
        warning: `${warning} ${manualWarning}`,
      }
    }
  }
}

export async function GET() {
  const manifest = await loadManifest()
  const originalWords = new Set<string>()

  if (manifest) {
    Object.values(manifest.entries).forEach((entry) => {
      if (entry.landmarksAvailable && entry.word.trim()) {
        originalWords.add(normalizeWord(entry.word))
      }
    })
  }

  const { synonymMap, synonymFilePathLoaded, warning } = await readSynonymMap()

  const synonymEntries = Object.entries(synonymMap)
    .map(([word, mappedWord]) => ({
      word: normalizeWord(word),
      mappedWord: typeof mappedWord === "string" ? normalizeWord(mappedWord) : "",
    }))
    .filter((entry) => entry.word && entry.mappedWord)
  const resolvableSynonymEntries = synonymEntries.filter((entry) => originalWords.has(entry.mappedWord))

  const uniqueResolvableWords = new Set(originalWords)
  resolvableSynonymEntries.forEach((entry) => uniqueResolvableWords.add(entry.word))

  const sampleSynonymMappings = resolvableSynonymEntries.slice(0, 20)
  const debugStats = {
    synonymFilePathLoaded,
    originalWordCount: originalWords.size,
    synonymEntryCount: resolvableSynonymEntries.length,
    uniqueResolvableWordCount: uniqueResolvableWords.size,
    sampleSynonymMappings,
    warning,
  }
  console.log("[dictionary-stats]", debugStats)

  return NextResponse.json({
    synonymFilePathLoaded,
    originalWordCount: originalWords.size,
    synonymEntryCount: resolvableSynonymEntries.length,
    uniqueResolvableWordCount: uniqueResolvableWords.size,
    sampleSynonymMappings,
    warning,
  })
}
