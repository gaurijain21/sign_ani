"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  AlertCircle,
  BookOpen,
  Database,
  Github,
  Hand,
  Info,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
} from "lucide-react"
import { AvatarDisplay } from "@/components/AvatarDisplay"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  fetchSignAnimation,
  loadSignDictionary,
  parseSentenceToQueue,
} from "@/lib/signDictionary"
import type { PlaybackQueueItem, SignData, SignDictionaryEntry } from "@/lib/types"

const DEFAULT_SENTENCE = "book drink computer"

function chipClass(status: PlaybackQueueItem["status"], active: boolean) {
  const base = "rounded-full border px-3 py-1 text-xs font-medium transition-colors"
  const activeClass = active ? " ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
  if (status === "available") {
    return `${base} bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800${activeClass}`
  }
  if (status === "skipped") {
    return `${base} bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-800${activeClass}`
  }
  return `${base} bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800${activeClass}`
}

export default function Home() {
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE)
  const [dictionary, setDictionary] = useState<SignDictionaryEntry[]>([])
  const [dictionarySource, setDictionarySource] = useState<"firebase" | "local">("local")
  const [dictionaryLoading, setDictionaryLoading] = useState(true)
  const [dictionaryError, setDictionaryError] = useState<string | null>(null)
  const [queue, setQueue] = useState<PlaybackQueueItem[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentSignData, setCurrentSignData] = useState<SignData | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isSignLoading, setIsSignLoading] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [showSkippedWords, setShowSkippedWords] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [dictionarySearch, setDictionarySearch] = useState("")

  useEffect(() => {
    loadSignDictionary()
      .then(({ entries, source }) => {
        setDictionary(entries)
        setDictionarySource(source)
      })
      .catch((error) => {
        setDictionaryError(error instanceof Error ? error.message : "Unable to load sign dictionary.")
      })
      .finally(() => setDictionaryLoading(false))
  }, [])

  const stats = useMemo(() => {
    const total = dictionary.length
    const available = dictionary.filter((entry) => entry.available).length
    const phrases = dictionary.filter((entry) => entry.type === "phrase").length
    const categories = new Set(dictionary.map((entry) => entry.category).filter(Boolean)).size
    return { total, available, phrases, categories }
  }, [dictionary])

  const filteredDictionary = useMemo(() => {
    const query = dictionarySearch.toLowerCase().trim()
    return dictionary
      .filter((entry) => {
        if (!query) return true
        return (
          entry.gloss.includes(query) ||
          entry.type.includes(query) ||
          entry.source.toLowerCase().includes(query) ||
          (entry.category || "").toLowerCase().includes(query)
        )
      })
      .slice(0, 80)
  }, [dictionary, dictionarySearch])

  const playableQueue = useMemo(
    () => queue.filter((item) => item.status === "available" && item.entry),
    [queue],
  )

  const currentItem = playableQueue[currentIndex] || null

  const buildQueue = useCallback(() => {
    const parsed = parseSentenceToQueue(sentence, dictionary, showSkippedWords)
    setQueue(parsed)
    setCurrentIndex(0)
    setCurrentSignData(null)
    setPlaybackError(null)
    setIsPlaying(parsed.some((item) => item.status === "available"))
  }, [sentence, dictionary, showSkippedWords])

  useEffect(() => {
    if (dictionary.length && queue.length === 0) {
      buildQueue()
    }
  }, [buildQueue, dictionary.length, queue.length])

  useEffect(() => {
    if (!isPlaying || !currentItem?.entry) return

    let cancelled = false
    setIsSignLoading(true)
    setPlaybackError(null)

    fetchSignAnimation(currentItem.entry)
      .then((data) => {
        if (!cancelled) setCurrentSignData(data)
      })
      .catch((error) => {
        if (!cancelled) {
          setCurrentSignData(null)
          setPlaybackError(error instanceof Error ? error.message : `Unable to load ${currentItem.gloss}.`)
        }
      })
      .finally(() => {
        if (!cancelled) setIsSignLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [currentItem, isPlaying])

  const goToNext = useCallback(() => {
    setCurrentIndex((index) => {
      if (index >= playableQueue.length - 1) {
        setIsPlaying(false)
        return index
      }
      return index + 1
    })
  }, [playableQueue.length])

  const goToPrevious = useCallback(() => {
    setCurrentIndex((index) => Math.max(0, index - 1))
    setIsPlaying(true)
  }, [])

  const replaySentence = useCallback(() => {
    setCurrentIndex(0)
    setCurrentSignData(null)
    setPlaybackError(null)
    setIsPlaying(playableQueue.length > 0)
  }, [playableQueue.length])

  const currentDisplayWord = currentItem?.gloss || sentence

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <motion.div
              className="flex items-center gap-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
                <Hand className="w-5 h-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">SignViz</h1>
                <p className="text-xs text-muted-foreground">Sentence-to-Sign Visualization</p>
              </div>
            </motion.div>

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => setShowInfo(!showInfo)}>
                <Info className="w-5 h-5" />
              </Button>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {showInfo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-primary/10 border-b border-primary/20"
          >
            <div className="container mx-auto px-4 py-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Educational research demo</p>
              <p className="mt-1">
                This visualizes sentence input using phrase-first matching and word-level fallback. It is not a complete
                ASL grammar translator; ASL grammar differs from English grammar.
              </p>
              <a
                href="https://github.com/dxli94/WLASL"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
              >
                <Github className="w-4 h-4" />
                WLASL dataset
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="container mx-auto px-4 py-4 md:py-8">
        <div className="grid gap-4 md:gap-6 xl:grid-cols-[minmax(0,1fr)_560px] xl:gap-8">
          <div className="contents xl:block xl:space-y-6">
            <section className="order-1 space-y-4">
              <div>
                <h2 className="text-3xl lg:text-4xl font-bold text-foreground text-balance">
                  Visualize a sentence as sequential signs
                </h2>
                <p className="text-muted-foreground mt-2">
                  Longest phrases are matched first, then individual words. Missing signs are shown clearly.
                </p>
              </div>

              <div className="space-y-3">
                <Textarea
                  value={sentence}
                  onChange={(event) => setSentence(event.target.value)}
                  placeholder="Type a sentence, e.g. good morning how are you"
                  className="min-h-28 text-base"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={buildQueue} disabled={dictionaryLoading || !sentence.trim()}>
                    {dictionaryLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Translate / Visualize Sentence
                  </Button>
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Switch checked={showSkippedWords} onCheckedChange={setShowSkippedWords} />
                    Show skipped words
                  </label>
                </div>
              </div>
            </section>

            <section className="order-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-foreground">Parsed playback queue</h3>
                <span className="text-xs text-muted-foreground">{playableQueue.length} playable signs</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {queue.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Enter a sentence to build a playback queue.</p>
                ) : (
                  queue.map((item) => {
                    const active = currentItem?.id === item.id
                    return (
                      <span key={item.id} className={chipClass(item.status, active)} title={item.reason}>
                        {item.gloss}
                        <span className="ml-1 opacity-70">({item.type})</span>
                      </span>
                    )
                  })
                )}
              </div>
              {queue.some((item) => item.status === "unavailable") && (
                <div className="space-y-1 text-sm text-red-600 dark:text-red-400">
                  {queue
                    .filter((item) => item.status === "unavailable")
                    .map((item) => (
                      <p key={item.id}>Sign unavailable: {item.text}</p>
                    ))}
                </div>
              )}
            </section>

            <section className="order-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="text-center p-3 rounded-xl bg-secondary/50">
                <div className="text-xl font-bold text-primary">{stats.total.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Dictionary Signs</div>
              </div>
              <div className="text-center p-3 rounded-xl bg-secondary/50">
                <div className="text-xl font-bold text-primary">{stats.available.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Processed</div>
              </div>
              <div className="text-center p-3 rounded-xl bg-secondary/50">
                <div className="text-xl font-bold text-primary">{stats.phrases.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Phrases</div>
              </div>
              <div className="text-center p-3 rounded-xl bg-secondary/50">
                <div className="text-xl font-bold text-primary capitalize">{dictionarySource}</div>
                <div className="text-xs text-muted-foreground">Dictionary Source</div>
              </div>
            </section>

            {dictionaryError && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-red-700 dark:text-red-300">{dictionaryError}</p>
              </div>
            )}

            <section className="order-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-foreground flex items-center gap-2">
                  <BookOpen className="w-4 h-4" />
                  Sign Dictionary
                </h3>
                <span className="text-xs text-muted-foreground">{stats.categories || 1} categories</span>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  value={dictionarySearch}
                  onChange={(event) => setDictionarySearch(event.target.value)}
                  placeholder="Search signs, source, category..."
                  className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
                />
              </div>
              <div className="max-h-72 overflow-auto rounded-xl border border-border">
                {filteredDictionary.map((entry) => (
                  <div key={`${entry.type}-${entry.gloss}`} className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
                    <div>
                      <p className="font-medium text-foreground">{entry.gloss}</p>
                      <p className="text-xs text-muted-foreground">{entry.category || "uncategorized"} · {entry.source}</p>
                    </div>
                    <span className="text-xs text-muted-foreground self-center">{entry.type}</span>
                    <span className={entry.available ? "text-xs text-green-600 self-center" : "text-xs text-red-600 self-center"}>
                      {entry.available ? "processed" : "not processed"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="order-2 h-fit xl:sticky xl:top-24"
          >
            <div className="bg-card border-2 border-border rounded-3xl overflow-hidden shadow-lg min-h-[430px] md:min-h-[560px] xl:min-h-[600px]">
              <AvatarDisplay
                signData={currentSignData}
                isLoading={isSignLoading}
                error={playbackError}
                searchedWord={currentDisplayWord}
                isPlaybackActive={isPlaying}
                signStatus={playbackError ? null : currentSignData ? "available" : null}
                onPlaybackComplete={goToNext}
                playbackKey={currentItem?.id}
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="icon" onClick={goToPrevious} disabled={currentIndex === 0}>
                <SkipBack className="w-4 h-4" />
              </Button>
              <Button variant="outline" onClick={() => setIsPlaying((value) => !value)} disabled={playableQueue.length === 0}>
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {isPlaying ? "Pause" : "Play"}
              </Button>
              <Button variant="outline" size="icon" onClick={goToNext} disabled={currentIndex >= playableQueue.length - 1}>
                <SkipForward className="w-4 h-4" />
              </Button>
              <Button variant="outline" onClick={replaySentence} disabled={playableQueue.length === 0}>
                <RotateCcw className="w-4 h-4" />
                Replay sentence
              </Button>
            </div>

            <div className="mt-3 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Database className="w-4 h-4" />
              <span>
                Current sign: {currentItem?.gloss || "none"} {currentItem ? `(${currentIndex + 1}/${playableQueue.length})` : ""}
              </span>
            </div>
          </motion.div>
        </div>
      </main>
    </div>
  )
}
