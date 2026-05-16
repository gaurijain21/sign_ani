"use client"

import { useEffect } from "react"
import Link from "next/link"
import { trackSignWizEvent } from "@/lib/analytics"

export default function AboutPage() {
  useEffect(() => {
    void trackSignWizEvent("page_view_about", { event_type: "page_view", page_title: "About Us" })
  }, [])

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <Link className="text-sm text-muted-foreground hover:text-foreground hover:underline" href="/">
        Back to SignWiz
      </Link>
      <h1 className="mt-6 text-3xl font-bold">About Us</h1>
      <p className="mt-4 text-muted-foreground">
        SignWiz is a sign language learning and translation demo focused on accessible animated practice.
        Placeholder content can be expanded with the project story, dataset notes, and team details.
      </p>
    </main>
  )
}
