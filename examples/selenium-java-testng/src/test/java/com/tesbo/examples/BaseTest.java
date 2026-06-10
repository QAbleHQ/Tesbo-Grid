package com.tesbo.examples;

import org.openqa.selenium.MutableCapabilities;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.firefox.FirefoxOptions;
import org.openqa.selenium.edge.EdgeOptions;
import org.openqa.selenium.remote.RemoteWebDriver;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;

import java.net.URI;
import java.net.URL;
import java.time.Duration;

public abstract class BaseTest {

    protected WebDriver driver;
    protected String baseUrl;

    @BeforeMethod(alwaysRun = true)
    public void setUp() throws Exception {
        String remote = envOr("SELENIUM_REMOTE_URL", "http://selenium-hub:4444/wd/hub");
        String browser = envOr("SELENIUM_BROWSER", "chrome").toLowerCase();
        baseUrl = envOr("BASE_URL", envOr("TESBOX_START_URL", "https://example.com"));

        MutableCapabilities options;
        switch (browser) {
            case "firefox":
                options = headlessFirefox();
                break;
            case "edge":
                options = new EdgeOptions();
                break;
            case "chrome":
            default:
                options = headlessChrome();
                break;
        }

        URL gridUrl = URI.create(remote).toURL();
        driver = new RemoteWebDriver(gridUrl, options);
        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));
        driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(30));
    }

    @AfterMethod(alwaysRun = true)
    public void tearDown() {
        if (driver != null) {
            driver.quit();
        }
    }

    private static ChromeOptions headlessChrome() {
        ChromeOptions options = new ChromeOptions();
        options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");
        return options;
    }

    private static FirefoxOptions headlessFirefox() {
        FirefoxOptions options = new FirefoxOptions();
        options.addArguments("-headless");
        return options;
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return (value == null || value.isBlank()) ? fallback : value;
    }
}
