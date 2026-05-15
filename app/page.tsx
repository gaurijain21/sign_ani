"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { addDoc, collection, serverTimestamp } from "firebase/firestore"
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
import { AvatarDisplay, type FeedbackType, type SignedItemFeedback } from "@/components/AvatarDisplay"
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
import { getFirebaseDb } from "@/lib/firebase"
import { buildSentenceAnimation, type SentenceAnimationResult } from "@/lib/sentenceAnimation"
import type { MissingWordReplacement, PlaybackQueueItem, SignData, SignDictionaryEntry } from "@/lib/types"

const DEFAULT_SENTENCE = "type a word here"
type TranslationMode = "live" | "learning"
type PlaybackFeedbackType = "regular_sign" | "fingerspell_letter" | "phrase_sign" | "synonym" | "ai_semantic_match"
type FeedbackResolvedFrom = "exact" | "protected_phrase" | "synonymMap" | "word_form" | "ai" | "fingerspell"
type PlaybackFeedbackItem = {
  inputText: string
  originalWord: string
  playbackItem: string
  playbackType: PlaybackFeedbackType
  resolvedFrom: FeedbackResolvedFrom
  itemIndex: number
  signSource: string | null
}
type FeedbackDocument = {
  inputText: string
  originalWord: string
  playbackItem: string
  playbackType: PlaybackFeedbackType
  resolvedFrom: FeedbackResolvedFrom
  feedback: "up" | "down"
  itemIndex: number
  signSource: string | null
  createdAt: ReturnType<typeof serverTimestamp>
}

const PROTECTED_PHRASE_WORDS = new Set(["thank you", "no way", "don't know", "i love you", "good bye"])

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

function getPlaybackType(item: PlaybackQueueItem): PlaybackFeedbackType {
  if (item.type === "fingerspell") return "fingerspell_letter"
  if (item.resolutionType === "ai") return "ai_semantic_match"
  if (item.resolutionType === "synonym") return "synonym"
  if (item.type === "phrase") return "phrase_sign"
  return "regular_sign"
}

function getResolvedFrom(item: PlaybackQueueItem): FeedbackResolvedFrom {
  if (item.resolutionType === "fingerspell") return "fingerspell"
  if (item.resolutionType === "ai") return "ai"
  if (item.resolutionType === "synonym") return "synonymMap"
  if (PROTECTED_PHRASE_WORDS.has(item.gloss)) return "protected_phrase"
  return "exact"
}

function buildPlaybackFeedbackItems(
  inputText: string,
  playableQueue: PlaybackQueueItem[],
): PlaybackFeedbackItem[] {
  const items: PlaybackFeedbackItem[] = []

  playableQueue.forEach((item) => {
    if (item.type === "fingerspell") {
      ;(item.fingerspellLetters || []).forEach((letter) => {
        items.push({
          inputText,
          originalWord: item.text,
          playbackItem: letter,
          playbackType: "fingerspell_letter",
          resolvedFrom: "fingerspell",
          itemIndex: items.length,
          signSource: "fingerspelling",
        })
      })
      return
    }

    items.push({
      inputText,
      originalWord: item.text,
      playbackItem: item.gloss,
      playbackType: getPlaybackType(item),
      resolvedFrom: getResolvedFrom(item),
      itemIndex: items.length,
      signSource: item.entry?.source || null,
    })
  })

  return items
}

function saveFeedbackToLocalStorage(feedbackDocument: FeedbackDocument) {
  if (typeof window === "undefined") return

  const fallbackKey = "signwiz_feedback_fallback"
  const { createdAt: _serverCreatedAt, ...serializableFeedback } = feedbackDocument
  const existing = window.localStorage.getItem(fallbackKey)
  let feedbackRecords: unknown[] = []
  try {
    feedbackRecords = existing ? JSON.parse(existing) as unknown[] : []
  } catch {
    feedbackRecords = []
  }
  feedbackRecords.push({
    ...serializableFeedback,
    createdAt: new Date().toISOString(),
  })
  window.localStorage.setItem(fallbackKey, JSON.stringify(feedbackRecords))
}

