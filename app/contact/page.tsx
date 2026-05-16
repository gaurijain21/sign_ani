"use client"

import { FormEvent, useEffect, useState } from "react"
import Link from "next/link"
import { addDoc, collection, serverTimestamp } from "firebase/firestore"
import { trackSignWizEvent } from "@/lib/analytics"
import { getFirebaseDb } from "@/lib/firebase"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

type ContactFormState = {
  name: string
  email: string
  subject: string
  message: string
}

const INITIAL_FORM_STATE: ContactFormState = {
  name: "",
  email: "",
  subject: "",
  message: "",
}

function looksLikeEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export default function ContactPage() {
  const [form, setForm] = useState<ContactFormState>(INITIAL_FORM_STATE)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [statusType, setStatusType] = useState<"success" | "error" | null>(null)

  useEffect(() => {
    void trackSignWizEvent("page_view_contact", { event_type: "page_view", page_title: "Contact Us" })
  }, [])

  function updateField(field: keyof ContactFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function validateForm() {
    const name = form.name.trim()
    const email = form.email.trim()
    const subject = form.subject.trim()
    const message = form.message.trim()

    if (!name || !email || !subject || !message) {
      return "Please fill out every field."
    }

    if (!looksLikeEmail(email)) {
      return "Please enter a valid email address."
    }

    return null
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void trackSignWizEvent("button_click_contact_submit")

    const validationError = validateForm()
    if (validationError) {
      setStatusType("error")
      setStatusMessage(validationError)
      return
    }

    setIsSubmitting(true)
    setStatusType(null)
    setStatusMessage(null)

    try {
      const db = getFirebaseDb()
      if (!db) {
        throw new Error("Firestore is unavailable.")
      }

      await addDoc(collection(db, "contact_messages"), {
        name: form.name.trim(),
        email: form.email.trim(),
        subject: form.subject.trim(),
        message: form.message.trim(),
        createdAt: serverTimestamp(),
        status: "new",
      })

      setForm(INITIAL_FORM_STATE)
      setStatusType("success")
      setStatusMessage("Thanks — your message has been sent.")
    } catch (error) {
      console.warn("[contact] unable to send message", error)
      setStatusType("error")
      setStatusMessage("Something went wrong. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-10">
      <Link className="text-sm text-muted-foreground hover:text-foreground hover:underline" href="/">
        Back to SignWiz
      </Link>
      <h1 className="mt-6 text-3xl font-bold">Contact Us</h1>
      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        <Input
          name="name"
          placeholder="Name"
          value={form.name}
          onChange={(event) => updateField("name", event.target.value)}
          required
        />
        <Input
          name="email"
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(event) => updateField("email", event.target.value)}
          required
        />
        <Input
          name="subject"
          placeholder="Subject"
          value={form.subject}
          onChange={(event) => updateField("subject", event.target.value)}
          required
        />
        <Textarea
          name="message"
          placeholder="Message"
          className="min-h-32"
          value={form.message}
          onChange={(event) => updateField("message", event.target.value)}
          required
        />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Sending..." : "Submit"}
        </Button>
      </form>
      {statusMessage ? (
        <p className={statusType === "success" ? "mt-4 text-sm text-green-700" : "mt-4 text-sm text-red-600"}>
          {statusMessage}
        </p>
      ) : null}
    </main>
  )
}
