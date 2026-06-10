"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authMe, getWorkspace } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 3000);
    authMe().then(async (me) => {
      clearTimeout(timer);
      if (!me) {
        router.replace("/login");
        return;
      }
      const workspace = await getWorkspace();
      router.replace(workspace ? "/projects" : "/onboarding");
    });
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="tesbo-aurora" />
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <div className="glass-subtle flex flex-col items-center gap-3 rounded-2xl px-8 py-6 text-center">
          <div className="h-7 w-7 rounded-full border-2 border-[var(--glass-border)] border-t-[var(--brand-primary)] animate-spin" />
          <p className="text-sm text-[var(--muted)]">Loading…</p>
          {slow && (
            <a
              href="/login"
              className="mt-1 text-xs text-[var(--brand-primary)] hover:underline"
            >
              Taking too long? Go to login →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
