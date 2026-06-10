# Selenium Python + Pytest sample

A minimal Pytest project that runs against a remote Selenium Grid through TesboGrid.

## What this proves

When you submit this project with the TesboGrid CLI:

1. The CLI auto-detects Python (because of `requirements.txt`) and `framework = selenium`.
2. The Execution API enqueues each test function onto `execution-jobs-selenium-python`.
3. A `execution-worker-selenium-python` pod (or local Compose worker) installs `requirements.txt`, then runs `python3 -m pytest tests/test_hello_grid.py::test_home_page_loads --json-report --json-report-file=report.json --junitxml=test-results/junit.xml`.
4. The worker parses `report.json` (preferred) or `test-results/junit.xml`, and each function shows up in the TesboGrid UI.

## What the worker injects at runtime

| Env var | Default | Purpose |
| --- | --- | --- |
| `SELENIUM_REMOTE_URL` | `http://selenium-hub:4444/wd/hub` | Grid endpoint |
| `SELENIUM_BROWSER` | `chrome` | Set via `--browser` on the CLI |
| `BASE_URL` | `https://example.com` (test default) | Set via `--start-url` on the CLI |
| `TESBOX_RUN_ID` | (current run id) | Useful for tagging |
| `TESBOX_JOB_ID` | (current job id) | Useful for tagging |

The `conftest.py` fixture reads these and builds a `webdriver.Remote`.

## Run it locally with Docker Compose

The CLI bundles everything under the current working directory, so `cd` into this folder first.

```bash
# 1. From the repo root, bring up the stack
#    (includes Selenium Hub + Chrome + Firefox + Selenium workers)
docker compose up -d

# 2. cd into the sample so only this project gets bundled
cd examples/selenium-python-pytest

# 3. Submit the sample (framework auto-detected from requirements.txt)
../../grid-cli/bin/tesbox.js run "tests/test_*.py" \
  --browser chrome \
  --start-url https://example.com \
  --api-url http://localhost:7420 \
  --api-key tesbo_...
```

Each `def test_*` function appears as a separate job on `execution-jobs-selenium-python`.

To force the framework explicitly (skip auto-detect):

```bash
../../grid-cli/bin/tesbox.js run "tests/test_*.py" \
  --language python \
  --framework selenium \
  --browser chrome \
  --start-url https://example.com \
  --api-url http://localhost:7420 \
  --api-key tesbo_...
```

## Run it directly (without TesboGrid)

```bash
docker compose up -d selenium-hub selenium-node-chrome
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SELENIUM_REMOTE_URL=http://localhost:4444/wd/hub \
SELENIUM_BROWSER=chrome \
BASE_URL=https://example.com \
pytest -v
```

## Troubleshooting

- **`pytest-json-report` not installed** — the worker auto-installs `requirements.txt` before running. If you've removed `pytest-json-report` from `requirements.txt`, the worker falls back to `test-results/junit.xml`.
- **`MaxRetryError` connecting to the Grid** — confirm the Hub is healthy: `curl http://localhost:4444/wd/hub/status`.
- **Tests show as "Skipped"** — the `nodeid` selector didn't match. The CLI generates `tests/test_hello_grid.py::test_home_page_loads`. Check the value in your job log.
