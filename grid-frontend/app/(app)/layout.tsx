"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import CommandRail from "@/components/CommandRail";
import { authMe, getWorkspace } from "@/lib/api";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [checkingAccess, setCheckingAccess] = useState(true);

  useEffect(() => {
    async function guard() {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const workspace = await getWorkspace();
      if (!workspace) {
        router.replace("/onboarding");
        return;
      }
      setCheckingAccess(false);
    }

    guard();
  }, [router]);

  if (checkingAccess) {
    return (
      <div className="relative min-h-screen overflow-hidden">
        <div className="tesbo-aurora" />
        <div className="relative z-10 flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 rounded-full border-2 border-[var(--glass-border)] border-t-[var(--brand-primary)] animate-spin" />
            <p className="text-sm text-[var(--muted)]">Loading workspace...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen text-[var(--foreground)]">
      <div className="tesbo-aurora" />
      <div className="relative z-0 flex min-h-screen">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <CommandRail />
          <div className="tesbo-page pt-4">{children}</div>
        </main>
      </div>
    </div>
  );
}
