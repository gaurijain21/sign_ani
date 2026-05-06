# SignViz - ASL Sentence Visualization

SignViz is an educational/research prototype for visualizing ASL motion from preprocessed landmark data. Users can type an English sentence, the app performs phrase-first matching with word fallback, lazy-loads only the needed sign JSON files, and plays the signs sequentially through the animated avatar.

## Important Disclaimer

This is not a complete ASL translator and is not a substitute for learning ASL from qualified instructors or the Deaf community.

- WLASL is a word-level ASL dataset, not an English-to-ASL grammar translator.
- Sentence visualization uses phrase-first matching and word-level fallback.
- ASL grammar differs from English grammar.
- Raw videos are not deployed. Only lightweight landmark JSON files should be uploaded.
- This project is for educational/research demo purposes.

## Features

- Sentence input with "Translate / Visualize Sentence"
- Longest-match-first phrase detection
- Word fallback matching for WLASL glosses
- Clear chips for available, skipped, and unavailable signs
- Sequential playback with play, pause, replay, next, and previous controls
- Firebase-backed sign dictionary support
- Firebase Storage lazy-loading for sign animation JSON
- Local manifest fallback for development
- Searchable Sign Dictionary panel
- Canvas avatar using WLASL-derived MediaPipe landmarks

## Architecture

```
Sentence input
  -> normalize/tokenize
  -> phrase-first dictionary match
  -> playback queue
  -> lazy-load sign JSON from Firebase Storage
  -> sequential avatar animation
```

Production target:

- Next.js frontend on Vercel
- Firestore collection: `signs`
- Firebase Storage path: `signs/[gloss].json`
- Local preprocessing scripts for WLASL videos

## Firestore Data Model

Collection: `signs`

Word document:

```json
{
  "gloss": "hello",
  "type": "word",
  "jsonPath": "signs/hello.json",
  "jsonUrl": "optional Firebase download URL",
  "available": true,
  "source": "WLASL",
  "fps": 30,
  "frameCount": 45,
  "aliases": ["hi"],
  "category": "greetings"
}
```

Phrase document:

```json
{
  "gloss": "good morning",
  "type": "phrase",
  "jsonPath": "signs/good-morning.json",
  "available": true,
  "source": "manual-curated",
  "aliases": ["morning greeting"],
  "category": "greetings"
}
```

## Environment Variables

Add these to `.env.local` and Vercel:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

If these are missing, the app falls back to the local `/api/sign-dictionary` endpoint backed by `data/signManifest.json`.

## WLASL Setup

Follow the official WLASL flow:

```bash
git clone https://github.com/dxli94/WLASL.git
cd WLASL/start_kit
pip install yt-dlp
python video_downloader.py
python preprocess.py
```

After preprocessing, extracted samples should exist under:

```text
WLASL/start_kit/videos/
```

## Local Processing

Install Python dependencies, preferably in a virtual environment:

```bash
python -m venv .venv
.\.venv\Scripts\python -m pip install -r scripts\requirements.txt
```

Build the WLASL manifest:

```bash
.\.venv\Scripts\python scripts\build_manifest.py --wlasl-path .\WLASL
```

Optional local manifest output for cloud upload workflows:

```bash
.\.venv\Scripts\python scripts\build_wlasl_manifest.py
```

Extract landmarks:

```bash
.\.venv\Scripts\python scripts\extract_landmarks.py --manifest .\data\signManifest.json --output .\data\signs
.\.venv\Scripts\python scripts\build_manifest.py --wlasl-path .\WLASL
```

Safely process small WLASL batches. The batch script refreshes `data/signManifest.json`, skips signs that already have JSON in `data/signs/`, skips missing or broken videos, and records repeated extraction failures in `data/failedSignExtractions.json`.

```bash
.\.venv\Scripts\python scripts\process_batch.py --limit 25
.\.venv\Scripts\python scripts\process_batch.py --word-file data\priority_words.txt
.\.venv\Scripts\python scripts\process_batch.py --words hello thanks yes no
.\.venv\Scripts\python scripts\process_batch.py --limit 25 --dry-run
```

Optional Firebase upload and local video cleanup:

```bash
set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
set FIREBASE_STORAGE_BUCKET=your-project.appspot.com
.\.venv\Scripts\python scripts\process_batch.py --limit 25 --upload
.\.venv\Scripts\python scripts\process_batch.py --limit 25 --upload --cleanup
```

