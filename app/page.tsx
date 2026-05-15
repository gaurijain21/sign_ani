"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  AlertCircle,
  Github,
  Hand,
  Info,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react"
import { AvatarDisplay } from "@/components/AvatarDisplay"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  fetchFingerspellingAnimation,
  fetchSignAnimation,
  loadSignDictionary,
  resolveSentenceWithAI,
} from "@/lib/signDictionary"
import { buildSentenceAnimation, type SentenceAnimationResult } from "@/lib/sentenceAnimation"
import type { MissingWordReplacement, PlaybackQueueItem, SignData, SignDictionaryEntry } from "@/lib/types"

const DEFAULT_SENTENCE = "Type a word here"

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
  const [dictionaryLoading, setDictionaryLoading] = useState(true)
  const [dictionaryError, setDictionaryError] = useState<string | null>(null)
  const [queue, setQueue] = useState<PlaybackQueueItem[]>([])
  const [currentSignData, setCurrentSignData] = useState<SignData | null>(null)
  const [sentenceAnimation, setSentenceAnimation] = useState<SentenceAnimationResult | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isSignLoading, setIsSignLoading] = useState(false)
  const [isResolvingWords, setIsResolvingWords] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [playbackVersion, setPlaybackVersion] = useState(0)
  const [showSkippedWords, setShowSkippedWords] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [aiReplacements, setAiReplacements] = useState<MissingWordReplacement[]>([])
  const [aiUnresolved, setAiUnresolved] = useState<string[]>([])
  const [aiUnavailable, setAiUnavailable] = useState(false)

  useEffect(() => {
    loadSignDictionary()
      .then(({ entries }) => {
        setDictionary(entries)
      })
      .catch((error) => {
        setDictionaryError(error instanceof Error ? error.message : "Unable to load sign dictionary.")
      })
      .finally(() => setDictionaryLoading(false))
  }, [])

  const playableQueue = useMemo(
    () => queue.filter((item) => item.status === "available" && (item.entry || item.type === "fingerspell")),
    [queue],
  )

  const buildQueue = useCallback(async () => {
    setIsResolvingWords(true)
    setAiReplacements([])
    setAiUnresolved([])
    setAiUnavailable(false)

    const resolved = await resolveSentenceWithAI(sentence, dictionary, showSkippedWords)
    setQueue(resolved.queue)
    setAiReplacements(resolved.replacements)
    setAiUnresolved(resolved.unresolved)
    setAiUnavailable(resolved.aiUnavailable)
    setCurrentSignData(null)
    setSentenceAnimation(null)
    setPlaybackError(null)
    setPlaybackVersion((version) => version + 1)
    setIsPlaying(resolved.queue.some((item) => item.status === "available"))
    setIsResolvingWords(false)
  }, [sentence, dictionary, showSkippedWords])

  useEffect(() => {
    if (dictionary.length && queue.length === 0) {
      void buildQueue()
    }
  }, [buildQueue, dictionary.length, queue.length])

  useEffect(() => {
    if (!isPlaying) return
    if (currentSignData?.frames.length && sentenceAnimation) return
    if (playableQueue.length === 0) {
      setCurrentSignData(null)
      setSentenceAnimation(null)
      return
    }

    let cancelled = false
    setIsSignLoading(true)
    setPlaybackError(null)

    Promise.allSettled(
      playableQueue.map((item) =>
        item.type === "fingerspell"
          ? fetchFingerspellingAnimation(item.text, item.fingerspellLetters || [])
          : fetchSignAnimation(item.entry!),
      ),
    )
      .then((results) => {
        if (cancelled) return

        const animationMap = new Map<string, SignData>()
        const failedWords: string[] = []

        results.forEach((result, index) => {
          const word = playableQueue[index].gloss
          if (result.status === "fulfilled") {
            animationMap.set(word, result.value)
          } else {
            failedWords.push(word)
          }
        })

        const words = playableQueue.map((item) => item.gloss)
        const built = buildSentenceAnimation(words, animationMap, { debug: true })
        const missingWords = [...built.missingWords, ...failedWords.filter((word) => !built.missingWords.includes(word))]
        const firstLoadedAnimation = results.find(
          (result): result is PromiseFulfilledResult<SignData> => result.status === "fulfilled",
        )?.value

        setSentenceAnimation({ ...built, missingWords })
        if (!built.frames.length) {
          setCurrentSignData(null)
          setPlaybackError("Unable to build a playable sentence animation.")
          setIsPlaying(false)
          return
        }

        setCurrentSignData({
          word: sentence.trim() || words.join(" "),
          fps: firstLoadedAnimation?.fps || 30,
          frames: built.frames,
          source: "wlasl",
          wordTimeline: built.wordTimeline,
          metadata: {
            fingerspelledWords: playableQueue
              .filter((item) => item.type === "fingerspell")
              .map((item) => item.text),
          },
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setCurrentSignData(null)
          setSentenceAnimation(null)
          setPlaybackError(error instanceof Error ? error.message : "Unable to load sentence animation.")
          setIsPlaying(false)
        }
      })
      .finally(() => {
        if (!cancelled) setIsSignLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [currentSignData, isPlaying, playableQueue, sentence, sentenceAnimation])

  const goToNext = useCallback(() => {
    setIsPlaying(false)
  }, [])

  const goToPrevious = useCallback(() => {
    setPlaybackVersion((version) => version + 1)
    setIsPlaying(true)
  }, [])

  const handleSentenceComplete = useCallback(() => {
    setPlaybackVersion((version) => version + 1)
    setIsPlaying(playableQueue.length > 0)
  }, [playableQueue.length])

  const currentDisplayWord = currentSignData?.word || sentence

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
                <h1 className="text-xl font-bold text-foreground">SignWiz</h1>
                <p className="text-xs text-muted-foreground">Learn and understand sign language effortlessly.</p>
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
                  Visualize a sentence as one blended sign timeline
                </h2>
                <p className="text-muted-foreground mt-2">
                  A simple and accessible platform helping kids, schools, and communities learn sign language through guided tutorials and live animated gestures.
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
                  <Button onClick={() => void buildQueue()} disabled={dictionaryLoading || isResolvingWords || !sentence.trim()}>
                    {dictionaryLoading || isResolvingWords ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Translate
                  </Button>
                  {/* <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Switch checked={showSkippedWords} onCheckedChange={setShowSkippedWords} />
                    Show skipped words
                  </label> */}
                </div>
              </div>
            </section>

            {/* <section className="order-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-foreground">Parsed playback queue</h3>
                <span className="text-xs text-muted-foreground">{playableQueue.length} signs in timeline</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {queue.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Enter a sentence to build a playback queue.</p>
                ) : (
                  queue.map((item) => {
                    const active = Boolean(sentenceAnimation?.wordsUsed.includes(item.gloss))
                    const label = item.replacement ? `${item.text} -> ${item.gloss}` : item.gloss
                    return (
                      <span key={item.id} className={chipClass(item.status, active)} title={item.reason}>
                        {label}
                        <span className="ml-1 opacity-70">({item.type})</span>
                      </span>
                    )
                  })
                )}
              </div>
              {aiReplacements.length ? (
                <div className="space-y-1 text-sm text-green-700 dark:text-green-300">
                  {aiReplacements.map((replacement) => (
                    <p key={`${replacement.originalWord}-${replacement.replacementWord}`}>
                      AI dictionary fallback: {replacement.originalWord}{" -> "}{replacement.replacementWord}
                    </p>
                  ))}
                </div>
              ) : null}
              {aiUnavailable && aiUnresolved.length ? (
                <p className="text-sm text-muted-foreground">
                  AI fallback unavailable; missing words use the standard unavailable state.
                </p>
              ) : null}
              {queue.some((item) => item.status === "unavailable") && (
                <div className="space-y-1 text-sm text-red-600 dark:text-red-400">
                  {queue
                    .filter((item) => item.status === "unavailable")
                    .map((item) => (
                      <p key={item.id}>Sign unavailable: {item.text}</p>
                    ))}
                </div>
              )}
            </section> */}

            {/* <section className="order-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="text-center p-3 rounded-xl bg-secondary/50">
                <div className="text-xl font-bold text-primary">{stats.total.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Dictionary Signs</div>
              </div>
            </section> */}

            {/* {dictionaryError && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-red-700 dark:text-red-300">{dictionaryError}</p>
              </div>
            )} */}

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
                onPlaybackComplete={handleSentenceComplete}
                playbackKey={`${playbackVersion}-${currentSignData?.frames.length || 0}`}
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="icon" onClick={goToPrevious} disabled={playableQueue.length === 0}>
                <SkipBack className="w-4 h-4" />
              </Button>
              <Button variant="outline" onClick={() => setIsPlaying((value) => !value)} disabled={playableQueue.length === 0}>
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {isPlaying ? "Pause" : "Play"}
              </Button>
              <Button variant="outline" size="icon" onClick={goToNext} disabled={!isPlaying}>
                <SkipForward className="w-4 h-4" />
              </Button>
            </div>
            {sentenceAnimation?.missingWords.length ? (
              <div className="mt-2 text-center text-sm text-red-600 dark:text-red-400">
                Missing from sentence timeline: {sentenceAnimation.missingWords.join(", ")}
              </div>
            ) : null}
          </motion.div>
        </div>
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-muted-foreground">
        AI can make mistakes. Please verify important information.
      </footer>
    </div>
  )
}
