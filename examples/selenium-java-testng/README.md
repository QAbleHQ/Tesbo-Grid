# Selenium Java + TestNG sample

A minimal Maven project that runs against a remote Selenium Grid through TesboGrid.

## What this proves

When you submit this project with the TesboGrid CLI:

1. The CLI auto-detects Java (because of `pom.xml`) and `framework = selenium`.
2. The Execution API enqueues each test method onto `execution-jobs-selenium-java`.
3. A `execution-worker-selenium-java` pod (or local Compose worker) unpacks the bundle, runs `mvn -B -Dtest="<class>#<method>" -DfailIfNoTests=false test`, and parses the resulting `target/surefire-reports/*.xml` (or `target/testng-results.xml`).
4. Each method shows up in the TesboGrid UI with status, duration, and logs.

## What the worker injects at runtime

| Env var | Default | Purpose |
| --- | --- | --- |
| `SELENIUM_REMOTE_URL` | `http://selenium-hub:4444/wd/hub` | Grid endpoint |
| `SELENIUM_BROWSER` | `chrome` | Set via `--browser` on the CLI |
| `BASE_URL` | `https://example.com` (test default) | Set via `--start-url` on the CLI |
| `TESBOX_RUN_ID` | (current run id) | Useful for tagging |
| `TESBOX_JOB_ID` | (current job id) | Useful for tagging |

The sample `BaseTest` reads these and constructs a `RemoteWebDriver`.

## Run it locally with Docker Compose

The CLI bundles everything under the current working directory, so `cd` into this folder first.

```bash
# 1. From the repo root, bring up the stack
#    (includes Selenium Hub + Chrome + Firefox + Selenium workers)
docker compose up -d

# 2. cd into the sample so only this project gets bundled
cd examples/selenium-java-testng

# 3. Submit the sample (framework/browser auto-detected from pom.xml)
../../grid-cli/bin/tesbox.js run "src/test/**/*.java" \
  --browser chrome \
  --start-url https://example.com \
  --api-url http://localhost:7420 \
  --api-key tesbo_...
```

You should see each `@Test` method appear as a separate job in the UI, scheduled onto the `execution-jobs-selenium-java` queue.

To force the framework explicitly (skip auto-detect):

```bash
../../grid-cli/bin/tesbox.js run "src/test/**/*.java" \
  --language java \
  --framework selenium \
  --browser chrome \
  --start-url https://example.com \
  --api-url http://localhost:7420 \
  --api-key tesbo_...
```

## Run it directly (without TesboGrid)

If you just want to verify the sample works against a Grid:

```bash
docker compose up -d selenium-hub selenium-node-chrome
SELENIUM_REMOTE_URL=http://localhost:4444/wd/hub \
SELENIUM_BROWSER=chrome \
BASE_URL=https://example.com \
mvn -B test
```

## Troubleshooting

- **`mvn: command not found` inside the worker** — make sure you built `Dockerfile.selenium-java` (Compose does this for `execution-worker-selenium-java`).
- **`Could not start a new session`** — confirm the Hub is healthy: `curl http://localhost:4444/wd/hub/status`.
- **Tests run but report "Skipped"** — the `--test` selector didn't match. The CLI generates `ClassName#methodName`. Check the value in your job log.