`--cleanup` only removes successfully processed source videos from WLASL video folders. Raw WLASL videos should stay out of the deployed frontend; only generated landmark JSON files from `data/signs/` should be uploaded.

Automated dictionary expansion can run the full download, process, upload, and cleanup loop in repeated small cycles:

```bash
.\.venv\Scripts\python scripts\auto_expand_dictionary.py --batch-size 25 --cycles 10 --upload --cleanup
.\.venv\Scripts\python scripts\auto_expand_dictionary.py --batch-size 25 --cycles 10 --word-file data\priority_words.txt --max-storage-gb 5 --stop-on-error false
```

Progress is written to `data/expansion_status.json`. Failed downloads and failed landmark extractions are remembered in `data/failedDownloads.json` and `data/failedSignExtractions.json`, so rerunning the command resumes safely instead of starting over.

## Firebase Upload

Do not upload raw WLASL videos. Upload only generated JSON files from `data/signs/`.

Frontend Firebase config already lives in `lib/firebase.ts` and uses `NEXT_PUBLIC_*` values from `.env.local`. Python upload scripts use Firebase Admin separately.

Firebase setup:

1. Create a Firebase project if you do not already have one.
2. Enable Firestore Database in Firebase Console.
3. Enable Firebase Storage in Firebase Console.
4. Open Project settings > Service accounts.
5. Generate a new private key and save it locally as `firebase-service-account.json`.
6. Keep the service account file private. It is ignored by `.gitignore`.

PowerShell Admin SDK credentials:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\Gauri\sign_ani\firebase-service-account.json"
$env:FIREBASE_STORAGE_BUCKET="your-project.appspot.com"
```

```bash
set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
set FIREBASE_STORAGE_BUCKET=your-project.appspot.com
.\.venv\Scripts\python scripts\upload_signs_to_firebase.py
```

This uploads JSON files to Firebase Storage and creates/updates Firestore documents in the `signs` collection.

## MS-ASL and Face Landmarks

Install the Python dependencies:

```bash
pip install firebase-admin mediapipe opencv-python yt-dlp tqdm
```

Process MS-ASL in small Firebase-backed batches:

```bash
python scripts/process_msasl_firebase.py --batch-size 25 --split all
```

Regenerate local WLASL videos with MediaPipe Holistic face and mouth landmarks:

```bash
python scripts/regenerate_wlasl_with_face.py --batch-size 25
```

Both scripts upload landmark JSON files to Firebase Storage under `sign-landmarks/...` and update the same Firestore `signs` collection. If a word already exists, the new sample is added as a variant; the existing `primaryVariantId` is preserved so playback has a deterministic default.

## Development

```bash
pnpm install
pnpm dev
```

Open:

```text
http://localhost:3000
```

## Deployment

1. Push the Next.js app to GitHub.
2. Import the repo in Vercel.
3. Add the Firebase environment variables in Vercel Project Settings.
4. Deploy.
5. Keep raw WLASL videos out of the frontend repository and deployment.

## Project Structure

```text
app/
  api/sign-dictionary/     Local dictionary fallback
  api/signs/               Local sign JSON fallback
  page.tsx                 Sentence visualization UI

components/
  AvatarCanvas.tsx         Canvas avatar renderer
  AvatarDisplay.tsx        Playback display wrapper

lib/
  firebase.ts              Firebase client initialization
  signDictionary.ts        Dictionary loading, parsing, animation fetching
  manifest.ts              Local manifest fallback helpers
  types.ts                 Shared TypeScript types

scripts/
  build_manifest.py
  build_wlasl_manifest.py
  extract_landmarks.py
  process_msasl_firebase.py
  regenerate_wlasl_with_face.py
  sign_landmark_utils.py
  process_batch.py
  upload_signs_to_firebase.py
```

## Limitations

- Phrase entries must be manually curated or imported from future phrase datasets.
- WLASL signs are word-level and may not match complete ASL grammar.
- Some source videos may be unavailable or unreadable.
- Facial grammar is limited to the available MediaPipe pose/face landmarks in the extracted JSON.

## Credits

- WLASL Dataset: https://github.com/dxli94/WLASL
- MediaPipe
- Firebase
- Next.js
