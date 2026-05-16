"use client"

import { doc, increment, setDoc } from "firebase/firestore"
import { getFirebaseDb, logFirebaseAnalyticsEvent } from "@/lib/firebase"

type AnalyticsMetadata = Record<string, string | number | boolean | null | undefined>

const LOCAL_COUNTS_KEY = "signwiz_analytics_counts"
const LOCAL_EVENTS_KEY = "signwiz_analytics_events"
const LOCAL_PAGE_USERS_KEY = "signwiz_analytics_page_users"

function readLocalRecord(key: string): Record<string, unknown> {
  if (typeof window === "undefined") return {}

  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeLocalRecord(key: string, value: Record<string, unknown>) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(key, JSON.stringify(value))
}

function saveLocalAnalyticsEvent(eventName: string, metadata: AnalyticsMetadata) {
  if (typeof window === "undefined") return

  const counts = readLocalRecord(LOCAL_COUNTS_KEY) as Record<string, number>
  counts[eventName] = (counts[eventName] || 0) + 1
  writeLocalRecord(LOCAL_COUNTS_KEY, counts)

  const events = readLocalRecord(LOCAL_EVENTS_KEY)
  const records = Array.isArray(events.records) ? events.records : []
  records.push({
    eventName,
    metadata,
    createdAt: new Date().toISOString(),
  })
  writeLocalRecord(LOCAL_EVENTS_KEY, { records: records.slice(-200) })
}

export async function trackSignWizEvent(
  eventName: string,
  metadata: AnalyticsMetadata = {},
) {
  const pagePath = typeof window === "undefined" ? "" : window.location.pathname
  const payload = {
    ...metadata,
    eventName,
    page_path: metadata.page_path || pagePath,
  }

  saveLocalAnalyticsEvent(eventName, payload)
  console.log("[analytics]", eventName, payload)

  try {
    await logFirebaseAnalyticsEvent(eventName, payload)
  } catch {
    // Firebase Analytics is optional for the product experience.
  }

  try {
    const db = getFirebaseDb()
    if (!db) return

    await setDoc(
      doc(db, "analytics_counts", eventName),
      {
        count: increment(1),
      },
      { merge: true },
    )

    if (eventName.startsWith("page_view_")) {
      const seenPages = readLocalRecord(LOCAL_PAGE_USERS_KEY) as Record<string, boolean>
      if (!seenPages[eventName]) {
        seenPages[eventName] = true
        writeLocalRecord(LOCAL_PAGE_USERS_KEY, seenPages)
        await setDoc(
          doc(db, "analytics_counts", `${eventName}_unique_users`),
          {
            count: increment(1),
          },
          { merge: true },
        )
      }
    }
  } catch (error) {
    console.warn("[analytics] Firestore counter unavailable; local fallback retained.", error)
  }
}
