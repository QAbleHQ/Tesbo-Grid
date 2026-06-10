// Middleware.io APM — only loads if MW credentials are present
const token = process.env.MW_APM_ACCESS_TOKEN || process.env.MW_API_KEY;
if (token) {
  try {
    const { track } = await import("@middleware.io/node-apm");
    track({ serviceName: "tesbox-execute-app-api", accessToken: token });
  } catch {
    // APM package not installed — skip
  }
}
