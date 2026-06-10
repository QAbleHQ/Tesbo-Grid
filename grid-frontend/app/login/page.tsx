"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { requestOtp } from "@/lib/api";
import BrandLogo from "@/components/BrandLogo";
import { Banner, Button, Field, FieldLabel, Input } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = email.trim().toLowerCase();
    if (!emailToUse) {
      setError("Email is required");
      return;
    }
    setLoading(true);
    try {
      await requestOtp(emailToUse);
      const qp = new URLSearchParams({ email: emailToUse });
      if (redirect) qp.set("redirect", redirect);
      router.push(`/verify-otp?${qp.toString()}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Request failed. You may be rate limited — try again in a moment."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="tesbo-aurora" />
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <BrandLogo
              priority
              width={280}
              height={64}
              className="mx-auto h-14 w-auto"
            />
            <p className="mt-3 text-sm text-[var(--muted)]">
              Sign in to manage Grid projects, runner access, and automation
              reports.
            </p>
          </div>

          <div className="glass-strong rounded-2xl p-6 space-y-4">
            {error && (
              <Banner tone="error" title="Sign-in failed" description={error} />
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <Field>
                <FieldLabel htmlFor="email">Email address</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={loading}
                />
              </Field>
              <Button type="submit" disabled={loading} fullWidth>
                {loading ? "Sending…" : "Send login code"}
              </Button>
            </form>
            <p className="text-center text-sm text-[var(--muted)]">
              We&apos;ll send a one-time 6-digit code — no password needed.
            </p>
          </div>

          <p className="text-center text-xs text-[var(--muted-soft)]">
            <Link href="/privacy-policy" className="hover:underline">
              Privacy Policy
            </Link>{" "}
            ·{" "}
            <Link href="/terms-and-conditions" className="hover:underline">
              Terms and Conditions
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

const AuthFallback = () => (
  <div className="relative min-h-screen overflow-hidden">
    <div className="tesbo-aurora" />
    <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
      <div className="glass-subtle flex items-center gap-3 rounded-2xl px-6 py-4">
        <div className="h-5 w-5 rounded-full border-2 border-[var(--glass-border)] border-t-[var(--brand-primary)] animate-spin" />
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      </div>
    </div>
  </div>
);

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <LoginForm />
    </Suspense>
  );
}
