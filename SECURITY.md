# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**. Do not open a public GitHub
issue, pull request, or discussion for a suspected vulnerability.

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository's **Security** tab), or
- Email **security@example.com** (replace with your project's security contact).

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version / commit, and any relevant configuration.

We aim to acknowledge reports within a few business days and will keep you updated
on remediation progress. Please give us a reasonable window to release a fix before
any public disclosure.

## Supported versions

Security fixes target the latest released version and `main`.

## Operator hardening notes

When self-hosting, treat these as required, not optional:

- Generate strong, unique values for `INTERNAL_SHARED_TOKEN`,
  `EXECUTION_API_SHARED_TOKEN`, and session secrets. The setup CLI
  (`tesbo-grid init`) generates these for you.
- Never commit `.env` / `app.env` / `*.pem` files. They are gitignored by default.
- Terminate TLS at your ingress/load balancer; do not expose service ports directly.
- Restrict the Selenium Grid endpoint to authenticated clients (the bundled
  `grid-selenium-proxy` enforces API-key auth).
