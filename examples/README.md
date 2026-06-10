# TesboGrid examples

Ready-to-run starter projects you can submit through the TesboGrid CLI.

| Folder | Language | Framework | What it shows |
| --- | --- | --- | --- |
| [`selenium-java-testng/`](./selenium-java-testng/) | Java 17 | Selenium 4 + TestNG (Maven) | Per-method test scheduling onto `execution-jobs-selenium-java`, TestNG/Surefire result parsing, headless Chrome/Firefox via Grid |
| [`selenium-python-pytest/`](./selenium-python-pytest/) | Python 3.12 | Selenium 4 + Pytest | Per-function test scheduling onto `execution-jobs-selenium-python`, `pytest-json-report` parsing, headless Chrome/Firefox via Grid |

## Quickest path to a green run

```bash
# 1. Bring up the full stack including Selenium Hub + nodes
docker compose up -d

# 2. Pick a sample and submit it (see each sample's README for full args)
cd examples/selenium-python-pytest
../../grid-cli/bin/tesbox.js run "tests/test_*.py" \
  --browser chrome \
  --start-url https://example.com \
  --api-url http://localhost:7420 \
  --api-key tesbo_...
```

The CLI will:

1. Auto-detect the language and the `selenium` framework.
2. Bundle the project (excluding `target/`, `__pycache__/`, `.venv/`, `.gradle/`, …).
3. Submit one job per test method/function.
4. Stream live status as workers pick the jobs up off the framework-specific queue.

## How a job flows

```
tesbox CLI ─► Execution API ─► Redis (BullMQ) ─► execution-worker-selenium-{java|python}
                                                       │
                                                       ▼
                                          Selenium Hub (selenium-hub:4444)
                                                       │
                                              ┌────────┴────────┐
                                              ▼                 ▼
                                   selenium-node-chrome  selenium-node-firefox
```

Reports parsed from inside the worker:

- **Java:** `target/surefire-reports/*.xml` (JUnit) or `target/testng-results.xml`
- **Python:** `report.json` (pytest-json-report) with `test-results/junit.xml` as a fallback
