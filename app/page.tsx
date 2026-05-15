"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { addDoc, collection, serverTimestamp } from "firebase/firestore"
import {
  Github,
  Hand,
  Info,
  Loader2,
  Pause,
  Play,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react"
import { AvatarDisplay, type ActiveSignedItem, type FeedbackType, type SignedItemFeedback } from "@/components/AvatarDisplay"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Button } from "@/components/ui/button"
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
type AnalyticsEventDocument = {
  eventType: string
  eventName: string
  page: string
  createdAt: ReturnType<typeof serverTimestamp>
  sessionId: string
  metadata: Record<string, unknown>
}

const PROTECTED_PHRASE_WORDS = new Set(["thank you", "no way", "don't know", "i love you", "good bye"])

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

function getStoredRecords(key: string) {
  if (typeof window === "undefined") return []
  const existing = window.localStorage.getItem(key)
  try {
    return existing ? JSON.parse(existing) as unknown[] : []
  } catch {
    return []
  }
}

function saveFeedbackToLocalStorage(feedbackDocument: FeedbackDocument) {
  if (typeof window === "undefined") return

  const fallbackKey = "signwiz_feedback_fallback"
  const { createdAt: _serverCreatedAt, ...serializableFeedback } = feedbackDocument
  const feedbackRecords = getStoredRecords(fallbackKey)
  feedbackRecords.push({
    ...serializableFeedback,
    createdAt: new Date().toISOString(),
  })
  window.localStorage.setItem(fallbackKey, JSON.stringify(feedbackRecords))
}

function getAnalyticsSessionId() {
  if (typeof window === "undefined") return "server"

  const sessionKey = "signwiz_session_id"
  const existing = window.localStorage.getItem(sessionKey)
  if (existing) return existing

  const sessionId = crypto.randomUUID()
  window.localStorage.setItem(sessionKey, sessionId)
  return sessionId
}

