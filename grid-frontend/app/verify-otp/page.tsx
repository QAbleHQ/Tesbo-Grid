"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getWorkspace, requestOtp, verifyOtp } from "@/lib/api";
import { Banner, Button, Field, FieldLabel, Input } from "@/components/ui";

function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return email;
  const [local, domain] = email.split("@");
  const masked =
    local.length <= 2
      ? local[0] + "***"
      : local[0] + "***" + local[local.length - 1];
  return `${masked}@${domain}`;
}

function VerifyOtpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") ?? "";
  const redirectParam = searchParams.get("redirect");
  const [email, setEmail] = useState(emailParam);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resendCountdown, setResendCountdown] = useState(30);
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const t = setTimeout(() => setResendCountdown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCountdown]);

  const handleResend = useCallback(async () => {
    if (resendCountdown > 0 || !email) return;
    setResending(true);
    setResendSuccess(false);
    setError("");
    try {
      await requestOtp(email.trim().toLowerCase());
      setResendCountdown(30);
      setResendSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend code");
    } finally {
      setResending(false);
    }
  }, [email, resendCountdown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = email.trim().toLowerCase();
    if (!emailToUse || !code.trim()) {
      setError("Email and code are required");
      return;
    }
    setLoading(true);
    try {
      await verifyOtp(emailToUse, code.trim());
      if (redirectParam) {
        router.push(redirectParam);
      } else {
        const workspace = await getWorkspace();
        router.push(workspace ? "/projects" : "/onboarding");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
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
            <h1 className="text-2xl font-semibold text-[var(--foreground)]">
              Check your email
            </h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {emailParam
                ? `We sent a 6-digit code to ${maskEmail(emailParam)}`
                : "Enter the 6-digit code we sent to your inbox"}
            </p>
          </div>

          <div className="glass-strong rounded-2xl p-6 space-y-4">
            {error && (
              <Banner tone="error" title="Verification failed" description={error} />
            )}
            {resendSuccess && (
              <Banner tone="success" title="Code resent" description="Check your inbox for the new code." />
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              {!emailParam && (
                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="code">6-digit code</FieldLabel>
                <Input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="000000"
                  className="text-center text-lg tracking-widest"
                  maxLength={6}
                  disabled={loading}
                  autoFocus
                />
              </Field>
              <Button type="submit" disabled={loading} fullWidth>
                {loading ? "Verifying…" : "Verify and sign in"}
              </Button>
            </form>

            <div className="flex items-center justify-center gap-2 text-sm">
              <span className="text-[var(--muted)]">Didn&apos;t get it?</span>
              <button
                type="button"
                onClick={handleResend}
                disabled={resendCountdown > 0 || resending || !email}
                className="font-medium text-[var(--brand-primary)] disabled:cursor-default disabled:opacity-50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] rounded"
              >
                {resending
                  ? "Resending…"
                  : resendCountdown > 0
                  ? `Resend in ${resendCountdown}s`
                  : "Resend code"}
              </button>
            </div>
          </div>

          <p className="text-center text-sm text-[var(--muted)]">
            <Link
              href="/login"
              className="text-[var(--brand-primary)] hover:underline"
            >
              Use a different email
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

export default function VerifyOtpPage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <VerifyOtpForm />
    </Suspense>
  );
}