export default function Home() {
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE)
  const [mode, setMode] = useState<TranslationMode>("live")
  const [currentLearningWords, setCurrentLearningWords] = useState<string[]>([])
  const [learningHistory, setLearningHistory] = useState<string[][]>([])
  const [learningHistoryIndex, setLearningHistoryIndex] = useState(-1)
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
  const [feedbackByItem, setFeedbackByItem] = useState<Record<string, FeedbackType>>({})

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

  const originalDictionaryWords = useMemo(
    () =>
      dictionary
        .filter((entry) =>
          entry.available &&
          entry.source === "WLASL" &&
          entry.gloss.trim() &&
          !entry.jsonPath.includes("/fingerspelling/"),
        )
        .map((entry) => entry.gloss),
    [dictionary],
  )

  const pickRandomLearningWords = useCallback(() => {
    const candidates = [...new Set(originalDictionaryWords)]
    const selected: string[] = []

    while (selected.length < 3 && candidates.length) {
      const randomIndex = Math.floor(Math.random() * candidates.length)
      const [word] = candidates.splice(randomIndex, 1)
      if (word) selected.push(word)
    }

    return selected
  }, [originalDictionaryWords])

  const buildQueueForSentence = useCallback(async (input: string) => {
    setIsResolvingWords(true)
    setAiReplacements([])
    setAiUnresolved([])
    setAiUnavailable(false)

    const resolved = await resolveSentenceWithAI(input, dictionary, showSkippedWords)
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
  }, [dictionary, showSkippedWords])

  const buildQueue = useCallback(async () => {
    await buildQueueForSentence(sentence)
  }, [buildQueueForSentence, sentence])

  const playLearningWords = useCallback(async (words: string[]) => {
    const learningSentence = words.join(" ")
    setCurrentLearningWords(words)
    setSentence(learningSentence)
    await buildQueueForSentence(learningSentence)
  }, [buildQueueForSentence])

  const startLearningMode = useCallback(async () => {
    const words = pickRandomLearningWords()
    if (!words.length) return

    setMode("learning")
    setLearningHistory([words])
    setLearningHistoryIndex(0)
    await playLearningWords(words)
  }, [pickRandomLearningWords, playLearningWords])

  const showNextLearningSet = useCallback(async () => {
    const words = pickRandomLearningWords()
    if (!words.length) return

    const nextHistory = learningHistory.slice(0, learningHistoryIndex + 1)
    nextHistory.push(words)
    setLearningHistory(nextHistory)
    setLearningHistoryIndex(nextHistory.length - 1)
    await playLearningWords(words)
  }, [learningHistory, learningHistoryIndex, pickRandomLearningWords, playLearningWords])

  const showPreviousLearningSet = useCallback(async () => {
    const previousIndex = learningHistoryIndex - 1
    const words = learningHistory[previousIndex]
    if (!words) return

    setLearningHistoryIndex(previousIndex)
    await playLearningWords(words)
  }, [learningHistory, learningHistoryIndex, playLearningWords])

  useEffect(() => {
    if (dictionary.length && queue.length === 0 && sentence.trim()) {
      void buildQueue()
    }
  }, [buildQueue, dictionary.length, queue.length, sentence])

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
        const playbackFeedbackItems = buildPlaybackFeedbackItems(sentence.trim() || words.join(" "), playableQueue)

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
            playbackFeedbackItems,
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
    setPlaybackVersion((version) => version + 1)
    setIsPlaying(true)
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

  const handleSignedItemFeedback = useCallback(async (feedback: SignedItemFeedback) => {
    const originalFullSentence = currentSignData?.word || sentence
    const playbackFeedbackItems = currentSignData?.metadata?.playbackFeedbackItems
    const playbackItem = Array.isArray(playbackFeedbackItems)
      ? playbackFeedbackItems[feedback.itemIndex] as PlaybackFeedbackItem | undefined
      : undefined
    const feedbackKey = feedback.feedbackKey || `${originalFullSentence}:${feedback.itemIndex}:${feedback.signedItem}`
    const feedbackDocument: FeedbackDocument = {
      inputText: playbackItem?.inputText || originalFullSentence,
      originalWord: playbackItem?.originalWord || feedback.signedItem,
      playbackItem: playbackItem?.playbackItem || feedback.signedItem,
      playbackType: playbackItem?.playbackType || "regular_sign",
      resolvedFrom: playbackItem?.resolvedFrom || "exact",
      feedback: feedback.feedbackType === "thumbs_up" ? "up" : "down",
      itemIndex: feedback.itemIndex,
      signSource: playbackItem?.signSource || null,
      createdAt: serverTimestamp(),
    }

    setFeedbackByItem((current) => ({
      ...current,
      [feedbackKey]: feedback.feedbackType,
    }))

    try {
      console.log("[feedback] preparing feedback document", feedbackDocument)
      const db = getFirebaseDb()
      if (!db) {
        console.warn("[feedback] Firestore unavailable, saved locally")
        saveFeedbackToLocalStorage(feedbackDocument)
        return
      }

      console.log("[feedback] attempting Firestore write")
      const docRef = await addDoc(collection(db, "feedback"), feedbackDocument)
      console.log("[feedback] Firestore write successful")
      console.log(`[feedback] created doc id: ${docRef.id}`)
    } catch (error) {
      console.error("[feedback] Firestore write failed:", error)
      console.warn("[feedback] Firestore unavailable, saved locally")
      saveFeedbackToLocalStorage(feedbackDocument)
    }
  }, [currentSignData?.word, sentence])

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
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button variant={mode === "live" ? "default" : "outline"} onClick={() => setMode("live")}>
                    Live Translation
                  </Button>
                  <Button
                    variant={mode === "learning" ? "default" : "outline"}
                    onClick={() => void startLearningMode()}
                    disabled={dictionaryLoading || isResolvingWords || originalDictionaryWords.length === 0}
                  >
                    {dictionaryLoading || isResolvingWords ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Start Learning
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                <div className="relative">
                  <Textarea
                    value={sentence}
                    onChange={(event) => setSentence(event.target.value)}
                    maxLength={150}
                    placeholder="Type a sentence here"
                    className="min-h-[72px] max-h-40 resize-none overflow-y-auto border-2 border-border pb-7 pr-16 text-base"
                  />
                  <span className="pointer-events-none absolute bottom-2 right-3 text-xs text-muted-foreground">
                    {sentence.length}/150
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {mode === "live" ? (
                    <Button onClick={() => void buildQueue()} disabled={dictionaryLoading || isResolvingWords || !sentence.trim()}>
                      {dictionaryLoading || isResolvingWords ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      Translate
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => void showPreviousLearningSet()}
                        disabled={dictionaryLoading || isResolvingWords || learningHistoryIndex <= 0}
                      >
                        Back
                      </Button>
                      <Button
                        onClick={() => void showNextLearningSet()}
                        disabled={dictionaryLoading || isResolvingWords || originalDictionaryWords.length === 0}
                      >
                        {isResolvingWords ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        Next
                      </Button>
                    </>
                  )}
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
                feedbackByItem={feedbackByItem}
                onFeedback={handleSignedItemFeedback}
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
        AI-generated signs can make mistakes. Check important translations.
      </footer>
    </div>
  )
}
