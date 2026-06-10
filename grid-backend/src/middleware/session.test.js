import test from "node:test";
import assert from "node:assert/strict";
import { hash, requireAuth, setSessionCookie, clearSessionCookie } from "./session.js";

// ── hash ─────────────────────────────────────────────────────────────────────

test("hash: produces a non-empty base64url string", () => {
  const result = hash("some-token");
  assert.ok(typeof result === "string" && result.length > 0);
});

test("hash: same input always produces the same digest", () => {
  assert.equal(hash("stable-input"), hash("stable-input"));
});

test("hash: different inputs produce different digests", () => {
  assert.notEqual(hash("token-a"), hash("token-b"));
});

test("hash: output contains no base64 padding characters (+, /, =)", () => {
  const result = hash("check-url-safe-chars");
  assert.ok(!/[+/=]/.test(result), `expected base64url but got: ${result}`);
});

// ── requireAuth ───────────────────────────────────────────────────────────────

function makeMockRes() {
  const res = { _status: null, _body: null };
  res.status = (code) => {
    res._status = code;
    return res;
  };
  res.json = (body) => {
    res._body = body;
    return res;
  };
  return res;
}

test("requireAuth: calls next() when userId is set on the request", () => {
  const req = { userId: "user-123" };
  const res = makeMockRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.equal(res._status, null);
});

test("requireAuth: responds 401 when userId is null", () => {
  const req = { userId: null };
  const res = makeMockRes();
  requireAuth(req, res, () => { throw new Error("next should not be called"); });
  assert.equal(res._status, 401);
  assert.equal(res._body.error, "Authentication required");
});

test("requireAuth: responds 401 when userId is undefined", () => {
  const req = {};
  const res = makeMockRes();
  requireAuth(req, res, () => { throw new Error("next should not be called"); });
  assert.equal(res._status, 401);
});

test("requireAuth: responds 503 (not 401) when session resolution hit an infra error", () => {
  // A DB/connection failure must NOT masquerade as "logged out" — that turns a
  // transient outage into a misleading 401 for every authenticated user.
  const req = { userId: null, sessionError: new Error("connection timeout") };
  const res = makeMockRes();
  requireAuth(req, res, () => { throw new Error("next should not be called"); });
  assert.equal(res._status, 503);
  assert.equal(res._body.error, "Service temporarily unavailable");
});

test("requireAuth: prefers 503 over 401 even when userId is also null", () => {
  const req = { userId: null, sessionError: new Error("pool exhausted") };
  const res = makeMockRes();
  requireAuth(req, res, () => {});
  assert.equal(res._status, 503);
});

// ── setSessionCookie ──────────────────────────────────────────────────────────

function makeMockSetHeaderRes() {
  const res = { _headers: {} };
  res.setHeader = (name, value) => { res._headers[name] = value; };
  return res;
}

test("setSessionCookie: sets a Set-Cookie header", () => {
  const res = makeMockSetHeaderRes();
  const req = { protocol: "http", headers: {} };
  setSessionCookie(res, "tok-abc", req);
  assert.ok("Set-Cookie" in res._headers);
  assert.ok(res._headers["Set-Cookie"].includes("tok-abc"));
});

test("setSessionCookie: marks cookie as HttpOnly and SameSite=Lax", () => {
  const res = makeMockSetHeaderRes();
  const req = { protocol: "http", headers: {} };
  setSessionCookie(res, "tok-abc", req);
  const header = res._headers["Set-Cookie"];
  assert.ok(header.toLowerCase().includes("httponly"));
  assert.ok(header.toLowerCase().includes("samesite=lax"));
});

test("setSessionCookie: sets Secure flag when protocol is https", () => {
  const res = makeMockSetHeaderRes();
  const req = { protocol: "https", headers: {} };
  setSessionCookie(res, "tok-secure", req);
  assert.ok(res._headers["Set-Cookie"].toLowerCase().includes("secure"));
});

// ── clearSessionCookie ────────────────────────────────────────────────────────

test("clearSessionCookie: sets the cookie value to empty string", () => {
  const res = makeMockSetHeaderRes();
  const req = { protocol: "http", headers: {} };
  clearSessionCookie(res, req);
  const header = res._headers["Set-Cookie"];
  assert.ok(header.includes("tesbo_session=;") || header.includes("tesbo_session=\n") || /tesbo_session=;/.test(header) || /tesbo_session=(?:;|$)/.test(header));
});

test("clearSessionCookie: sets Max-Age to 0 to expire immediately", () => {
  const res = makeMockSetHeaderRes();
  const req = { protocol: "http", headers: {} };
  clearSessionCookie(res, req);
  assert.ok(res._headers["Set-Cookie"].includes("Max-Age=0"));
});
