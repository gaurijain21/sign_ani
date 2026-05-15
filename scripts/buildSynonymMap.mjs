#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"

const DEFAULT_THESAURUS_URL =
  "https://raw.githubusercontent.com/zaibacu/thesaurus/master/en_thesaurus.jsonl"

function normalizeWord(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s']/g, " ")
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function parseArgs(argv) {
  const args = {
    help: false,
    manifest: "data/signManifest.json",
    thesaurus: "",
    output: "public/data/synonymMap.json",
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") args.help = true
    if (arg === "--manifest") args.manifest = argv[++index] || args.manifest
    if (arg === "--thesaurus") args.thesaurus = argv[++index] || args.thesaurus
    if (arg === "--output") args.output = argv[++index] || args.output
  }

  return args
}

function printHelp() {
  console.log(`Usage: node scripts/buildSynonymMap.mjs [options]

Options:
  --manifest <path>   Sign manifest path (default: data/signManifest.json)
  --thesaurus <path>  Local zaibacu en_thesaurus.jsonl path. If omitted, downloads from GitHub.
  --output <path>     Output JSON path (default: public/data/synonymMap.json)
  -h, --help          Show this help text
`)
}

async function loadManifestWords(manifestPath) {
  const raw = await fs.readFile(manifestPath, "utf8")
  const manifest = JSON.parse(raw)
  const words = new Set()

  Object.values(manifest.entries || {}).forEach((entry) => {
    if (!entry?.landmarksAvailable) return
    const normalized = normalizeWord(entry.word || entry.gloss)
    if (normalized) words.add(normalized)
  })

  return words
}

async function loadThesaurusJsonl(source) {
  if (!source || /^https?:\/\//i.test(source)) {
    const url = source || DEFAULT_THESAURUS_URL
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Unable to download thesaurus JSONL: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }

  return fs.readFile(source, "utf8")
}

function candidateScore(candidate, dictionaryWords) {
  if (!dictionaryWords.has(candidate)) return Number.POSITIVE_INFINITY
  const phrasePenalty = candidate.includes(" ") ? 2 : 0
  return phrasePenalty + candidate.length / 100
}

function chooseDictionarySynonym(synonyms, dictionaryWords, sourceWord) {
  return synonyms
    .map(normalizeWord)
    .filter((candidate) => candidate && candidate !== sourceWord)
    .sort((a, b) => candidateScore(a, dictionaryWords) - candidateScore(b, dictionaryWords))
    .find((candidate) => dictionaryWords.has(candidate))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const dictionaryWords = await loadManifestWords(args.manifest)
  const thesaurusJsonl = await loadThesaurusJsonl(args.thesaurus)
  const synonymMap = {}

  thesaurusJsonl.split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let entry
    try {
      entry = JSON.parse(trimmed)
    } catch {
      console.warn(`[buildSynonymMap] Skipping invalid JSON on line ${lineIndex + 1}`)
      return
    }

    const word = normalizeWord(entry.word)
    if (!word || dictionaryWords.has(word) || synonymMap[word]) return
    if (!Array.isArray(entry.synonyms)) return

    const mappedWord = chooseDictionarySynonym(entry.synonyms, dictionaryWords, word)
    if (mappedWord) {
      synonymMap[word] = mappedWord
    }
  })

  await fs.mkdir(path.dirname(args.output), { recursive: true })
  await fs.writeFile(args.output, `${JSON.stringify(synonymMap, null, 2)}\n`, "utf8")
  console.log(`[buildSynonymMap] wrote ${Object.keys(synonymMap).length} mappings to ${args.output}`)
}

main().catch((error) => {
  console.error("[buildSynonymMap]", error)
  process.exit(1)
})