function saveAnalyticsToLocalStorage(eventDocument: AnalyticsEventDocument) {
  if (typeof window === "undefined") return

  const fallbackKey = "signwiz_analytics_fallback"
  const { createdAt: _serverCreatedAt, ...serializableEvent } = eventDocument
  const analyticsRecords = getStoredRecords(fallbackKey)
  analyticsRecords.push({
    ...serializableEvent,
    createdAt: new Date().toISOString(),
  })
  window.localStorage.setItem(fallbackKey, JSON.stringify(analyticsRecords))
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
  const [showSkippedWords] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [aiReplacements, setAiReplacements] = useState<MissingWordReplacement[]>([])
  const [aiUnresolved, setAiUnresolved] = useState<string[]>([])
  const [aiUnavailable, setAiUnavailable] = useState(false)
  const [feedbackByItem, setFeedbackByItem] = useState<Record<string, FeedbackType>>({})
  const [activeSignedItem, setActiveSignedItem] = useState<ActiveSignedItem | null>(null)

  const trackAnalyticsEvent = useCallback(async (
    eventName: string,
    metadata: Record<string, unknown> = {},
    eventType = "interaction",
  ) => {
    const eventDocument: AnalyticsEventDocument = {
      eventType,
      eventName,
      page: "/",
      createdAt: serverTimestamp(),
      sessionId: getAnalyticsSessionId(),
      metadata,
    }

    try {
      const db = getFirebaseDb()
      if (!db) {
        console.warn("[analytics] Firestore unavailable, saved locally")
        saveAnalyticsToLocalStorage(eventDocument)
        return
      }

      await addDoc(collection(db, "analyticsEvents"), eventDocument)
    } catch (error) {
      console.warn("[analytics] Firestore write failed, saved locally", error)
      saveAnalyticsToLocalStorage(eventDocument)
    }
  }, [])

  useEffect(() => {
    void trackAnalyticsEvent("page_view", {}, "page_view")
  }, [trackAnalyticsEvent])

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
    void trackAnalyticsEvent("click_start_learning")
    const words = pickRandomLearningWords()
    if (!words.length) return

    setMode("learning")
    setLearningHistory([words])
    setLearningHistoryIndex(0)
    await playLearningWords(words)
  }, [pickRandomLearningWords, playLearningWords, trackAnalyticsEvent])

  const showNextLearningSet = useCallback(async () => {
    void trackAnalyticsEvent("click_learning_next")
    const words = pickRandomLearningWords()
    if (!words.length) return

    const nextHistory = learningHistory.slice(0, learningHistoryIndex + 1)
    nextHistory.push(words)
    setLearningHistory(nextHistory)
    setLearningHistoryIndex(nextHistory.length - 1)
    await playLearningWords(words)
  }, [learningHistory, learningHistoryIndex, pickRandomLearningWords, playLearningWords, trackAnalyticsEvent])

  const showPreviousLearningSet = useCallback(async () => {
    void trackAnalyticsEvent("click_learning_back")
    const previousIndex = learningHistoryIndex - 1
    const words = learningHistory[previousIndex]
    if (!words) return

    setLearningHistoryIndex(previousIndex)
    await playLearningWords(words)
  }, [learningHistory, learningHistoryIndex, playLearningWords, trackAnalyticsEvent])

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

  const handleSentenceComplete = useCallback(() => {
    setPlaybackVersion((version) => version + 1)
    setIsPlaying(playableQueue.length > 0)
  }, [playableQueue.length])

  const currentDisplayWord = currentSignData?.word || sentence
  const activeFeedback = activeSignedItem?.feedbackKey ? feedbackByItem[activeSignedItem.feedbackKey] : undefined

  const handlePlaybackToggle = useCallback(() => {
    void trackAnalyticsEvent(isPlaying ? "click_pause" : "click_play")
    setIsPlaying((value) => !value)
  }, [isPlaying, trackAnalyticsEvent])

  const handleLiveTranslationClick = useCallback(() => {
    void trackAnalyticsEvent("click_live_translation")
    setMode("live")
  }, [trackAnalyticsEvent])

  const handleTranslateClick = useCallback(() => {
    void trackAnalyticsEvent("click_translate")
    void buildQueue()
  }, [buildQueue, trackAnalyticsEvent])

  const handleSignedItemFeedback = useCallback(async (feedback: SignedItemFeedback) => {
    void trackAnalyticsEvent(feedback.feedbackType === "thumbs_up" ? "click_feedback_up" : "click_feedback_down", {
      signedItem: feedback.signedItem,
      itemIndex: feedback.itemIndex,
    })
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
  }, [currentSignData?.metadata?.playbackFeedbackItems, currentSignData?.word, sentence, trackAnalyticsEvent])

  const handleFeedbackButtonClick = useCallback((feedbackType: FeedbackType) => {
    if (!activeSignedItem) return
    void handleSignedItemFeedback({
      signedItem: activeSignedItem.signedItem,
      itemIndex: activeSignedItem.itemIndex,
      feedbackKey: activeSignedItem.feedbackKey,
      feedbackType,
    })
  }, [activeSignedItem, handleSignedItemFeedback])

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
                  <Button variant={mode === "live" ? "default" : "outline"} onClick={handleLiveTranslationClick}>
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
                    <Button onClick={handleTranslateClick} disabled={dictionaryLoading || isResolvingWords || !sentence.trim()}>
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
                </div>
              </div>
            </section>

            {dictionaryError ? (
              <div className="text-sm text-red-600 dark:text-red-400">{dictionaryError}</div>
            ) : null}
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
                onActiveItemChange={setActiveSignedItem}
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <Button variant="outline" onClick={handlePlaybackToggle} disabled={playableQueue.length === 0}>
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {isPlaying ? "Pause" : "Play"}
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleFeedbackButtonClick("thumbs_up")}
                  disabled={!activeSignedItem}
                  aria-label="Mark current signed item as correct"
                  className={activeFeedback === "thumbs_up" ? "text-green-600 hover:text-green-700" : "text-muted-foreground"}
                >
                  <ThumbsUp className={`w-5 h-5 ${activeFeedback === "thumbs_up" ? "fill-current" : ""}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleFeedbackButtonClick("thumbs_down")}
                  disabled={!activeSignedItem}
                  aria-label="Mark current signed item as incorrect"
                  className={activeFeedback === "thumbs_down" ? "text-red-600 hover:text-red-700" : "text-muted-foreground"}
                >
                  <ThumbsDown className={`w-5 h-5 ${activeFeedback === "thumbs_down" ? "fill-current" : ""}`} />
                </Button>
              </div>
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
