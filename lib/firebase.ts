import { initializeApp, getApps, type FirebaseApp } from "firebase/app"
import { getFirestore, type Firestore } from "firebase/firestore"
import { getStorage, type FirebaseStorage } from "firebase/storage"

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

let firebaseEnvLogged = false
let firebaseAppLogged = false
let firestoreLogged = false

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
