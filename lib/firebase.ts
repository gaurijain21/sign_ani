import { initializeApp, getApps, type FirebaseApp } from "firebase/app"
import { getFirestore, type Firestore } from "firebase/firestore"
import { getStorage, type FirebaseStorage } from "firebase/storage"
import type { Analytics } from "firebase/analytics"

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || "G-9Q63Q84LGP",
}

let firebaseEnvLogged = false
let firebaseAppLogged = false
let firestoreLogged = false
let analyticsLogged = false
let analyticsSkipLogged = false
let analyticsPromise: Promise<Analytics | null> | null = null

function logFirebaseEnvStatus() {
  if (firebaseEnvLogged) return
  firebaseEnvLogged = true

  console.log(`[firebase] NEXT_PUBLIC_FIREBASE_API_KEY exists: ${Boolean(firebaseConfig.apiKey)}`)
  console.log(`[firebase] NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN exists: ${Boolean(firebaseConfig.authDomain)}`)
  console.log(`[firebase] NEXT_PUBLIC_FIREBASE_PROJECT_ID exists: ${Boolean(firebaseConfig.projectId)}`)
  console.log(`[firebase] project id exists: ${Boolean(firebaseConfig.projectId)}`)
  console.log(`[firebase] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET exists: ${Boolean(firebaseConfig.storageBucket)}`)
  console.log(`[firebase] NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID exists: ${Boolean(firebaseConfig.messagingSenderId)}`)
  console.log(`[firebase] NEXT_PUBLIC_FIREBASE_APP_ID exists: ${Boolean(firebaseConfig.appId)}`)
  console.log(`[firebase] NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID exists: ${Boolean(firebaseConfig.measurementId)}`)
}

export function hasFirebaseConfig(): boolean {
  logFirebaseEnvStatus()
  return Object.values(firebaseConfig).every(Boolean)
}

export function getFirebaseApp(): FirebaseApp | null {
  if (!hasFirebaseConfig()) {
    console.warn("[firebase] firebase config incomplete; firebase app not initialized")
    return null
  }

  if (!firebaseAppLogged) {
    console.log("[firebase] initializing firebase app")
  }
  const app = getApps()[0] || initializeApp(firebaseConfig)
  if (!firebaseAppLogged) {
    console.log("[firebase] app initialized")
    console.log("[firebase] firebase app initialized")
    console.log(`[firebase] using projectId: ${firebaseConfig.projectId}`)
    firebaseAppLogged = true
  }

  return app
}

export function getFirebaseDb(): Firestore | null {
  const app = getFirebaseApp()
  if (!app) return null

  const db = getFirestore(app)
  if (!firestoreLogged) {
    console.log("[firebase] firestore initialized")
    firestoreLogged = true
  }
  return db
}

export function getFirebaseStorage(): FirebaseStorage | null {
  const app = getFirebaseApp()
  return app ? getStorage(app) : null
}

export async function getFirebaseAnalytics(): Promise<Analytics | null> {
  if (!shouldEnableAnalytics()) return null
  if (analyticsPromise) return analyticsPromise

  analyticsPromise = (async () => {
    try {
      const app = getFirebaseApp()
      if (!app) return null

      const { getAnalytics, isSupported } = await import("firebase/analytics")
      if (!(await isSupported())) return null

      const analytics = getAnalytics(app)
      if (!analyticsLogged) {
        console.log("[firebase] analytics initialized")
        analyticsLogged = true
      }
      return analytics
    } catch {
      return null
    }
  })()

  return analyticsPromise
}

export async function logFirebaseAnalyticsEvent(
  eventName: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
) {
  try {
    const analytics = await getFirebaseAnalytics()
    if (!analytics) return

    const { logEvent } = await import("firebase/analytics")
    logEvent(analytics, eventName, params)
  } catch {
    // Analytics should never interrupt the app experience.
  }
}

function shouldEnableAnalytics(): boolean {
  if (typeof window === "undefined") return false

  const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  const shouldEnable = process.env.NODE_ENV === "production" && !isLocalHost

  if (!shouldEnable && !analyticsSkipLogged) {
    console.log("[analytics] skipped in development/local environment")
    analyticsSkipLogged = true
  }

  return shouldEnable
}
