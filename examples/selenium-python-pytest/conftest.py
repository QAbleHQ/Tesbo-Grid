import os

import pytest
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.edge.options import Options as EdgeOptions


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value if value else default


def _build_options(browser: str):
    if browser == "firefox":
        options = FirefoxOptions()
        options.add_argument("-headless")
        return options
    if browser == "edge":
        return EdgeOptions()
    options = ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    return options


@pytest.fixture()
def browser() -> str:
    return _env("SELENIUM_BROWSER", "chrome").lower()


@pytest.fixture()
def base_url() -> str:
    return _env("BASE_URL", _env("TESBOX_START_URL", "https://example.com"))


@pytest.fixture()
def driver(browser: str):
    remote_url = _env("SELENIUM_REMOTE_URL", "http://selenium-hub:4444/wd/hub")
    options = _build_options(browser)
    web_driver = webdriver.Remote(command_executor=remote_url, options=options)
    web_driver.implicitly_wait(10)
    web_driver.set_page_load_timeout(30)
    try:
        yield web_driver
    finally:
        web_driver.quit()
